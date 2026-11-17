-- C Cafe content model: admins, published content, one draft, history, operations,
-- and public-page verification attempts.
--
-- Scope note: this migration is deliberately local-only for now. It does not
-- create Storage buckets, analytics tables, Netlify functions, or login UI.
-- The running application (server.js/admin) is not connected to these tables.
--
-- Security model:
--   * Public readers can only SELECT public.published_content (version/content/saved_at).
--   * Authenticated admins can read admin tables, but all writes go through the
--     SECURITY DEFINER RPCs in the next migration.
--   * RLS is enabled and no INSERT/UPDATE/DELETE policies are created.
--   * Admin identity comes from auth.uid() plus public.admin_users. No user can
--     grant themselves admin through the API.

begin;

-- ---------------------------------------------------------------------------
-- Admin allow-list
-- ---------------------------------------------------------------------------

create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'admin' check (role = 'admin'),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

comment on table public.admin_users is
  'Local/bootstrap admin allow-list. Rows are managed by the service role or migrations only; there is no self-service admin RPC.';

-- ---------------------------------------------------------------------------
-- Public-page verification attempts
--
-- A verification is a two-step operation: begin (record attempt) then finish
-- (record observed version). This makes it possible to reject a result for an
-- old content version or an older attempt that finishes late.
-- ---------------------------------------------------------------------------

