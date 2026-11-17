// Mandatory read-only verification of the live C-cafe Supabase project.
//
// Run with: npm run verify:supabase
//
// This command is intentionally strict: it never skips when configuration is
// missing, refuses to run against any other project, and only reads production
// state. It does not clean up data, attempt admin RPCs, create/delete users, or
// change any account. Normal non-empty operational tables are allowed.
//
// Required environment:
//   CCAFE_PROJECT_REF        must be mzbhncsdpdbxsdswzruc
//   SUPABASE_URL             https://mzbhncsdpdbxsdswzruc.supabase.co
//   SUPABASE_ANON_KEY        public anon key (browser-safe)
//   SUPABASE_ACCESS_TOKEN    Supabase personal access token, used only for
//                            read-only Management API state checks. Never put
//                            this in the app or in Git.
//
// What it proves:
//   * project identity and healthy status;
//   * signup is closed, email login stays enabled, and Auth site_url is official;
//   * the public view exposes only version/content/saved_at, matches
//     data/content.json, and carries the official seo.siteUrl;
//   * anon cannot read any admin table (read-only GET probes);
//   * migration history matches the local supabase/migrations files exactly;
//   * a valid admin exists, admin table/function grants are correct, and no
//     temporary verification role can log in.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ALLOWED_REF = 'mzbhncsdpdbxsdswzruc';
const ALLOWED_HOST = `https://${ALLOWED_REF}.supabase.co`;
const ALLOWED_REGION = 'us-east-2';
const OFFICIAL_SITE_URL = 'https://c-cafe-preview.netlify.app';
const ADMIN_TABLES = [
  'site_content',
  'draft',
  'content_history',
  'content_operations',
  'verification_checks',
  'admin_users',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `missing required environment variable ${name}; refusing to skip Supabase verification`,
    );
  }
  return value;
}

const ref = requireEnv('CCAFE_PROJECT_REF');
const baseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
const anonKey = requireEnv('SUPABASE_ANON_KEY');
const accessToken = requireEnv('SUPABASE_ACCESS_TOKEN');

if (ref !== ALLOWED_REF) {
  throw new Error(`refusing project ref ${ref}; only ${ALLOWED_REF} is allowed`);
}
if (baseUrl !== ALLOWED_HOST) {
  throw new Error(`refusing host ${baseUrl}; expected ${ALLOWED_HOST}`);
}

const localContent = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
const migrationFiles = await readdir(path.join(root, 'supabase', 'migrations'));
const localMigrations = migrationFiles
  .map((name) => /^(\d{14})_.*\.sql$/.exec(name)?.[1])
  .filter(Boolean)
  .sort();
if (localMigrations.length === 0) {
  throw new Error('no local migration files found; refusing to verify an empty migration set');
}
if (new Set(localMigrations).size !== localMigrations.length) {
  throw new Error('local migration versions are duplicated');
}

