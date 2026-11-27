'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { handler } = require('../netlify/functions/site');
const DEFAULTS = require('../lib/default-content');

const saved = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_ANON_KEY,
  timeout: process.env.CCAFE_SUPABASE_TIMEOUT_MS,
  preview: process.env.CCAFE_PREVIEW_ONLY,
  context: process.env.CONTEXT,
  analytics: process.env.CCAFE_ANALYTICS_ENV,
  fetch: global.fetch,
};

function restore() {
  for (const [name, value] of [
    ['SUPABASE_URL', saved.url],
    ['SUPABASE_ANON_KEY', saved.key],
    ['CCAFE_SUPABASE_TIMEOUT_MS', saved.timeout],
    ['CCAFE_PREVIEW_ONLY', saved.preview],
    ['CONTEXT', saved.context],
    ['CCAFE_ANALYTICS_ENV', saved.analytics],
  ]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = saved.fetch;
}

function contentWith(label) {
  const copy = structuredClone(DEFAULTS);
  copy.hero.big = label;
  return copy;
}

function liveRows(content, version) {
  return {
    ok: true,
    status: 200,
    async json() {
      return [{ version, content, saved_at: '2026-11-07T00:00:00Z' }];
    },
  };
}

function assetRows(rows) {
  return {
    ok: true,
    status: 200,
    async json() {
      return rows;
    },
  };
}

function statusRows(state = 'running', message = '') {
  return assetRows([{ state, message }]);
}

function routeFetch(routes) {
  return async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (!Object.prototype.hasOwnProperty.call(routes, pathname)) {
      throw new Error(`unexpected fetch: ${pathname}`);
    }
    const value = routes[pathname];
    return typeof value === 'function' ? value(url, init) : value;
  };
}

test('live: renders actual version, content, and no analytics', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;
  const content = contentWith('محتوى حي للاختبار');
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': liveRows(content, 243),
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['X-CCafe-Source'], 'live');
    assert.equal(result.headers['X-CCafe-Version'], '243');
    assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
    assert.equal(result.headers['X-Robots-Tag'], undefined);
    assert.match(result.body, /<meta name="ccafe-content-version" content="243">/);
    assert.doesNotMatch(result.body, /<meta name="robots"/);
    assert.match(result.body, /محتوى حي للاختبار/);
    assert.match(result.body, /styles\.css/);
    assert.match(result.body, /script\.js/);
    assert.doesNotMatch(result.body, /track\.js/);
    assert.doesNotMatch(result.body, /api\/track/);
  } finally {
    restore();
  }
});

test('preview: live responses are noindex only when the preview flag is set', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  process.env.CCAFE_PREVIEW_ONLY = '1';
  delete process.env.CONTEXT;
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': liveRows(contentWith('preview content'), 244),
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'live');
    assert.equal(result.headers['X-Robots-Tag'], 'noindex');
    assert.equal(result.headers['X-CCafe-Preview'], '1');
    assert.match(result.body, /<meta name="robots" content="noindex">/);
    assert.match(result.body, /<meta name="ccafe-content-version" content="244">/);
    assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
    assert.equal(result.headers['Netlify-CDN-Cache-Control'], 'no-store');
  } finally {
    restore();
  }
});

test('fallback: fetch failure is marked and never claims a live version', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content'() {
      throw new Error('network down');
    },
  });

  try {
    const result = await handler({ path: '/index.html', httpMethod: 'GET' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers['X-CCafe-Source'], 'fallback');
    assert.equal(result.headers['X-CCafe-Reason'], 'fetch-error');
    assert.equal(result.headers['X-Robots-Tag'], 'noindex');
    assert.match(result.body, /<meta name="ccafe-content-version" content="fallback">/);
    assert.match(result.body, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(result.body, /track\.js/);
  } finally {
    restore();
  }
});

test('fallback: invalid payload is rejected', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': assetRows({ nope: true }),
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'fallback');
    assert.equal(result.headers['X-CCafe-Reason'], 'invalid-data');
  } finally {
    restore();
  }
});

