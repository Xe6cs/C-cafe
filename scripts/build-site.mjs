// Build the public site into dist/ from an explicit allow-list.
//
// Usage: npm run build
//
// It copies only files named in scripts/public-files.mjs. It never copies
// data/, admin/, supabase/, tests, env files, backups, server.js, or index.html.
// The page HTML is produced at request time by netlify/functions/site.js.

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from './public-files.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');

const FORBIDDEN_NAMES = new Set([
  'index.html',
  'server.js',
  'package.json',
  'package-lock.json',
  'netlify.toml',
  'seed.sql',
]);

function collectAssetRefs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectAssetRefs(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectAssetRefs(item, out);
    return out;
  }
  if (typeof value === 'string' && value.startsWith('assets/')) out.add(value);
  return out;
}

async function listFiles(dir, prefix = '') {
  const entries = await readdir(path.join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(dir, rel)));
    else files.push(rel);
  }
  return files.sort();
}

const content = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
const referenced = collectAssetRefs(content, new Set());
const allowed = new Set(PUBLIC_FILES);
const missing = [...referenced].filter((asset) => !allowed.has(asset)).sort();
if (missing.length > 0) {
  throw new Error(
    `data/content.json references assets missing from scripts/public-files.mjs:\n  ${missing.join('\n  ')}`,
  );
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

let totalBytes = 0;
for (const rel of PUBLIC_FILES) {
  const source = path.join(root, rel);
  const target = path.join(dist, rel);
  const info = await stat(source).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`allow-listed file does not exist: ${rel}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
  totalBytes += info.size;
}

const built = await listFiles(dist);
const forbidden = built.filter((rel) => {
  const name = rel.split('/').pop();
  return (
    FORBIDDEN_NAMES.has(name) ||
    rel.startsWith('data/') ||
    rel.startsWith('admin/') ||
    rel.startsWith('supabase/') ||
    rel.startsWith('test/') ||
    rel.startsWith('netlify/') ||
    rel.startsWith('scripts/') ||
    rel.startsWith('docs/') ||
    rel.startsWith('assets/uploads/') ||
    rel.startsWith('.env') ||
    rel.includes('/.env')
  );
});
if (forbidden.length > 0) {
  throw new Error(`build produced forbidden files:\n  ${forbidden.join('\n  ')}`);
}

if (built.length !== PUBLIC_FILES.length) {
  throw new Error(`expected ${PUBLIC_FILES.length} files, found ${built.length}`);
}

console.log(`Built ${built.length} public files into dist/ (${totalBytes} bytes).`);
for (const rel of built) console.log(`  ${rel}`);
console.log('Excluded: index.html (served by Function), data/, admin/, supabase/, tests, env files.');