create table public.verification_checks (
  id bigint generated always as identity primary key,
  content_version bigint not null check (content_version >= 1),
  state text not null default 'started'
    check (state in ('started', 'matched', 'mismatch', 'error')),
  observed_version bigint,
  detail text,
  started_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index verification_checks_content_version_idx
  on public.verification_checks (content_version, id desc);

comment on table public.verification_checks is
  'Each attempt to fetch the public page and compare its embedded content version. Results are operational data, not visitor-facing content.';

-- ---------------------------------------------------------------------------
-- Published content (one row)
--
-- version is the saved content version. purge_state describes the CDN purge
-- request only; it is never proof that visitors can see this version.
-- public_check_* describes a separate verification attempt.
-- ---------------------------------------------------------------------------

create table public.site_content (
  id smallint primary key default 1 check (id = 1),
  version bigint not null check (version >= 1),
  content jsonb not null,
  saved_at timestamptz not null default now(),
  saved_by uuid references auth.users (id) on delete set null,

  purge_state text not null default 'pending'
    check (purge_state in ('pending', 'requested', 'accepted', 'failed')),
  purge_requested_at timestamptz,
  purge_accepted_at timestamptz,
  purge_error text,
  purge_operation_id uuid,

  public_check_id bigint references public.verification_checks (id) on delete set null,
  public_check_state text not null default 'pending'
    check (public_check_state in ('pending', 'matched', 'mismatch', 'error')),
  public_check_observed_version bigint,
  public_check_at timestamptz,
  public_check_detail text
);

comment on column public.site_content.version is
  'Saved published content version. This is not a claim that every CDN edge is serving it.';
comment on column public.site_content.purge_state is
  'CDN purge progress only: pending, requested, accepted, failed. Acceptance is not live-visibility proof.';
comment on column public.site_content.public_check_id is
  'Newest registered verification attempt for the current saved version. Only this attempt may write the result.';
comment on column public.site_content.public_check_state is
  'Separate public-page verification result for public_check_observed_version.';

-- ---------------------------------------------------------------------------
-- Draft (one row)
--
-- revision_id changes on every save and is never reused. It acts as the
-- optimistic concurrency token for save/delete/publish. Deleting and creating
-- a new draft therefore cannot revive an old token.
-- ---------------------------------------------------------------------------

create table public.draft (
  id smallint primary key default 1 check (id = 1),
  revision_id uuid not null default gen_random_uuid() unique,
  content jsonb not null,
  base_version bigint not null check (base_version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on column public.draft.revision_id is
  'Rotates on every save. Expected-revision checks reject stale editors, including after delete/recreate.';
comment on column public.draft.base_version is
  'Published version the draft was based on. Publishing a draft against a newer published version is rejected.';

-- ---------------------------------------------------------------------------
-- Published history (last 50 versions are retained by the publish RPC)
-- ---------------------------------------------------------------------------

create table public.content_history (
  id bigint generated always as identity primary key,
  version bigint not null unique check (version >= 1),
  content jsonb not null,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  operation_id uuid
);

create unique index content_history_operation_id_key
  on public.content_history (operation_id)
  where operation_id is not null;

create index content_history_version_idx
  on public.content_history (version desc, id desc);

comment on table public.content_history is
  'Immutable published versions. Restore inserts a new version; it never moves an old row to current.';

-- ---------------------------------------------------------------------------
-- Idempotent publish/restore operations
--
-- A retry with the same operation_id and the same request returns the original
-- result instead of creating another content version. Reusing an operation ID
-- for a different actor, kind, content, or parameters is rejected.
-- ---------------------------------------------------------------------------

create table public.content_operations (
  operation_id uuid primary key,
  actor_id uuid not null references auth.users (id) on delete restrict,
  kind text not null check (kind in ('publish', 'restore')),
  request jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

comment on table public.content_operations is
  'Idempotency records for publish/restore retries. The stored request fingerprint prevents reusing an operation ID for different content or parameters.';

-- ---------------------------------------------------------------------------
-- Database-side content validation
--
-- Netlify normalization is not a security boundary: an authenticated caller
-- can call the RPC directly. These functions reject malformed content, oversized
-- values, unsafe links, and non-asset image paths before any row is changed.
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

    -- PostgreSQL text/jsonb cannot contain a NUL byte, so no separate NUL check
    -- is needed or possible here.
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
      if v_text <> '' and (
        v_text !~ '^assets/[A-Za-z0-9_./-]+$'
        or v_text like '%..%'
      ) then
        raise exception 'image paths must stay under assets/' using errcode = '22023';
      end if;
    end if;
  end if;
end;
$fn$;

create or replace function public.validate_content(p_content jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_group text;
  v_section text;
begin
  if p_content is null or pg_catalog.jsonb_typeof(p_content) is distinct from 'object' then
    raise exception 'content must be a JSON object' using errcode = '22023';
  end if;

  if octet_length(p_content::text) > 2 * 1024 * 1024 then
    raise exception 'content is larger than 2 MB' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_object_keys(p_content) as keys(key)
    where keys.key not in (
      'contact', 'seo', 'brand', 'header', 'hero', 'moods', 'vibes',
      'offer', 'menu', 'visit', 'footer', 'quickbar', 'layout', 'settings'
    )
  ) then
    raise exception 'content contains an unknown top-level key' using errcode = '22023';
  end if;

  if not (p_content ?& array[
    'contact', 'seo', 'brand', 'header', 'hero', 'moods', 'vibes',
    'offer', 'menu', 'visit', 'footer', 'quickbar', 'layout', 'settings'
  ]) then
    raise exception 'content is missing a required top-level key' using errcode = '22023';
  end if;

  foreach v_group in array array[
    'contact', 'seo', 'brand', 'header', 'hero', 'moods', 'vibes',
    'offer', 'menu', 'visit', 'footer', 'quickbar'
  ] loop
    if pg_catalog.jsonb_typeof(p_content -> v_group) is distinct from 'object' then
      raise exception 'content group % must be an object', v_group using errcode = '22023';
    end if;
  end loop;

  foreach v_section in array array['moods', 'vibes', 'offer', 'menu', 'visit'] loop
    if (p_content -> v_section) ? 'visible' then
      if pg_catalog.jsonb_typeof(p_content -> v_section -> 'visible') is distinct from 'boolean' then
        raise exception 'section % visible must be boolean', v_section using errcode = '22023';
      end if;
    end if;
  end loop;

  if pg_catalog.jsonb_typeof(p_content -> 'layout') is distinct from 'object' then
    raise exception 'layout must be an object' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_content -> 'layout' -> 'order') is distinct from 'array' then
    raise exception 'layout.order must be an array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(p_content -> 'layout' -> 'order') <> 5 then
    raise exception 'layout.order must contain exactly the five visible sections' using errcode = '22023';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements_text(p_content -> 'layout' -> 'order') as item(value)
    where item.value not in ('moods', 'vibes', 'offer', 'menu', 'visit')
  ) then
    raise exception 'layout.order contains an unknown section' using errcode = '22023';
  end if;
  if (
    select count(distinct item.value)
    from pg_catalog.jsonb_array_elements_text(p_content -> 'layout' -> 'order') as item(value)
  ) <> 5 then
    raise exception 'layout.order contains a duplicate section' using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(p_content -> 'settings') is distinct from 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_content -> 'settings' -> 'tracking') is distinct from 'boolean' then
    raise exception 'settings.tracking must be boolean' using errcode = '22023';
  end if;

  perform public.assert_content_value(p_content, '$', 0);
end;
$fn$;

-- Internal validation functions are not callable by API roles.
revoke all on function public.assert_content_value(jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.validate_content(jsonb) from public, anon, authenticated;

commit;
