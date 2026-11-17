-- Public media for published content, and a fix for the finalize credential.
--
-- Two independent changes ship together because publishing needs both:
--
-- 1. Credential design fix.
--    The previous admin_media_finalize took p_token_sha256 and compared it to
--    media_secrets.value_sha256. That made the *stored fingerprint itself* a
--    reusable credential: anyone who could read media_secrets (or a leaked
--    backup) could call the RPC without the raw server secret. The new function
--    takes the raw secret and recomputes its SHA-256 inside the database.
--    The stored digest is rotated by this migration; the raw value lives only in
--    the Netlify Function environment.
--
-- 2. Approved public copies.
--    Published content is served to anonymous visitors, so approved uploads must
--    exist in a public surface. A new public bucket ccafe-public holds an
--    immutable copy of each image that is about to be published. The content
--    still stores only media/<asset-uuid>; the public object name is a random
--    capability (published/<asset-uuid>/<256-bit-hex>) that is never returned to
--    the browser.
--
-- Storage/DB atomicity:
--   Preparing a public copy is not one transaction across Storage and Postgres.
--   The sequence is: begin -> prepare_public (staging) -> upload bytes -> read
--   the public URL back and re-verify -> confirm_public (ready) -> admin_publish.
--   A failure leaves the published version and the draft untouched. Copies that
--   reached ready but were never linked to a published version stay recoverable
--   and are tracked with linked_version = null.
--
-- Retention:
--   Public copies are never deleted by the application. A ready copy that was
--   published at least once has linked_version set and can never be failed or
--   removed through the API. Removing an image from current content does not
--   make a previously published image private again; its old public URL remains.
--
-- Scope guards:
--   * Original assets/ files are untouched.
--   * The private ccafe-media bucket stays private.
--   * No service_role key or management token is used by the application.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Credential check: hash the raw secret inside the database
-- ---------------------------------------------------------------------------

