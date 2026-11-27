// Real two-connection concurrency checks for media deletion.
//
// Run with: npm run test:db:media
//
// These tests use a real, isolated PostgreSQL server over TCP (not PGlite) and
// two independent admin sessions. Every interleaving is ordered by an observed
// advisory lock / pg_blocking_pids, never by an arbitrary sleep. They exercise
// the SQL RPCs the Netlify function calls; they do not start PostgREST, GoTrue,
// Storage, or Netlify, and they do not upload bytes. Netlify/Storage behaviour
// is covered separately by the live tests.
//
// Safety: loopback only, throwaway databases only, never port 5432 unless
// explicitly allowed, never touches the existing service or the cloud project.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

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
  'supabase/migrations/20261128120000_media_permanent_delete_and_history_row_delete.sql',
];

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const FINALIZE_TOKEN = 'local-test-finalize-token-0123456789abcdef';
const FINALIZE_HASH = createHash('sha256').update(FINALIZE_TOKEN).digest('hex');
const MEDIA_MIME = 'image/png';
const MEDIA_BYTES = 1024;
const MEDIA_SHA = createHash('sha256').update('concurrency-test-image').digest('hex');

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
  MIGRATIONS.map(async (file) => (await readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, '')),
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
const PUBLISH_SQL =
  'select public.admin_publish($1::bigint, $2::uuid, $3::jsonb, $4::text, $5::uuid) as result';
const RESTORE_SQL =
  'select public.admin_restore($1::bigint, $2::bigint, $3::text, $4::uuid) as result';
const MEDIA_CREATE_SQL =
  'select public.admin_media_create($1::text, $2::text, $3::bigint) as result';
const MEDIA_FINALIZE_SQL =
  'select public.admin_media_finalize($1::uuid, $2::text, $3::text, $4::bigint, $5::integer, $6::integer, $7::bigint, $8::text) as result';
const DELETE_BEGIN_SQL =
  'select public.admin_media_delete_begin($1::uuid, $2::text, $3::uuid) as result';
const DELETE_FINISH_SQL =
  'select public.admin_media_delete_finish($1::uuid, $2::text, $3::uuid, $4::text) as result';
const RESTORE_BEGIN_SQL =
  'select public.admin_media_restore_begin($1::uuid, $2::text, $3::uuid) as result';
const RESTORE_FINISH_SQL =
  'select public.admin_media_restore_finish($1::uuid, $2::text, $3::uuid) as result';
const PURGE_BEGIN_SQL =
  'select public.admin_media_purge_begin($1::uuid, $2::text, $3::uuid, $4::text) as result';
const PREPARE_PUBLIC_SQL =
  'select public.admin_media_prepare_public($1::uuid, $2::text) as result';
const CONFIRM_PUBLIC_SQL =
  'select public.admin_media_confirm_public($1::uuid, $2::text, $3::text) as result';
const PURGE_CONFIRMATION = 'حذف الصورة نهائيًا';

function contentWith(label) {
  const copy = structuredClone(defaultContent);
  copy.hero.big = label;
  return copy;
}

