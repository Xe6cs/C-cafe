// Real-session PostgreSQL checks for the C Cafe content model.
//
// Run with: npm run test:db:real
//
// This file talks to a real, isolated PostgreSQL server over TCP. It uses two
// independent client connections for every concurrency scenario and observes
// pg_locks / pg_blocking_pids to order them; it does not rely on arbitrary
// sleeps to decide who wins.
//
// It is NOT the Supabase local stack. It does not start PostgREST, GoTrue, or
// Docker. It exercises the same SQL, roles, RLS, grants, views, and JWT-claims
// simulation that PostgREST uses behind the scenes. A full Supabase local run
// still requires Docker + WSL2 (see supabase/README.md).
//
// Safety:
//   * It only connects to loopback and refuses port 5432 unless explicitly allowed.
//   * It creates uniquely named throwaway databases and drops only those.
//   * It never touches the existing PostgreSQL service or the user's Supabase project.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client, types } = pg;
types.setTypeParser(20, (value) => Number(value)); // int8 -> number

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const MIGRATIONS = [
  'supabase/migrations/20261106120000_content_core.sql',
  'supabase/migrations/20261106121000_content_api.sql',
  'supabase/migrations/20261108020000_conflict_sqlstate.sql',
  'supabase/migrations/20261109090000_media_library.sql',
  'supabase/migrations/20261110090000_media_finalize_claim.sql',
  'supabase/migrations/20261111090000_media_public_assets.sql',
  'supabase/migrations/20261112090000_media_trash.sql',
  'supabase/migrations/20261113090000_media_public_ready_delete.sql',
  'supabase/migrations/20261113100000_media_public_admin_read.sql',
  'supabase/migrations/20261114090000_analytics.sql',
  'supabase/migrations/20261115090000_analytics_digest_guard.sql',
  'supabase/migrations/20261116090000_analytics_day_cap.sql',
  'supabase/migrations/20261126120000_site_status.sql',
  'supabase/migrations/20261127120000_content_history_clear.sql',
  'supabase/migrations/20261128120000_media_permanent_delete_and_history_row_delete.sql',
];

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const HOST = process.env.CCAFE_PG_HOST || '127.0.0.1';
const PORT = Number(process.env.CCAFE_PG_PORT || 55432);
const PGUSER = process.env.CCAFE_PG_USER || 'ccafe_admin';
const MAINTENANCE_DB = process.env.CCAFE_PG_MAINTENANCE_DB || 'postgres';

if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  throw new Error('refusing to connect outside loopback');
}
if (PORT === 5432 && process.env.CCAFE_PG_ALLOW_EXISTING !== '1') {
  throw new Error(
    'refusing to use port 5432 (the existing PostgreSQL service); use the isolated test cluster on 55432',
  );
}

const migrationSql = await Promise.all(
  MIGRATIONS.map((file) => readFile(path.join(root, file), 'utf8')),
);
const seedSql = await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8');
const defaultContent = JSON.parse(
  await readFile(path.join(root, 'data', 'content.json'), 'utf8'),
);

const BOOTSTRAP_SQL = `
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid
    language sql
    stable
  as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
    )
  $$;
  revoke all on function auth.uid() from public;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users (id, email) values
    ('${ADMIN_ID}', 'admin@local.test'),
    ('${USER_ID}', 'user@local.test');

  create schema storage;
  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets (id),
    name text not null,
    owner uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_accessed_at timestamptz,
    metadata jsonb,
    unique (bucket_id, name)
  );
  alter table storage.objects enable row level security;
  grant usage on schema storage to anon, authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant select on storage.buckets to anon, authenticated;
`;

const SAVE_SQL = 'select public.admin_save_draft($1::bigint, $2::uuid, $3::jsonb) as result';
const DELETE_SQL = 'select public.admin_delete_draft($1::bigint, $2::uuid) as result';
const PUBLISH_SQL =
  'select public.admin_publish($1::bigint, $2::uuid, $3::jsonb, $4::text, $5::uuid) as result';
const RESTORE_SQL =
  'select public.admin_restore($1::bigint, $2::bigint, $3::text, $4::uuid) as result';
const CLEAR_HISTORY_SQL =
  'select public.admin_clear_content_history($1::uuid, $2::text) as result';
const DELETE_HISTORY_SQL =
  'select public.admin_delete_content_history_entry($1::bigint, $2::uuid, $3::text) as result';
const BEGIN_CHECK_SQL = 'select public.admin_begin_public_check($1::bigint) as result';
const FINISH_CHECK_SQL =
  'select public.admin_finish_public_check($1::bigint, $2::text, $3::bigint, $4::text) as result';
const SITE_STATUS_SQL = 'select public.admin_site_status() as result';
const SET_SITE_STATUS_SQL =
  'select public.admin_set_site_status($1::text, $2::text, $3::bigint, $4::uuid) as result';
const INGEST_SQL = 'select public.analytics_ingest($1::text, $2::text, $3::jsonb, $4::text) as result';

// The migration ships the production digest; the harness replaces it with a
// local-only value so these tests never depend on the deployed secret. Only the
// digest is stored, and it is not a credential by itself.
const ANALYTICS_TOKEN = 'local-test-analytics-token-0123456789abcdef';
// The Function sends D1; the database stores D2 = SHA-256('ingest|' || D1).
const ANALYTICS_DIGEST = createHash('sha256').update(`ingest|${ANALYTICS_TOKEN}`).digest('hex');
const ANALYTICS_STORED = createHash('sha256').update(`ingest|${ANALYTICS_DIGEST}`).digest('hex');

function contentWith(label) {
  const copy = structuredClone(defaultContent);
  copy.hero.big = label;
  return copy;
}

