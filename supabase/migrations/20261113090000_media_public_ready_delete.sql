-- Treat a ready public copy as cleanup state, not as a content reference.
--
-- A public copy stays "ready" after the version that referenced it has been
-- replaced, but history already preserves every content revision, so history is
-- the real blocker for those images. An unlinked ready copy must not keep an
-- otherwise unused upload alive forever.
--
-- This migration:
--   * removes public_ready from the usage blockers;
--   * records the public object name on media_trash when a delete starts;
--   * flips the public row to failed only at the delete commit point;
--   * tracks public-object cleanup separately from the private original;
--   * makes restore wait for the same content lock as delete/save/publish and
--     remove any pending public object before the asset becomes approved again.
--
-- Removing the public object never guarantees that browsers or a CDN forget a
-- previously cached copy. Only the server-side object is removed.

begin;

-- ---------------------------------------------------------------------------
-- 1. Trash bookkeeping for the public copy
-- ---------------------------------------------------------------------------

alter table public.media_trash
  add column if not exists public_object_path text,
  add column if not exists public_cleanup_state text not null default 'none',
  add column if not exists public_cleanup_error text;

alter table public.media_trash
  drop constraint if exists media_trash_public_object_path_check;
alter table public.media_trash
  add constraint media_trash_public_object_path_check check (
    public_object_path is null
    or public_object_path ~ '^published/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
  );

alter table public.media_trash
  drop constraint if exists media_trash_public_cleanup_state_check;
alter table public.media_trash
  add constraint media_trash_public_cleanup_state_check check (
    public_cleanup_state in ('none', 'pending', 'done')
  );

-- ---------------------------------------------------------------------------
-- 2. Usage: only real content references block deletion
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

  -- public_ready is deliberately not a reason. A ready copy without any
  -- published/draft/history reference is an orphaned capability, not usage.
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

-- ---------------------------------------------------------------------------
-- 3. Trash list includes public cleanup state
-- ---------------------------------------------------------------------------

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
        'public_cleanup_state', t.public_cleanup_state,
        'public_cleanup_error', case
          when t.public_cleanup_error is null then null
          else pg_catalog.left(t.public_cleanup_error, 200)
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

-- ---------------------------------------------------------------------------
-- 4. Delete begin: record the public path, keep the ready copy untouched
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
  v_public public.media_public_assets%rowtype;
  v_path text;
  v_public_path text;
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
        'public_cleanup_state', v_trash.public_cleanup_state,
        'public_cleanup_error', v_trash.public_cleanup_error,
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
        'public_object_path', v_trash.public_object_path,
        'public_cleanup_state', v_trash.public_cleanup_state,
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

  select *
  into v_public
  from public.media_public_assets as p
  where p.asset_id = p_asset_id
  for update;

  if found then
    v_public_path := v_public.object_path;
  end if;

  -- An unlinked staging public copy is not served to anyone. Invalidate it
  -- immediately; a ready copy (linked or not) is flipped to failed only at the
  -- commit point, so a failed transfer leaves the approved asset untouched.
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
    delete_operation_id, cleanup_state, prepared_at,
    public_object_path, public_cleanup_state, public_cleanup_error
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
    pg_catalog.now(),
    v_public_path,
    case when v_public_path is null then 'none' else 'pending' end,
    null
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
      public_object_path = excluded.public_object_path,
      public_cleanup_state = excluded.public_cleanup_state,
      public_cleanup_error = null,
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
    'public_object_path', v_trash.public_object_path,
    'public_cleanup_state', v_trash.public_cleanup_state,
    'idempotent', false
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Delete finish: atomic asset + public-copy state change
-- ---------------------------------------------------------------------------

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
      'public_object_path', v_trash.public_object_path,
      'public_cleanup_state', v_trash.public_cleanup_state,
      'public_cleanup_error', v_trash.public_cleanup_error,
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

  -- The public capability is invalidated in the same transaction that commits
  -- the trash copy. If this transaction fails, the approved asset and its ready
  -- copy remain untouched.
  update public.media_public_assets as p
  set state = 'failed',
      failure_reason = 'asset_deleting',
      confirmed_at = null,
      linked_version = null
  where p.asset_id = p_asset_id
    and p.state in ('staging', 'ready');

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
    'public_object_path', v_trash.public_object_path,
    'public_cleanup_state', v_trash.public_cleanup_state,
    'public_cleanup_error', v_trash.public_cleanup_error,
    'sha256', v_trash.sha256,
    'idempotent', false
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Delete abort keeps the public copy because the commit never happened
-- ---------------------------------------------------------------------------

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
      public_object_path = null,
      public_cleanup_state = 'none',
      public_cleanup_error = null,
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

