'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createHash } = require('node:crypto');

const { handler, _internal } = require('../netlify/functions/admin-api');

const TOKEN = 'test-access-token-0123456789abcdefghijklmnopqrstuvwxyz';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const NEW_REV = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';
const ASSET_PATH = `media/${ASSET_ID}`;
const FINALIZE_TOKEN = 'test-finalize-token-0123456789abcdef';
const MEDIA_SHA = 'a'.repeat(64);
const PUBLIC_PATH = `published/${ASSET_ID}/${'b'.repeat(64)}`;
const TRASH_PATH = `trash/${ASSET_ID}/${'c'.repeat(64)}`;
const OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const ANON = 'anon-test-key';

let pngCache = null;
async function samplePng() {
  if (!pngCache) {
    pngCache = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 200, g: 120, b: 40 } },
    }).png().toBuffer();
  }
  return pngCache;
}

function mediaRow(overrides = {}) {
  return {
    id: ASSET_ID,
    logical_path: ASSET_PATH,
    status: 'approved',
    original_name: 'photo.png',
    mime: 'image/png',
    bytes: 1024,
    width: 2,
    height: 2,
    failure_reason: null,
    created_at: '2026-11-09T10:00:00+00:00',
    finalized_at: '2026-11-09T10:01:00+00:00',
    created_by: USER_ID,
    declared_mime: 'image/png',
    declared_bytes: 1024,
    ...overrides,
  };
}

function mediaSignReply(path = ASSET_PATH) {
  return reply({ signedURL: `/object/sign/ccafe-media/${path}?token=signed` });
}

let mediaCache = null;
async function sampleMedia() {
  if (!mediaCache) {
    const png = await samplePng();
    mediaCache = {
      png,
      sha: createHash('sha256').update(png).digest('hex'),
      bytes: png.length,
      width: 2,
      height: 2,
      pixel_count: 4,
    };
  }
  return mediaCache;
}

function deleteBeginReply(media, overrides = {}) {
  return reply({
    state: 'staging',
    asset_id: ASSET_ID,
    logical_path: ASSET_PATH,
    bucket: 'ccafe-trash',
    object_path: TRASH_PATH,
    mime: 'image/png',
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    pixel_count: media.pixel_count,
    sha256: media.sha,
    trash_state: 'staging',
    idempotent: false,
    ...overrides,
  });
}

function cleanupTargetsReply(overrides = {}) {
  return reply({
    asset_id: ASSET_ID,
    logical_path: ASSET_PATH,
    cleanup_state: 'pending',
    public_object_path: null,
    public_cleanup_state: 'none',
    ...overrides,
  });
}

function restoreBeginReply(media, overrides = {}) {
  return reply({
    state: 'restoring',
    asset_id: ASSET_ID,
    logical_path: ASSET_PATH,
    bucket: 'ccafe-media',
    storage_path: ASSET_PATH,
    trash_bucket: 'ccafe-trash',
    trash_object_path: TRASH_PATH,
    mime: 'image/png',
    bytes: media.bytes,
    width: media.width,
    height: media.height,
    pixel_count: media.pixel_count,
    sha256: media.sha,
    idempotent: false,
    ...overrides,
  });
}

function publicAsset(overrides = {}) {
  return {
    id: ASSET_ID,
    logical_path: ASSET_PATH,
    sha256: MEDIA_SHA,
    mime: 'image/png',
    bytes: 1024,
    width: 2,
    height: 2,
    public_state: 'staging',
    object_path: PUBLIC_PATH,
    ...overrides,
  };
}

function publishBeginReply(overrides = {}) {
  return reply({
    state: 'ready',
    version: 243,
    draft_revision: REV,
    assets: [],
    needs_prepare: [],
    ...overrides,
  });
}

function publishResultReply(operationId = NEW_REV, overrides = {}) {
  return reply({
    version: 244,
    saved_at: '2026-11-08T12:00:00+00:00',
    operation_id: operationId,
    source: 'draft',
    purge_state: 'pending',
    public_check_state: 'pending',
    ...overrides,
  });
}

const saved = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_ANON_KEY,
  timeout: process.env.CCAFE_SUPABASE_TIMEOUT_MS,
  verify: process.env.CCAFE_VERIFY_ORIGIN,
  prime: process.env.DEPLOY_PRIME_URL,
  site: process.env.URL,
  finalize: process.env.CCAFE_MEDIA_FINALIZE_TOKEN,
  analyticsEnv: process.env.CCAFE_ANALYTICS_ENV,
  fetch: global.fetch,
};

const CONTENT = { hero: { big: 'مرحبا', line1: 'سطر' }, contact: { name: 'سي كافيه' } };
const DRAFT_CONTENT = { hero: { big: 'مسودة جديدة', line1: 'سطر' }, contact: { name: 'سي كافيه' } };
const PUBLISHED_ROW = {
  version: 243,
  content: CONTENT,
  saved_at: '2026-11-06T23:37:22.959179+00:00',
};
const DRAFT_ROW = {
  content: DRAFT_CONTENT,
  revision_id: REV,
  base_version: 243,
  updated_at: '2026-11-07T10:00:00+00:00',
};

function configure() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = ANON;
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_VERIFY_ORIGIN;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.URL;
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = 'test-token-1234567890-abcdefghijklmnopqrstuvwxyz';
  delete process.env.CCAFE_ANALYTICS_ENV;
}

function restore() {
  for (const [name, value] of [
    ['SUPABASE_URL', saved.url],
    ['SUPABASE_ANON_KEY', saved.key],
    ['CCAFE_SUPABASE_TIMEOUT_MS', saved.timeout],
    ['CCAFE_VERIFY_ORIGIN', saved.verify],
    ['DEPLOY_PRIME_URL', saved.prime],
    ['URL', saved.site],
    ['CCAFE_MEDIA_FINALIZE_TOKEN', saved.finalize],
    ['CCAFE_ANALYTICS_ENV', saved.analyticsEnv],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = saved.fetch;
}

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function htmlReply(status, body, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null; } },
    async text() {
      return body;
    },
  };
}

function binaryReply(status, bytes, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get(name) { return map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null; } },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function installFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, init });
    for (const route of routes) {
      if (href.includes(route.match)) {
        const target = route.handler || route.reply;
        return typeof target === 'function' ? target(url, init) : target;
      }
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  return calls;
}

function storageDeleteUrls(calls) {
  return calls
    .filter((entry) => entry.init.method === 'DELETE' && String(entry.url).includes('/storage/v1/object/'))
    .map((entry) => String(entry.url));
}

function adminRoutes(overrides = {}) {
  return [
    { match: '/auth/v1/user', reply: overrides.user || reply({ id: USER_ID, email: 'admin@example.com' }) },
    { match: '/rest/v1/rpc/is_admin', reply: overrides.admin || reply(true) },
    { match: '/rest/v1/published_content', reply: overrides.published || reply([PUBLISHED_ROW]) },
    { match: '/rest/v1/draft', reply: overrides.draft || reply([]) },
    {
      match: '/rest/v1/content_history',
      reply: overrides.history || reply([{ id: 1, version: 243, note: 'seed', created_at: '2026-11-06T23:37:22.959179+00:00' }]),
    },
    {
      match: '/rest/v1/rpc/admin_save_draft',
      reply: overrides.save || reply({ revision_id: NEW_REV, base_version: 243, updated_at: '2026-11-07T10:00:00+00:00' }),
    },
    {
      match: '/rest/v1/rpc/admin_delete_draft',
      reply: overrides.remove || reply({ deleted: true }),
    },
    ...(overrides.publishRpc ? [{ match: '/rest/v1/rpc/admin_publish', reply: overrides.publishRpc }] : []),
    ...(overrides.restoreRpc ? [{ match: '/rest/v1/rpc/admin_restore', reply: overrides.restoreRpc }] : []),
    ...(overrides.historyClear ? [{ match: '/rest/v1/rpc/admin_clear_content_history', reply: overrides.historyClear }] : []),
    ...(overrides.historyDelete ? [{ match: '/rest/v1/rpc/admin_delete_content_history_entry', reply: overrides.historyDelete }] : []),
    ...(overrides.beginCheck ? [{ match: '/rest/v1/rpc/admin_begin_public_check', reply: overrides.beginCheck }] : []),
    ...(overrides.finishCheck ? [{ match: '/rest/v1/rpc/admin_finish_public_check', reply: overrides.finishCheck }] : []),
    ...(overrides.siteStatus ? [{ match: '/rest/v1/rpc/admin_site_status', reply: overrides.siteStatus }] : []),
    ...(overrides.siteStatusSet ? [{ match: '/rest/v1/rpc/admin_set_site_status', reply: overrides.siteStatusSet }] : []),
    ...(overrides.analyticsSnapshot ? [{ match: '/rest/v1/rpc/admin_analytics_snapshot', reply: overrides.analyticsSnapshot }] : []),
    ...(overrides.analyticsClear ? [{ match: '/rest/v1/rpc/admin_analytics_clear', reply: overrides.analyticsClear }] : []),
    ...(overrides.historyClear ? [{ match: '/rest/v1/rpc/admin_clear_content_history', reply: overrides.historyClear }] : []),
    ...(overrides.mediaAsset ? [{ match: 'id=eq.', reply: overrides.mediaAsset }] : []),
    ...(overrides.mediaApproved ? [{ match: 'status=eq.approved', reply: overrides.mediaApproved }] : []),
    ...(overrides.mediaList ? [{ match: '/rest/v1/media_assets', reply: overrides.mediaList }] : []),
    ...(overrides.mediaCreate ? [{ match: '/rest/v1/rpc/admin_media_create', reply: overrides.mediaCreate }] : []),
    {
      match: '/rest/v1/rpc/admin_media_begin_finalize',
      reply: overrides.mediaBegin || reply({
        id: ASSET_ID,
        status: 'pending',
        claimed: true,
        already_claimed: false,
        verification_started_at: '2026-11-10T10:00:00+00:00',
      }),
    },
    ...(overrides.mediaFinalize ? [{ match: '/rest/v1/rpc/admin_media_finalize', reply: overrides.mediaFinalize }] : []),
    ...(overrides.mediaFail ? [{ match: '/rest/v1/rpc/admin_media_fail', reply: overrides.mediaFail }] : []),
    ...(overrides.mediaPurgeBegin ? [{ match: '/rest/v1/rpc/admin_media_purge_begin', reply: overrides.mediaPurgeBegin }] : []),
    ...(overrides.mediaPurgeCleanup ? [{ match: '/rest/v1/rpc/admin_media_purge_cleanup', reply: overrides.mediaPurgeCleanup }] : []),
    {
      match: '/rest/v1/rpc/admin_media_publish_begin',
      reply: overrides.publishBegin || publishBeginReply(),
    },
    ...(overrides.mediaPreparePublic ? [{ match: '/rest/v1/rpc/admin_media_prepare_public', reply: overrides.mediaPreparePublic }] : []),
    ...(overrides.mediaConfirmPublic ? [{ match: '/rest/v1/rpc/admin_media_confirm_public', reply: overrides.mediaConfirmPublic }] : []),
    ...(overrides.mediaFailPublic ? [{ match: '/rest/v1/rpc/admin_media_fail_public', reply: overrides.mediaFailPublic }] : []),
    ...(overrides.mediaUsage ? [{ match: '/rest/v1/rpc/admin_media_usage', reply: overrides.mediaUsage }] : []),
    ...(overrides.mediaTrashList ? [{ match: '/rest/v1/rpc/admin_media_trash_list', reply: overrides.mediaTrashList }] : []),
    ...(overrides.mediaDeleteBegin ? [{ match: '/rest/v1/rpc/admin_media_delete_begin', reply: overrides.mediaDeleteBegin }] : []),
    ...(overrides.mediaDeleteFinish ? [{ match: '/rest/v1/rpc/admin_media_delete_finish', reply: overrides.mediaDeleteFinish }] : []),
    ...(overrides.mediaDeleteAbort ? [{ match: '/rest/v1/rpc/admin_media_delete_abort', reply: overrides.mediaDeleteAbort }] : []),
    ...(overrides.mediaDeleteCleanup ? [{ match: '/rest/v1/rpc/admin_media_delete_cleanup', reply: overrides.mediaDeleteCleanup }] : []),
    ...(overrides.mediaCleanupTargets ? [{ match: '/rest/v1/rpc/admin_media_cleanup_targets', reply: overrides.mediaCleanupTargets }] : []),
    ...(overrides.mediaRestoreBegin ? [{ match: '/rest/v1/rpc/admin_media_restore_begin', reply: overrides.mediaRestoreBegin }] : []),
    ...(overrides.mediaRestoreFinish ? [{ match: '/rest/v1/rpc/admin_media_restore_finish', reply: overrides.mediaRestoreFinish }] : []),
    ...(overrides.mediaRestoreAbort ? [{ match: '/rest/v1/rpc/admin_media_restore_abort', reply: overrides.mediaRestoreAbort }] : []),
    ...(overrides.mediaTrashObject ? [{ match: '/storage/v1/object/ccafe-trash/', reply: overrides.mediaTrashObject }] : []),
    ...(overrides.mediaPublicObject ? [{ match: '/storage/v1/object/ccafe-public/', reply: overrides.mediaPublicObject }] : []),
    ...(overrides.mediaPublic ? [{ match: '/storage/v1/object/public/ccafe-public/', reply: overrides.mediaPublic }] : []),
    ...(overrides.mediaPublicUpload ? [{ match: '/storage/v1/object/ccafe-public/', reply: overrides.mediaPublicUpload }] : []),
    ...(overrides.mediaSign ? [{ match: '/storage/v1/object/sign/ccafe-media/', reply: overrides.mediaSign }] : []),
    ...(overrides.mediaObject ? [{ match: '/storage/v1/object/ccafe-media/', reply: overrides.mediaObject }] : []),
    ...(overrides.site ? [{ match: 'c-cafe-preview.netlify.app', reply: overrides.site }] : []),
  ];
}