function contentWithout(key) {
  const copy = structuredClone(defaultContent);
  delete copy[key];
  return copy;
}

async function connect(database) {
  const client = new Client({ host: HOST, port: PORT, user: PGUSER, database });
  await client.connect();
  return client;
}

async function call(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0].result;
}

async function session(dbName, role, userId) {
  const client = await connect(dbName);
  const claims = userId ? JSON.stringify({ sub: userId, role }) : '{}';
  await client.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
  await client.query(`set role ${role}`);
  return client;
}

async function count(client, table) {
  return (await client.query(`select count(*)::int as n from public.${table}`)).rows[0].n;
}

async function state(client) {
  return (
    await client.query(
      'select version, content, saved_at, purge_state, public_check_id, public_check_state, public_check_observed_version from public.site_content where id = 1',
    )
  ).rows[0];
}

async function draftRow(client) {
  return (
    await client.query(
      'select revision_id, content, base_version from public.draft where id = 1',
    )
  ).rows[0] || null;
}

async function historyRows(client) {
  return (await client.query(
    'select id, version, content, note from public.content_history order by version desc, id desc',
  )).rows;
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    // This sleep only avoids a busy loop while waiting for an observable lock
    // state. It never decides ordering; pg_locks / pg_blocking_pids does that.
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForAdvisoryLock(observer, pid) {
  await waitFor(async () => {
    const row = await observer.query(
      "select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = $1 and granted",
      [pid],
    );
    return row.rows[0].n > 0;
  }, `advisory lock held by pid ${pid}`);
}

async function waitForBlocked(observer, pid, blockerPid) {
  await waitFor(async () => {
    const row = await observer.query('select pg_blocking_pids($1) as blockers', [pid]);
    return row.rows[0].blockers.includes(blockerPid);
  }, `pid ${pid} blocked by pid ${blockerPid}`);
}

let maintenance = null;
let unavailable = null;
try {
  maintenance = await connect(MAINTENANCE_DB);
  await maintenance.query('select 1');
  await maintenance.query(`
    do $$
    begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'create role anon nologin';
      end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'create role authenticated nologin';
      end if;
    end
    $$;
  `);
} catch (error) {
  unavailable = error;
}

after(async () => {
  if (maintenance) await maintenance.end();
});

if (unavailable) {
  test(
    'اختبارات PostgreSQL الحقيقية تحتاج خادمًا محليًا معزولًا',
    { skip: `${HOST}:${PORT} — ${unavailable.message}` },
    () => {},
  );
} else {
  let counter = 0;

  async function dropDatabase(name) {
    try {
      await maintenance.query(`drop database if exists ${name} with (force)`);
    } catch {
      // Best effort cleanup; a leaked throwaway DB never contains user data.
    }
  }

  async function createTestDb(t) {
    const name = `ccafe_verify_${process.pid}_${Date.now().toString(36)}_${counter++}`;
    await maintenance.query(`create database ${name}`);
    const db = await connect(name);
    try {
      await db.query(BOOTSTRAP_SQL);
      for (const sql of migrationSql) await db.query(sql);
      await db.query(seedSql);
      await db.query(
        `insert into public.admin_users (user_id, role) values ('${ADMIN_ID}', 'admin')`,
      );
      await db.query(
        `update public.analytics_secrets
         set value_sha256 = '${ANALYTICS_STORED}', updated_at = clock_timestamp()
         where name = 'ingest'`,
      );
    } catch (error) {
      await db.end();
      await dropDatabase(name);
      throw error;
    }
    t.after(async () => {
      try {
        await db.end();
      } finally {
        await dropDatabase(name);
      }
    });
    return { name, db };
  }

  test('تطبيق المخطط والبذرة من الصفر ومطابقة data/content.json', async (t) => {
    const ctx = await createTestDb(t);

    const server = await ctx.db.query('show server_version');
    assert.match(server.rows[0].server_version, /^16\./);

    const site = await ctx.db.query('select version, content from public.site_content where id = 1');
    assert.equal(site.rows[0].version, 1);
    assert.deepEqual(site.rows[0].content, defaultContent);

    const publicRow = await ctx.db.query('select version, content from public.published_content');
    assert.equal(publicRow.rows.length, 1);
    assert.equal(publicRow.rows[0].version, 1);
    assert.deepEqual(publicRow.rows[0].content, defaultContent);

    const history = await ctx.db.query(
      'select count(*)::int as n, min(version)::int as lo, max(version)::int as hi from public.content_history',
    );
    assert.deepEqual(history.rows[0], { n: 1, lo: 1, hi: 1 });

    const columns = await ctx.db.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'published_content'
      order by ordinal_position
    `);
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['version', 'content', 'saved_at'],
    );

    const view = await ctx.db.query(
      "select relkind from pg_class where oid = 'public.published_content'::regclass",
    );
    assert.equal(view.rows[0].relkind, 'v', 'published_content must stay a view, not a table');

    const statusColumns = await ctx.db.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'public_site_status'
      order by ordinal_position
    `);
    assert.deepEqual(
      statusColumns.rows.map((row) => row.column_name),
      ['state', 'message'],
    );
    const statusView = await ctx.db.query(
      "select relkind from pg_class where oid = 'public.public_site_status'::regclass",
    );
    assert.equal(statusView.rows[0].relkind, 'v', 'public_site_status must stay a view');

    const grants = await ctx.db.query(`
      select
        has_table_privilege('anon', 'public.published_content', 'select') as anon_view_select,
        has_table_privilege('anon', 'public.published_content', 'insert') as anon_view_insert,
        has_table_privilege('anon', 'public.published_content', 'update') as anon_view_update,
        has_table_privilege('anon', 'public.published_content', 'delete') as anon_view_delete,
        has_table_privilege('anon', 'public.site_content', 'select') as anon_base_select,
        has_table_privilege('anon', 'public.draft', 'select') as anon_draft_select,
        has_function_privilege('anon', 'public.admin_publish(bigint, uuid, jsonb, text, uuid)', 'execute') as anon_publish,
        has_function_privilege('authenticated', 'public.admin_publish(bigint, uuid, jsonb, text, uuid)', 'execute') as auth_publish,
        has_function_privilege('authenticated', 'public.is_admin()', 'execute') as auth_is_admin,
        has_function_privilege('authenticated', 'public.validate_content(jsonb)', 'execute') as auth_validate,
        has_function_privilege('authenticated', 'public.find_operation(uuid, uuid, text, jsonb)', 'execute') as auth_find,
        has_function_privilege('authenticated', 'public.assert_admin()', 'execute') as auth_assert_admin,
        has_table_privilege('anon', 'public.public_site_status', 'select') as anon_status_view_select,
        has_table_privilege('anon', 'public.public_site_status', 'insert') as anon_status_view_insert,
        has_table_privilege('anon', 'public.public_site_status', 'update') as anon_status_view_update,
        has_table_privilege('anon', 'public.public_site_status', 'delete') as anon_status_view_delete,
        has_table_privilege('anon', 'public.site_status', 'select') as anon_status_base_select,
        has_table_privilege('authenticated', 'public.site_status', 'select') as auth_status_base_select,
        has_table_privilege('anon', 'public.site_status_operations', 'select') as anon_status_ops_select,
        has_table_privilege('authenticated', 'public.site_status_operations', 'select') as auth_status_ops_select,
        has_function_privilege('anon', 'public.admin_site_status()', 'execute') as anon_status_read,
        has_function_privilege('authenticated', 'public.admin_site_status()', 'execute') as auth_status_read,
        has_function_privilege('anon', 'public.admin_set_site_status(text, text, bigint, uuid)', 'execute') as anon_status_write,
        has_function_privilege('authenticated', 'public.admin_set_site_status(text, text, bigint, uuid)', 'execute') as auth_status_write,
        has_function_privilege('authenticated', 'public.find_site_status_operation(uuid, uuid, text, jsonb)', 'execute') as auth_find_status_op
    `);
    const g = grants.rows[0];
    assert.equal(g.anon_view_select, true);
    assert.equal(g.anon_view_insert, false);
    assert.equal(g.anon_view_update, false);
    assert.equal(g.anon_view_delete, false);
    assert.equal(g.anon_base_select, false);
    assert.equal(g.anon_draft_select, false);
    assert.equal(g.anon_publish, false);
    assert.equal(g.auth_publish, true);
    assert.equal(g.auth_is_admin, true);
    assert.equal(g.auth_validate, false);
    assert.equal(g.auth_find, false);
    assert.equal(g.auth_assert_admin, false);
    assert.equal(g.anon_status_view_select, true);
    assert.equal(g.anon_status_view_insert, false);
    assert.equal(g.anon_status_view_update, false);
    assert.equal(g.anon_status_view_delete, false);
    assert.equal(g.anon_status_base_select, false);
    assert.equal(g.auth_status_base_select, true);
    assert.equal(g.anon_status_ops_select, false);
    assert.equal(g.auth_status_ops_select, true);
    assert.equal(g.anon_status_read, false);
    assert.equal(g.auth_status_read, true);
    assert.equal(g.anon_status_write, false);
    assert.equal(g.auth_status_write, true);
    assert.equal(g.auth_find_status_op, false);

    const definerFunctions = await ctx.db.query(`
      select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
    `);
    assert.ok(definerFunctions.rows.length >= 10, 'expected all SECURITY DEFINER helpers');
    for (const row of definerFunctions.rows) {
      assert.equal(row.prosecdef, true, row.signature);
      assert.ok(
        Array.isArray(row.proconfig) && row.proconfig.some((item) => item.startsWith('search_path=')),
        `${row.signature} must pin search_path`,
      );
    }
  });

  test('الصلاحيات عبر أدوار PostgreSQL: زائر وغير مدير ومدير', async (t) => {
    const ctx = await createTestDb(t);
    const anon = await session(ctx.name, 'anon', null);
    const user = await session(ctx.name, 'authenticated', USER_ID);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const publicRows = await anon.query('select * from public.published_content');
      assert.equal(publicRows.rows.length, 1);
      assert.deepEqual(Object.keys(publicRows.rows[0]).sort(), ['content', 'saved_at', 'version']);
      assert.deepEqual(publicRows.rows[0].content, defaultContent);

      const publicStatus = await anon.query('select * from public.public_site_status');
      assert.equal(publicStatus.rows.length, 1);
      assert.deepEqual(publicStatus.rows[0], { state: 'running', message: '' });
      await assert.rejects(anon.query(SITE_STATUS_SQL), /permission denied/);
      await assert.rejects(anon.query(SET_SITE_STATUS_SQL, ['stopped', '', 1, ADMIN_ID]), /permission denied/);

      for (const table of [
        'site_content', 'draft', 'content_history', 'admin_users',
        'content_operations', 'verification_checks', 'site_status',
        'site_status_operations',
      ]) {
        await assert.rejects(
          anon.query(`select * from public.${table}`),
          /permission denied/,
          `anon must not read ${table}`,
        );
      }
      await assert.rejects(
        anon.query('update public.published_content set version = 2'),
        /permission denied/,
      );
      await assert.rejects(
        anon.query('select public.admin_save_draft(1, null, $1::jsonb)', [
          JSON.stringify(defaultContent),
        ]),
        /permission denied/,
      );

      for (const table of [
        'site_content', 'draft', 'content_history',
        'content_operations', 'verification_checks', 'site_status',
        'site_status_operations',
      ]) {
        const rows = await user.query(`select * from public.${table}`);
        assert.equal(rows.rows.length, 0, `non-admin must see no ${table} rows`);
      }
      const ownAdminRows = await user.query('select * from public.admin_users');
      assert.equal(ownAdminRows.rows.length, 0);
      assert.equal((await user.query('select public.is_admin() as result')).rows[0].result, false);

      await assert.rejects(user.query(SITE_STATUS_SQL), /admin only/);
      await assert.rejects(
        user.query(SET_SITE_STATUS_SQL, ['stopped', '', 1, randomUUID()]),
        /admin only/,
      );

      await assert.rejects(
        user.query('select public.admin_save_draft(1, null, $1::jsonb)', [
          JSON.stringify(defaultContent),
        ]),
        /admin only/,
      );
      await assert.rejects(
        user.query("insert into public.admin_users (user_id, role) values ($1, 'admin')", [USER_ID]),
        /permission denied/,
      );
      await assert.rejects(
        user.query('update public.site_content set version = 99 where id = 1'),
        /permission denied/,
      );
      await assert.rejects(
        user.query("insert into public.draft (id, content, base_version) values (1, '{}'::jsonb, 1)"),
        /permission denied/,
      );
      await assert.rejects(
        user.query(`insert into public.content_operations (operation_id, actor_id, kind, request, result)
          values (gen_random_uuid(), $1, 'publish', '{}'::jsonb, '{}'::jsonb)`, [ADMIN_ID]),
        /permission denied/,
      );

      assert.equal((await admin.query('select public.is_admin() as result')).rows[0].result, true);
      const adminStatus = await call(admin, SITE_STATUS_SQL);
      assert.equal(adminStatus.state, 'running');
      assert.equal(adminStatus.revision, 1);
      assert.equal((await admin.query('select * from public.site_content')).rows.length, 1);
      assert.equal((await admin.query('select * from public.admin_users')).rows.length, 1);

      const saved = await call(admin, SAVE_SQL, [
        1, null, JSON.stringify(contentWith('admin-ok')),
      ]);
      assert.ok(saved.revision_id);

      await assert.rejects(
        admin.query('update public.site_content set version = 99 where id = 1'),
        /permission denied/,
      );
      await assert.rejects(
        admin.query(`insert into public.content_operations (operation_id, actor_id, kind, request, result)
          values (gen_random_uuid(), $1, 'publish', '{}'::jsonb, '{}'::jsonb)`, [ADMIN_ID]),
        /permission denied/,
      );
    } finally {
      await anon.end();
      await user.end();
      await admin.end();
    }
  });

  test('رفض المحتوى غير الصالح داخل RPC مباشرة دون كود Netlify', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);

    const cases = [
      [contentWithout('menu'), /missing a required top-level key/, 'missing key'],
      [(() => { const c = structuredClone(defaultContent); c.rogue = {}; return c; })(), /unknown top-level key/, 'unknown key'],
      [(() => { const c = structuredClone(defaultContent); c.header.nav[0].href = 'javascript:alert(1)'; return c; })(), /unsafe link/, 'unsafe href'],
      [(() => { const c = structuredClone(defaultContent); c.brand.logo = '../secret.png'; return c; })(), /image paths must reference an approved media asset|image paths must stay under assets/, 'bad image path'],
      [(() => { const c = structuredClone(defaultContent); c.hero.big = 'x'.repeat(4001); return c; })(), /content string is too long/, 'long string'],
      [(() => { const c = structuredClone(defaultContent); c.layout.order = ['moods', 'moods', 'offer', 'menu', 'visit']; return c; })(), /duplicate section/, 'duplicate section'],
      [(() => { const c = structuredClone(defaultContent); c.settings.tracking = 'yes'; return c; })(), /settings.tracking must be boolean/, 'bad toggle'],
      [(() => { const c = structuredClone(defaultContent); c.seo.siteUrl = 'javascript:alert(1)'; return c; })(), /URL fields must use http or https/, 'unsafe url'],
      [(() => { const c = structuredClone(defaultContent); c.contact.phoneIntl = 'not-a-phone'; return c; })(), /phoneIntl must contain only a phone number/, 'bad phone'],
      [[], /content must be a JSON object/, 'not an object'],
    ];

    try {
      for (const [bad, expected, label] of cases) {
        await assert.rejects(
          call(admin, SAVE_SQL, [1, null, JSON.stringify(bad)]),
          expected,
          label,
        );
      }

      assert.equal(await draftRow(ctx.db), null);
      assert.equal((await state(ctx.db)).version, 1);

      const ok = await call(admin, SAVE_SQL, [1, null, JSON.stringify(defaultContent)]);
      assert.ok(ok.revision_id);
    } finally {
      await admin.end();
    }
  });

  test('حفظان متزامنان من اتصالين بالمراجعة نفسها: واحد ينجح والآخر يتعارض', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await session(ctx.name, 'authenticated', ADMIN_ID);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const first = await call(setup, SAVE_SQL, [1, null, JSON.stringify(contentWith('R0'))]);

      await a.query('begin');
      const aResult = await call(a, SAVE_SQL, [
        1, first.revision_id, JSON.stringify(contentWith('A-wins')),
      ]);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const bPromise = call(b, SAVE_SQL, [
        1, first.revision_id, JSON.stringify(contentWith('B-loses')),
      ]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');

      let bError = null;
      try {
        await bPromise;
      } catch (error) {
        bError = error;
      }
      await b.query('rollback');

      assert.ok(bError, 'second editor must fail');
      assert.match(bError.message, /stale draft revision/);

      const draft = await draftRow(ctx.db);
      assert.equal(draft.revision_id, aResult.revision_id);
      assert.equal(draft.content.hero.big, 'A-wins');
      assert.equal((await state(ctx.db)).version, 1);
    } finally {
      await setup.end();
      await a.end();
      await b.end();
    }
  });

  test('حفظ مسودة أحدث أثناء نشر: النشر القديم لا يحذفها', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await session(ctx.name, 'authenticated', ADMIN_ID);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const draft0 = await call(setup, SAVE_SQL, [1, null, JSON.stringify(contentWith('draft-base'))]);

      await a.query('begin');
      const aSave = await call(a, SAVE_SQL, [
        1, draft0.revision_id, JSON.stringify(contentWith('newer-edit')),
      ]);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const bPublish = call(b, PUBLISH_SQL, [
        1, draft0.revision_id, null, 'stale publish', randomUUID(),
      ]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');

      let bError = null;
      try {
        await bPublish;
      } catch (error) {
        bError = error;
      }
      await b.query('rollback');

      assert.ok(bError, 'stale publish must fail');
      assert.match(bError.message, /stale draft revision/);

      const draft = await draftRow(ctx.db);
      assert.equal(draft.revision_id, aSave.revision_id);
      assert.equal(draft.content.hero.big, 'newer-edit');
      assert.equal((await state(ctx.db)).version, 1);
    } finally {
      await setup.end();
      await a.end();
      await b.end();
    }
  });

  test('استعادة متزامنة مع تعديل المسودة: لا حذف صامت للمسودة', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await session(ctx.name, 'authenticated', ADMIN_ID);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const draft0 = await call(setup, SAVE_SQL, [1, null, JSON.stringify(contentWith('draft-base'))]);
      const historyId = (await ctx.db.query(
        'select id from public.content_history where version = 1',
      )).rows[0].id;

      await a.query('begin');
      const restored = await call(a, RESTORE_SQL, [historyId, 1, 'restore', randomUUID()]);
      assert.equal(restored.version, 2);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const bSave = call(b, SAVE_SQL, [
        1, draft0.revision_id, JSON.stringify(contentWith('latest-edit')),
      ]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');

      let bError = null;
      try {
        await bSave;
      } catch (error) {
        bError = error;
      }
      await b.query('rollback');

      assert.ok(bError, 'save based on the old version must fail');
      assert.match(bError.message, /stale published version/);

      let draft = await draftRow(ctx.db);
      assert.equal(draft.revision_id, draft0.revision_id);
      assert.equal(draft.content.hero.big, 'draft-base');
      assert.equal((await state(ctx.db)).version, 2);

      const afterRestore = await call(setup, SAVE_SQL, [
        2, draft0.revision_id, JSON.stringify(contentWith('after-restore')),
      ]);
      assert.notEqual(afterRestore.revision_id, draft0.revision_id);
      draft = await draftRow(ctx.db);
      assert.equal(draft.content.hero.big, 'after-restore');
    } finally {
      await setup.end();
      await a.end();
      await b.end();
    }
  });

  test('نشران متزامنان بمعرّف العملية نفسه: إصدار واحد ونتيجة واحدة', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);
    const operationId = randomUUID();

    try {
      await a.query('begin');
      const aResult = await call(a, PUBLISH_SQL, [
        1, null, JSON.stringify(contentWith('same-op')), 'same note', operationId,
      ]);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const bPromise = call(b, PUBLISH_SQL, [
        1, null, JSON.stringify(contentWith('same-op')), 'same note', operationId,
      ]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      const bResult = await bPromise;
      await b.query('commit');

      assert.deepEqual(bResult, aResult);
      assert.equal((await state(ctx.db)).version, 2);
      assert.equal(await count(ctx.db, 'content_history'), 2);
      assert.equal(await count(ctx.db, 'content_operations'), 1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('إعادة استخدام معرّف العملية بمحتوى أو معاملات مختلفة تُرفض', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);
    const operationId = randomUUID();

    try {
      const first = await call(admin, PUBLISH_SQL, [
        1, null, JSON.stringify(contentWith('op-A')), 'note-1', operationId,
      ]);
      assert.equal(first.version, 2);

      await assert.rejects(
        call(admin, PUBLISH_SQL, [
          1, null, JSON.stringify(contentWith('op-B')), 'note-1', operationId,
        ]),
        /reused with different request parameters/,
      );
      await assert.rejects(
        call(admin, PUBLISH_SQL, [
          1, null, JSON.stringify(contentWith('op-A')), 'note-2', operationId,
        ]),
        /reused with different request parameters/,
      );
      await assert.rejects(
        call(admin, PUBLISH_SQL, [
          2, null, JSON.stringify(contentWith('op-A')), 'note-1', operationId,
        ]),
        /reused with different request parameters/,
      );

      const historyId = (await ctx.db.query(
        'select id from public.content_history where version = 1',
      )).rows[0].id;
      await assert.rejects(
        call(admin, RESTORE_SQL, [historyId, 2, 'note-1', operationId]),
        /operation id belongs to another operation/,
      );

      assert.equal((await state(ctx.db)).version, 2);
      assert.equal(await count(ctx.db, 'content_history'), 2);
    } finally {
      await admin.end();
    }
  });

  test('نتيجة فحص ظهور قديمة لا تستبدل تسجيلًا أحدث', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const check1 = await call(admin, BEGIN_CHECK_SQL, [1]);

      // Connection A finishes check1 and holds the content lock.
      await a.query('begin');
      assert.equal(await call(a, FINISH_CHECK_SQL, [check1, 'matched', 1, null]), true);
      await waitForAdvisoryLock(ctx.db, a.processID);

      // Connection B starts a newer attempt and must wait for A.
      await b.query('begin');
      const newerCheck = call(b, BEGIN_CHECK_SQL, [1]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      const check2 = await newerCheck;
      await b.query('commit');
      assert.ok(check2 > check1);

      // Registering the newer attempt resets the state to pending. The old
      // result is now audit data and cannot re-apply itself.
      let current = await state(ctx.db);
      assert.equal(current.public_check_state, 'pending');
      assert.equal(current.public_check_id, check2);
      assert.equal(await call(admin, FINISH_CHECK_SQL, [check1, 'matched', 1, null]), false);

      assert.equal(await call(admin, FINISH_CHECK_SQL, [check2, 'matched', 1, null]), true);
      current = await state(ctx.db);
      assert.equal(current.public_check_state, 'matched');
      assert.equal(current.public_check_observed_version, 1);

      assert.equal(await call(admin, FINISH_CHECK_SQL, [check1, 'matched', 1, null]), false);
      current = await state(ctx.db);
      assert.equal(current.public_check_id, check2);
      assert.equal(current.public_check_state, 'matched');

      const published = await call(admin, PUBLISH_SQL, [
        1, null, JSON.stringify(contentWith('v2')), 'v2', randomUUID(),
      ]);
      assert.equal(published.version, 2);
      const check3 = await call(admin, BEGIN_CHECK_SQL, [2]);

      assert.equal(await call(admin, FINISH_CHECK_SQL, [check2, 'matched', 1, null]), false);
      current = await state(ctx.db);
      assert.equal(current.public_check_state, 'pending');
      assert.equal(current.public_check_id, check3);

      assert.equal(await call(admin, FINISH_CHECK_SQL, [check3, 'matched', 2, null]), true);
      current = await state(ctx.db);
      assert.equal(current.public_check_state, 'matched');
      assert.equal(current.public_check_observed_version, 2);
    } finally {
      await admin.end();
      await a.end();
      await b.end();
    }
  });

  test('مراجعة قديمة تبقى مرفوضة بعد حذف المسودة وإعادة إنشائها', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const first = await call(admin, SAVE_SQL, [1, null, JSON.stringify(contentWith('old-draft'))]);
      const deleted = await call(admin, DELETE_SQL, [1, first.revision_id]);
      assert.equal(deleted.deleted, true);

      const second = await call(admin, SAVE_SQL, [1, null, JSON.stringify(contentWith('new-draft'))]);
      assert.notEqual(second.revision_id, first.revision_id);

      await assert.rejects(
        call(admin, SAVE_SQL, [1, first.revision_id, JSON.stringify(contentWith('stale-save'))]),
        /stale draft revision/,
      );
      await assert.rejects(
        call(admin, DELETE_SQL, [1, first.revision_id]),
        /stale draft revision/,
      );
      await assert.rejects(
        call(admin, PUBLISH_SQL, [1, first.revision_id, null, 'stale', randomUUID()]),
        /stale draft revision/,
      );

      const draft = await draftRow(ctx.db);
      assert.equal(draft.revision_id, second.revision_id);
      assert.equal(draft.content.hero.big, 'new-draft');
      assert.equal((await state(ctx.db)).version, 1);
    } finally {
      await admin.end();
    }
  });

  test('الاحتفاظ بآخر 50 نسخة والاستعادة تضيف إصدارًا جديدًا', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      let version = 1;
      for (let i = 0; i < 52; i += 1) {
        const result = await call(admin, PUBLISH_SQL, [
          version, null, JSON.stringify(contentWith(`bulk-${i}`)), `bulk ${i}`, randomUUID(),
        ]);
        assert.equal(result.version, version + 1);
        version = result.version;
      }
      assert.equal(version, 53);

      let stats = await ctx.db.query(
        'select count(*)::int as n, min(version)::int as lo, max(version)::int as hi from public.content_history',
      );
      assert.deepEqual(stats.rows[0], { n: 50, lo: 4, hi: 53 });

      const old = (await ctx.db.query(
        'select id, content from public.content_history where version = 4',
      )).rows[0];
      const restored = await call(admin, RESTORE_SQL, [old.id, 53, 'restore old', randomUUID()]);
      assert.equal(restored.version, 54);

      const current = await state(ctx.db);
      assert.equal(current.version, 54);
      assert.deepEqual(current.content, old.content);

      stats = await ctx.db.query(
        'select count(*)::int as n, min(version)::int as lo, max(version)::int as hi from public.content_history',
      );
      assert.deepEqual(stats.rows[0], { n: 50, lo: 5, hi: 54 });
    } finally {
      await admin.end();
    }
  });

  test('فشل المعاملة لا يترك تحديثات جزئية', async (t) => {
    const ctx = await createTestDb(t);
    const admin = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      const before = await state(ctx.db);
      const historyBefore = await count(ctx.db, 'content_history');
      const operationsBefore = await count(ctx.db, 'content_operations');

      await ctx.db.query(`
        create function public.test_force_failure() returns trigger
          language plpgsql
        as $$
        begin
          raise exception 'forced history failure';
        end;
        $$;
        create trigger test_force_failure
          before insert on public.content_history
          for each row
          when (new.note = 'force-rollback')
          execute function public.test_force_failure();
      `);

      let error = null;
      try {
        await call(admin, PUBLISH_SQL, [
          1, null, JSON.stringify(contentWith('rollback-content')), 'force-rollback', randomUUID(),
        ]);
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      assert.match(error.message, /forced history failure/);

      const after = await state(ctx.db);
      assert.equal(after.version, before.version);
      assert.deepEqual(after.content, before.content);
      assert.equal(
        new Date(after.saved_at).toISOString(),
        new Date(before.saved_at).toISOString(),
      );
      assert.equal(await count(ctx.db, 'content_history'), historyBefore);
      assert.equal(await count(ctx.db, 'content_operations'), operationsBefore);

      await ctx.db.query(`
        drop trigger test_force_failure on public.content_history;
        drop function public.test_force_failure();
      `);

      const ok = await call(admin, PUBLISH_SQL, [
        1, null, JSON.stringify(contentWith('after-rollback')), 'ok', randomUUID(),
      ]);
      assert.equal(ok.version, 2);
    } finally {
      await admin.end();
    }
  });

  test('حدود التحليلات مشتركة بين اتصالين: العدّاد واحد ولا يتجاوز الحد', async (t) => {
    const ctx = await createTestDb(t);
    // Two independent connections stand in for two Function instances. The
    // counter lives in a table, so the limit is not per-process memory.
    const a = await session(ctx.name, 'anon', null);
    const b = await session(ctx.name, 'anon', null);
    const visitor = 'a'.repeat(16);
    const event = JSON.stringify({
      e: 'pageview',
      s: 'session000000001',
      r: 'instagram.com',
      u: 'ig',
      device: 'desktop',
      browser: 'chrome',
      os: 'windows',
    });

    try {
      await ctx.db.query(
        `insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
         values ('preview', 'minute', $1, date_trunc('minute', clock_timestamp()), 119)`,
        [visitor],
      );

      // A takes the 120th slot and holds the row lock until it commits.
      await a.query('begin');
      assert.deepEqual(await call(a, INGEST_SQL, [ANALYTICS_DIGEST, 'preview', event, visitor]), { ok: true });

      // B reaches the same shared row and must wait; this is the observable
      // proof that the two connections share one counter.
      await b.query('begin');
      const bPromise = call(b, INGEST_SQL, [ANALYTICS_DIGEST, 'preview', event, visitor]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      const bResult = await bPromise;
      await b.query('commit');

      // B's increment lands at 121 and is rejected; only A's event is stored.
      assert.deepEqual(bResult, { ok: false, reason: 'minute_limit' });
      assert.equal(await count(ctx.db, 'analytics_events'), 1);
      const minuteRows = await ctx.db.query(
        `select count from public.analytics_rate_limits
         where env = 'preview' and scope = 'minute' and bucket = $1`,
        [visitor],
      );
      assert.equal(minuteRows.rows.length, 1);
      assert.equal(minuteRows.rows[0].count, 121);

      // The accepted event also consumed exactly one daily slot.
      const dayRows = await ctx.db.query(
        `select count from public.analytics_rate_limits
         where env = 'preview' and scope = 'day'`,
      );
      assert.equal(dayRows.rows.length, 1);
      assert.equal(dayRows.rows[0].count, 1);

      // A wrong digest is rejected before it can touch any counter.
      await assert.rejects(
        call(a, INGEST_SQL, ['f'.repeat(64), 'preview', event, visitor]),
        /forbidden/,
      );
      // The stored second-order fingerprint cannot be replayed either.
      await assert.rejects(
        call(a, INGEST_SQL, [ANALYTICS_STORED, 'preview', event, visitor]),
        /forbidden/,
      );
      const afterRejects = await ctx.db.query(
        `select count from public.analytics_rate_limits
         where env = 'preview' and scope = 'minute' and bucket = $1`,
        [visitor],
      );
      assert.equal(afterRejects.rows[0].count, 121);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('حالة الموقع: طلبا إيقاف متزامنان لا يقبلان المراجعة نفسها والتكرار الآمن واحد', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);
    const operationA = randomUUID();
    const operationB = randomUUID();

    try {
      await a.query('begin');
      const first = await call(a, SET_SITE_STATUS_SQL, ['stopped', 'صيانة', 1, operationA]);
      assert.equal(first.revision, 2);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const secondPromise = call(b, SET_SITE_STATUS_SQL, ['stopped', 'رسالة أخرى', 1, operationB]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');

      let secondError = null;
      try {
        await secondPromise;
      } catch (error) {
        secondError = error;
      }
      await b.query('rollback');

      assert.ok(secondError, 'the second stop must fail');
      assert.equal(secondError.code, 'PT409');
      assert.match(secondError.message, /stale site status revision/);

      const after = await call(a, SITE_STATUS_SQL);
      assert.equal(after.state, 'stopped');
      assert.equal(after.message, 'صيانة');
      assert.equal(after.revision, 2);
      assert.equal(after.changed_by.id, ADMIN_ID);
      assert.equal(await count(ctx.db, 'site_status_operations'), 1);

      const publicStatus = await ctx.db.query('select * from public.public_site_status');
      assert.deepEqual(publicStatus.rows[0], { state: 'stopped', message: 'صيانة' });

      const replay = await call(b, SET_SITE_STATUS_SQL, ['stopped', 'صيانة', 1, operationA]);
      assert.equal(replay.idempotent, true);
      assert.equal(replay.revision, first.revision);
      assert.equal(replay.updated_at, first.updated_at);
      assert.equal(await count(ctx.db, 'site_status_operations'), 1);

      const restarted = await call(a, SET_SITE_STATUS_SQL, ['running', '', 2, randomUUID()]);
      assert.equal(restarted.state, 'running');
      assert.equal(restarted.revision, 3);
      assert.equal((await state(ctx.db)).version, 1);

      // A replay of the old stop request is harmless after a newer restart:
      // it returns the stored result without rolling the newer state back.
      const beforeStaleReplay = await count(ctx.db, 'site_status_operations');
      const staleReplay = await call(a, SET_SITE_STATUS_SQL, ['stopped', 'صيانة', 1, operationA]);
      assert.equal(staleReplay.idempotent, true);
      assert.equal(staleReplay.revision, first.revision);
      const afterReplay = await call(a, SITE_STATUS_SQL);
      assert.equal(afterReplay.state, 'running');
      assert.equal(afterReplay.revision, restarted.revision);
      const publicAfterReplay = await ctx.db.query('select * from public.public_site_status');
      assert.deepEqual(publicAfterReplay.rows[0], { state: 'running', message: '' });
      assert.equal(await count(ctx.db, 'site_status_operations'), beforeStaleReplay);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('حذف سجل المحتوى مع نشر متزامن: لا فقد جزئي ولا حذف لنسخ بعد الحد', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);
    const clearOp = randomUUID();
    const publishOp = randomUUID();

    try {
      await call(a, PUBLISH_SQL, [1, null, JSON.stringify(contentWith('v2')), null, randomUUID()]);

      await a.query('begin');
      const clearResult = await call(a, CLEAR_HISTORY_SQL, [clearOp, 'حذف السجل نهائيًا']);
      assert.equal(clearResult.deleted_count, 2);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const publishPromise = call(b, PUBLISH_SQL, [2, null, JSON.stringify(contentWith('v3')), null, publishOp]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      const publishResult = await publishPromise;
      await b.query('commit');

      assert.equal(publishResult.version, 3);
      const history = await historyRows(ctx.db);
      assert.equal(history.length, 1);
      assert.equal(history[0].version, 3);
      assert.equal((await state(ctx.db)).version, 3);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('حذف سجل المحتوى مع استعادة متزامنة لنسخة محذوفة: الاستعادة تفشل دون حذف جزئي', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      await call(a, PUBLISH_SQL, [1, null, JSON.stringify(contentWith('v2')), null, randomUUID()]);
      const oldHistory = await historyRows(ctx.db);
      const target = oldHistory.find((row) => row.version === 1);
      assert.ok(target);

      await a.query('begin');
      const clearResult = await call(a, CLEAR_HISTORY_SQL, [randomUUID(), 'حذف السجل نهائيًا']);
      assert.equal(clearResult.deleted_count, 2);
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const restorePromise = call(b, RESTORE_SQL, [target.id, 2, 'restore-old', randomUUID()]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      await assert.rejects(restorePromise, /history version not found/);
      await b.query('rollback');

      assert.equal(await count(ctx.db, 'content_history'), 0);
      assert.equal((await state(ctx.db)).version, 2);
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('حذف سجل واحد مع استعادة متزامنة: السجل المحذوف لا يُستعاد والطلب القديم لا يمس غيره', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);
    const deleteOp = randomUUID();

    try {
      await call(a, PUBLISH_SQL, [1, null, JSON.stringify(contentWith('v2')), null, randomUUID()]);
      const history = await historyRows(ctx.db);
      const target = history.find((row) => row.version === 1);
      const survivor = history.find((row) => row.version === 2);
      assert.ok(target && survivor);

      await a.query('begin');
      const deleted = await call(a, DELETE_HISTORY_SQL, [target.id, deleteOp, 'حذف هذه النسخة نهائيًا']);
      assert.equal(Number(deleted.history_id), Number(target.id));
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const restorePromise = call(b, RESTORE_SQL, [target.id, 2, 'restore deleted row', randomUUID()]);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      await assert.rejects(restorePromise, /history version not found/);
      await b.query('rollback');

      const after = await historyRows(ctx.db);
      assert.equal(after.length, 1, 'only the targeted history row may disappear');
      assert.equal(Number(after[0].id), Number(survivor.id));
      assert.equal((await state(ctx.db)).version, 2);

      const replay = await call(a, DELETE_HISTORY_SQL, [target.id, deleteOp, 'حذف هذه النسخة نهائيًا']);
      assert.deepEqual(replay, deleted, 'a replay must return the stored result');
      assert.equal((await historyRows(ctx.db)).length, 1);

      // Reusing the old operation id with a *different* row must never delete
      // that other row, even after the original target is gone.
      await assert.rejects(
        call(a, DELETE_HISTORY_SQL, [survivor.id, deleteOp, 'حذف هذه النسخة نهائيًا']),
        /operation id was reused|different request|request parameters/,
      );
      assert.equal((await historyRows(ctx.db)).length, 1, 'the old request must not touch another row');
      assert.equal(Number((await historyRows(ctx.db))[0].id), Number(survivor.id));
    } finally {
      await a.end();
      await b.end();
    }
  });

  test('حذف سجل واحد مع مسح شامل متزامن: لا فقد مزدوج ولا نتيجة ناقصة', async (t) => {
    const ctx = await createTestDb(t);
    const a = await session(ctx.name, 'authenticated', ADMIN_ID);
    const b = await session(ctx.name, 'authenticated', ADMIN_ID);

    try {
      await call(a, PUBLISH_SQL, [1, null, JSON.stringify(contentWith('v2')), null, randomUUID()]);
      await call(a, PUBLISH_SQL, [2, null, JSON.stringify(contentWith('v3')), null, randomUUID()]);
      const target = (await historyRows(ctx.db)).find((row) => row.version === 1);
      assert.ok(target);

      await a.query('begin');
      const deleted = await call(a, DELETE_HISTORY_SQL, [target.id, randomUUID(), 'حذف هذه النسخة نهائيًا']);
      assert.equal(Number(deleted.history_id), Number(target.id));
      await waitForAdvisoryLock(ctx.db, a.processID);

      await b.query('begin');
      const clearPromise = call(b, CLEAR_HISTORY_SQL, [randomUUID(), 'حذف السجل نهائيًا']);
      await waitForBlocked(ctx.db, b.processID, a.processID);

      await a.query('commit');
      const cleared = await clearPromise;
      await b.query('commit');

      assert.equal(cleared.deleted_count, 2, 'the bulk clear must only report rows it actually removed');
      assert.equal(await count(ctx.db, 'content_history'), 0);
      assert.equal((await state(ctx.db)).version, 3, 'history cleanup must not change published content');
    } finally {
      await a.end();
      await b.end();
    }
  });
}