-- ---------------------------------------------------------------------------
-- 7. Cleanup records both private and public object results
-- ---------------------------------------------------------------------------

drop function if exists public.admin_media_delete_cleanup(uuid, text, uuid, boolean, text);

create or replace function public.admin_media_delete_cleanup(
  p_asset_id uuid,
  p_token text,
  p_operation_id uuid,
  p_done boolean,
  p_error text,
  p_public_done boolean default null,
  p_public_error text default null
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
  v_public_error text := pg_catalog.left(pg_catalog.btrim(coalesce(p_public_error, '')), 200);
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
      public_cleanup_state = case
        when t.public_object_path is null then 'none'
        when p_public_done is null then t.public_cleanup_state
        when p_public_done then 'done'
        else 'pending'
      end,
      public_cleanup_error = case
        when t.public_object_path is null then null
        when p_public_done is true then null
        when p_public_done is false then nullif(v_public_error, '')
        else t.public_cleanup_error
      end,
      updated_at = pg_catalog.now()
  where t.asset_id = p_asset_id
  returning * into v_trash;

  return pg_catalog.jsonb_build_object(
    'state', 'trashed',
    'asset_id', v_asset.id,
    'cleanup_state', v_trash.cleanup_state,
    'cleanup_error', v_trash.cleanup_error,
    'public_cleanup_state', v_trash.public_cleanup_state,
    'public_cleanup_error', v_trash.public_cleanup_error
  );
end;
$fn$;

-- Server-only read of the exact cleanup targets. The browser never calls this
-- route; the object names stay in the RPC response to the Netlify function.
create or replace function public.admin_media_cleanup_targets(
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
  v_trash public.media_trash%rowtype;
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

  select *
  into v_trash
  from public.media_trash as t
  where t.asset_id = p_asset_id;

  if not found or v_asset.status <> 'trashed' or v_trash.state <> 'stored' then
    raise exception 'trash cleanup does not match a trashed asset' using errcode = 'PT409';
  end if;

  return pg_catalog.jsonb_build_object(
    'asset_id', v_asset.id,
    'logical_path', v_asset.logical_path,
    'cleanup_state', v_trash.cleanup_state,
    'public_object_path', v_trash.public_object_path,
    'public_cleanup_state', v_trash.public_cleanup_state
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 8. Restore serializes with content writers and clears the public copy
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
  v_public_path text;
begin
  perform public.assert_admin();
  perform public.assert_media_finalize_token(p_token);

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  -- Restore changes an asset back into a valid content reference, so it must
  -- wait for the same lock as save/publish/delete.
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
      public_object_path = null,
      public_cleanup_state = 'done',
      public_cleanup_error = null,
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

-- ---------------------------------------------------------------------------
-- 9. Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.media_asset_usage(uuid) from public, anon, authenticated;
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

revoke all on function public.admin_media_delete_cleanup(uuid, text, uuid, boolean, text, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_media_delete_cleanup(uuid, text, uuid, boolean, text, boolean, text) to authenticated;

revoke all on function public.admin_media_cleanup_targets(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_media_cleanup_targets(uuid, text) to authenticated;

revoke all on function public.admin_media_restore_begin(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_restore_begin(uuid, text, uuid) to authenticated;

revoke all on function public.admin_media_restore_finish(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.admin_media_restore_finish(uuid, text, uuid) to authenticated;

commit;
