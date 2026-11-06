'use strict';
// خادم الموقع ولوحة التحكم. بلا مكتبات خارجية: يكفي Node.js.
//
// لا توجد كلمة مرور للوحة التحكم. الوصول إليها مسموح في حالتين فقط:
//   1. الطلب قادم من الجهاز نفسه الذي يشغّل الخادم (localhost).
//   2. فتح الرابط السري مرة واحدة من جهاز آخر، فيُحفظ إذن الوصول على ذلك الجهاز.
// أي طلب آخر إلى /admin يحصل على 404 كأن اللوحة غير موجودة.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');

const { SCHEMA, LINK_TOKENS, LINK_ANCHORS, normalize } = require('./lib/schema');
const DEFAULTS = require('./lib/default-content');
const { renderPage } = require('./lib/render');
const { ICONS } = require('./lib/icons');
const { Analytics } = require('./lib/analytics');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};
const PUBLIC_FILES = new Set(['styles.css', 'script.js', 'track.js']);
const ADMIN_FILES = new Set(['index.html', 'admin.css', 'app.js', 'dom.js', 'forms.js', 'stats.js']);
const MEDIA_FOLDERS = ['assets/uploads', 'assets/uploads/icons', 'assets/photos', 'assets/brand'];
const DELETABLE_FOLDERS = ['assets/uploads', 'assets/uploads/icons', 'assets/photos'];
const HISTORY_LIMIT = 50;
const MAX_UPLOAD = 15 * 1024 * 1024;
const MAX_JSON = 2 * 1024 * 1024;
const ADMIN_COOKIE = 'ccafe_admin';
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// كتابة آمنة: ملف مؤقت ثم إعادة تسمية، مع إعادة المحاولة لأن OneDrive قد يقفل الملف لحظيًا
async function writeAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await sleep(60 * (attempt + 1));
    }
  }
  await fsp.writeFile(file, data);
  await fsp.rm(tmp, { force: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, 'حجم البيانات أكبر من المسموح'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'بيانات غير صالحة');
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('404');
}

async function sendFile(req, res, file, headers = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return notFound(res);
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const base = { ETag: etag, 'Cache-Control': 'no-cache', ...headers };
  if (type === 'image/svg+xml') base['Content-Security-Policy'] = 'sandbox';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base);
    return res.end();
  }
  res.writeHead(200, { ...base, 'Content-Type': type, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  return undefined;
}

function sendHtml(res, html, headers = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(html);
}

// يتعرف على نوع الصورة من محتواها الفعلي وليس من اسمها
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return '.ico';
  const head = buf.subarray(0, 2000).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    const text = buf.toString('utf8');
    if (/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(text)) return null;
    return '.svg';
  }
  return null;
}

