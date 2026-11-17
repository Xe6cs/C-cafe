// Mandatory remote verification for the C-cafe Supabase project.
//
// Run with: npm run verify:supabase
//
// This command is intentionally strict: it does not skip when configuration is
// missing, and it refuses to run against any project other than C-cafe.
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
//   * signup is closed and email login stays enabled;
//   * the public view exposes only version/content/saved_at and matches
//     data/content.json exactly;
//   * anon cannot read any admin table;
//   * no test auth users, admin allow-list rows, drafts, operations, checks, or
//     temporary DB roles remain;
//   * the migration history is the expected two migrations;
//   * the CLI JIT role, if it could not be dropped, cannot log in.
//
// It is a read-only verifier. It does not use service_role, does not publish,
// and does not create or delete users.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ALLOWED_REF = 'mzbhncsdpdbxsdswzruc';
const ALLOWED_REGION = 'us-east-2';
const EXPECTED_MIGRATIONS = '20261106120000,20261106121000';
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
if (baseUrl !== `https://${ALLOWED_REF}.supabase.co`) {
  throw new Error(`refusing host ${baseUrl}; expected https://${ALLOWED_REF}.supabase.co`);
}

const localContent = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
const rest = `${baseUrl}/rest/v1`;
const auth = `${baseUrl}/auth/v1`;
const management = `https://api.supabase.com/v1/projects/${ALLOWED_REF}`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeMessage(body) {
  if (body && typeof body === 'object') {
    return [body.code, body.message, body.details, body.hint].filter(Boolean).join(' | ');
  }
  return typeof body === 'string' ? body.slice(0, 200) : '';
}

async function request(
  url,
  { method = 'GET', token, body, headers = {}, withApiKey = true } = {},
) {
  const response = await fetch(url, {
    method,
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
    body: { query: sql },
  });
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`management query failed: ${result.status} ${safeMessage(result.data)}`);
  }
  const rows = Array.isArray(result.data) ? result.data : result.data?.rows || [result.data];
  assert(rows.length === 1, 'management query must return exactly one row');
  return rows[0];
}

function expectDenied(result, label) {
  assert(
    [401, 403, 404].includes(result.status),
    `${label}: expected 401/403/404, got ${result.status} ${safeMessage(result.data)}`,
  );
}

const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

await check('project identity is C-cafe and healthy', async () => {
  const project = await managementRequest(management);
  assert(project.status === 200, `project lookup failed: ${project.status} ${safeMessage(project.data)}`);
  assert(project.data?.id === ALLOWED_REF, `unexpected project id ${project.data?.id}`);
  assert(project.data?.name === 'C-cafe', `unexpected project name ${project.data?.name}`);
  assert(project.data?.status === 'ACTIVE_HEALTHY', `project is not healthy: ${project.data?.status}`);
  assert(project.data?.region === ALLOWED_REGION, `unexpected region ${project.data?.region}`);
});

await check('signup is closed and email login is enabled', async () => {
  const managed = await managementRequest(`${management}/config/auth`);
  assert(managed.status === 200, `auth config failed: ${managed.status} ${safeMessage(managed.data)}`);
  assert(managed.data?.disable_signup === true, 'management config still allows signup');

  const gotrue = await request(`${auth}/settings`, { token: anonKey });
  assert(gotrue.status === 200, `GoTrue settings failed: ${gotrue.status} ${safeMessage(gotrue.data)}`);
  assert(gotrue.data?.disable_signup === true, 'GoTrue still allows signup');
  assert(gotrue.data?.external?.email === true, 'email login is not enabled');
});

await check('public view has only version/content/saved_at and matches content.json', async () => {
  const published = await request(`${rest}/published_content?select=*`, { token: anonKey });
  assert(published.status === 200, `public view failed: ${published.status} ${safeMessage(published.data)}`);
  assert(Array.isArray(published.data) && published.data.length === 1, 'expected exactly one row');
  const keys = Object.keys(published.data[0]).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(['content', 'saved_at', 'version']),
    `unexpected public columns: ${keys.join(',')}`,
  );
  assert(isDeepStrictEqual(published.data[0].content, localContent), 'content parity failed');
});