function adminEvent(path = '/api/admin/bootstrap', method = 'GET', token = TOKEN, body) {
  const event = {
    path,
    httpMethod: method,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    event.body = typeof body === 'string' ? body : JSON.stringify(body);
    event.isBase64Encoded = false;
  }
  return event;
}

function saveBody(extra = {}) {
  return {
    expected_version: 243,
    expected_revision: null,
    content: DRAFT_CONTENT,
    ...extra,
  };
}

function assertPrivateHeaders(result) {
  assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(result.headers['Netlify-CDN-Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(result.headers['X-Frame-Options'], 'DENY');
}

test('rejects unsupported methods before doing any work', async () => {
  configure();
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  try {
    for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await handler(adminEvent('/api/admin/bootstrap', method));
      assert.equal(result.statusCode, 405);
      assert.equal(result.headers.Allow, 'GET, HEAD');
    }
    assert.equal(called, false);

    for (const method of ['GET', 'HEAD']) {
      const result = await handler(adminEvent('/api/admin/draft', method));
      assert.equal(result.statusCode, 405);
      assert.equal(result.headers.Allow, 'POST');
    }
    for (const method of ['GET', 'HEAD']) {
      const result = await handler(adminEvent('/api/admin/draft/delete', method));
      assert.equal(result.statusCode, 405);
      assert.equal(result.headers.Allow, 'POST');
    }
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('missing or malformed authorization is 401 without calling Supabase', async () => {
  configure();
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  try {
    for (const path of ['/api/admin/bootstrap', '/api/admin/history', '/api/admin/preview']) {
      const missing = await handler(adminEvent(path, 'GET', null));
      assert.equal(missing.statusCode, 401);
      assert.deepEqual(JSON.parse(missing.body), { error: 'unauthorized' });
      assertPrivateHeaders(missing);
    }

    for (const value of ['Bearer', 'Basic abcdefghijklmnopqrstuvwxyz', 'Bearer short', 'Bearer has space in it']) {
      const result = await handler({ path: '/api/admin/bootstrap', httpMethod: 'GET', headers: { Authorization: value } });
      assert.equal(result.statusCode, 401);
    }
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('invalid token is rejected by the auth endpoint', async () => {
  configure();
  const calls = installFetch([
    { match: '/auth/v1/user', reply: reply({ message: 'invalid token' }, 401) },
  ]);

  try {
    const result = await handler(adminEvent('/api/admin/bootstrap'));
    assert.equal(result.statusCode, 401);
    assert.match(result.body, /unauthorized/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.supabase.co/auth/v1/user');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(calls[0].init.headers.apikey, ANON);
  } finally {
    restore();
  }
});

test('authenticated non-admin is 403 and cannot read or write admin data', async () => {
  configure();
  const calls = installFetch(adminRoutes({ admin: reply(false) }));

  try {
    for (const path of ['/api/admin/bootstrap', '/api/admin/history', '/api/admin/preview', '/api/admin/verify', '/api/admin/media', '/api/admin/media/url', '/api/admin/media/usage', '/api/admin/media/trash']) {
      const result = await handler(adminEvent(path));
      assert.equal(result.statusCode, 403);
      assert.deepEqual(JSON.parse(result.body), { error: 'forbidden' });
      assertPrivateHeaders(result);
    }
    for (const path of ['/api/admin/draft', '/api/admin/draft/delete', '/api/admin/publish', '/api/admin/restore', '/api/admin/media', '/api/admin/media/finalize', '/api/admin/media/abandon', '/api/admin/media/delete', '/api/admin/media/restore', '/api/admin/media/cleanup']) {
      const result = await handler(adminEvent(path, 'POST', TOKEN, saveBody()));
      assert.equal(result.statusCode, 403);
      assert.deepEqual(JSON.parse(result.body), { error: 'forbidden' });
    }
    assert.equal(calls.length, 36);
    assert.equal(calls.some((call) => call.url.includes('published_content')), false);
    assert.equal(calls.some((call) => call.url.includes('content_history')), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/draft')), false);
    assert.equal(calls.some((call) => call.url.includes('/rest/v1/media_assets')), false);
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/')), false);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_')), false);
  } finally {
    restore();
  }
});

test('admin bootstrap returns published metadata, working content, schema, and history summary', async () => {
  configure();
  const calls = installFetch(adminRoutes({ draft: reply([DRAFT_ROW]) }));

  try {
    const result = await handler(adminEvent('/api/admin/bootstrap'));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);

    const body = JSON.parse(result.body);
    assert.deepEqual(Object.keys(body).sort(), ['history', 'published', 'schema', 'server_time', 'user', 'working']);
    assert.deepEqual(body.user, { id: USER_ID, email: 'admin@example.com' });
    assert.equal(body.published.version, 243);
    assert.deepEqual(body.published.content, CONTENT);
    assert.equal(body.history.count, 1);
    assert.equal(body.history.latest.note, 'seed');

    assert.equal(body.working.source, 'draft');
    assert.equal(body.working.revision_id, REV);
    assert.equal(body.working.base_version, 243);
    assert.equal(body.working.content.hero.big, 'مسودة جديدة');

    assert.ok(Array.isArray(body.schema.groups));
    assert.ok(body.schema.groups.length > 0);
    assert.ok(Array.isArray(body.schema.linkTokens));
    assert.ok(Array.isArray(body.schema.linkAnchors));

    assert.equal(JSON.stringify(body).includes('admin_users'), false);
    assert.equal(JSON.stringify(body).includes('service_role'), false);
    assert.equal(JSON.stringify(body).includes('saved_by'), false);
    assert.equal(JSON.stringify(body).includes('purge'), false);

    assert.equal(calls.length, 5);
    const userCall = calls.find((call) => call.url.includes('/auth/v1/user'));
    const adminCall = calls.find((call) => call.url.includes('/rpc/is_admin'));
    const publishedCall = calls.find((call) => call.url.includes('/published_content'));
    const draftCall = calls.find((call) => call.url.includes('/rest/v1/draft'));
    const historyCall = calls.find((call) => call.url.includes('/content_history'));
    for (const call of [userCall, adminCall, publishedCall, draftCall, historyCall]) {
      assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(call.init.headers.apikey, ANON);
    }
    assert.equal(adminCall.init.method, 'POST');
    assert.equal(adminCall.init.body, '{}');
    assert.match(publishedCall.url, /select=version%2Ccontent%2Csaved_at/);
    assert.match(draftCall.url, /select=content%2Crevision_id%2Cbase_version%2Cupdated_at/);
    assert.match(historyCall.url, /order=version.desc/);
  } finally {
    restore();
  }
});

test('bootstrap falls back to published content when no draft exists', async () => {
  configure();
  installFetch(adminRoutes({ draft: reply([]) }));

  try {
    const body = JSON.parse((await handler(adminEvent('/api/admin/bootstrap'))).body);
    assert.equal(body.working.source, 'published');
    assert.equal(body.working.revision_id, null);
    assert.equal(body.working.base_version, 243);
    assert.equal(body.working.content.hero.big, 'مرحبا');
  } finally {
    restore();
  }
});

test('admin history returns sanitized metadata only', async () => {
  configure();
  const longNote = 'x'.repeat(700);
  const calls = installFetch(adminRoutes({
    history: reply([
      { id: 1, version: 243, note: longNote, created_at: '2026-11-06T23:37:22Z' },
      { id: 2, version: 242, note: null, created_at: '2026-11-05T10:00:00Z' },
      { id: 3, version: -1, note: 'bad', created_at: '2026-11-05T10:00:00Z' },
      { id: 4, version: 241, note: 'bad-date', created_at: 42 },
      { id: 0, version: 240, note: 'bad-id', created_at: '2026-11-05T10:00:00Z' },
    ]),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/history'));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.count, 2);
    assert.equal(body.entries.length, 2);
    assert.equal(body.entries[0].note.length, 500);
    assert.equal(body.entries[1].note, null);
    assert.equal(body.entries[0].content, undefined);
    assert.equal(calls.length, 3);
    assert.equal(calls.some((call) => call.url.includes('/published_content')), false);
  } finally {
    restore();
  }
});

test('draft save normalizes content and forwards expected version and revision', async () => {
  configure();
  const calls = installFetch(adminRoutes({ draft: reply([DRAFT_ROW]) }));

  try {
    const content = {
      hero: { big: 'نص جديد', unknownKey: 'ignored' },
      unknownGroup: { x: 1 },
    };
    const result = await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody({
      expected_revision: REV,
      content,
    })));

    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.deepEqual(body, {
      revision_id: NEW_REV,
      base_version: 243,
      updated_at: '2026-11-07T10:00:00+00:00',
    });

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_save_draft'));
    assert.equal(rpc.init.method, 'POST');
    assert.equal(rpc.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(rpc.init.headers.apikey, ANON);
    const sent = JSON.parse(rpc.init.body);
    assert.equal(sent.p_expected_version, 243);
    assert.equal(sent.p_expected_revision, REV);
    assert.equal(sent.p_content.hero.big, 'نص جديد');
    assert.equal(sent.p_content.hero.unknownKey, undefined);
    assert.equal(sent.p_content.unknownGroup, undefined);
    assert.equal(typeof sent.p_content.contact.name, 'string');
    assert.equal(typeof sent.p_content.layout.order, 'object');
  } finally {
    restore();
  }
});

test('draft save reports conflicts as 409 and auth failures correctly', async () => {
  configure();

  try {
    installFetch(adminRoutes({ save: reply({ code: '40001', message: 'stale draft revision' }, 400) }));
    const conflict = await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()));
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(JSON.parse(conflict.body), { error: 'conflict' });
    assertPrivateHeaders(conflict);

    installFetch(adminRoutes({ save: reply({ code: 'PT409', message: 'stale draft revision' }, 400) }));
    assert.equal((await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()))).statusCode, 409);

    installFetch(adminRoutes({ save: reply({ code: '42501', message: 'admin only' }, 403) }));
    assert.equal((await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()))).statusCode, 403);

    installFetch(adminRoutes({ save: reply({ code: '28000', message: 'auth' }, 401) }));
    assert.equal((await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()))).statusCode, 401);

    installFetch(adminRoutes({ save: reply({ code: '22023', message: 'invalid content' }, 400) }));
    const invalid = await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()));
    assert.equal(invalid.statusCode, 422);
    assert.deepEqual(JSON.parse(invalid.body), { error: 'invalid_content' });

    installFetch(adminRoutes({ save: reply({}, 500) }));
    assert.equal((await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()))).statusCode, 502);
  } finally {
    restore();
  }
});

test('draft save rejects malformed and oversized bodies before writing', async () => {
  configure();
  const calls = installFetch([
    { match: '/auth/v1/user', reply: reply({ id: USER_ID, email: 'admin@example.com' }) },
    { match: '/rest/v1/rpc/is_admin', reply: reply(true) },
  ]);

  try {
    for (const body of [
      undefined,
      'not json',
      '[]',
      { expected_version: 0, expected_revision: null, content: {} },
      { expected_version: 1, expected_revision: 'not-a-uuid', content: {} },
      { expected_version: 1, expected_revision: null, content: 'text' },
    ]) {
      const result = await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, body));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
    }
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_save_draft')), false);

    const tooLarge = await handler(adminEvent('/api/admin/draft', 'POST', TOKEN, 'x'.repeat(2 * 1024 * 1024 + 1)));
    assert.equal(tooLarge.statusCode, 413);
    assert.deepEqual(JSON.parse(tooLarge.body), { error: 'payload_too_large' });
  } finally {
    restore();
  }
});

test('draft delete forwards revision and returns the deletion result', async () => {
  configure();
  const calls = installFetch(adminRoutes({ draft: reply([DRAFT_ROW]) }));

  try {
    const result = await handler(adminEvent('/api/admin/draft/delete', 'POST', TOKEN, {
      expected_version: 243,
      expected_revision: REV,
    }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { deleted: true });

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_delete_draft'));
    assert.equal(rpc.init.method, 'POST');
    const sent = JSON.parse(rpc.init.body);
    assert.equal(sent.p_expected_version, 243);
    assert.equal(sent.p_expected_revision, REV);

    installFetch(adminRoutes({
      remove: reply({ code: '40001', message: 'stale' }, 409),
    }));
    assert.equal((await handler(adminEvent('/api/admin/draft/delete', 'POST', TOKEN, {
      expected_version: 243,
      expected_revision: REV,
    }))).statusCode, 409);
  } finally {
    restore();
  }
});

test('preview uses the draft, strips scripts and tracking, and never includes the token', async () => {
  configure();
  installFetch(adminRoutes({ draft: reply([DRAFT_ROW]) }));

  try {
    const result = await handler(adminEvent('/api/admin/preview'));
    assert.equal(result.statusCode, 200);
    assert.match(result.headers['Content-Type'], /^text\/html/);
    assertPrivateHeaders(result);
    assert.equal(result.headers['X-CCafe-Preview-Source'], 'draft');
    assert.equal(result.headers['X-CCafe-Preview-Version'], '243');

    const html = result.body;
    assert.match(html, /مسودة جديدة/);
    assert.doesNotMatch(html, /مرحبا/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /http-equiv="Content-Security-Policy"/);
    assert.doesNotMatch(html, /<script\b/i);
    assert.doesNotMatch(html, /track\.js/);
    assert.doesNotMatch(html, /styles\.css/);
    assert.match(html, /<style>/);
    assert.match(html, /src="\/assets\//);
    assert.equal(html.includes(TOKEN), false);
    assert.equal(html.includes(ANON), false);
    assert.equal(html.includes('service_role'), false);
  } finally {
    restore();
  }
});

test('preview falls back to published content when there is no draft', async () => {
  configure();
  installFetch(adminRoutes({ draft: reply([]) }));

  try {
    const result = await handler(adminEvent('/api/admin/preview'));
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['X-CCafe-Preview-Source'], 'published');
    assert.match(result.body, /مرحبا/);
    assert.doesNotMatch(result.body, /مسودة جديدة/);
  } finally {
    restore();
  }
});

test('HEAD returns headers without a body', async () => {
  configure();
  installFetch(adminRoutes({ draft: reply([DRAFT_ROW]) }));

  try {
    for (const path of ['/api/admin/bootstrap', '/api/admin/history', '/api/admin/preview']) {
      const result = await handler(adminEvent(path, 'HEAD'));
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, '');
      assertPrivateHeaders(result);
    }
  } finally {
    restore();
  }
});

