-- C Cafe analytics: privacy-reduced visitor events, shared rate limits, and
-- admin-only statistics for the Netlify preview.
--
-- Scope:
--   * stores only the fields the existing dashboard already shows;
--   * one row per accepted event, 90-day retention, no rollup tables;
--   * events are tagged preview/production so the two environments never mix;
--   * no raw IP, user agent, referrer URL with query/hash, password, JWT, or
--     signed URL is stored;
--   * the daily visitor hash is computed by the server Function (HMAC over the
--     rotating day + IP + user agent) and is not reversible here.
--
-- Security:
--   * analytics_events / analytics_rate_limits / analytics_secrets are closed to
--     anon and authenticated; RLS is enabled with no policies;
--   * the only write path is public.analytics_ingest(), which requires the
--     SHA-256 digest of the server-only ingest token. The raw token never reaches
--     the database or PostgREST;
--   * reading and clearing statistics require public.assert_admin();
--   * cleanup is a SECURITY DEFINER function with no API-role grant. It is meant
--     to be called by the database scheduler (pg_cron) or the Management API.
--
-- Rate limits are stored in a shared table, so two Function instances see the
-- same counters. The counters are not per-process memory.

begin;

-- ---------------------------------------------------------------------------
-- Event storage
-- ---------------------------------------------------------------------------

create table public.analytics_events (
  id bigint generated always as identity primary key,
  env text not null check (env in ('preview', 'production')),
  day date not null,
  occurred_at timestamptz not null,
  visitor text not null check (visitor ~ '^[0-9a-f]{16}$'),
  session text not null check (session ~ '^[a-z0-9]{8,32}$'),
  type text not null check (type in ('pageview', 'section', 'mood', 'click', 'leave')),
  name text,
  kind text,
  referrer text,
  utm text,
  device text,
  browser text,
  os text,
  duration_ms integer,
  scroll integer,
  constraint analytics_events_name_len check (name is null or char_length(name) <= 80),
  constraint analytics_events_name_chars check (name is null or name !~ '[[:cntrl:]]'),
  constraint analytics_events_kind check (
    kind is null or kind in ('call', 'directions', 'instagram', 'whatsapp', 'email', 'external', 'internal')
  ),
  constraint analytics_events_referrer check (
    referrer is null or referrer ~ '^[a-z0-9.-]{1,100}$'
  ),
  constraint analytics_events_utm check (
    utm is null or utm ~ '^[a-z0-9._-]{1,40}$'
  ),
  constraint analytics_events_device check (
    device is null or device in ('mobile', 'desktop', 'tablet', 'other')
  ),
  constraint analytics_events_browser check (
    browser is null or browser in (
      'chrome', 'safari', 'edge', 'firefox', 'samsung', 'opera',
      'instagram', 'facebook', 'tiktok', 'snapchat', 'other'
    )
  ),
  constraint analytics_events_os check (
    os is null or os in ('android', 'ios', 'windows', 'macos', 'linux', 'other')
  ),
  constraint analytics_events_duration check (
    duration_ms is null or (duration_ms >= 0 and duration_ms <= 7200000)
  ),
  constraint analytics_events_scroll check (
    scroll is null or (scroll >= 0 and scroll <= 100)
  )
);

comment on table public.analytics_events is
  'Privacy-reduced analytics events. Raw IPs and user agents are never stored; visitor is a server-side daily HMAC.';

create index analytics_events_env_time_idx
  on public.analytics_events (env, occurred_at);

create index analytics_events_env_day_idx
  on public.analytics_events (env, day);

-- ---------------------------------------------------------------------------
-- Shared rate-limit counters
--
-- minute: per visitor hash, matching the previous 120 events/minute design.
-- day:    per environment and Baghdad day, matching the previous 200000/day cap.
-- ---------------------------------------------------------------------------

create table public.analytics_rate_limits (
  env text not null check (env in ('preview', 'production')),
  scope text not null check (scope in ('minute', 'day')),
  bucket text not null,
  window_start timestamptz not null,
  count integer not null check (count >= 0),
  primary key (env, scope, bucket, window_start)
);

comment on table public.analytics_rate_limits is
  'Shared counters across Function instances. Cleanup removes entries older than two days.';

-- ---------------------------------------------------------------------------
-- Server-only ingest token fingerprint
-- ---------------------------------------------------------------------------
-- The value seeded here is an inert placeholder, not a live verifier. After a
-- fresh install, generate CCAFE_ANALYTICS_INGEST_TOKEN and replace this row with
-- D2 = SHA-256('ingest|' || SHA-256('ingest|' || token)). During a restore, load
-- the exported public.analytics_secrets row instead (or rotate both together).