function contentWithMedia(label, ref) {
  const copy = contentWith(label);
  copy.hero.image = ref;
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

async function adminSession(database) {
  const client = await connect(database);
  const claims = JSON.stringify({ sub: ADMIN_ID, role: 'authenticated' });
  await client.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [ADMIN_ID]);
  await client.query('set role authenticated');
  return client;
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    // Only avoids a busy loop while observing a lock; it never decides order.
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

async function expectReject(promise, matcher, label) {
  try {
    await promise;
  } catch (error) {
    assert.match(String(error.message || ''), matcher, `${label}: unexpected error message`);
    return error;
  }
  assert.fail(`${label}: expected the operation to be rejected`);
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
    'اختبارات تزامن الوسائط تحتاج خادم PostgreSQL محليًا معزولًا',
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
    const name = `ccafe_media_${process.pid}_${Date.now().toString(36)}_${counter++}`;
    await maintenance.query(`create database ${name}`);
    const db = await connect(name);
    const clients = [db];
    try {
      await db.query(BOOTSTRAP_SQL);
      for (const sql of migrationSql) await db.query(sql);
      await db.query(seedSql);
      await db.query(
        `insert into public.admin_users (user_id, role) values ('${ADMIN_ID}', 'admin')`,
      );
      await db.query(
        `update public.media_secrets
         set value_sha256 = '${FINALIZE_HASH}', updated_at = pg_catalog.now()
         where name = 'finalize'`,
      );
    } catch (error) {
      await db.end();
      await dropDatabase(name);
      throw error;
    }
    t.after(async () => {
      for (const client of clients) {
        try {
          await client.end();
        } catch {
          // already closed
        }
      }
      await dropDatabase(name);
    });
    return {
      name,
      db,
      async session() {
        const client = await adminSession(name);
        clients.push(client);
        return client;
      },
    };
  }

  async function mediaCreate(session) {
    return call(session, MEDIA_CREATE_SQL, ['concurrency.png', MEDIA_MIME, MEDIA_BYTES]);
  }

  async function mediaFinalize(session, id) {
    return call(session, MEDIA_FINALIZE_SQL, [
      id,
      FINALIZE_TOKEN,
      MEDIA_MIME,
      MEDIA_BYTES,
      2,
      2,
      4,
      MEDIA_SHA,
    ]);
  }

  async function createApprovedAsset(ctx, session) {
    const db = ctx.db;
    const created = await mediaCreate(session);
    await db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)",
      [created.storage_path],
    );
    await call(session, 'select public.admin_media_begin_finalize($1::uuid) as result', [created.id]);
    const approved = await mediaFinalize(session, created.id);
    return { ...approved, storage_path: created.storage_path };
  }

  async function createReadyPublicAsset(ctx, session) {
    const approved = await createApprovedAsset(ctx, session);
    const prepared = await call(
      session,
      'select public.admin_media_prepare_public($1::uuid, $2::text) as result',
      [approved.id, FINALIZE_TOKEN],
    );
    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-public', $1)",
      [prepared.object_path],
    );
    const confirmed = await call(
      session,
      'select public.admin_media_confirm_public($1::uuid, $2::text, $3::text) as result',
      [approved.id, FINALIZE_TOKEN, approved.sha256],
    );
    return { approved, prepared, confirmed };
  }

  async function createTrashedAsset(ctx, session) {
    const approved = await createApprovedAsset(ctx, session);
    const operationId = randomUUID();
    const begun = await call(session, DELETE_BEGIN_SQL, [approved.id, FINALIZE_TOKEN, operationId]);
    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
      [begun.object_path],
    );
    const finished = await call(session, DELETE_FINISH_SQL, [
      approved.id,
      FINALIZE_TOKEN,
      operationId,
      approved.sha256,
    ]);
    // Simulate the server-side cleanup that runs after delete_finish: the
    // private original is removed and the cleanup result is recorded. The trash
    // copy stays available for a restore.
    await ctx.db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1",
      [approved.storage_path],
    );
    await call(
      session,
      'select public.admin_media_delete_cleanup($1::uuid, $2::text, $3::uuid, $4::boolean, $5::text, $6::boolean, $7::text) as result',
      [approved.id, FINALIZE_TOKEN, operationId, true, null, null, null],
    );
    return { approved, begun, finished, operationId };
  }

  async function createTrashedReadyPublicAsset(ctx, session) {
    const ready = await createReadyPublicAsset(ctx, session);
    const operationId = randomUUID();
    const begun = await call(session, DELETE_BEGIN_SQL, [ready.approved.id, FINALIZE_TOKEN, operationId]);
    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
      [begun.object_path],
    );
    const finished = await call(session, DELETE_FINISH_SQL, [
      ready.approved.id,
      FINALIZE_TOKEN,
      operationId,
      ready.approved.sha256,
    ]);
    assert.equal(finished.state, 'trashed');
    assert.equal(finished.public_cleanup_state, 'pending');
    return { ...ready, begun, finished, operationId };
  }

  async function pid(client) {
    return (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
  }

  test('الحذف مقابل حفظ مسودة تشير للصورة: الحذف يسبق فيُرفض الحفظ بوضوح', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const deleting = await ctx.session();
    const saving = await ctx.session();
    const asset = await createApprovedAsset(ctx, setup);
    const site = (await ctx.db.query('select version from public.site_content where id = 1')).rows[0];
    const draftBefore = (await ctx.db.query('select revision_id from public.draft where id = 1')).rows[0] || null;

    const deleteOp = randomUUID();
    await deleting.query('begin');
    const begun = await call(deleting, DELETE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, deleteOp]);
    assert.equal(begun.state, 'staging');
    await waitForAdvisoryLock(ctx.db, await pid(deleting));

    await saving.query('begin');
    const savingPid = await pid(saving);
    const savePromise = call(
      saving,
      SAVE_SQL,
      [site.version, draftBefore ? draftBefore.revision_id : null, JSON.stringify(contentWithMedia('race-save', asset.logical_path))],
    );
    await waitForBlocked(ctx.db, savingPid, await pid(deleting));

    await deleting.query('commit');
    await expectReject(savePromise, /approved media asset/, 'draft save after delete');

    const assetRow = (await ctx.db.query('select status from public.media_assets where id = $1', [asset.id])).rows[0];
    assert.equal(assetRow.status, 'deleting', 'the delete won before the lock was released');
    const draftAfter = (await ctx.db.query('select revision_id from public.draft where id = 1')).rows[0] || null;
    assert.equal(draftAfter && draftAfter.revision_id, draftBefore && draftBefore.revision_id,
      'no draft revision may be committed with a reference to a deleting image');
    await saving.query('rollback');
    await deleting.query('rollback');
  });

  test('الحذف مقابل نشر الصورة: النشر يسبق فيُرفض الحذف لوجود مرجع منشور', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const publishing = await ctx.session();
    const deleting = await ctx.session();
    const ready = await createReadyPublicAsset(ctx, setup);
    const asset = ready.approved;
    const site = (await ctx.db.query('select version from public.site_content where id = 1')).rows[0];
    const draft = await call(setup, SAVE_SQL, [
      site.version,
      null,
      JSON.stringify(contentWithMedia('publish-race', asset.logical_path)),
    ]);

    await publishing.query('begin');
    const publishPromise = call(publishing, PUBLISH_SQL, [
      site.version,
      draft.revision_id,
      null,
      'race publish',
      randomUUID(),
    ]);
    await waitForAdvisoryLock(ctx.db, await pid(publishing));

    await deleting.query('begin');
    const deletingPid = await pid(deleting);
    const deletePromise = call(deleting, DELETE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID()]);
    await waitForBlocked(ctx.db, deletingPid, await pid(publishing));

    await publishing.query('commit');
    const published = await publishPromise;
    assert.equal(published.version, Number(site.version) + 1);

    const blocked = await deletePromise;
    assert.equal(blocked.state, 'blocked');
    assert.ok(blocked.reasons.includes('published'), 'the new published reference must block deletion');
    assert.ok(blocked.reasons.includes('history'));
    assert.equal(blocked.references.published, true);

    const assetRow = (await ctx.db.query('select status from public.media_assets where id = $1', [asset.id])).rows[0];
    assert.equal(assetRow.status, 'approved');
    const current = (await ctx.db.query('select content from public.site_content where id = 1')).rows[0].content;
    assert.equal(current.hero.image, asset.logical_path);
    await deleting.query('rollback');
  });

  test('الحذف مقابل استعادة محتوى يشير للصورة: الاستعادة تسبق فيُرفض الحذف', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const restoring = await ctx.session();
    const deleting = await ctx.session();
    const ready = await createReadyPublicAsset(ctx, setup);
    const asset = ready.approved;
    const site = (await ctx.db.query('select version from public.site_content where id = 1')).rows[0];
    const draft = await call(setup, SAVE_SQL, [
      site.version,
      null,
      JSON.stringify(contentWithMedia('restore-race', asset.logical_path)),
    ]);
    const published = await call(setup, PUBLISH_SQL, [
      site.version,
      draft.revision_id,
      null,
      'history with image',
      randomUUID(),
    ]);
    const history = (await ctx.db.query(
      'select id, version from public.content_history where version = $1 order by id desc limit 1',
      [published.version],
    )).rows[0];
    assert.ok(history, 'the publish must create the history row used by restore');

    await restoring.query('begin');
    const restorePromise = call(restoring, RESTORE_SQL, [
      history.id,
      published.version,
      'restore race',
      randomUUID(),
    ]);
    await waitForAdvisoryLock(ctx.db, await pid(restoring));

    await deleting.query('begin');
    const deletingPid = await pid(deleting);
    const deletePromise = call(deleting, DELETE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID()]);
    await waitForBlocked(ctx.db, deletingPid, await pid(restoring));

    await restoring.query('commit');
    const restored = await restorePromise;
    assert.equal(restored.version, published.version + 1);

    // History is an intentional permanent blocker, and the restored published
    // content is now visible to the same usage check. Either way the image must
    // never be deleted while restored content references it.
    const blocked = await deletePromise;
    assert.equal(blocked.state, 'blocked');
    assert.ok(blocked.reasons.includes('published'));
    assert.ok(blocked.reasons.includes('history'));

    const assetRow = (await ctx.db.query('select status from public.media_assets where id = $1', [asset.id])).rows[0];
    assert.equal(assetRow.status, 'approved');
    const current = (await ctx.db.query('select content from public.site_content where id = 1')).rows[0].content;
    assert.equal(current.hero.image, asset.logical_path);
    await deleting.query('rollback');
  });

  test('الاسترداد مقابل طلب حذف جديد: الاسترداد يسبق فيُرفض الحذف الجديد', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const restoring = await ctx.session();
    const deleting = await ctx.session();
    const trashed = await createTrashedAsset(ctx, setup);
    assert.equal(trashed.finished.state, 'trashed');

    await restoring.query('begin');
    const restoreOp = randomUUID();
    const begun = await call(restoring, RESTORE_BEGIN_SQL, [trashed.approved.id, FINALIZE_TOKEN, restoreOp]);
    assert.equal(begun.state, 'restoring');
    await waitForAdvisoryLock(ctx.db, await pid(restoring));

    await deleting.query('begin');
    const deletingPid = await pid(deleting);
    const deletePromise = call(deleting, DELETE_BEGIN_SQL, [trashed.approved.id, FINALIZE_TOKEN, randomUUID()]);
    await waitForBlocked(ctx.db, deletingPid, await pid(restoring));

    await restoring.query('commit');
    await expectReject(deletePromise, /being restored/, 'delete during restore');

    const restoringRow = (await ctx.db.query('select status from public.media_assets where id = $1', [trashed.approved.id])).rows[0];
    assert.equal(restoringRow.status, 'restoring');
    await deleting.query('rollback');

    // Finish the restore, then prove a *new* delete is possible only after the
    // asset is approved again; the blocked request above changed nothing.
    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)",
      [trashed.approved.storage_path],
    );
    const finished = await call(restoring, RESTORE_FINISH_SQL, [trashed.approved.id, FINALIZE_TOKEN, restoreOp]);
    assert.equal(finished.state, 'approved');

    await deleting.query('begin');
    const fresh = await call(deleting, DELETE_BEGIN_SQL, [trashed.approved.id, FINALIZE_TOKEN, randomUUID()]);
    assert.equal(fresh.state, 'staging');
    await deleting.query('rollback');
    const finalRow = (await ctx.db.query('select status from public.media_assets where id = $1', [trashed.approved.id])).rows[0];
    assert.equal(finalRow.status, 'approved');
  });

  test('حذف صورة بنسخة عامة جاهزة بلا مرجع: مسار التنظيف العام يسجل داخل المعاملة', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const asset = await createApprovedAsset(ctx, setup);
    const prepared = await call(setup, 'select public.admin_media_prepare_public($1::uuid, $2::text) as result', [
      asset.id,
      FINALIZE_TOKEN,
    ]);
    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-public', $1)",
      [prepared.object_path],
    );
    const confirmed = await call(
      setup,
      'select public.admin_media_confirm_public($1::uuid, $2::text, $3::text) as result',
      [asset.id, FINALIZE_TOKEN, asset.sha256],
    );
    assert.equal(confirmed.state, 'ready');

    const usage = await call(setup, 'select public.admin_media_usage($1::uuid) as result', [asset.id]);
    assert.equal(usage.deletable, true);
    assert.equal(usage.reasons.includes('public_ready'), false);
    assert.equal(usage.references.public_state, 'ready');

    const op = randomUUID();
    const begun = await call(setup, DELETE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, op]);
    assert.equal(begun.public_object_path, prepared.object_path);
    assert.equal(begun.public_cleanup_state, 'pending');
    assert.equal(
      (await ctx.db.query('select state from public.media_public_assets where asset_id = $1', [asset.id])).rows[0].state,
      'ready',
      'begin must not invalidate a ready copy before the trash copy exists',
    );

    await ctx.db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
      [begun.object_path],
    );
    const finished = await call(setup, DELETE_FINISH_SQL, [asset.id, FINALIZE_TOKEN, op, asset.sha256]);
    assert.equal(finished.state, 'trashed');
    assert.equal(finished.public_cleanup_state, 'pending');
    assert.equal(
      (await ctx.db.query('select state from public.media_public_assets where asset_id = $1', [asset.id])).rows[0].state,
      'failed',
      'the public row flips only at the delete commit point',
    );

    const targets = await call(setup, 'select public.admin_media_cleanup_targets($1::uuid, $2::text) as result', [
      asset.id,
      FINALIZE_TOKEN,
    ]);
    assert.equal(targets.public_object_path, prepared.object_path);
    const cleanup = await call(
      setup,
      'select public.admin_media_delete_cleanup($1::uuid, $2::text, $3::uuid, $4::boolean, $5::text, $6::boolean, $7::text) as result',
      [asset.id, FINALIZE_TOKEN, op, true, null, true, null],
    );
    assert.equal(cleanup.cleanup_state, 'done');
    assert.equal(cleanup.public_cleanup_state, 'done');
  });

  test('الحذف النهائي مقابل حفظ مسودة: القفل يمنع المرجع canonical والخام ورابط النشر', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const purging = await ctx.session();
    const saving = await ctx.session();
    const trashed = await createTrashedAsset(ctx, setup);
    const asset = trashed.approved;
    const site = (await ctx.db.query('select version from public.site_content where id = 1')).rows[0];
    const draftBefore = (await ctx.db.query('select revision_id from public.draft where id = 1')).rows[0] || null;

    await purging.query('begin');
    const begun = await call(purging, PURGE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID(), PURGE_CONFIRMATION]);
    assert.equal(begun.state, 'purging');
    await waitForAdvisoryLock(ctx.db, await pid(purging));

    await saving.query('begin');
    const savingPid = await pid(saving);
    const savePromise = call(saving, SAVE_SQL, [
      site.version,
      draftBefore ? draftBefore.revision_id : null,
      JSON.stringify(contentWithMedia('purge-save-race', asset.logical_path)),
    ]);
    await waitForBlocked(ctx.db, savingPid, await pid(purging));

    await purging.query('commit');
    await expectReject(savePromise, /permanently deleted/, 'draft save after purge begins');
    await saving.query('rollback');

    const draftAfter = (await ctx.db.query('select revision_id from public.draft where id = 1')).rows[0] || null;
    assert.equal(draftAfter && draftAfter.revision_id, draftBefore && draftBefore.revision_id,
      'no draft may be written with a reference to an asset being purged');

    // The purge row remains in the purging state through Storage cleanup, so
    // later writers must also reject bare ids and public links, not just paths.
    const variants = [
      ['bare asset id', asset.id],
      ['public link', `https://example.supabase.co/storage/v1/object/public/ccafe-public/published/${asset.id}/${asset.sha256}`],
    ];
    for (const [label, ref] of variants) {
      await expectReject(
        call(saving, SAVE_SQL, [
          site.version,
          draftAfter ? draftAfter.revision_id : null,
          JSON.stringify(contentWithMedia(`purge-${label}`, ref)),
        ]),
        /permanently deleted/,
        `draft save with ${label}`,
      );
    }
  });

  test('الحذف النهائي مقابل نشر: أي مرجع للصورة أثناء التنظيف يُرفض', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const purging = await ctx.session();
    const publishing = await ctx.session();
    const trashed = await createTrashedAsset(ctx, setup);
    const asset = trashed.approved;
    const site = (await ctx.db.query('select version from public.site_content where id = 1')).rows[0];

    await purging.query('begin');
    await call(purging, PURGE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID(), PURGE_CONFIRMATION]);
    await waitForAdvisoryLock(ctx.db, await pid(purging));

    await publishing.query('begin');
    const publishingPid = await pid(publishing);
    const publishPromise = call(publishing, PUBLISH_SQL, [
      site.version,
      null,
      JSON.stringify(contentWithMedia('purge-publish-race', asset.logical_path)),
      'purge publish race',
      randomUUID(),
    ]);
    await waitForBlocked(ctx.db, publishingPid, await pid(purging));

    await purging.query('commit');
    await expectReject(publishPromise, /permanently deleted/, 'publish after purge begins');
    await publishing.query('rollback');

    assert.equal((await ctx.db.query('select version from public.site_content where id = 1')).rows[0].version, site.version);

    const variants = [asset.id, `https://example.supabase.co/storage/v1/object/public/ccafe-public/published/${asset.id}/${asset.sha256}`];
    for (const ref of variants) {
      await expectReject(
        call(publishing, PUBLISH_SQL, [
          site.version,
          null,
          JSON.stringify(contentWithMedia('purge-publish-id', ref)),
          'purge publish id',
          randomUUID(),
        ]),
        /permanently deleted/,
        `publish with ${ref}`,
      );
    }
  });

  test('الحذف النهائي مقابل استعادة الصورة: الاستعادة لا تبدأ أثناء التنظيف', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const purging = await ctx.session();
    const restoring = await ctx.session();
    const trashed = await createTrashedAsset(ctx, setup);
    const asset = trashed.approved;

    await purging.query('begin');
    await call(purging, PURGE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID(), PURGE_CONFIRMATION]);
    await waitForAdvisoryLock(ctx.db, await pid(purging));

    await restoring.query('begin');
    const restoringPid = await pid(restoring);
    const restorePromise = call(restoring, RESTORE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID()]);
    await waitForBlocked(ctx.db, restoringPid, await pid(purging));

    await purging.query('commit');
    await expectReject(restorePromise, /permanently deleted/, 'media restore during purge');
    await restoring.query('rollback');

    const row = (await ctx.db.query('select status from public.media_assets where id = $1', [asset.id])).rows[0];
    assert.equal(row.status, 'purging', 'a blocked restore must not change the purging asset');
  });

  test('الحذف النهائي مقابل تجهيز وتأكيد نسخة عامة: لا تُنشأ نسخة جديدة', async (t) => {
    const ctx = await createTestDb(t);
    const setup = await ctx.session();
    const purging = await ctx.session();
    const preparing = await ctx.session();
    const confirming = await ctx.session();
    const trashed = await createTrashedReadyPublicAsset(ctx, setup);
    const asset = trashed.approved;

    await purging.query('begin');
    const purgingPid = await pid(purging);
    const begun = await call(purging, PURGE_BEGIN_SQL, [asset.id, FINALIZE_TOKEN, randomUUID(), PURGE_CONFIRMATION]);
    assert.equal(begun.public_cleanup_state, 'pending');
    await waitForAdvisoryLock(ctx.db, purgingPid);

    await preparing.query('begin');
    const preparingPid = await pid(preparing);
    const preparePromise = call(preparing, PREPARE_PUBLIC_SQL, [asset.id, FINALIZE_TOKEN]);
    await waitForBlocked(ctx.db, preparingPid, purgingPid);

    await confirming.query('begin');
    const confirmingPid = await pid(confirming);
    let confirmSettled = false;
    const confirmPromise = call(confirming, CONFIRM_PUBLIC_SQL, [asset.id, FINALIZE_TOKEN, asset.sha256])
      .then((value) => { confirmSettled = true; return value; })
      .catch((error) => { confirmSettled = true; throw error; });
    // A second row-lock waiter can be queued behind the first one, so accept
    // either blocker, or a prompt rejection from the RPC itself.
    await waitFor(async () => {
      const row = await ctx.db.query('select pg_blocking_pids($1) as blockers', [confirmingPid]);
      return confirmSettled
        || row.rows[0].blockers.includes(purgingPid)
        || row.rows[0].blockers.includes(preparingPid);
    }, `pid ${confirmingPid} blocked or settled during purge`);

    await purging.query('commit');
    await expectReject(preparePromise, /not approved|permanently deleted/, 'public prepare during purge');
    await expectReject(confirmPromise, /not approved|permanently deleted/, 'public confirm during purge');
    await preparing.query('rollback');
    await confirming.query('rollback');

    const publicRow = (await ctx.db.query(
      'select state, object_path from public.media_public_assets where asset_id = $1',
      [asset.id],
    )).rows[0];
    assert.equal(publicRow.state, 'failed', 'a purging asset must never regain a ready public copy');
    assert.equal(publicRow.object_path, trashed.prepared.object_path);
  });
}