test('unknown admin routes are 404 and operation routes enforce methods', async () => {
  configure();
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  try {
    for (const path of [
      '/api/admin/',
      '/api/admin/settings',
      '/api/admin/bootstrap/extra',
      '/api/admin/publish/extra',
    ]) {
      for (const method of ['GET', 'POST']) {
        const result = await handler(adminEvent(path, method));
        assert.equal(result.statusCode, 404);
      }
    }

    for (const path of ['/api/admin/publish', '/api/admin/restore']) {
      for (const method of ['GET', 'HEAD']) {
        const result = await handler(adminEvent(path, method));
        assert.equal(result.statusCode, 405);
        assert.equal(result.headers.Allow, 'POST');
      }
    }
    for (const method of ['POST', 'PUT']) {
      const result = await handler(adminEvent('/api/admin/verify', method));
      assert.equal(result.statusCode, 405);
      assert.equal(result.headers.Allow, 'GET, HEAD');
    }
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('publish forwards the draft revision and operation id and never sends client content', async () => {
  configure();
  const op = NEW_REV;
  const calls = installFetch(adminRoutes({
    publishRpc: reply({
      version: 244,
      saved_at: '2026-11-08T12:00:00+00:00',
      operation_id: op,
      source: 'draft',
      purge_state: 'pending',
      public_check_state: 'pending',
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: op,
      note: '  نشر تجريبي  ',
      content: { hero: { big: 'مرفوض' } },
    }));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    assert.deepEqual(JSON.parse(result.body), {
      version: 244,
      saved_at: '2026-11-08T12:00:00+00:00',
      operation_id: op,
      source: 'draft',
      purge_state: 'pending',
      public_check_state: 'pending',
    });

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_publish'));
    const sent = JSON.parse(rpc.init.body);
    assert.equal(sent.p_expected_version, 243);
    assert.equal(sent.p_expected_draft_revision, REV);
    assert.equal(sent.p_operation_id, op);
    assert.equal(sent.p_note, 'نشر تجريبي');
    assert.equal(sent.p_content, null);
    assert.equal(rpc.init.headers.Authorization, `Bearer ${TOKEN}`);

    const begin = calls.find((call) => call.url.includes('/rpc/admin_media_publish_begin'));
    const begun = JSON.parse(begin.init.body);
    assert.equal(begun.p_expected_version, 243);
    assert.equal(begun.p_expected_draft_revision, REV);
    assert.equal(begun.p_operation_id, op);
    assert.equal(begun.p_note, 'نشر تجريبي');
    assert.ok(calls.indexOf(begin) < calls.indexOf(rpc), 'preflight must run before admin_publish');
  } finally {
    restore();
  }
});

test('publish validates its body and maps database conflicts', async () => {
  configure();
  try {
    installFetch([
      { match: '/auth/v1/user', reply: reply({ id: USER_ID, email: 'admin@example.com' }) },
      { match: '/rest/v1/rpc/is_admin', reply: reply(true) },
    ]);

    for (const body of [
      {},
      { expected_version: 0, expected_draft_revision: REV, operation_id: NEW_REV },
      { expected_version: 243, expected_draft_revision: null, operation_id: NEW_REV },
      { expected_version: 243, expected_draft_revision: REV, operation_id: 'not-a-uuid' },
      { expected_version: 243, expected_draft_revision: REV, operation_id: NEW_REV, note: 'x'.repeat(201) },
    ]) {
      const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, body));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
    }

    installFetch(adminRoutes({
      publishRpc: reply({ code: 'PT409', message: 'stale draft revision' }, 400),
    }));
    const conflict = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
    }));
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(JSON.parse(conflict.body), { error: 'conflict' });

    installFetch(adminRoutes({
      publishRpc: reply({ version: 244, saved_at: 'x', operation_id: NEW_REV, source: 'content' }),
    }));
    const invalidShape = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
    }));
    assert.equal(invalidShape.statusCode, 502);
  } finally {
    restore();
  }
});

test('restore forwards the history id and expected version', async () => {
  configure();
  const calls = installFetch(adminRoutes({
    restoreRpc: reply({
      version: 245,
      saved_at: '2026-11-08T12:30:00+00:00',
      operation_id: NEW_REV,
      source: 'restore',
      restored_from: 3,
      purge_state: 'pending',
      public_check_state: 'pending',
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/restore', 'POST', TOKEN, {
      history_id: 3,
      expected_version: 244,
      operation_id: NEW_REV,
      note: 'استعادة',
    }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.version, 245);
    assert.equal(body.source, 'restore');
    assert.equal(body.restored_from, 3);

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_restore'));
    const sent = JSON.parse(rpc.init.body);
    assert.equal(sent.p_history_id, 3);
    assert.equal(sent.p_expected_version, 244);
    assert.equal(sent.p_operation_id, NEW_REV);
    assert.equal(sent.p_note, 'استعادة');
  } finally {
    restore();
  }
});

test('verify accepts only the configured preview origin and the live version marker', async () => {
  configure();
  process.env.DEPLOY_PRIME_URL = 'https://abc123--c-cafe-preview.netlify.app';
  const calls = installFetch(adminRoutes({
    beginCheck: reply(17),
    finishCheck: reply(true),
    site: htmlReply(200, '<html><head><meta name="ccafe-content-version" content="244"></head></html>', {
      'X-CCafe-Source': 'live',
      'X-CCafe-Version': '244',
    }),
  }));

  try {
    const event = adminEvent('/api/admin/verify');
    event.queryStringParameters = { version: '244', url: 'https://evil.example/' };
    const result = await handler(event);
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.equal(body.state, 'matched');
    assert.equal(body.applied, true);
    assert.equal(body.observed_version, 244);
    assert.equal(body.source, 'live');

    const siteCall = calls.find((call) => call.url.includes('c-cafe-preview.netlify.app'));
    assert.match(siteCall.url, /^https:\/\/abc123--c-cafe-preview\.netlify\.app\/\?_ccafe_verify=/);
    assert.equal(siteCall.url.includes('evil.example'), false);

    const finish = calls.find((call) => call.url.includes('/rpc/admin_finish_public_check'));
    const sent = JSON.parse(finish.init.body);
    assert.equal(sent.p_check_id, 17);
    assert.equal(sent.p_state, 'matched');
    assert.equal(sent.p_observed_version, 244);
  } finally {
    restore();
  }
});

test('verify never treats a fallback page as proof and rejects unsupported origins', async () => {
  configure();
  process.env.CCAFE_VERIFY_ORIGIN = 'https://c-cafe-preview.netlify.app';
  installFetch(adminRoutes({
    beginCheck: reply(18),
    finishCheck: reply(true),
    site: htmlReply(200, '<html><head><meta name="ccafe-content-version" content="244"></head></html>', {
      'X-CCafe-Source': 'fallback',
      'X-CCafe-Version': '244',
    }),
  }));

  try {
    const event = adminEvent('/api/admin/verify');
    event.queryStringParameters = { version: '244' };
    const body = JSON.parse((await handler(event)).body);
    assert.equal(body.state, 'mismatch');
    assert.equal(body.detail, 'fallback_snapshot');
    assert.equal(body.applied, true);
  } finally {
    restore();
  }

  configure();
  process.env.CCAFE_VERIFY_ORIGIN = 'https://evil.example';
  let fetched = false;
  global.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) return reply({ id: USER_ID, email: 'admin@example.com' });
    if (String(url).includes('/rpc/is_admin')) return reply(true);
    fetched = true;
    throw new Error('must not fetch');
  };
  try {
    const event = adminEvent('/api/admin/verify');
    event.queryStringParameters = { version: '244' };
    event.headers.host = 'evil.example';
    assert.equal((await handler(event)).statusCode, 503);
    assert.equal(fetched, false);
  } finally {
    restore();
  }
});

test('verify reports superseded when a newer check wins', async () => {
  configure();
  process.env.CCAFE_VERIFY_ORIGIN = 'https://c-cafe-preview.netlify.app';
  installFetch(adminRoutes({
    beginCheck: reply(19),
    finishCheck: reply(false),
    site: htmlReply(200, '<html><head><meta name="ccafe-content-version" content="244"></head></html>', {
      'X-CCafe-Source': 'live',
      'X-CCafe-Version': '244',
    }),
  }));

  try {
    const event = adminEvent('/api/admin/verify');
    event.queryStringParameters = { version: '244' };
    const body = JSON.parse((await handler(event)).body);
    assert.equal(body.state, 'superseded');
    assert.equal(body.applied, false);
  } finally {
    restore();
  }
});

test('site status read returns admin-only fields through the RPC with the user JWT', async () => {
  configure();
  const value = {
    state: 'running',
    message: '',
    revision: 1,
    updated_at: '2026-11-26T12:00:00+00:00',
    changed_by: { id: USER_ID, email: 'admin@example.com' },
  };
  const calls = installFetch(adminRoutes({ siteStatus: reply(value) }));

  try {
    const result = await handler(adminEvent('/api/admin/site-status'));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.equal(body.state, 'running');
    assert.equal(body.message, '');
    assert.equal(body.revision, 1);
    assert.equal(body.updated_at, value.updated_at);
    assert.deepEqual(body.changed_by, value.changed_by);
    assert.ok(typeof body.server_time === 'string');

    const head = await handler(adminEvent('/api/admin/site-status', 'HEAD'));
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');

    const rpcCalls = calls.filter((call) => call.url.includes('/rest/v1/rpc/admin_site_status'));
    assert.equal(rpcCalls.length, 2);
    assert.deepEqual(JSON.parse(rpcCalls[0].init.body), {});
    assert.equal(rpcCalls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(rpcCalls[0].init.headers.apikey, ANON);
  } finally {
    restore();
  }
});

test('admin APIs remain available while the public site state is stopped', async () => {
  configure();
  const stopped = {
    state: 'stopped',
    message: 'صيانة',
    revision: 2,
    updated_at: '2026-11-26T12:10:00+00:00',
    changed_by: { id: USER_ID, email: 'admin@example.com' },
  };
  const restarted = {
    state: 'running',
    message: '',
    revision: 3,
    updated_at: '2026-11-26T12:15:00+00:00',
    changed_by: { id: USER_ID, email: 'admin@example.com' },
    operation_id: OPERATION_ID,
    idempotent: false,
  };
  const calls = installFetch(adminRoutes({
    draft: reply([DRAFT_ROW]),
    siteStatus: reply(stopped),
    siteStatusSet: reply(restarted),
  }));

  try {
    for (const path of ['/api/admin/bootstrap', '/api/admin/history', '/api/admin/preview', '/api/admin/site-status']) {
      const result = await handler(adminEvent(path));
      assert.equal(result.statusCode, 200, path);
      assertPrivateHeaders(result);
    }

    const read = JSON.parse((await handler(adminEvent('/api/admin/site-status'))).body);
    assert.equal(read.state, 'stopped');
    assert.equal(read.message, 'صيانة');
    assert.equal(read.revision, 2);

    const write = await handler(adminEvent('/api/admin/site-status', 'POST', TOKEN, {
      state: 'running',
      message: '',
      expected_revision: 2,
      operation_id: OPERATION_ID,
    }));
    assert.equal(write.statusCode, 200);
    assert.equal(JSON.parse(write.body).state, 'running');

    assert.equal(calls.some((call) => call.url.includes('/rest/v1/public_site_status')), false);
    assert.equal(calls.some((call) => call.url.includes('c-cafe-preview.netlify.app')), false);
  } finally {
    restore();
  }
});

test('site status write forwards the validated request and accepts an idempotent replay', async () => {
  configure();
  const request = {
    state: 'stopped',
    message: 'نعمل على الصيانة',
    expected_revision: 1,
    operation_id: OPERATION_ID,
  };
  const stored = {
    state: 'stopped',
    message: request.message,
    revision: 2,
    updated_at: '2026-11-26T12:05:00+00:00',
    changed_by: { id: USER_ID, email: 'admin@example.com' },
    operation_id: OPERATION_ID,
    idempotent: false,
  };
  let writes = 0;
  const calls = installFetch(adminRoutes({
    siteStatusSet(url, init) {
      writes += 1;
      assert.equal(writes <= 2, true);
      return reply(writes === 1 ? stored : { ...stored, idempotent: true });
    },
  }));

  try {
    for (const idempotent of [false, true]) {
      const result = await handler(adminEvent('/api/admin/site-status', 'POST', TOKEN, request));
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.state, 'stopped');
      assert.equal(body.message, request.message);
      assert.equal(body.revision, 2);
      assert.equal(body.operation_id, OPERATION_ID);
      assert.equal(body.idempotent, idempotent);
    }
    assert.equal(writes, 2);

    const sent = JSON.parse(calls.find((call) => call.url.includes('/rpc/admin_set_site_status')).init.body);
    assert.deepEqual(sent, {
      p_state: 'stopped',
      p_message: 'نعمل على الصيانة',
      p_expected_revision: 1,
      p_operation_id: OPERATION_ID,
    });
  } finally {
    restore();
  }
});

