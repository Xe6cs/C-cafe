// Create the static fallback snapshot used by the public site Function.
//
// Usage: npm run snapshot:content
//
// This is a deliberate, one-off snapshot of data/content.json at the moment the
// command runs. It is NOT refreshed by `npm run build`, and it is NOT
// necessarily the latest content published to Supabase. If the database is
// unreachable, the Function renders this snapshot and marks the response as a
// fallback instead of pretending it is live.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const source = path.join(root, 'data', 'content.json');
const target = path.join(root, 'netlify', 'functions', 'content-fallback.json');

const content = JSON.parse(await readFile(source, 'utf8'));
const snapshot = {
  snapshot_at: new Date().toISOString(),
  source: 'data/content.json',
  note: 'Static fallback snapshot for the public site Function. It is not necessarily the latest published content.',
  content,
};

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
console.log(`Wrote fallback snapshot to ${path.relative(root, target)}`);
