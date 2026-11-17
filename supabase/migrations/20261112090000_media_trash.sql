-- Recoverable deletion for unused uploaded media.
--
-- Goal:
--   An admin may delete an approved upload that is not referenced anywhere, but
--   the bytes must remain recoverable. Nothing is ever permanently deleted by
--   the application: the image is copied to the private ccafe-trash bucket, the
--   asset becomes trashed, and a later request can restore it.
--
-- Lifecycle:
--   approved -> deleting -> trashed -> restoring -> approved
--
--   * admin_media_delete_begin locks the asset, proves it is unused, allocates a
--     random trash object name, sets media_assets.status = 'deleting' and leaves
--     media_trash.state = 'staging'. Once this commits, the asset is no longer a
--     valid content reference, cannot be published, and cannot be restored from
--     the content history.
--   * The server copies the private bytes to ccafe-trash, reads them back, and
--     verifies SHA-256/MIME/size.
--   * admin_media_delete_finish is the database commit point. It requires the
--     exact staging trash object and the server finalize token, marks the trash
--     row stored and the asset trashed. Deleting the private object is a
--     best-effort step after this point; if it fails, cleanup_state stays
--     'pending' and the bytes still exist in both places.
--   * admin_media_restore_begin moves the asset to 'restoring' and authorizes a
--     write to the original private path. The server copies the trash bytes back,
--     re-reads and verifies them, then admin_media_restore_finish marks the asset
--     approved again.
--
-- Atomicity:
--   Storage and Postgres cannot share one transaction. Every step is therefore
--   explicit and retry-safe. A failure before delete_finish is aborted back to
--   approved; a failure after it leaves the asset trashed with a verified trash
--   copy. No API response claims success before the bytes are actually stored.
--
-- Concurrency:
--   Delete begin takes the same advisory lock as draft save/publish/restore, then
--   locks the media row. admin_save_draft is re-validated after that lock, and
--   prepare/confirm public lock the media row and require status = 'approved'.
--   A deleting/trashed/restoring asset is rejected by content validation and by
--   assert_publishable_media, so a stale editor cannot add, publish, or restore a
--   reference once deletion has started.
--
-- Retention:
--   Trash objects are never removed automatically. Restoring keeps the trash
--   copy. Browser/CDN caches and already-published public copies are not revoked
--   by deleting the private asset; removing an image from content never made an
--   old public URL private again.
--
-- Scope guards:
--   * Original assets/ files are not rows in media_assets and cannot be deleted.
--   * No permanent delete RPC or Storage DELETE policy exists for ccafe-trash.
--   * No service_role key or management token is used by the application.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Extend media status and add the trash metadata table
-- ---------------------------------------------------------------------------

alter table public.media_assets
  drop constraint if exists media_assets_status_check;
alter table public.media_assets
  add constraint media_assets_status_check
  check (status in ('pending', 'approved', 'failed', 'deleting', 'trashed', 'restoring'));