create table public.analytics_secrets (
  name text primary key,
  value_sha256 text not null check (value_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null default now()
);

comment on table public.analytics_secrets is
  'Server-only ingest fingerprint. No API role can read this table.';

insert into public.analytics_secrets (name, value_sha256)
values (
  'ingest',
  '1111111111111111111111111111111111111111111111111111111111111111'
);

-- ---------------------------------------------------------------------------
-- Ingest RPC
--
-- Called only by netlify/functions/track.js with the anon key. The caller must
-- present SHA-256('ingest|' || token). The database repeats all field checks so
-- a direct PostgREST call with a leaked digest still cannot store arbitrary
-- JSON or exceed the field limits of the existing tracker.
--
-- Thresholds:
--   * 120 events per visitor per UTC minute;
--   * 200000 events per environment per Baghdad day.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_ingest(
  p_token_sha256 text,
  p_env text,
  p_event jsonb,
  p_visitor text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_expected text;
  v_now timestamptz := clock_timestamp();
  v_day date;
  v_type text;
  v_session text;
  v_name text;
  v_kind text;
  v_referrer text;
  v_utm text;
  v_device text;
  v_browser text;
  v_os text;
  v_ms integer;
  v_sc integer;
  v_count integer;
  v_minute timestamptz;
  v_day_start timestamptz;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select s.value_sha256 into v_expected
  from public.analytics_secrets as s
  where s.name = 'ingest';
  if v_expected is null or p_token_sha256 <> v_expected then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_env is null or p_env not in ('preview', 'production') then
    raise exception 'invalid environment' using errcode = '22023';
  end if;
  if p_visitor is null or p_visitor !~ '^[0-9a-f]{16}$' then
    raise exception 'invalid visitor' using errcode = '22023';
  end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'invalid event' using errcode = '22023';
  end if;

  v_type := p_event->>'e';
  if v_type is null or v_type not in ('pageview', 'section', 'mood', 'click', 'leave') then
    raise exception 'invalid event type' using errcode = '22023';
  end if;

  v_session := p_event->>'s';
  if v_session is null or v_session !~ '^[a-z0-9]{8,32}$' then
    raise exception 'invalid session' using errcode = '22023';
  end if;

  v_day := (v_now at time zone 'Asia/Baghdad')::date;
  -- Start of the Baghdad day as a timestamptz. Using date_trunc('day', now)
  -- would split one Baghdad day across two UTC windows.
  v_day_start := (v_day::timestamp at time zone 'Asia/Baghdad');

  if v_type = 'pageview' then
    v_referrer := nullif(p_event->>'r', '');
    if v_referrer is not null and v_referrer !~ '^[a-z0-9.-]{1,100}$' then
      raise exception 'invalid referrer' using errcode = '22023';
    end if;
    v_utm := nullif(p_event->>'u', '');
    if v_utm is not null and v_utm !~ '^[a-z0-9._-]{1,40}$' then
      raise exception 'invalid utm' using errcode = '22023';
    end if;
    v_device := coalesce(p_event->>'device', 'other');
    v_browser := coalesce(p_event->>'browser', 'other');
    v_os := coalesce(p_event->>'os', 'other');
    if v_device not in ('mobile', 'desktop', 'tablet', 'other')
      or v_browser not in (
        'chrome', 'safari', 'edge', 'firefox', 'samsung', 'opera',
        'instagram', 'facebook', 'tiktok', 'snapchat', 'other'
      )
      or v_os not in ('android', 'ios', 'windows', 'macos', 'linux', 'other') then
      raise exception 'invalid agent classification' using errcode = '22023';
    end if;
  elsif v_type = 'section' then
    v_name := p_event->>'n';
    if v_name is null or v_name !~ '^[a-z0-9_-]{1,32}$' then
      raise exception 'invalid section' using errcode = '22023';
    end if;
  elsif v_type = 'mood' then
    v_name := p_event->>'n';
    if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 60
      or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid mood' using errcode = '22023';
    end if;
  elsif v_type = 'click' then
    v_name := coalesce(p_event->>'n', '');
    if char_length(v_name) > 80 or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid click label' using errcode = '22023';
    end if;
    v_kind := p_event->>'k';
    if v_kind is null or v_kind not in (
      'call', 'directions', 'instagram', 'whatsapp', 'email', 'external', 'internal'
    ) then
      v_kind := 'external';
    end if;
  elsif v_type = 'leave' then
    if jsonb_typeof(p_event->'ms') = 'number' then
      v_ms := greatest(0, least((p_event->>'ms')::numeric, 7200000))::integer;
    else
      v_ms := 0;
    end if;
    if jsonb_typeof(p_event->'sc') = 'number' then
      v_sc := greatest(0, least(round((p_event->>'sc')::numeric), 100))::integer;
    else
      v_sc := 0;
    end if;
  end if;

  -- Shared minute counter. A rejected event still consumes the counter, exactly
  -- like the previous implementation.
  v_minute := date_trunc('minute', v_now);
  insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
  values (p_env, 'minute', p_visitor, v_minute, 1)
  on conflict (env, scope, bucket, window_start)
  do update set count = public.analytics_rate_limits.count + 1
  returning count into v_count;
  if v_count > 120 then
    return jsonb_build_object('ok', false, 'reason', 'minute_limit');
  end if;

  -- Shared daily cap per environment.
  insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
  values (p_env, 'day', v_day::text, v_day_start, 1)
  on conflict (env, scope, bucket, window_start)
  do update set count = public.analytics_rate_limits.count + 1
  returning count into v_count;
  if v_count > 200000 then
    return jsonb_build_object('ok', false, 'reason', 'day_limit');
  end if;

  insert into public.analytics_events (
    env, day, occurred_at, visitor, session, type, name, kind,
    referrer, utm, device, browser, os, duration_ms, scroll
  ) values (
    p_env, v_day, v_now, p_visitor, v_session, v_type, v_name, v_kind,
    v_referrer, v_utm, v_device, v_browser, v_os, v_ms, v_sc
  );

  return jsonb_build_object('ok', true);
end;
$fn$;

comment on function public.analytics_ingest(text, text, jsonb, text) is
  'Token-gated event ingest. The database repeats validation and enforces shared rate limits.';

-- ---------------------------------------------------------------------------
-- Admin read/clear RPCs
-- ---------------------------------------------------------------------------

create or replace function public.admin_analytics_snapshot(
  p_env text,
  p_range text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := clock_timestamp();
  v_days integer;
  v_today date;
  v_from timestamptz;
  v_prev_from timestamptz;
  v_prev_to timestamptz;
  v_live_from timestamptz;
  v_current jsonb;
  v_previous jsonb;
  v_live jsonb;
begin
  perform public.assert_admin();

  if p_env is null or p_env not in ('preview', 'production') then
    raise exception 'invalid environment' using errcode = '22023';
  end if;
  v_days := case p_range
    when 'today' then 1
    when '7d' then 7
    when '30d' then 30
    when '90d' then 90
    else null
  end;
  if v_days is null then
    raise exception 'invalid range' using errcode = '22023';
  end if;

  v_today := (v_now at time zone 'Asia/Baghdad')::date;
  v_from := ((v_today - (v_days - 1))::timestamp at time zone 'Asia/Baghdad');
  v_prev_from := ((v_today - (2 * v_days - 1))::timestamp at time zone 'Asia/Baghdad');
  v_prev_to := v_from;
  v_live_from := v_now - interval '5 minutes';

  select coalesce(jsonb_agg(public.analytics_event_json(e.occurred_at, e.visitor, e.session, e.type,
    e.name, e.kind, e.referrer, e.utm, e.device, e.browser, e.os, e.duration_ms, e.scroll)
    order by e.occurred_at), '[]'::jsonb)
  into v_current
  from public.analytics_events as e
  where e.env = p_env and e.occurred_at >= v_from and e.occurred_at <= v_now;

  select coalesce(jsonb_agg(public.analytics_event_json(e.occurred_at, e.visitor, e.session, e.type,
    e.name, e.kind, e.referrer, e.utm, e.device, e.browser, e.os, e.duration_ms, e.scroll)
    order by e.occurred_at), '[]'::jsonb)
  into v_previous
  from public.analytics_events as e
  where e.env = p_env and e.occurred_at >= v_prev_from and e.occurred_at < v_prev_to;

  select coalesce(jsonb_agg(public.analytics_event_json(e.occurred_at, e.visitor, e.session, e.type,
    e.name, e.kind, e.referrer, e.utm, e.device, e.browser, e.os, e.duration_ms, e.scroll)
    order by e.occurred_at), '[]'::jsonb)
  into v_live
  from public.analytics_events as e
  where e.env = p_env and e.occurred_at >= v_live_from and e.occurred_at <= v_now;

  return jsonb_build_object(
    'env', p_env,
    'range', p_range,
    'generated_at', (extract(epoch from v_now) * 1000)::bigint,
    'current', v_current,
    'previous', v_previous,
    'live', v_live
  );
end;
$fn$;

comment on function public.admin_analytics_snapshot(text, text) is
  'Admin-only snapshot for the existing dashboard indicators. Nothing is aggregated in storage.';

create or replace function public.analytics_event_json(
  p_occurred_at timestamptz,
  p_visitor text,
  p_session text,
  p_type text,
  p_name text,
  p_kind text,
  p_referrer text,
  p_utm text,
  p_device text,
  p_browser text,
  p_os text,
  p_duration_ms integer,
  p_scroll integer
)
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    't', (extract(epoch from p_occurred_at) * 1000)::bigint,
    'v', p_visitor,
    's', p_session,
    'e', p_type,
    'n', p_name,
    'k', p_kind,
    'r', p_referrer,
    'u', p_utm,
    'device', p_device,
    'browser', p_browser,
    'os', p_os,
    'ms', p_duration_ms,
    'sc', p_scroll
  ));
$fn$;

create or replace function public.admin_analytics_clear(p_env text)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_deleted integer;
begin
  perform public.assert_admin();

  if p_env is null or p_env not in ('preview', 'production') then
    raise exception 'invalid environment' using errcode = '22023';
  end if;

  delete from public.analytics_events where env = p_env;
  get diagnostics v_deleted = row_count;
  delete from public.analytics_rate_limits where env = p_env;
  return v_deleted;
end;
$fn$;

comment on function public.admin_analytics_clear(text) is
  'Admin-only clear scoped to one environment. Content, media, and history are untouched.';

-- ---------------------------------------------------------------------------
-- Retention
--
-- Keeps exactly the 90 days the dashboard can display. There is no rollup and
-- no longer retention. Only the database scheduler or the Management API calls
-- this; no API role has EXECUTE.
-- ---------------------------------------------------------------------------

create or replace function public.analytics_purge_expired(p_retention_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_events integer;
  v_limits integer;
begin
  if p_retention_days is null or p_retention_days < 1 or p_retention_days > 365 then
    raise exception 'invalid retention' using errcode = '22023';
  end if;

  delete from public.analytics_events
  where occurred_at < clock_timestamp() - make_interval(days => p_retention_days);
  get diagnostics v_events = row_count;

  delete from public.analytics_rate_limits
  where window_start < clock_timestamp() - interval '2 days';
  get diagnostics v_limits = row_count;

  return jsonb_build_object('events', v_events, 'rate_limits', v_limits);
end;
$fn$;

comment on function public.analytics_purge_expired(integer) is
  'Scheduled retention: deletes events older than 90 days and rate rows older than two days.';

-- ---------------------------------------------------------------------------
-- Privileges: no direct table access, explicit RPC surface only
-- ---------------------------------------------------------------------------

alter table public.analytics_events enable row level security;
alter table public.analytics_rate_limits enable row level security;
alter table public.analytics_secrets enable row level security;

revoke all on table public.analytics_events from public, anon, authenticated;
revoke all on table public.analytics_rate_limits from public, anon, authenticated;
revoke all on table public.analytics_secrets from public, anon, authenticated;
revoke all on sequence public.analytics_events_id_seq from public, anon, authenticated;

revoke all on function public.analytics_ingest(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.analytics_ingest(text, text, jsonb, text) to anon;

revoke all on function public.admin_analytics_snapshot(text, text)
  from public, anon, authenticated;
grant execute on function public.admin_analytics_snapshot(text, text) to authenticated;

revoke all on function public.analytics_event_json(timestamptz, text, text, text, text, text,
  text, text, text, text, text, integer, integer) from public, anon, authenticated;

revoke all on function public.admin_analytics_clear(text)
  from public, anon, authenticated;
grant execute on function public.admin_analytics_clear(text) to authenticated;

revoke all on function public.analytics_purge_expired(integer)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Scheduled retention
--
-- pg_cron is available on the cloud project. The block is a no-op when the
-- extension is not installed (local PGlite tests), so migrations stay portable.
-- The job runs daily at 03:15 UTC (06:15 Baghdad) and keeps 90 days.
-- ---------------------------------------------------------------------------

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      execute 'select cron.unschedule(''ccafe_analytics_purge'')';
    exception when others then
      null;
    end;
    execute 'select cron.schedule(''ccafe_analytics_purge'', ''15 3 * * *'', ''select public.analytics_purge_expired(90)'')';
  end if;
end;
$cron$;

commit;
