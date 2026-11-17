-- Close the time-of-check/time-of-use window in media finalization.
--
-- Before this migration, admin_media_finalize only checked that an object
-- existed at the pending path. The uploader could delete the object (or delete
-- and re-upload different bytes) between the server's download/decode and the
-- finalize RPC, so the stored digest could describe bytes other than the ones
-- that would later be shown.
--
-- The fix is a server-issued claim:
--   * admin_media_begin_finalize locks the row and sets verification_started_at.
--   * While the claim is set, the Storage INSERT/DELETE policies deny any write
--     to that path, so the bytes cannot be replaced or removed.
--   * admin_media_finalize now refuses to approve an unclaimed row.
--   * admin_media_fail clears the claim so a rejected/abandoned upload can still
--     be cleaned up.
--
-- Only the Netlify Function calls the begin RPC (with the admin JWT) and the
-- finalize RPC (with the admin JWT plus the server-side finalize token). The
-- claim itself does not approve anything; it only freezes the bytes while the
-- server verifies them.

begin;

alter table public.media_assets
  add column if not exists verification_started_at timestamptz;

comment on column public.media_assets.verification_started_at is
  'Set by admin_media_begin_finalize before the server reads the object. While set, Storage INSERT/DELETE policies deny changing the bytes until finalize or fail clears the row state.';

-- Upload: only the exact pending path generated for this admin, and only while
-- no verification claim is active. No overwrite is possible because object
-- INSERT fails when the name already exists; there is deliberately no UPDATE
-- policy.
drop policy if exists ccafe_media_admin_upload on storage.objects;
create policy ccafe_media_admin_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ccafe-media'
    and public.is_admin()
    and exists (
      select 1
      from public.media_assets as a
      where a.storage_path = storage.objects.name
        and a.status = 'pending'
        and a.verification_started_at is null
        and a.created_by = auth.uid()
    )
  );

-- Delete: cleanup of a pending/failed upload by its creator only, and never
-- while the server is verifying the bytes. Approved assets cannot be deleted
-- through the Storage API by admins.
drop policy if exists ccafe_media_admin_cleanup on storage.objects;
create policy ccafe_media_admin_cleanup on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'ccafe-media'
    and public.is_admin()
    and exists (
      select 1
      from public.media_assets as a
      where a.storage_path = storage.objects.name
        and a.status in ('pending', 'failed')
        and a.verification_started_at is null
        and a.created_by = auth.uid()
    )
  );

create or replace function public.admin_media_begin_finalize(
  p_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_asset public.media_assets%rowtype;
  v_already boolean;
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
    raise exception 'media asset is already approved' using errcode = 'PT409';
  end if;
  if v_asset.status <> 'pending' then
    raise exception 'media asset is not pending' using errcode = 'PT409';
  end if;

  v_already := v_asset.verification_started_at is not null;
  if not v_already then
    update public.media_assets as a
    set verification_started_at = pg_catalog.now()
    where a.id = p_asset_id
    returning * into v_asset;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_asset.id,
    'status', 'pending',
    'claimed', true,
    'already_claimed', v_already,
    'verification_started_at', v_asset.verification_started_at
  );
end;
$fn$;

create or replace function public.admin_media_finalize(
  p_asset_id uuid,
  p_token_sha256 text,
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
  v_expected text;
  v_pixels bigint;
begin
  v_actor := public.assert_admin();

  select s.value_sha256
  into v_expected
  from public.media_secrets as s
  where s.name = 'finalize';

  if v_expected is null
    or p_token_sha256 is null
    or p_token_sha256 !~ '^[0-9a-f]{64}$'
    or p_token_sha256 <> v_expected
  then
    raise exception 'finalize token is invalid' using errcode = '42501';
  end if;

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

revoke all on function public.admin_media_begin_finalize(uuid) from public, anon, authenticated;
grant execute on function public.admin_media_begin_finalize(uuid) to authenticated;

commit;