test('site status write rejects unsafe requests before calling the write RPC', async () => {
  configure();
  let writes = 0;
  const calls = installFetch(adminRoutes({
    siteStatusSet() {
      writes += 1;
      throw new Error('write RPC must not be called');
    },
  }));

  const invalid = [
    {},
    { state: 'paused', message: '', expected_revision: 1, operation_id: OPERATION_ID },
    { state: 'running', message: 'يجب ألا تظهر', expected_revision: 1, operation_id: OPERATION_ID },
    { state: 'stopped', message: 'x'.repeat(301), expected_revision: 1, operation_id: OPERATION_ID },
    { state: 'stopped', message: 7, expected_revision: 1, operation_id: OPERATION_ID },
    { state: 'stopped', message: '', expected_revision: 0, operation_id: OPERATION_ID },
    { state: 'stopped', message: '', expected_revision: 1.5, operation_id: OPERATION_ID },
    { state: 'stopped', message: '', expected_revision: 1, operation_id: 'not-a-uuid' },
  ];

  try {
    for (const body of invalid) {
      const result = await handler(adminEvent('/api/admin/site-status', 'POST', TOKEN, body));
      assert.equal(result.statusCode, 422);
      assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
    }
    const huge = await handler(adminEvent('/api/admin/site-status', 'POST', TOKEN, 'x'.repeat(2 * 1024 * 1024 + 1)));
    assert.equal(huge.statusCode, 413);
    assert.equal(writes, 0);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_set_site_status')), false);
  } finally {
    restore();
  }
});

test('site status write maps auth, conflict, validation, and upstream failures', async () => {
  configure();
  const request = {
    state: 'stopped',
    message: '',
    expected_revision: 1,
    operation_id: OPERATION_ID,
  };
  const cases = [
    [reply({ code: '28000' }, 401), 401],
    [reply({ code: '42501' }, 403), 403],
    [reply({ code: 'PT409', message: 'stale site status revision' }, 400), 409],
    [reply({ code: '22023', message: 'invalid site state' }, 400), 422],
    [reply({}, 500), 502],
  ];

  try {
    for (const [siteStatusSet, expected] of cases) {
      installFetch(adminRoutes({ siteStatusSet }));
      const result = await handler(adminEvent('/api/admin/site-status', 'POST', TOKEN, request));
      assert.equal(result.statusCode, expected);
    }

    installFetch(adminRoutes({ siteStatus: reply({ state: 'running' }) }));
    assert.equal((await handler(adminEvent('/api/admin/site-status'))).statusCode, 502);
  } finally {
    restore();
  }
});

test('verify never treats a stop page or an indeterminate state as published-content proof', async () => {
  configure();
  process.env.CCAFE_VERIFY_ORIGIN = 'https://c-cafe-preview.netlify.app';

  const pages = [
    [htmlReply(503, '<html><head><meta name="ccafe-site-state" content="stopped"></head></html>', {}), 'site_stopped', 'stopped'],
    [htmlReply(503, '', { 'X-CCafe-Site-State': 'unknown' }), 'site_state_unknown', 'unknown'],
  ];

  try {
    for (const [site, detail, siteState] of pages) {
      const calls = installFetch(adminRoutes({
        beginCheck: reply(17),
        finishCheck: reply(true),
        site,
      }));
      const event = adminEvent('/api/admin/verify');
      event.queryStringParameters = { version: '244' };
      const result = await handler(event);
      assert.equal(result.statusCode, 200);
      const body = JSON.parse(result.body);
      assert.equal(body.state, 'mismatch');
      assert.equal(body.applied, true);
      assert.equal(body.detail, detail);
      assert.equal(body.site_state, siteState);
      assert.equal(body.observed_version, null);

      const finish = JSON.parse(calls.find((call) => call.url.includes('/rpc/admin_finish_public_check')).init.body);
      assert.equal(finish.p_state, 'mismatch');
      assert.equal(finish.p_detail, detail);
      assert.equal(finish.p_observed_version, null);
    }
  } finally {
    restore();
  }
});

test('missing configuration fails closed without network access', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  try {
    const result = await handler(adminEvent('/api/admin/bootstrap'));
    assert.equal(result.statusCode, 500);
    assert.deepEqual(JSON.parse(result.body), { error: 'server_misconfigured' });
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('upstream failures fail closed', async () => {
  configure();

  try {
    installFetch([{ match: '/auth/v1/user', reply: reply({}, 500) }]);
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ admin: reply({}, 500) }));
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ published: reply({}, 500) }));
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ published: reply([{ version: 0, content: {}, saved_at: 'x' }]) }));
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ draft: reply({}, 500) }));
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ draft: reply([{ content: {}, revision_id: 'bad', base_version: 1, updated_at: 'x' }]) }));
    assert.equal((await handler(adminEvent('/api/admin/bootstrap'))).statusCode, 502);

    installFetch(adminRoutes({ history: reply({ rows: [] }) }));
    assert.equal((await handler(adminEvent('/api/admin/history'))).statusCode, 502);
  } finally {
    restore();
  }
});

test('timeouts are reported as upstream failures', async () => {
  configure();
  process.env.CCAFE_SUPABASE_TIMEOUT_MS = '20';
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  try {
    const result = await handler(adminEvent('/api/admin/bootstrap'));
    assert.equal(result.statusCode, 502);
  } finally {
    restore();
  }
});

test('verifyOrigin only accepts allowlisted preview hosts from server-side signals', () => {
  configure();
  try {
    assert.equal(
      _internal.verifyOrigin({ headers: { host: '6af056fe25b8fdb26f4dab06--c-cafe-preview.netlify.app' } }),
      'https://6af056fe25b8fdb26f4dab06--c-cafe-preview.netlify.app',
    );
    assert.equal(
      _internal.verifyOrigin({ headers: { host: 'c-cafe-preview.netlify.app' } }),
      'https://c-cafe-preview.netlify.app',
    );
    assert.equal(
      _internal.verifyOrigin({ headers: { host: 'c-cafe-preview.netlify.app.evil.example' } }),
      null,
    );
    assert.equal(_internal.verifyOrigin({ headers: { host: 'evil.example' } }), null);
    assert.equal(_internal.verifyOrigin({ headers: {} }), null);

    process.env.CCAFE_VERIFY_ORIGIN = 'http://c-cafe-preview.netlify.app';
    assert.equal(
      _internal.verifyOrigin({ headers: { host: 'c-cafe-preview.netlify.app' } }),
      'https://c-cafe-preview.netlify.app',
    );
  } finally {
    restore();
  }
});

test('helper validators reject unsafe input and preview paths are rewritten', () => {
  assert.equal(_internal.normalizePath('/api/admin/bootstrap/'), '/api/admin/bootstrap');
  assert.equal(_internal.normalizePath('/api/admin//history//'), '/api/admin//history');
  assert.equal(_internal.bearerToken({ headers: { AUTHORIZATION: `Bearer ${TOKEN}` } }), TOKEN);
  assert.equal(_internal.bearerToken({ headers: { Authorization: 'Bearer token with spaces' } }), '');
  assert.equal(_internal.bearerToken({ headers: {} }), '');

  const body = _internal.parseDraftBody(adminEvent('/api/admin/draft', 'POST', TOKEN, saveBody()));
  assert.equal(body.ok, true);
  assert.equal(body.value.expected_version, 243);

  const html = _internal.buildPreviewHtml(require('../lib/default-content'));
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /src="\/assets\//);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
});

// ---------------------------------------------------------------------------
// Private media library (upload, verify, approve, select, preview)
// ---------------------------------------------------------------------------

test('media library lists only sanitized assets with short-lived preview URLs', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({
    mediaList: reply([
      mediaRow(),
      mediaRow({
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        logical_path: 'media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        status: 'pending',
        mime: null,
        bytes: null,
        width: null,
        height: null,
        finalized_at: null,
      }),
    ]),
    mediaSign: mediaSignReply(),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media'));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);

    assert.equal(body.assets.length, 2);
    assert.equal(body.assets[0].selectable, true);
    assert.equal(body.assets[0].logical_path, ASSET_PATH);
    assert.equal(body.assets[1].selectable, false);
    assert.equal(body.assets[1].status, 'pending');
    assert.equal(body.originals.length, 15);
    assert.deepEqual(Object.keys(body.urls), [ASSET_PATH]);
    assert.match(body.urls[ASSET_PATH], /^https:\/\/example\.supabase\.co\/storage\/v1\/object\/sign\/ccafe-media\//);
    assert.equal(body.media_enabled, true);
    assert.equal(body.limits.max_bytes, 15 * 1024 * 1024);
    assert.equal(body.limits.max_dimension, 8000);
    assert.equal(body.limits.max_pixels, 32000000);
    assert.deepEqual(body.limits.mime_types, ['image/png', 'image/jpeg', 'image/webp']);

    const text = JSON.stringify(body);
    assert.equal(text.includes('service_role'), false);
    assert.equal(text.includes(FINALIZE_TOKEN), false);

    const sign = calls.find((call) => call.url.includes('/storage/v1/object/sign/'));
    assert.deepEqual(JSON.parse(sign.init.body), { expiresIn: 300 });
  } finally {
    restore();
  }
});

test('preview resolves approved media refs to short-lived signed URLs', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const draftRow = {
    content: { hero: { big: 'مسودة جديدة', mark: ASSET_PATH } },
    revision_id: REV,
    base_version: 243,
    updated_at: '2026-11-07T10:00:00+00:00',
  };
  const calls = installFetch(adminRoutes({
    draft: reply([draftRow]),
    mediaApproved: reply([{ id: ASSET_ID, logical_path: ASSET_PATH }]),
    mediaSign: mediaSignReply(),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/preview'));
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /https:\/\/example\.supabase\.co\/storage\/v1\/object\/sign\/ccafe-media\//);
    assert.doesNotMatch(result.body, new RegExp(`src="${ASSET_PATH}"`));

    const query = calls.find((call) => call.url.includes('logical_path='));
    assert.ok(query, 'preview must filter approved media by logical path');
    // The filter is encoded exactly once by URLSearchParams; a double-encoded
    // slash (media%252F...) would never match and the preview would lose the image.
    assert.equal(query.url.includes('media%252F'), false);
    assert.match(decodeURIComponent(query.url), /logical_path=in\.\("media\/[0-9a-f-]{36}"\)/);
  } finally {
    restore();
  }
});

test('media create returns a server-generated pending path and rejects client URLs', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({
    mediaCreate: reply({
      id: ASSET_ID,
      logical_path: ASSET_PATH,
      storage_path: ASSET_PATH,
      bucket: 'ccafe-media',
      status: 'pending',
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media', 'POST', TOKEN, {
      original_name: '  صورة جديدة.png  ',
      declared_mime: 'image/png',
      declared_bytes: 2048,
      url: 'https://evil.example/payload.png',
      path: 'media/../../etc/passwd',
    }));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.deepEqual(body.asset, {
      id: ASSET_ID,
      logical_path: ASSET_PATH,
      status: 'pending',
      original_name: 'صورة جديدة.png',
      selectable: false,
    });
    assert.equal(body.upload.bucket, 'ccafe-media');
    assert.equal(body.upload.path, ASSET_PATH);
    assert.equal(
      body.upload.url,
      `https://example.supabase.co/storage/v1/object/ccafe-media/${ASSET_PATH}`,
    );
    assert.equal(JSON.stringify(body).includes('evil.example'), false);

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_media_create'));
    assert.deepEqual(JSON.parse(rpc.init.body), {
      p_original_name: 'صورة جديدة.png',
      p_declared_mime: 'image/png',
      p_declared_bytes: 2048,
    });
  } finally {
    restore();
  }
});

test('media create rejects unsupported types, empty names, and oversized declarations', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({}));

  try {
    const base = { original_name: 'x.png', declared_mime: 'image/png', declared_bytes: 100 };
    const cases = [
      { ...base, declared_mime: 'image/svg+xml' },
      { ...base, declared_mime: 'image/gif' },
      { ...base, original_name: '   ' },
      { ...base, original_name: 'a'.repeat(121) },
      { ...base, declared_bytes: 0 },
      { ...base, declared_bytes: 15 * 1024 * 1024 + 1 },
    ];
    for (const payload of cases) {
      const result = await handler(adminEvent('/api/admin/media', 'POST', TOKEN, payload));
      assert.equal(result.statusCode, 400, JSON.stringify(payload));
      assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
    }
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_create')), false);
  } finally {
    restore();
  }
});