test('fallback: read timeout is reported as timeout', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.CCAFE_SUPABASE_TIMEOUT_MS = '30';
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content'(url, options) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'fallback');
    assert.equal(result.headers['X-CCafe-Reason'], 'timeout');
  } finally {
    restore();
  }
});

test('fallback: missing configuration does not call the network', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('should not be called');
  };

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(called, false);
    assert.equal(result.statusCode, 503);
    assert.equal(result.headers['X-CCafe-Source'], 'unavailable');
    assert.equal(result.headers['X-CCafe-Site-State'], 'unknown');
    assert.equal(result.headers['X-CCafe-Reason'], 'missing-config');
  } finally {
    restore();
  }
});

test('live: published media resolves to the public bucket with no signed URL', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;

  const assetId = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';
  const otherId = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const objectPath = `published/${assetId}/${'b'.repeat(64)}`;
  const publicUrl = `https://example.supabase.co/storage/v1/object/public/ccafe-public/${objectPath}`;
  const content = contentWith('وسائط منشورة');
  content.hero.mark = `media/${assetId}`;
  content.vibes.tiles[0].image = `media/${otherId}`;

  const calls = [];
  const headers = [];
  global.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    headers.push({ url: parsed, init });
    if (parsed.pathname === '/rest/v1/public_site_status') return statusRows();
    if (parsed.pathname === '/rest/v1/published_content') return liveRows(content, 250);
    if (parsed.pathname === '/rest/v1/media_public_assets') {
      return assetRows([
        { asset_id: assetId, object_path: objectPath },
        // Staging paths, malformed ids, and non-published names are ignored even
        // if a future policy mistake ever returned them.
        { asset_id: otherId, object_path: `staging/${otherId}/${'c'.repeat(64)}` },
        { asset_id: 'not-a-uuid', object_path: objectPath },
        { asset_id: otherId, object_path: '../../secret' },
      ]);
    }
    throw new Error(`unexpected fetch: ${parsed.href}`);
  };

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'live');
    assert.match(result.body, new RegExp(publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.body, /token=/);
    assert.doesNotMatch(result.body, /ccafe-media/);
    assert.doesNotMatch(result.body, /staging\//);

    const assetsCall = calls.find((call) => call.pathname === '/rest/v1/media_public_assets');
    assert.ok(assetsCall, 'the site reads only the public asset table');
    assert.equal(assetsCall.searchParams.get('state'), 'eq.ready');
    assert.equal(assetsCall.searchParams.get('asset_id'), `in.(${assetId},${otherId})`);
    assert.equal(assetsCall.searchParams.get('select'), 'asset_id,object_path');
    const assetsInit = headers.find((entry) => entry.url.pathname === '/rest/v1/media_public_assets').init;
    assert.equal(assetsInit.headers.apikey, 'anon-test-key');
    assert.equal(assetsInit.headers.Authorization, 'Bearer anon-test-key');
    assert.equal(assetsInit.headers.apikey, process.env.SUPABASE_ANON_KEY);
  } finally {
    restore();
  }
});

test('live: a failed public-asset read falls back without leaking private refs', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;

  const assetId = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';
  const content = contentWith('فشل الوسائط');
  content.hero.mark = `media/${assetId}`;
  global.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/rest/v1/public_site_status') return statusRows();
    if (parsed.pathname === '/rest/v1/published_content') return liveRows(content, 251);
    return { ok: false, status: 500, async json() { return null; } };
  };

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'fallback');
    assert.equal(result.headers['X-CCafe-Reason'], 'http-500');
    assert.doesNotMatch(result.body, /media\//);
    assert.doesNotMatch(result.body, /ccafe-public/);
  } finally {
    restore();
  }
});

