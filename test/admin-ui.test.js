'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { handler, _internal } = require('../netlify/functions/admin-ui');

const saved = {
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_ANON_KEY,
  fetch: global.fetch,
};

function configure() {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'anon-test-key';
}

function restore() {
  for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_ANON_KEY', saved.key]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  global.fetch = saved.fetch;
}

function event(pathname, method = 'GET') {
  return { path: pathname, httpMethod: method, headers: {} };
}

function assertPrivateHeaders(result) {
  assert.equal(result.headers['Cache-Control'], 'no-store, max-age=0');
  assert.equal(result.headers['Netlify-CDN-Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(result.headers['X-Frame-Options'], 'DENY');
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
}

test('serves the admin HTML with a strict CSP and no caching', async () => {
  configure();

  try {
    for (const pathname of ['/admin', '/admin/', '/admin/index.html']) {
      const result = await handler(event(pathname));
      assert.equal(result.statusCode, 200);
      assert.match(result.headers['Content-Type'], /^text\/html/);
      assertPrivateHeaders(result);

      const csp = result.headers['Content-Security-Policy'];
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-eval/);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
      assert.match(csp, /style-src 'self' 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
      assert.match(csp, /img-src 'self' data: https:/);
      assert.match(csp, /connect-src 'self' https:\/\/example\.supabase\.co/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /form-action 'none'/);

      assert.match(result.body, /<meta name="robots" content="noindex, nofollow">/);
      assert.match(result.body, /\/admin\/config\.js/);
      assert.match(result.body, /\/admin\/vendor\/supabase\.js/);
      assert.match(result.body, /\/admin\/editor\.js/);
      assert.match(result.body, /\/admin\/stats\.js/);
      assert.match(result.body, /\/admin\/app\.js/);
      assert.match(result.body, /\/admin\/readonly\.css/);
      assert.match(result.body, /\/admin\/editor\.css/);
      assert.match(result.body, /id="status-pill"/);
      assert.match(result.body, /id="save-btn"/);
      assert.match(result.body, /id="publish-btn"/);
      assert.match(result.body, /id="delete-btn"/);
      assert.match(result.body, /id="status-banner"/);
      assert.match(result.body, /نشر المسودة/);
      assert.match(result.body, /data-nav="media"/);
      assert.match(result.body, /مكتبة الوسائط/);
      assert.match(result.body, /data-nav="stats"/);
      assert.match(result.body, /نشاط الزوار/);
      assert.match(result.body, /data-nav="site-status"/);
      assert.match(result.body, /حالة الموقع/);
      assert.doesNotMatch(result.body, /service_role/);
    }
  } finally {
    restore();
  }
});

test('admin dashboard and assets never consult the public site-state route', async () => {
  configure();
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('admin assets must load without a public site-state read');
  };

  try {
    for (const pathname of [
      '/admin/',
      '/admin/app.js',
      '/admin/editor.js',
      '/admin/editor.css',
      '/admin/config.js',
      '/admin/vendor/supabase.js',
    ]) {
      const result = await handler(event(pathname));
      assert.equal(result.statusCode, 200, pathname);
      assertPrivateHeaders(result);
    }
    assert.equal(called, false);
  } finally {
    restore();
  }
});

test('admin scripts have the expected content types and security headers', async () => {
  configure();

  try {
    const app = await handler(event('/admin/app.js'));
    assert.equal(app.statusCode, 200);
    assert.match(app.headers['Content-Type'], /^application\/javascript/);
    assertPrivateHeaders(app);
    assert.match(app.body, /persistSession: false/);
    assert.match(app.body, /autoRefreshToken: false/);
    assert.match(app.body, /detectSessionInUrl: false/);
    assert.match(app.body, /const API = '\/api\/admin'/);
    assert.match(app.body, /\$\{API\}\/bootstrap/);
    assert.match(app.body, /\$\{API\}\/history/);
    assert.match(app.body, /\$\{API\}\/draft/);
    assert.match(app.body, /\$\{API\}\/preview/);
    assert.match(app.body, /\$\{API\}\/publish/);
    assert.match(app.body, /\$\{API\}\/restore/);
    assert.match(app.body, /\$\{API\}\/verify/);
    assert.match(app.body, /\$\{API\}\/site-status/);
    assert.match(app.body, /MAX_SITE_MESSAGE = 300/);
    assert.match(app.body, /site-state|site-status/);
    assert.match(app.body, /status-banner-conflict/);
    assert.match(app.body, /beforeunload/);
    assert.match(app.body, /AUTOSAVE_MS/);
    // Site status: write results are historical only, the current state comes
    // from a fresh GET, stale reads are ignored, dialogs are guarded, and a
    // lost response keeps the full request for an explicit in-memory retry.
    assert.match(app.body, /const confirmed = normalizeSiteStatusWrite/);
    assert.match(app.body, /const fetched = await loadSiteStatus\(true, \{ quiet: true \}\)/);
    assert.match(app.body, /state\.siteStatus\.loadSeq/);
    assert.match(app.body, /value\.revision >= current\.revision/);
    assert.match(app.body, /state\.siteStatus\.dialogBusy = true/);
    assert.match(app.body, /async function retryPendingSiteStatus/);
    assert.match(app.body, /expected_revision: status\.revision/);

    // No persistent credentials and no direct write RPCs from the browser.
    // Publish/restore/verify must go through /api/admin only.
    assert.doesNotMatch(app.body, /localStorage\s*(?:\.|\[)/);
    assert.doesNotMatch(app.body, /sessionStorage\s*(?:\.|\[)/);
    assert.doesNotMatch(app.body, /document\.cookie\s*=/);
    assert.doesNotMatch(app.body, /service_role/);
    assert.doesNotMatch(app.body, /signInWithOtp/);
    assert.doesNotMatch(app.body, /admin_save_draft/);
    assert.doesNotMatch(app.body, /admin_delete_draft/);
    assert.doesNotMatch(app.body, /admin_publish/);
    assert.doesNotMatch(app.body, /admin_restore/);
    assert.doesNotMatch(app.body, /admin_begin_public_check/);
    assert.doesNotMatch(app.body, /admin_site_status/);
    assert.doesNotMatch(app.body, /admin_set_site_status/);
    // Uploads go straight to the private bucket with the admin JWT; nothing else
    // in the browser touches the Storage API.
    assert.match(app.body, /\/storage\/v1\/object\/ccafe-media\//);
    assert.doesNotMatch(app.body, /\/storage\/v1\/(?!object\/ccafe-media\/)/);
    assert.doesNotMatch(app.body, /storage\/v1\/object\/sign/);
    assert.doesNotMatch(app.body, /setInterval/);
    // The file picker must snapshot the FileList before resetting the input;
    // clearing `value` empties the live FileList and silently drops the upload.
    assert.match(app.body, /const files = Array\.from\(event\.target\.files \|\| \[\]\);/);
    assert.doesNotMatch(app.body, /const files = event\.target\.files;\s*\n\s*event\.target\.value = '';/);
    // Approved media previews must render after a reload, when the editor is
    // already showing `media/<uuid>` before the first media list request ends.
    assert.match(app.body, /if \(!wasLoaded && state\.media\.loaded && state\.content\s*\n\s*&& EDITOR_VIEWS\.has\(state\.view\)\) \{/);

    // Recoverable deletion goes through the admin API only. The browser never
    // learns trash bucket names or object paths, and never calls an RPC itself.
    assert.match(app.body, /\$\{API\}\/media\/usage\?id=/);
    assert.match(app.body, /\$\{API\}\/media\/trash/);
    assert.match(app.body, /\$\{API\}\/media\/delete/);
    assert.match(app.body, /\$\{API\}\/media\/restore/);
    assert.match(app.body, /\$\{API\}\/media\/cleanup/);
    assert.doesNotMatch(app.body, /admin_media_/);
    assert.doesNotMatch(app.body, /ccafe-trash/);
    assert.doesNotMatch(app.body, /trash\/[0-9a-f]{8}/);
    assert.doesNotMatch(app.body, /object_path/);
    assert.doesNotMatch(app.body, /storage\/v1\/object\/ccafe-trash/);
    // Only approved uploads get a delete control; originals stay read-only.
    assert.match(app.body, /const deleteButton = asset\.status === 'approved'/);
    assert.doesNotMatch(app.body, /deleteMediaAsset\(item\)/);
    // Every destructive action is guarded by a usage check and a confirmation.
    assert.match(app.body, /async function deleteMediaAsset\(asset\) \{[\s\S]*?media\/usage\?id=/);
    assert.match(app.body, /const confirmed = await deleteMediaConfirm\(asset\);/);
    assert.match(app.body, /case 'published':/);
    assert.match(app.body, /case 'history':/);
    assert.doesNotMatch(app.body, /case 'public_ready':/);
    assert.match(app.body, /public_cleanup_state/);
    assert.match(app.body, /تنظيف النسخة العامة معلّق/);
    assert.match(app.body, /سلة المهملات/);
    assert.match(app.body, /استرداد/);
    assert.match(app.body, /إعادة محاولة التنظيف/);

    const editor = await handler(event('/admin/editor.js'));
    assert.equal(editor.statusCode, 200);
    assert.match(editor.headers['Content-Type'], /^application\/javascript/);
    assertPrivateHeaders(editor);
    assert.match(editor.body, /diffContent/);
    assert.match(editor.body, /renderSections/);
    assert.doesNotMatch(editor.body, /localStorage\s*(?:\.|\[)/);
    assert.doesNotMatch(editor.body, /service_role/);
    assert.doesNotMatch(editor.body, /admin_publish/);
    assert.doesNotMatch(editor.body, /fetch\s*\(/);

    const css = await handler(event('/admin/readonly.css'));
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['Content-Type'], /^text\/css/);
    assertPrivateHeaders(css);

    const editorCss = await handler(event('/admin/editor.css'));
    assert.equal(editorCss.statusCode, 200);
    assert.match(editorCss.headers['Content-Type'], /^text\/css/);
    assert.match(editorCss.body, /\.status-banner/);
    assert.match(editorCss.body, /\.preview-frame/);
    assert.match(editorCss.body, /\.media-card-actions/);
    assert.match(editorCss.body, /\.media-confirm/);
    assert.match(editorCss.body, /\.media-trash-error/);
    assert.match(editorCss.body, /\.site-state-row/);
    assert.match(editorCss.body, /\.site-status-actions/);

    const readonlyCss = await handler(event('/admin/readonly.css'));
    assert.equal(readonlyCss.statusCode, 200);
    assert.match(readonlyCss.body, /\.history-head-title/);

    const adminCss = await handler(event('/admin/admin.css'));
    assert.equal(adminCss.statusCode, 200);
    assert.match(adminCss.headers['Content-Type'], /^text\/css/);
    assert.match(adminCss.body, /--orange:/);

    const vendorPath = path.join(__dirname, '..', 'netlify', 'admin', 'vendor', 'supabase.js');
    assert.equal(fs.existsSync(vendorPath), true, 'run npm run build to copy the pinned Supabase UMD');
    const vendor = await handler(event('/admin/vendor/supabase.js'));
    assert.equal(vendor.statusCode, 200);
    assert.match(vendor.headers['Content-Type'], /^application\/javascript/);
    assertPrivateHeaders(vendor);
    assert.match(vendor.body, /createClient/);
    assert.doesNotMatch(vendor.body, /service_role/);
  } finally {
    restore();
  }
});

test('config.js exposes only the public URL and anon key, escaped for embedding', async () => {
  configure();

  try {
    const result = await handler(event('/admin/config.js'));
    assert.equal(result.statusCode, 200);
    assert.match(result.headers['Content-Type'], /^application\/javascript/);
    assertPrivateHeaders(result);
    assert.match(result.body, /window\.CCAFE_ADMIN_CONFIG = Object\.freeze\(/);
    assert.match(result.body, /"supabaseUrl":"https:\/\/example\.supabase\.co"/);
    assert.match(result.body, /"supabaseAnonKey":"anon-test-key"/);
    assert.doesNotMatch(result.body, /service_role/);
    assert.doesNotMatch(result.body, /SUPABASE_ACCESS_TOKEN/);
    assert.doesNotMatch(result.body, /refresh_token/);

    const escaped = _internal.escapeForScript('{"x":"<>&\u2028\u2029"}');
    assert.equal(escaped.includes('<'), false);
    assert.equal(escaped.includes('>'), false);
    assert.equal(escaped.includes('&'), false);
    assert.equal(escaped.includes('\u2028'), false);
    assert.equal(escaped.includes('\u2029'), false);
    assert.match(escaped, /\\u003c/);
    assert.match(escaped, /\\u003e/);
    assert.match(escaped, /\\u0026/);
  } finally {
    restore();
  }
});

test('config.js still loads safely when settings are missing', async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;

  try {
    const result = await handler(event('/admin/config.js'));
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /"supabaseUrl":""/);
    assert.match(result.body, /"supabaseAnonKey":""/);

    const html = await handler(event('/admin/'));
    assert.match(html.headers['Content-Security-Policy'], /connect-src 'self' https:\/\/fonts\.googleapis\.com/);
  } finally {
    restore();
  }
});

test('only GET/HEAD are allowed', async () => {
  configure();

  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const result = await handler(event('/admin/', method));
      assert.equal(result.statusCode, 405);
      assert.equal(result.headers.Allow, 'GET, HEAD');
      assertPrivateHeaders(result);
    }
  } finally {
    restore();
  }
});

test('HEAD returns headers without a body', async () => {
  configure();

  try {
    for (const pathname of ['/admin/', '/admin/app.js', '/admin/editor.js', '/admin/readonly.css', '/admin/editor.css', '/admin/config.js', '/admin/vendor/supabase.js']) {
      const result = await handler(event(pathname, 'HEAD'));
      assert.equal(result.statusCode, 200);
      assert.equal(result.body, '');
    }
  } finally {
    restore();
  }
});
test('unknown and traversal paths are 404 and never read files', async () => {
  configure();

  try {
    for (const pathname of [
      '/admin/nope',
      '/admin/../package.json',
      '/admin/app.js.map',
      '/admin/vendor/',
      '/package.json',
      '/.netlify/functions/admin-ui',
    ]) {
      const result = await handler(event(pathname));
      assert.equal(result.statusCode, 404);
      assertPrivateHeaders(result);
    }
  } finally {
    restore();
  }
});

test('path normalisation keeps trailing-slash variants working', () => {
  assert.equal(_internal.normalizePath('/admin/'), '/admin');
  assert.equal(_internal.normalizePath('/admin/app.js/'), '/admin/app.js');
  assert.equal(_internal.normalizePath('/'), '/');
});

test('the analytics admin page is served privately and has no credentials of its own', async () => {
  configure();

  try {
    const stats = await handler(event('/admin/stats.js'));
    assert.equal(stats.statusCode, 200);
    assert.match(stats.headers['Content-Type'], /^application\/javascript/);
    assertPrivateHeaders(stats);
    assert.match(stats.body, /window\.CcafeStats/);
    assert.match(stats.body, /\/api\/admin\/analytics\?range=/);
    assert.match(stats.body, /\/api\/admin\/analytics\/clear/);
    assert.match(stats.body, /confirmDialog/);
    assert.match(stats.body, /جارٍ تحميل نشاط الزوار/);
    assert.match(stats.body, /تعذّر عرض البيانات/);
    // The page never reads or stores a token; app.js supplies authenticated
    // helpers, so the JWT stays in memory and no direct RPC is called.
    assert.doesNotMatch(stats.body, /localStorage\s*(?:\.|\[)/);
    assert.doesNotMatch(stats.body, /document\.cookie\s*=/);
    assert.doesNotMatch(stats.body, /SUPABASE_/);
    assert.doesNotMatch(stats.body, /Bearer/);
    assert.doesNotMatch(stats.body, /admin_analytics_/);
    assert.doesNotMatch(stats.body, /service_role/);
  } finally {
    restore();
  }
});