test('finalize verifies real bytes, binds the server token, and only then approves', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const png = await samplePng();
  const calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({
      status: 'pending',
      mime: null,
      bytes: null,
      width: null,
      height: null,
      finalized_at: null,
      declared_mime: 'image/png',
      declared_bytes: png.length,
    })]),
    mediaObject: binaryReply(200, png, { 'content-length': String(png.length) }),
    mediaFinalize: reply({
      id: ASSET_ID,
      logical_path: ASSET_PATH,
      status: 'approved',
      mime: 'image/png',
      bytes: png.length,
      width: 2,
      height: 2,
      finalized_at: '2026-11-09T10:01:00+00:00',
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.status, 'approved');
    assert.equal(body.asset.selectable, true);
    assert.equal(body.asset.mime, 'image/png');
    assert.equal(body.asset.bytes, png.length);
    assert.equal(body.idempotent, false);

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_media_finalize'));
    const sent = JSON.parse(rpc.init.body);
    assert.equal(sent.p_asset_id, ASSET_ID);
    assert.equal(sent.p_token, FINALIZE_TOKEN);
    assert.equal(sent.p_token_sha256, undefined);
    assert.equal(sent.p_mime, 'image/png');
    assert.equal(sent.p_bytes, png.length);
    assert.equal(sent.p_width, 2);
    assert.equal(sent.p_height, 2);
    assert.equal(sent.p_pixel_count, 4);
    assert.match(sent.p_sha256, /^[0-9a-f]{64}$/);

    const download = calls.find((call) => call.url.includes('/storage/v1/object/ccafe-media/'));
    assert.match(download.url, new RegExp(`/object/ccafe-media/${ASSET_PATH}$`));
    assert.equal(download.init.headers.Authorization, `Bearer ${TOKEN}`);

    const begin = calls.find((call) => call.url.includes('/rpc/admin_media_begin_finalize'));
    assert.ok(begin, 'finalize must claim the row before reading bytes');
    assert.deepEqual(JSON.parse(begin.init.body), { p_asset_id: ASSET_ID });
    assert.ok(
      calls.indexOf(begin) < calls.indexOf(download),
      'the verification claim must be acquired before the object download',
    );
  } finally {
    restore();
  }
});

test('finalize resolves a claim conflict without reading bytes twice', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  let reads = 0;
  const assetRoute = {
    match: 'id=eq.',
    get reply() {
      reads += 1;
      if (reads === 1) {
        return reply([mediaRow({
          status: 'pending',
          mime: null,
          bytes: null,
          width: null,
          height: null,
          finalized_at: null,
        })]);
      }
      return reply([mediaRow()]);
    },
  };
  const calls = installFetch([
    ...adminRoutes({ mediaBegin: reply({ code: 'PT409', message: 'already approved' }, 409) })
      .filter((route) => route.match !== 'id=eq.'),
    assetRoute,
  ]);

  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).idempotent, true);
    assert.equal(reads, 2, 'the server re-reads the asset after losing the claim');
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/object/ccafe-media/')), false);
  } finally {
    restore();
  }
});

test('finalize refuses to read bytes when the claim is rejected', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({ status: 'pending', mime: null, bytes: null, width: null, height: null, finalized_at: null })]),
    mediaBegin: reply({ code: 'PT409', message: 'still pending' }, 409),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'conflict' });
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/object/ccafe-media/')), false);
  } finally {
    restore();
  }
});

test('finalize is idempotent for an already approved asset and never re-verifies', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({ mediaAsset: reply([mediaRow()]) }));

  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.status, 'approved');
    assert.equal(body.idempotent, true);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_finalize')), false);
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/')), false);
  } finally {
    restore();
  }
});

test('finalize refuses another admin asset, non-uuid ids, and unconfigured servers', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  let calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({
      created_by: '44444444-4444-4444-8444-444444444444',
      status: 'pending',
      finalized_at: null,
    })]),
  }));
  try {
    const other = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(other.statusCode, 403);
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/')), false);

    const bad = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: '../x' }));
    assert.equal(bad.statusCode, 400);
  } finally {
    restore();
  }

  configure();
  delete process.env.CCAFE_MEDIA_FINALIZE_TOKEN;
  calls = installFetch(adminRoutes({}));
  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 503);
    assert.deepEqual(JSON.parse(result.body), { error: 'media_unavailable' });
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_finalize')), false);
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/')), false);
  } finally {
    restore();
  }
});

test('finalize rejects corrupt bytes and declared MIME mismatches without approving', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;

  // Corrupt payload: real bytes that sharp cannot decode.
  let calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({
      status: 'pending', mime: null, bytes: null, width: null, height: null,
      finalized_at: null, declared_mime: 'image/png', declared_bytes: 11,
    })]),
    mediaObject: binaryReply(200, Buffer.from('not-an-image'), { 'content-length': '12' }),
    mediaFail: reply(true),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), { error: 'invalid_image', reason: 'decode_failed' });
    const fail = calls.find((call) => call.url.includes('/rpc/admin_media_fail'));
    assert.deepEqual(JSON.parse(fail.init.body), { p_asset_id: ASSET_ID, p_reason: 'decode_failed' });
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_finalize')), false);
  } finally {
    restore();
  }

  // Valid PNG but the row declared JPEG: MIME is derived from content, not input.
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const png = await samplePng();
  installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({
      status: 'pending', mime: null, bytes: null, width: null, height: null,
      finalized_at: null, declared_mime: 'image/jpeg', declared_bytes: png.length,
    })]),
    mediaObject: binaryReply(200, png, { 'content-length': String(png.length) }),
    mediaFail: reply(true),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/media/finalize', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 422);
    assert.equal(JSON.parse(result.body).reason, 'mime_mismatch');
  } finally {
    restore();
  }
});

test('media URL and abandon only act on approved paths from server rows', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;

  // Approved asset: a client-supplied url is ignored and the row path is signed.
  let calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow()]),
    mediaSign: mediaSignReply(),
  }));
  try {
    const event = adminEvent('/api/admin/media/url');
    event.queryStringParameters = { id: ASSET_ID, url: 'https://evil.example/x.png' };
    const result = await handler(event);
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.match(body.url, /\/object\/sign\/ccafe-media\/media\//);
    assert.equal(body.expires_in, 300);
    const sign = calls.find((call) => call.url.includes('/object/sign/'));
    assert.match(sign.url, new RegExp(ASSET_PATH));
    assert.equal(sign.url.includes('evil.example'), false);

    const bad = adminEvent('/api/admin/media/url');
    bad.queryStringParameters = { id: 'not-a-uuid' };
    assert.equal((await handler(bad)).statusCode, 400);
  } finally {
    restore();
  }

  // Pending asset cannot be previewed.
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  installFetch(adminRoutes({ mediaAsset: reply([mediaRow({ status: 'pending', finalized_at: null })]) }));
  try {
    const event = adminEvent('/api/admin/media/url');
    event.queryStringParameters = { id: ASSET_ID };
    const result = await handler(event);
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'not_approved' });
  } finally {
    restore();
  }

  // Abandon marks pending as failed, deletes the object, refuses approved rows.
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  calls = installFetch(adminRoutes({
    mediaAsset: reply([mediaRow({ status: 'pending', finalized_at: null })]),
    mediaFail: reply({ id: ASSET_ID, status: 'failed', failure_reason: 'abandoned' }),
    mediaObject: reply({ ok: true, status: 200, async json() { return true; } }),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/media/abandon', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.status, 'failed');
    assert.equal(body.deleted_object, true);
    const fail = calls.find((call) => call.url.includes('/rpc/admin_media_fail'));
    assert.deepEqual(JSON.parse(fail.init.body), { p_asset_id: ASSET_ID, p_reason: 'abandoned' });
  } finally {
    restore();
  }

  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  installFetch(adminRoutes({ mediaAsset: reply([mediaRow()]) }));
  try {
    const result = await handler(adminEvent('/api/admin/media/abandon', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'approved' });
  } finally {
    restore();
  }
});

test('publish maps CC001 from preflight and admin_publish to media_not_ready', async () => {
  configure();

  let calls = installFetch(adminRoutes({
    publishBegin: reply({ code: 'CC001', message: 'media asset is not ready for publication' }, 400),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), { error: 'media_not_ready' });
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_publish')), false);
  } finally {
    restore();
  }

  // A race between preflight and publish can still surface CC001 at admin_publish.
  configure();
  calls = installFetch(adminRoutes({
    publishRpc: reply({ code: 'CC001', message: 'media asset is not ready for publication' }, 400),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 422);
    assert.deepEqual(JSON.parse(result.body), { error: 'media_not_ready' });
  } finally {
    restore();
  }
});

test('publish prepares missing public copies before calling admin_publish', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const png = await samplePng();
  const sha = _internal.sha256Hex(png);
  const calls = installFetch(adminRoutes({
    publishBegin: publishBeginReply({
      state: 'needs_prepare',
      assets: [publicAsset({ sha256: sha, bytes: png.length, public_state: 'none', object_path: null })],
      needs_prepare: [ASSET_PATH],
    }),
    mediaPreparePublic: reply({
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      bucket: 'ccafe-public',
      state: 'staging',
      object_path: PUBLIC_PATH,
      mime: 'image/png',
      bytes: png.length,
      width: 2,
      height: 2,
      pixel_count: 4,
      sha256: sha,
      linked_version: null,
    }),
    mediaPublic: binaryReply(200, png, { 'content-length': String(png.length) }),
    mediaConfirmPublic: reply({
      asset_id: ASSET_ID,
      state: 'ready',
      object_path: PUBLIC_PATH,
      sha256: sha,
      linked_version: null,
    }),
    publishRpc: publishResultReply(),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      version: 244,
      saved_at: '2026-11-08T12:00:00+00:00',
      operation_id: NEW_REV,
      source: 'draft',
      purge_state: 'pending',
      public_check_state: 'pending',
    });

    const prepare = calls.find((call) => call.url.includes('/rpc/admin_media_prepare_public'));
    const confirm = calls.find((call) => call.url.includes('/rpc/admin_media_confirm_public'));
    const publishCall = calls.find((call) => call.url.includes('/rpc/admin_publish'));
    assert.ok(prepare && confirm && publishCall);
    assert.equal(JSON.parse(prepare.init.body).p_token, FINALIZE_TOKEN);
    assert.equal(JSON.parse(confirm.init.body).p_sha256, sha);
    assert.ok(calls.indexOf(prepare) < calls.indexOf(confirm));
    assert.ok(calls.indexOf(confirm) < calls.indexOf(publishCall));

    // The existing public object is re-read anonymously and never replaced.
    const read = calls.find(
      (call) => call.url.includes('/storage/v1/object/public/ccafe-public/') && call.init.method === 'GET',
    );
    assert.ok(read);
    assert.equal(read.init.headers.Authorization, undefined);
    assert.equal(
      calls.some((call) => call.url.includes('/storage/v1/object/ccafe-public/')),
      false,
    );
  } finally {
    restore();
  }
});

test('publish uploads a missing public object once and re-reads it', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const png = await samplePng();
  const sha = _internal.sha256Hex(png);
  const routes = adminRoutes({
    publishBegin: publishBeginReply({
      state: 'needs_prepare',
      assets: [publicAsset({ sha256: sha, bytes: png.length, public_state: 'none', object_path: null })],
      needs_prepare: [ASSET_PATH],
    }),
    mediaPreparePublic: reply({
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      state: 'staging',
      object_path: PUBLIC_PATH,
      mime: 'image/png',
      bytes: png.length,
      width: 2,
      height: 2,
      pixel_count: 4,
      sha256: sha,
      linked_version: null,
    }),
    mediaObject: binaryReply(200, png, { 'content-length': String(png.length) }),
    mediaPublicUpload: binaryReply(200, Buffer.alloc(0)),
    mediaConfirmPublic: reply({
      asset_id: ASSET_ID,
      state: 'ready',
      object_path: PUBLIC_PATH,
      sha256: sha,
      linked_version: null,
    }),
    publishRpc: publishResultReply(),
  });
  // HEAD is used to test existence; GET is the credential-free verification read.
  routes.unshift({
    match: '/storage/v1/object/public/ccafe-public/',
    handler(url, init) {
      return init.method === 'HEAD'
        ? htmlReply(404, '')
        : binaryReply(200, png, { 'content-length': String(png.length) });
    },
  });
  const calls = installFetch(routes);

  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 200);

    const uploads = calls.filter(
      (call) => call.url.includes('/storage/v1/object/ccafe-public/') && call.init.method === 'POST',
    );
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].init.headers['x-upsert'], 'false');
    assert.equal(uploads[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    const privateRead = calls.find((call) => call.url.includes('/storage/v1/object/ccafe-media/'));
    assert.ok(privateRead, 'the approved private bytes are the upload source');
    assert.ok(calls.some((call) => call.url.includes('/rpc/admin_publish')));
  } finally {
    restore();
  }
});

test('publish stops on a preparation failure without touching the published version', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const png = await samplePng();
  const sha = _internal.sha256Hex(png);
  const routes = adminRoutes({
    publishBegin: publishBeginReply({
      state: 'needs_prepare',
      assets: [publicAsset({ sha256: sha, bytes: png.length, public_state: 'staging', object_path: PUBLIC_PATH })],
      needs_prepare: [ASSET_PATH],
    }),
    mediaPreparePublic: reply({
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      state: 'staging',
      object_path: PUBLIC_PATH,
      mime: 'image/png',
      bytes: png.length,
      width: 2,
      height: 2,
      pixel_count: 4,
      sha256: sha,
      linked_version: null,
    }),
    mediaFailPublic: reply({ asset_id: ASSET_ID, state: 'failed', failure_reason: 'decode_failed' }),
    publishRpc: publishResultReply(),
  });
  routes.unshift({
    match: '/storage/v1/object/public/ccafe-public/',
    handler(url, init) {
      return init.method === 'HEAD' ? binaryReply(200, Buffer.alloc(0)) : binaryReply(200, Buffer.from('not an image'));
    },
  });
  const calls = installFetch(routes);

  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 502);
    assert.deepEqual(JSON.parse(result.body), { error: 'media_prepare_failed' });
    assert.ok(calls.some((call) => call.url.includes('/rpc/admin_media_fail_public')));
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_publish')), false);
  } finally {
    restore();
  }
});

test('publish returns the stored result for an already published operation', async () => {
  configure();
  const calls = installFetch(adminRoutes({
    publishBegin: reply({
      state: 'published',
      result: {
        version: 244,
        saved_at: '2026-11-08T12:00:00+00:00',
        operation_id: NEW_REV,
        source: 'draft',
        purge_state: 'pending',
        public_check_state: 'pending',
      },
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/publish', 'POST', TOKEN, {
      expected_version: 243,
      expected_draft_revision: REV,
      operation_id: NEW_REV,
      note: null,
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).version, 244);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_publish')), false);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_prepare_public')), false);
  } finally {
    restore();
  }
});


