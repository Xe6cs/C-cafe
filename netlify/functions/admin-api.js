'use strict';
// Admin API: read published content/history, read and save the single draft,
// delete the draft, publish a draft revision, restore a history version, verify
// the public preview page, render a private preview of the draft, and read or
// change the temporary site display state.
//
// Scope:
//   * GET/HEAD: bootstrap, history, preview, verify, site-status.
//   * POST: draft save, draft delete, publish, restore, site-status.
//   * No purge, upload, media, or analytics endpoint exists here.
//
// Security:
//   * Every route requires a real Supabase access token. The token is verified
//     with GET /auth/v1/user, then admin membership is checked with
//     public.is_admin() using the same user token.
//   * Draft reads use the user token under RLS. All writes go through the
//     SECURITY DEFINER RPCs, which call public.assert_admin() again and enforce
//     expected revision/version/operation-id rules inside the database.
//   * The anon key and user JWT are the only Supabase credentials used. No
//     service_role key or management token is read or forwarded.
//   * Publish/restore require a caller-supplied operation_id and never generate
//     one server-side, so a retry after a lost response reuses the same result.
//   * Verification only fetches the configured preview origin from an explicit
//     allow-list. A client-supplied URL is never used.
//   * The preview is returned as text for an isolated srcdoc iframe. The token
//     never appears in a preview URL. Preview HTML is rendered with the site
//     template, but without scripts or tracking.
//
// Responses are never cached and always carry noindex.

const fs = require('node:fs');
const path = require('node:path');

const { SCHEMA, LINK_TOKENS, LINK_ANCHORS, normalize } = require('../../lib/schema');
const { renderPage } = require('../../lib/render');
const { buildStats } = require('../../lib/analytics');
const {
  verifyImage,
  sha256Hex,
  collectMediaRefs,
  MAX_BYTES: MEDIA_MAX_BYTES,
  MAX_DIMENSION: MEDIA_MAX_DIMENSION,
  MAX_PIXELS: MEDIA_MAX_PIXELS,
  MEDIA_PATH_RE,
} = require('../../lib/media-verify');
const { publicOriginals } = require('../../lib/media-originals');
const DEFAULTS = require('../../lib/default-content');

