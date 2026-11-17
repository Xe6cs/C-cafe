// Real HTTP checks against the C-cafe Supabase project.
//
// This suite uses Auth-issued JWTs and PostgREST/GoTrue over HTTPS. It never
// uses the service_role key to prove visitor/admin permissions; the service key
// is only used to confirm that a rejected public signup created no user.
//
// Required environment (the suite fails clearly when any is missing):
//   CCAFE_PROJECT_REF        must be mzbhncsdpdbxsdswzruc
//   CCAFE_SUPABASE_URL       https://mzbhncsdpdbxsdswzruc.supabase.co
//   CCAFE_ANON_KEY           public anon key
//   CCAFE_SERVICE_ROLE_KEY   server-only key, used only for the signup check
//   CCAFE_CREDENTIALS_FILE   temp JSON with the two test account sessions
//
// It writes nothing except the rejected signup attempt. Content-mutating
// concurrency tests live in pg-cloud-check.mjs and run in a throwaway database.

import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const ALLOWED_REF = 'mzbhncsdpdbxsdswzruc';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `missing required environment variable ${name}; refusing to skip remote verification`,
    );
  }
  return value;
}

const ref = requireEnv('CCAFE_PROJECT_REF');
const baseUrl = requireEnv('CCAFE_SUPABASE_URL').replace(/\/$/, '');
const anonKey = requireEnv('CCAFE_ANON_KEY');
const serviceKey = requireEnv('CCAFE_SERVICE_ROLE_KEY');
const credentialsFile = requireEnv('CCAFE_CREDENTIALS_FILE');

if (ref !== ALLOWED_REF) {
  throw new Error(`refusing project ref ${ref}; only ${ALLOWED_REF} is allowed`);
}
if (baseUrl !== `https://${ALLOWED_REF}.supabase.co`) {
  throw new Error(`refusing host ${baseUrl}; expected https://${ALLOWED_REF}.supabase.co`);
}

const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
if (credentials.project_ref !== ALLOWED_REF) {
  throw new Error('credentials file belongs to a different project');
}
if (!credentials.admin?.access_token || !credentials.viewer?.access_token) {
  throw new Error('credentials file is missing test sessions');
}

const localContent = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
const rest = `${baseUrl}/rest/v1`;
const auth = `${baseUrl}/auth/v1`;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function headers(token, extra = {}, apiKey = anonKey) {
  return {
    apikey: apiKey,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...extra,
  };
}