// ---------------------------------------------------------------------------
// Recoverable media deletion and trash
// ---------------------------------------------------------------------------

test('media delete writes a verified trash copy before committing and hides its path', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media),
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaTrashObject: (url, init) => (init.method === 'POST'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaDeleteFinish: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      cleanup_state: 'pending',
      cleanup_error: null,
      sha256: media.sha,
      idempotent: false,
    }),
    mediaCleanupTargets: cleanupTargetsReply(),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'none',
      public_cleanup_error: null,
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.id, ASSET_ID);
    assert.equal(body.asset.status, 'trashed');
    assert.equal(body.asset.cleanup_state, 'done');
    assert.equal(body.asset.public_cleanup_state, 'none');
    assert.equal(JSON.stringify(body).includes(TRASH_PATH), false);
    assert.equal(JSON.stringify(body).includes('ccafe-trash'), false);

    const targets = calls.find((call) => call.url.includes('/rpc/admin_media_cleanup_targets'));
    assert.ok(targets, 'cleanup must read the server-only target list first');
    const firstDelete = calls.find((call) => call.url.includes('/storage/v1/object/ccafe-media/')
      && call.init.method === 'DELETE');
    assert.ok(calls.indexOf(targets) < calls.indexOf(firstDelete));

    const begin = calls.find((call) => call.url.includes('/rpc/admin_media_delete_begin'));
    const beginBody = JSON.parse(begin.init.body);
    assert.equal(beginBody.p_asset_id, ASSET_ID);
    assert.equal(beginBody.p_token, FINALIZE_TOKEN);
    assert.equal(beginBody.p_operation_id, OPERATION_ID);

    const download = calls.find((call) => call.url.includes(`/object/ccafe-media/${ASSET_PATH}`) && call.init.method !== 'DELETE');
    assert.ok(download, 'the original private bytes must be read server-side');
    assert.equal(download.init.headers.Authorization, `Bearer ${TOKEN}`);

    const upload = calls.find((call) => call.url.includes(`/object/ccafe-trash/${TRASH_PATH}`) && call.init.method === 'POST');
    assert.ok(upload, 'the verified bytes must be copied to the trash bucket');
    assert.equal(upload.init.headers['x-upsert'], 'false');

    const storedRead = calls.find((call) => call.url.includes(`/object/ccafe-trash/${TRASH_PATH}`) && call.init.method === 'GET');
    assert.ok(storedRead, 'the trash copy must be read back and verified');

    const finish = calls.find((call) => call.url.includes('/rpc/admin_media_delete_finish'));
    const finishBody = JSON.parse(finish.init.body);
    assert.equal(finishBody.p_sha256, media.sha);
    assert.equal(finishBody.p_operation_id, OPERATION_ID);
    assert.ok(calls.indexOf(upload) < calls.indexOf(storedRead));
    assert.ok(calls.indexOf(storedRead) < calls.indexOf(finish));
    assert.ok(calls.indexOf(finish) < calls.indexOf(calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'))));
  } finally {
    restore();
  }
});

test('media delete removes the exact public copy and records it separately from the private original', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media, {
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaTrashObject: (url, init) => (init.method === 'POST'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaDeleteFinish: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      cleanup_state: 'pending',
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
      sha256: media.sha,
      idempotent: false,
    }),
    mediaCleanupTargets: cleanupTargetsReply({
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'done',
      public_cleanup_error: null,
    }),
    mediaPublicObject: (url, init) => (init.method === 'DELETE' ? reply({}, 200) : reply({}, 404)),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.cleanup_state, 'done');
    assert.equal(body.asset.public_cleanup_state, 'done');
    assert.equal(JSON.stringify(body).includes(PUBLIC_PATH), false);

    const publicDelete = calls.find((call) => call.url.includes(`/storage/v1/object/ccafe-public/${PUBLIC_PATH}`)
      && call.init.method === 'DELETE');
    assert.ok(publicDelete, 'the public object must be deleted by its exact name');
    assert.equal(publicDelete.init.headers.Authorization, `Bearer ${TOKEN}`);
    const cleanup = calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'));
    const cleanupBody = JSON.parse(cleanup.init.body);
    assert.equal(cleanupBody.p_public_done, true);
    assert.equal(cleanupBody.p_public_error, null);
  } finally {
    restore();
  }
});

test('a failed public cleanup is reported as pending instead of a fully clean delete', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media, {
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaTrashObject: (url, init) => (init.method === 'POST'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaDeleteFinish: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      cleanup_state: 'pending',
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
      sha256: media.sha,
      idempotent: false,
    }),
    mediaCleanupTargets: cleanupTargetsReply({
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'pending',
      public_cleanup_error: 'public_object_delete_failed',
    }),
    mediaPublicObject: (url, init) => (init.method === 'DELETE' ? reply({ message: 'storage down' }, 500) : reply({}, 404)),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.cleanup_state, 'done');
    assert.equal(body.asset.public_cleanup_state, 'pending');
    assert.equal(body.asset.public_cleanup_error, 'public_object_delete_failed');

    const cleanup = calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'));
    const cleanupBody = JSON.parse(cleanup.init.body);
    assert.equal(cleanupBody.p_public_done, false);
    assert.equal(cleanupBody.p_public_error, 'public_object_delete_failed');
  } finally {
    restore();
  }
});

test('an already-missing public copy is reported as cleaned up, not pending', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media, {
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaTrashObject: (url, init) => (init.method === 'POST'
      ? reply({}, 200)
      : binaryReply(200, media.png, { 'content-length': String(media.bytes) })),
    mediaDeleteFinish: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      cleanup_state: 'pending',
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
      sha256: media.sha,
      idempotent: false,
    }),
    mediaCleanupTargets: cleanupTargetsReply({
      public_object_path: PUBLIC_PATH,
      public_cleanup_state: 'pending',
    }),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'done',
      public_cleanup_error: null,
    }),
    // Storage reports a missing object as 400 with statusCode 404 in the body.
    mediaPublicObject: (url, init) => (init.method === 'DELETE'
      ? reply({ statusCode: 404, error: 'not_found', message: 'Object not found' }, 400)
      : reply({}, 404)),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.public_cleanup_state, 'done');
    assert.equal(body.asset.public_cleanup_error, null);

    const cleanup = calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'));
    const cleanupBody = JSON.parse(cleanup.init.body);
    assert.equal(cleanupBody.p_public_done, true);
    assert.equal(cleanupBody.p_public_error, null);
  } finally {
    restore();
  }
});

test('cleanup retry treats an already-removed private original as done', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaCleanupTargets: cleanupTargetsReply({
      cleanup_state: 'pending',
      public_cleanup_state: 'none',
    }),
    // The original was removed by an earlier attempt; a repeat cleanup must not
    // stay pending forever.
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({ statusCode: 404, error: 'not_found', message: 'Object not found' }, 400)
      : binaryReply(404, Buffer.from(''))),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'none',
      public_cleanup_error: null,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/cleanup', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.cleanup_state, 'done');
    assert.equal(body.cleanup_error, null);

    const cleanup = calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'));
    const cleanupBody = JSON.parse(cleanup.init.body);
    assert.equal(cleanupBody.p_done, true);
    assert.equal(cleanupBody.p_error, null);
    assert.equal(cleanupBody.p_operation_id, null);
  } finally {
    restore();
  }
});

test('media delete refuses a referenced asset and reports every reason without touching storage', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: reply({
      state: 'blocked',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      reasons: ['published', 'draft', 'history'],
      references: { published: true, draft: true, history_count: 3, public_state: 'ready' },
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 409);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'media_in_use');
    assert.deepEqual(body.reasons, ['published', 'draft', 'history']);
    assert.equal(body.references.public_state, 'ready');
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/')), false);
  } finally {
    restore();
  }
});

test('media usage and trash list return sanitized admin summaries', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaUsage: reply({
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      original_name: 'photo.png',
      status: 'approved',
      deletable: false,
      reasons: ['published', 'unknown_reason'],
      references: {
        published: true,
        draft: false,
        history_count: 2,
        public_state: 'ready',
        public_linked_version: 257,
      },
    }),
    mediaTrashList: reply({
      items: [{
        asset_id: ASSET_ID,
        logical_path: ASSET_PATH,
        original_name: 'photo.png',
        mime: 'image/png',
        bytes: media.bytes,
        width: 2,
        height: 2,
        deleted_at: '2026-11-12T10:00:00+00:00',
        state: 'trashed',
        cleanup_state: 'pending',
        cleanup_error: 'timeout',
        public_cleanup_state: 'pending',
        public_cleanup_error: 'public_timeout',
        restore_error: null,
        object_path: TRASH_PATH,
      }],
    }),
  }));

  try {
    const usage = await handler({
      path: '/api/admin/media/usage',
      httpMethod: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
      queryStringParameters: { id: ASSET_ID },
    });
    assert.equal(usage.statusCode, 200);
    const usageBody = JSON.parse(usage.body).usage;
    assert.equal(usageBody.deletable, false);
    assert.deepEqual(usageBody.reasons, ['published']);
    assert.equal(usageBody.references.history_count, 2);
    assert.equal(usageBody.references.public_state, 'ready');

    const trash = await handler(adminEvent('/api/admin/media/trash'));
    assert.equal(trash.statusCode, 200);
    const trashBody = JSON.parse(trash.body);
    assert.equal(trashBody.items.length, 1);
    assert.equal(trashBody.items[0].asset_id, ASSET_ID);
    assert.equal(trashBody.items[0].cleanup_state, 'pending');
    assert.equal(trashBody.items[0].public_cleanup_state, 'pending');
    assert.equal(trashBody.items[0].public_cleanup_error, 'public_timeout');
    assert.equal(JSON.stringify(trashBody).includes(TRASH_PATH), false);
    assert.equal(JSON.stringify(trashBody).includes('object_path'), false);

    const preview = await handler({
      path: '/api/admin/media/usage',
      httpMethod: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
      queryStringParameters: { id: 'not-a-uuid' },
    });
    assert.equal(preview.statusCode, 400);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_usage') && call.init.body.includes('not-a-uuid')), false);
  } finally {
    restore();
  }
});

test('trash list exposes a valid purging operation id for a later resume', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const operationId = '77777777-7777-4777-8777-777777777777';
  installFetch(adminRoutes({
    mediaTrashList: reply({
      items: [{
        asset_id: ASSET_ID,
        logical_path: ASSET_PATH,
        original_name: 'photo.png',
        mime: 'image/png',
        bytes: media.bytes,
        width: 2,
        height: 2,
        deleted_at: '2026-11-12T10:00:00+00:00',
        state: 'purging',
        purge_operation_id: operationId,
        cleanup_state: 'done',
        public_cleanup_state: 'none',
      }],
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/trash'));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].state, 'purging');
    assert.equal(body.items[0].purge_operation_id, operationId);
  } finally {
    restore();
  }
});

test('media delete aborts and leaves the asset approved when bytes cannot be copied', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media),
    mediaObject: binaryReply(404, Buffer.from(''), { 'content-length': '0' }),
    mediaDeleteAbort: reply({
      state: 'approved',
      asset_id: ASSET_ID,
      aborted: true,
      failure_reason: 'not_found',
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'media_object_missing' });

    const abort = calls.find((call) => call.url.includes('/rpc/admin_media_delete_abort'));
    assert.ok(abort, 'a failed delete must release the deleting state');
    const abortBody = JSON.parse(abort.init.body);
    assert.equal(abortBody.p_operation_id, OPERATION_ID);
    assert.equal(abortBody.p_reason, 'not_found');
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_delete_finish')), false);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_delete_cleanup')), false);
  } finally {
    restore();
  }
});

test('media delete does not commit a trash copy that could not be verified', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: deleteBeginReply(media),
    mediaObject: binaryReply(200, media.png, { 'content-length': String(media.bytes) }),
    mediaTrashObject: reply({ message: 'storage down' }, 500),
    mediaDeleteAbort: reply({
      state: 'approved',
      asset_id: ASSET_ID,
      aborted: true,
      failure_reason: 'upstream',
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 502);
    assert.deepEqual(JSON.parse(result.body), { error: 'storage_unavailable' });
    assert.ok(calls.some((call) => call.url.includes('/rpc/admin_media_delete_abort')));
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_delete_finish')), false);
  } finally {
    restore();
  }
});

test('a repeated delete reconciles cleanup without allocating another trash copy', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaDeleteBegin: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      trash_state: 'stored',
      cleanup_state: 'pending',
      cleanup_error: null,
      sha256: media.sha,
      idempotent: true,
    }),
    mediaObject: (url, init) => (init.method === 'DELETE'
      ? reply({}, 200)
      : binaryReply(500, Buffer.from(''))),
    mediaCleanupTargets: cleanupTargetsReply(),
    mediaDeleteCleanup: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      cleanup_state: 'done',
      cleanup_error: null,
      public_cleanup_state: 'none',
      public_cleanup_error: null,
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).idempotent, true);
    assert.equal(JSON.parse(result.body).asset.cleanup_state, 'done');
    assert.equal(calls.some((call) => call.url.includes('/storage/v1/object/ccafe-trash/')), false);

    const cleanup = calls.find((call) => call.url.includes('/rpc/admin_media_delete_cleanup'));
    assert.equal(JSON.parse(cleanup.init.body).p_operation_id, OPERATION_ID);

    const retry = await handler(adminEvent('/api/admin/media/cleanup', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(retry.statusCode, 200);
    assert.equal(JSON.parse(retry.body).cleanup_state, 'done');
    const retryRpc = calls.filter((call) => call.url.includes('/rpc/admin_media_delete_cleanup')).at(-1);
    assert.equal(JSON.parse(retryRpc.init.body).p_operation_id, null);
  } finally {
    restore();
  }
});

