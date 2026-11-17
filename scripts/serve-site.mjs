// Local preview server for the built public site.
//
// It is a small Netlify emulator for verification only: it serves dist/ assets
// and sends /, /index.html, and /api/* to the same Function handler that
// netlify/functions/site.js exports. It is NOT proof of Netlify's production
// routing, caching, or bundling behaviour.
//
// Usage (after npm run build):
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run preview:site

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('../netlify/functions/site.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT || 8899);
const host = '127.0.0.1';

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(pathname, res, method) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(1));
  } catch {
    return false;
  }
  if (!rel || rel.includes('..') || rel.startsWith('.')) return false;
  const file = path.join(dist, rel);
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const data = await readFile(file);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(method === 'HEAD' ? undefined : data);
  return true;
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://${req.headers.host || host}`);
  const pathname = url.pathname;

  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/api/')) {
    const result = await handler({ path: pathname, httpMethod: method, headers: req.headers });
    res.writeHead(result.statusCode || 200, result.headers || {});
    res.end(method === 'HEAD' ? undefined : result.body);
    return;
  }

  if (await serveStatic(pathname, res, method)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Not Found');
});

server.listen(port, host, () => {
  console.log(`Local preview: http://${host}:${port}/`);
  console.log(`Serving static files from ${path.relative(root, dist)}`);
});
