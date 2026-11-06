'use strict';
// اختبارات الأمان والسلوك الأساسي. التشغيل: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { createApp, sniffImage } = require('../server');
const { renderPage, safeUrl } = require('../lib/render');
const { normalize } = require('../lib/schema');
const DEFAULTS = require('../lib/default-content');
const { Analytics, classifySource, parseAgent } = require('../lib/analytics');

const BROWSER = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
const ROOT = path.join(__dirname, '..');

async function startApp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccafe-test-'));
  const app = createApp({ dataDir: path.join(dir, 'data'), indexOut: path.join(dir, 'index.html'), root: ROOT });
  await app.init();
  const server = http.createServer(app.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { app, dir, port: server.address().port };
}

// عميل HTTP خام لأن fetch يمنع تعديل ترويسة Host
function request(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const ADMIN = { 'X-CCafe-Admin': '1', 'Content-Type': 'application/json' };

test('اللوحة تفتح من الجهاز نفسه بلا كلمة مرور', async (t) => {
  const { port } = await startApp(t);
  const res = await request(port, 'GET', '/admin/api/bootstrap', { headers: { Host: `localhost:${port}` } });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.text).access.local, true);
});

test('اللوحة مخفية عن أي طلب من خارج الجهاز', async (t) => {
  const { port } = await startApp(t);
  const cases = [
    { Host: 'ccafe.iq' },
    { Host: 'evil.example' },
    { Host: `localhost:${port}`, 'X-Forwarded-For': '203.0.113.5' },
    { Host: `localhost:${port}`, Forwarded: 'for=203.0.113.5' },
    { Host: `localhost:${port}`, 'X-Real-IP': '203.0.113.5' },
  ];
  for (const headers of cases) {
    for (const url of ['/admin/', '/admin/app.js', '/admin/api/bootstrap', '/admin/api/stats', '/admin-preview']) {
      const res = await request(port, 'GET', url, { headers });
      assert.equal(res.status, 404, `${url} ${JSON.stringify(headers)}`);
    }
  }
});

test('الرابط السري يمنح جهازًا بعيدًا الوصول، والمفتاح الخاطئ لا يفعل', async (t) => {
  const { port, app } = await startApp(t);
  const remote = { Host: 'ccafe.iq' };
  const wrong = await request(port, 'GET', '/admin/?key=wrong', { headers: remote });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const good = await request(port, 'GET', `/admin/?key=${app.adminKey}`, { headers: remote });
  assert.equal(good.status, 302);
  assert.equal(good.headers.location, '/admin/');
  const cookie = good.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const session = { ...remote, Cookie: cookie.split(';')[0] };
  assert.equal((await request(port, 'GET', '/admin/', { headers: session })).status, 200);

  const rotated = await request(port, 'POST', '/admin/api/access/rotate', { headers: { ...session, ...ADMIN }, body: '{}' });
  assert.equal(rotated.status, 200);
  assert.equal((await request(port, 'GET', '/admin/', { headers: session })).status, 404, 'الجلسة القديمة تُلغى بعد تغيير الرابط');
  const fresh = { ...remote, Cookie: rotated.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await request(port, 'GET', '/admin/', { headers: fresh })).status, 200);
});