async function request(
  url,
  { method = 'GET', token = anonKey, body, extraHeaders = {}, apiKey = anonKey } = {},
) {
  const response = await fetch(url, {
    method,
    headers: {
      ...headers(token, extraHeaders, apiKey),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
  return { status: response.status, data, headers: response.headers };
}

function safeMessage(body) {
  if (body && typeof body === 'object') {
    return [body.code, body.message, body.details, body.hint].filter(Boolean).join(' | ');
  }
  return typeof body === 'string' ? body.slice(0, 160) : '';
}

function expectStatus(result, allowed, label) {
  if (!allowed.includes(result.status)) {
    throw new Error(`${label}: expected ${allowed.join('/')} got ${result.status} ${safeMessage(result.data)}`);
  }
}

function expectDenied(result, label) {
  expectStatus(result, [401, 403, 404], label);
}

const anon = anonKey;
const viewer = credentials.viewer.access_token;
const admin = credentials.admin.access_token;

let adminTableSnapshot = null;

await check('visitor: public view exposes only version/content/saved_at', async () => {
  const result = await request(`${rest}/published_content?select=*`, { token: anon });
  expectStatus(result, [200], 'published_content');
  assert(Array.isArray(result.data) && result.data.length === 1, 'expected exactly one row');
  const keys = Object.keys(result.data[0]).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(['content', 'saved_at', 'version']),
    `unexpected columns: ${keys.join(',')}`,
  );
  assert(isDeepStrictEqual(result.data[0].content, localContent), 'content parity failed');
});

await check('visitor: hidden public-view columns are rejected', async () => {
  const result = await request(`${rest}/published_content?select=saved_by`, { token: anon });
  expectStatus(result, [400], 'saved_by select');
  assert(/column|saved_by/i.test(safeMessage(result.data)), 'expected an unknown-column error');
});

await check('visitor: all admin tables are unreadable', async () => {
  for (const table of [
    'site_content',
    'draft',
    'content_history',
    'content_operations',
    'verification_checks',
    'admin_users',
  ]) {
    const result = await request(`${rest}/${table}?select=*`, { token: anon });
    expectDenied(result, table);
  }
});

await check('visitor: admin RPCs are not executable', async () => {
  const payload = {
    p_expected_version: 1,
    p_expected_revision: null,
    p_content: localContent,
  };
  expectDenied(await request(`${rest}/rpc/admin_save_draft`, { method: 'POST', token: anon, body: payload }), 'save_draft');
  const publish = {
    p_expected_version: 1,
    p_expected_draft_revision: null,
    p_content: localContent,
    p_note: 'verify',
    p_operation_id: randomUUID(),
  };
  expectDenied(await request(`${rest}/rpc/admin_publish`, { method: 'POST', token: anon, body: publish }), 'publish');
});

await check('visitor: public signup is rejected and creates no user', async () => {
  const listUrl = `${auth}/admin/users?page=1&per_page=100`;
  const before = await request(listUrl, { token: serviceKey, apiKey: serviceKey });
  expectStatus(before, [200], 'admin list users');
  const beforeUsers = before.data?.users || [];

  const email = `ccafe.verify.signup.${randomBytes(6).toString('hex')}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const signup = await request(`${auth}/signup`, {
    method: 'POST',
    token: anon,
    body: { email, password },
  });
  expectStatus(signup, [400, 403, 422], 'signup');

  const after = await request(listUrl, { token: serviceKey, apiKey: serviceKey });
  expectStatus(after, [200], 'admin list users after signup');
  const afterUsers = after.data?.users || [];
  assert(afterUsers.length === beforeUsers.length, 'signup changed the auth user count');
  assert(!afterUsers.some((u) => String(u.email).toLowerCase() === email), 'signup created a user');
});

await check('viewer: public view works with a real Auth JWT', async () => {
  const result = await request(`${rest}/published_content?select=*`, { token: viewer });
  expectStatus(result, [200], 'published_content');
  assert(Array.isArray(result.data) && result.data.length === 1, 'expected exactly one row');
  assert(
    JSON.stringify(Object.keys(result.data[0]).sort()) ===
      JSON.stringify(['content', 'saved_at', 'version']),
    'unexpected public columns',
  );
});

await check('viewer: admin tables expose no rows', async () => {
  adminTableSnapshot = {};
  for (const table of [
    'site_content',
    'draft',
    'content_history',
    'content_operations',
    'verification_checks',
    'admin_users',
  ]) {
    const result = await request(`${rest}/${table}?select=*`, { token: viewer });
    expectStatus(result, [200], table);
    assert(Array.isArray(result.data) && result.data.length === 0, `${table} leaked rows`);
    adminTableSnapshot[table] = 0;
  }
});

await check('viewer: admin RPCs are denied by assert_admin', async () => {
  const payload = {
    p_expected_version: 1,
    p_expected_revision: null,
    p_content: localContent,
  };
  const save = await request(`${rest}/rpc/admin_save_draft`, {
    method: 'POST',
    token: viewer,
    body: payload,
  });
  expectStatus(save, [403], 'save_draft');
  assert(/admin only/i.test(safeMessage(save.data)), 'expected admin-only rejection');

  const publish = await request(`${rest}/rpc/admin_publish`, {
    method: 'POST',
    token: viewer,
    body: {
      p_expected_version: 1,
      p_expected_draft_revision: null,
      p_content: localContent,
      p_note: 'verify',
      p_operation_id: randomUUID(),
    },
  });
  expectStatus(publish, [403], 'publish');
  assert(/admin only/i.test(safeMessage(publish.data)), 'expected admin-only rejection');
});

await check('viewer: self-admin grant is impossible', async () => {
  const insert = await request(`${rest}/admin_users`, {
    method: 'POST',
    token: viewer,
    body: { user_id: credentials.viewer.id, role: 'admin' },
  });
  expectDenied(insert, 'insert admin_users');

  const update = await request(`${rest}/admin_users?user_id=eq.${credentials.viewer.id}`, {
    method: 'PATCH',
    token: viewer,
    body: { role: 'admin' },
  });
  expectDenied(update, 'update admin_users');

  const readBack = await request(`${rest}/admin_users?select=*`, { token: viewer });
  expectStatus(readBack, [200], 'read admin_users');
  assert(Array.isArray(readBack.data) && readBack.data.length === 0, 'viewer gained an admin row');
});

await check('viewer: direct writes are denied', async () => {
  const attempts = [
    ['PATCH', `${rest}/site_content?id=eq.1`, { content: {} }],
    ['POST', `${rest}/site_content`, { id: 1, version: 2, content: {} }],
    ['POST', `${rest}/draft`, { id: 1, content: {}, base_version: 1 }],
    ['PATCH', `${rest}/draft?id=eq.1`, { content: {} }],
    ['DELETE', `${rest}/draft?id=eq.1`, undefined],
    ['POST', `${rest}/content_history`, { version: 2, content: {} }],
    ['DELETE', `${rest}/content_history?id=eq.1`, undefined],
  ];
  for (const [method, url, body] of attempts) {
    expectDenied(await request(url, { method, token: viewer, body }), `${method} ${url}`);
  }
});

await check('admin: real JWT can read admin tables', async () => {
  const site = await request(`${rest}/site_content?select=version,content`, { token: admin });
  expectStatus(site, [200], 'site_content');
  assert(site.data.length === 1, 'expected site_content row');
  const version = site.data[0].version;
  assert(Number.isInteger(version) && version >= 1, 'invalid version');

  const history = await request(`${rest}/content_history?select=id,version`, { token: admin });
  expectStatus(history, [200], 'content_history');
  assert(history.data.length >= 1, 'expected history row');

  const admins = await request(`${rest}/admin_users?select=user_id,role`, { token: admin });
  expectStatus(admins, [200], 'admin_users');
  assert(admins.data.some((row) => row.user_id === credentials.admin.id), 'admin row missing');

  const draft = await request(`${rest}/draft?select=*`, { token: admin });
  expectStatus(draft, [200], 'draft');
  assert(draft.data.length === 0, 'draft should not exist before the permission test');
});

await check('admin: invalid content is rejected by the RPC atomically', async () => {
  const siteBefore = await request(`${rest}/site_content?select=version`, { token: admin });
  expectStatus(siteBefore, [200], 'version before');
  const versionBefore = siteBefore.data[0].version;
  const historyBefore = await request(`${rest}/content_history?select=id`, { token: admin });
  const operationsBefore = await request(`${rest}/content_operations?select=operation_id`, { token: admin });

  const publish = await request(`${rest}/rpc/admin_publish`, {
    method: 'POST',
    token: admin,
    body: {
      p_expected_version: versionBefore,
      p_expected_draft_revision: null,
      p_content: {},
      p_note: 'verify invalid content',
      p_operation_id: randomUUID(),
    },
  });
  expectStatus(publish, [400], 'invalid publish');
  assert(/required top-level key/i.test(safeMessage(publish.data)), 'expected validation error');

  const save = await request(`${rest}/rpc/admin_save_draft`, {
    method: 'POST',
    token: admin,
    body: { p_expected_version: versionBefore, p_expected_revision: null, p_content: {} },
  });
  expectStatus(save, [400], 'invalid draft save');
  assert(/required top-level key/i.test(safeMessage(save.data)), 'expected validation error');

  const siteAfter = await request(`${rest}/site_content?select=version`, { token: admin });
  const historyAfter = await request(`${rest}/content_history?select=id`, { token: admin });
  const operationsAfter = await request(`${rest}/content_operations?select=operation_id`, { token: admin });
  assert(siteAfter.data[0].version === versionBefore, 'invalid publish changed the version');
  assert(historyAfter.data.length === historyBefore.data.length, 'invalid publish wrote history');
  assert(operationsAfter.data.length === operationsBefore.data.length, 'invalid publish recorded an operation');

  const draftAfter = await request(`${rest}/draft?select=*`, { token: admin });
  assert(draftAfter.data.length === 0, 'invalid save created a draft');
});

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    project: ref,
  }),
);
if (failed.length > 0) {
  console.error('Remote HTTP verification failed.');
  process.exit(1);
}
