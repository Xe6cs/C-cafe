-- Replace retryable SQLSTATE 40001 conflict raises with PostgREST PT409.
--
-- PostgREST treats 40001 (serialization_failure) as retryable and the
-- request hung until the upstream timeout, so stale-revision conflicts never
-- reached the API as HTTP 409. PT409 is returned immediately as HTTP 409.
-- The function bodies are otherwise unchanged; grants survive CREATE OR
-- REPLACE.

begin;

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

commit;
