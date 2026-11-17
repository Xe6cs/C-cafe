// Copy the pinned official Supabase UMD build into the admin Function asset
// directory. The file is generated and git-ignored; `npm run build` recreates it
// before Netlify packages the admin-ui Function.
//
// Why UMD: the admin page needs only createClient + Auth, so shipping the
// official build avoids a separate bundler and keeps the version pinned by
// package.json/package-lock.json.

import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const source = path.join(root, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
const destDir = path.join(root, 'netlify', 'admin', 'vendor');
const dest = path.join(destDir, 'supabase.js');

await mkdir(destDir, { recursive: true });
await copyFile(source, dest);
const info = await stat(dest);

if (info.size < 100000) {
  throw new Error(`Unexpected Supabase UMD size: ${info.size} bytes`);
}

console.log(`Copied Supabase UMD (${info.size} bytes) to netlify/admin/vendor/supabase.js`);
