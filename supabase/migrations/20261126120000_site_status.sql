-- C Cafe temporary site pause (maintenance mode).
--
-- This migration is LOCAL ONLY. It is not applied to the hosted Supabase project
-- as part of this change. The feature must not be deployed before this migration
-- is applied deliberately.
--
-- Scope:
--   * site state is separate from site_content, draft, history, and media;
--   * default state for an existing site is 'running';
--   * the public read view exposes ONLY state and message;
--   * admins read the full state through admin_site_status();
--   * every change goes through admin_set_site_status(), which re-checks
--     admin membership, validates input, uses a server-side lock, rotates a
--     revision, and records an idempotency + audit row.
--
-- Publish/restore never touch these tables. Stopping/restarting never touches
-- published content, drafts, history, media, or users. This is a site display
-- pause, not a change to REST or Storage privacy.

begin;

-- ---------------------------------------------------------------------------
-- Singleton state and operation ledger
-- ---------------------------------------------------------------------------

create table public.site_status (
  id smallint primary key default 1 check (id = 1),
  state text not null default 'running' check (state in ('running', 'stopped')),
  message text not null default '' check (char_length(message) <= 300),
  revision bigint not null default 1 check (revision >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table public.site_status is
  'Singleton display state for the public site. Separate from all content tables; publish/restore must not modify it.';
comment on column public.site_status.revision is
  'Optimistic concurrency token. Every accepted new state change increments it; an idempotent replay returns the original result unchanged.';

create table public.site_status_operations (
  operation_id uuid primary key,
  actor_id uuid not null references auth.users (id) on delete restrict,
  kind text not null check (kind in ('stop', 'restart')),
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.site_status_operations is
  'Idempotency and audit ledger for site pause/restart. Actor identity is never exposed through the public view.';

insert into public.site_status (id, state, message, revision)
values (1, 'running', '', 1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Internal idempotency lookup
-- ---------------------------------------------------------------------------

create or replace function public.find_site_status_operation(
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
  v_operation public.site_status_operations%rowtype;
begin
  select *
  into v_operation
  from public.site_status_operations as o
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

-- ---------------------------------------------------------------------------
-- Admin read surface (identity is visible to admins only)
-- ---------------------------------------------------------------------------

create or replace function public.admin_site_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_actor uuid;
  v_status public.site_status%rowtype;
  v_email text;
begin
  v_actor := public.assert_admin();

  select *
  into v_status
  from public.site_status as s
  where s.id = 1;

  if not found then
    raise exception 'site status is not initialized' using errcode = '55000';
  end if;

  select u.email into v_email from auth.users as u where u.id = v_status.updated_by;

  return pg_catalog.jsonb_build_object(
    'state', v_status.state,
    'message', v_status.message,
    'revision', v_status.revision,
    'updated_at', v_status.updated_at,
    'changed_by', pg_catalog.jsonb_build_object(
      'id', v_status.updated_by,
      'email', coalesce(v_email, '')
    )
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Admin write surface
-- ---------------------------------------------------------------------------

create or replace function public.admin_set_site_status(
  p_state text,
  p_message text,
  p_expected_revision bigint,
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
  v_message text := coalesce(p_message, '');
  v_kind text;
  v_current public.site_status%rowtype;
  v_state text;
  v_message_after text;
  v_revision bigint;
  v_updated_at timestamptz;
  v_updated_by uuid;
  v_email text;
  v_request jsonb;
  v_existing jsonb;
  v_result jsonb;
begin
  v_actor := public.assert_admin();

  if p_state is null or p_state not in ('running', 'stopped') then
    raise exception 'invalid site state' using errcode = '22023';
  end if;
  if char_length(v_message) > 300 then
    raise exception 'site message is too long' using errcode = '22023';
  end if;
  if p_state = 'running' and v_message <> '' then
    raise exception 'restart must clear the visitor message' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 1 then
    raise exception 'expected revision is required' using errcode = '22023';
  end if;
  if p_operation_id is null then
    raise exception 'operation id is required' using errcode = '22023';
  end if;

  v_kind := case when p_state = 'stopped' then 'stop' else 'restart' end;
  v_request := pg_catalog.jsonb_build_object(
    'state', p_state,
    'message', v_message,
    'expected_revision', p_expected_revision
  );

  -- A separate lock namespace is intentional: content operations never change
  -- site state, and this operation never changes content.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ccafe.site-status.lock')::bigint);

  v_existing := public.find_site_status_operation(p_operation_id, v_actor, v_kind, v_request);
  if v_existing is not null then
    return pg_catalog.jsonb_strip_nulls(v_existing || pg_catalog.jsonb_build_object('idempotent', true));
  end if;

  select *
  into v_current
  from public.site_status as s
  where s.id = 1
  for update;

  if not found then
    raise exception 'site status is not initialized' using errcode = '55000';
  end if;
  if v_current.revision <> p_expected_revision then
    raise exception 'stale site status revision' using errcode = 'PT409';
  end if;

  update public.site_status as s
  set state = p_state,
      message = v_message,
      revision = s.revision + 1,
      updated_at = v_now,
      updated_by = v_actor
  where s.id = 1
  returning s.state, s.message, s.revision, s.updated_at, s.updated_by
    into v_state, v_message_after, v_revision, v_updated_at, v_updated_by;

  select u.email into v_email from auth.users as u where u.id = v_updated_by;

  v_result := pg_catalog.jsonb_build_object(
    'state', v_state,
    'message', v_message_after,
    'revision', v_revision,
    'updated_at', v_updated_at,
    'changed_by', pg_catalog.jsonb_build_object(
      'id', v_updated_by,
      'email', coalesce(v_email, '')
    ),
    'operation_id', p_operation_id,
    'idempotent', false
  );

  insert into public.site_status_operations (operation_id, actor_id, kind, request, result)
  values (p_operation_id, v_actor, v_kind, v_request, v_result);

  return v_result;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Public read surface: state and message only
-- ---------------------------------------------------------------------------

create or replace view public.public_site_status
with (security_invoker = false, security_barrier = true)
as
select
  s.state,
  s.message
from public.site_status as s
where s.id = 1;

comment on view public.public_site_status is
  'Minimum public read surface for the site Function. Intentionally excludes revision, timestamps, actor identity, and audit rows.';

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------

alter table public.site_status enable row level security;
alter table public.site_status_operations enable row level security;

create policy site_status_admin_read on public.site_status
  for select to authenticated
  using (public.is_admin());

create policy site_status_operations_admin_read on public.site_status_operations
  for select to authenticated
  using (public.is_admin());

revoke all on table public.site_status from anon, authenticated;
revoke all on table public.site_status_operations from anon, authenticated;
grant select on table public.site_status to authenticated;
grant select on table public.site_status_operations to authenticated;

revoke all on table public.public_site_status from anon, authenticated;
grant select on table public.public_site_status to anon, authenticated;

revoke all on function public.find_site_status_operation(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_site_status() from public, anon, authenticated;
revoke all on function public.admin_set_site_status(text, text, bigint, uuid) from public, anon, authenticated;

grant execute on function public.admin_site_status() to authenticated;
grant execute on function public.admin_set_site_status(text, text, bigint, uuid) to authenticated;

commit;