test('المواقع الأخرى لا تستطيع تنفيذ تغييرات عبر المتصفح', async (t) => {
  const { port } = await startApp(t);
  const host = `localhost:${port}`;
  const body = JSON.stringify({ content: DEFAULTS });
  const attempts = [
    { Host: host, 'Content-Type': 'application/json' },
    { Host: host, ...ADMIN, Origin: 'https://evil.example' },
    { Host: host, ...ADMIN, 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const headers of attempts) {
    const res = await request(port, 'POST', '/admin/api/publish', { headers, body });
    assert.equal(res.status, 403, JSON.stringify(headers));
  }
  const ok = await request(port, 'POST', '/admin/api/publish', { headers: { Host: host, ...ADMIN, Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' }, body });
  assert.equal(ok.status, 200);
});

test('لا تُخدم ملفات الخادم والبيانات، ولا يمكن الخروج من مجلد الصور', async (t) => {
  const { port } = await startApp(t);
  const blocked = [
    '/server.js', '/package.json', '/data/config.json', '/data/content.json', '/lib/render.js',
    '/assets/../server.js', '/assets/%2e%2e/server.js', '/assets/..%2fserver.js', '/assets/..%5cserver.js',
    '/assets/photos/..%2f..%2fserver.js', '/assets/brand/logo.svg%00.png', '/.env', '/README.md',
  ];
  for (const url of blocked) {
    const res = await request(port, 'GET', url);
    assert.equal(res.status, 404, url);
  }
  assert.equal((await request(port, 'GET', '/')).status, 200);
  assert.equal((await request(port, 'GET', '/styles.css')).status, 200);
  const svg = await request(port, 'GET', '/assets/brand/logo.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.headers['content-security-policy'], 'sandbox');
});

test('النشر يحدّث الصفحة، والسجل يستعيد النسخة السابقة', async (t) => {
  const { port, dir } = await startApp(t);
  const headers = { Host: `localhost:${port}`, ...ADMIN };
  const changed = normalize(DEFAULTS, DEFAULTS);
  changed.hero.big = 'مزاج-تجريبي';
  const pub = await request(port, 'POST', '/admin/api/publish', { headers, body: JSON.stringify({ content: changed }) });
  assert.equal(pub.status, 200);
  assert.match((await request(port, 'GET', '/')).text, /مزاج-تجريبي/);
  assert.match(await fs.readFile(path.join(dir, 'index.html'), 'utf8'), /مزاج-تجريبي/);

  const history = JSON.parse((await request(port, 'GET', '/admin/api/history', { headers })).text).items;
  assert.equal(history.length, 2);
  const oldest = history[history.length - 1];
  const restored = await request(port, 'POST', '/admin/api/history/restore', { headers, body: JSON.stringify({ id: oldest.id }) });
  assert.equal(restored.status, 200);
  assert.doesNotMatch((await request(port, 'GET', '/')).text, /مزاج-تجريبي/);

  const traversal = await request(port, 'POST', '/admin/api/history/restore', { headers, body: JSON.stringify({ id: '../config.json' }) });
  assert.equal(traversal.status, 400);
});

test('المسودة تظهر في المعاينة فقط ولا تمس الموقع العام', async (t) => {
  const { port } = await startApp(t);
  const headers = { Host: `localhost:${port}`, ...ADMIN };
  const changed = normalize(DEFAULTS, DEFAULTS);
  changed.hero.big = 'مسودة-فقط';
  await request(port, 'PUT', '/admin/api/draft', { headers, body: JSON.stringify({ content: changed }) });
  const preview = await request(port, 'GET', '/admin-preview', { headers });
  assert.match(preview.text, /مسودة-فقط/);
  assert.doesNotMatch(preview.text, /track\.js/);
  assert.doesNotMatch((await request(port, 'GET', '/')).text, /مسودة-فقط/);
});

test('رفع الصور يتحقق من المحتوى الفعلي للملف', async (t) => {
  const { port } = await startApp(t);
  const headers = { Host: `localhost:${port}`, 'X-CCafe-Admin': '1' };
  const fake = await request(port, 'POST', '/admin/api/media?name=shell.php', { headers, body: '<?php echo 1; ?>' });
  assert.equal(fake.status, 415);
  const html = await request(port, 'POST', '/admin/api/media?name=a.svg', { headers, body: '<html><script>alert(1)</script></html>' });
  assert.equal(html.status, 415);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x"></svg>')), null);
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>')), '.svg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(20)])), '.jpg');
  const del = await request(port, 'DELETE', `/admin/api/media?path=${encodeURIComponent('assets/brand/logo.svg')}`, { headers });
  assert.equal(del.status, 403);
  const used = await request(port, 'DELETE', `/admin/api/media?path=${encodeURIComponent('assets/photos/coffee.webp')}`, { headers });
  assert.equal(used.status, 409);
  const escape = await request(port, 'DELETE', `/admin/api/media?path=${encodeURIComponent('assets/photos/../../server.js')}`, { headers });
  assert.equal(escape.status, 403);
});

test('الصفحة تهرب كل النصوص وترفض الروابط الخطرة', () => {
  const c = normalize(DEFAULTS, DEFAULTS);
  c.hero.big = '<script>alert(1)</script>';
  c.hero.primary.href = 'javascript:alert(1)';
  c.moods.items[0].alt = '"><img src=x onerror=alert(1)>';
  c.moods.items[0].image = '../../server.js';
  c.seo.title = '</title><script>alert(2)</script>';
  c.contact.name = '</script><script>alert(3)</script>';
  const html = renderPage(c);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /javascript:alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /\.\.\/\.\.\/server\.js/);
  for (const bad of ['javascript:x', 'data:text/html,x', ' JaVaScRiPt:x', '//evil.example', 'vbscript:x']) assert.equal(safeUrl(bad), '', bad);
  for (const good of ['https://a.b/c', 'tel:+964', 'mailto:a@b.c', '#menu', '/x']) assert.equal(safeUrl(good), good);
});

test('إخفاء قسم يزيل الروابط المؤدية إليه، والمنيو يعرض الأصناف والأسعار', () => {
  const c = normalize(DEFAULTS, DEFAULTS);
  c.menu.visible = false;
  let html = renderPage(c);
  assert.doesNotMatch(html, /href="#menu"/);
  assert.doesNotMatch(html, /id="menu"/);

  c.menu.visible = true;
  c.menu.categories[0].items = [{ name: 'لاتيه', note: 'بارد', price: '4,000 د.ع' }];
  html = renderPage(c);
  assert.match(html, /لاتيه/);
  assert.match(html, /4,000 د\.ع/);
});

