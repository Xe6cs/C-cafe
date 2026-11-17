'use strict';
// Serves the admin UI from Function code instead of static files.
//
// Why a Function: the dashboard must never be published as a static asset with
// default caching, and every response must be no-store/noindex with a strict CSP.
// Only the explicit assets below are exposed; request paths are never used to
// build filesystem paths.
//
// CSP note: the draft preview is injected into an iframe with srcdoc so the
// access token never appears in a URL. A srcdoc document inherits the parent
// CSP, and the preview needs the site's inline stylesheet, Google Fonts, and
// the site's own asset images. The directives below allow exactly those, while
// scripts remain limited to 'self' and the iframe stays sandboxed without
// allow-scripts. No connect-src entry is added for preview content.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MAX_ASSET_CACHE = 8;

const ASSETS = {
  '/admin/index.html': {
    file: path.join(ROOT, 'netlify', 'admin', 'index.html'),
    type: 'text/html; charset=utf-8',
    html: true,
  },
  '/admin/app.js': {
    file: path.join(ROOT, 'netlify', 'admin', 'app.js'),
    type: 'application/javascript; charset=utf-8',
  },
  '/admin/readonly.css': {
    file: path.join(ROOT, 'netlify', 'admin', 'readonly.css'),
    type: 'text/css; charset=utf-8',
  },
  '/admin/editor.css': {
    file: path.join(ROOT, 'netlify', 'admin', 'editor.css'),
    type: 'text/css; charset=utf-8',
  },
  '/admin/editor.js': {
    file: path.join(ROOT, 'netlify', 'admin', 'editor.js'),
    type: 'application/javascript; charset=utf-8',
  },
  '/admin/stats.js': {
    file: path.join(ROOT, 'netlify', 'admin', 'stats.js'),
    type: 'application/javascript; charset=utf-8',
  },
  '/admin/admin.css': {
    file: path.join(ROOT, 'admin', 'admin.css'),
    type: 'text/css; charset=utf-8',
  },
  '/admin/vendor/supabase.js': {
    file: path.join(ROOT, 'netlify', 'admin', 'vendor', 'supabase.js'),
    type: 'application/javascript; charset=utf-8',
  },
};

const assetCache = new Map();

const BASE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Netlify-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

function supabaseOrigin() {
  const raw = String(process.env.SUPABASE_URL || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function contentSecurityPolicy() {
  const origin = supabaseOrigin();
  const connect = ["'self'", origin, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com']
    .filter(Boolean)
    .join(' ');
  return [
    "default-src 'none'",
    "script-src 'self'",
    // 'unsafe-inline' is required by the srcdoc preview's inlined site styles;
    // scripts remain restricted to 'self' and the preview never runs scripts.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function headers(type, isHtml) {
  const result = {
    ...BASE_HEADERS,
    'Content-Type': type,
  };
  if (isHtml) result['Content-Security-Policy'] = contentSecurityPolicy();
  return result;
}

function respond(statusCode, type, body, isHtml) {
  return {
    statusCode,
    headers: headers(type, isHtml),
    body,
    isBase64Encoded: false,
  };
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: message,
    isBase64Encoded: false,
  };
}

function readAsset(file) {
  if (assetCache.has(file)) return assetCache.get(file);
  const body = fs.readFileSync(file, 'utf8');
  if (assetCache.size >= MAX_ASSET_CACHE) {
    const oldest = assetCache.keys().next().value;
    if (oldest) assetCache.delete(oldest);
  }
  assetCache.set(file, body);
  return body;
}

function escapeForScript(json) {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function configResponse(method) {
  const payload = {
    supabaseUrl: String(process.env.SUPABASE_URL || '').trim(),
    supabaseAnonKey: String(process.env.SUPABASE_ANON_KEY || '').trim(),
  };
  const body = `window.CCAFE_ADMIN_CONFIG = Object.freeze(${escapeForScript(JSON.stringify(payload))});\n`;
  return respond(200, 'application/javascript; charset=utf-8', method === 'HEAD' ? '' : body, false);
}

function normalizePath(value) {
  const raw = String(value || '');
  if (!raw.startsWith('/')) return raw;
  return raw.length > 1 ? raw.replace(/\/+$/, '') || '/' : raw;
}

exports.handler = async (event = {}) => {
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return {
      statusCode: 405,
      headers: {
        ...BASE_HEADERS,
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: 'Method Not Allowed',
      isBase64Encoded: false,
    };
  }

  const pathname = normalizePath(event.path);
  if (pathname === '/admin' || pathname === '/admin/') {
    try {
      const body = readAsset(ASSETS['/admin/index.html'].file);
      return respond(200, ASSETS['/admin/index.html'].type, method === 'HEAD' ? '' : body, true);
    } catch {
      return errorResponse(500, 'Admin UI unavailable');
    }
  }

  if (pathname === '/admin/config.js') {
    return configResponse(method);
  }

  const asset = ASSETS[pathname];
  if (!asset) return errorResponse(404, 'Not Found');

  try {
    const body = readAsset(asset.file);
    return respond(200, asset.type, method === 'HEAD' ? '' : body, Boolean(asset.html));
  } catch {
    return errorResponse(500, 'Admin asset unavailable');
  }
};

exports._internal = {
  contentSecurityPolicy,
  escapeForScript,
  normalizePath,
};