test('only GET/HEAD page routes are served; analytics and other paths are 404', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': liveRows(contentWith('ok'), 7),
  });

  try {
    const track = await handler({ path: '/api/track', httpMethod: 'GET' });
    assert.equal(track.statusCode, 404);

    const missing = await handler({ path: '/admin/', httpMethod: 'GET' });
    assert.equal(missing.statusCode, 404);

    const post = await handler({ path: '/', httpMethod: 'POST' });
    assert.equal(post.statusCode, 405);

    const direct = await handler({ path: '/.netlify/functions/site', httpMethod: 'GET' });
    assert.equal(direct.statusCode, 200);
    assert.equal(direct.headers['X-CCafe-Source'], 'live');
  } finally {
    restore();
  }
});

test('live: tracking loads only when CCAFE_ANALYTICS_ENV is explicit', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;
  const content = contentWith('تحليلات');
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': liveRows(content, 250),
  });

  try {
    delete process.env.CCAFE_ANALYTICS_ENV;
    let result = await handler({ path: '/', httpMethod: 'GET' });
    assert.doesNotMatch(result.body, /track\.js/);

    process.env.CCAFE_ANALYTICS_ENV = 'staging';
    result = await handler({ path: '/', httpMethod: 'GET' });
    assert.doesNotMatch(result.body, /track\.js/);

    process.env.CCAFE_ANALYTICS_ENV = 'preview';
    result = await handler({ path: '/', httpMethod: 'GET' });
    assert.match(result.body, /<script src="track\.js" defer><\/script>/);
    assert.doesNotMatch(result.body, /<meta name="robots"/);
    assert.equal(result.headers['X-Robots-Tag'], undefined);

    // The public preview page is noindex but still tracks, because analytics
    // and indexing are separate concerns.
    process.env.CCAFE_PREVIEW_ONLY = '1';
    result = await handler({ path: '/', httpMethod: 'GET' });
    assert.match(result.body, /track\.js/);
    assert.match(result.body, /<meta name="robots" content="noindex">/);
    assert.equal(result.headers['X-Robots-Tag'], 'noindex');
  } finally {
    restore();
  }
});

test('fallback never loads tracking even when analytics is configured', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows(),
    '/rest/v1/published_content': { ok: false, status: 500, async json() { return null; } },
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.headers['X-CCafe-Source'], 'fallback');
    assert.doesNotMatch(result.body, /track\.js/);
  } finally {
    restore();
  }
});