const DEFAULT_TIMEOUT_MS = 7000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 500;
const MAX_OPERATION_NOTE = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;
// The verification fetcher may only reach the intended Netlify preview site.
// Both the main preview host and per-deploy hosts are accepted; nothing else is.
const PREVIEW_HOST_RE = /^(?:[a-z0-9-]+--)?c-cafe-preview\.netlify\.app$/i;
const VERSION_MARKER_RE = /<meta\s+name=["']ccafe-content-version["']\s+content=["']([^"']*)["']/i;
const SITE_STATE_MARKER_RE = /<meta\s+name=["']ccafe-site-state["']\s+content=["']([^"']*)["']/i;
const MAX_SITE_MESSAGE_CHARS = 300;

const MEDIA_BUCKET = 'ccafe-media';
const PUBLIC_MEDIA_BUCKET = 'ccafe-public';
const TRASH_BUCKET = 'ccafe-trash';
const PUBLIC_MEDIA_PATH_RE = /^published\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;
const TRASH_PATH_RE = /^trash\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;
const MEDIA_URL_TTL_SECONDS = 300;
const MAX_MEDIA_LIST = 200;
const MAX_ORIGINAL_NAME = 120;

const ROUTES = new Map([
  ['/api/admin/analytics', ['GET', 'HEAD']],
  ['/api/admin/analytics/clear', ['POST']],
  ['/api/admin/bootstrap', ['GET', 'HEAD']],
  ['/api/admin/history', ['GET', 'HEAD']],
  ['/api/admin/history/clear', ['POST']],
  ['/api/admin/preview', ['GET', 'HEAD']],
  ['/api/admin/site-status', ['GET', 'HEAD', 'POST']],
  ['/api/admin/verify', ['GET', 'HEAD']],
  ['/api/admin/draft', ['POST']],
  ['/api/admin/draft/delete', ['POST']],
  ['/api/admin/publish', ['POST']],
  ['/api/admin/restore', ['POST']],
  ['/api/admin/media', ['GET', 'HEAD', 'POST']],
  ['/api/admin/media/finalize', ['POST']],
  ['/api/admin/media/abandon', ['POST']],
  ['/api/admin/media/url', ['GET', 'HEAD']],
  ['/api/admin/media/usage', ['GET', 'HEAD']],
  ['/api/admin/media/trash', ['GET', 'HEAD']],
  ['/api/admin/media/delete', ['POST']],
  ['/api/admin/media/restore', ['POST']],
  ['/api/admin/media/cleanup', ['POST']],
  ['/api/admin/media/purge', ['POST']],
  ['/api/admin/history/delete', ['POST']],
]);

const BASE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Netlify-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  Vary: 'Authorization',
};

const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  // 'self' is not usable here: the sandboxed srcdoc document has an opaque
  // origin, so its site assets must be allowed by scheme.
  'img-src https: data:',
  'font-src https:',
  "script-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readConfig() {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !anonKey) return null;

  let endpoint;
  try {
    endpoint = new URL('/rest/v1/', base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(endpoint.protocol)) return null;
  return { base, anonKey };
}

function timeoutMs() {
  const value = Number(process.env.CCAFE_SUPABASE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_TIMEOUT_MS;
}

// Analytics is environment-scoped by the server, never by the caller. The
// dashboard on a preview deployment can only read/write preview rows.
function analyticsEnv() {
  const value = String(process.env.CCAFE_ANALYTICS_ENV || '').trim().toLowerCase();
  return value === 'preview' || value === 'production' ? value : '';
}

function analyticsRange(event) {
  const query = event && event.queryStringParameters;
  const range = query && typeof query.range === 'string' ? query.range : '';
  return ['today', '7d', '30d', '90d'].includes(range) ? range : '';
}

function analyticsFailure(reason, extra) {
  if (reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
  if (reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
  if (reason === 'invalid') return jsonResponse(422, { error: 'invalid_request', ...(extra || {}) });
  return jsonResponse(502, { error: 'upstream_unavailable' });
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
      return typeof value === 'string' ? value.trim() : '';
    }
  }
  return '';
}

function bearerToken(event) {
  const header = headerValue(event.headers, 'authorization');
  const match = /^Bearer[ ]+([^\s]+)$/i.exec(header);
  if (!match) return '';
  const token = match[1];
  if (token.length < 20 || token.length > 4096) return '';
  if (!TOKEN_RE.test(token)) return '';
  return token;
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: payload === undefined ? '' : JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

function textResponse(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      ...(extraHeaders || {}),
    },
    body,
    isBase64Encoded: false,
  };
}

function htmlResponse(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/html; charset=utf-8',
      ...(extraHeaders || {}),
    },
    body,
    isBase64Encoded: false,
  };
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(config, token) {
  return {
    apikey: config.anonKey,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

async function readUser(config, token) {
  let response;
  try {
    response = await fetchWithTimeout(new URL('/auth/v1/user', config.base), {
      method: 'GET',
      headers: authHeaders(config, token),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let user;
  try {
    user = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (!isPlainObject(user) || typeof user.id !== 'string' || !UUID_RE.test(user.id)) {
    return { ok: false, reason: 'unauthorized' };
  }
  return {
    ok: true,
    user: {
      id: user.id,
      email: typeof user.email === 'string' ? user.email : null,
    },
  };
}

async function checkAdmin(config, token) {
  let response;
  try {
    response = await fetchWithTimeout(new URL('/rest/v1/rpc/is_admin', config.base), {
      method: 'POST',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (response.status === 401) return { ok: false, reason: 'unauthorized' };
  if (response.status === 403) return { ok: false, reason: 'forbidden' };
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let value;
  try {
    value = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (value === true) return { ok: true, admin: true };
  if (value === false) return { ok: true, admin: false };
  return { ok: false, reason: 'upstream' };
}

async function readPublished(config, token) {
  const endpoint = new URL('/rest/v1/published_content', config.base);
  endpoint.searchParams.set('select', 'version,content,saved_at');
  endpoint.searchParams.set('limit', '1');

  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: authHeaders(config, token),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'forbidden' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let rows;
  try {
    rows = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!Array.isArray(rows) || rows.length > 1) return { ok: false, reason: 'upstream' };
  if (rows.length === 0) return { ok: true, published: null };

  const row = rows[0];
  if (!isPlainObject(row)
    || !isPlainObject(row.content)
    || !Number.isSafeInteger(row.version)
    || row.version < 1
    || typeof row.saved_at !== 'string') {
    return { ok: false, reason: 'upstream' };
  }

  return {
    ok: true,
    published: {
      version: row.version,
      content: row.content,
      saved_at: row.saved_at,
    },
  };
}

async function readDraft(config, token) {
  const endpoint = new URL('/rest/v1/draft', config.base);
  endpoint.searchParams.set('select', 'content,revision_id,base_version,updated_at');
  endpoint.searchParams.set('limit', '1');

  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: authHeaders(config, token),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'forbidden' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let rows;
  try {
    rows = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!Array.isArray(rows) || rows.length > 1) return { ok: false, reason: 'upstream' };
  if (rows.length === 0) return { ok: true, draft: null };

  const row = rows[0];
  if (!isPlainObject(row)
    || !isPlainObject(row.content)
    || typeof row.revision_id !== 'string'
    || !UUID_RE.test(row.revision_id)
    || !Number.isSafeInteger(row.base_version)
    || row.base_version < 1
    || typeof row.updated_at !== 'string') {
    return { ok: false, reason: 'upstream' };
  }

  return {
    ok: true,
    draft: {
      revision_id: row.revision_id,
      base_version: row.base_version,
      updated_at: row.updated_at,
      content: row.content,
    },
  };
}

async function readHistory(config, token) {
  const endpoint = new URL('/rest/v1/content_history', config.base);
  endpoint.searchParams.set('select', 'id,version,note,created_at');
  endpoint.searchParams.set('order', 'version.desc');
  endpoint.searchParams.set('limit', '50');

  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: 'GET',
      headers: authHeaders(config, token),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'forbidden' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let rows;
  try {
    rows = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!Array.isArray(rows)) return { ok: false, reason: 'upstream' };

  const entries = [];
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (!Number.isSafeInteger(row.id) || row.id < 1) continue;
    if (!Number.isSafeInteger(row.version) || row.version < 1) continue;
    if (typeof row.created_at !== 'string') continue;
    if (row.note !== null && row.note !== undefined && typeof row.note !== 'string') continue;
    entries.push({
      id: row.id,
      version: row.version,
      note: typeof row.note === 'string' ? row.note.slice(0, MAX_NOTE) : null,
      created_at: row.created_at,
    });
  }

  return { ok: true, entries };
}

function normalizedContent(value) {
  return normalize(value, DEFAULTS);
}

function buildWorking(published, draft) {
  if (!published && !draft) return null;
  const source = draft || published;
  return {
    source: draft ? 'draft' : 'published',
    content: normalizedContent(source.content),
    revision_id: draft ? draft.revision_id : null,
    base_version: draft ? draft.base_version : published.version,
    updated_at: draft ? draft.updated_at : null,
  };
}

async function callRpc(config, token, name, body) {
  let response;
  try {
    response = await fetchWithTimeout(new URL(`/rest/v1/rpc/${name}`, config.base), {
      method: 'POST',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (response.ok) {
    if (!isPlainObject(data)) return { ok: false, reason: 'upstream' };
    return { ok: true, value: data };
  }

  return rpcError(response.status, data);
}

// Some admin RPCs (public-check begin/finish) return a scalar: a bigint id or a
// boolean. They still need the same error mapping, but not the object check.
async function callRpcValue(config, token, name, body) {
  let response;
  try {
    response = await fetchWithTimeout(new URL(`/rest/v1/rpc/${name}`, config.base), {
      method: 'POST',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }

  let data;
  let parsed = true;
  try {
    data = await response.json();
  } catch {
    parsed = false;
    data = null;
  }

  if (response.ok) {
    if (!parsed) return { ok: false, reason: 'upstream' };
    return { ok: true, value: data };
  }

  return rpcError(response.status, data);
}

function rpcError(status, data) {
  const code = data && typeof data.code === 'string' ? data.code : '';
  if (status === 401 || code === '28000') return { ok: false, reason: 'unauthorized' };
  if (status === 403 || code === '42501') return { ok: false, reason: 'forbidden' };
  // PT409 is the PostgREST convention for an immediate HTTP 409. 40001 is kept
  // for compatibility, but the database must not raise it: PostgREST retries
  // serialization failures until the upstream request times out.
  if (status === 409 || code === 'PT409' || code === '40001') return { ok: false, reason: 'conflict' };
  // CC001 is raised by assert_publishable_media when content references an
  // uploaded asset that has no ready public copy. The API prepares copies before
  // calling admin_publish, so reaching this usually means a direct caller or a
  // race; the request can be retried through the publish flow.
  if (code === 'CC001') return { ok: false, reason: 'media_not_ready' };
  if (code === 'P0002') return { ok: false, reason: 'not_found' };
  if (status === 400 || status === 422
    || code === '22023' || code === '22P02' || code === '23514') {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: false, reason: 'upstream' };
}

// ---------------------------------------------------------------------------
// Site display state
//
// The state tables are never read or written directly by this Function. Reads
// and writes both go through SECURITY DEFINER RPCs that call assert_admin()
// again. The RPC result is the only source of revision, time, and actor data.
// ---------------------------------------------------------------------------

function siteStatusValue(value) {
  if (!isPlainObject(value)) return null;
  if (value.state !== 'running' && value.state !== 'stopped') return null;
  if (typeof value.message !== 'string'
    || [...value.message].length > MAX_SITE_MESSAGE_CHARS) return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) return null;
  if (typeof value.updated_at !== 'string') return null;
  if (!isPlainObject(value.changed_by)) return null;
  if (value.changed_by.id !== null && typeof value.changed_by.id !== 'string') return null;
  if (typeof value.changed_by.email !== 'string') return null;

  return {
    state: value.state,
    message: value.message,
    revision: value.revision,
    updated_at: value.updated_at,
    changed_by: {
      id: value.changed_by.id,
      email: value.changed_by.email,
    },
  };
}

function siteStatusWriteValue(value, operationId) {
  const status = siteStatusValue(value);
  if (!status) return null;
  if (value.operation_id !== operationId) return null;
  if (typeof value.idempotent !== 'boolean') return null;
  return {
    ...status,
    operation_id: operationId,
    idempotent: value.idempotent,
  };
}

function parseSiteStatusBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (data.state !== 'running' && data.state !== 'stopped') return { ok: false, reason: 'invalid' };

  const message = data.message === undefined || data.message === null ? '' : data.message;
  if (typeof message !== 'string') return { ok: false, reason: 'invalid' };
  if ([...message].length > MAX_SITE_MESSAGE_CHARS) return { ok: false, reason: 'invalid' };
  if (data.state === 'running' && message !== '') return { ok: false, reason: 'invalid' };
  if (!Number.isSafeInteger(data.expected_revision) || data.expected_revision < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }

  return {
    ok: true,
    value: {
      state: data.state,
      message,
      expected_revision: data.expected_revision,
      operation_id: data.operation_id,
    },
  };
}

function siteStatusFailure(reason) {
  if (reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
  if (reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
  if (reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
  if (reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
  return jsonResponse(502, { error: 'upstream_unavailable' });
}

// ---------------------------------------------------------------------------
// Private media helpers
//
// The server never accepts a download URL from the client. Object names come
// from media_assets rows that were created by admin_media_create, and are
// re-validated against MEDIA_PATH_RE before any Storage request.
// ---------------------------------------------------------------------------

function mediaFinalizeToken() {
  const raw = String(process.env.CCAFE_MEDIA_FINALIZE_TOKEN || '').trim();
  if (raw.length < 32 || raw.length > 256) return '';
  return raw;
}

function emptyMediaLimits() {
  return {
    max_bytes: MEDIA_MAX_BYTES,
    max_dimension: MEDIA_MAX_DIMENSION,
    max_pixels: MEDIA_MAX_PIXELS,
    mime_types: ['image/png', 'image/jpeg', 'image/webp'],
    preview_ttl_seconds: MEDIA_URL_TTL_SECONDS,
  };
}

function mediaRow(row) {
  if (!isPlainObject(row)) return null;
  if (typeof row.id !== 'string' || !UUID_RE.test(row.id)) return null;
  if (typeof row.logical_path !== 'string' || !MEDIA_PATH_RE.test(row.logical_path)) return null;
  if (row.logical_path !== `media/${row.id}`) return null;
  if (!['pending', 'approved', 'failed'].includes(row.status)) return null;
  if (typeof row.original_name !== 'string' || row.original_name.length > MAX_ORIGINAL_NAME) return null;
  if (typeof row.created_at !== 'string') return null;

  const item = {
    id: row.id,
    logical_path: row.logical_path,
    status: row.status,
    original_name: row.original_name,
    created_at: row.created_at,
    finalized_at: typeof row.finalized_at === 'string' ? row.finalized_at : null,
    selectable: row.status === 'approved',
  };
  if (row.status === 'approved') {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(row.mime)) return null;
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > MEDIA_MAX_BYTES) return null;
    if (!Number.isSafeInteger(row.width) || !Number.isSafeInteger(row.height)) return null;
    if (row.width < 1 || row.height < 1
      || row.width > MEDIA_MAX_DIMENSION || row.height > MEDIA_MAX_DIMENSION) return null;
    if (row.width * row.height > MEDIA_MAX_PIXELS) return null;
    item.mime = row.mime;
    item.bytes = row.bytes;
    item.width = row.width;
    item.height = row.height;
  } else {
    item.failure_reason = typeof row.failure_reason === 'string'
      ? row.failure_reason.slice(0, 200)
      : null;
  }
  return item;
}

function publicMediaAsset(asset) {
  return {
    id: asset.id,
    logical_path: asset.logical_path,
    status: asset.status,
    original_name: asset.original_name,
    selectable: asset.status === 'approved',
    mime: asset.mime || null,
    bytes: asset.bytes || null,
    width: asset.width || null,
    height: asset.height || null,
    created_at: asset.created_at,
    finalized_at: asset.finalized_at || null,
    failure_reason: asset.failure_reason || null,
  };
}

async function readMediaList(config, token) {
  const endpoint = new URL('/rest/v1/media_assets', config.base);
  endpoint.searchParams.set(
    'select',
    'id,logical_path,status,original_name,mime,bytes,width,height,failure_reason,created_at,finalized_at',
  );
  // The active library never includes deleting/trashed/restoring rows: they are
  // listed separately from media_trash so a trash state cannot be selected in
  // the editor and cannot make this list fail validation.
  endpoint.searchParams.set('status', 'in.(pending,approved,failed)');
  endpoint.searchParams.set('order', 'created_at.desc');
  endpoint.searchParams.set('limit', String(MAX_MEDIA_LIST));

  let response;
  try {
    response = await fetchWithTimeout(endpoint, { method: 'GET', headers: authHeaders(config, token) });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'forbidden' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let rows;
  try {
    rows = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!Array.isArray(rows) || rows.length > MAX_MEDIA_LIST) return { ok: false, reason: 'upstream' };
  const assets = rows.map(mediaRow).filter(Boolean);
  if (assets.length !== rows.length) return { ok: false, reason: 'upstream' };
  return { ok: true, assets };
}

async function readMediaAsset(config, token, id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) return { ok: false, reason: 'invalid' };
  const endpoint = new URL('/rest/v1/media_assets', config.base);
  endpoint.searchParams.set(
    'select',
    'id,logical_path,status,original_name,declared_mime,declared_bytes,mime,bytes,width,height,failure_reason,created_at,finalized_at,created_by',
  );
  endpoint.searchParams.set('id', `eq.${id}`);
  endpoint.searchParams.set('limit', '1');

  let response;
  try {
    response = await fetchWithTimeout(endpoint, { method: 'GET', headers: authHeaders(config, token) });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: response.status === 401 ? 'unauthorized' : 'forbidden' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let rows;
  try {
    rows = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!Array.isArray(rows) || rows.length > 1) return { ok: false, reason: 'upstream' };
  if (rows.length === 0) return { ok: true, asset: null };

  const row = rows[0];
  const item = mediaRow(row);
  if (!item) return { ok: false, reason: 'upstream' };
  item.created_by = typeof row.created_by === 'string' ? row.created_by : '';
  item.declared_mime = typeof row.declared_mime === 'string' ? row.declared_mime : '';
  item.declared_bytes = Number.isSafeInteger(row.declared_bytes) ? row.declared_bytes : 0;
  return { ok: true, asset: item };
}

async function mediaPreviewUrls(config, token, refs) {
  const paths = [...new Set(refs)].slice(0, 100);
  if (!paths.length) return {};
  const endpoint = new URL('/rest/v1/media_assets', config.base);
  endpoint.searchParams.set('select', 'id,logical_path');
  endpoint.searchParams.set('status', 'eq.approved');
  // Do not pre-encode the values here: URLSearchParams encodes the whole filter
  // once, so encodeURIComponent would double-encode the slash in `media/<uuid>`
  // and PostgREST would compare against `media%2F...` (never matching). Values
  // are quoted so the `in.(...)` list stays unambiguous.
  endpoint.searchParams.set(
    'logical_path',
    `in.(${paths.map((p) => `"${p}"`).join(',')})`,
  );
  endpoint.searchParams.set('limit', String(paths.length));

  let response;
  try {
    response = await fetchWithTimeout(endpoint, { method: 'GET', headers: authHeaders(config, token) });
  } catch {
    return {};
  }
  if (!response.ok) return {};

  let rows;
  try {
    rows = await response.json();
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) return {};

  const assets = rows.filter((row) => isPlainObject(row)
    && typeof row.id === 'string'
    && UUID_RE.test(row.id)
    && typeof row.logical_path === 'string'
    && MEDIA_PATH_RE.test(row.logical_path)
    && row.logical_path === `media/${row.id}`);
  const ready = await readReadyPublicPaths(config, token, assets.map((row) => row.id));

  const entries = await Promise.all(assets.map(async (row) => {
    const objectPath = ready[row.id];
    if (objectPath) return [row.logical_path, publicMediaUrl(config, objectPath)];
    const signed = await signMediaObject(config, token, row.logical_path);
    return signed.ok ? [row.logical_path, signed.url] : null;
  }));
  return signedUrlMap(entries.filter(Boolean));
}

// The admin preview prefers the permanent public URL for a ready copy and falls
// back to a short-lived signed URL for private (staging/not-yet-public) assets.
async function readReadyPublicPaths(config, token, assetIds) {
  const ids = [...new Set(assetIds)].slice(0, 100);
  if (!ids.length) return {};
  const endpoint = new URL('/rest/v1/media_public_assets', config.base);
  endpoint.searchParams.set('select', 'asset_id,object_path');
  endpoint.searchParams.set('state', 'eq.ready');
  endpoint.searchParams.set('asset_id', `in.(${ids.join(',')})`);
  endpoint.searchParams.set('limit', String(ids.length));

  let response;
  try {
    response = await fetchWithTimeout(endpoint, { method: 'GET', headers: authHeaders(config, token) });
  } catch {
    return {};
  }
  if (!response.ok) return {};

  let rows;
  try {
    rows = await response.json();
  } catch {
    return {};
  }
  if (!Array.isArray(rows)) return {};

  const map = {};
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (typeof row.asset_id !== 'string' || !UUID_RE.test(row.asset_id)) continue;
    if (typeof row.object_path !== 'string' || !PUBLIC_MEDIA_PATH_RE.test(row.object_path)) continue;
    map[row.asset_id] = row.object_path;
  }
  return map;
}

function publicMediaUrl(config, path) {
  return new URL(`/storage/v1/object/public/${PUBLIC_MEDIA_BUCKET}/${path}`, config.base).toString();
}

function publicMediaObjectUrl(config, path) {
  return new URL(`/storage/v1/object/${PUBLIC_MEDIA_BUCKET}/${path}`, config.base);
}

async function publicObjectExists(config, path) {
  if (!PUBLIC_MEDIA_PATH_RE.test(path)) return false;
  try {
    const response = await fetchWithTimeout(publicMediaUrl(config, path), {
      method: 'HEAD',
      redirect: 'error',
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function uploadPublicObject(config, token, path, mime, buffer) {
  if (!PUBLIC_MEDIA_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(publicMediaObjectUrl(config, path), {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': mime,
        'x-upsert': 'false',
        'cache-control': 'max-age=31536000',
      },
      body: buffer,
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  // The object name is immutable: an existing name is a previous attempt with
  // the same approved bytes, so do not replace it. The caller re-reads and
  // verifies the public bytes before confirming.
  if (response.status === 409) return { ok: true, existed: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'forbidden' };
  if (!response.ok) return { ok: false, reason: 'upstream' };
  return { ok: true, existed: false };
}

async function downloadPublicObject(config, path) {
  if (!PUBLIC_MEDIA_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  let lastReason = 'upstream';
  // No Authorization/apikey header: this is exactly what an anonymous visitor
  // receives from the public bucket.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout(publicMediaUrl(config, path), {
        method: 'GET',
        redirect: 'error',
        headers: { Accept: 'application/octet-stream' },
      });
    } catch {
      lastReason = 'upstream';
    }
    if (response) {
      if (response.status === 404) {
        lastReason = 'not_found';
      } else if (!response.ok) {
        lastReason = response.status === 403 ? 'forbidden' : 'upstream';
      } else {
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MEDIA_MAX_BYTES) {
          return { ok: false, reason: 'too_large' };
        }
        let buffer;
        try {
          buffer = Buffer.from(await response.arrayBuffer());
        } catch {
          return { ok: false, reason: 'upstream' };
        }
        if (buffer.length > MEDIA_MAX_BYTES) return { ok: false, reason: 'too_large' };
        return { ok: true, buffer };
      }
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { ok: false, reason: lastReason };
}

function mediaObjectUrl(config, path) {
  return new URL(`/storage/v1/object/${MEDIA_BUCKET}/${path}`, config.base);
}

async function downloadMediaObject(config, token, path) {
  if (!MEDIA_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(mediaObjectUrl(config, path), {
      method: 'GET',
      redirect: 'error',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream',
      },
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'forbidden' };
  if (response.status === 404) return { ok: false, reason: 'not_found' };
  if (!response.ok) {
    if (await storageObjectAlreadyMissing(response)) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'upstream' };
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MEDIA_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (buffer.length > MEDIA_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true, buffer };
}

async function signMediaObject(config, token, path) {
  if (!MEDIA_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(
      new URL(`/storage/v1/object/sign/${MEDIA_BUCKET}/${path}`, config.base),
      {
        method: 'POST',
        headers: { ...authHeaders(config, token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: MEDIA_URL_TTL_SECONDS }),
      },
    );
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (!response.ok) return { ok: false, reason: 'upstream' };

  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  const signed = data && typeof data.signedURL === 'string' ? data.signedURL : '';
  if (!signed) return { ok: false, reason: 'upstream' };

  let url;
  if (/^https?:\/\//i.test(signed)) {
    url = signed;
  } else if (signed.startsWith('/object/sign/')) {
    url = `${config.base}/storage/v1${signed}`;
  } else if (signed.startsWith('/storage/v1/')) {
    url = `${config.base}${signed}`;
  } else {
    return { ok: false, reason: 'upstream' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'upstream' };
  }
  return { ok: true, url, expires_in: MEDIA_URL_TTL_SECONDS };
}

// Supabase Storage returns "404 Not Found" inside a 400 response body for an
// already-missing object, so a cleanup retry must treat that as success. Reading
// the body here keeps a second delete (delete -> restore -> delete) from being
// reported as a pending cleanup forever.
async function storageObjectAlreadyMissing(response) {
  if (response.status === 404) return true;
  if (response.status !== 400) return false;
  try {
    const body = await response.json();
    return Boolean(body) && (body.statusCode === 404 || body.statusCode === '404' || body.error === 'not_found');
  } catch {
    return false;
  }
}

async function deleteMediaObject(config, token, path) {
  if (!MEDIA_PATH_RE.test(path)) return false;
  try {
    const response = await fetchWithTimeout(mediaObjectUrl(config, path), {
      method: 'DELETE',
      headers: authHeaders(config, token),
    });
    return response.ok || await storageObjectAlreadyMissing(response);
  } catch {
    return false;
  }
}

// The public copy is deleted by its exact registered name only, and only after
// admin_media_delete_finish has marked the row failed (the Storage DELETE policy
// accepts staging/failed copies). Removing the object does not remove cached
// copies already held by browsers or a CDN.
async function deletePublicObject(config, token, path) {
  if (!PUBLIC_MEDIA_PATH_RE.test(path)) return false;
  try {
    const response = await fetchWithTimeout(publicMediaObjectUrl(config, path), {
      method: 'DELETE',
      headers: authHeaders(config, token),
    });
    return response.ok || await storageObjectAlreadyMissing(response);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trash helpers
//
// The trash object name is allocated by admin_media_delete_begin and is only
// ever taken from that RPC response. It is re-validated here before any Storage
// request, and the browser never receives it.
// ---------------------------------------------------------------------------

function trashObjectUrl(config, path) {
  return new URL(`/storage/v1/object/${TRASH_BUCKET}/${path}`, config.base);
}

async function uploadTrashObject(config, token, path, mime, buffer) {
  if (!TRASH_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(trashObjectUrl(config, path), {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': mime,
        'x-upsert': 'false',
        'cache-control': 'no-store',
      },
      body: buffer,
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  // A retry of the same operation reuses the same trash name. An existing
  // object is accepted here and re-read below so its bytes are still verified.
  if (response.status === 409) return { ok: true, existed: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'forbidden' };
  if (!response.ok) return { ok: false, reason: 'upstream' };
  return { ok: true, existed: false };
}

async function downloadTrashObject(config, token, path) {
  if (!TRASH_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(trashObjectUrl(config, path), {
      method: 'GET',
      redirect: 'error',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token}`,
        Accept: 'application/octet-stream',
      },
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'forbidden' };
  if (response.status === 404) return { ok: false, reason: 'not_found' };
  if (!response.ok) {
    if (await storageObjectAlreadyMissing(response)) return { ok: false, reason: 'not_found' };
    return { ok: false, reason: 'upstream' };
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MEDIA_MAX_BYTES) {
    return { ok: false, reason: 'too_large' };
  }

  let buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (buffer.length > MEDIA_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true, buffer };
}

// Write the restored bytes back to the exact original private name. There is no
// UPDATE policy, so an existing object reports 409; the caller re-reads it and
// verifies those bytes instead of replacing them.
async function deleteTrashObject(config, token, path) {
  if (!TRASH_PATH_RE.test(path)) return false;
  let response;
  try {
    response = await fetchWithTimeout(trashObjectUrl(config, path), {
      method: 'DELETE',
      redirect: 'manual',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${token}`,
      },
    }, 8000);
  } catch {
    return false;
  }
  if (response.ok) return true;
  if (response.status === 404) return true;
  if (response.status === 400) {
    try {
      const body = await response.json();
      if (body && (body.error === 'not_found' || body.statusCode === '404')) return true;
    } catch {}
  }
  return false;
}
async function uploadMediaObject(config, token, path, mime, buffer) {
  if (!MEDIA_PATH_RE.test(path)) return { ok: false, reason: 'invalid' };
  if (!Buffer.isBuffer(buffer) || buffer.length < 1) return { ok: false, reason: 'invalid' };
  let response;
  try {
    response = await fetchWithTimeout(mediaObjectUrl(config, path), {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...authHeaders(config, token),
        'Content-Type': mime,
        'x-upsert': 'false',
      },
      body: buffer,
    });
  } catch {
    return { ok: false, reason: 'upstream' };
  }
  if (response.status === 409) return { ok: true, existed: true };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'forbidden' };
  if (!response.ok) return { ok: false, reason: 'upstream' };
  return { ok: true, existed: false };
}

// Re-derive MIME/size/dimensions/digest and compare them with the database
// values. The database values came from the approved row, so matching bytes are
// the only accepted trash copy or restore source.
async function verifyMediaBytes(buffer, expected) {
  const verified = await verifyImage(buffer, { declaredMime: expected.mime });
  if (!verified.ok) return { ok: false, reason: verified.reason };
  if (verified.sha256 !== expected.sha256
    || verified.bytes !== expected.bytes
    || verified.width !== expected.width
    || verified.height !== expected.height
    || verified.pixel_count !== expected.pixel_count) {
    return { ok: false, reason: 'digest_mismatch' };
  }
  return { ok: true, value: verified };
}

function trashAssetFrom(value, assetId) {
  if (!isPlainObject(value)) return null;
  if (value.asset_id !== assetId) return null;
  if (typeof value.logical_path !== 'string' || value.logical_path !== `media/${assetId}`) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MEDIA_MAX_BYTES) return null;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1
    || value.width > MEDIA_MAX_DIMENSION || value.height > MEDIA_MAX_DIMENSION
    || value.width * value.height > MEDIA_MAX_PIXELS) {
    return null;
  }
  if (!Number.isSafeInteger(value.pixel_count)
    || value.pixel_count < 1 || value.pixel_count > MEDIA_MAX_PIXELS) {
    return null;
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  if (typeof value.object_path !== 'string' || !TRASH_PATH_RE.test(value.object_path)) return null;
  return {
    id: assetId,
    logical_path: value.logical_path,
    mime: value.mime,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    pixel_count: value.pixel_count,
    sha256: value.sha256,
    trash_object_path: value.object_path,
  };
}

function restoreAssetFrom(value, assetId) {
  if (!isPlainObject(value)) return null;
  if (value.asset_id !== assetId) return null;
  if (typeof value.logical_path !== 'string' || value.logical_path !== `media/${assetId}`) return null;
  if (value.storage_path !== value.logical_path) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MEDIA_MAX_BYTES) return null;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || value.width < 1 || value.height < 1
    || value.width > MEDIA_MAX_DIMENSION || value.height > MEDIA_MAX_DIMENSION
    || value.width * value.height > MEDIA_MAX_PIXELS) {
    return null;
  }
  if (!Number.isSafeInteger(value.pixel_count)
    || value.pixel_count < 1 || value.pixel_count > MEDIA_MAX_PIXELS) {
    return null;
  }
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  if (typeof value.trash_object_path !== 'string' || !TRASH_PATH_RE.test(value.trash_object_path)) {
    return null;
  }
  if (value.public_object_path !== null && value.public_object_path !== undefined
    && (typeof value.public_object_path !== 'string'
      || !PUBLIC_MEDIA_PATH_RE.test(value.public_object_path))) {
    return null;
  }
  return {
    id: assetId,
    logical_path: value.logical_path,
    storage_path: value.storage_path,
    mime: value.mime,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    pixel_count: value.pixel_count,
    sha256: value.sha256,
    trash_object_path: value.trash_object_path,
    public_object_path: typeof value.public_object_path === 'string'
      ? value.public_object_path
      : null,
  };
}

const USAGE_REASONS = new Set(['not_approved', 'published', 'draft', 'history']);

function mediaUsagePayload(value, assetId) {
  if (!isPlainObject(value) || value.asset_id !== assetId) return null;
  if (typeof value.deletable !== 'boolean') return null;
  if (typeof value.status !== 'string') return null;
  const reasons = Array.isArray(value.reasons)
    ? value.reasons.filter((item) => typeof item === 'string' && USAGE_REASONS.has(item))
    : [];
  const refs = isPlainObject(value.references) ? value.references : {};
  return {
    asset_id: assetId,
    logical_path: typeof value.logical_path === 'string' ? value.logical_path : '',
    original_name: typeof value.original_name === 'string'
      ? value.original_name.slice(0, MAX_ORIGINAL_NAME)
      : '',
    status: value.status.slice(0, 40),
    deletable: value.deletable,
    reasons,
    references: {
      published: refs.published === true,
      draft: refs.draft === true,
      history_count: Number.isSafeInteger(refs.history_count) && refs.history_count > 0
        ? refs.history_count
        : 0,
      public_state: typeof refs.public_state === 'string' ? refs.public_state.slice(0, 40) : null,
      public_linked_version: Number.isSafeInteger(refs.public_linked_version)
        ? refs.public_linked_version
        : null,
    },
  };
}

function trashListItem(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.asset_id !== 'string' || !UUID_RE.test(value.asset_id)) return null;
  if (value.logical_path !== `media/${value.asset_id}`) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MEDIA_MAX_BYTES) return null;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
  if (value.width < 1 || value.height < 1
    || value.width > MEDIA_MAX_DIMENSION || value.height > MEDIA_MAX_DIMENSION) return null;
  if (typeof value.original_name !== 'string') return null;
  if (value.state !== 'trashed' && value.state !== 'restoring' && value.state !== 'purging') return null;
  if (value.cleanup_state !== 'pending' && value.cleanup_state !== 'done') return null;
  if (value.public_cleanup_state !== undefined
    && value.public_cleanup_state !== 'none'
    && value.public_cleanup_state !== 'pending'
    && value.public_cleanup_state !== 'done') return null;
  return {
    asset_id: value.asset_id,
    logical_path: value.logical_path,
    original_name: value.original_name.slice(0, MAX_ORIGINAL_NAME),
    mime: value.mime,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    deleted_at: typeof value.deleted_at === 'string' ? value.deleted_at : null,
    state: value.state,
    purge_operation_id: typeof value.purge_operation_id === 'string'
      && UUID_RE.test(value.purge_operation_id)
      ? value.purge_operation_id
      : null,
    cleanup_state: value.cleanup_state,
    cleanup_error: typeof value.cleanup_error === 'string' ? value.cleanup_error.slice(0, 200) : null,
    public_cleanup_state: value.public_cleanup_state === 'pending' || value.public_cleanup_state === 'done'
      ? value.public_cleanup_state
      : 'none',
    public_cleanup_error: typeof value.public_cleanup_error === 'string'
      ? value.public_cleanup_error.slice(0, 200)
      : null,
    restore_error: typeof value.restore_error === 'string' ? value.restore_error.slice(0, 200) : null,
  };
}

async function abortMediaDelete(config, token, tokenValue, assetId, operationId, reason) {
  const result = await callRpc(config, token, 'admin_media_delete_abort', {
    p_asset_id: assetId,
    p_token: tokenValue,
    p_operation_id: operationId,
    p_reason: String(reason || 'delete_failed').slice(0, 200),
  });
  return result.ok && isPlainObject(result.value) && result.value.state === 'approved';
}

async function abortMediaRestore(config, token, tokenValue, assetId, operationId, reason) {
  const result = await callRpc(config, token, 'admin_media_restore_abort', {
    p_asset_id: assetId,
    p_token: tokenValue,
    p_operation_id: operationId,
    p_reason: String(reason || 'restore_failed').slice(0, 200),
  });
  return result.ok && isPlainObject(result.value) && result.value.state === 'trashed';
}

async function retryTrashCleanup(config, token, tokenValue, assetId, operationId) {
  // The exact public object name lives only in the database. Ask the server-only
  // RPC before touching Storage; a missing target means nothing can be recorded.
  const targetsResult = await callRpc(config, token, 'admin_media_cleanup_targets', {
    p_asset_id: assetId,
    p_token: tokenValue,
  });
  if (!targetsResult.ok || !isPlainObject(targetsResult.value)) {
    return {
      done: false,
      error: null,
      public_done: null,
      public_error: null,
      recorded: false,
    };
  }
  const targets = targetsResult.value;
  if (targets.asset_id !== assetId) {
    return {
      done: false,
      error: null,
      public_done: null,
      public_error: null,
      recorded: false,
    };
  }
  const publicPath = typeof targets.public_object_path === 'string'
    && PUBLIC_MEDIA_PATH_RE.test(targets.public_object_path)
    ? targets.public_object_path
    : null;
  const publicState = targets.public_cleanup_state === 'pending'
    || targets.public_cleanup_state === 'done'
    ? targets.public_cleanup_state
    : 'none';

  const deleted = await deleteMediaObject(config, token, `media/${assetId}`);
  let publicDone = null;
  let publicError = null;
  if (publicPath && publicState === 'pending') {
    publicDone = await deletePublicObject(config, token, publicPath);
    publicError = publicDone ? null : 'public_object_delete_failed';
  } else if (publicPath && publicState === 'done') {
    publicDone = true;
  }

  const result = await callRpc(config, token, 'admin_media_delete_cleanup', {
    p_asset_id: assetId,
    p_token: tokenValue,
    p_operation_id: operationId,
    p_done: deleted,
    p_error: deleted ? null : 'object_delete_failed',
    p_public_done: publicDone,
    p_public_error: publicError,
  });
  if (!result.ok || !isPlainObject(result.value)) {
    return {
      done: deleted,
      error: deleted ? null : 'object_delete_failed',
      public_done: publicDone,
      public_error: publicError,
      recorded: false,
    };
  }
  const publicCleanupState = result.value.public_cleanup_state;
  return {
    done: result.value.cleanup_state === 'done',
    error: typeof result.value.cleanup_error === 'string' ? result.value.cleanup_error : null,
    public_done: publicCleanupState === 'done'
      ? true
      : publicCleanupState === 'pending' ? false : null,
    public_error: typeof result.value.public_cleanup_error === 'string'
      ? result.value.public_cleanup_error
      : null,
    recorded: true,
  };
}

function mediaRpcFailure(reason) {
  if (reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
  if (reason === 'not_found') return jsonResponse(404, { error: 'not_found' });
  if (reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
  // A forbidden/unauthorized response on a finalize-token RPC means the server
  // secret does not match the stored fingerprint, not a caller permission issue
  // (the admin check already ran).
  if (reason === 'forbidden' || reason === 'unauthorized') {
    return jsonResponse(503, { error: 'media_unavailable' });
  }
  return jsonResponse(502, { error: 'upstream_unavailable' });
}

function mediaStorageFailure(reason) {
  if (reason === 'not_found') return jsonResponse(409, { error: 'media_object_missing' });
  if (reason === 'too_large') return jsonResponse(422, { error: 'invalid_image', reason: 'too_large' });
  return jsonResponse(502, { error: 'storage_unavailable' });
}

function mediaPublicAsset(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== 'string' || !UUID_RE.test(value.id)) return null;
  if (value.logical_path !== `media/${value.id}`) return null;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MEDIA_MAX_BYTES) return null;
  if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) return null;
  if (typeof value.public_state !== 'string') return null;
  if (value.object_path !== null && value.object_path !== undefined
    && (typeof value.object_path !== 'string' || !PUBLIC_MEDIA_PATH_RE.test(value.object_path))) {
    return null;
  }
  return value;
}

async function failPublicCopy(config, token, tokenValue, assetId, reason) {
  if (!tokenValue) return;
  await callRpc(config, token, 'admin_media_fail_public', {
    p_asset_id: assetId,
    p_token: tokenValue,
    p_reason: String(reason || 'prepare_failed').slice(0, 200),
  });
}

// Copy one approved private object into the public bucket, then read it back
// without credentials and verify the digest. Nothing is linked to a published
// version until admin_publish runs, so a failure here leaves both the live
// version and the draft untouched.
async function preparePublicCopy(config, token, tokenValue, asset) {
  const prepared = await callRpc(config, token, 'admin_media_prepare_public', {
    p_asset_id: asset.id,
    p_token: tokenValue,
  });
  if (!prepared.ok) return { ok: false, reason: prepared.reason };
  const copy = prepared.value;
  if (!isPlainObject(copy)
    || copy.asset_id !== asset.id
    || typeof copy.object_path !== 'string'
    || !PUBLIC_MEDIA_PATH_RE.test(copy.object_path)
    || (copy.state !== 'staging' && copy.state !== 'ready')) {
    return { ok: false, reason: 'upstream' };
  }
  if (copy.sha256 !== asset.sha256) return { ok: false, reason: 'digest' };

  if (copy.state === 'staging') {
    const exists = await publicObjectExists(config, copy.object_path);
    if (!exists) {
      const download = await downloadMediaObject(config, token, asset.logical_path);
      if (!download.ok) return { ok: false, reason: download.reason };
      const verified = await verifyImage(download.buffer);
      if (!verified.ok) return { ok: false, reason: verified.reason };
      if (verified.sha256 !== asset.sha256
        || verified.mime !== asset.mime
        || verified.bytes !== asset.bytes) {
        return { ok: false, reason: 'digest' };
      }
      const upload = await uploadPublicObject(config, token, copy.object_path, verified.mime, download.buffer);
      if (!upload.ok) return { ok: false, reason: upload.reason };
    }
  }

  const published = await downloadPublicObject(config, copy.object_path);
  if (!published.ok) return { ok: false, reason: published.reason };
  const publicVerified = await verifyImage(published.buffer);
  if (!publicVerified.ok) return { ok: false, reason: publicVerified.reason };
  if (publicVerified.sha256 !== asset.sha256
    || publicVerified.mime !== asset.mime
    || publicVerified.bytes !== asset.bytes) {
    return { ok: false, reason: 'digest' };
  }

  const confirmed = await callRpc(config, token, 'admin_media_confirm_public', {
    p_asset_id: asset.id,
    p_token: tokenValue,
    p_sha256: asset.sha256,
  });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };
  const result = confirmed.value;
  if (!isPlainObject(result)
    || result.asset_id !== asset.id
    || result.state !== 'ready'
    || result.sha256 !== asset.sha256) {
    return { ok: false, reason: 'upstream' };
  }
  return { ok: true };
}

async function preparePublicCopies(config, token, tokenValue, begun) {
  const assets = Array.isArray(begun.assets) ? begun.assets : [];
  const needs = Array.isArray(begun.needs_prepare) ? begun.needs_prepare : [];
  const byPath = new Map();
  for (const value of assets) {
    const asset = mediaPublicAsset(value);
    if (!asset) return { ok: false, reason: 'upstream' };
    byPath.set(asset.logical_path, asset);
  }

  for (const ref of needs) {
    const asset = byPath.get(ref);
    if (!asset) return { ok: false, reason: 'upstream' };
    if (!mediaFinalizeToken()) return { ok: false, reason: 'token' };
    const result = await preparePublicCopy(config, token, tokenValue, asset);
    if (!result.ok) {
      await failPublicCopy(config, token, tokenValue, asset.id, result.reason);
      return { ok: false, reason: result.reason };
    }
  }
  return { ok: true };
}

function signedUrlMap(entries) {
  const map = {};
  for (const [path, url] of entries) {
    if (typeof path === 'string' && typeof url === 'string') map[path] = url;
  }
  return map;
}

function bodyText(event) {
  const raw = typeof event.body === 'string'
    ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
    : '';
  if (!raw) return { ok: false, reason: 'invalid' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true, value: raw };
}

function parseDraftBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };

  if (!Number.isSafeInteger(data.expected_version) || data.expected_version < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (data.expected_revision !== null
    && (typeof data.expected_revision !== 'string' || !UUID_RE.test(data.expected_revision))) {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data.content)) return { ok: false, reason: 'invalid' };
  return { ok: true, value: data };
}

function parseDeleteBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (!Number.isSafeInteger(data.expected_version) || data.expected_version < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (data.expected_revision !== null
    && (typeof data.expected_revision !== 'string' || !UUID_RE.test(data.expected_revision))) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: data };
}

function operationNote(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== 'string' || value.length > MAX_OPERATION_NOTE) {
    return { ok: false, reason: 'invalid' };
  }
  const note = value.trim();
  return { ok: true, value: note === '' ? null : note };
}

function parsePublishBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };

  if (!Number.isSafeInteger(data.expected_version) || data.expected_version < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.expected_draft_revision !== 'string'
    || !UUID_RE.test(data.expected_draft_revision)) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  const note = operationNote(data.note);
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      expected_version: data.expected_version,
      expected_draft_revision: data.expected_draft_revision,
      operation_id: data.operation_id,
      note: note.value,
    },
  };
}

function parseRestoreBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };

  if (!Number.isSafeInteger(data.history_id) || data.history_id < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (!Number.isSafeInteger(data.expected_version) || data.expected_version < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  const note = operationNote(data.note);
  if (!note.ok) return note;

  return {
    ok: true,
    value: {
      history_id: data.history_id,
      expected_version: data.expected_version,
      operation_id: data.operation_id,
      note: note.value,
    },
  };
}

function parseHistoryClearBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };

  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (data.confirmation !== 'حذف السجل نهائيًا') {
    return { ok: false, reason: 'invalid' };
  }

  return {
    ok: true,
    value: {
      operation_id: data.operation_id,
      confirmation: data.confirmation,
    },
  };
}


function parseHistoryDeleteBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };

  if (!Number.isSafeInteger(data.history_id) || data.history_id < 1) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (data.confirmation !== 'حذف هذه النسخة نهائيًا') {
    return { ok: false, reason: 'invalid' };
  }

  return {
    ok: true,
    value: {
      history_id: data.history_id,
      operation_id: data.operation_id,
      confirmation: data.confirmation,
    },
  };
}

function parseMediaPurgeBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (typeof data.asset_id !== 'string' || !UUID_RE.test(data.asset_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  if (data.confirmation !== 'حذف الصورة نهائيًا') {
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    value: {
      asset_id: data.asset_id,
      operation_id: data.operation_id,
      confirmation: data.confirmation,
    },
  };
}
function parseMediaCreateBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (typeof data.original_name !== 'string') return { ok: false, reason: 'invalid' };
  const name = data.original_name.trim();
  if (!name || name.length > MAX_ORIGINAL_NAME || /[\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(data.declared_mime)) {
    return { ok: false, reason: 'invalid' };
  }
  if (!Number.isSafeInteger(data.declared_bytes)
    || data.declared_bytes < 1
    || data.declared_bytes > MEDIA_MAX_BYTES) {
    return { ok: false, reason: 'invalid' };
  }
  return {
    ok: true,
    value: {
      original_name: name,
      declared_mime: data.declared_mime,
      declared_bytes: data.declared_bytes,
    },
  };
}

function parseMediaIdBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (typeof data.asset_id !== 'string' || !UUID_RE.test(data.asset_id)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: { asset_id: data.asset_id } };
}

function parseMediaOperationBody(event) {
  const body = bodyText(event);
  if (!body.ok) return body;

  let data;
  try {
    data = JSON.parse(body.value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isPlainObject(data)) return { ok: false, reason: 'invalid' };
  if (typeof data.asset_id !== 'string' || !UUID_RE.test(data.asset_id)) {
    return { ok: false, reason: 'invalid' };
  }
  // The client supplies the idempotency key, exactly like publish/restore. It is
  // never used as a credential; it only prevents a double click from allocating a
  // second trash copy.
  if (typeof data.operation_id !== 'string' || !UUID_RE.test(data.operation_id)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, value: { asset_id: data.asset_id, operation_id: data.operation_id } };
}

function parseVerifyQuery(event) {
  const query = event.queryStringParameters;
  if (!query || typeof query !== 'object') return { ok: false, reason: 'invalid' };
  const raw = query.version;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,15}$/.test(raw)) {
    return { ok: false, reason: 'invalid' };
  }
  const version = Number(raw);
  if (!Number.isSafeInteger(version)) return { ok: false, reason: 'invalid' };
  // Any other query parameter (including a client-supplied URL) is ignored on
  // purpose: the fetch target comes only from server configuration.
  return { ok: true, value: { version } };
}

function verifyOrigin(event) {
  // Only server-side signals are used. The order prefers an explicit override,
  // then the deploy's own prime URL, then the server-observed Host header of the
  // admin request. A URL supplied by the client is never read.
  const candidates = [];
  for (const name of ['CCAFE_VERIFY_ORIGIN', 'DEPLOY_PRIME_URL']) {
    const raw = String(process.env[name] || '').trim();
    if (raw) candidates.push(raw);
  }
  const host = String(headerValue(event && event.headers, 'host') || '').trim();
  if (host && !host.includes('/')) candidates.push(`https://${host}`);

  for (const raw of candidates) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (url.username || url.password) continue;
    if (url.pathname !== '/' || url.search || url.hash) continue;
    if (url.port) continue;
    if (!PREVIEW_HOST_RE.test(url.hostname)) continue;
    return url.origin;
  }
  return null;
}

async function readPublicVersion(origin) {
  const endpoint = new URL('/', origin);
  // Cache-busting query only; this is not a purge request and does not depend on
  // any purge mechanism. The site itself still sends no-store.
  endpoint.searchParams.set('_ccafe_verify', String(Date.now()));

  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'text/html',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
    });
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  }

  const source = String(response.headers.get('x-ccafe-source') || '').trim().toLowerCase();

  // A pause page is deliberately not a published-content page: it has no
  // content-version marker at all. Detect the explicit state before reading a
  // marker so a 503 can never be mistaken for a successful publish check.
  if (response.status === 503) {
    const headerState = String(response.headers.get('x-ccafe-site-state') || '').trim().toLowerCase();
    let state = headerState === 'stopped' || headerState === 'unknown' ? headerState : '';
    if (!state) {
      try {
        const body = await response.text();
        const marker = SITE_STATE_MARKER_RE.exec(body);
        const metaState = marker ? marker[1].trim().toLowerCase() : '';
        if (metaState === 'stopped' || metaState === 'unknown') state = metaState;
      } catch {
        // The header is enough; an unreadable body is still not proof.
      }
    }
    if (!state) state = 'unknown';
    return {
      ok: false,
      reason: state === 'stopped' ? 'site_stopped' : 'site_state_unknown',
      siteState: state,
      source,
    };
  }

  if (response.status !== 200) {
    return { ok: false, reason: `http_${response.status}` };
  }

  const headerVersion = String(response.headers.get('x-ccafe-version') || '').trim();

  let html;
  try {
    html = await response.text();
  } catch {
    return { ok: false, reason: 'read_failed' };
  }

  const match = VERSION_MARKER_RE.exec(html);
  const marker = match ? match[1].trim() : '';
  if (!marker) return { ok: false, reason: 'version_marker_missing', source };
  if (!/^[1-9][0-9]{0,15}$/.test(marker)) {
    return { ok: true, source, version: null, reason: 'non_numeric_version' };
  }
  const version = Number(marker);
  if (!Number.isSafeInteger(version)) {
    return { ok: true, source, version: null, reason: 'non_numeric_version' };
  }
  if (headerVersion && headerVersion !== marker) {
    return { ok: true, source, version, reason: 'header_version_mismatch' };
  }
  return { ok: true, source, version };
}

