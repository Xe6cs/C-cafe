-- Local-only migration: permanent media purge from trash + single history-row delete.
--
-- This migration is intentionally not applied to cloud in this task.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Single history-row delete
-- ---------------------------------------------------------------------------

alter table public.content_operations
  drop constraint if exists content_operations_kind_check;

alter table public.content_operations
  add constraint content_operations_kind_check
  check (kind in ('publish', 'restore', 'clear_history', 'delete_history_entry', 'media_purge'));

create or replace function public.admin_delete_content_history_entry(
  p_history_id bigint,
  p_operation_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_now timestamptz := pg_catalog.now();
  v_existing jsonb;
  v_request jsonb;
  v_target public.content_history%rowtype;
  v_site public.site_content%rowtype;
  v_result jsonb;
begin
  v_actor := public.assert_admin();

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if p_history_id is null or p_history_id < 1 then
    raise exception 'history id is required' using errcode = '22023';
  end if;
  if coalesce(p_confirmation, '') <> 'حذف هذه النسخة نهائيًا' then
    raise exception 'confirmation is required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  v_request := pg_catalog.jsonb_build_object(
    'history_id', p_history_id,
    'confirmation', 'حذف هذه النسخة نهائيًا'
  );

  v_existing := public.find_operation(p_operation_id, v_actor, 'delete_history_entry', v_request);
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

  select *
  into v_target
  from public.content_history as h
  where h.id = p_history_id
  for update;

  if not found then
    raise exception 'history version not found' using errcode = 'P0002';
  end if;

  delete from public.content_history as h
  where h.id = p_history_id;

  v_result := pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id,
    'history_id', v_target.id,
    'version', v_target.version,
    'deleted', true,
    'current_published_version', v_site.version,
    'was_current_published_version', v_target.version = v_site.version,
    'deleted_at', v_now
  );

  insert into public.content_operations (operation_id, actor_id, kind, request, result)
  values (p_operation_id, v_actor, 'delete_history_entry', v_request, v_result);

  return v_result;
end;
$fn$;

revoke all on function public.admin_delete_content_history_entry(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_delete_content_history_entry(bigint, uuid, text) to authenticated;
-- ---------------------------------------------------------------------------
-- 2. Permanent media purge (trash -> gone)
-- ---------------------------------------------------------------------------

alter table public.media_assets
  drop constraint if exists media_assets_status_check;
alter table public.media_assets
  add constraint media_assets_status_check
  check (status in ('pending', 'approved', 'failed', 'deleting', 'trashed', 'restoring', 'purging'));

comment on column public.media_assets.status is
  'pending = bytes not verified; approved = server-verified/selectable; failed = rejected/abandoned; deleting = locked for recoverable delete; trashed = recoverable in trash; restoring = trash copy being copied back; purging = permanent delete in progress from trash. Only approved rows are valid content references.';

create table if not exists public.media_purge (
  asset_id uuid primary key,
  logical_path text not null,
  original_name text not null default '',
  private_bucket text not null default 'ccafe-media' check (private_bucket = 'ccafe-media'),
  private_object_path text not null,
  trash_bucket text not null default 'ccafe-trash' check (trash_bucket = 'ccafe-trash'),
  trash_object_path text not null,
  public_bucket text not null default 'ccafe-public' check (public_bucket = 'ccafe-public'),
  public_object_path text,
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp')),
  bytes bigint not null check (bytes between 1 and 15728640),
  width integer not null check (width between 1 and 8000),
  height integer not null check (height between 1 and 8000),
  pixel_count bigint not null check (pixel_count between 1 and 32000000),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  operation_id uuid not null,
  state text not null default 'purging' check (state in ('purging', 'purged')),
  private_cleanup_state text not null default 'pending' check (private_cleanup_state in ('pending', 'done')),
  trash_cleanup_state text not null default 'pending' check (trash_cleanup_state in ('pending', 'done')),
  public_cleanup_state text not null default 'none' check (public_cleanup_state in ('none', 'pending', 'done')),
  private_cleanup_error text,
  trash_cleanup_error text,
  public_cleanup_error text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint media_purge_private_path_shape check (private_object_path ~ '^media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint media_purge_trash_path_shape check (trash_object_path ~ '^trash/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'),
  constraint media_purge_public_path_shape check (
    public_object_path is null
    or public_object_path ~ '^published/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
  ),
  constraint media_purge_public_cleanup_shape check (
    (public_object_path is null and public_cleanup_state = 'none')
    or (public_object_path is not null and public_cleanup_state in ('pending', 'done'))
  ),
  constraint media_purge_purged_shape check (
    state <> 'purged'
    or (
      completed_at is not null
      and private_cleanup_state = 'done'
      and trash_cleanup_state = 'done'
      and public_cleanup_state in ('none', 'done')
    )
  )
);

create unique index if not exists media_purge_operation_id_key
  on public.media_purge (operation_id);

create index if not exists media_purge_state_idx
  on public.media_purge (state, updated_at desc);

comment on table public.media_purge is
  'Durable permanent-delete record. Survives after media_assets/media_trash rows are removed so lost responses can resume safely with the same operation_id. It stores only server-managed paths and cleanup state; no public/browser capability is exposed.';
-- ---------------------------------------------------------------------------
-- 3. Helpers / guards
-- ---------------------------------------------------------------------------

create or replace function public.media_purge_storage_path(p_name text, p_bucket text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.media_purge as p
    where p.state = 'purging'
      and (
        (p_bucket = 'ccafe-media' and p.private_cleanup_state = 'pending' and p.private_object_path = p_name)
        or (p_bucket = 'ccafe-trash' and p.trash_cleanup_state = 'pending' and p.trash_object_path = p_name)
        or (p_bucket = 'ccafe-public' and p.public_cleanup_state = 'pending' and p.public_object_path = p_name)
      )
  );
$fn$;

revoke all on function public.media_purge_storage_path(text, text) from public, anon, authenticated;
grant execute on function public.media_purge_storage_path(text, text) to authenticated;

drop policy if exists ccafe_media_admin_purge_cleanup on storage.objects;
create policy ccafe_media_admin_purge_cleanup on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-media'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-media')
  );