test('stopped: returns a content-free server-rendered 503 page with escaped message', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;
  delete process.env.CCAFE_ANALYTICS_ENV;
  const message = '<b>ختم</b> & "اقتباس" \'مفرد\'';
  let publishedCalled = false;
  global.fetch = routeFetch({
    '/rest/v1/public_site_status': statusRows('stopped', message),
    '/rest/v1/published_content'() {
      publishedCalled = true;
      throw new Error('published content must not be read while stopped');
    },
  });

  try {
    const result = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(result.statusCode, 503);
    assert.equal(result.headers['X-CCafe-Source'], 'unavailable');
    assert.equal(result.headers['X-CCafe-Site-State'], 'stopped');
    assert.equal(result.headers['X-CCafe-Reason'], 'site_stopped');
    assert.equal(result.headers['Retry-After'], '300');
    assert.equal(result.headers['X-Robots-Tag'], 'noindex, nofollow');
    assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
    assert.equal(result.headers['Netlify-CDN-Cache-Control'], 'no-store');
    assert.match(result.headers['Content-Security-Policy'], /default-src 'none'/);
    assert.match(result.body, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(result.body, /<meta name="ccafe-site-state" content="stopped">/);
    assert.match(result.body, /الموقع متوقف مؤقتًا/);
    assert.match(result.body, /&lt;b&gt;ختم&lt;\/b&gt; &amp; &quot;اقتباس&quot; &#39;مفرد&#39;/);
    assert.doesNotMatch(result.body, /<b>ختم<\/b>/);
    assert.doesNotMatch(result.body, /ccafe-content-version/);
    assert.doesNotMatch(result.body, /<script/i);
    assert.doesNotMatch(result.body, /track\.js/);
    assert.doesNotMatch(result.body, /api\/track/);
    assert.doesNotMatch(result.body, /https?:\/\//);
    assert.doesNotMatch(result.body, /\/storage\//);
    assert.equal(publishedCalled, false);
  } finally {
    restore();
  }
});

test('stopped: all public page paths and HEAD use the same stop response', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete process.env.CCAFE_PREVIEW_ONLY;
  delete process.env.CONTEXT;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push({ parsed, init });
    return statusRows('stopped', '');
  };

  try {
    for (const path of ['/', '/index.html', '/.netlify/functions/site']) {
      const result = await handler({ path, httpMethod: 'GET' });
      assert.equal(result.statusCode, 503);
      assert.equal(result.headers['X-CCafe-Site-State'], 'stopped');
      assert.match(result.body, /الموقع متوقف مؤقتًا/);
    }
    const head = await handler({ path: '/', httpMethod: 'HEAD' });
    assert.equal(head.statusCode, 503);
    assert.equal(head.body, '');
    assert.equal(head.headers['X-CCafe-Site-State'], 'stopped');

    const statusCall = requests.find((entry) => entry.parsed.pathname === '/rest/v1/public_site_status');
    assert.ok(statusCall);
    assert.equal(statusCall.parsed.searchParams.get('select'), 'state,message');
    assert.equal(statusCall.parsed.searchParams.get('limit'), '1');
    assert.equal(statusCall.init.headers.apikey, 'anon-test-key');
    assert.equal(statusCall.init.headers.Authorization, 'Bearer anon-test-key');
    assert.equal(requests.every((entry) => !entry.parsed.pathname.includes('published_content')), true);
  } finally {
    restore();
  }
});

test('unknown or invalid site state fails closed without using published or fallback content', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;

  for (const status of [statusRows('paused', ''), statusRows('stopped', 'x'.repeat(301)), { ok: false, status: 500, async json() { return null; } }]) {
    let publishedCalled = false;
    global.fetch = routeFetch({
      '/rest/v1/public_site_status': status,
      '/rest/v1/published_content'() {
        publishedCalled = true;
        throw new Error('published content must not be read for an unknown state');
      },
    });

    try {
      const result = await handler({ path: '/', httpMethod: 'GET' });
      assert.equal(result.statusCode, 503);
      assert.equal(result.headers['X-CCafe-Site-State'], 'unknown');
      assert.equal(result.headers['X-CCafe-Source'], 'unavailable');
      assert.match(result.body, /الموقع غير متاح مؤقتًا/);
      assert.doesNotMatch(result.body, /ccafe-content-version/);
      assert.equal(publishedCalled, false);
    } finally {
      restore();
    }
  }
});

test('stopped: the public Function does not intercept admin or API paths', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('admin and API paths must not read site state');
  };

  try {
    for (const path of ['/admin/', '/admin/app.js', '/api/admin/site-status', '/api/track']) {
      const result = await handler({ path, httpMethod: 'GET' });
      assert.equal(result.statusCode, 404, path);
      assert.equal(result.body, 'Not Found', path);
    }
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('a later status-read failure fails closed even after a running response', async () => {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  const content = contentWith('live-before-failure');
  let publishedCalled = false;

  try {
    global.fetch = routeFetch({
      '/rest/v1/public_site_status': statusRows('running'),
      '/rest/v1/published_content': liveRows(content, 7),
    });
    const live = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers['X-CCafe-Source'], 'live');
    assert.match(live.body, /live-before-failure/);

    global.fetch = routeFetch({
      '/rest/v1/public_site_status': { ok: false, status: 500, async json() { return null; } },
      '/rest/v1/published_content'() {
        publishedCalled = true;
        throw new Error('a failed status read must never fall through to content');
      },
    });
    const unknown = await handler({ path: '/', httpMethod: 'GET' });
    assert.equal(unknown.statusCode, 503);
    assert.equal(unknown.headers['X-CCafe-Site-State'], 'unknown');
    assert.equal(unknown.headers['X-CCafe-Reason'], 'http-500');
    assert.equal(unknown.headers['X-CCafe-Source'], 'unavailable');
    assert.doesNotMatch(unknown.body, /live-before-failure|ccafe-content-version/);
    assert.equal(publishedCalled, false);
  } finally {
    restore();
  }
});
