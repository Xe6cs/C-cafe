'use strict';
// Public site Function: renders the current published content from Supabase.
//
// Security/scope:
//   * reads public.published_content with the public anon key only;
//   * never uses service_role, SUPABASE_ACCESS_TOKEN, or any admin endpoint;
//   * exposes no write or admin route;
//   * includes track.js only when CCAFE_ANALYTICS_ENV is explicitly
//     'preview' or 'production'; the destination is /api/track.
//
// Failure behaviour:
//   * a 5s timeout (CCAFE_SUPABASE_TIMEOUT_MS override) and any fetch/parse/
//     validation error fall back to the static snapshot in
//     content-fallback.json;
//   * fallback responses are marked X-CCafe-Source: fallback, carry a noindex
//     header, and use the non-numeric version marker "fallback";
//   * fallback is not proof of a successful deployment.
//
// Preview protection:
//   * when CCAFE_PREVIEW_ONLY is truthy (or Netlify CONTEXT is not production),
//     live responses also carry X-Robots-Tag: noindex and a robots meta tag;
//   * this flag must be removed before a future production launch, so noindex is
//     never forced on production.
//
// The page HTML is rendered at request time, so no static index.html can shadow
// this Function.

const { renderPage } = require('../../lib/render');
const { normalize } = require('../../lib/schema');
const { collectMediaRefs } = require('../../lib/media-verify');
const DEFAULTS = require('../../lib/default-content');
const FALLBACK = require('./content-fallback.json');

const DEFAULT_TIMEOUT_MS = 5000;
const PAGE_PATHS = new Set(['', '/', '/index.html', '/.netlify/functions/site']);
const PUBLIC_MEDIA_BUCKET = 'ccafe-public';
const PUBLIC_MEDIA_PATH_RE = /^published\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;

const BASE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Netlify-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function reasonError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

function timeoutMs() {
  const value = Number(process.env.CCAFE_SUPABASE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_TIMEOUT_MS;
}

function isPreviewOnly() {
  const flag = String(process.env.CCAFE_PREVIEW_ONLY || '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  const context = String(process.env.CONTEXT || '').trim().toLowerCase();
  return Boolean(context) && context !== 'production';
}

// The only switch that enables tracking. Preview deploys set it to 'preview';
// production configuration is documented but must stay unset until launch.
function analyticsEnv() {
  const value = String(process.env.CCAFE_ANALYTICS_ENV || '').trim().toLowerCase();
  return value === 'preview' || value === 'production' ? value : '';
}

function readSupabaseConfig() {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !anonKey) throw reasonError('missing-config');
  return { base, anonKey };
}

async function getJson(endpoint, anonKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(endpoint, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw reasonError(`http-${response.status}`);
    try {
      return await response.json();
    } catch {
      throw reasonError('invalid-data');
    }
  } catch (error) {
    if (error && error.reason) throw error;
    throw reasonError(error && error.name === 'AbortError' ? 'timeout' : 'fetch-error');
  } finally {
    clearTimeout(timer);
  }
}

async function readPublished(config) {
  let endpoint;
  try {
    endpoint = new URL('/rest/v1/published_content', config.base);
  } catch {
    throw reasonError('invalid-config');
  }
  if (!/^https?:$/.test(endpoint.protocol)) throw reasonError('invalid-config');
  endpoint.searchParams.set('select', 'version,content,saved_at');
  endpoint.searchParams.set('limit', '1');

  const rows = await getJson(endpoint, config.anonKey);
  if (!Array.isArray(rows) || rows.length !== 1) throw reasonError('invalid-data');
  const row = rows[0];
  if (!isPlainObject(row) || !isPlainObject(row.content)) throw reasonError('invalid-data');
  if (!Number.isSafeInteger(row.version) || row.version < 0) throw reasonError('invalid-data');

  return { version: row.version, content: row.content };
}

// Anonymous resolution of approved uploads. The published content stores only
// `media/<asset-uuid>`; this reads the ready, published-linked public copy with
// the anon key and builds a permanent public URL. No signed URL ever enters the
// page, and staging/unpublished copies are filtered out by RLS.
async function readPublicAssets(config, content) {
  const refs = [...collectMediaRefs(content)];
  if (!refs.length) return {};

  const ids = [...new Set(refs.map((ref) => ref.slice('media/'.length)))];
  let endpoint;
  try {
    endpoint = new URL('/rest/v1/media_public_assets', config.base);
  } catch {
    throw reasonError('invalid-config');
  }
  if (!/^https?:$/.test(endpoint.protocol)) throw reasonError('invalid-config');
  endpoint.searchParams.set('select', 'asset_id,object_path');
  endpoint.searchParams.set('state', 'eq.ready');
  endpoint.searchParams.set('asset_id', `in.(${ids.join(',')})`);
  endpoint.searchParams.set('limit', String(ids.length));

  const rows = await getJson(endpoint, config.anonKey);
  if (!Array.isArray(rows)) throw reasonError('invalid-data');

  const base = config.base.replace(/\/+$/, '');
  const assets = {};
  for (const row of rows) {
    if (!isPlainObject(row)) continue;
    if (typeof row.asset_id !== 'string' || !/^[0-9a-f-]{36}$/.test(row.asset_id)) continue;
    if (typeof row.object_path !== 'string' || !PUBLIC_MEDIA_PATH_RE.test(row.object_path)) continue;
    assets[`media/${row.asset_id}`] = `${base}/storage/v1/object/public/${PUBLIC_MEDIA_BUCKET}/${row.object_path}`;
  }
  return assets;
}

function notFound() {
  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
    body: 'Not Found',
    isBase64Encoded: false,
  };
}

function htmlResponse(html, { source, version, reason, previewOnly }) {
  const headers = {
    ...BASE_HEADERS,
    'X-CCafe-Source': source,
  };
  if (source === 'live') headers['X-CCafe-Version'] = String(version);
  if (reason) headers['X-CCafe-Reason'] = reason;
  if (previewOnly) headers['X-CCafe-Preview'] = '1';
  if (previewOnly || source === 'fallback') headers['X-Robots-Tag'] = 'noindex';
  return {
    statusCode: 200,
    headers,
    body: html,
    isBase64Encoded: false,
  };
}

exports.handler = async (event = {}) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      statusCode: 405,
      headers: {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
      body: 'Method Not Allowed',
      isBase64Encoded: false,
    };
  }

  const pathname = event.path || '/';
  if (pathname.startsWith('/api/')) return notFound();
  if (!PAGE_PATHS.has(pathname)) return notFound();

  let live = null;
  let assets = {};
  let reason = null;
  try {
    const config = readSupabaseConfig();
    live = await readPublished(config);
    assets = await readPublicAssets(config, live.content);
  } catch (error) {
    reason = (error && error.reason) || 'fetch-error';
    live = null;
    assets = {};
    console.error(`[ccafe-site] using fallback snapshot: ${reason}`);
  }

  const content = normalize(live ? live.content : FALLBACK.content, DEFAULTS);
  const previewOnly = isPreviewOnly();
  const usingFallback = !live;
  const html = renderPage(content, {
    version: live ? live.version : 'fallback',
    // A fallback page means Supabase is unreachable; tracking would fail too.
    analytics: !usingFallback && analyticsEnv() !== '',
    tracking: false,
    preview: previewOnly || usingFallback,
    assets,
  });

  return htmlResponse(html, {
    source: live ? 'live' : 'fallback',
    version: live ? live.version : null,
    reason,
    previewOnly,
  });
};