await check('anon cannot read any admin table', async () => {
  for (const table of [
    'site_content',
    'draft',
    'content_history',
    'content_operations',
    'verification_checks',
    'admin_users',
  ]) {
    const result = await request(`${rest}/${table}?select=*`, { token: anonKey });
    expectDenied(result, table);
  }
});

await check('anon cannot execute admin RPCs', async () => {
  const save = await request(`${rest}/rpc/admin_save_draft`, {
    method: 'POST',
    token: anonKey,
    body: { p_expected_version: 1, p_expected_revision: null, p_content: localContent },
  });
  expectDenied(save, 'admin_save_draft');

  const publish = await request(`${rest}/rpc/admin_publish`, {
    method: 'POST',
    token: anonKey,
    body: {
      p_expected_version: 1,
      p_expected_draft_revision: null,
      p_content: localContent,
      p_note: 'verify',
      p_operation_id: '00000000-0000-4000-8000-000000000000',
    },
  });
  expectDenied(publish, 'admin_publish');
});

await check('no test users, admin rows, drafts, operations, checks, or temp roles remain', async () => {
  const contentLiteral = `'${JSON.stringify(localContent).replace(/'/g, "''")}'::jsonb`;
  const state = await managementQuery(`
    with expected as (select ${contentLiteral} as content)
    select
      (select version from public.site_content where id = 1) as version,
      (select s.content = e.content from public.site_content s cross join expected e where s.id = 1) as content_matches,
      (select count(*) from public.content_history) as history,
      (select count(*) from public.content_history h cross join expected e where h.content <> e.content) as non_original_history,
      (select count(*) from public.content_operations) as operations,
      (select count(*) from public.verification_checks) as verification_checks,
      (select count(*) from public.draft) as drafts,
      (select count(*) from public.admin_users) as admins,
      (select count(*) from auth.users) as auth_users,
      (select count(*) from pg_roles where rolname like 'ccafe_verify_login_%') as temp_roles,
      (select count(*) from pg_roles where rolname = 'cli_login_postgres' and rolcanlogin) as cli_login_roles,
      (select count(*) from supabase_migrations.schema_migrations) as migrations,
      (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations) as migration_versions,
      (select count(*) from public.published_content) as public_rows
  `);

  assert(state.content_matches === true, 'published content does not match data/content.json');
  assert(Number(state.non_original_history) === 0, 'history contains non-original content');
  assert(Number(state.operations) === 0, 'content operations remain');
  assert(Number(state.verification_checks) === 0, 'verification checks remain');
  assert(Number(state.drafts) === 0, 'a draft remains');
  assert(Number(state.admins) === 0, 'admin allow-list rows remain');
  assert(Number(state.auth_users) === 0, 'auth users remain');
  assert(Number(state.temp_roles) === 0, 'temporary DB roles remain');
  assert(Number(state.cli_login_roles) === 0, 'the CLI JIT role can still log in');
  assert(Number(state.migrations) === 2, `expected 2 migrations, found ${state.migrations}`);
  assert(state.migration_versions === EXPECTED_MIGRATIONS, `unexpected migrations: ${state.migration_versions}`);
  assert(Number(state.public_rows) === 1, 'published_content does not expose exactly one row');
  assert(Number(state.version) >= 1, `unexpected content version ${state.version}`);
});

const failed = checks.filter((item) => !item.ok);
console.log(
  JSON.stringify({
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.length,
    project: ALLOWED_REF,
  }),
);
if (failed.length > 0) {
  console.error('Supabase verification failed. Missing settings or a wrong state is never skipped.');
  process.exit(1);
}