test('media restore verifies the trash bytes before writing and committing', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaRestoreBegin: restoreBeginReply(media),
    mediaTrashObject: binaryReply(200, media.png, { 'content-length': String(media.bytes) }),
    mediaObject: reply({}, 200),
    mediaRestoreFinish: reply({
      state: 'approved',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      sha256: media.sha,
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/restore', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body);
    assert.equal(body.asset.status, 'approved');
    assert.equal(body.asset.selectable, true);
    assert.equal(JSON.stringify(body).includes(TRASH_PATH), false);

    const begin = calls.find((call) => call.url.includes('/rpc/admin_media_restore_begin'));
    assert.equal(JSON.parse(begin.init.body).p_operation_id, OPERATION_ID);
    const trashRead = calls.find((call) => call.url.includes('/storage/v1/object/ccafe-trash/'));
    const upload = calls.find((call) => call.url.includes(`/storage/v1/object/ccafe-media/${ASSET_PATH}`));
    const finish = calls.find((call) => call.url.includes('/rpc/admin_media_restore_finish'));
    assert.ok(calls.indexOf(trashRead) < calls.indexOf(upload));
    assert.ok(calls.indexOf(upload) < calls.indexOf(finish));
  } finally {
    restore();
  }
});

test('media restore never overwrites an existing object with different bytes', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaRestoreBegin: restoreBeginReply(media),
    mediaTrashObject: binaryReply(200, media.png, { 'content-length': String(media.bytes) }),
    mediaObject: (url, init) => (init.method === 'POST'
      ? reply({ message: 'duplicate' }, 409)
      : binaryReply(200, Buffer.from('different-bytes'), { 'content-length': '15' })),
    mediaRestoreAbort: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      aborted: true,
      failure_reason: 'digest_mismatch',
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/restore', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body), { error: 'restore_conflict' });
    assert.ok(calls.some((call) => call.url.includes('/rpc/admin_media_restore_abort')));
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_restore_finish')), false);
  } finally {
    restore();
  }
});

test('media restore removes a pending public copy before the asset becomes approved again', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaRestoreBegin: restoreBeginReply(media, {
      public_object_path: PUBLIC_PATH,
      public_cleanup_pending: true,
    }),
    mediaTrashObject: binaryReply(200, media.png, { 'content-length': String(media.bytes) }),
    mediaObject: reply({}, 200),
    mediaRestoreFinish: reply({
      state: 'approved',
      asset_id: ASSET_ID,
      logical_path: ASSET_PATH,
      sha256: media.sha,
      idempotent: false,
    }),
    mediaPublicObject: (url, init) => (init.method === 'DELETE' ? reply({}, 200) : reply({}, 404)),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/restore', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 200);
    const publicDelete = calls.find((call) => call.url.includes(`/storage/v1/object/ccafe-public/${PUBLIC_PATH}`)
      && call.init.method === 'DELETE');
    assert.ok(publicDelete, 'a pending public object must be removed before restore commits');
    const finish = calls.find((call) => call.url.includes('/rpc/admin_media_restore_finish'));
    assert.ok(calls.indexOf(publicDelete) < calls.indexOf(finish));
  } finally {
    restore();
  }
});

test('media restore aborts and stays trashed when the public cleanup still fails', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  const media = await sampleMedia();
  const calls = installFetch(adminRoutes({
    mediaRestoreBegin: restoreBeginReply(media, {
      public_object_path: PUBLIC_PATH,
      public_cleanup_pending: true,
    }),
    mediaTrashObject: binaryReply(200, media.png, { 'content-length': String(media.bytes) }),
    mediaObject: reply({}, 200),
    mediaPublicObject: (url, init) => (init.method === 'DELETE' ? reply({ message: 'storage down' }, 500) : reply({}, 404)),
    mediaRestoreAbort: reply({
      state: 'trashed',
      asset_id: ASSET_ID,
      aborted: true,
      failure_reason: 'public_object_delete_failed',
      idempotent: false,
    }),
  }));

  try {
    const result = await handler(adminEvent('/api/admin/media/restore', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(result.statusCode, 502);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'storage_unavailable');
    assert.equal(body.reason, 'public_cleanup_pending');
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_restore_finish')), false);
    const abort = calls.find((call) => call.url.includes('/rpc/admin_media_restore_abort'));
    assert.ok(abort);
    assert.equal(JSON.parse(abort.init.body).p_reason, 'public_object_delete_failed');
  } finally {
    restore();
  }
});

test('media delete and restore reject malformed requests and missing server configuration', async () => {
  configure();
  process.env.CCAFE_MEDIA_FINALIZE_TOKEN = FINALIZE_TOKEN;
  let calls = installFetch(adminRoutes({}));

  try {
    for (const payload of [
      { asset_id: ASSET_ID },
      { asset_id: 'not-a-uuid', operation_id: OPERATION_ID },
      { asset_id: ASSET_ID, operation_id: 'not-a-uuid' },
    ]) {
      const result = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, payload));
      assert.equal(result.statusCode, 400);
    }
    const missing = await handler(adminEvent('/api/admin/media/restore', 'POST', TOKEN, { asset_id: ASSET_ID }));
    assert.equal(missing.statusCode, 400);
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_')), false);
  } finally {
    restore();
  }

  configure();
  delete process.env.CCAFE_MEDIA_FINALIZE_TOKEN;
  calls = installFetch(adminRoutes({}));
  try {
    const blocked = await handler(adminEvent('/api/admin/media/delete', 'POST', TOKEN, {
      asset_id: ASSET_ID,
      operation_id: OPERATION_ID,
    }));
    assert.equal(blocked.statusCode, 503);
    assert.deepEqual(JSON.parse(blocked.body), { error: 'media_unavailable' });
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_media_')), false);
  } finally {
    restore();
  }
});

const ANALYTICS_NOW = 1763200000000;
function analyticsSnapshotReply(overrides = {}) {
  const base = { v: 'a'.repeat(16), s: 'session000000001' };
  return reply({
    env: 'ignored',
    range: 'ignored',
    generated_at: ANALYTICS_NOW,
    current: [
      { ...base, t: ANALYTICS_NOW - 120000, e: 'pageview', r: 'instagram.com', u: 'ig', device: 'desktop', browser: 'chrome', os: 'windows' },
      { ...base, t: ANALYTICS_NOW - 110000, e: 'section', n: 'menu' },
      { ...base, t: ANALYTICS_NOW - 100000, e: 'mood', n: 'هادئ' },
      { ...base, t: ANALYTICS_NOW - 90000, e: 'click', n: 'اتصال', k: 'call' },
      { ...base, t: ANALYTICS_NOW - 80000, e: 'leave', ms: 60000, sc: 40 },
    ],
    previous: [],
    live: [{ ...base, t: ANALYTICS_NOW - 1000, e: 'pageview', r: '', device: 'mobile', browser: 'safari', os: 'ios' }],
    ...overrides,
  });
}

test('admin analytics is environment-scoped and returns the existing indicators', async () => {
  configure();
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  const calls = installFetch(adminRoutes({ analyticsSnapshot: analyticsSnapshotReply() }));

  try {
    const event = { ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d', env: 'production' } };
    const result = await handler(event);
    assert.equal(result.statusCode, 200);
    assertPrivateHeaders(result);

    const body = JSON.parse(result.body);
    assert.equal(body.env, 'preview');
    assert.equal(body.stats.range, '7d');
    assert.equal(body.stats.totals.visitors, 1);
    assert.equal(body.stats.totals.sessions, 1);
    assert.equal(body.stats.totals.pageviews, 1);
    assert.equal(body.stats.totals.calls, 1);
    assert.equal(body.stats.totals.avgDurationMs, 60000);
    assert.equal(body.stats.live, 1);
    assert.equal(body.stats.sources[0].key, 'instagram');
    assert.equal(body.stats.clicks[0].kind, 'call');
    assert.equal(body.stats.moods[0].key, 'هادئ');
    assert.equal(body.stats.sections.menu, 1);

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_analytics_snapshot'));
    assert.deepEqual(JSON.parse(rpc.init.body), { p_env: 'preview', p_range: '7d' });
    assert.equal(rpc.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(rpc.init.headers.apikey, ANON);
  } finally {
    restore();
  }
});

test('admin analytics rejects missing/invalid environment and range before any RPC', async () => {
  configure();
  const calls = installFetch(adminRoutes({ analyticsSnapshot: analyticsSnapshotReply() }));
  try {
    const unset = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d' } });
    assert.equal(unset.statusCode, 503);
    assert.equal(JSON.parse(unset.body).error, 'analytics_unavailable');

    process.env.CCAFE_ANALYTICS_ENV = 'staging';
    const invalidEnv = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d' } });
    assert.equal(invalidEnv.statusCode, 503);

    process.env.CCAFE_ANALYTICS_ENV = 'preview';
    for (const range of ['', '1d', '365d', '../90d']) {
      const badRange = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range } });
      assert.equal(badRange.statusCode, 400);
    }
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_analytics_snapshot')), false);
  } finally {
    restore();
  }
});

test('admin analytics maps upstream errors and rejects malformed snapshots', async () => {
  configure();
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  try {
    installFetch(adminRoutes({ analyticsSnapshot: reply({ code: '42501', message: 'admin only' }, 403) }));
    const forbidden = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d' } });
    assert.equal(forbidden.statusCode, 403);

    installFetch(adminRoutes({ analyticsSnapshot: reply({ generated_at: 'soon', current: {} }) }));
    const malformed = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d' } });
    assert.equal(malformed.statusCode, 502);

    installFetch(adminRoutes({ analyticsSnapshot: reply({ message: 'down' }, 503) }));
    const down = await handler({ ...adminEvent('/api/admin/analytics'), queryStringParameters: { range: '7d' } });
    assert.equal(down.statusCode, 502);
  } finally {
    restore();
  }
});

test('admin analytics HEAD returns headers without a body', async () => {
  configure();
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  installFetch(adminRoutes({ analyticsSnapshot: analyticsSnapshotReply() }));
  try {
    const result = await handler({ ...adminEvent('/api/admin/analytics', 'HEAD'), queryStringParameters: { range: 'today' } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, '');
    assertPrivateHeaders(result);
  } finally {
    restore();
  }
});

test('clearing analytics is limited to the server-selected environment', async () => {
  configure();
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  const calls = installFetch(adminRoutes({ analyticsClear: reply(7) }));
  try {
    const result = await handler(adminEvent('/api/admin/analytics/clear', 'POST', TOKEN, {}));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { env: 'preview', deleted: 7 });

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_analytics_clear'));
    assert.deepEqual(JSON.parse(rpc.init.body), { p_env: 'preview' });
    assert.equal(rpc.init.headers.Authorization, `Bearer ${TOKEN}`);

    installFetch(adminRoutes({ analyticsClear: reply(null, 403) }));
    const denied = await handler(adminEvent('/api/admin/analytics/clear', 'POST', TOKEN, {}));
    assert.equal(denied.statusCode, 403);

    delete process.env.CCAFE_ANALYTICS_ENV;
    const disabled = await handler(adminEvent('/api/admin/analytics/clear', 'POST', TOKEN, {}));
    assert.equal(disabled.statusCode, 503);
  } finally {
    restore();
  }
});

test('history clear requires explicit confirmation and forwards idempotent RPC call', async () => {
  configure();
  const operationId = '55555555-5555-4555-8555-555555555555';
  const calls = installFetch(adminRoutes({
    historyClear: reply({
      operation_id: operationId,
      deleted_count: 12,
      boundary_version: 260,
      boundary_id: 9001,
      cleared_at: '2026-11-27T12:00:00+00:00',
    }),
  }));

  try {
    for (const body of [
      {},
      { operation_id: operationId },
      { confirmation: 'حذف السجل نهائيًا' },
      { operation_id: operationId, confirmation: 'حذف السجل' },
      { operation_id: 'not-a-uuid', confirmation: 'حذف السجل نهائيًا' },
    ]) {
      const result = await handler(adminEvent('/api/admin/history/clear', 'POST', TOKEN, body));
      assert.equal(result.statusCode, 400);
      assert.deepEqual(JSON.parse(result.body), { error: 'invalid_request' });
    }
    assert.equal(calls.some((call) => call.url.includes('/rpc/admin_clear_content_history')), false);

    const result = await handler(adminEvent('/api/admin/history/clear', 'POST', TOKEN, {
      operation_id: operationId,
      confirmation: 'حذف السجل نهائيًا',
    }));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), {
      operation_id: operationId,
      deleted_count: 12,
      boundary_version: 260,
      boundary_id: 9001,
      cleared_at: '2026-11-27T12:00:00+00:00',
    });

    const rpc = calls.find((call) => call.url.includes('/rpc/admin_clear_content_history'));
    assert.equal(rpc.init.method, 'POST');
    assert.deepEqual(JSON.parse(rpc.init.body), {
      p_operation_id: operationId,
      p_confirmation: 'حذف السجل نهائيًا',
    });
  } finally {
    restore();
  }
});