const rest = `${baseUrl}/rest/v1`;
const auth = `${baseUrl}/auth/v1`;
const management = `https://api.supabase.com/v1/projects/${ALLOWED_REF}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeMessage(body) {
  if (body && typeof body === 'object' && typeof body.code === 'string') {
    return `code=${body.code}`;
  }
  return '';
}

async function request(url, { method = 'GET', token, body, headers = {}, withApiKey = true } = {}) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(token && withApiKey ? { apikey: token } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function managementRequest(url, options = {}) {
  return request(url, {
    ...options,
    token: accessToken,
    withApiKey: false,
    headers: { Authorization: `Bearer ${accessToken}`, ...(options.headers || {}) },
  });
}

async function managementQuery(sql) {
  const result = await managementRequest(`${management}/database/query`, {
    method: 'POST',
    body: { query: sql, read_only: true },
  });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`read-only management query failed: ${result.status} ${safeMessage(result.data)}`);
  }
  const rows = Array.isArray(result.data) ? result.data : result.data?.rows || [];
  assert(rows.length === 1, 'read-only management query must return exactly one row');
  return rows[0];
}

function expectDenied(result, label) {
  assert(
    [401, 403, 404].includes(result.status),
    `${label}: expected 401/403/404, got ${result.status} ${safeMessage(result.data)}`,
  );
}

const checks = [];
let state = null;
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false });
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check('project identity is C-cafe and healthy', async () => {
  const project = await managementRequest(management);
  assert(
    project.status === 200,
    `project lookup failed: ${project.status} ${safeMessage(project.data)}`,
  );
  assert(project.data?.id === ALLOWED_REF, `unexpected project id ${project.data?.id}`);
  assert(project.data?.name === 'C-cafe', `unexpected project name ${project.data?.name}`);
  assert(project.data?.status === 'ACTIVE_HEALTHY', `project is not healthy: ${project.data?.status}`);
  assert(project.data?.region === ALLOWED_REGION, `unexpected region ${project.data?.region}`);
});

await check('signup is closed, email login is enabled, and site_url is official', async () => {
  const managed = await managementRequest(`${management}/config/auth`);
  assert(
    managed.status === 200,
    `auth config failed: ${managed.status} ${safeMessage(managed.data)}`,
  );
  assert(managed.data?.disable_signup === true, 'management config still allows signup');
  assert(managed.data?.external_email_enabled === true, 'email login is not enabled');
  assert(
    managed.data?.site_url === OFFICIAL_SITE_URL,
    'management Auth site_url is not the official URL',
  );

  const gotrue = await request(`${auth}/settings`, { token: anonKey });
  assert(
    gotrue.status === 200,
    `GoTrue settings failed: ${gotrue.status} ${safeMessage(gotrue.data)}`,
  );
  assert(gotrue.data?.disable_signup === true, 'GoTrue still allows signup');
  assert(gotrue.data?.external?.email === true, 'GoTrue email login is not enabled');
});

await check('public view is minimal, matches local content, and has the official site URL', async () => {
  const published = await request(`${rest}/published_content?select=*`, { token: anonKey });
  assert(
    published.status === 200,
    `public view failed: ${published.status} ${safeMessage(published.data)}`,
  );
  assert(Array.isArray(published.data) && published.data.length === 1, 'expected exactly one row');
  const keys = Object.keys(published.data[0]).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(['content', 'saved_at', 'version']),
    `unexpected public columns: ${keys.join(',')}`,
  );
  assert(Number.isSafeInteger(published.data[0].version), 'public version is not an integer');
  assert(published.data[0].version >= 1, 'public version is invalid');
  assert(isDeepStrictEqual(published.data[0].content, localContent), 'content parity failed');
  assert(
    published.data[0].content?.seo?.siteUrl === OFFICIAL_SITE_URL,
    'published seo.siteUrl is not the official URL',
  );
});

await check('anon cannot read admin tables', async () => {
  for (const table of ADMIN_TABLES) {
    const result = await request(`${rest}/${table}?select=*`, { token: anonKey });
    expectDenied(result, table);
  }
});

await check('remote migrations match the local migration files', async () => {
  const row = await managementQuery(`
    select
      count(*)::int as count,
      coalesce(string_agg(version, ',' order by version), '') as versions
    from supabase_migrations.schema_migrations
  `);
  const remoteMigrations = String(row.versions || '')
    .split(',')
    .filter(Boolean)
    .sort();
  assert(
    Number(row.count) === localMigrations.length,
    `migration count mismatch: local ${localMigrations.length}, remote ${row.count}`,
  );
  assert(
    JSON.stringify(remoteMigrations) === JSON.stringify(localMigrations),
    'migration versions do not match the local files',
  );
});

await check('final admin, RLS, grants, and login roles are correct', async () => {
  const tables = ADMIN_TABLES.map((name) => `'${name}'`).join(',');
  state = await managementQuery(`
    select
      (select version::int from public.site_content where id = 1) as content_version,
      (select count(*)::int from public.admin_users) as admin_rows,
      (select count(*)::int from public.admin_users a join auth.users u on u.id = a.user_id where a.role = 'admin') as valid_admin_grants,
      (select count(*)::int from public.admin_users a left join auth.users u on u.id = a.user_id where u.id is null) as orphan_admin_rows,
      (select count(*)::int from auth.users) as auth_users,
      (select count(*)::int from public.draft) as drafts,
      (select count(*)::int from public.content_operations) as operations,
      (select count(*)::int from public.analytics_events) as analytics_events,
      (select count(*)::int from public.verification_checks) as verification_checks,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${tables}) and not c.relrowsecurity) as rls_missing,
      (select count(*)::int from pg_policies where schemaname = 'public' and tablename in (${tables}) and cmd <> 'SELECT') as write_policies,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${tables}) and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))) as anon_admin_table_exposure,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (${tables}) and (not has_table_privilege('authenticated', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE') or has_table_privilege('authenticated', c.oid, 'DELETE'))) as admin_table_grant_errors,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'published_content' and not has_table_privilege('anon', c.oid, 'SELECT')) as published_anon_select_missing,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'published_content' and (has_table_privilege('anon', c.oid, 'INSERT') or has_table_privilege('anon', c.oid, 'UPDATE') or has_table_privilege('anon', c.oid, 'DELETE'))) as published_anon_write_exposure,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'admin_%' and (has_function_privilege('anon', p.oid::regprocedure, 'EXECUTE') or has_function_privilege('public', p.oid::regprocedure, 'EXECUTE'))) as admin_funcs_exposed,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'admin_%' and not has_function_privilege('authenticated', p.oid::regprocedure, 'EXECUTE')) as admin_funcs_missing_auth,
      (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('assert_admin','is_admin') and (has_function_privilege('anon', p.oid::regprocedure, 'EXECUTE') or has_function_privilege('public', p.oid::regprocedure, 'EXECUTE'))) as guard_funcs_exposed,
      (select count(*)::int from pg_roles where rolname like 'ccafe_verify_login_%' and rolcanlogin) as temp_login_roles
  `);

  assert(Number(state.content_version) >= 1, 'published content version is invalid');
  assert(Number(state.valid_admin_grants) >= 1, 'no valid admin grant exists');
  assert(
    Number(state.admin_rows) === Number(state.valid_admin_grants),
    'admin allow-list contains orphan or non-admin rows',
  );
  assert(Number(state.orphan_admin_rows) === 0, 'admin allow-list references missing auth users');
  assert(Number(state.auth_users) >= Number(state.valid_admin_grants), 'auth user count is invalid');
  assert(Number(state.rls_missing) === 0, 'admin table is missing row level security');
  assert(Number(state.write_policies) === 0, 'admin table has a write policy');
  assert(Number(state.anon_admin_table_exposure) === 0, 'anon can read an admin table');
  assert(Number(state.admin_table_grant_errors) === 0, 'admin table grants are wrong');
  assert(Number(state.published_anon_select_missing) === 0, 'anon cannot read the public view');
  assert(Number(state.published_anon_write_exposure) === 0, 'anon has write access to the public view');
  assert(Number(state.admin_funcs_exposed) === 0, 'admin RPC is executable by anon or PUBLIC');
  assert(Number(state.admin_funcs_missing_auth) === 0, 'admin RPC is not executable by authenticated');
  assert(Number(state.guard_funcs_exposed) === 0, 'admin guard function is executable by anon or PUBLIC');
  assert(Number(state.temp_login_roles) === 0, 'a temporary verification role can still log in');
});

const failed = checks.filter((item) => !item.ok);
console.log(
  JSON.stringify({
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    project: ALLOWED_REF,
    read_only: true,
    content_version: state ? Number(state.content_version) : null,
    migrations: localMigrations.length,
    admins: state ? Number(state.valid_admin_grants) : null,
    auth_users: state ? Number(state.auth_users) : null,
    drafts: state ? Number(state.drafts) : null,
    operations: state ? Number(state.operations) : null,
    analytics_events: state ? Number(state.analytics_events) : null,
  }),
);
if (failed.length > 0) {
  console.error('Supabase verification failed. Missing settings or a wrong state is never skipped.');
  process.exitCode = 1;
}