drop policy if exists ccafe_media_admin_purge_read on storage.objects;
create policy ccafe_media_admin_purge_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ccafe-media'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-media')
  );

drop policy if exists ccafe_trash_admin_purge_read on storage.objects;
create policy ccafe_trash_admin_purge_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ccafe-trash'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-trash')
  );

drop policy if exists ccafe_trash_admin_purge_delete on storage.objects;
create policy ccafe_trash_admin_purge_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-trash'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-trash')
  );

drop policy if exists ccafe_public_admin_purge_read on storage.objects;
create policy ccafe_public_admin_purge_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ccafe-public'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-public')
  );

drop policy if exists ccafe_public_admin_purge_delete on storage.objects;
create policy ccafe_public_admin_purge_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-public'
    and public.is_admin()
    and public.media_purge_storage_path(storage.objects.name, 'ccafe-public')
  );
-- ---------------------------------------------------------------------------
-- 3b. Purge-specific reference helpers
--
-- media_asset_usage() is intentionally unchanged: the recoverable delete flow
-- still requires an approved asset. A purge starts from the trash, so it needs
-- its own usage check that ignores status/public_ready but still blocks on any
-- published, draft, or restorable-history reference. Bare asset ids and public
-- links are treated as references too, not only the canonical media/<uuid> path.
-- ---------------------------------------------------------------------------

create or replace function public.media_purge_content_has_ref(
  p_content jsonb,
  p_asset_id uuid
)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_asset_id is not null
    and coalesce(p_content, '{}'::jsonb)::text ~ (
      '(^|[^0-9a-f])' || p_asset_id::text || '([^0-9a-f]|$)'
    )
$fn$;

revoke all on function public.media_purge_content_has_ref(jsonb, uuid) from public, anon, authenticated;

create or replace function public.media_purge_usage(p_asset_id uuid)
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
      and public.media_purge_content_has_ref(s.content, p_asset_id)
  )
  into v_published;

  select exists (
    select 1
    from public.draft as d
    where public.media_purge_content_has_ref(d.content, p_asset_id)
  )
  into v_draft;

  select count(*)::integer
  into v_history_count
  from public.content_history as h
  where public.media_purge_content_has_ref(h.content, p_asset_id);

  select p.state, p.linked_version
  into v_public_state, v_public_linked
  from public.media_public_assets as p
  where p.asset_id = p_asset_id;

  if v_published then
    v_reasons := v_reasons || 'published'::text;
  end if;
  if v_draft then
    v_reasons := v_reasons || 'draft'::text;
  end if;
  if v_history_count > 0 then
    v_reasons := v_reasons || 'history'::text;
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

