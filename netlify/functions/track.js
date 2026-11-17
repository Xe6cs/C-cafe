'use strict';
// /api/track: the only public write path for analytics.
//
// Design:
//   * the browser sends one small JSON event (same shape as the local tracker);
//   * all fields are re-validated here, so a crafted request cannot store
//     arbitrary text, links, IPs, or user agents;
//   * the event time, Baghdad day, and daily visitor hash are computed on the
//     server. The visitor hash is HMAC-SHA256(token, 'visitor|env|day|ip|ua')
//     truncated to 16 hex characters, so it cannot be reversed or linked across
//     days;
//   * only the ingest-token digest is sent to Supabase. The raw token never
//     reaches the database, PostgREST, or logs;
//   * analytics is enabled only when CCAFE_ANALYTICS_ENV is explicitly
//     'preview' or 'production'. An unset/invalid value disables the endpoint.
//
// Failure behaviour:
//   * the public site keeps working when this Function or Supabase is down;
//   * rejected requests return 204 for bots/rate limits so clients do not retry
//     or learn whether a limit exists;
//   * malformed requests return 400/413, configuration failures return 503.
//   * request bodies, tokens, IPs, and user agents are never logged.

const crypto = require('node:crypto');
const { BOT_RE, sanitizeEvent } = require('../../lib/analytics');

const MAX_BODY_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 4000;
const ENVS = new Set(['preview', 'production']);
const TOKEN_RE = /^[0-9a-f]{64}$/;
const VISITOR_RE = /^[0-9a-f]{16}$/;
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

function headerValue(event, name) {
  const headers = event && event.headers;
  if (!headers || typeof headers !== 'object') return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0].trim() : '';
    return typeof value === 'string' ? value.trim() : '';
  }
  return '';
}

function analyticsEnv() {
  const value = String(process.env.CCAFE_ANALYTICS_ENV || '').trim().toLowerCase();
  return ENVS.has(value) ? value : '';
}

function ingestToken() {
  const value = String(process.env.CCAFE_ANALYTICS_INGEST_TOKEN || '').trim();
  return TOKEN_RE.test(value) ? value : '';
}

function supabaseConfig() {
  const base = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  if (!base || !anonKey) return null;
  let url;
  try {
    url = new URL('/rest/v1/', base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  return { base, anonKey };
}

function timeoutMs() {
  const value = Number(process.env.CCAFE_SUPABASE_TIMEOUT_MS);
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_TIMEOUT_MS;
}

// The request must stay on the site that served the page. Origin is an extra
// check only: beacons may omit it, and the payload/token checks remain the
// real gate.
function sameOrigin(event) {
  const origin = headerValue(event, 'origin');
  if (!origin) return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = (headerValue(event, 'x-forwarded-host') || headerValue(event, 'host')).toLowerCase();
  if (!host) return true;
  return parsed.host.toLowerCase() === host;
}

function clientIp(event) {
  const direct = headerValue(event, 'x-nf-client-connection-ip');
  if (direct) return direct.split(',')[0].trim().slice(0, 200);
  const forwarded = headerValue(event, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 200);
  return '';
}

function readBody(event) {
  const raw = typeof event.body === 'string' ? event.body : '';
  if (!raw) return { ok: false, error: 'invalid' };
  let text = raw;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return { ok: false, error: 'invalid' };
    }
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes === 0) return { ok: false, error: 'invalid' };
  if (bytes > MAX_BODY_BYTES) return { ok: false, error: 'too_large' };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid' };
  }
  return { ok: true, value: parsed };
}

function baghdadDay(ms) {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

function visitorHash(token, env, day, ip, ua) {
  const value = crypto
    .createHmac('sha256', token)
    .update(`visitor|${env}|${day}|${ip}|${ua}`)
    .digest('hex')
    .slice(0, 16);
  return VISITOR_RE.test(value) ? value : '';
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(`ingest|${token}`).digest('hex');
}

async function ingest(config, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(new URL('/rest/v1/rpc/analytics_ingest', config.base), {
      method: 'POST',
      headers: {
        apikey: config.anonKey,
        Authorization: `Bearer ${config.anonKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false };
    try {
      await response.json();
    } catch {
      // A 2xx response with an unreadable body still means the row was handled.
    }
    return { ok: true };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Netlify-CDN-Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: body || '',
    isBase64Encoded: false,
  };
}

exports.handler = async (event = {}) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') {
    return {
      ...reply(405, 'Method Not Allowed'),
      headers: { ...reply(405).headers, Allow: 'POST' },
    };
  }

  const env = analyticsEnv();
  const token = ingestToken();
  const config = supabaseConfig();
  if (!env || !token || !config) return reply(503, 'Unavailable');
  if (!sameOrigin(event)) return reply(403, 'Forbidden');

  const contentLength = Number(headerValue(event, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return reply(413, 'Payload Too Large');
  }

  const ua = headerValue(event, 'user-agent');
  if (!ua || BOT_RE.test(ua)) return reply(204);
  const ip = clientIp(event);
  // The daily hash needs a real client address; without it every visitor with
  // the same browser would collapse into one. Netlify provides the header.
  if (!ip) return reply(204);

  const body = readBody(event);
  if (!body.ok) return reply(body.error === 'too_large' ? 413 : 400, 'Bad Request');

  const sanitized = sanitizeEvent(body.value, ua);
  if (!sanitized) return reply(400, 'Bad Request');

  const now = Date.now();
  const visitor = visitorHash(token, env, baghdadDay(now), ip, ua);
  if (!visitor) return reply(503, 'Unavailable');

  const result = await ingest(config, {
    p_token_sha256: tokenDigest(token),
    p_env: env,
    p_event: sanitized,
    p_visitor: visitor,
  });
  if (!result.ok) return reply(503, 'Unavailable');

  // 204 is also returned when the database rejects an event due to a shared
  // rate limit; clients must never retry or batch around the limit.
  return reply(204);
};
