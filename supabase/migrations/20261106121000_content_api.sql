-- C Cafe content RPCs, RLS policies, public view, and grants.
--
-- All mutations serialize on one transaction-level advisory lock and then lock
-- rows in this order:
--   site_content -> draft -> history/operations
-- This keeps save/publish/restore/delete consistent and prevents a publish or
-- restore from deleting a newer draft.
--
-- Every SECURITY DEFINER function sets search_path = '' and schema-qualifies
-- every object. The functions are owned by the migration role (postgres in
-- Supabase), which bypasses RLS for the allow-list check. EXECUTE is revoked
-- from PUBLIC/anon and granted only to authenticated for the admin RPCs.
--
-- Stale version/revision conflicts use SQLSTATE PT409 (PostgREST maps it to
-- HTTP 409). Do not use 40001 here: PostgREST treats serialization failures as
-- retryable and the request hangs until the upstream timeout.

begin;

-- ---------------------------------------------------------------------------
-- Admin helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
    from public.admin_users as a
    where a.user_id = auth.uid()
      and a.role = 'admin'
  );
$fn$;

create or replace function public.assert_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
begin
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return v_actor;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Small shared helpers for idempotent publish/restore
-- ---------------------------------------------------------------------------

create or replace function public.find_operation(
  p_operation_id uuid,
  p_actor uuid,
  p_kind text,
  p_request jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_operation public.content_operations%rowtype;
begin
  select *
  into v_operation
  from public.content_operations as o
  where o.operation_id = p_operation_id;

  if not found then
    return null;
  end if;

  if v_operation.actor_id <> p_actor or v_operation.kind <> p_kind then
    raise exception 'operation id belongs to another operation' using errcode = 'PT409';
  end if;

  if v_operation.request is distinct from p_request then
    raise exception 'operation id was reused with different request parameters' using errcode = 'PT409';
  end if;

  return v_operation.result;
end;
$fn$;

create or replace function public.trim_content_history()
returns void
language sql
security definer
set search_path = ''
as $fn$
  delete from public.content_history
  where id in (
    select h.id
    from public.content_history as h
    order by h.version desc, h.id desc
    offset 50
  );
$fn$;

-- ---------------------------------------------------------------------------
-- Draft save/delete
-- ---------------------------------------------------------------------------

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
  perform public.validate_content(p_content);

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

create or replace function public.admin_delete_draft(
  p_expected_version bigint,
  p_expected_revision uuid
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

  select *
  into v_draft
  from public.draft as d
  where d.id = 1
  for update;

  if not found then
    if p_expected_revision is null then
      return pg_catalog.jsonb_build_object('deleted', false);
    end if;
    raise exception 'stale draft revision' using errcode = 'PT409';
  end if;

  if p_expected_revision is null or v_draft.revision_id <> p_expected_revision then
    raise exception 'stale draft revision' using errcode = 'PT409';
  end if;

  delete from public.draft as d
  where d.id = 1
    and d.revision_id = p_expected_revision;

  return pg_catalog.jsonb_build_object(
    'deleted', true,
    'revision_id', p_expected_revision
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Publish (content or a specific draft revision)
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

  -- A retry after a lost response must return the original result even if the
  -- published version has since moved forward. It must not create a new version,
  -- and reusing the same operation ID for different content/parameters is rejected.
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

  -- Delete only the exact draft that was published. A newer draft can never be
  -- removed here, even if a caller sends a stale expected revision.
  if p_expected_draft_revision is not null then
    delete from public.draft as d
    where d.id = 1
      and d.revision_id = p_expected_draft_revision;
  end if;

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

-- ---------------------------------------------------------------------------
-- Restore (always creates a new version; never reuses or moves a history row)
-- ---------------------------------------------------------------------------

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
  v_note := coalesce(nullif(p_note, ''), 'استعادة نسخة سابقة');

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
-- Purge and public-page verification (operational state, not live proof)
-- ---------------------------------------------------------------------------

create or replace function public.admin_begin_purge(
  p_expected_version bigint,
  p_operation_id uuid default null
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

  update public.site_content as s
  set purge_state = 'requested',
      purge_requested_at = v_now,
      purge_accepted_at = null,
      purge_error = null,
      purge_operation_id = p_operation_id
  where s.id = 1;

  return pg_catalog.jsonb_build_object(
    'saved_version', v_site.version,
    'purge_state', 'requested',
    'requested_at', v_now,
    'note', 'requested means only that a purge was requested, not that visitors see it'
  );
end;
$fn$;

create or replace function public.admin_record_purge(
  p_version bigint,
  p_state text,
  p_error text
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
begin
  v_actor := public.assert_admin();

  if p_state not in ('accepted', 'failed') then
    raise exception 'purge state must be accepted or failed' using errcode = '22023';
  end if;
  if length(coalesce(p_error, '')) > 500 then
    raise exception 'purge error is too long' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  select *
  into v_site
  from public.site_content as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;

  -- A late purge result must not overwrite the state of a newer version.
  if v_site.version <> p_version then
    return pg_catalog.jsonb_build_object(
      'applied', false,
      'reason', 'stale_version',
      'saved_version', v_site.version,
      'purge_state', v_site.purge_state
    );
  end if;

  update public.site_content as s
  set purge_state = p_state,
      purge_accepted_at = case when p_state = 'accepted' then v_now else null end,
      purge_error = case when p_state = 'failed' then nullif(p_error, '') else null end
  where s.id = 1;

  return pg_catalog.jsonb_build_object(
    'applied', true,
    'saved_version', p_version,
    'purge_state', p_state,
    'purge_accepted_at', case when p_state = 'accepted' then v_now else null end,
    'note', 'purge acceptance is not proof that every visitor sees this version'
  );
end;
$fn$;

create or replace function public.admin_begin_public_check(
  p_expected_version bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_site public.site_content%rowtype;
  v_id bigint;
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

  insert into public.verification_checks (content_version, started_by)
  values (v_site.version, v_actor)
  returning id into v_id;

  -- Register this attempt as the newest one immediately. A late result from an
  -- older in-flight attempt can no longer write the current state.
  update public.site_content as s
  set public_check_id = v_id,
      public_check_state = 'pending',
      public_check_observed_version = null,
      public_check_at = null,
      public_check_detail = null
  where s.id = 1
    and s.version = v_site.version;

  return v_id;
end;
$fn$;

create or replace function public.admin_finish_public_check(
  p_check_id bigint,
  p_state text,
  p_observed_version bigint,
  p_detail text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_now timestamptz := pg_catalog.now();
  v_site public.site_content%rowtype;
  v_check public.verification_checks%rowtype;
  v_applied integer := 0;
  v_detail text;
begin
  v_actor := public.assert_admin();

  if p_state not in ('matched', 'mismatch', 'error') then
    raise exception 'verification state must be matched, mismatch, or error' using errcode = '22023';
  end if;
  if length(coalesce(p_detail, '')) > 500 then
    raise exception 'verification detail is too long' using errcode = '22023';
  end if;
  v_detail := nullif(p_detail, '');

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.content.lock')::bigint);

  select *
  into v_site
  from public.site_content as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'published content is not initialized' using errcode = '55000';
  end if;

  select *
  into v_check
  from public.verification_checks as c
  where c.id = p_check_id
  for update;

  if not found then
    raise exception 'verification check not found' using errcode = 'P0002';
  end if;
  if v_check.state <> 'started' then
    return false;
  end if;
  if p_state = 'matched' and p_observed_version is distinct from v_check.content_version then
    raise exception 'matched verification must observe the checked version' using errcode = '22023';
  end if;

  update public.verification_checks as c
  set state = p_state,
      observed_version = p_observed_version,
      detail = v_detail,
      finished_at = v_now
  where c.id = p_check_id;

  -- Apply only if this is the newest registered attempt for the current saved
  -- version. A late result for an older attempt/version is recorded for audit
  -- but cannot overwrite the current state.
  update public.site_content as s
  set public_check_state = p_state,
      public_check_observed_version = p_observed_version,
      public_check_at = v_now,
      public_check_detail = v_detail
  where s.id = 1
    and s.version = v_check.content_version
    and s.public_check_id = v_check.id;

  get diagnostics v_applied = row_count;
  return v_applied > 0;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Public read surface
--
-- This view deliberately exposes only version, content, and saved_at. It does
-- not expose saved_by/published_by, purge_error, purge_state, or verification
-- metadata. It runs as its owner (security definer view) so anon does not need
-- access to the base table, which remains closed by RLS.
-- ---------------------------------------------------------------------------

create or replace view public.published_content
with (security_invoker = false, security_barrier = true)
as
select
  s.version,
  s.content,
  s.saved_at
from public.site_content as s
where s.id = 1;

comment on view public.published_content is
  'Public read surface. Intentionally excludes admin identity, purge, and verification columns.';

-- ---------------------------------------------------------------------------
-- RLS: read-only admin access; no direct write policies
-- ---------------------------------------------------------------------------

alter table public.admin_users enable row level security;
alter table public.site_content enable row level security;
alter table public.draft enable row level security;
alter table public.content_history enable row level security;
alter table public.content_operations enable row level security;
alter table public.verification_checks enable row level security;

create policy admin_users_read on public.admin_users
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy site_content_admin_read on public.site_content
  for select to authenticated
  using (public.is_admin());

create policy draft_admin_read on public.draft
  for select to authenticated
  using (public.is_admin());

create policy content_history_admin_read on public.content_history
  for select to authenticated
  using (public.is_admin());

create policy content_operations_admin_read on public.content_operations
  for select to authenticated
  using (public.is_admin());

create policy verification_checks_admin_read on public.verification_checks
  for select to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

revoke all on table public.admin_users from anon, authenticated;
revoke all on table public.site_content from anon, authenticated;
revoke all on table public.draft from anon, authenticated;
revoke all on table public.content_history from anon, authenticated;
revoke all on table public.content_operations from anon, authenticated;
revoke all on table public.verification_checks from anon, authenticated;

grant select on table public.admin_users to authenticated;
grant select on table public.site_content to authenticated;
grant select on table public.draft to authenticated;
grant select on table public.content_history to authenticated;
grant select on table public.content_operations to authenticated;
grant select on table public.verification_checks to authenticated;

revoke all on table public.published_content from anon, authenticated;
grant select on table public.published_content to anon, authenticated;

revoke all on sequence public.content_history_id_seq from anon, authenticated;
revoke all on sequence public.verification_checks_id_seq from anon, authenticated;

-- Internal helpers
revoke all on function public.assert_content_value(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.validate_content(jsonb) from public, anon, authenticated;
revoke all on function public.assert_admin() from public, anon, authenticated;
revoke all on function public.find_operation(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.trim_content_history() from public, anon, authenticated;

-- Policy helper must be executable by authenticated so RLS can evaluate it.
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;

-- Admin RPCs: authenticated only. assert_admin() still checks admin_users.
revoke all on function public.admin_save_draft(bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.admin_delete_draft(bigint, uuid) from public, anon, authenticated;
revoke all on function public.admin_publish(bigint, uuid, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_restore(bigint, bigint, text, uuid) from public, anon, authenticated;
revoke all on function public.admin_begin_purge(bigint, uuid) from public, anon, authenticated;
revoke all on function public.admin_record_purge(bigint, text, text) from public, anon, authenticated;
revoke all on function public.admin_begin_public_check(bigint) from public, anon, authenticated;
revoke all on function public.admin_finish_public_check(bigint, text, bigint, text) from public, anon, authenticated;

grant execute on function public.admin_save_draft(bigint, uuid, jsonb) to authenticated;
grant execute on function public.admin_delete_draft(bigint, uuid) to authenticated;
grant execute on function public.admin_publish(bigint, uuid, jsonb, text, uuid) to authenticated;
grant execute on function public.admin_restore(bigint, bigint, text, uuid) to authenticated;
grant execute on function public.admin_begin_purge(bigint, uuid) to authenticated;
grant execute on function public.admin_record_purge(bigint, text, text) to authenticated;
grant execute on function public.admin_begin_public_check(bigint) to authenticated;
grant execute on function public.admin_finish_public_check(bigint, text, bigint, text) to authenticated;

commit;