function checkId(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function normalizePath(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/')) return raw;
  return raw.length > 1 ? raw.replace(/\/+$/, '') || '/' : raw;
}

function allowedMethods(pathname) {
  return ROUTES.get(pathname) || null;
}

let stylesCache = null;
function siteStyles() {
  if (stylesCache !== null) return stylesCache;
  try {
    stylesCache = fs.readFileSync(path.join(__dirname, '..', '..', 'dist', 'styles.css'), 'utf8');
  } catch {
    stylesCache = '';
  }
  return stylesCache;
}

function absoluteAssetPaths(html) {
  // The preview is inserted with srcdoc, so relative asset URLs would resolve
  // under /admin/. Rewriting them to root-relative URLs keeps the public design
  // without needing a <base> element (which the strict CSP disables).
  return html.replace(/(["'(])assets\//g, '$1/assets/');
}

function buildPreviewHtml(content, assets) {
  let html = renderPage(content, { preview: true, tracking: false, analytics: false, assets: assets || {} });
  const css = siteStyles();
  html = html.replace(
    /<link rel="stylesheet" href="styles\.css">/i,
    css ? `<style>\n${css}\n</style>` : '',
  );
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script\b[^>]*\/>/gi, '');
  html = absoluteAssetPaths(html);
  const head = [
    '<head>',
    '  <meta name="robots" content="noindex, nofollow">',
    `  <meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`,
  ].join('\n');
  return html.replace('<head>', head);
}

function publishResultPayload(value, input) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.version)
    || value.version < 1
    || typeof value.saved_at !== 'string'
    || value.operation_id !== input.operation_id
    || (value.source !== 'draft' && value.source !== 'content')
    || typeof value.purge_state !== 'string'
    || typeof value.public_check_state !== 'string') {
    return null;
  }
  return {
    version: value.version,
    saved_at: value.saved_at,
    operation_id: value.operation_id,
    source: value.source,
    purge_state: value.purge_state,
    public_check_state: value.public_check_state,
  };
}

