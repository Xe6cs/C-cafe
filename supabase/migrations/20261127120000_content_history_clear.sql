-- C Cafe content history clear (local only; apply deliberately before deploy).
--
-- Adds an admin-only, idempotent, atomic operation that deletes all content
-- history rows that exist at execution time. It never touches site_content,
-- draft, media, users, site_status/site_status operations, or analytics.
--
-- Safety properties:
--   * assert_admin() is required and the function is SECURITY DEFINER with
--     search_path = '';
--   * same advisory lock namespace as publish/restore/delete-draft so history
--     clear cannot interleave with version-changing content operations;
--   * idempotent by operation_id through content_operations; a retry with the
--     same request returns the original result and does not delete rows created
--     after the original boundary;
--   * the delete boundary is the maximum content_history.version visible under
--     the content lock. Rows inserted later (version > boundary) are preserved.
--
-- This migration is intentionally local/unapplied until explicitly reviewed.

begin;

alter table public.content_operations
  drop constraint if exists content_operations_kind_check;

alter table public.content_operations
  add constraint content_operations_kind_check
  check (kind in ('publish', 'restore', 'clear_history'));

create or replace function public.admin_clear_content_history(
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
  v_boundary_version bigint;
  v_boundary_id bigint;
  v_deleted integer := 0;
  v_result jsonb;
begin
  v_actor := public.assert_admin();

  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;
  if coalesce(p_confirmation, '') <> 'حذف السجل نهائيًا' then
    raise exception 'confirmation is required' using errcode = '22023';
  end if;

  -- Same lock namespace/order used by save/delete/publish/restore. This blocks
  -- concurrent version-creating operations while the boundary is captured and
  -- history rows are deleted.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  v_request := pg_catalog.jsonb_build_object(
    'confirmation', 'حذف السجل نهائيًا'
  );

  v_existing := public.find_operation(p_operation_id, v_actor, 'clear_history', v_request);
  if v_existing is not null then
    return v_existing;
  end if;

  -- Lock the singleton published row as publish/restore do. No content fields
  -- are changed; this keeps the operation in the same serialization domain.
  perform 1
  from public.site_content as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;

  select h.version, h.id
  into v_boundary_version, v_boundary_id
  from public.content_history as h
  order by h.version desc, h.id desc
  limit 1;

  if v_boundary_version is null then
    v_deleted := 0;
  else
    delete from public.content_history as h
    where h.version <= v_boundary_version;
    get diagnostics v_deleted = row_count;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id,
    'deleted_count', v_deleted,
    'boundary_version', v_boundary_version,
    'boundary_id', v_boundary_id,
    'cleared_at', v_now
  );

  insert into public.content_operations (operation_id, actor_id, kind, request, result)
  values (p_operation_id, v_actor, 'clear_history', v_request, v_result);

  return v_result;
end;
$fn$;

revoke all on function public.admin_clear_content_history(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_clear_content_history(uuid, text) to authenticated;

commit;