revoke all on function public.media_purge_usage(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Permanent purge RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_media_purge_begin(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_asset public.media_assets%rowtype;
  v_trash public.media_trash%rowtype;
  v_public public.media_public_assets%rowtype;
  v_purge public.media_purge%rowtype;
  v_usage jsonb;
  v_public_path text;
  v_public_cleanup_state text := 'none';
begin
  v_actor := public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if p_asset_id is null then
    raise exception 'asset id is required' using errcode = '22023';
  end if;
  if coalesce(p_confirmation, '') <> 'حذف الصورة نهائيًا' then
    raise exception 'confirmation is required' using errcode = '22023';
  end if;

  -- Same content lock domain as save/publish/restore/delete. This blocks new
  -- content references from being committed while we re-check usage and mark the
  -- trashed asset as purging. The purging status remains until all storage/DB
  -- cleanup completes, preventing restore/publish/reference creation during the
  -- out-of-transaction storage deletion phase.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  select *
  into v_purge
  from public.media_purge as p
  where p.operation_id = p_operation_id
  for update;

  if found then
    if v_purge.asset_id <> p_asset_id then
      raise exception 'operation id was reused with different request parameters' using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', v_purge.state,
      'asset_id', v_purge.asset_id,
      'logical_path', v_purge.logical_path,
      'original_name', v_purge.original_name,
      'private_object_path', v_purge.private_object_path,
      'trash_object_path', v_purge.trash_object_path,
      'public_object_path', v_purge.public_object_path,
      'mime', v_purge.mime,
      'bytes', v_purge.bytes,
      'width', v_purge.width,
      'height', v_purge.height,
      'pixel_count', v_purge.pixel_count,
      'sha256', v_purge.sha256,
      'private_cleanup_state', v_purge.private_cleanup_state,
      'trash_cleanup_state', v_purge.trash_cleanup_state,
      'public_cleanup_state', v_purge.public_cleanup_state,
      'private_cleanup_error', v_purge.private_cleanup_error,
      'trash_cleanup_error', v_purge.trash_cleanup_error,
      'public_cleanup_error', v_purge.public_cleanup_error,
      'operation_id', v_purge.operation_id,
      'idempotent', true
    );
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    -- If the same operation was already fully purged, its durable record answers
    -- above. A missing asset with no purge record is a normal not-found conflict.
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if v_asset.status = 'purging' then
    select *
    into v_purge
    from public.media_purge as p
    where p.asset_id = p_asset_id
    for update;
    if not found then
      raise exception 'media purge state is missing' using errcode = 'PT409';
    end if;
    if v_purge.operation_id <> p_operation_id then
      raise exception 'media purge is already in progress' using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_build_object(
      'state', v_purge.state,
      'asset_id', v_purge.asset_id,
      'logical_path', v_purge.logical_path,
      'original_name', v_purge.original_name,
      'private_object_path', v_purge.private_object_path,
      'trash_object_path', v_purge.trash_object_path,
      'public_object_path', v_purge.public_object_path,
      'mime', v_purge.mime,
      'bytes', v_purge.bytes,
      'width', v_purge.width,
      'height', v_purge.height,
      'pixel_count', v_purge.pixel_count,
      'sha256', v_purge.sha256,
      'private_cleanup_state', v_purge.private_cleanup_state,
      'trash_cleanup_state', v_purge.trash_cleanup_state,
      'public_cleanup_state', v_purge.public_cleanup_state,
      'private_cleanup_error', v_purge.private_cleanup_error,
      'trash_cleanup_error', v_purge.trash_cleanup_error,
      'public_cleanup_error', v_purge.public_cleanup_error,
      'operation_id', v_purge.operation_id,
      'idempotent', true
    );
  end if;

  if v_asset.status <> 'trashed' then
    raise exception 'media asset must be in trash before permanent delete' using errcode = 'PT409';
  end if;
  if not found or v_trash.state <> 'stored' then
    raise exception 'trash copy is not stored' using errcode = 'PT409';
  end if;

  -- Recompute usage after the content lock. Any save/publish/restore that
  -- committed before this lock is visible; writers after it block on the lock.
  v_usage := public.media_purge_usage(p_asset_id);
  if v_usage is null then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if not (v_usage ->> 'deletable')::boolean then
    return pg_catalog.jsonb_build_object(
      'state', 'blocked',
      'asset_id', v_asset.id,
      'logical_path', v_asset.logical_path,
      'original_name', v_asset.original_name,
      'reasons', v_usage -> 'reasons',
      'references', v_usage -> 'references'
    );
  end if;

  -- Defensive shared-file guard: paths are asset-scoped by schema, but reject
  -- any unexpected overlap with another asset/trash/public row.
  if exists (
    select 1 from public.media_assets a
    where a.id <> v_asset.id and a.storage_path = v_asset.storage_path
  ) or exists (
    select 1 from public.media_trash t
    where t.asset_id <> v_asset.id and t.object_path = v_trash.object_path
  ) then
    raise exception 'storage path is shared with another asset' using errcode = 'PT409';
  end if;

  select *
  into v_public
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if found then
    v_public_path := v_public.object_path;
    if exists (
      select 1 from public.media_public_assets p2
      where p2.asset_id <> v_asset.id and p2.object_path = v_public.object_path
    ) then
      raise exception 'public storage path is shared with another asset' using errcode = 'PT409';
    end if;
    v_public_cleanup_state := 'pending';
  end if;

  insert into public.media_purge (
    asset_id, logical_path, original_name,
    private_bucket, private_object_path,
    trash_bucket, trash_object_path,
    public_bucket, public_object_path,
    mime, bytes, width, height, pixel_count, sha256,
    operation_id, state,
    private_cleanup_state, trash_cleanup_state, public_cleanup_state,
    private_cleanup_error, trash_cleanup_error, public_cleanup_error,
    started_at, completed_at, updated_at
  )
  values (
    v_asset.id, v_asset.logical_path, coalesce(v_asset.original_name, ''),
    'ccafe-media', v_asset.storage_path,
    'ccafe-trash', v_trash.object_path,
    'ccafe-public', v_public_path,
    coalesce(v_asset.mime, v_trash.mime),
    coalesce(v_asset.bytes, v_trash.bytes),
    coalesce(v_asset.width, v_trash.width),
    coalesce(v_asset.height, v_trash.height),
    coalesce(v_asset.pixel_count, v_trash.pixel_count),
    coalesce(v_asset.sha256, v_trash.sha256),
    p_operation_id, 'purging',
    'pending', 'pending', v_public_cleanup_state,
    null, null, null,
    pg_catalog.now(), null, pg_catalog.now()
  )
  returning * into v_purge;

  -- Mark the asset purging before any out-of-transaction storage delete. While
  -- purging, validate_content/references cannot target it (not approved), and
  -- restore/publish paths reject non-approved states.
  update public.media_assets
  set status = 'purging', failure_reason = null
  where id = p_asset_id;

  insert into public.content_operations (operation_id, actor_id, kind, request, result)
  values (
    p_operation_id,
    v_actor,
    'media_purge',
    pg_catalog.jsonb_build_object(
      'asset_id', p_asset_id,
      'confirmation', 'حذف الصورة نهائيًا'
    ),
    pg_catalog.jsonb_build_object(
      'state', 'purging',
      'asset_id', v_asset.id,
      'operation_id', p_operation_id,
      'logical_path', v_asset.logical_path
    )
  )
  on conflict (operation_id) do nothing;

  return pg_catalog.jsonb_build_object(
    'state', v_purge.state,
    'asset_id', v_purge.asset_id,
    'logical_path', v_purge.logical_path,
    'original_name', v_purge.original_name,
    'private_object_path', v_purge.private_object_path,
    'trash_object_path', v_purge.trash_object_path,
    'public_object_path', v_purge.public_object_path,
    'mime', v_purge.mime,
    'bytes', v_purge.bytes,
    'width', v_purge.width,
    'height', v_purge.height,
    'pixel_count', v_purge.pixel_count,
    'sha256', v_purge.sha256,
    'private_cleanup_state', v_purge.private_cleanup_state,
    'trash_cleanup_state', v_purge.trash_cleanup_state,
    'public_cleanup_state', v_purge.public_cleanup_state,
    'private_cleanup_error', v_purge.private_cleanup_error,
    'trash_cleanup_error', v_purge.trash_cleanup_error,
    'public_cleanup_error', v_purge.public_cleanup_error,
    'operation_id', v_purge.operation_id,
    'idempotent', false
  );
end;
$fn$;
create or replace function public.admin_media_purge_status(
  p_asset_id uuid,
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_purge public.media_purge%rowtype;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  select *
  into v_purge
  from public.media_purge as p
  where p.asset_id = p_asset_id
  order by p.updated_at desc
  limit 1
  for update;

  if not found then
    return pg_catalog.jsonb_build_object('state', 'not_found', 'asset_id', p_asset_id);
  end if;

  return pg_catalog.jsonb_build_object(
    'state', v_purge.state,
    'asset_id', v_purge.asset_id,
    'logical_path', v_purge.logical_path,
    'original_name', v_purge.original_name,
    'private_object_path', v_purge.private_object_path,
    'trash_object_path', v_purge.trash_object_path,
    'public_object_path', v_purge.public_object_path,
    'mime', v_purge.mime,
    'bytes', v_purge.bytes,
    'width', v_purge.width,
    'height', v_purge.height,
    'pixel_count', v_purge.pixel_count,
    'sha256', v_purge.sha256,
    'private_cleanup_state', v_purge.private_cleanup_state,
    'trash_cleanup_state', v_purge.trash_cleanup_state,
    'public_cleanup_state', v_purge.public_cleanup_state,
    'private_cleanup_error', v_purge.private_cleanup_error,
    'trash_cleanup_error', v_purge.trash_cleanup_error,
    'public_cleanup_error', v_purge.public_cleanup_error,
    'operation_id', v_purge.operation_id,
    'idempotent', true
  );
end;
$fn$;

create or replace function public.admin_media_purge_cleanup(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_private_done boolean,
  p_private_error text,
  p_trash_done boolean,
  p_trash_error text,
  p_public_done boolean default null,
  p_public_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_purge public.media_purge%rowtype;
  v_private_error text := pg_catalog.left(pg_catalog.btrim(coalesce(p_private_error, '')), 200);
  v_trash_error text := pg_catalog.left(pg_catalog.btrim(coalesce(p_trash_error, '')), 200);
  v_public_error text := pg_catalog.left(pg_catalog.btrim(coalesce(p_public_error, '')), 200);
  v_all_done boolean;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  select *
  into v_purge
  from public.media_purge as p
  where p.asset_id = p_asset_id
  for update;

  if not found then
    -- A durable "purged" record may be the only remaining trace after final
    -- cleanup. A replay by operation_id should still succeed idempotently.
    select *
    into v_purge
    from public.media_purge as p
    where p.operation_id = p_operation_id
    for update;
    if found and v_purge.state = 'purged' and v_purge.asset_id = p_asset_id then
      return pg_catalog.jsonb_build_object(
        'state', 'purged',
        'asset_id', v_purge.asset_id,
        'logical_path', v_purge.logical_path,
        'private_cleanup_state', v_purge.private_cleanup_state,
        'trash_cleanup_state', v_purge.trash_cleanup_state,
        'public_cleanup_state', v_purge.public_cleanup_state,
        'private_cleanup_error', v_purge.private_cleanup_error,
        'trash_cleanup_error', v_purge.trash_cleanup_error,
        'public_cleanup_error', v_purge.public_cleanup_error,
        'operation_id', v_purge.operation_id,
        'idempotent', true
      );
    end if;
    raise exception 'media purge record not found' using errcode = 'P0002';
  end if;

  if v_purge.operation_id <> p_operation_id then
    raise exception 'media purge operation does not match' using errcode = 'PT409';
  end if;

  if v_purge.state = 'purged' then
    return pg_catalog.jsonb_build_object(
      'state', 'purged',
      'asset_id', v_purge.asset_id,
      'logical_path', v_purge.logical_path,
      'private_cleanup_state', v_purge.private_cleanup_state,
      'trash_cleanup_state', v_purge.trash_cleanup_state,
      'public_cleanup_state', v_purge.public_cleanup_state,
      'private_cleanup_error', v_purge.private_cleanup_error,
      'trash_cleanup_error', v_purge.trash_cleanup_error,
      'public_cleanup_error', v_purge.public_cleanup_error,
      'operation_id', v_purge.operation_id,
      'idempotent', true
    );
  end if;

  if p_private_done is true then
    v_purge.private_cleanup_state := 'done';
    v_purge.private_cleanup_error := null;
  elsif v_purge.private_cleanup_state <> 'done' then
    v_purge.private_cleanup_state := 'pending';
    v_purge.private_cleanup_error := nullif(v_private_error, '');
  end if;

  if p_trash_done is true then
    v_purge.trash_cleanup_state := 'done';
    v_purge.trash_cleanup_error := null;
  elsif v_purge.trash_cleanup_state <> 'done' then
    v_purge.trash_cleanup_state := 'pending';
    v_purge.trash_cleanup_error := nullif(v_trash_error, '');
  end if;

  if v_purge.public_object_path is not null then
    if p_public_done is true then
      v_purge.public_cleanup_state := 'done';
      v_purge.public_cleanup_error := null;
    elsif v_purge.public_cleanup_state <> 'done' then
      v_purge.public_cleanup_state := 'pending';
      v_purge.public_cleanup_error := nullif(v_public_error, '');
    end if;
  else
    v_purge.public_cleanup_state := 'none';
    v_purge.public_cleanup_error := null;
  end if;

  v_all_done := v_purge.private_cleanup_state = 'done'
    and v_purge.trash_cleanup_state = 'done'
    and v_purge.public_cleanup_state in ('none', 'done');

  if v_all_done then
    -- Remove DB rows only after all storage targets have been confirmed handled.
    delete from public.media_public_assets where asset_id = p_asset_id;
    delete from public.media_trash where asset_id = p_asset_id;
    delete from public.media_assets where id = p_asset_id;

    update public.media_purge
    set state = 'purged',
        private_cleanup_state = v_purge.private_cleanup_state,
        trash_cleanup_state = v_purge.trash_cleanup_state,
        public_cleanup_state = v_purge.public_cleanup_state,
        private_cleanup_error = v_purge.private_cleanup_error,
        trash_cleanup_error = v_purge.trash_cleanup_error,
        public_cleanup_error = v_purge.public_cleanup_error,
        completed_at = coalesce(completed_at, pg_catalog.now()),
        updated_at = pg_catalog.now()
    where asset_id = p_asset_id
    returning * into v_purge;

    update public.content_operations
    set result = pg_catalog.jsonb_build_object(
      'state', 'purged',
      'asset_id', v_purge.asset_id,
      'operation_id', v_purge.operation_id,
      'logical_path', v_purge.logical_path,
      'deleted_at', v_purge.completed_at
    )
    where operation_id = p_operation_id
      and kind = 'media_purge';
  else
    update public.media_purge
    set private_cleanup_state = v_purge.private_cleanup_state,
        trash_cleanup_state = v_purge.trash_cleanup_state,
        public_cleanup_state = v_purge.public_cleanup_state,
        private_cleanup_error = v_purge.private_cleanup_error,
        trash_cleanup_error = v_purge.trash_cleanup_error,
        public_cleanup_error = v_purge.public_cleanup_error,
        updated_at = pg_catalog.now()
    where asset_id = p_asset_id
    returning * into v_purge;
  end if;

  return pg_catalog.jsonb_build_object(
    'state', v_purge.state,
    'asset_id', v_purge.asset_id,
    'logical_path', v_purge.logical_path,
    'private_cleanup_state', v_purge.private_cleanup_state,
    'trash_cleanup_state', v_purge.trash_cleanup_state,
    'public_cleanup_state', v_purge.public_cleanup_state,
    'private_cleanup_error', v_purge.private_cleanup_error,
    'trash_cleanup_error', v_purge.trash_cleanup_error,
    'public_cleanup_error', v_purge.public_cleanup_error,
    'operation_id', v_purge.operation_id,
    'idempotent', false
  );
end;
$fn$;
-- ---------------------------------------------------------------------------
-- 5. Guards: purging must never become a content reference
-- ---------------------------------------------------------------------------

create or replace function public.assert_content_value(
  p_value jsonb,
  p_path text,
  p_depth integer
)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_type text := pg_catalog.jsonb_typeof(p_value);
  v_key text;
  v_child jsonb;
  v_text text;
  v_index integer := 0;
begin
  if p_depth > 8 then
    raise exception 'content is nested too deeply' using errcode = '22023';
  end if;

  -- A purge stays in the purging state across the whole out-of-transaction
  -- Storage deletion phase. Reject any content write that mentions a purging
  -- asset anywhere, including a bare id or a public link, not just a canonical
  -- media/<uuid> image field.
  if p_path = '$' and p_depth = 0 then
    if exists (
      select 1
      from public.media_purge as p
      where p.state = 'purging'
        and public.media_purge_content_has_ref(p_value, p.asset_id)
    ) then
      raise exception 'content references an image being permanently deleted' using errcode = 'PT409';
    end if;
  end if;

  if v_type = 'object' then
    if (select count(*) from pg_catalog.jsonb_object_keys(p_value)) > 50 then
      raise exception 'content object has too many keys' using errcode = '22023';
    end if;

    for v_key, v_child in
      select key, value from pg_catalog.jsonb_each(p_value)
    loop
      if length(v_key) > 80 then
        raise exception 'content key is invalid' using errcode = '22023';
      end if;
      perform public.assert_content_value(v_child, p_path || '.' || v_key, p_depth + 1);
    end loop;
  elsif v_type = 'array' then
    if pg_catalog.jsonb_array_length(p_value) > 200 then
      raise exception 'content array is too long' using errcode = '22023';
    end if;

    for v_child in
      select value from pg_catalog.jsonb_array_elements(p_value)
    loop
      v_index := v_index + 1;
      perform public.assert_content_value(
        v_child,
        p_path || '[' || v_index || ']',
        p_depth + 1
      );
    end loop;
  elsif v_type = 'string' then
    v_text := p_value #>> '{}';

    if length(v_text) > 4000 then
      raise exception 'content string is too long' using errcode = '22023';
    end if;

    if p_path ~ '\.href$' then
      if v_text <> '' and not (
        v_text ~ '^#[A-Za-z0-9_-]+$'
        or v_text ~* '^(https?://|tel:|mailto:|sms:)'
        or (v_text ~ '^/' and v_text !~ '^//')
        or v_text in ('@phone', '@maps', '@instagram')
      ) then
        raise exception 'unsafe link in content' using errcode = '22023';
      end if;
    elsif p_path ~ '\.phoneIntl$' then
      if v_text <> '' and v_text !~ '^\+?[0-9 ()-]+$' then
        raise exception 'phoneIntl must contain only a phone number' using errcode = '22023';
      end if;
    elsif p_path ~ '\.(mapsUrl|instagramUrl|siteUrl)$' then
      if v_text <> '' and v_text !~* '^https?://' then
        raise exception 'URL fields must use http or https' using errcode = '22023';
      end if;
    elsif p_path ~ '\.(image|mark|logo|favicon|touchIcon|ogImage)$' then
      if v_text <> '' then
        if v_text ~ '^assets/[A-Za-z0-9_./-]+$' and v_text not like '%..%' then
          null;
        elsif v_text ~ '^media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          and exists (
            select 1
            from public.media_assets as a
            where a.logical_path = v_text
              and a.status = 'approved'
          )
          and not exists (
            select 1
            from public.media_purge as p
            where p.logical_path = v_text
              and p.state = 'purging'
          )
        then
          null;
        else
          raise exception 'image paths must reference an approved media asset' using errcode = '22023';
        end if;
      end if;
    end if;
  end if;
end;
$fn$;

-- Publish/restore must also refuse a purging asset even if a caller supplies a
-- non-canonical id or public-link reference. validate_content() already guards
-- normal writes; this is the publish-specific second line of defence.
create or replace function public.assert_publishable_media(p_content jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_ref text;
begin
  if exists (
    select 1
    from public.media_purge as p
    where p.state = 'purging'
      and public.media_purge_content_has_ref(p_content, p.asset_id)
  ) then
    raise exception 'content references an image being permanently deleted' using errcode = 'PT409';
  end if;

  foreach v_ref in array public.media_content_refs(p_content) loop
    if not exists (
      select 1
      from public.media_assets as a
      join public.media_public_assets as p on p.asset_id = a.id
      where a.logical_path = v_ref
        and a.status = 'approved'
        and p.state = 'ready'
        and not exists (
          select 1 from public.media_purge as purge
          where purge.asset_id = a.id and purge.state = 'purging'
        )
    ) then
      raise exception 'media asset is not ready for publication' using errcode = 'CC001';
    end if;
  end loop;
end;
$fn$;

revoke all on function public.assert_publishable_media(jsonb) from public, anon, authenticated;

-- Publish/restore prepare/confirm/fail guard: purging is not approved.
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
  if v_asset.status <> 'approved' then
    raise exception 'media asset is not approved' using errcode = 'PT409';
  end if;
  if exists (select 1 from public.media_purge p where p.asset_id = p_asset_id and p.state = 'purging') then
    raise exception 'media asset is being permanently deleted' using errcode = 'PT409';
  end if;

  insert into public.media_public_assets (
    asset_id, bucket, object_path, state,
    mime, bytes, width, height, pixel_count, sha256,
    prepared_at
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
    v_asset.sha256,
    pg_catalog.now()
  )
  on conflict (asset_id) do nothing;

  select *
  into v_pub
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'public asset row is missing' using errcode = 'P0002';
  end if;

  if v_pub.state = 'failed' then
    v_path := 'published/' || v_asset.id::text || '/' || pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');
    update public.media_public_assets as p
    set bucket = 'ccafe-public',
        object_path = v_path,
        state = 'staging',
        mime = v_asset.mime,
        bytes = v_asset.bytes,
        width = v_asset.width,
        height = v_asset.height,
        pixel_count = v_asset.pixel_count,
        sha256 = v_asset.sha256,
        linked_version = null,
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
        sha256 = v_asset.sha256
    where p.asset_id = p_asset_id
    returning * into v_pub;
  end if;

  return pg_catalog.jsonb_build_object(
    'state', v_pub.state,
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'bucket', v_pub.bucket,
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
  if exists (select 1 from public.media_purge p where p.asset_id = p_asset_id and p.state = 'purging') then
    raise exception 'media asset is being permanently deleted' using errcode = 'PT409';
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

-- ---------------------------------------------------------------------------
-- 6. RLS/privileges
-- ---------------------------------------------------------------------------

alter table public.media_purge enable row level security;
revoke all on table public.media_purge from anon, authenticated;

revoke all on function public.admin_delete_content_history_entry(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_delete_content_history_entry(bigint, uuid, text) to authenticated;

revoke all on function public.admin_media_purge_begin(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_purge_begin(uuid, text, uuid, text) to authenticated;

revoke all on function public.admin_media_purge_status(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_purge_status(uuid, text) to authenticated;

revoke all on function public.admin_media_purge_cleanup(uuid, text, uuid, boolean, text, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_media_purge_cleanup(uuid, text, uuid, boolean, text, boolean, text, boolean, text) to authenticated;

revoke all on function public.assert_content_value(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.admin_media_prepare_public(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_prepare_public(uuid, text) to authenticated;
revoke all on function public.admin_media_confirm_public(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_media_confirm_public(uuid, text, text) to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 7. Block restore/delete flows while purging; expose purging in trash list
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
  v_purge public.media_purge%rowtype;
  v_public_path text;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  -- Restore changes an asset back into a valid content reference, so it must
  -- wait for the same lock as save/publish/delete/purge.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  select * into v_purge from public.media_purge where asset_id = p_asset_id for update;
  if found and v_purge.state = 'purging' then
    raise exception 'media asset is being permanently deleted' using errcode = 'PT409';
  end if;

  select *
  into v_asset
  from public.media_assets as a
  where a.id = p_asset_id
  for update;

  if not found then
    raise exception 'media asset not found' using errcode = 'P0002';
  end if;
  if v_asset.status = 'purging' then
    raise exception 'media asset is being permanently deleted' using errcode = 'PT409';
  end if;

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id
  for update;

  if not found then
    raise exception 'trash row not found' using errcode = 'P0002';
  end if;

  if v_trash.public_cleanup_state = 'pending' then
    v_public_path := v_trash.public_object_path;
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
        'public_object_path', v_public_path,
        'public_cleanup_pending', v_public_path is not null,
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
    'public_object_path', v_public_path,
    'public_cleanup_pending', v_public_path is not null,
    'idempotent', false
  );
end;
$fn$;

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
        'state', case when a.status = 'restoring' then 'restoring' when a.status = 'purging' then 'purging' else 'trashed' end,
        'cleanup_state', t.cleanup_state,
        'cleanup_error', case when t.cleanup_error is null then null else pg_catalog.left(t.cleanup_error, 200) end,
        'public_cleanup_state', t.public_cleanup_state,
        'public_cleanup_error', case when t.public_cleanup_error is null then null else pg_catalog.left(t.public_cleanup_error, 200) end,
        'purge_operation_id', (select p.operation_id from public.media_purge p where p.asset_id = t.asset_id and p.state = 'purging' limit 1)
      )
      order by t.stored_at desc, t.asset_id::text desc
    ),
    '[]'::jsonb
  )
  into v_items
  from public.media_trash as t
  join public.media_assets as a on a.id = t.asset_id
  where a.status in ('trashed', 'restoring', 'purging');

  return pg_catalog.jsonb_build_object('items', v_items);
end;
$fn$;

revoke all on function public.admin_media_restore_begin(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_restore_begin(uuid, text, uuid) to authenticated;
revoke all on function public.admin_media_trash_list() from public, anon, authenticated;
grant execute on function public.admin_media_trash_list() to authenticated;