test('history clear maps admin, conflict, and invalid upstream errors', async () => {
  configure();
  const operationId = '66666666-6666-4666-8666-666666666666';
  try {
    installFetch(adminRoutes({ historyClear: reply({ code: '42501', message: 'admin only' }, 403) }));
    const forbidden = await handler(adminEvent('/api/admin/history/clear', 'POST', TOKEN, {
      operation_id: operationId,
      confirmation: 'حذف السجل نهائيًا',
    }));
    assert.equal(forbidden.statusCode, 403);

    installFetch(adminRoutes({ historyClear: reply({ code: 'PT409', message: 'stale' }, 409) }));
    const conflict = await handler(adminEvent('/api/admin/history/clear', 'POST', TOKEN, {
      operation_id: operationId,
      confirmation: 'حذف السجل نهائيًا',
    }));
    assert.equal(conflict.statusCode, 409);

    installFetch(adminRoutes({ historyClear: reply({ code: '22023', message: 'invalid' }, 400) }));
    const invalid = await handler(adminEvent('/api/admin/history/clear', 'POST', TOKEN, {
      operation_id: operationId,
      confirmation: 'حذف السجل نهائيًا',
    }));
    assert.equal(invalid.statusCode, 422);
  } finally {
    restore();
  }
});


test('history delete request rejects invalid bodies and maps rpc', async () => {
  configure();
  const operationId = '77777777-7777-4777-8777-777777777777';
  const calls = installFetch(adminRoutes({
    historyDelete: (req) => { return reply({
        operation_id: operationId,
        history_id: 12,
        version: 259,
        deleted: true,
        was_current_published_version: false,
        deleted_at: '2026-11-27T12:00:00Z',
      });
    },
  }));
  try {
    for (const body of [
      { history_id: 12, operation_id: operationId, confirmation: 'wrong' },
      { history_id: 0, operation_id: operationId, confirmation: 'حذف هذه النسخة نهائيًا' },
      { history_id: 12, operation_id: 'bad', confirmation: 'حذف هذه النسخة نهائيًا' },
    ]) {
      const result = await handler(adminEvent('/api/admin/history/delete', 'POST', TOKEN, body));
      assert.equal(result.statusCode, 400);
    }
    const rpcBefore = calls.filter((c)=>String(c.url).includes('/rpc/admin_delete_content_history_entry')).length;
    const ok = await handler(adminEvent('/api/admin/history/delete', 'POST', TOKEN, {
      history_id: 12, operation_id: operationId, confirmation: 'حذف هذه النسخة نهائيًا',
    }));
    assert.equal(ok.statusCode, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.history_id, 12);
    assert.equal(body.deleted, true);
    const rpcAfter = calls.filter((c)=>String(c.url).includes('/rpc/admin_delete_content_history_entry')).length;
    assert.ok(rpcAfter > rpcBefore);
  } finally {
    restore();
  }
});

test('history delete maps not_found/conflict', async () => {
  configure();
  const operationId = '77777777-7777-4777-8777-777777777778';
  try {
    installFetch(adminRoutes({ historyDelete: reply({ code: 'P0002', message: 'missing' }, 404) }));
    let r = await handler(adminEvent('/api/admin/history/delete', 'POST', TOKEN, { history_id: 1, operation_id: operationId, confirmation: 'حذف هذه النسخة نهائيًا' }));
    assert.equal(r.statusCode, 404);

    installFetch(adminRoutes({ historyDelete: reply({ code: 'PT409', message: 'conflict' }, 409) }));
    r = await handler(adminEvent('/api/admin/history/delete', 'POST', TOKEN, { history_id: 1, operation_id: operationId, confirmation: 'حذف هذه النسخة نهائيًا' }));
    assert.equal(r.statusCode, 409);
  } finally {
    restore();
  }
});

test('media purge blocks when usage is still present', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-888888888888';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  installFetch(adminRoutes({
    mediaPurgeBegin: reply({ state: 'blocked', asset_id: assetId, reasons: ['published'], references: { published: true, draft: false, history_count: 0 } }),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, { asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا' }));
    assert.equal(result.statusCode, 409);
    assert.deepEqual(JSON.parse(result.body).reasons, ['published']);
  } finally {
    restore();
  }
});

test('media purge returns cleanup_pending when storage delete cannot be confirmed', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-888888888889';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  const trashPath = `trash/${assetId}/${'b'.repeat(64)}`;
  installFetch(adminRoutes({
    mediaPurgeBegin: reply({
      state: 'purging', operation_id: operationId, asset_id: assetId,
      logical_path: `media/${assetId}`, original_name: 'x.png',
      private_object_path: `media/${assetId}`, trash_object_path: trashPath,
      public_object_path: null, private_cleanup_state: 'pending', trash_cleanup_state: 'pending', public_cleanup_state: 'none',
    }),
    mediaPurgeCleanup: reply({
      state: 'purging', asset_id: assetId, logical_path: `media/${assetId}`,
      private_cleanup_state: 'pending', trash_cleanup_state: 'pending', public_cleanup_state: 'none',
      operation_id: operationId, idempotent: false,
    }),
  }));
  try {
    const result = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, { asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا' }));
    assert.equal(result.statusCode, 502);
    assert.equal(JSON.parse(result.body).error, 'cleanup_pending');
  } finally {
    restore();
  }
});

test('media purge fails after one storage delete and resumes with the same operation id', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-88888888888a';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac';
  const privatePath = `media/${assetId}`;
  const trashPath = `trash/${assetId}/${'b'.repeat(64)}`;
  const state = {
    privateDone: false,
    trashDone: false,
    trashAttempts: 0,
    cleanupRequests: [],
    deletedUrls: [],
  };
  const beginReply = () => reply({
    state: 'purging', operation_id: operationId, asset_id: assetId,
    logical_path: privatePath, original_name: 'x.png',
    private_object_path: privatePath, trash_object_path: trashPath, public_object_path: null,
    private_cleanup_state: state.privateDone ? 'done' : 'pending',
    trash_cleanup_state: state.trashDone ? 'done' : 'pending',
    public_cleanup_state: 'none',
  });
  const cleanupHandler = (_url, init) => {
    const request = JSON.parse(init.body);
    state.cleanupRequests.push(request);
    state.privateDone = state.privateDone || request.p_private_done === true;
    state.trashDone = state.trashDone || request.p_trash_done === true;
    const done = state.privateDone && state.trashDone;
    return reply({
      state: done ? 'purged' : 'purging', asset_id: assetId, logical_path: privatePath,
      private_cleanup_state: state.privateDone ? 'done' : 'pending',
      trash_cleanup_state: state.trashDone ? 'done' : 'pending',
      public_cleanup_state: 'none', operation_id: operationId, idempotent: false,
    });
  };
  const calls = installFetch([
    ...adminRoutes({
      mediaPurgeBegin: () => beginReply(),
      mediaPurgeCleanup: cleanupHandler,
    }),
    {
      match: `/storage/v1/object/ccafe-media/${privatePath}`,
      handler: () => {
        state.deletedUrls.push(`private`);
        return reply({});
      },
    },
    {
      match: `/storage/v1/object/ccafe-trash/${trashPath}`,
      handler: () => {
        state.trashAttempts += 1;
        state.deletedUrls.push(`trash`);
        return state.trashAttempts === 1 ? reply({ error: 'storage_failure' }, 500) : reply({});
      },
    },
  ]);
  try {
    const body = { asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا' };
    const first = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, body));
    assert.equal(first.statusCode, 502);
    assert.equal(JSON.parse(first.body).error, 'cleanup_pending');
    assert.deepEqual(state.deletedUrls, ['private', 'trash']);
    assert.equal(state.cleanupRequests.length, 1);
    assert.equal(state.cleanupRequests[0].p_private_done, true);
    assert.equal(state.cleanupRequests[0].p_trash_done, false);

    const retry = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, body));
    assert.equal(retry.statusCode, 200);
    assert.equal(JSON.parse(retry.body).asset.status, 'purged');
    assert.deepEqual(state.deletedUrls, ['private', 'trash', 'trash']);
    assert.equal(state.cleanupRequests.length, 2);
    assert.equal(state.cleanupRequests[1].p_private_done, true);
    assert.equal(state.cleanupRequests[1].p_trash_done, true);
    assert.deepEqual(storageDeleteUrls(calls), [
      `https://example.supabase.co/storage/v1/object/ccafe-media/${privatePath}`,
      `https://example.supabase.co/storage/v1/object/ccafe-trash/${trashPath}`,
      `https://example.supabase.co/storage/v1/object/ccafe-trash/${trashPath}`,
    ]);
  } finally {
    restore();
  }
});

test('media purge retry after a lost cleanup response does not delete again', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-88888888888b';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad';
  const privatePath = `media/${assetId}`;
  const trashPath = `trash/${assetId}/${'b'.repeat(64)}`;
  const state = { cleanupCompleted: false, cleanupCalls: 0 };
  const calls = installFetch([
    ...adminRoutes({
      mediaPurgeBegin: () => reply(state.cleanupCompleted ? {
        state: 'purged', operation_id: operationId, asset_id: assetId,
        logical_path: privatePath, original_name: 'x.png',
        private_object_path: privatePath, trash_object_path: trashPath, public_object_path: null,
        private_cleanup_state: 'done', trash_cleanup_state: 'done', public_cleanup_state: 'none',
        operation_id: operationId,
      } : {
        state: 'purging', operation_id: operationId, asset_id: assetId,
        logical_path: privatePath, original_name: 'x.png',
        private_object_path: privatePath, trash_object_path: trashPath, public_object_path: null,
        private_cleanup_state: 'pending', trash_cleanup_state: 'pending', public_cleanup_state: 'none',
      }),
      mediaPurgeCleanup: () => {
        state.cleanupCalls += 1;
        state.cleanupCompleted = true;
        throw new Error('response lost after cleanup completed');
      },
    }),
    { match: `/storage/v1/object/ccafe-media/${privatePath}`, reply: reply({}) },
    { match: `/storage/v1/object/ccafe-trash/${trashPath}`, reply: reply({}) },
  ]);
  try {
    const body = { asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا' };
    const first = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, body));
    assert.equal(first.statusCode, 502);
    assert.equal(state.cleanupCalls, 1);
    const deletesAfterFirst = storageDeleteUrls(calls).length;
    assert.equal(deletesAfterFirst, 2);

    const retry = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, body));
    assert.equal(retry.statusCode, 200);
    const retryBody = JSON.parse(retry.body);
    assert.equal(retryBody.asset.status, 'purged');
    assert.equal(retryBody.idempotent, true);
    assert.equal(state.cleanupCalls, 1);
    assert.equal(storageDeleteUrls(calls).length, deletesAfterFirst);
  } finally {
    restore();
  }
});

test('media purge reports no success until every storage target is confirmed', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-88888888888c';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaae';
  const privatePath = `media/${assetId}`;
  const trashPath = `trash/${assetId}/${'b'.repeat(64)}`;
  const publicPath = `published/${assetId}/${'d'.repeat(64)}`;
  let cleanupRequest = null;
  const calls = installFetch([
    ...adminRoutes({
      mediaPurgeBegin: reply({
        state: 'purging', operation_id: operationId, asset_id: assetId,
        logical_path: privatePath, original_name: 'x.png',
        private_object_path: privatePath, trash_object_path: trashPath, public_object_path: publicPath,
        private_cleanup_state: 'pending', trash_cleanup_state: 'pending', public_cleanup_state: 'pending',
      }),
      mediaPurgeCleanup: (_url, init) => {
        cleanupRequest = JSON.parse(init.body);
        return reply({
          state: 'purging', asset_id: assetId, logical_path: privatePath,
          private_cleanup_state: 'done', trash_cleanup_state: 'done', public_cleanup_state: 'pending',
          operation_id: operationId, idempotent: false,
        });
      },
    }),
    { match: `/storage/v1/object/ccafe-media/${privatePath}`, reply: reply({}) },
    { match: `/storage/v1/object/ccafe-trash/${trashPath}`, reply: reply({}) },
    { match: `/storage/v1/object/ccafe-public/${publicPath}`, reply: reply({ error: 'storage_failure' }, 500) },
  ]);
  try {
    const result = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, {
      asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا',
    }));
    assert.equal(result.statusCode, 502);
    const body = JSON.parse(result.body);
    assert.equal(body.error, 'cleanup_pending');
    assert.equal(body.asset.private_cleanup_state, 'done');
    assert.equal(body.asset.trash_cleanup_state, 'done');
    assert.equal(body.asset.public_cleanup_state, 'pending');
    assert.equal(cleanupRequest.p_private_done, true);
    assert.equal(cleanupRequest.p_trash_done, true);
    assert.equal(cleanupRequest.p_public_done, false);
    assert.deepEqual(storageDeleteUrls(calls), [
      `https://example.supabase.co/storage/v1/object/ccafe-media/${privatePath}`,
      `https://example.supabase.co/storage/v1/object/ccafe-trash/${trashPath}`,
      `https://example.supabase.co/storage/v1/object/ccafe-public/${publicPath}`,
    ]);
  } finally {
    restore();
  }
});

test('media purge refuses out-of-scope storage paths without deleting anything', async () => {
  configure();
  const operationId = '88888888-8888-4888-8888-88888888888d';
  const assetId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaf';
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaag';
  const calls = installFetch([
    ...adminRoutes({
      mediaPurgeBegin: reply({
        state: 'purging', operation_id: operationId, asset_id: assetId,
        logical_path: `media/${assetId}`, original_name: 'x.png',
        private_object_path: `media/${otherId}`,
        trash_object_path: `trash/${otherId}/${'b'.repeat(64)}`,
        public_object_path: `published/${otherId}/${'d'.repeat(64)}`,
        private_cleanup_state: 'pending', trash_cleanup_state: 'pending', public_cleanup_state: 'pending',
      }),
    }),
  ]);
  try {
    const result = await handler(adminEvent('/api/admin/media/purge', 'POST', TOKEN, {
      asset_id: assetId, operation_id: operationId, confirmation: 'حذف الصورة نهائيًا',
    }));
    assert.equal(result.statusCode, 502);
    assert.equal(JSON.parse(result.body).error, 'upstream_unavailable');
    assert.deepEqual(storageDeleteUrls(calls), []);
  } finally {
    restore();
  }
});