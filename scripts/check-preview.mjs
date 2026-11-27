// Verify a running local preview of the built site.
//
// Usage:
//   PREVIEW_URL=http://127.0.0.1:8899 npm run check:preview
//   PREVIEW_URL=http://127.0.0.1:8898 EXPECT_SOURCE=fallback npm run check:preview
//   PREVIEW_URL=https://... EXPECT_PREVIEW=1 npm run check:preview
//
// It checks:
//   * an explicit 503 pause page is reported as site state, not as content;
//   * the page is served and marked live or fallback;
//   * the live version meta matches the response header;
//   * preview/fallback responses are noindex and production live is not;
//   * the served HTML is byte-identical to renderPage(normalize(...));
//   * all 15 public assets and the two public files are reachable;
//   * internal anchors resolve and the Google map iframe is present;
//   * no analytics script or /api/track reference is shipped.
//
// It is a local verification tool. It does not prove Netlify routing,
// Function bundling, CDN caching, or production behaviour.

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PUBLIC_FILES } from './public-files.mjs';

const require = createRequire(import.meta.url);
const { renderPage } = require('../lib/render');
const { normalize } = require('../lib/schema');
const DEFAULTS = require('../lib/default-content');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const base = (process.env.PREVIEW_URL || 'http://127.0.0.1:8899').replace(/\/+$/, '');
const expectSource = process.env.EXPECT_SOURCE || 'live';
const expectPreview = process.env.EXPECT_PREVIEW === '1';
const expectNoindex = expectPreview || expectSource === 'fallback';

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const pageResponse = await fetch(`${base}/`);
const html = await pageResponse.text();
const stateHeader = pageResponse.headers.get('x-ccafe-site-state');
const stateMetaMatch = html.match(/<meta name="ccafe-site-state" content="([^"]+)">/);
const siteState = (stateHeader || stateMetaMatch?.[1] || '').toLowerCase();
const source = pageResponse.headers.get('x-ccafe-source');
const headerVersion = pageResponse.headers.get('x-ccafe-version');
const reason = pageResponse.headers.get('x-ccafe-reason');

if (pageResponse.status === 503 && (siteState === 'stopped' || siteState === 'unknown')) {
  console.log(`SITE PAUSED: state=${siteState} source=${source || 'unavailable'} reason=${reason || 'site_stopped'}`);
  assert(!/<meta name="ccafe-content-version"/.test(html), 'pause page must not contain a content-version marker');
  assert(!/track\.js/.test(html), 'pause page must not reference track.js');
  console.log(JSON.stringify({
    total: 1,
    failed: 1,
    siteState,
    skipped: 'published-content checks are not valid while the site is paused',
  }));
  process.exit(1);
}

assert(pageResponse.status === 200, `page status ${pageResponse.status}`);
console.log(`source=${source}${headerVersion ? ` version=${headerVersion}` : ''}${reason ? ` reason=${reason}` : ''}`);

await check('page is served with the expected source', () => {
  assert(source === expectSource, `expected source ${expectSource}, got ${source}`);
});

await check('cache is disabled for the dynamic page', () => {
  const cache = pageResponse.headers.get('cache-control') || '';
  const cdn = pageResponse.headers.get('netlify-cdn-cache-control') || '';
  const age = pageResponse.headers.get('age') || '';
  const cacheStatus = pageResponse.headers.get('cache-status') || '';
  assert(/no-store/.test(cache), `unexpected Cache-Control: ${cache}`);
  // Netlify consumes Netlify-CDN-Cache-Control and may not forward it, so accept
  // either the explicit no-store value or its absence.
  assert(!cdn || /no-store/.test(cdn), `unexpected Netlify-CDN-Cache-Control: ${cdn}`);
  assert(!age || Number(age) <= 5, `response looks cached (Age: ${age})`);
  assert(!/hit/i.test(cacheStatus), `edge cache hit reported: ${cacheStatus}`);
});

await check('preview and fallback responses are noindex', () => {
  const robots = pageResponse.headers.get('x-robots-tag') || '';
  const meta = /<meta name="robots" content="noindex">/.test(html);
  if (expectNoindex) {
    assert(/noindex/.test(robots), 'missing X-Robots-Tag: noindex');
    assert(meta, 'missing robots noindex meta tag');
  } else {
    assert(!/noindex/.test(robots), 'production live response must not be noindex');
    assert(!meta, 'production live response must not ship a robots noindex meta tag');
  }
});

await check('content version marker is present and consistent', () => {
  const match = html.match(/<meta name="ccafe-content-version" content="([^"]+)">/);
  assert(match, 'missing ccafe-content-version meta');
  if (expectSource === 'live') {
    assert(headerVersion, 'missing X-CCafe-Version header');
    assert(match[1] === headerVersion, `meta ${match[1]} != header ${headerVersion}`);
  } else {
    assert(match[1] === 'fallback', `fallback meta should be "fallback", got ${match[1]}`);
    const robots = pageResponse.headers.get('x-robots-tag') || '';
    assert(/noindex/.test(robots), 'fallback response should be noindex');
  }
});

await check('no analytics is shipped or referenced', () => {
  assert(!/track\.js/.test(html), 'page references track.js');
  assert(!/api\/track/.test(html), 'page references /api/track');
});

let expectedContent;
if (expectSource === 'live') {
  expectedContent = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
} else {
  const snapshot = JSON.parse(
    await readFile(path.join(root, 'netlify', 'functions', 'content-fallback.json'), 'utf8'),
  );
  expectedContent = snapshot.content;
}

const expectedHtml = renderPage(normalize(expectedContent, DEFAULTS), {
  version: expectSource === 'live' ? headerVersion : 'fallback',
  tracking: false,
  preview: expectNoindex,
});

await check('served HTML matches the local template exactly', () => {
  assert(html === expectedHtml, `HTML differs (${html.length} vs ${expectedHtml.length} bytes)`);
});

const referenced = new Set();
for (const match of html.matchAll(/(?:href|src)="(assets\/[^"]+)"/g)) referenced.add(match[1]);

await check('all public files are reachable', async () => {
  for (const rel of PUBLIC_FILES) {
    const response = await fetch(`${base}/${rel}`);
    assert(response.status === 200, `${rel}: status ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const local = await readFile(path.join(root, 'dist', rel));
    assert(body.equals(local), `${rel}: bytes differ from dist/`);
  }
});

await check('every asset referenced by the page exists', () => {
  for (const rel of referenced) {
    assert(PUBLIC_FILES.includes(rel), `referenced asset ${rel} is not in the allow-list`);
  }
});

await check('internal anchors resolve', () => {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  for (const match of html.matchAll(/href="#([^"]+)"/g)) {
    assert(ids.has(match[1]), `missing anchor target #${match[1]}`);
  }
});

await check('no unsafe or empty links', () => {
  for (const match of html.matchAll(/href="([^"]*)"/g)) {
    const href = match[1];
    assert(href.length > 0, 'empty href');
    assert(!/^javascript:/i.test(href), `unsafe href: ${href}`);
  }
});

await check('Google map iframe is present', () => {
  assert(/<iframe[^>]+google\.com\/maps/.test(html), 'missing Google map iframe');
});

console.log(JSON.stringify({ total: 11, failed: failures.length, source, version: headerVersion || 'fallback' }));
if (failures.length > 0) process.exit(1);