test('التتبع يرفض الروبوتات والمدخلات المشوهة ولا يحفظ IP', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccafe-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = new Analytics({ dir, secret: 'x' });
  const who = { ip: '203.0.113.9', ua: BROWSER };
  assert.equal(await a.record({ e: 'pageview', s: 'abcdef1234' }, { ip: '1.1.1.1', ua: 'Googlebot/2.1' }), false);
  assert.equal(await a.record({ e: 'pageview', s: 'abcdef1234' }, { ip: '1.1.1.1', ua: '' }), false);
  assert.equal(await a.record({ e: 'hack', s: 'abcdef1234' }, who), false);
  assert.equal(await a.record({ e: 'pageview', s: '../../x' }, who), false);
  assert.equal(await a.record(null, who), false);
  assert.equal(await a.record({ e: 'section', s: 'abcdef1234', n: '<img src=x>' }, who), false);

  const now = Date.UTC(2026, 10, 5, 12);
  assert.equal(await a.record({ e: 'pageview', s: 'abcdef1234', r: 'l.instagram.com' }, who, now), true);
  assert.equal(await a.record({ e: 'click', s: 'abcdef1234', k: 'call', n: 'اتصل' }, who, now + 1000), true);
  assert.equal(await a.record({ e: 'mood', s: 'abcdef1234', n: 'قهوة' }, who, now + 2000), true);
  assert.equal(await a.record({ e: 'section', s: 'abcdef1234', n: 'menu' }, who, now + 3000), true);
  assert.equal(await a.record({ e: 'leave', s: 'abcdef1234', ms: 90000, sc: 70 }, who, now + 4000), true);

  const raw = await fs.readFile(path.join(dir, '2026-11-05.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /203\.0\.113\.9/);

  const stats = await a.stats('today', now + 5000);
  assert.equal(stats.totals.visitors, 1);
  assert.equal(stats.totals.sessions, 1);
  assert.equal(stats.totals.calls, 1);
  assert.equal(stats.totals.avgDurationMs, 90000);
  assert.equal(stats.totals.actionSessions, 1);
  assert.deepEqual(stats.sources, [{ key: 'instagram', value: 1 }]);
  assert.deepEqual(stats.devices, [{ key: 'mobile', value: 1 }]);
  assert.equal(stats.sections.menu, 1);
  assert.equal(stats.live, 1);
  assert.equal(stats.hours[15], 1, 'الساعة بتوقيت بغداد');
});

test('التتبع يحد من سيل الأحداث ويرفض الأجسام الكبيرة', async (t) => {
  const { port } = await startApp(t);
  const headers = { Host: 'ccafe.iq', 'User-Agent': BROWSER, 'X-Forwarded-For': '203.0.113.7' };
  const big = await request(port, 'POST', '/api/track', { headers, body: 'x'.repeat(5000) });
  assert.equal(big.status, 413);
  const cross = await request(port, 'POST', '/api/track', { headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccafe-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const a = new Analytics({ dir, secret: 'x' });
  let accepted = 0;
  for (let i = 0; i < 150; i += 1) {
    if (await a.record({ e: 'click', s: 'abcdef1234', k: 'call', n: 'x' }, { ip: '1.2.3.4', ua: BROWSER })) accepted += 1;
  }
  assert.equal(accepted, 120);
});

test('تصنيف المصادر والأجهزة', () => {
  assert.equal(classifySource('l.instagram.com', ''), 'instagram');
  assert.equal(classifySource('', 'ig'), 'instagram');
  assert.equal(classifySource('www.google.iq', ''), 'google');
  assert.equal(classifySource('', ''), 'direct');
  assert.equal(classifySource('example.org', ''), 'example.org');
  assert.equal(parseAgent(BROWSER).device, 'mobile');
  assert.equal(parseAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Instagram 300').browser, 'instagram');
  assert.equal(parseAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537 Edg/130').browser, 'edge');
});

test('تنظيف المحتوى يهمل المجهول ويكمل الناقص', () => {
  const c = normalize({ hero: { big: 'x', evil: 'y' }, junk: 1, layout: { order: ['visit', 'visit', 'bad'] } }, DEFAULTS);
  assert.equal(c.hero.big, 'x');
  assert.equal(c.hero.evil, undefined);
  assert.equal(c.junk, undefined);
  assert.equal(c.hero.lead, DEFAULTS.hero.lead);
  assert.deepEqual(c.layout.order, ['visit', 'moods', 'vibes', 'offer', 'menu']);
  assert.equal(normalize({ menu: { visible: false } }, DEFAULTS).menu.visible, false);
});