create or replace function public.assert_media_finalize_token(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_expected text;
  v_actual text;
begin
  select s.value_sha256
  into v_expected
  from public.media_secrets as s
  where s.name = 'finalize';

  if v_expected is null
    or p_token is null
    or length(p_token) < 1
    or length(p_token) > 512
  then
    raise exception 'finalize token is invalid' using errcode = '42501';
  end if;

  v_actual := pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex');
  if v_actual <> v_expected then
    raise exception 'finalize token is invalid' using errcode = '42501';
  end if;
end;
$fn$;

comment on function public.assert_media_finalize_token(text) is
  'Hashes the raw server secret and compares it to media_secrets.value_sha256. The stored fingerprint is never accepted as input.';

-- Replace the old signature (p_token_sha256) with one that takes the raw secret.
drop function if exists public.admin_media_finalize(uuid, text, text, bigint, integer, integer, bigint, text);

create or replace function public.admin_media_finalize(
  p_asset_id uuid,
  p_token text,
  p_mime text,
  p_bytes bigint,
  p_width integer,
  p_height integer,
  p_pixel_count bigint,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_now timestamptz := pg_catalog.now();
  v_asset public.media_assets%rowtype;
  v_pixels bigint;
begin
  v_actor := public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_mime is null or p_mime not in ('image/png', 'image/jpeg', 'image/webp') then
    raise exception 'verified type is not allowed' using errcode = '22023';
  end if;
  if p_bytes is null or p_bytes < 1 or p_bytes > 15728640 then
    raise exception 'verified size is not allowed' using errcode = '22023';
  end if;
  if p_width is null or p_height is null
    or p_width < 1 or p_width > 8000
    or p_height < 1 or p_height > 8000
  then
    raise exception 'verified dimensions are not allowed' using errcode = '22023';
  end if;
  v_pixels := p_width::bigint * p_height::bigint;
  if p_pixel_count is null or p_pixel_count <> v_pixels or v_pixels > 32000000 then
    raise exception 'verified pixel count is not allowed' using errcode = '22023';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'verified digest is not allowed' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if v_asset.created_by is distinct from v_actor then
    raise exception 'media asset belongs to another uploader' using errcode = '42501';
  end if;

  if v_asset.status = 'approved' then
    -- Retry-safe: the same verification result returns the existing approval and
    -- does not create another asset, version, or timestamp change.
    if v_asset.mime = p_mime
      and v_asset.bytes = p_bytes
      and v_asset.width = p_width
      and v_asset.height = p_height
      and v_asset.pixel_count = p_pixel_count
      and v_asset.sha256 = p_sha256
    then
      return pg_catalog.jsonb_build_object(
        'id', v_asset.id,
        'logical_path', v_asset.logical_path,
        'status', 'approved',
        'mime', v_asset.mime,
        'bytes', v_asset.bytes,
        'width', v_asset.width,
        'height', v_asset.height,
        'pixel_count', v_asset.pixel_count,
        'sha256', v_asset.sha256,
        'finalized_at', v_asset.finalized_at,
        'idempotent', true
      );
    end if;

    raise exception 'media asset was already verified with different bytes' using errcode = 'PT409';
  end if;

  if v_asset.status <> 'pending' then
    raise exception 'media asset is not pending' using errcode = 'PT409';
  end if;

  -- The server must claim the row before reading its bytes. Without the claim,
  -- the object could have been replaced between the read and this call.
  if v_asset.verification_started_at is null then
    raise exception 'media asset was not claimed for verification' using errcode = 'PT409';
  end if;

  if not exists (
    select 1
    from storage.objects as o
    where o.bucket_id = 'ccafe-media'
      and o.name = v_asset.storage_path
  ) then
    raise exception 'uploaded object is missing' using errcode = 'P0002';
  end if;

  update public.media_assets as a
  set status = 'approved',
      mime = p_mime,
      bytes = p_bytes,
      width = p_width,
      height = p_height,
      pixel_count = p_pixel_count,
      sha256 = p_sha256,
      verified_by = v_actor,
      verified_at = v_now,
      finalized_at = v_now,
      failure_reason = null,
      verify_detail = pg_catalog.jsonb_build_object(
        'mime', p_mime,
        'bytes', p_bytes,
        'width', p_width,
        'height', p_height,
        'pixel_count', p_pixel_count,
        'sha256', p_sha256
      )
  where a.id = p_asset_id
  returning * into v_asset;

  return pg_catalog.jsonb_build_object(
    'id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'status', 'approved',
    'mime', v_asset.mime,
    'bytes', v_asset.bytes,
    'width', v_asset.width,
    'height', v_asset.height,
    'pixel_count', v_asset.pixel_count,
    'sha256', v_asset.sha256,
    'finalized_at', v_asset.finalized_at,
    'idempotent', false
  );
end;
$fn$;

-- The stored digest is rotated to a second inert placeholder here. The real
-- raw secret is held only by the Netlify Function environment; a deployment must
-- set public.media_secrets to its SHA-256. A restore loads the exported row.
update public.media_secrets
set value_sha256 = '4444444444444444444444444444444444444444444444444444444444444444',
    updated_at = pg_catalog.now()
where name = 'finalize';

-- ---------------------------------------------------------------------------
-- 2. Public bucket and public-copy metadata
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ccafe-public',
  'ccafe-public',
  true,
  15728640,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.media_public_assets (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.media_assets (id) on delete restrict,
  bucket text not null default 'ccafe-public' check (bucket = 'ccafe-public'),
  object_path text not null unique,
  state text not null default 'staging'
    check (state in ('staging', 'ready', 'failed')),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bigint not null check (bytes between 1 and 15728640),
  width integer not null check (width between 1 and 8000),
  height integer not null check (height between 1 and 8000),
  pixel_count bigint not null check (pixel_count between 1 and 32000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  linked_version bigint,
  failure_reason text,
  prepared_at timestamptz not null default now(),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint media_public_assets_path_shape check (
    object_path ~ '^published/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
  ),
  constraint media_public_assets_ready_shape check (
    state <> 'ready'
    or (
      confirmed_at is not null
      and sha256 ~ '^[0-9a-f]{64}$'
    )
  )
);

create index media_public_assets_linked_idx
  on public.media_public_assets (linked_version)
  where linked_version is not null;

create index media_public_assets_state_idx
  on public.media_public_assets (state, created_at desc);

comment on table public.media_public_assets is
  'Approved uploads copied to the public ccafe-public bucket. staging = not yet verified/served; ready = public URL re-read and digest-verified; failed = rejected before any publish. linked_version is set when the copy appears in a published version and is never cleared.';
comment on column public.media_public_assets.object_path is
  'Random immutable object name. This is the read capability for the public object; it is never returned to the browser.';
comment on column public.media_public_assets.linked_version is
  'First published version that contained this asset. Non-null copies cannot be failed or removed through the API.';

-- Read policy: an anonymous visitor may resolve a public copy only after it has
-- been linked to a published version, so a ready-but-unpublished copy never
-- leaks to the public site. Admins additionally read every ready row (linked or
-- not) for the preview pane. There is deliberately no INSERT/UPDATE/DELETE
-- policy; only the SECURITY DEFINER RPCs write here.
alter table public.media_public_assets enable row level security;

create policy media_public_assets_public_read on public.media_public_assets
  for select to anon
  using (state = 'ready' and linked_version is not null);

create policy media_public_assets_admin_read on public.media_public_assets
  for select to authenticated
  using (state = 'ready' and public.is_admin());

revoke all on table public.media_public_assets from anon, authenticated;
grant select on table public.media_public_assets to anon, authenticated;

-- The Storage policy below runs as the signed-in admin, and RLS applies to
-- tables read *inside* a policy. The admin SELECT policy intentionally exposes
-- only ready rows, so a staging row would be invisible and the upload check
-- would always fail. This SECURITY DEFINER helper answers the narrower
-- question without exposing the random object name to the browser API.
create or replace function public.media_public_storage_path(
  p_name text,
  p_states text[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin()
    and exists (
      select 1
      from public.media_public_assets as p
      where p.object_path = p_name
        and p.state = any (p_states)
    );
$fn$;

comment on function public.media_public_storage_path(text, text[]) is
  'Storage-policy helper: true only for an admin and an exact registered public object name in one of the allowed states. Returns a boolean, never the path.';

revoke all on function public.media_public_storage_path(text, text[]) from public, anon, authenticated;
grant execute on function public.media_public_storage_path(text, text[]) to authenticated;

-- Public bucket Storage policies:
--   * upload only the exact staging object name created by prepare_public;
--   * no UPDATE policy (an object name is written once);
--   * delete only staging/failed copies, never a ready/published one.
-- Reads use the public object endpoint and need no Storage SELECT policy.
drop policy if exists ccafe_public_admin_upload on storage.objects;
create policy ccafe_public_admin_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ccafe-public'
    and public.is_admin()
    and public.media_public_storage_path(storage.objects.name, array['staging'])
  );

drop policy if exists ccafe_public_admin_cleanup on storage.objects;
create policy ccafe_public_admin_cleanup on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-public'
    and public.is_admin()
    and public.media_public_storage_path(storage.objects.name, array['staging', 'failed'])
  );

-- ---------------------------------------------------------------------------
-- 3. Media reference helpers
-- ---------------------------------------------------------------------------

create or replace function public.media_content_refs(p_content jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(
    pg_catalog.array_agg(distinct m[1] order by m[1]),
    '{}'::text[]
  )
  from pg_catalog.regexp_matches(
    coalesce(p_content, '{}'::jsonb)::text,
    '(media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
    'g'
  ) as m
$fn$;

create or replace function public.assert_publishable_media(p_content jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_ref text;
begin
  foreach v_ref in array public.media_content_refs(p_content) loop
    if not exists (
      select 1
      from public.media_assets as a
      join public.media_public_assets as p on p.asset_id = a.id
      where a.logical_path = v_ref
        and a.status = 'approved'
        and p.state = 'ready'
    ) then
      raise exception 'media asset is not ready for publication' using errcode = 'CC001';
    end if;
  end loop;
end;
$fn$;

-- Record that a ready copy is part of a published version. Called only from the
-- publish/restore RPCs after validation. The first version wins and is never
-- cleared.
create or replace function public.link_published_media(p_content jsonb, p_version bigint)
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.media_public_assets as p
  set linked_version = coalesce(p.linked_version, p_version)
  where p.state = 'ready'
    and p.asset_id in (
      select a.id
      from public.media_assets as a
      where a.logical_path = any (public.media_content_refs(p_content))
    )
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Publish preflight and public-copy RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_media_publish_begin(
  p_expected_version bigint,
  p_expected_draft_revision uuid,
  p_note text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_site public.site_content%rowtype;
  v_draft public.draft%rowtype;
  v_existing jsonb;
  v_op_actor uuid;
  v_op_kind text;
  v_existing_request jsonb;
  v_note text;
  v_ref text;
  v_asset public.media_assets%rowtype;
  v_state text;
  v_path text;
  v_assets jsonb := '[]'::jsonb;
  v_needs jsonb := '[]'::jsonb;
begin
  v_actor := public.assert_admin();

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if p_expected_draft_revision is null then
    raise exception 'draft revision is required' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 200 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  v_note := nullif(p_note, '');

  -- The publish operation is the idempotency record. admin_publish may carry a
  -- content_md5 for direct content publishes while this preflight does not, so
  -- compare only the identifying fields and ignore content_md5. A retry after a
  -- successful publish returns the original result without preparing anything.
  select o.actor_id, o.kind, o.request, o.result
  into v_op_actor, v_op_kind, v_existing_request, v_existing
  from public.content_operations as o
  where o.operation_id = p_operation_id;

  if found then
    if v_op_actor <> v_actor or v_op_kind <> 'publish' then
      raise exception 'operation id belongs to another operation' using errcode = 'PT409';
    end if;
    if (v_existing_request ->> 'expected_version')::bigint is distinct from p_expected_version
      or (v_existing_request ->> 'expected_draft_revision')::uuid is distinct from p_expected_draft_revision
      or nullif(v_existing_request ->> 'note', '') is distinct from v_note
    then
      raise exception 'operation id was reused with different request parameters' using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_build_object('state', 'published', 'result', v_existing);
  end if;

  select *
  into v_site
  from public.site_content as s
  where s.id = 1;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;
  if v_site.version <> p_expected_version then
    raise exception 'stale published version' using errcode = 'PT409';
  end if;

  select *
  into v_draft
  from public.draft as d
  where d.id = 1;

  if not found or v_draft.revision_id <> p_expected_draft_revision then
    raise exception 'stale draft revision' using errcode = 'PT409';
  end if;
  if v_draft.base_version <> v_site.version then
    raise exception 'draft is based on an older published version' using errcode = 'PT409';
  end if;

  foreach v_ref in array public.media_content_refs(v_draft.content) loop
    select a.*
    into v_asset
    from public.media_assets as a
    where a.logical_path = v_ref
      and a.status = 'approved';

    if not found or v_asset.sha256 is null or v_asset.mime is null then
      raise exception 'media asset is not ready for publication' using errcode = 'CC001';
    end if;

    v_state := null;
    v_path := null;
    select p.state, p.object_path
    into v_state, v_path
    from public.media_public_assets as p
    where p.asset_id = v_asset.id;

    v_assets := v_assets || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'id', v_asset.id,
        'logical_path', v_asset.logical_path,
        'sha256', v_asset.sha256,
        'mime', v_asset.mime,
        'bytes', v_asset.bytes,
        'width', v_asset.width,
        'height', v_asset.height,
        'public_state', coalesce(v_state, 'none'),
        'object_path', v_path
      )
    );

    if v_state is distinct from 'ready' then
      v_needs := v_needs || pg_catalog.jsonb_build_array(v_ref);
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'state', case
      when pg_catalog.jsonb_array_length(v_needs) > 0 then 'needs_prepare'
      else 'ready'
    end,
    'version', v_site.version,
    'draft_revision', v_draft.revision_id,
    'assets', v_assets,
    'needs_prepare', v_needs
  );
end;
$fn$;

create or replace function public.admin_media_prepare_public(
  p_asset_id uuid,
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_pub public.media_public_assets%rowtype;
  v_path text;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if v_asset.status <> 'approved'
    or v_asset.sha256 is null
    or v_asset.mime is null
    or v_asset.bytes is null
    or v_asset.width is null
    or v_asset.height is null
    or v_asset.pixel_count is null
  then
    raise exception 'media asset is not approved' using errcode = 'PT409';
  end if;

  insert into public.media_public_assets (
    asset_id, bucket, object_path, state,
    mime, bytes, width, height, pixel_count, sha256
  )
  values (
    v_asset.id,
    'ccafe-public',
    'published/' || v_asset.id::text || '/' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex'),
    'staging',
    v_asset.mime,
    v_asset.bytes,
    v_asset.width,
    v_asset.height,
    v_asset.pixel_count,
    v_asset.sha256
  )
  on conflict (asset_id) do nothing;

  select *
  into v_pub
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'public media row is missing' using errcode = '55000';
  end if;

  if v_pub.state = 'failed' then
    -- The previous attempt never reached ready, so nothing public points at the
    -- old name. Recover with a fresh capability instead of overwriting a path.
    v_path := 'published/' || v_asset.id::text || '/' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    update public.media_public_assets as p
    set state = 'staging',
        object_path = v_path,
        mime = v_asset.mime,
        bytes = v_asset.bytes,
        width = v_asset.width,
        height = v_asset.height,
        pixel_count = v_asset.pixel_count,
        sha256 = v_asset.sha256,
        failure_reason = null,
        prepared_at = pg_catalog.now(),
        confirmed_at = null
    where p.asset_id = p_asset_id
    returning * into v_pub;
  elsif v_pub.state = 'staging' then
    -- Re-assert the approved metadata without changing the object path; a
    -- concurrent upload may already exist at this immutable name.
    update public.media_public_assets as p
    set mime = v_asset.mime,
        bytes = v_asset.bytes,
        width = v_asset.width,
        height = v_asset.height,
        pixel_count = v_asset.pixel_count,
        sha256 = v_asset.sha256,
        failure_reason = null,
        prepared_at = pg_catalog.now()
    where p.asset_id = p_asset_id
    returning * into v_pub;
  end if;

  return pg_catalog.jsonb_build_object(
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'bucket', 'ccafe-public',
    'state', v_pub.state,
    'object_path', v_pub.object_path,
    'mime', v_pub.mime,
    'bytes', v_pub.bytes,
    'width', v_pub.width,
    'height', v_pub.height,
    'pixel_count', v_pub.pixel_count,
    'sha256', v_pub.sha256,
    'linked_version', v_pub.linked_version
  );
end;
$fn$;

create or replace function public.admin_media_confirm_public(
  p_asset_id uuid,
  p_token text,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_pub public.media_public_assets%rowtype;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'public digest is not allowed' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_pub
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'public media row not found' using errcode = 'P0002';
  end if;

  if v_pub.state = 'ready' then
    if v_pub.sha256 = p_sha256 and v_asset.sha256 = p_sha256 then
      return pg_catalog.jsonb_build_object(
        'asset_id', v_pub.asset_id,
        'logical_path', v_asset.logical_path,
        'bucket', v_pub.bucket,
        'state', 'ready',
        'object_path', v_pub.object_path,
        'sha256', v_pub.sha256,
        'linked_version', v_pub.linked_version,
        'idempotent', true
      );
    end if;
    raise exception 'public media was confirmed with different bytes' using errcode = 'PT409';
  end if;

  if v_pub.state <> 'staging' then
    raise exception 'public media is not staging' using errcode = 'PT409';
  end if;
  if v_asset.sha256 is distinct from p_sha256 or v_pub.sha256 is distinct from p_sha256 then
    raise exception 'public digest does not match the approved asset' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from storage.objects as o
    where o.bucket_id = v_pub.bucket
      and o.name = v_pub.object_path
  ) then
    raise exception 'public object is missing' using errcode = 'P0002';
  end if;

  update public.media_public_assets as p
  set state = 'ready',
      confirmed_at = pg_catalog.now(),
      failure_reason = null
  where p.asset_id = p_asset_id
  returning * into v_pub;

  return pg_catalog.jsonb_build_object(
    'asset_id', v_pub.asset_id,
    'logical_path', v_asset.logical_path,
    'bucket', v_pub.bucket,
    'state', 'ready',
    'object_path', v_pub.object_path,
    'sha256', v_pub.sha256,
    'linked_version', v_pub.linked_version,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_fail_public(
  p_asset_id uuid,
  p_token text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pub public.media_public_assets%rowtype;
  v_reason text := pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 200);
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  select *
  into v_pub
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'public media row not found' using errcode = 'P0002';
  end if;

  if v_pub.state = 'ready' and v_pub.linked_version is not null then
    raise exception 'published public media cannot be failed' using errcode = 'PT409';
  end if;
  if v_pub.state = 'failed' then
    return pg_catalog.jsonb_build_object(
      'asset_id', v_pub.asset_id,
      'state', 'failed',
      'failure_reason', v_pub.failure_reason,
      'idempotent', true
    );
  end if;

  update public.media_public_assets as p
  set state = 'failed',
      failure_reason = nullif(v_reason, ''),
      confirmed_at = null
  where p.asset_id = p_asset_id
  returning * into v_pub;

  return pg_catalog.jsonb_build_object(
    'asset_id', v_pub.asset_id,
    'state', 'failed',
    'failure_reason', v_pub.failure_reason,
    'idempotent', false
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Publish/restore: require ready copies and link them to the new version
-- ---------------------------------------------------------------------------

create or replace function public.admin_publish(
  p_expected_version bigint,
  p_expected_draft_revision uuid,
  p_content jsonb,
  p_note text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_now timestamptz := pg_catalog.now();
  v_site public.site_content%rowtype;
  v_draft public.draft%rowtype;
  v_existing jsonb;
  v_content jsonb;
  v_source text;
  v_note text;
  v_request jsonb;
  v_version bigint;
  v_result jsonb;
begin
  v_actor := public.assert_admin();

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 200 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  v_note := nullif(p_note, '');

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  v_request := pg_catalog.jsonb_build_object(
    'expected_version', p_expected_version,
    'expected_draft_revision', p_expected_draft_revision,
    'content_md5', case when p_content is null then null else pg_catalog.md5(p_content::text) end,
    'note', v_note
  );

  v_existing := public.find_operation(p_operation_id, v_actor, 'publish', v_request);
  if v_existing is not null then
    return v_existing;
  end if;

  select *
  into v_site
  from public.site_content as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;
  if v_site.version <> p_expected_version then
    raise exception 'stale published version' using errcode = 'PT409';
  end if;

  if p_expected_draft_revision is not null then
    if p_content is not null then
      raise exception 'content must be null when publishing a draft revision' using errcode = '22023';
    end if;

    select *
    into v_draft
    from public.draft as d
    where d.id = 1
    for update;

    if not found or v_draft.revision_id <> p_expected_draft_revision then
      raise exception 'stale draft revision' using errcode = 'PT409';
    end if;
    if v_draft.base_version <> v_site.version then
      raise exception 'draft is based on an older published version' using errcode = 'PT409';
    end if;

    v_content := v_draft.content;
    v_source := 'draft';
  else
    if p_content is null then
      raise exception 'content is required when no draft revision is supplied' using errcode = '22023';
    end if;

    v_content := p_content;
    v_source := 'content';
  end if;

  perform public.validate_content(v_content);
  perform public.assert_publishable_media(v_content);

  update public.site_content as s
  set version = v_site.version + 1,
      content = v_content,
      saved_at = v_now,
      saved_by = v_actor,
      purge_state = 'pending',
      purge_requested_at = null,
      purge_accepted_at = null,
      purge_error = null,
      purge_operation_id = null,
      public_check_id = null,
      public_check_state = 'pending',
      public_check_observed_version = null,
      public_check_at = null,
      public_check_detail = null
  where s.id = 1
  returning s.version into v_version;

  insert into public.content_history (
    version, content, note, created_at, created_by, operation_id
  )
  values (
    v_version, v_content, v_note, v_now, v_actor, p_operation_id
  );

  if p_expected_draft_revision is not null then
    delete from public.draft as d
    where d.id = 1
      and d.revision_id = p_expected_draft_revision;
  end if;

  perform public.link_published_media(v_content, v_version);
  perform public.trim_content_history();

  v_result := pg_catalog.jsonb_build_object(
    'version', v_version,
    'saved_at', v_now,
    'operation_id', p_operation_id,
    'source', v_source,
    'purge_state', 'pending',
    'public_check_state', 'pending'
  );

  insert into public.content_operations (operation_id, actor_id, kind, request, result)
  values (p_operation_id, v_actor, 'publish', v_request, v_result);

  return v_result;
end;
$fn$;

create or replace function public.admin_restore(
  p_history_id bigint,
  p_expected_version bigint,
  p_note text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_now timestamptz := pg_catalog.now();
  v_site public.site_content%rowtype;
  v_history public.content_history%rowtype;
  v_existing jsonb;
  v_version bigint;
  v_note text;
  v_request jsonb;
  v_result jsonb;
begin
  v_actor := public.assert_admin();

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 200 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  v_note := coalesce(nullif(p_note, ''), 'ط§ط³طھط¹ط§ط¯ط© ظ…ظ† ط§ظ„ط³ط¬ظ„');

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  v_request := pg_catalog.jsonb_build_object(
    'history_id', p_history_id,
    'expected_version', p_expected_version,
    'note', v_note
  );

  v_existing := public.find_operation(p_operation_id, v_actor, 'restore', v_request);
  if v_existing is not null then
    return v_existing;
  end if;

  select *
  into v_site
  from public.site_content as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;
  if v_site.version <> p_expected_version then
    raise exception 'stale published version' using errcode = 'PT409';
  end if;

  select *
  into v_history
  from public.content_history as h
  where h.id = p_history_id;

  if not found then
    raise exception 'history version not found' using errcode = 'P0002';
  end if;

  perform public.validate_content(v_history.content);
  perform public.assert_publishable_media(v_history.content);

  update public.site_content as s
  set version = v_site.version + 1,
      content = v_history.content,
      saved_at = v_now,
      saved_by = v_actor,
      purge_state = 'pending',
      purge_requested_at = null,
      purge_accepted_at = null,
      purge_error = null,
      purge_operation_id = null,
      public_check_id = null,
      public_check_state = 'pending',
      public_check_observed_version = null,
      public_check_at = null,
      public_check_detail = null
  where s.id = 1
  returning s.version into v_version;

  insert into public.content_history (
    version, content, note, created_at, created_by, operation_id
  )
  values (
    v_version, v_history.content, v_note, v_now, v_actor, p_operation_id
  );

  perform public.link_published_media(v_history.content, v_version);
  perform public.trim_content_history();

  v_result := pg_catalog.jsonb_build_object(
    'version', v_version,
    'saved_at', v_now,
    'operation_id', p_operation_id,
    'source', 'restore',
    'restored_from', p_history_id,
    'purge_state', 'pending',
    'public_check_state', 'pending'
  );

  insert into public.content_operations (operation_id, actor_id, kind, request, result)
  values (p_operation_id, v_actor, 'restore', v_request, v_result);

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.assert_media_finalize_token(text) from public, anon, authenticated;
revoke all on function public.media_content_refs(jsonb) from public, anon, authenticated;
revoke all on function public.link_published_media(jsonb, bigint) from public, anon, authenticated;

revoke all on function public.admin_media_finalize(uuid, text, text, bigint, integer, integer, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_media_finalize(uuid, text, text, bigint, integer, integer, bigint, text) to authenticated;

revoke all on function public.admin_media_publish_begin(bigint, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_publish_begin(bigint, uuid, text, uuid) to authenticated;

revoke all on function public.admin_media_prepare_public(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_prepare_public(uuid, text) to authenticated;

revoke all on function public.admin_media_confirm_public(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_media_confirm_public(uuid, text, text) to authenticated;

revoke all on function public.admin_media_fail_public(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_media_fail_public(uuid, text, text) to authenticated;

commit;