comment on column public.media_assets.status is
  'pending = bytes not verified; approved = server-verified/selectable; failed = rejected/abandoned; deleting = locked for a recoverable delete; trashed = removed from active use but recoverable; restoring = trash copy being copied back. Only approved rows are valid content references.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ccafe-trash',
  'ccafe-trash',
  false,
  15728640,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table public.media_trash (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null unique references public.media_assets (id) on delete restrict,
  bucket text not null default 'ccafe-trash' check (bucket = 'ccafe-trash'),
  object_path text not null unique,
  state text not null default 'staging'
    check (state in ('staging', 'stored', 'restoring', 'restored', 'aborted')),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bigint not null check (bytes between 1 and 15728640),
  width integer not null check (width between 1 and 8000),
  height integer not null check (height between 1 and 8000),
  pixel_count bigint not null check (pixel_count between 1 and 32000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  delete_operation_id uuid not null,
  restore_operation_id uuid,
  cleanup_state text not null default 'pending'
    check (cleanup_state in ('pending', 'done')),
  cleanup_error text,
  failure_reason text,
  prepared_at timestamptz not null default now(),
  stored_at timestamptz,
  restore_started_at timestamptz,
  restored_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint media_trash_path_shape check (
    object_path ~ '^trash/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
  ),
  constraint media_trash_stored_shape check (
    state not in ('stored', 'restoring', 'restored')
    or stored_at is not null
  )
);

create index media_trash_state_idx
  on public.media_trash (state, updated_at desc);

comment on table public.media_trash is
  'One recoverable trash copy per uploaded asset. staging = allocated and being copied; stored = bytes copied and verified, asset trashed; restoring = bytes being copied back; restored = asset approved again; aborted = deletion never committed. No automatic permanent deletion.';
comment on column public.media_trash.object_path is
  'Random immutable private object name in ccafe-trash. This is never returned to the browser; only the server uses it.';
comment on column public.media_trash.cleanup_state is
  'Best-effort cleanup of the original private object after delete_finish. pending keeps the old object (and the trash copy) until a retry succeeds.';
comment on column public.media_trash.restore_operation_id is
  'Operation id of the last restore attempt, used for retry-safe begin/finish/abort.';

alter table public.media_trash enable row level security;
revoke all on table public.media_trash from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Storage-policy helpers
-- ---------------------------------------------------------------------------

create or replace function public.media_trash_storage_path(
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
      from public.media_trash as t
      join public.media_assets as a on a.id = t.asset_id
      where t.object_path = p_name
        and t.state = any (p_states)
        and a.status in ('deleting', 'trashed', 'restoring')
    );
$fn$;

comment on function public.media_trash_storage_path(text, text[]) is
  'Storage-policy helper: true only for an admin and an exact registered trash object name in one of the allowed states. Returns a boolean, never the path.';

-- Restore and cleanup policies also need to read media_trash. They must go
-- through SECURITY DEFINER helpers: policy expressions run as the caller, and
-- authenticated has no direct SELECT on media_trash (its random object names
-- must never be enumerable from the browser).
create or replace function public.media_restore_storage_path(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin()
    and exists (
      select 1
      from public.media_assets as a
      join public.media_trash as t on t.asset_id = a.id
      where a.storage_path = p_name
        and a.status = 'restoring'
        and t.state = 'restoring'
    );
$fn$;

create or replace function public.media_trash_cleanup_storage_path(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin()
    and exists (
      select 1
      from public.media_assets as a
      join public.media_trash as t on t.asset_id = a.id
      where a.storage_path = p_name
        and a.status = 'trashed'
        and t.state = 'stored'
        and t.cleanup_state = 'pending'
    );
$fn$;

revoke all on function public.media_restore_storage_path(text) from public, anon, authenticated;
grant execute on function public.media_restore_storage_path(text) to authenticated;

revoke all on function public.media_trash_cleanup_storage_path(text) from public, anon, authenticated;
grant execute on function public.media_trash_cleanup_storage_path(text) to authenticated;

revoke all on function public.media_trash_storage_path(text, text[]) from public, anon, authenticated;
grant execute on function public.media_trash_storage_path(text, text[]) to authenticated;

-- Private trash bucket policies:
--   * read/upload only the exact object name allocated by delete_begin;
--   * no UPDATE and no DELETE policy, so trash bytes are immutable and are never
--     permanently removed by the application.
drop policy if exists ccafe_trash_admin_read on storage.objects;
create policy ccafe_trash_admin_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ccafe-trash'
    and public.is_admin()
    and public.media_trash_storage_path(storage.objects.name, array['staging', 'stored', 'restoring'])
  );

drop policy if exists ccafe_trash_admin_upload on storage.objects;
create policy ccafe_trash_admin_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ccafe-trash'
    and public.is_admin()
    and public.media_trash_storage_path(storage.objects.name, array['staging'])
  );

-- Restoring writes back to the exact original private path. INSERT is denied
-- while any other asset state is in effect; there is still no UPDATE policy, so
-- an existing object cannot be replaced. The server verifies the existing bytes
-- when the insert reports a conflict.
drop policy if exists ccafe_media_admin_restore_upload on storage.objects;
create policy ccafe_media_admin_restore_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ccafe-media'
    and public.media_restore_storage_path(storage.objects.name)
  );

