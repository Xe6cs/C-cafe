-- Analytics: make the stored ingest fingerprint non-replayable.
--
-- Before this migration the database compared the presented value directly with
-- the stored digest, so the stored digest was itself a usable credential: anyone
-- able to read public.analytics_secrets could call analytics_ingest directly.
--
-- New scheme (no change to netlify/functions/track.js):
--   * the Function still sends D1 = SHA-256('ingest|' || raw token);
--   * the database stores D2 = SHA-256('ingest|' || D1);
--   * analytics_ingest hashes the presented value once more before comparing.
--
-- Consequences:
--   * the raw token never reaches the database, PostgREST, or any log;
--   * the value the Function sends is not stored anywhere;
--   * replaying the stored fingerprint (D2) is rejected, because SHA-256 of D2
--     is not D2;
--   * sending anything that is not exactly D1 (raw token, D2, random hex) is
--     rejected with SQLSTATE 42501 before any counter or row is touched.
--
-- The function signature and grants are unchanged.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Upgrade the deployed fingerprint from the inert placeholder to the second
-- placeholder. The condition keeps the migration idempotent and avoids
-- overwriting a rotated value. A real deployment must set public.analytics_secrets
-- from the generated token; a restore loads the exported row instead.
update public.analytics_secrets
set value_sha256 = '2222222222222222222222222222222222222222222222222222222222222222',
    updated_at = pg_catalog.now()
where name = 'ingest'
  and value_sha256 = '1111111111111111111111111111111111111111111111111111111111111111';

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
  v_presented text;
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
  v_presented := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to('ingest|' || p_token_sha256, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_expected is null or v_presented <> v_expected then
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
  'Token-gated event ingest with a second-order fingerprint. The database repeats validation and enforces shared rate limits.';

revoke all on function public.analytics_ingest(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.analytics_ingest(text, text, jsonb, text) to anon;