async function handle(event) {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const pathname = normalizePath(event.path);
  const methods = allowedMethods(pathname);
  if (!methods) return textResponse(404, 'Not Found');
  if (!methods.includes(method)) {
    return textResponse(405, 'Method Not Allowed', { Allow: methods.join(', ') });
  }

  const config = readConfig();
  if (!config) {
    return jsonResponse(500, { error: 'server_misconfigured' });
  }

  const token = bearerToken(event);
  if (!token) {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  const user = await readUser(config, token);
  if (!user.ok) {
    if (user.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
    return jsonResponse(502, { error: 'upstream_unavailable' });
  }

  const admin = await checkAdmin(config, token);
  if (!admin.ok) {
    if (admin.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
    if (admin.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
    return jsonResponse(502, { error: 'upstream_unavailable' });
  }
  if (!admin.admin) {
    return jsonResponse(403, { error: 'forbidden' });
  }

  if (pathname === '/api/admin/bootstrap') {
    const [published, draft, history] = await Promise.all([
      readPublished(config, token),
      readDraft(config, token),
      readHistory(config, token),
    ]);

    for (const result of [published, draft, history]) {
      if (result.ok) continue;
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!published.published) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const latest = history.entries.length > 0 ? history.entries[0] : null;
    const payload = {
      user: { id: user.user.id, email: user.user.email },
      published: published.published,
      working: buildWorking(published.published, draft.draft),
      schema: {
        groups: SCHEMA,
        linkTokens: LINK_TOKENS,
        linkAnchors: LINK_ANCHORS,
      },
      history: {
        count: history.entries.length,
        latest,
      },
      server_time: new Date().toISOString(),
    };
    return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, payload);
  }

  if (pathname === '/api/admin/history') {
    const history = await readHistory(config, token);
    if (!history.ok) {
      if (history.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (history.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const payload = {
      user: { id: user.user.id, email: user.user.email },
      entries: history.entries,
      count: history.entries.length,
      server_time: new Date().toISOString(),
    };
    return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, payload);
  }

  if (pathname === '/api/admin/history/clear') {
    const parsed = parseHistoryClearBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const result = await callRpc(config, token, 'admin_clear_content_history', {
      p_operation_id: parsed.value.operation_id,
      p_confirmation: parsed.value.confirmation,
    });
    if (!result.ok) {
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = result.value;
    if (!isPlainObject(value)
      || value.operation_id !== parsed.value.operation_id
      || !Number.isSafeInteger(value.deleted_count)
      || value.deleted_count < 0
      || (value.boundary_version !== null
        && (!Number.isSafeInteger(value.boundary_version) || value.boundary_version < 1))
      || (value.boundary_id !== null
        && (!Number.isSafeInteger(value.boundary_id) || value.boundary_id < 1))
      || typeof value.cleared_at !== 'string') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      operation_id: value.operation_id,
      deleted_count: value.deleted_count,
      boundary_version: value.boundary_version,
      boundary_id: value.boundary_id,
      cleared_at: value.cleared_at,
    });
  }

  if (pathname === '/api/admin/history/delete') {
    const parsed = parseHistoryDeleteBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const result = await callRpc(config, token, 'admin_delete_content_history_entry', {
      p_history_id: parsed.value.history_id,
      p_operation_id: parsed.value.operation_id,
      p_confirmation: parsed.value.confirmation,
    });
    if (!result.ok) {
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'not_found') return jsonResponse(404, { error: 'not_found' });
      if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = result.value;
    if (!isPlainObject(value)
      || value.operation_id !== parsed.value.operation_id
      || value.history_id !== parsed.value.history_id
      || !Number.isSafeInteger(value.version)
      || value.version < 1
      || value.deleted !== true
      || typeof value.deleted_at !== 'string') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      operation_id: value.operation_id,
      history_id: value.history_id,
      version: value.version,
      deleted: true,
      was_current_published_version: value.was_current_published_version === true,
      deleted_at: value.deleted_at,
    });
  }

  if (pathname === '/api/admin/analytics') {
    const env = analyticsEnv();
    if (!env) return jsonResponse(503, { error: 'analytics_unavailable' });
    const range = analyticsRange(event);
    if (!range) return jsonResponse(400, { error: 'invalid_request' });

    const result = await callRpc(config, token, 'admin_analytics_snapshot', {
      p_env: env,
      p_range: range,
    });
    if (!result.ok) return analyticsFailure(result.reason);

    const value = result.value;
    if (!isPlainObject(value)
      || !Number.isFinite(Number(value.generated_at))
      || !Array.isArray(value.current)
      || !Array.isArray(value.previous)
      || !Array.isArray(value.live)
      || value.current.some((item) => !isPlainObject(item))
      || value.previous.some((item) => !isPlainObject(item))
      || value.live.some((item) => !isPlainObject(item))) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const stats = buildStats({
      range,
      now: Number(value.generated_at),
      events: value.current,
      previousEvents: value.previous,
      liveEvents: value.live,
    });
    return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, { env, stats });
  }

  if (pathname === '/api/admin/analytics/clear') {
    const env = analyticsEnv();
    if (!env) return jsonResponse(503, { error: 'analytics_unavailable' });

    const result = await callRpcValue(config, token, 'admin_analytics_clear', { p_env: env });
    if (!result.ok) return analyticsFailure(result.reason);
    if (!Number.isSafeInteger(result.value) || result.value < 0) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    return jsonResponse(200, { env, deleted: result.value });
  }

  if (pathname === '/api/admin/preview') {
    const [published, draft] = await Promise.all([
      readPublished(config, token),
      readDraft(config, token),
    ]);
    for (const result of [published, draft]) {
      if (result.ok) continue;
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!published.published) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const working = buildWorking(published.published, draft.draft);
    let assets = {};
    const refs = [...collectMediaRefs(working.content)];
    if (refs.length > 0) {
      assets = await mediaPreviewUrls(config, token, refs);
    }
    const html = buildPreviewHtml(working.content, assets);
    if (method === 'HEAD') return htmlResponse(200, '');
    return htmlResponse(200, html, {
      'X-CCafe-Preview-Source': working.source,
      'X-CCafe-Preview-Version': String(working.source === 'draft' ? working.base_version : published.published.version),
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
  }

  if (pathname === '/api/admin/site-status') {
    if (method === 'POST') {
      const parsed = parseSiteStatusBody(event);
      if (!parsed.ok) {
        if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
        return jsonResponse(422, { error: 'invalid_request' });
      }

      const result = await callRpc(config, token, 'admin_set_site_status', {
        p_state: parsed.value.state,
        p_message: parsed.value.message,
        p_expected_revision: parsed.value.expected_revision,
        p_operation_id: parsed.value.operation_id,
      });
      if (!result.ok) return siteStatusFailure(result.reason);

      const value = siteStatusWriteValue(result.value, parsed.value.operation_id);
      if (!value) return jsonResponse(502, { error: 'upstream_unavailable' });
      return jsonResponse(200, { ...value, server_time: new Date().toISOString() });
    }

    const result = await callRpc(config, token, 'admin_site_status', {});
    if (!result.ok) return siteStatusFailure(result.reason);
    const value = siteStatusValue(result.value);
    if (!value) return jsonResponse(502, { error: 'upstream_unavailable' });
    return method === 'HEAD'
      ? jsonResponse(200)
      : jsonResponse(200, { ...value, server_time: new Date().toISOString() });
  }

  if (pathname === '/api/admin/verify') {
    const parsed = parseVerifyQuery(event);
    if (!parsed.ok) return jsonResponse(400, { error: 'invalid_request' });

    const origin = verifyOrigin(event);
    if (!origin) return jsonResponse(503, { error: 'verification_unavailable' });

    const begun = await callRpcValue(config, token, 'admin_begin_public_check', {
      p_expected_version: parsed.value.version,
    });
    if (!begun.ok) {
      if (begun.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (begun.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (begun.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (begun.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const id = checkId(begun.value);
    if (id === null) return jsonResponse(502, { error: 'upstream_unavailable' });

    const observed = await readPublicVersion(origin);
    let state;
    let detail = '';
    let observedVersion = null;

    if (!observed.ok) {
      // A stopped or indeterminate public state is an explicit mismatch, not a
      // verification error and never a published-content match. Retrying after
      // a restart is the caller's decision; this request does not change state.
      state = observed.reason === 'site_stopped'
        || observed.reason === 'site_state_unknown'
        ? 'mismatch'
        : 'error';
      detail = observed.reason || 'fetch_failed';
    } else if (observed.reason) {
      state = 'mismatch';
      detail = observed.reason;
      observedVersion = observed.version;
    } else {
      observedVersion = observed.version;
      if (observed.source !== 'live') {
        // A fallback snapshot is explicitly not proof of a successful publish.
        state = 'mismatch';
        detail = observed.source === 'fallback' ? 'fallback_snapshot' : 'not_live';
      } else if (observed.version === parsed.value.version) {
        state = 'matched';
      } else {
        state = 'mismatch';
        detail = 'version_mismatch';
      }
    }

    const finished = await callRpcValue(config, token, 'admin_finish_public_check', {
      p_check_id: id,
      p_state: state,
      p_observed_version: observedVersion,
      p_detail: detail || null,
    });
    if (!finished.ok) {
      if (finished.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (finished.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const applied = finished.value === true;
    if (!applied) {
      // A newer verification attempt (or a newer saved version) registered while
      // this fetch was in flight. Its result must win; this one is not shown.
      return jsonResponse(200, {
        state: 'superseded',
        applied: false,
        version: parsed.value.version,
        checked_at: new Date().toISOString(),
      });
    }

    return jsonResponse(200, {
      state,
      applied: true,
      version: parsed.value.version,
      observed_version: observedVersion,
      source: observed.source || null,
      site_state: observed.siteState || null,
      detail: detail || null,
      checked_at: new Date().toISOString(),
    });
  }

  if (pathname === '/api/admin/media') {
    if (method === 'GET' || method === 'HEAD') {
      const listed = await readMediaList(config, token);
      if (!listed.ok) {
        if (listed.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
        if (listed.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
        return jsonResponse(502, { error: 'upstream_unavailable' });
      }

      let urls = {};
      if (method !== 'HEAD') {
        const signed = await Promise.all(
          listed.assets
            .filter((asset) => asset.selectable)
            .map(async (asset) => {
              const result = await signMediaObject(config, token, asset.logical_path);
              return result.ok ? [asset.logical_path, result.url] : null;
            }),
        );
        urls = signedUrlMap(signed.filter(Boolean));
      }

      const payload = {
        assets: listed.assets,
        originals: publicOriginals(),
        urls,
        media_enabled: Boolean(mediaFinalizeToken()),
        limits: emptyMediaLimits(),
        server_time: new Date().toISOString(),
      };
      return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, payload);
    }

    const parsed = parseMediaCreateBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const created = await callRpc(config, token, 'admin_media_create', {
      p_original_name: parsed.value.original_name,
      p_declared_mime: parsed.value.declared_mime,
      p_declared_bytes: parsed.value.declared_bytes,
    });
    if (!created.ok) {
      if (created.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (created.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (created.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = created.value;
    if (typeof value.id !== 'string'
      || !UUID_RE.test(value.id)
      || value.logical_path !== `media/${value.id}`
      || value.storage_path !== value.logical_path
      || value.bucket !== MEDIA_BUCKET
      || value.status !== 'pending') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      asset: {
        id: value.id,
        logical_path: value.logical_path,
        status: 'pending',
        original_name: parsed.value.original_name,
        selectable: false,
      },
      // Destination only, not a signed URL: the browser uploads with its own
      // admin JWT and Storage RLS pins it to this exact pending path.
      upload: {
        bucket: MEDIA_BUCKET,
        path: value.storage_path,
        url: `${config.base}/storage/v1/object/${MEDIA_BUCKET}/${value.storage_path}`,
      },
      limits: emptyMediaLimits(),
    });
  }

  if (pathname === '/api/admin/media/finalize') {
    const tokenValue = mediaFinalizeToken();
    if (!tokenValue) return jsonResponse(503, { error: 'media_unavailable' });

    const parsed = parseMediaIdBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const found = await readMediaAsset(config, token, parsed.value.asset_id);
    if (!found.ok) {
      if (found.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (found.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!found.asset) return jsonResponse(404, { error: 'not_found' });

    const asset = found.asset;
    if (asset.created_by !== user.user.id) return jsonResponse(403, { error: 'forbidden' });
    if (asset.status === 'approved') {
      return jsonResponse(200, { asset: publicMediaAsset(asset), idempotent: true });
    }
    if (asset.status !== 'pending') return jsonResponse(409, { error: 'not_pending' });

    // Claim the row before reading its bytes. While the claim is set, the
    // Storage INSERT/DELETE policies deny replacing or removing the object, so
    // the digest verified below always describes the bytes that remain.
    const claimed = await callRpc(config, token, 'admin_media_begin_finalize', {
      p_asset_id: asset.id,
    });
    if (!claimed.ok) {
      if (claimed.reason === 'conflict') {
        // A concurrent finalize may have approved the asset between our read
        // and the claim. Re-read once and report the idempotent success.
        const current = await readMediaAsset(config, token, asset.id);
        if (current.ok && current.asset && current.asset.status === 'approved') {
          return jsonResponse(200, { asset: publicMediaAsset(current.asset), idempotent: true });
        }
        return jsonResponse(409, { error: 'conflict' });
      }
      if (claimed.reason === 'forbidden' || claimed.reason === 'unauthorized') {
        return jsonResponse(403, { error: 'forbidden' });
      }
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!claimed.value || claimed.value.claimed !== true || claimed.value.id !== asset.id) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const download = await downloadMediaObject(config, token, asset.logical_path);
    if (!download.ok) {
      if (download.reason === 'too_large') {
        await callRpc(config, token, 'admin_media_fail', {
          p_asset_id: asset.id,
          p_reason: 'too_large',
        });
        await deleteMediaObject(config, token, asset.logical_path);
        return jsonResponse(422, { error: 'invalid_image', reason: 'too_large' });
      }
      if (download.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      // A just-uploaded object can be briefly unavailable; keep the row pending
      // so the same finalize call can be retried without creating a new asset.
      return jsonResponse(502, { error: 'upload_not_ready' });
    }

    const verified = await verifyImage(download.buffer, { declaredMime: asset.declared_mime });
    if (!verified.ok) {
      await callRpc(config, token, 'admin_media_fail', {
        p_asset_id: asset.id,
        p_reason: verified.reason,
      });
      await deleteMediaObject(config, token, asset.logical_path);
      return jsonResponse(422, { error: 'invalid_image', reason: verified.reason });
    }

    const result = await callRpc(config, token, 'admin_media_finalize', {
      p_asset_id: asset.id,
      p_token: tokenValue,
      p_mime: verified.mime,
      p_bytes: verified.bytes,
      p_width: verified.width,
      p_height: verified.height,
      p_pixel_count: verified.pixel_count,
      p_sha256: verified.sha256,
    });
    if (!result.ok) {
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'invalid') {
        return jsonResponse(422, { error: 'invalid_image', reason: 'verification_rejected' });
      }
      // A forbidden/unauthorized result here means the server token does not
      // match the stored fingerprint (misconfiguration), not a client problem.
      if (result.reason === 'forbidden' || result.reason === 'unauthorized') {
        return jsonResponse(503, { error: 'media_unavailable' });
      }
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = result.value;
    if (typeof value.id !== 'string' || value.id !== asset.id
      || value.logical_path !== asset.logical_path
      || value.status !== 'approved'
      || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)
      || value.mime !== verified.mime
      || value.bytes !== verified.bytes
      || value.width !== verified.width
      || value.height !== verified.height) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      asset: {
        id: value.id,
        logical_path: value.logical_path,
        status: 'approved',
        original_name: asset.original_name,
        mime: value.mime,
        bytes: value.bytes,
        width: value.width,
        height: value.height,
        selectable: true,
        finalized_at: typeof value.finalized_at === 'string' ? value.finalized_at : null,
      },
      idempotent: value.idempotent === true,
    });
  }

  if (pathname === '/api/admin/media/abandon') {
    const parsed = parseMediaIdBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const found = await readMediaAsset(config, token, parsed.value.asset_id);
    if (!found.ok) {
      if (found.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (found.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!found.asset) return jsonResponse(404, { error: 'not_found' });
    if (found.asset.created_by !== user.user.id) return jsonResponse(403, { error: 'forbidden' });
    if (found.asset.status === 'approved') return jsonResponse(409, { error: 'approved' });

    const result = await callRpc(config, token, 'admin_media_fail', {
      p_asset_id: found.asset.id,
      p_reason: 'abandoned',
    });
    if (!result.ok) {
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'forbidden' || result.reason === 'unauthorized') {
        return jsonResponse(403, { error: 'forbidden' });
      }
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const deleted = await deleteMediaObject(config, token, found.asset.logical_path);
    return jsonResponse(200, {
      id: found.asset.id,
      status: 'failed',
      deleted_object: deleted,
    });
  }

  if (pathname === '/api/admin/media/url') {
    const query = event.queryStringParameters;
    const id = query && typeof query === 'object' ? query.id : '';
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const found = await readMediaAsset(config, token, id);
    if (!found.ok) {
      if (found.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (found.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    if (!found.asset) return jsonResponse(404, { error: 'not_found' });
    if (found.asset.status !== 'approved') return jsonResponse(409, { error: 'not_approved' });
    if (method === 'HEAD') return jsonResponse(200);

    const signed = await signMediaObject(config, token, found.asset.logical_path);
    if (!signed.ok) return jsonResponse(502, { error: 'upstream_unavailable' });
    return jsonResponse(200, { url: signed.url, expires_in: signed.expires_in });
  }

  if (pathname === '/api/admin/media/usage') {
    const query = event.queryStringParameters;
    const id = query && typeof query === 'object' ? query.id : '';
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const result = await callRpc(config, token, 'admin_media_usage', { p_asset_id: id });
    if (!result.ok) return mediaRpcFailure(result.reason);

    const usage = mediaUsagePayload(result.value, id);
    if (!usage) return jsonResponse(502, { error: 'upstream_unavailable' });
    return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, { usage });
  }

  if (pathname === '/api/admin/media/trash') {
    const result = await callRpc(config, token, 'admin_media_trash_list', {});
    if (!result.ok) return mediaRpcFailure(result.reason);
    if (!isPlainObject(result.value) || !Array.isArray(result.value.items)) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const items = result.value.items.map(trashListItem);
    if (items.some((item) => item === null)) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }
    const payload = {
      items,
      media_enabled: Boolean(mediaFinalizeToken()),
      server_time: new Date().toISOString(),
    };
    return method === 'HEAD' ? jsonResponse(200) : jsonResponse(200, payload);
  }

  if (pathname === '/api/admin/media/delete') {
    const tokenValue = mediaFinalizeToken();
    if (!tokenValue) return jsonResponse(503, { error: 'media_unavailable' });

    const parsed = parseMediaOperationBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const begun = await callRpc(config, token, 'admin_media_delete_begin', {
      p_asset_id: parsed.value.asset_id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
    });
    if (!begun.ok) return mediaRpcFailure(begun.reason);
    if (!isPlainObject(begun.value)) return jsonResponse(502, { error: 'upstream_unavailable' });

    const value = begun.value;
    if (value.state === 'blocked') {
      return jsonResponse(409, {
        error: 'media_in_use',
        reasons: Array.isArray(value.reasons) ? value.reasons.filter((r) => typeof r === 'string') : [],
        references: isPlainObject(value.references) ? value.references : {},
      });
    }

    if (value.state === 'trashed') {
      // A retry of an already committed delete only reconciles best-effort
      // cleanup; it never allocates another trash copy.
      const cleanup = await retryTrashCleanup(
        config,
        token,
        tokenValue,
        parsed.value.asset_id,
        parsed.value.operation_id,
      );
      return jsonResponse(200, {
        asset: {
          id: parsed.value.asset_id,
          logical_path: `media/${parsed.value.asset_id}`,
          status: 'trashed',
          cleanup_state: cleanup.done ? 'done' : 'pending',
          cleanup_error: cleanup.error,
          public_cleanup_state: cleanup.public_done === true
            ? 'done'
            : cleanup.public_done === false ? 'pending' : 'none',
          public_cleanup_error: cleanup.public_error,
        },
        idempotent: value.idempotent === true,
      });
    }

    const asset = trashAssetFrom(value, parsed.value.asset_id);
    if (!asset) return jsonResponse(502, { error: 'upstream_unavailable' });

    const downloaded = await downloadMediaObject(config, token, asset.logical_path);
    if (!downloaded.ok) {
      await abortMediaDelete(config, token, tokenValue, asset.id, parsed.value.operation_id, downloaded.reason);
      return mediaStorageFailure(downloaded.reason);
    }

    const verified = await verifyMediaBytes(downloaded.buffer, asset);
    if (!verified.ok) {
      await abortMediaDelete(config, token, tokenValue, asset.id, parsed.value.operation_id, verified.reason);
      return jsonResponse(422, { error: 'invalid_image', reason: verified.reason });
    }

    const uploaded = await uploadTrashObject(
      config,
      token,
      asset.trash_object_path,
      asset.mime,
      downloaded.buffer,
    );
    if (!uploaded.ok) {
      await abortMediaDelete(config, token, tokenValue, asset.id, parsed.value.operation_id, uploaded.reason);
      return mediaStorageFailure(uploaded.reason);
    }

    // Read the stored copy back and verify it. This also covers a retry where the
    // object already exists: the accepted bytes are proven, not assumed.
    const storedCopy = await downloadTrashObject(config, token, asset.trash_object_path);
    if (!storedCopy.ok) {
      await abortMediaDelete(config, token, tokenValue, asset.id, parsed.value.operation_id, storedCopy.reason);
      return mediaStorageFailure(storedCopy.reason);
    }
    const storedVerified = await verifyMediaBytes(storedCopy.buffer, asset);
    if (!storedVerified.ok) {
      await abortMediaDelete(config, token, tokenValue, asset.id, parsed.value.operation_id, storedVerified.reason);
      return jsonResponse(422, { error: 'invalid_image', reason: storedVerified.reason });
    }

    // Database commit point. If this response is lost the asset may already be
    // trashed; do not abort here. A retry with the same operation id reconciles.
    const finished = await callRpc(config, token, 'admin_media_delete_finish', {
      p_asset_id: asset.id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
      p_sha256: verified.value.sha256,
    });
    if (!finished.ok) return mediaRpcFailure(finished.reason);
    if (!isPlainObject(finished.value)
      || finished.value.asset_id !== asset.id
      || finished.value.state !== 'trashed') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    // Removing the original private object is best effort. Failure leaves the
    // verified trash copy and a cleanup_pending marker; it is never reported as
    // a fully clean delete.
    const cleanup = await retryTrashCleanup(
      config,
      token,
      tokenValue,
      asset.id,
      parsed.value.operation_id,
    );

    return jsonResponse(200, {
      asset: {
        id: asset.id,
        logical_path: asset.logical_path,
        status: 'trashed',
        cleanup_state: cleanup.done ? 'done' : 'pending',
        cleanup_error: cleanup.error,
        public_cleanup_state: cleanup.public_done === true
          ? 'done'
          : cleanup.public_done === false ? 'pending' : 'none',
        public_cleanup_error: cleanup.public_error,
      },
      idempotent: finished.value.idempotent === true,
    });
  }

  if (pathname === '/api/admin/media/restore') {
    const tokenValue = mediaFinalizeToken();
    if (!tokenValue) return jsonResponse(503, { error: 'media_unavailable' });

    const parsed = parseMediaOperationBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const begun = await callRpc(config, token, 'admin_media_restore_begin', {
      p_asset_id: parsed.value.asset_id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
    });
    if (!begun.ok) return mediaRpcFailure(begun.reason);
    if (!isPlainObject(begun.value)) return jsonResponse(502, { error: 'upstream_unavailable' });

    if (begun.value.state === 'approved' && begun.value.idempotent === true) {
      return jsonResponse(200, {
        asset: {
          id: parsed.value.asset_id,
          logical_path: `media/${parsed.value.asset_id}`,
          status: 'approved',
          selectable: true,
        },
        idempotent: true,
      });
    }

    const asset = restoreAssetFrom(begun.value, parsed.value.asset_id);
    if (!asset) return jsonResponse(502, { error: 'upstream_unavailable' });

    const downloaded = await downloadTrashObject(config, token, asset.trash_object_path);
    if (!downloaded.ok) {
      await abortMediaRestore(config, token, tokenValue, asset.id, parsed.value.operation_id, downloaded.reason);
      return mediaStorageFailure(downloaded.reason);
    }

    const verified = await verifyMediaBytes(downloaded.buffer, asset);
    if (!verified.ok) {
      await abortMediaRestore(config, token, tokenValue, asset.id, parsed.value.operation_id, verified.reason);
      return jsonResponse(422, { error: 'invalid_image', reason: verified.reason });
    }

    const uploaded = await uploadMediaObject(
      config,
      token,
      asset.storage_path,
      asset.mime,
      downloaded.buffer,
    );
    if (!uploaded.ok) {
      await abortMediaRestore(config, token, tokenValue, asset.id, parsed.value.operation_id, uploaded.reason);
      return mediaStorageFailure(uploaded.reason);
    }

    if (uploaded.existed) {
      // Cleanup may never have removed the original bytes. Accept only identical
      // bytes; never overwrite an object with a different image.
      const existing = await downloadMediaObject(config, token, asset.storage_path);
      if (!existing.ok) {
        await abortMediaRestore(config, token, tokenValue, asset.id, parsed.value.operation_id, existing.reason);
        return mediaStorageFailure(existing.reason);
      }
      const existingVerified = await verifyMediaBytes(existing.buffer, asset);
      if (!existingVerified.ok) {
        await abortMediaRestore(config, token, tokenValue, asset.id, parsed.value.operation_id, existingVerified.reason);
        return jsonResponse(409, { error: 'restore_conflict' });
      }
    }

    // A pending public cleanup means the previous delete could not remove the
    // public object. Remove it before the asset becomes approved again; leaving
    // it would keep an orphaned public capability alive for a restored upload.
    if (asset.public_object_path) {
      const cleared = await deletePublicObject(config, token, asset.public_object_path);
      if (!cleared) {
        await abortMediaRestore(
          config,
          token,
          tokenValue,
          asset.id,
          parsed.value.operation_id,
          'public_object_delete_failed',
        );
        return jsonResponse(502, {
          error: 'storage_unavailable',
          reason: 'public_cleanup_pending',
        });
      }
    }

    // Database commit point. As with delete, an ambiguous failure is left for a
    // retry of the same operation instead of being aborted after a possible
    // commit.
    const finished = await callRpc(config, token, 'admin_media_restore_finish', {
      p_asset_id: asset.id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
    });
    if (!finished.ok) return mediaRpcFailure(finished.reason);
    if (!isPlainObject(finished.value)
      || finished.value.asset_id !== asset.id
      || finished.value.state !== 'approved') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      asset: {
        id: asset.id,
        logical_path: asset.logical_path,
        status: 'approved',
        mime: asset.mime,
        bytes: asset.bytes,
        width: asset.width,
        height: asset.height,
        selectable: true,
      },
      idempotent: finished.value.idempotent === true,
    });
  }

  if (pathname === '/api/admin/media/purge') {
    const tokenValue = mediaFinalizeToken();
    if (!tokenValue) return jsonResponse(503, { error: 'media_unavailable' });

    const parsed = parseMediaPurgeBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const begun = await callRpc(config, token, 'admin_media_purge_begin', {
      p_asset_id: parsed.value.asset_id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
      p_confirmation: parsed.value.confirmation,
    });
    if (!begun.ok) return mediaRpcFailure(begun.reason);
    if (!isPlainObject(begun.value)) return jsonResponse(502, { error: 'upstream_unavailable' });

    const v = begun.value;
    if (v.state === 'blocked') {
      return jsonResponse(409, {
        error: 'media_in_use',
        reasons: Array.isArray(v.reasons) ? v.reasons.filter((r) => typeof r === 'string') : [],
        references: isPlainObject(v.references) ? v.references : {},
        asset_id: parsed.value.asset_id,
      });
    }
    if (v.state === 'purged' && v.operation_id === parsed.value.operation_id) {
      return jsonResponse(200, {
        asset: {
          id: parsed.value.asset_id,
          logical_path: typeof v.logical_path === 'string' ? v.logical_path : `media/${parsed.value.asset_id}`,
          status: 'purged',
          private_cleanup_state: 'done',
          trash_cleanup_state: 'done',
          public_cleanup_state: typeof v.public_cleanup_state === 'string' ? v.public_cleanup_state : 'none',
        },
        idempotent: true,
      });
    }
    if (v.state !== 'purging' || v.operation_id !== parsed.value.operation_id) {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    // Only the exact paths recorded for this operation may be deleted. The RPC
    // derives them from the asset row, but validate again here so a stale or
    // unexpected response can never widen the Storage scope to another asset.
    const expectedPrivatePath = `media/${parsed.value.asset_id}`;
    const privatePath = v.private_object_path === expectedPrivatePath ? expectedPrivatePath : null;
    const trashPath = typeof v.trash_object_path === 'string'
      && v.trash_object_path.startsWith(`trash/${parsed.value.asset_id}/`)
      && TRASH_PATH_RE.test(v.trash_object_path) ? v.trash_object_path : null;
    const publicPath = typeof v.public_object_path === 'string'
      && v.public_object_path.startsWith(`published/${parsed.value.asset_id}/`)
      && PUBLIC_MEDIA_PATH_RE.test(v.public_object_path) ? v.public_object_path : null;
    if (!privatePath || !trashPath) return jsonResponse(502, { error: 'upstream_unavailable' });

    const privateDone = v.private_cleanup_state === 'done' ? true : await deleteMediaObject(config, token, privatePath);
    const trashDone = v.trash_cleanup_state === 'done' ? true : await deleteTrashObject(config, token, trashPath);
    let publicDone = null;
    let publicError = null;
    if (publicPath) {
      if (v.public_cleanup_state === 'done') {
        publicDone = true;
      } else {
        publicDone = await deletePublicObject(config, token, publicPath);
        publicError = publicDone ? null : 'public_object_delete_failed';
      }
    }

    const recorded = await callRpc(config, token, 'admin_media_purge_cleanup', {
      p_asset_id: parsed.value.asset_id,
      p_token: tokenValue,
      p_operation_id: parsed.value.operation_id,
      p_private_done: privateDone,
      p_private_error: privateDone ? null : 'object_delete_failed',
      p_trash_done: trashDone,
      p_trash_error: trashDone ? null : 'trash_object_delete_failed',
      p_public_done: publicDone,
      p_public_error: publicError,
    });
    if (!recorded.ok || !isPlainObject(recorded.value)) {
      if (privateDone && trashDone && (publicDone === true || publicDone === null)) {
        return jsonResponse(502, { error: 'cleanup_pending' });
      }
      return jsonResponse(502, { error: 'storage_unavailable' });
    }

    const rv = recorded.value;
    const state = rv.state === 'purged' ? 'purged' : 'purging';
    if (state !== 'purged') {
      return jsonResponse(502, {
        error: 'cleanup_pending',
        asset: {
          id: parsed.value.asset_id,
          logical_path: typeof rv.logical_path === 'string' ? rv.logical_path : `media/${parsed.value.asset_id}`,
          status: 'purging',
          private_cleanup_state: rv.private_cleanup_state === 'done' ? 'done' : 'pending',
          trash_cleanup_state: rv.trash_cleanup_state === 'done' ? 'done' : 'pending',
          public_cleanup_state: rv.public_cleanup_state === 'done' ? 'done' : rv.public_cleanup_state === 'pending' ? 'pending' : 'none',
        },
      });
    }

    return jsonResponse(200, {
      asset: {
        id: parsed.value.asset_id,
        logical_path: typeof rv.logical_path === 'string' ? rv.logical_path : `media/${parsed.value.asset_id}`,
        status: 'purged',
        private_cleanup_state: 'done',
        trash_cleanup_state: 'done',
        public_cleanup_state: rv.public_cleanup_state === 'done' ? 'done' : 'none',
      },
      idempotent: rv.idempotent === true,
    });
  }

  if (pathname === '/api/admin/media/cleanup') {
    const tokenValue = mediaFinalizeToken();
    if (!tokenValue) return jsonResponse(503, { error: 'media_unavailable' });

    const parsed = parseMediaIdBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const cleanup = await retryTrashCleanup(
      config,
      token,
      tokenValue,
      parsed.value.asset_id,
      null,
    );
    if (!cleanup.recorded && !cleanup.done) {
      return jsonResponse(502, { error: 'cleanup_pending' });
    }
    return jsonResponse(200, {
      asset_id: parsed.value.asset_id,
      cleanup_state: cleanup.done ? 'done' : 'pending',
      cleanup_error: cleanup.error,
      public_cleanup_state: cleanup.public_done === true
        ? 'done'
        : cleanup.public_done === false ? 'pending' : 'none',
      public_cleanup_error: cleanup.public_error,
    });
  }

  if (pathname === '/api/admin/draft') {
    const parsed = parseDraftBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    let content;
    try {
      content = normalizedContent(parsed.value.content);
    } catch {
      return jsonResponse(400, { error: 'invalid_request' });
    }
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: 'payload_too_large' });
    }

    const result = await callRpc(config, token, 'admin_save_draft', {
      p_expected_version: parsed.value.expected_version,
      p_expected_revision: parsed.value.expected_revision,
      p_content: content,
    });
    if (!result.ok) {
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_content' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = result.value;
    if (typeof value.revision_id !== 'string'
      || !UUID_RE.test(value.revision_id)
      || !Number.isSafeInteger(value.base_version)
      || typeof value.updated_at !== 'string') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      revision_id: value.revision_id,
      base_version: value.base_version,
      updated_at: value.updated_at,
    });
  }

  if (pathname === '/api/admin/publish') {
    const parsed = parsePublishBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    // Preflight inside the database: verifies the version, draft revision and
    // operation id, and reports which approved assets still need a ready public
    // copy. A retry of an already-published operation returns its stored result
    // here, so no bytes are uploaded and no extra version is created.
    const begun = await callRpc(config, token, 'admin_media_publish_begin', {
      p_expected_version: parsed.value.expected_version,
      p_expected_draft_revision: parsed.value.expected_draft_revision,
      p_note: parsed.value.note,
      p_operation_id: parsed.value.operation_id,
    });
    if (!begun.ok) {
      if (begun.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (begun.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (begun.reason === 'media_not_ready') return jsonResponse(422, { error: 'media_not_ready' });
      if (begun.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (begun.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const preflight = begun.value;
    if (!isPlainObject(preflight)) return jsonResponse(502, { error: 'upstream_unavailable' });

    if (preflight.state === 'published') {
      const payload = publishResultPayload(preflight.result, parsed.value);
      if (!payload) return jsonResponse(502, { error: 'upstream_unavailable' });
      return jsonResponse(200, payload);
    }
    if (preflight.state !== 'ready' && preflight.state !== 'needs_prepare') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    // Publish is split across Storage and Postgres, so it cannot be atomic. A
    // preparation failure below returns before admin_publish: the live version
    // and the draft stay unchanged, and a ready-but-unlinked copy remains
    // recoverable for a retry.
    const prepare = await preparePublicCopies(
      config,
      token,
      mediaFinalizeToken(),
      preflight,
    );
    if (!prepare.ok) {
      if (prepare.reason === 'token') return jsonResponse(503, { error: 'media_unavailable' });
      if (prepare.reason === 'forbidden' || prepare.reason === 'unauthorized') {
        return jsonResponse(403, { error: 'forbidden' });
      }
      return jsonResponse(502, { error: 'media_prepare_failed' });
    }

    const result = await callRpc(config, token, 'admin_publish', {
      p_expected_version: parsed.value.expected_version,
      p_expected_draft_revision: parsed.value.expected_draft_revision,
      p_content: null,
      p_note: parsed.value.note,
      p_operation_id: parsed.value.operation_id,
    });
    if (!result.ok) {
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (result.reason === 'media_not_ready') return jsonResponse(422, { error: 'media_not_ready' });
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const payload = publishResultPayload(result.value, parsed.value);
    if (!payload) return jsonResponse(502, { error: 'upstream_unavailable' });
    return jsonResponse(200, payload);
  }

  if (pathname === '/api/admin/restore') {
    const parsed = parseRestoreBody(event);
    if (!parsed.ok) {
      if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
      return jsonResponse(400, { error: 'invalid_request' });
    }

    const result = await callRpc(config, token, 'admin_restore', {
      p_history_id: parsed.value.history_id,
      p_expected_version: parsed.value.expected_version,
      p_note: parsed.value.note,
      p_operation_id: parsed.value.operation_id,
    });
    if (!result.ok) {
      if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
      if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
      if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
      if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_request' });
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    const value = result.value;
    if (!Number.isSafeInteger(value.version)
      || value.version < 1
      || typeof value.saved_at !== 'string'
      || value.operation_id !== parsed.value.operation_id
      || value.source !== 'restore'
      || value.restored_from !== parsed.value.history_id
      || typeof value.purge_state !== 'string'
      || typeof value.public_check_state !== 'string') {
      return jsonResponse(502, { error: 'upstream_unavailable' });
    }

    return jsonResponse(200, {
      version: value.version,
      saved_at: value.saved_at,
      operation_id: value.operation_id,
      source: value.source,
      restored_from: value.restored_from,
      purge_state: value.purge_state,
      public_check_state: value.public_check_state,
    });
  }

  // /api/admin/draft/delete
  const parsed = parseDeleteBody(event);
  if (!parsed.ok) {
    if (parsed.reason === 'too_large') return jsonResponse(413, { error: 'payload_too_large' });
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const result = await callRpc(config, token, 'admin_delete_draft', {
    p_expected_version: parsed.value.expected_version,
    p_expected_revision: parsed.value.expected_revision,
  });
  if (!result.ok) {
    if (result.reason === 'unauthorized') return jsonResponse(401, { error: 'unauthorized' });
    if (result.reason === 'forbidden') return jsonResponse(403, { error: 'forbidden' });
    if (result.reason === 'conflict') return jsonResponse(409, { error: 'conflict' });
    if (result.reason === 'invalid') return jsonResponse(422, { error: 'invalid_content' });
    return jsonResponse(502, { error: 'upstream_unavailable' });
  }

  return jsonResponse(200, { deleted: result.value.deleted === true });
}

exports.handler = async (event = {}) => {
  try {
    return await handle(event);
  } catch {
    return jsonResponse(500, { error: 'server_error' });
  }
};

// Test hooks for the pure helpers; not used by Netlify.
exports._internal = {
  bearerToken,
  normalizePath,
  readConfig,
  readHistory,
  buildWorking,
  buildPreviewHtml,
  parseDraftBody,
  parseDeleteBody,
  parsePublishBody,
  parseRestoreBody,
  parseHistoryClearBody,
  parseMediaCreateBody,
  parseMediaIdBody,
  parseVerifyQuery,
  parseSiteStatusBody,
  siteStatusValue,
  siteStatusWriteValue,
  verifyOrigin,
  readPublicVersion,
  callRpc,
  callRpcValue,
  readMediaList,
  readMediaAsset,
  signMediaObject,
  downloadMediaObject,
  publicMediaUrl,
  readReadyPublicPaths,
  publicObjectExists,
  uploadPublicObject,
  downloadPublicObject,
  preparePublicCopy,
  preparePublicCopies,
  mediaFinalizeToken,
  mediaPreviewUrls,
  emptyMediaLimits,
  publicOriginals,
  sha256Hex,
};