-- Cleanup of the original private object after a committed trash copy. This can
-- only remove bytes whose asset is already trashed and whose trash row is
-- stored; it never touches approved, deleting, or restoring assets.
drop policy if exists ccafe_media_admin_trash_cleanup on storage.objects;
create policy ccafe_media_admin_trash_cleanup on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-media'
    and public.media_trash_cleanup_storage_path(storage.objects.name)
  );

-- ---------------------------------------------------------------------------
-- 3. Usage: exact reference checks
-- ---------------------------------------------------------------------------

create or replace function public.media_asset_usage(p_asset_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_published boolean := false;
  v_draft boolean := false;
  v_history_count integer := 0;
  v_public_state text;
  v_public_linked bigint;
  v_reasons text[] := '{}'::text[];
begin
  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id;

  if not found then
    return null;
  end if;

  select exists (
    select 1
    from public.site_content as s
    where s.id = 1
      and v_asset.logical_path = any (public.media_content_refs(s.content))
  )
  into v_published;

  select exists (
    select 1
    from public.draft as d
    where v_asset.logical_path = any (public.media_content_refs(d.content))
  )
  into v_draft;

  select count(*)::integer
  into v_history_count
  from public.content_history as h
  where v_asset.logical_path = any (public.media_content_refs(h.content));

  select p.state, p.linked_version
  into v_public_state, v_public_linked
  from public.media_public_assets as p
  where p.asset_id = p_asset_id;

  if v_asset.status <> 'approved' then
    v_reasons := v_reasons || 'not_approved'::text;
  end if;
  if v_published then
    v_reasons := v_reasons || 'published'::text;
  end if;
  if v_draft then
    v_reasons := v_reasons || 'draft'::text;
  end if;
  if v_history_count > 0 then
    v_reasons := v_reasons || 'history'::text;
  end if;
  if v_public_state = 'ready' then
    v_reasons := v_reasons || 'public_ready'::text;
  end if;

  return pg_catalog.jsonb_build_object(
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'original_name', v_asset.original_name,
    'status', v_asset.status,
    'deletable', pg_catalog.cardinality(v_reasons) = 0,
    'reasons', pg_catalog.to_jsonb(v_reasons),
    'references', pg_catalog.jsonb_build_object(
      'published', v_published,
      'draft', v_draft,
      'history_count', v_history_count,
      'public_state', v_public_state,
      'public_linked_version', v_public_linked
    )
  );
end;
$fn$;

revoke all on function public.media_asset_usage(uuid) from public, anon, authenticated;

create or replace function public.admin_media_usage(p_asset_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_usage jsonb;
begin
  perform public.assert_admin();

  v_usage := public.media_asset_usage(p_asset_id);
  if v_usage is null then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  return v_usage;
end;
$fn$;

comment on function public.admin_media_usage(uuid) is
  'Admin-only usage report: published, draft, restorable history, and public-copy references. The delete RPC rechecks the same conditions under lock.';

create or replace function public.admin_media_trash_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_items jsonb;
begin
  perform public.assert_admin();

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'asset_id', t.asset_id,
        'logical_path', a.logical_path,
        'original_name', a.original_name,
        'mime', t.mime,
        'bytes', t.bytes,
        'width', t.width,
        'height', t.height,
        'deleted_at', t.stored_at,
        'state', case when a.status = 'restoring' then 'restoring' else 'trashed' end,
        'cleanup_state', t.cleanup_state,
        'cleanup_error', case
          when t.cleanup_error is null then null
          else pg_catalog.left(t.cleanup_error, 200)
        end,
        'restore_error', case
          when t.failure_reason is null then null
          else pg_catalog.left(t.failure_reason, 200)
        end
      )
      order by t.stored_at desc nulls last, t.created_at desc
    ),
    '[]'::jsonb
  )
  into v_items
  from public.media_trash as t
  join public.media_assets as a on a.id = t.asset_id
  where a.status in ('trashed', 'restoring')
    and t.state in ('stored', 'restoring');

  return pg_catalog.jsonb_build_object('items', v_items);