function createApp(options = {}) {
  const root = options.root || __dirname;
  const dataDir = options.dataDir || path.join(root, 'data');
  const indexOut = options.indexOut || path.join(root, 'index.html');
  const paths = {
    content: path.join(dataDir, 'content.json'),
    draft: path.join(dataDir, 'draft.json'),
    config: path.join(dataDir, 'config.json'),
    history: path.join(dataDir, 'history'),
    events: path.join(dataDir, 'events'),
    trash: path.join(dataDir, 'trash'),
  };

  let config = null;
  let published = null;
  let draft = null;
  let analytics = null;

  const clean = (value) => normalize(value, DEFAULTS);

  async function archive(content, note) {
    const at = Date.now();
    const id = `${at}.json`;
    await writeAtomic(path.join(paths.history, id), JSON.stringify({ at, note, content }));
    const names = (await fsp.readdir(paths.history)).filter((n) => /^\d+\.json$/.test(n)).sort();
    const excess = names.slice(0, Math.max(0, names.length - HISTORY_LIMIT));
    await Promise.all(excess.map((n) => fsp.rm(path.join(paths.history, n), { force: true })));
  }

  async function listHistory() {
    let names = [];
    try {
      names = await fsp.readdir(paths.history);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names.filter((n) => /^\d+\.json$/.test(n)).sort().reverse().map(async (name) => {
        const item = await readJson(path.join(paths.history, name), null);
        return item ? { id: name, at: item.at, note: item.note } : null;
      }),
    );
    return entries.filter(Boolean);
  }

  async function writeIndex(html) {
    let current = null;
    try {
      current = await fsp.readFile(indexOut, 'utf8');
    } catch { /* أول تشغيل */ }
    if (current !== html) await writeAtomic(indexOut, html);
  }

  async function publish(input, note) {
    const content = clean(input);
    const html = renderPage(content);
    await writeAtomic(paths.content, JSON.stringify(content, null, 2));
    await writeIndex(html);
    await archive(content, note);
    published = content;
    draft = null;
    await fsp.rm(paths.draft, { force: true });
    return content;
  }

  async function init() {
    await fsp.mkdir(dataDir, { recursive: true });
    config = await readJson(paths.config, null);
    if (!config || !config.secret || !config.adminKey) {
      config = {
        secret: crypto.randomBytes(32).toString('hex'),
        adminKey: crypto.randomBytes(24).toString('hex'),
      };
      await writeAtomic(paths.config, JSON.stringify(config, null, 2));
    }
    analytics = new Analytics({ dir: paths.events, secret: config.secret });

    const stored = await readJson(paths.content, null);
    if (stored) {
      published = clean(stored);
      await writeIndex(renderPage(published));
      if ((await listHistory()).length === 0) await archive(published, 'النسخة الحالية');
    } else {
      await publish(DEFAULTS, 'النسخة الأصلية من الموقع');
    }
    const savedDraft = await readJson(paths.draft, null);
    draft = savedDraft ? clean(savedDraft) : null;
  }

  // ---- الوصول إلى لوحة التحكم -------------------------------------------------

  function isLocalRequest(req) {
    const addr = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return false;
    // خلف وكيل عكسي تأتي كل الطلبات من الجهاز نفسه، فلا تكفي هذه الفحوص إلا مع غياب ترويسات الوكيل
    if (req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip']) return false;
    // فحص Host يمنع هجمات DNS rebinding
    const host = String(req.headers.host || '').toLowerCase();
    const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
    return name === 'localhost' || name === '127.0.0.1' || name === '[::1]';
  }

  function hasAdminCookie(req) {
    const cookies = String(req.headers.cookie || '').split(';').map((c) => c.trim());
    const match = cookies.find((c) => c.startsWith(`${ADMIN_COOKIE}=`));
    return match ? safeEqual(match.slice(ADMIN_COOKIE.length + 1), config.adminKey) : false;
  }

  function adminCookie(req) {
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    return `${ADMIN_COOKIE}=${config.adminKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
  }

  // يمنع أي موقع آخر من تنفيذ تغييرات عبر متصفح صاحب اللوحة
  function assertSameOrigin(req) {
    if (req.headers['x-ccafe-admin'] !== '1') throw new HttpError(403, 'طلب مرفوض');
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') throw new HttpError(403, 'طلب مرفوض');
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch { /* يبقى فارغًا فيُرفض */ }
      if (originHost !== req.headers.host) throw new HttpError(403, 'طلب مرفوض');
    }
  }

  // ---- الوسائط ---------------------------------------------------------------

  async function listMedia() {
    const usedIn = `${JSON.stringify(published)}${JSON.stringify(draft || {})}`;
    const items = [];
    for (const folder of MEDIA_FOLDERS) {
      let names = [];
      try {
        names = await fsp.readdir(path.join(root, folder), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of names) {
        if (!entry.isFile() || !MIME[path.extname(entry.name).toLowerCase()]) continue;
        const rel = `${folder}/${entry.name}`;
        const stat = await fsp.stat(path.join(root, rel));
        items.push({
          path: rel,
          name: entry.name,
          folder,
          size: stat.size,
          modified: stat.mtimeMs,
          used: usedIn.includes(`"${rel}"`),
          deletable: DELETABLE_FOLDERS.includes(folder),
        });
      }
    }
    return items.sort((a, b) => b.modified - a.modified);
  }

  async function saveUpload(req, url) {
    const body = await readBody(req, MAX_UPLOAD);
    const ext = sniffImage(body);
    if (!ext) throw new HttpError(415, 'نوع الملف غير مدعوم. استخدم JPG أو PNG أو WebP أو GIF أو SVG.');
    const folder = url.searchParams.get('kind') === 'icon' ? 'assets/uploads/icons' : 'assets/uploads';
    const rawName = path.parse(String(url.searchParams.get('name') || 'image')).name;
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
    const rel = `${folder}/${slug}-${hash}${ext}`;
    await fsp.mkdir(path.join(root, folder), { recursive: true });
    await fsp.writeFile(path.join(root, rel), body);
    return { path: rel };
  }

  async function deleteMedia(rel) {
    const folder = path.posix.dirname(rel);
    if (!DELETABLE_FOLDERS.includes(folder) || !/^assets\/[A-Za-z0-9_\-./]+$/.test(rel) || rel.includes('..')) {
      throw new HttpError(403, 'لا يمكن حذف هذا الملف');
    }
    const usedIn = `${JSON.stringify(published)}${JSON.stringify(draft || {})}`;
    if (usedIn.includes(`"${rel}"`)) throw new HttpError(409, 'هذه الصورة مستخدمة في الموقع. غيّرها أولًا ثم احذفها.');
    await fsp.mkdir(paths.trash, { recursive: true });
    // تُنقل إلى سلة داخلية بدل الحذف النهائي، حتى تبقى النسخ القديمة قابلة للاستعادة
    await fsp.rename(path.join(root, rel), path.join(paths.trash, `${Date.now()}-${path.posix.basename(rel)}`));
  }

  // ---- واجهة لوحة التحكم ------------------------------------------------------

  async function bootstrap(req) {
    const site = /^https?:\/\//i.test(published.seo.siteUrl) ? published.seo.siteUrl.replace(/\/+$/, '') : '';
    return {
      schema: SCHEMA,
      linkTokens: LINK_TOKENS,
      linkAnchors: LINK_ANCHORS,
      icons: ICONS,
      content: draft || published,
      published,
      access: {
        local: isLocalRequest(req),
        remotePath: `/admin/?key=${config.adminKey}`,
        site,
      },
    };
  }

  async function handleAdminApi(req, res, url, route) {
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') assertSameOrigin(req);

    if (route === 'bootstrap' && method === 'GET') return sendJson(res, 200, await bootstrap(req));

    if (route === 'draft' && method === 'PUT') {
      const body = await readJsonBody(req);
      draft = clean(body.content);
      renderPage(draft);
      await writeAtomic(paths.draft, JSON.stringify(draft));
      return sendJson(res, 200, { ok: true });
    }
    if (route === 'draft' && method === 'DELETE') {
      draft = null;
      await fsp.rm(paths.draft, { force: true });
      return sendJson(res, 200, { content: published });
    }

    if (route === 'publish' && method === 'POST') {
      const body = await readJsonBody(req);
      const content = await publish(body.content, 'نشر من لوحة التحكم');
      return sendJson(res, 200, { published: content });
    }

    if (route === 'history' && method === 'GET') return sendJson(res, 200, { items: await listHistory() });
    if (route === 'history/restore' && method === 'POST') {
      const body = await readJsonBody(req);
      if (!/^\d+\.json$/.test(String(body.id))) throw new HttpError(400, 'نسخة غير صالحة');
      const item = await readJson(path.join(paths.history, body.id), null);
      if (!item) throw new HttpError(404, 'النسخة غير موجودة');
      const content = await publish(item.content, 'استعادة نسخة سابقة');
      return sendJson(res, 200, { published: content });
    }

    if (route === 'media' && method === 'GET') return sendJson(res, 200, { items: await listMedia() });
    if (route === 'media' && method === 'POST') return sendJson(res, 200, await saveUpload(req, url));
    if (route === 'media' && method === 'DELETE') {
      await deleteMedia(String(url.searchParams.get('path') || ''));
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'stats' && method === 'GET') return sendJson(res, 200, await analytics.stats(url.searchParams.get('range')));
    if (route === 'stats' && method === 'DELETE') {
      await analytics.clear();
      return sendJson(res, 200, { ok: true });
    }

    if (route === 'access/rotate' && method === 'POST') {
      config.adminKey = crypto.randomBytes(24).toString('hex');
      await writeAtomic(paths.config, JSON.stringify(config, null, 2));
      // من يغيّر الرابط من جهاز بعيد يبقى داخل اللوحة، وتُلغى صلاحية بقية الأجهزة
      if (!isLocalRequest(req)) res.setHeader('Set-Cookie', adminCookie(req));
      return sendJson(res, 200, { remotePath: `/admin/?key=${config.adminKey}` });
    }

    throw new HttpError(404, 'غير موجود');
  }

  async function handleAdmin(req, res, url) {
    const pathname = url.pathname;
    const local = isLocalRequest(req);
    const key = url.searchParams.get('key');

    if (!local && key && (pathname === '/admin' || pathname === '/admin/') && safeEqual(key, config.adminKey)) {
      res.writeHead(302, { 'Set-Cookie': adminCookie(req), Location: '/admin/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      return res.end();
    }
    if (!local && !hasAdminCookie(req)) return notFound(res);

    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');

    if (pathname === '/admin') {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }
    if (pathname === '/admin-preview') {
      return sendHtml(res, renderPage(draft || published, { preview: true }));
    }
    if (pathname.startsWith('/admin/api/')) {
      return handleAdminApi(req, res, url, pathname.slice('/admin/api/'.length));
    }
    const name = pathname === '/admin/' ? 'index.html' : pathname.slice('/admin/'.length);
    if (!ADMIN_FILES.has(name)) return notFound(res);
    const headers = name === 'index.html' ? { 'Content-Security-Policy': ADMIN_CSP } : {};
    return sendFile(req, res, path.join(root, 'admin', name), headers);
  }

  // ---- الموقع العام -----------------------------------------------------------

  async function handleTrack(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch { /* يبقى فارغًا */ }
      if (originHost !== req.headers.host) {
        res.writeHead(403);
        return res.end();
      }
    }
    const body = await readBody(req, 2048);
    let event = null;
    try {
      event = JSON.parse(body.toString('utf8'));
    } catch { /* يُتجاهل */ }
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    await analytics.record(event, { ip: forwarded || req.socket.remoteAddress || '', ua: req.headers['user-agent'] });
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    if (!res.hasHeader('Referrer-Policy')) res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    try {
      let url;
      try {
        url = new URL(req.url, 'http://local');
      } catch {
        res.writeHead(400);
        return res.end();
      }
      const pathname = url.pathname;

      if (pathname === '/admin' || pathname.startsWith('/admin/') || pathname === '/admin-preview') {
        return await handleAdmin(req, res, url);
      }
      if (pathname === '/api/track') return await handleTrack(req, res);

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      if (pathname === '/' || pathname === '/index.html') return await sendFile(req, res, indexOut);
      const name = pathname.slice(1);
      if (PUBLIC_FILES.has(name)) return await sendFile(req, res, path.join(root, name));
      if (pathname.startsWith('/assets/')) {
        let decoded;
        try {
          decoded = decodeURIComponent(pathname);
        } catch {
          return notFound(res);
        }
        // قائمة بيضاء صارمة للمحارف تمنع الخروج من مجلد الصور على أي نظام
        if (!/^\/assets\/[A-Za-z0-9_\-./]+$/.test(decoded) || decoded.includes('..') || decoded.includes('/.')) return notFound(res);
        return await sendFile(req, res, path.join(root, decoded.slice(1)));
      }
      return notFound(res);
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      if (res.headersSent) return res.destroy();
      return sendJson(res, 500, { error: 'حدث خطأ غير متوقع في الخادم' });
    }
  }

  return { init, handler, get adminKey() { return config.adminKey; } };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--open') args.open = true;
    else if (argv[i] === '--data-dir') args.dataDir = argv[(i += 1)];
    else if (argv[i] === '--index-out') args.indexOut = argv[(i += 1)];
    else if (argv[i] === '--port') args.port = Number(argv[(i += 1)]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port || Number(process.env.PORT) || 3000;
  // منصات الاستضافة تحدد PORT، وعندها يجب الاستماع لكل العناوين. أما على جهازك فالخادم لا يُرى من الشبكة.
  const host = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const app = createApp({ dataDir: args.dataDir, indexOut: args.indexOut });
  await app.init();
  const server = http.createServer(app.handler);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`المنفذ ${port} مستخدم. قد يكون الخادم يعمل بالفعل، أو شغّله بمنفذ آخر: node server.js --port 3001`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`الموقع:       http://localhost:${port}/`);
    console.log(`لوحة التحكم:  http://localhost:${port}/admin/`);
    if (args.open && process.platform === 'win32') exec(`start "" "http://localhost:${port}/admin/"`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createApp, sniffImage };