end;
$fn$;

comment on function public.admin_media_trash_list() is
  'Lists recoverable trashed assets. The random trash object name is never returned to the browser.';

-- ---------------------------------------------------------------------------
-- 4. Delete RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_media_delete_begin(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
  v_usage jsonb;
  v_path text;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  -- Serialize with draft save/publish/restore, then lock the media row.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if v_asset.status = 'trashed' then
    if found
      and v_trash.state = 'stored'
      and v_trash.delete_operation_id = p_operation_id
      and v_trash.sha256 = v_asset.sha256
    then
      return pg_catalog.jsonb_build_object(
        'state', 'trashed',
        'asset_id', v_asset.id,
        'logical_path', v_asset.logical_path,
        'trash_state', v_trash.state,
        'cleanup_state', v_trash.cleanup_state,
        'cleanup_error', v_trash.cleanup_error,
        'sha256', v_trash.sha256,
        'idempotent', true
      );
    end if;
    raise exception 'media asset is already trashed' using errcode = 'PT409';
  end if;

  if v_asset.status = 'deleting' then
    if found
      and v_trash.state = 'staging'
      and v_trash.delete_operation_id = p_operation_id
    then
      return pg_catalog.jsonb_build_object(
        'state', 'staging',
        'asset_id', v_asset.id,
        'logical_path', v_asset.logical_path,
        'bucket', v_trash.bucket,
        'object_path', v_trash.object_path,
        'mime', v_trash.mime,
        'bytes', v_trash.bytes,
        'width', v_trash.width,
        'height', v_trash.height,
        'pixel_count', v_trash.pixel_count,
        'sha256', v_trash.sha256,
        'trash_state', v_trash.state,
        'idempotent', true
      );
    end if;
    raise exception 'media deletion is already in progress' using errcode = 'PT409';
  end if;

  if v_asset.status = 'restoring' then
    raise exception 'media asset is being restored' using errcode = 'PT409';
  end if;
  if v_asset.status <> 'approved' then
    raise exception 'media asset is not approved' using errcode = 'PT409';
  end if;

  -- Recompute usage after the advisory lock. A writer that committed before this
  -- point is now visible; a writer that starts later waits for this transaction.
  v_usage := public.media_asset_usage(p_asset_id);
  if v_usage is null then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if not (v_usage ->> 'deletable')::boolean then
    return pg_catalog.jsonb_build_object(
      'state', 'blocked',
      'asset_id', v_asset.id,
      'logical_path', v_asset.logical_path,
      'reasons', v_usage -> 'reasons',
      'references', v_usage -> 'references'
    );
  end if;

  -- An unlinked staging public copy is not served to anyone. Invalidate it rather
  -- than leaving a stale capability that would block deletion forever. A ready
  -- copy (linked or not) is a hard blocker above.
  update public.media_public_assets as p
  set state = 'failed',
      failure_reason = 'asset_deleting',
      confirmed_at = null
  where p.asset_id = p_asset_id
    and p.state = 'staging'
    and p.linked_version is null;

  v_path := 'trash/' || v_asset.id::text || '/'
    || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.media_trash (
    asset_id, bucket, object_path, state,
    mime, bytes, width, height, pixel_count, sha256,
    delete_operation_id, cleanup_state, prepared_at
  )
  values (
    v_asset.id,
    'ccafe-trash',
    v_path,
    'staging',
    v_asset.mime,
    v_asset.bytes,
    v_asset.width,
    v_asset.height,
    v_asset.pixel_count,
    v_asset.sha256,
    p_operation_id,
    'pending',
    pg_catalog.now()
  )
  on conflict (asset_id) do update
  set bucket = excluded.bucket,
      object_path = excluded.object_path,
      state = 'staging',
      mime = excluded.mime,
      bytes = excluded.bytes,
      width = excluded.width,
      height = excluded.height,
      pixel_count = excluded.pixel_count,
      sha256 = excluded.sha256,
      delete_operation_id = excluded.delete_operation_id,
      restore_operation_id = null,
      cleanup_state = 'pending',
      cleanup_error = null,
      failure_reason = null,
      prepared_at = pg_catalog.now(),
      stored_at = null,
      restore_started_at = null,
      restored_at = null,
      updated_at = pg_catalog.now()
  returning * into v_trash;

  update public.media_assets as a
  set status = 'deleting',
      failure_reason = null
  where a.id = p_asset_id;

  return pg_catalog.jsonb_build_object(
    'state', 'staging',
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'bucket', v_trash.bucket,
    'object_path', v_trash.object_path,
    'mime', v_trash.mime,
    'bytes', v_trash.bytes,
    'width', v_trash.width,
    'height', v_trash.height,
    'pixel_count', v_trash.pixel_count,
    'sha256', v_trash.sha256,
    'trash_state', v_trash.state,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_delete_finish(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
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

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'trash row not found' using errcode = 'P0002';
  end if;

  if v_asset.status = 'trashed'
    and v_trash.state = 'stored'
    and v_trash.delete_operation_id = p_operation_id
    and v_trash.sha256 = p_sha256
    and v_asset.sha256 = p_sha256
  then
    return pg_catalog.jsonb_build_object(
      'state', 'trashed',
      'asset_id', v_asset.id,
      'logical_path', v_asset.logical_path,
      'cleanup_state', v_trash.cleanup_state,
      'cleanup_error', v_trash.cleanup_error,
      'sha256', v_trash.sha256,
      'idempotent', true
    );
  end if;

  if v_asset.status <> 'deleting' then
    raise exception 'media asset is not being deleted' using errcode = 'PT409';
  end if;
  if v_trash.delete_operation_id <> p_operation_id then
    raise exception 'delete operation does not match' using errcode = 'PT409';
  end if;
  if v_trash.state <> 'staging' and v_trash.state <> 'stored' then
    raise exception 'trash copy is not staged' using errcode = 'PT409';
  end if;
  if v_asset.sha256 is distinct from p_sha256
    or v_trash.sha256 is distinct from p_sha256
  then
    raise exception 'trash digest does not match the approved asset' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from storage.objects as o
    where o.bucket_id = v_trash.bucket
      and o.name = v_trash.object_path
  ) then
    raise exception 'trash object is missing' using errcode = 'P0002';
  end if;

  update public.media_trash as t
  set state = 'stored',
      stored_at = coalesce(t.stored_at, pg_catalog.now()),
      failure_reason = null,
      cleanup_error = null,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  update public.media_assets as a
  set status = 'trashed',
      failure_reason = null
  where a.id = p_asset_id;

  return pg_catalog.jsonb_build_object(
    'state', 'trashed',
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'cleanup_state', v_trash.cleanup_state,
    'cleanup_error', v_trash.cleanup_error,
    'sha256', v_trash.sha256,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_delete_abort(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
  v_reason text := pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 200);
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if v_asset.status = 'approved'
    and found
    and v_trash.state = 'aborted'
    and v_trash.delete_operation_id = p_operation_id
  then
    return pg_catalog.jsonb_build_object(
      'state', 'approved',
      'asset_id', v_asset.id,
      'aborted', true,
      'idempotent', true
    );
  end if;

  if v_asset.status = 'trashed' then
    raise exception 'media deletion is already committed' using errcode = 'PT409';
  end if;
  if v_asset.status <> 'deleting'
    or not found
    or v_trash.delete_operation_id <> p_operation_id
    or v_trash.state <> 'staging'
  then
    raise exception 'delete operation cannot be aborted' using errcode = 'PT409';
  end if;

  update public.media_trash as t
  set state = 'aborted',
      failure_reason = nullif(v_reason, ''),
      stored_at = null,
      restore_started_at = null,
      restored_at = null,
      cleanup_error = null,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  update public.media_assets as a
  set status = 'approved',
      failure_reason = null
  where a.id = p_asset_id;

  return pg_catalog.jsonb_build_object(
    'state', 'approved',
    'asset_id', v_asset.id,
    'aborted', true,
    'failure_reason', v_trash.failure_reason,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_delete_cleanup(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_done boolean,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
  v_error text := pg_catalog.left(pg_catalog.btrim(coalesce(p_error, '')), 200);
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  -- A null operation id means "retry cleanup" from the trash list, after the
  -- original idempotency key was lost with the page. It may only update the
  -- bookkeeping of an already stored trash copy; it cannot change any asset
  -- state or delete bytes (the Storage DELETE policy still requires the stored,
  -- trashed row).
  if v_asset.status <> 'trashed'
    or not found
    or v_trash.state <> 'stored'
    or (
      p_operation_id is not null
      and v_trash.delete_operation_id <> p_operation_id
    )
  then
    raise exception 'trash cleanup does not match a trashed asset' using errcode = 'PT409';
  end if;

  update public.media_trash as t
  set cleanup_state = case when p_done then 'done' else 'pending' end,
      cleanup_error = case when p_done then null else nullif(v_error, '') end,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  return pg_catalog.jsonb_build_object(
    'state', 'trashed',
    'asset_id', v_asset.id,
    'cleanup_state', v_trash.cleanup_state,
    'cleanup_error', v_trash.cleanup_error
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Restore RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_media_restore_begin(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'trash row not found' using errcode = 'P0002';
  end if;

  if v_asset.status = 'approved'
    and v_trash.state = 'restored'
    and v_trash.restore_operation_id = p_operation_id
  then
    return pg_catalog.jsonb_build_object(
      'state', 'approved',
      'asset_id', v_asset.id,
      'logical_path', v_asset.logical_path,
      'idempotent', true
    );
  end if;

  if v_asset.status = 'restoring' then
    if v_trash.state = 'restoring'
      and v_trash.restore_operation_id = p_operation_id
    then
      return pg_catalog.jsonb_build_object(
        'state', 'restoring',
        'asset_id', v_asset.id,
        'logical_path', v_asset.logical_path,
        'bucket', 'ccafe-media',
        'storage_path', v_asset.storage_path,
        'trash_bucket', v_trash.bucket,
        'trash_object_path', v_trash.object_path,
        'mime', v_trash.mime,
        'bytes', v_trash.bytes,
        'width', v_trash.width,
        'height', v_trash.height,
        'pixel_count', v_trash.pixel_count,
        'sha256', v_trash.sha256,
        'idempotent', true
      );
    end if;
    raise exception 'media restore is already in progress' using errcode = 'PT409';
  end if;

  if v_asset.status <> 'trashed' then
    raise exception 'media asset is not trashed' using errcode = 'PT409';
  end if;
  if v_trash.state <> 'stored' then
    raise exception 'trash copy is not stored' using errcode = 'PT409';
  end if;
  if v_trash.sha256 is distinct from v_asset.sha256 then
    raise exception 'trash digest does not match the asset' using errcode = 'PT409';
  end if;

  if not exists (
    select 1
    from storage.objects as o
    where o.bucket_id = v_trash.bucket
      and o.name = v_trash.object_path
  ) then
    raise exception 'trash object is missing' using errcode = 'P0002';
  end if;

  update public.media_trash as t
  set state = 'restoring',
      restore_operation_id = p_operation_id,
      restore_started_at = pg_catalog.now(),
      failure_reason = null,
      cleanup_error = null,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  update public.media_assets as a
  set status = 'restoring',
      failure_reason = null
  where a.id = p_asset_id;

  return pg_catalog.jsonb_build_object(
    'state', 'restoring',
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'bucket', 'ccafe-media',
    'storage_path', v_asset.storage_path,
    'trash_bucket', v_trash.bucket,
    'trash_object_path', v_trash.object_path,
    'mime', v_trash.mime,
    'bytes', v_trash.bytes,
    'width', v_trash.width,
    'height', v_trash.height,
    'pixel_count', v_trash.pixel_count,
    'sha256', v_trash.sha256,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_restore_finish(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'trash row not found' using errcode = 'P0002';
  end if;

  if v_asset.status = 'approved'
    and v_trash.state = 'restored'
    and v_trash.restore_operation_id = p_operation_id
  then
    return pg_catalog.jsonb_build_object(
      'state', 'approved',
      'asset_id', v_asset.id,
      'logical_path', v_asset.logical_path,
      'mime', v_asset.mime,
      'bytes', v_asset.bytes,
      'width', v_asset.width,
      'height', v_asset.height,
      'pixel_count', v_asset.pixel_count,
      'sha256', v_asset.sha256,
      'idempotent', true
    );
  end if;

  if v_asset.status <> 'restoring'
    or v_trash.state <> 'restoring'
    or v_trash.restore_operation_id <> p_operation_id
  then
    raise exception 'media restore is not in progress' using errcode = 'PT409';
  end if;
  if v_asset.mime is null
    or v_asset.bytes is null
    or v_asset.width is null
    or v_asset.height is null
    or v_asset.pixel_count is null
    or v_asset.sha256 is null
    or v_asset.verified_at is null
  then
    raise exception 'approved media metadata is incomplete' using errcode = 'PT409';
  end if;
  if v_trash.sha256 is distinct from v_asset.sha256 then
    raise exception 'trash digest does not match the asset' using errcode = 'PT409';
  end if;

  if not exists (
    select 1
    from storage.objects as o
    where o.bucket_id = 'ccafe-media'
      and o.name = v_asset.storage_path
  ) then
    raise exception 'restored private object is missing' using errcode = 'P0002';
  end if;

  update public.media_trash as t
  set state = 'restored',
      restored_at = pg_catalog.now(),
      cleanup_state = 'done',
      cleanup_error = null,
      failure_reason = null,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  update public.media_assets as a
  set status = 'approved',
      failure_reason = null
  where a.id = p_asset_id
  returning * into v_asset;

  return pg_catalog.jsonb_build_object(
    'state', 'approved',
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'mime', v_asset.mime,
    'bytes', v_asset.bytes,
    'width', v_asset.width,
    'height', v_asset.height,
    'pixel_count', v_asset.pixel_count,
    'sha256', v_asset.sha256,
    'idempotent', false
  );
end;
$fn$;

create or replace function public.admin_media_restore_abort(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
  v_reason text := pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 200);
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if v_asset.status = 'trashed'
    and found
    and v_trash.state = 'stored'
    and v_trash.restore_operation_id = p_operation_id
  then
    return pg_catalog.jsonb_build_object(
      'state', 'trashed',
      'asset_id', v_asset.id,
      'aborted', true,
      'idempotent', true
    );
  end if;

  if v_asset.status <> 'restoring'
    or not found
    or v_trash.state <> 'restoring'
    or v_trash.restore_operation_id <> p_operation_id
  then
    raise exception 'media restore cannot be aborted' using errcode = 'PT409';
  end if;

  update public.media_trash as t
  set state = 'stored',
      failure_reason = nullif(v_reason, ''),
      restored_at = null,
      cleanup_state = 'pending',
      cleanup_error = nullif(v_reason, ''),
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  update public.media_assets as a
  set status = 'trashed',
      failure_reason = null
  where a.id = p_asset_id;

  return pg_catalog.jsonb_build_object(
    'state', 'trashed',
    'asset_id', v_asset.id,
    'aborted', true,
    'failure_reason', v_trash.failure_reason,
    'idempotent', false
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Close the existing races
-- ---------------------------------------------------------------------------

-- Validate after taking the content lock. Before this migration the validation
-- ran first, so a save that started before a delete could commit a reference to
-- an asset that was already deleting.
create or replace function public.admin_save_draft(
  p_expected_version bigint,
  p_expected_revision uuid,
  p_content jsonb
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
  v_revision uuid;
begin
  v_actor := public.assert_admin();

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

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

  -- Re-checked after the lock: a concurrent delete now sees a stable asset
  -- status, and this save sees a deleting/trashed asset as an invalid reference.
  -- Keep this before the draft SELECT so FOUND still describes that SELECT.
  perform public.validate_content(p_content);

  select *
  into v_draft
  from public.draft as d
  where d.id = 1
  for update;

  if found then
    if p_expected_revision is null or v_draft.revision_id <> p_expected_revision then
      raise exception 'stale draft revision' using errcode = 'PT409';
    end if;

    update public.draft as d
    set content = p_content,
        revision_id = gen_random_uuid(),
        base_version = v_site.version,
        updated_at = v_now,
        updated_by = v_actor
    where d.id = 1
    returning d.revision_id into v_revision;
  else
    if p_expected_revision is not null then
      raise exception 'stale draft revision' using errcode = 'PT409';
    end if;

    insert into public.draft (id, content, base_version, updated_at, updated_by)
    values (1, p_content, v_site.version, v_now, v_actor)
    returning revision_id into v_revision;
  end if;

  return pg_catalog.jsonb_build_object(
    'revision_id', v_revision,
    'base_version', v_site.version,
    'updated_at', v_now
  );
end;
$fn$;

-- Lock the asset and require approved status before a public copy is staged or
-- confirmed. This prevents a delete from racing between the status check and the
-- metadata write.
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
  where a.id = p_asset_id
  for update;

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
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if v_asset.status <> 'approved' then
    raise exception 'media asset is not approved' using errcode = 'PT409';
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

-- Only pending uploads may be failed. A deleting/trashed/restoring asset must go
-- through the delete/restore RPCs so a stray failure call cannot bypass the lock.
create or replace function public.admin_media_fail(
  p_asset_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_asset public.media_assets%rowtype;
  v_reason text := pg_catalog.left(pg_catalog.btrim(coalesce(p_reason, '')), 200);
begin
  v_actor := public.assert_admin();

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
    raise exception 'approved media cannot be marked failed' using errcode = 'PT409';
  end if;
  if v_asset.status = 'failed' then
    return pg_catalog.jsonb_build_object(
      'id', v_asset.id,
      'status', 'failed',
      'failure_reason', v_asset.failure_reason,
      'idempotent', true
    );
  end if;
  if v_asset.status <> 'pending' then
    raise exception 'media asset is not pending' using errcode = 'PT409';
  end if;

  update public.media_assets as a
  set status = 'failed',
      failure_reason = nullif(v_reason, ''),
      verified_by = null,
      verified_at = null,
      finalized_at = null,
      verification_started_at = null
  where a.id = p_asset_id
  returning * into v_asset;

  return pg_catalog.jsonb_build_object(
    'id', v_asset.id,
    'status', 'failed',
    'failure_reason', v_asset.failure_reason,
    'idempotent', false
  );
end;
$fn$;

-- Admins may see idle/trashed metadata for any uploader so any admin can manage
-- the shared library. The random trash object name is still only in media_trash,
-- which no API role can read directly.
drop policy if exists media_assets_admin_read on public.media_assets;
create policy media_assets_admin_read on public.media_assets
  for select to authenticated
  using (
    public.is_admin()
    and (
      status in ('approved', 'deleting', 'trashed', 'restoring')
      or created_by = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.admin_media_usage(uuid) from public, anon, authenticated;
grant execute on function public.admin_media_usage(uuid) to authenticated;

revoke all on function public.admin_media_trash_list() from public, anon, authenticated;
grant execute on function public.admin_media_trash_list() to authenticated;

revoke all on function public.admin_media_delete_begin(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_delete_begin(uuid, text, uuid) to authenticated;

revoke all on function public.admin_media_delete_finish(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_delete_finish(uuid, text, uuid, text) to authenticated;

revoke all on function public.admin_media_delete_abort(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_delete_abort(uuid, text, uuid, text) to authenticated;

revoke all on function public.admin_media_delete_cleanup(uuid, text, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_media_delete_cleanup(uuid, text, uuid, boolean, text) to authenticated;

revoke all on function public.admin_media_restore_begin(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_restore_begin(uuid, text, uuid) to authenticated;

revoke all on function public.admin_media_restore_finish(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_restore_finish(uuid, text, uuid) to authenticated;

revoke all on function public.admin_media_restore_abort(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_restore_abort(uuid, text, uuid, text) to authenticated;

commit;
