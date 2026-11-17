// Fast local database checks for the Supabase content model.
//
// Run with: npm run test:db
// For real two-connection concurrency checks use: npm run test:db:real
//
// This harness uses PGlite (PostgreSQL compiled to WASM) so the SQL can be
// exercised without Docker or a cloud project. It creates a minimal Supabase-like
// environment: the auth schema/users table, an auth.uid() function that reads
// request.jwt.claims, and the anon/authenticated roles. Role switching uses
// SET ROLE, and admins/users are identified by local test UUIDs.
//
// PGlite is single-session, so conflicts are simulated by calling the RPCs in
// the same session in the order two sessions could produce. This is NOT proof of
// real concurrency; pg-real-check.mjs uses two TCP connections and observes
// pg_locks/pg_blocking_pids instead. Neither harness verifies JWT signatures or
// runs PostgREST/GoTrue.
//
// The harness creates only local test auth users and a local admin allow-list row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
];

const ADMIN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
// Local raw server token for the test harness. The migrations ship inert placeholders,
// and the harness overrides media_secrets/analytics_secrets after loading them so
// tests never depend on a deployed secret. A stored digest is not a credential.
const FINALIZE_TOKEN = 'local-test-finalize-token-0123456789abcdef';
const FINALIZE_HASH = createHash('sha256').update(FINALIZE_TOKEN).digest('hex');
const ANALYTICS_TOKEN = 'local-test-analytics-token-0123456789abcdef';
// The Function sends D1; the database stores D2 = SHA-256('ingest|' || D1).
const ANALYTICS_SENT = createHash('sha256').update(`ingest|${ANALYTICS_TOKEN}`).digest('hex');
const ANALYTICS_HASH = createHash('sha256').update(`ingest|${ANALYTICS_SENT}`).digest('hex');
const MEDIA_MIME = 'image/png';
const MEDIA_BYTES = 1024;
const MEDIA_SHA = createHash('sha256').update('local-test-image').digest('hex');

let PGlite = null;
let pgcrypto = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
} catch {
  PGlite = null;
}

const defaultContent = JSON.parse(
  await readFile(path.join(root, 'data', 'content.json'), 'utf8'),
);

function contentWith(label) {
  const copy = JSON.parse(JSON.stringify(defaultContent));
  copy.hero.big = label;
  return copy;
}

if (!PGlite) {
  test(
    'اختبارات قاعدة البيانات تحتاج @electric-sql/pglite',
    { skip: 'شغّل npm install ثم npm run test:db' },
    () => {},
  );
} else {
  const migrationSql = await Promise.all(
    MIGRATIONS.map(async (file) => (await readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, '')),
  );
  const seedSql = await readFile(path.join(root, 'supabase', 'seed.sql'), 'utf8');

  async function createDb() {
    const db = await PGlite.create({ extensions: { pgcrypto } });

    // Supabase provides these; the local harness supplies the minimum needed.
    await db.exec(`
      create schema auth;
      create table auth.users (id uuid primary key, email text unique);
      create function auth.uid() returns uuid
        language sql stable
      as $$
        select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
      $$;
      create role anon nologin;
      create role authenticated nologin;
      grant usage on schema public to anon, authenticated;

      -- Minimal Storage stand-in. Real Supabase ships these tables and RLS; the
      -- media migration adds policies to storage.objects, so the local harness
      -- must provide the table before running migrations.
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

      insert into auth.users (id, email) values
        ('${ADMIN_ID}', 'admin@local.test'),
        ('${USER_ID}', 'user@local.test');
    `);

    for (const sql of migrationSql) await db.exec(sql);
    await db.exec(seedSql);
    await db.exec(`
      insert into public.admin_users (user_id, role)
      values ('${ADMIN_ID}', 'admin');

      -- The deployed migration stores a real second-order digest; the repo now
      -- ships only an inert placeholder for it. The harness swaps in the digest of
      -- a local token. Only the digest is stored; the local raw token is a test constant.
      update public.media_secrets
      set value_sha256 = '${FINALIZE_HASH}', updated_at = pg_catalog.now()
      where name = 'finalize';

      update public.analytics_secrets
      set value_sha256 = '${ANALYTICS_HASH}', updated_at = pg_catalog.now()
      where name = 'ingest';
    `);

    return db;
  }

  async function asRole(db, role, userId, fn) {
    await db.query("select set_config('request.jwt.claims', $1, false)", [
      userId ? JSON.stringify({ sub: userId }) : '{}',
    ]);
    await db.exec(`set role ${role}`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claims', '', false)");
    }
  }

  const asAdmin = (db, fn) => asRole(db, 'authenticated', ADMIN_ID, fn);
  const asUser = (db, fn) => asRole(db, 'authenticated', USER_ID, fn);
  const asVisitor = (db, fn) => asRole(db, 'anon', null, fn);

  async function rpc(db, sql, params = []) {
    const result = await asAdmin(db, () => db.query(sql, params));
    return result.rows[0].result;
  }

  const saveDraft = (db, version, revision, content) =>
    rpc(
      db,
      'select public.admin_save_draft($1::bigint, $2::uuid, $3::jsonb) as result',
      [version, revision, JSON.stringify(content)],
    );

  const deleteDraft = (db, version, revision) =>
    rpc(
      db,
      'select public.admin_delete_draft($1::bigint, $2::uuid) as result',
      [version, revision],
    );

  const publish = (db, version, draftRevision, content, note, operationId) =>
    rpc(
      db,
      'select public.admin_publish($1::bigint, $2::uuid, $3::jsonb, $4::text, $5::uuid) as result',
      [version, draftRevision, content ? JSON.stringify(content) : null, note, operationId],
    );

  const restore = (db, historyId, version, note, operationId) =>
    rpc(
      db,
      'select public.admin_restore($1::bigint, $2::bigint, $3::text, $4::uuid) as result',
      [historyId, version, note, operationId],
    );

  const mediaCreate = (db, name, mime, bytes) =>
    rpc(
      db,
      'select public.admin_media_create($1::text, $2::text, $3::bigint) as result',
      [name, mime, bytes],
    );

  const mediaBegin = (db, id) =>
    rpc(
      db,
      'select public.admin_media_begin_finalize($1::uuid) as result',
      [id],
    );

  const mediaFinalize = (db, id, token, mime, bytes, width, height, pixelCount, sha) =>
    rpc(
      db,
      'select public.admin_media_finalize($1::uuid, $2::text, $3::text, $4::bigint, $5::integer, $6::integer, $7::bigint, $8::text) as result',
      [id, token, mime, bytes, width, height, pixelCount, sha],
    );

  const mediaFail = (db, id, reason) =>
    rpc(
      db,
      'select public.admin_media_fail($1::uuid, $2::text) as result',
      [id, reason],
    );

  const mediaPublishBegin = (db, version, revision, note, operationId) =>
    rpc(
      db,
      'select public.admin_media_publish_begin($1::bigint, $2::uuid, $3::text, $4::uuid) as result',
      [version, revision, note, operationId],
    );

  const mediaPreparePublic = (db, id, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_prepare_public($1::uuid, $2::text) as result',
      [id, token],
    );

  const mediaConfirmPublic = (db, id, sha, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_confirm_public($1::uuid, $2::text, $3::text) as result',
      [id, token, sha],
    );

  const mediaFailPublic = (db, id, reason, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_fail_public($1::uuid, $2::text, $3::text) as result',
      [id, token, reason],
    );

  const mediaUsage = (db, id) =>
    rpc(db, 'select public.admin_media_usage($1::uuid) as result', [id]);

  const mediaTrashList = (db) =>
    rpc(db, 'select public.admin_media_trash_list() as result');

  const mediaDeleteBegin = (db, id, operationId, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_delete_begin($1::uuid, $2::text, $3::uuid) as result',
      [id, token, operationId],
    );

  const mediaDeleteFinish = (db, id, operationId, sha, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_delete_finish($1::uuid, $2::text, $3::uuid, $4::text) as result',
      [id, token, operationId, sha],
    );

  const mediaDeleteAbort = (db, id, operationId, reason, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_delete_abort($1::uuid, $2::text, $3::uuid, $4::text) as result',
      [id, token, operationId, reason],
    );

  const mediaDeleteCleanup = (db, id, operationId, done, error, publicDone = null, publicError = null, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_delete_cleanup($1::uuid, $2::text, $3::uuid, $4::boolean, $5::text, $6::boolean, $7::text) as result',
      [id, token, operationId, done, error, publicDone, publicError],
    );

  const mediaCleanupTargets = (db, id, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_cleanup_targets($1::uuid, $2::text) as result',
      [id, token],
    );

  const mediaRestoreBegin = (db, id, operationId, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_restore_begin($1::uuid, $2::text, $3::uuid) as result',
      [id, token, operationId],
    );

  const mediaRestoreFinish = (db, id, operationId, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_restore_finish($1::uuid, $2::text, $3::uuid) as result',
      [id, token, operationId],
    );

  const mediaRestoreAbort = (db, id, operationId, reason, token = FINALIZE_TOKEN) =>
    rpc(
      db,
      'select public.admin_media_restore_abort($1::uuid, $2::text, $3::uuid, $4::text) as result',
      [id, token, operationId, reason],
    );

  async function insertTrashObject(db, name) {
    await db.query("insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)", [name]);
  }

  async function createTrashedAsset(db, operationId = randomUUID()) {
    const approved = await createApprovedAsset(db);
    const begun = await mediaDeleteBegin(db, approved.id, operationId);
    await insertTrashObject(db, begun.object_path);
    const finished = await mediaDeleteFinish(db, approved.id, operationId, approved.sha256);
    return { approved, begun, finished, operationId };
  }

  async function insertObject(db, name) {
    await db.query("insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [name]);
  }

  async function insertPublicObject(db, name) {
    await db.query("insert into storage.objects (bucket_id, name) values ('ccafe-public', $1)", [name]);
  }

  async function createApprovedAsset(db, width = 2, height = 2) {
    const created = await mediaCreate(db, 'photo.png', MEDIA_MIME, MEDIA_BYTES);
    await insertObject(db, created.storage_path);
    await mediaBegin(db, created.id);
    const approved = await mediaFinalize(
      db,
      created.id,
      FINALIZE_TOKEN,
      MEDIA_MIME,
      MEDIA_BYTES,
      width,
      height,
      width * height,
      MEDIA_SHA,
    );
    return { ...approved, storage_path: created.storage_path };
  }

  // Full publish preparation: create an approved upload, stage its public copy,
  // upload the object, and confirm the copy as ready. Linking happens only when a
  // publish/restore RPC succeeds.
  async function createReadyPublicAsset(db) {
    const approved = await createApprovedAsset(db);
    const prepared = await mediaPreparePublic(db, approved.id);
    await insertPublicObject(db, prepared.object_path);
    const confirmed = await mediaConfirmPublic(db, approved.id, approved.sha256);
    return { approved, prepared, confirmed };
  }

  function contentWithMedia(label, ref) {
    const copy = contentWith(label);
    copy.hero.image = ref;
    return copy;
  }

  async function state(db) {
    return (await db.query(
      'select version, content, purge_state, public_check_state, public_check_observed_version from public.site_content where id = 1',
    )).rows[0];
  }

  async function count(db, table) {
    return (await db.query(`select count(*)::int as n from public.${table}`)).rows[0].n;
  }

  async function draftRow(db) {
    return (await db.query('select revision_id, content, base_version from public.draft where id = 1')).rows[0] || null;
  }

  async function historyRows(db) {
    return (await db.query(
      'select id, version, content, note from public.content_history order by version desc, id desc',
    )).rows;
  }

  test('الزائر وغير المدير لا يستطيعان تنفيذ العمليات الإدارية', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const sql = 'select public.admin_save_draft(1, $1::uuid, $2::jsonb) as result';
    const params = [null, JSON.stringify(defaultContent)];

    await assert.rejects(
      asVisitor(db, () => db.query(sql, params)),
      /permission denied/,
    );
    await assert.rejects(
      asUser(db, () => db.query(sql, params)),
      /admin only/,
    );

    const saved = await saveDraft(db, 1, null, contentWith('admin-can-save'));
    assert.ok(saved.revision_id);
  });

  test('المستخدم لا يستطيع منح نفسه صلاحية مدير', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(
      asUser(db, () => db.query(
        "insert into public.admin_users (user_id, role) values ($1, 'admin')",
        [USER_ID],
      )),
      /permission denied/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        "update public.admin_users set role = 'admin' where user_id = $1",
        [USER_ID],
      )),
      /permission denied/,
    );

    const result = await asUser(db, () => db.query('select public.is_admin() as result'));
    assert.equal(result.rows[0].result, false);
    assert.equal(await count(db, 'admin_users'), 1);
  });

  test('الجمهور لا يرى المسودة ولا السجل ولا بيانات الإدارة', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await saveDraft(db, 1, null, contentWith('draft-secret'));

    const publicRows = await asVisitor(db, () => db.query('select * from public.published_content'));
    assert.equal(publicRows.rows.length, 1);
    assert.deepEqual(Object.keys(publicRows.rows[0]).sort(), ['content', 'saved_at', 'version']);
    assert.equal(publicRows.rows[0].content.hero.big, defaultContent.hero.big);
    assert.doesNotMatch(JSON.stringify(publicRows.rows[0]), /draft-secret/);

    const columns = await db.query(`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'published_content'
      order by ordinal_position
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), ['version', 'content', 'saved_at']);

    for (const table of [
      'site_content', 'draft', 'content_history', 'admin_users',
      'content_operations', 'verification_checks',
    ]) {
      await assert.rejects(
        asVisitor(db, () => db.query(`select * from public.${table}`)),
        /permission denied/,
        `anon must not read ${table}`,
      );
    }

    for (const table of [
      'site_content', 'draft', 'content_history',
      'content_operations', 'verification_checks',
    ]) {
      const rows = await asUser(db, () => db.query(`select * from public.${table}`));
      assert.equal(rows.rows.length, 0, `non-admin must not read ${table}`);
    }

    const ownAdminRows = await asUser(db, () => db.query('select * from public.admin_users'));
    assert.equal(ownAdminRows.rows.length, 0);
  });

  test('الكتابة المباشرة التي تتجاوز RPC مرفوضة', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const writes = [
      ['update public.site_content set version = 99 where id = 1', []],
      ["insert into public.draft (id, content, base_version) values (1, '{}'::jsonb, 1)", []],
      ['delete from public.content_history', []],
      ["update public.admin_users set role = 'admin'", []],
      [`insert into public.content_operations (operation_id, actor_id, kind, result)
        values (gen_random_uuid(), '${ADMIN_ID}', 'publish', '{}'::jsonb)`, []],
    ];

    for (const [sql, params] of writes) {
      await assert.rejects(
        asAdmin(db, () => db.query(sql, params)),
        /permission denied/,
        sql,
      );
    }

    const current = await state(db);
    assert.equal(current.version, 1);
    assert.equal(await count(db, 'content_history'), 1);
    assert.equal(await count(db, 'admin_users'), 1);
  });

  test('تعارض الحفظ والنشر لا يفقد التعديلات ولا يحذف مسودة أحدث', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const version = (await state(db)).version;
    const first = await saveDraft(db, version, null, contentWith('edit-A'));
    const second = await saveDraft(db, version, first.revision_id, contentWith('edit-B'));
    assert.notEqual(second.revision_id, first.revision_id);

    // A stale editor still holding edit-A's revision must be rejected.
    await assert.rejects(
      saveDraft(db, version, first.revision_id, contentWith('edit-lost')),
      /stale draft revision/,
    );

    let draft = await draftRow(db);
    assert.equal(draft.revision_id, second.revision_id);
    assert.equal(draft.content.hero.big, 'edit-B');

    const third = await saveDraft(db, version, second.revision_id, contentWith('edit-C'));
    assert.notEqual(third.revision_id, second.revision_id);

    // Publishing an older draft revision must not delete the newer draft.
    await assert.rejects(
      publish(db, version, second.revision_id, null, 'stale publish', randomUUID()),
      /stale draft revision/,
    );
    draft = await draftRow(db);
    assert.equal(draft.revision_id, third.revision_id);
    assert.equal((await state(db)).version, version);

    const published = await publish(db, version, third.revision_id, null, 'publish C', randomUUID());
    assert.equal(published.version, version + 1);
    assert.equal(published.source, 'draft');
    assert.equal((await state(db)).content.hero.big, 'edit-C');
    assert.equal(await draftRow(db), null);

    // A second publish based on the old version must fail, not overwrite C.
    await assert.rejects(
      publish(db, version, third.revision_id, null, 'late publish', randomUUID()),
      /stale published version/,
    );
    const current = await state(db);
    assert.equal(current.version, version + 1);
    assert.equal(current.content.hero.big, 'edit-C');
    assert.equal(await count(db, 'content_history'), 2);
  });

  test('مراجعة مسودة قديمة تبقى مرفوضة بعد الحذف وإعادة الإنشاء', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const version = (await state(db)).version;
    const first = await saveDraft(db, version, null, contentWith('old-draft'));
    const deleted = await deleteDraft(db, version, first.revision_id);
    assert.equal(deleted.deleted, true);

    const second = await saveDraft(db, version, null, contentWith('new-draft'));
    assert.notEqual(second.revision_id, first.revision_id);

    await assert.rejects(
      saveDraft(db, version, first.revision_id, contentWith('stale-save')),
      /stale draft revision/,
    );
    await assert.rejects(
      deleteDraft(db, version, first.revision_id),
      /stale draft revision/,
    );
    await assert.rejects(
      publish(db, version, first.revision_id, null, 'stale-publish', randomUUID()),
      /stale draft revision/,
    );

    const draft = await draftRow(db);
    assert.equal(draft.revision_id, second.revision_id);
    assert.equal(draft.content.hero.big, 'new-draft');
    assert.equal((await state(db)).version, version);
  });

  test('إعادة نفس طلب النشر لا تنشئ نسخة إضافية وإعادة استخدام المعرّف بطلب مختلف تُرفض', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const version = (await state(db)).version;
    const operationId = randomUUID();
    const first = await publish(db, version, null, contentWith('idempotent-A'), 'first', operationId);
    assert.equal(first.version, version + 1);
    assert.equal(await count(db, 'content_history'), 2);

    // Same operation ID + same request returns the original result.
    const retry = await publish(db, version, null, contentWith('idempotent-A'), 'first', operationId);
    assert.deepEqual(retry, first);

    // Same operation ID + different content/note must be rejected, not treated as a retry.
    await assert.rejects(
      publish(db, version, null, contentWith('idempotent-B'), 'different', operationId),
      /reused with different request parameters/,
    );

    const current = await state(db);
    assert.equal(current.version, version + 1);
    assert.equal(current.content.hero.big, 'idempotent-A');
    assert.equal(await count(db, 'content_history'), 2);

    const historyId = (await historyRows(db)).at(-1).id;
    await assert.rejects(
      restore(db, historyId, version + 1, 'wrong kind', operationId),
      /operation id belongs to another operation/,
    );
  });

  test('الاستعادة تنشئ إصدارًا جديدًا والسجل يحتفظ بآخر 50 نسخة', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    for (let i = 0; i < 52; i += 1) {
      const current = await state(db);
      const result = await publish(
        db,
        current.version,
        null,
        contentWith(`bulk-${i}`),
        `bulk ${i}`,
        randomUUID(),
      );
      assert.equal(result.version, current.version + 1);
    }

    let current = await state(db);
    assert.equal(current.version, 53);
    assert.equal(await count(db, 'content_history'), 50);
    assert.equal((await db.query('select min(version)::int as n from public.content_history')).rows[0].n, 4);
    assert.equal((await db.query('select max(version)::int as n from public.content_history')).rows[0].n, 53);

    const old = (await db.query(
      'select id, content from public.content_history where version = 4',
    )).rows[0];
    const restored = await restore(db, old.id, 53, 'restore old', randomUUID());
    assert.equal(restored.version, 54);

    current = await state(db);
    assert.equal(current.version, 54);
    assert.deepEqual(current.content, old.content);
    assert.equal(await count(db, 'content_history'), 50);
    assert.equal((await db.query('select min(version)::int as n from public.content_history')).rows[0].n, 5);
    assert.equal((await db.query('select max(version)::int as n from public.content_history')).rows[0].n, 54);
    assert.equal((await db.query(
      'select count(*)::int as n from public.content_history where version = 54',
    )).rows[0].n, 1);
  });

  test('فشل المعاملة لا يترك تغييرات جزئية', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const before = await state(db);
    const historyBefore = await count(db, 'content_history');
    const operationsBefore = await count(db, 'content_operations');

    await db.exec(`
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

    await assert.rejects(
      publish(db, 1, null, contentWith('rollback-content'), 'force-rollback', randomUUID()),
      /forced history failure/,
    );

    const after = await state(db);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.content, before.content);
    assert.equal(await count(db, 'content_history'), historyBefore);
    assert.equal(await count(db, 'content_operations'), operationsBefore);

    await db.exec(`
      drop trigger test_force_failure on public.content_history;
      drop function public.test_force_failure();
    `);

    const ok = await publish(db, 1, null, contentWith('after-rollback'), 'ok', randomUUID());
    assert.equal(ok.version, 2);
  });

  test('حالة الإبطال وفحص الصفحة منفصلان ولا تسبق نتيجة قديمة نتيجة أحدث', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const beginPurge = await rpc(
      db,
      'select public.admin_begin_purge(1, $1::uuid) as result',
      [randomUUID()],
    );
    assert.equal(beginPurge.purge_state, 'requested');

    const accepted = await rpc(
      db,
      'select public.admin_record_purge(1, $1::text, $2::text) as result',
      ['accepted', null],
    );
    assert.equal(accepted.applied, true);
    assert.equal((await state(db)).version, 1, 'purge acceptance must not create/claim a live version');
    assert.equal((await state(db)).purge_state, 'accepted');

    const published2 = await publish(db, 1, null, contentWith('version-2'), 'v2', randomUUID());
    assert.equal(published2.version, 2);
    assert.equal((await state(db)).purge_state, 'pending');

    const latePurge = await rpc(
      db,
      'select public.admin_record_purge(1, $1::text, $2::text) as result',
      ['failed', 'late callback'],
    );
    assert.equal(latePurge.applied, false);
    assert.equal(latePurge.reason, 'stale_version');
    assert.equal((await state(db)).purge_state, 'pending');

    const check1 = await rpc(
      db,
      'select public.admin_begin_public_check(2) as result',
    );
    const check2 = await rpc(
      db,
      'select public.admin_begin_public_check(2) as result',
    );

    const older = await rpc(
      db,
      'select public.admin_finish_public_check($1::bigint, $2::text, $3::bigint, $4::text) as result',
      [check1, 'matched', 2, null],
    );
    assert.equal(older, false, 'older in-flight check must not overwrite newer attempt');

    const newer = await rpc(
      db,
      'select public.admin_finish_public_check($1::bigint, $2::text, $3::bigint, $4::text) as result',
      [check2, 'matched', 2, null],
    );
    assert.equal(newer, true);
    let current = await state(db);
    assert.equal(current.public_check_state, 'matched');
    assert.equal(Number(current.public_check_observed_version), 2);

    const check3 = await rpc(
      db,
      'select public.admin_begin_public_check(2) as result',
    );
    const published4 = await publish(db, 2, null, contentWith('version-3'), 'v3', randomUUID());
    assert.equal(published4.version, 3);
    const published5 = await publish(db, 3, null, contentWith('version-4'), 'v4', randomUUID());
    assert.equal(published5.version, 4);

    const staleVersion = await rpc(
      db,
      'select public.admin_finish_public_check($1::bigint, $2::text, $3::bigint, $4::text) as result',
      [check3, 'matched', 2, null],
    );
    assert.equal(staleVersion, false);

    current = await state(db);
    assert.equal(current.version, 4);
    assert.equal(current.public_check_state, 'pending');
    assert.equal(current.public_check_observed_version, null);
  });

  test('pending media is created only by admins and never selectable', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await assert.rejects(
      asVisitor(db, () => db.query(
        "select public.admin_media_create('x.png', 'image/png', 100) as result",
      )),
      /permission denied/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        "select public.admin_media_create('x.png', 'image/png', 100) as result",
      )),
      /admin only/,
    );

    const created = await mediaCreate(db, '  photo.png  ', 'image/webp', 2048);
    assert.equal(created.status, 'pending');
    assert.match(created.logical_path, /^media\/[0-9a-f-]{36}$/);
    assert.equal(created.storage_path, created.logical_path);
    assert.equal(created.bucket, 'ccafe-media');
    assert.equal(created.max_bytes, 15728640);

    const rows = await asAdmin(db, () => db.query(
      'select status, declared_mime, declared_bytes, created_by from public.media_assets where id = $1',
      [created.id],
    ));
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].status, 'pending');
    assert.equal(rows.rows[0].declared_mime, 'image/webp');
    assert.equal(rows.rows[0].declared_bytes, 2048);
    assert.equal(rows.rows[0].created_by, ADMIN_ID);

    for (const [name, mime, bytes] of [
      ['', 'image/png', 100],
      ['x.png', 'image/svg+xml', 100],
      ['x.png', 'image/gif', 100],
      ['x.png', 'image/png', 0],
      ['x.png', 'image/png', 15728641],
    ]) {
      await assert.rejects(
        mediaCreate(db, name, mime, bytes),
        /invalid|not allowed/,
        `${name}/${mime}/${bytes}`,
      );
    }
    assert.equal(await count(db, 'media_assets'), 1);
  });

  test('finalize requires the raw server secret, existing bytes, and is retry-safe', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await mediaCreate(db, 'photo.png', MEDIA_MIME, MEDIA_BYTES);
    await insertObject(db, created.storage_path);

    // The server token must match even before the claim check.
    await assert.rejects(
      mediaFinalize(db, created.id, '0'.repeat(64), MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /finalize token is invalid/,
    );
    // Audit regression: the stored SHA-256 fingerprint is not itself a credential.
    // Presenting media_secrets.value_sha256 must be rejected just like any other
    // wrong token, because the RPC hashes its input before comparing.
    await assert.rejects(
      mediaFinalize(db, created.id, FINALIZE_HASH, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /finalize token is invalid/,
    );
    // Knowing the token is not enough: the row must be claimed first, which the
    // Netlify Function does before reading bytes.
    await assert.rejects(
      mediaFinalize(db, created.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /not claimed for verification/,
    );

    // Visitor and non-admin cannot acquire the claim.
    await assert.rejects(
      asVisitor(db, () => db.query(
        'select public.admin_media_begin_finalize($1::uuid) as result', [created.id],
      )),
      /permission denied/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        'select public.admin_media_begin_finalize($1::uuid) as result', [created.id],
      )),
      /admin only/,
    );

    // The claim is idempotent for retries of the same upload.
    const claim = await mediaBegin(db, created.id);
    assert.equal(claim.claimed, true);
    assert.equal(claim.already_claimed, false);
    assert.ok(claim.verification_started_at);
    const claimAgain = await mediaBegin(db, created.id);
    assert.equal(claimAgain.already_claimed, true);
    assert.equal(claimAgain.verification_started_at, claim.verification_started_at);

    // Missing object: a claimed row with no uploaded bytes cannot be approved.
    const missing = await mediaCreate(db, 'missing.png', MEDIA_MIME, MEDIA_BYTES);
    await mediaBegin(db, missing.id);
    await assert.rejects(
      mediaFinalize(db, missing.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /uploaded object is missing/,
    );

    // Pixel count must match the dimensions and stay within the cap.
    await assert.rejects(
      mediaFinalize(db, created.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 5, MEDIA_SHA),
      /pixel count is not allowed/,
    );
    await assert.rejects(
      mediaFinalize(db, created.id, FINALIZE_TOKEN, 'image/svg+xml', MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /not allowed/,
    );

    const approved = await mediaFinalize(
      db, created.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA,
    );
    assert.equal(approved.status, 'approved');
    assert.equal(approved.idempotent, false);
    assert.equal(approved.bytes, MEDIA_BYTES);
    assert.equal(approved.width, 2);
    assert.equal(approved.sha256, MEDIA_SHA);

    const row = (await db.query(
      'select status, finalized_at, verified_by from public.media_assets where id = $1',
      [created.id],
    )).rows[0];
    assert.equal(row.status, 'approved');
    assert.equal(row.verified_by, ADMIN_ID);

    // Retry: same result, same timestamp, no second row or new history.
    const retry = await mediaFinalize(
      db, created.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA,
    );
    assert.equal(retry.idempotent, true);
    assert.equal(retry.finalized_at, approved.finalized_at);
    assert.equal(await count(db, 'media_assets'), 2);

    // Different bytes after approval are a conflict, not a silent overwrite.
    await assert.rejects(
      mediaFinalize(db, created.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES + 1, 2, 2, 4, MEDIA_SHA),
      /already verified with different bytes/,
    );
    const after = (await db.query(
      'select bytes, status from public.media_assets where id = $1',
      [created.id],
    )).rows[0];
    assert.equal(after.bytes, MEDIA_BYTES);
    assert.equal(after.status, 'approved');
  });

  test('failed and abandoned uploads stay failed, idempotently, and approved cannot fail', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await mediaCreate(db, 'a.png', MEDIA_MIME, MEDIA_BYTES);
    const failed = await mediaFail(db, first.id, 'decode_failed');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure_reason, 'decode_failed');
    assert.equal(failed.idempotent, false);

    const again = await mediaFail(db, first.id, 'other');
    assert.equal(again.idempotent, true);
    assert.equal(again.failure_reason, 'decode_failed');

    await insertObject(db, first.storage_path);
    await assert.rejects(
      mediaFinalize(db, first.id, FINALIZE_TOKEN, MEDIA_MIME, MEDIA_BYTES, 2, 2, 4, MEDIA_SHA),
      /not pending/,
    );

    const second = await createApprovedAsset(db);
    await assert.rejects(mediaFail(db, second.id, 'abandoned'), /approved media cannot be marked failed/);
  });

  test('media rows are readable only by admins and only through approved/own RLS', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const pending = await mediaCreate(db, 'pending.png', MEDIA_MIME, MEDIA_BYTES);

    await assert.rejects(
      asVisitor(db, () => db.query('select * from public.media_assets')),
      /permission denied/,
    );
    const asUserRows = await asUser(db, () => db.query('select * from public.media_assets'));
    assert.equal(asUserRows.rows.length, 0);

    const adminRows = await asAdmin(db, () => db.query('select id, status from public.media_assets order by created_at'));
    assert.equal(adminRows.rows.length, 2);
    assert.equal(adminRows.rows[0].id, approved.id);
    assert.equal(adminRows.rows[1].id, pending.id);

    await assert.rejects(
      asAdmin(db, () => db.query('select * from public.media_secrets')),
      /permission denied/,
    );
    await assert.rejects(
      asVisitor(db, () => db.query('select * from public.media_secrets')),
      /permission denied/,
    );

    // No API role can write metadata directly; only the SECURITY DEFINER RPCs.
    for (const sql of [
      "insert into public.media_assets (storage_path, logical_path, original_name, declared_mime, declared_bytes) values ('media/x', 'media/x', 'x', 'image/png', 1)",
      "update public.media_assets set status = 'approved'",
      'delete from public.media_assets',
    ]) {
      await assert.rejects(asAdmin(db, () => db.query(sql)), /permission denied/, sql);
    }
  });

  test('Storage policies allow only the creator pending path and block approved overwrite', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await mediaCreate(db, 'upload.png', MEDIA_MIME, MEDIA_BYTES);
    const path = created.storage_path;

    // Non-admin and visitor cannot upload at all.
    await assert.rejects(
      asUser(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [path],
      )),
      /row-level security/,
    );
    await assert.rejects(
      asVisitor(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [path],
      )),
      /permission denied/,
    );

    // Any path other than the server-generated pending path is denied.
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', 'media/00000000-0000-4000-8000-000000000000')",
      )),
      /row-level security/,
    );

    // Exact pending path succeeds, once. No overwrite.
    const inserted = await asAdmin(db, () => db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1) returning name", [path],
    ));
    assert.equal(inserted.rows[0].name, path);
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [path],
      )),
      /duplicate key|unique/,
    );

    // Reading objects is admin-only.
    const userRead = await asUser(db, () => db.query('select * from storage.objects'));
    assert.equal(userRead.rows.length, 0);
    await assert.rejects(
      asVisitor(db, () => db.query('select * from storage.objects')),
      /permission denied/,
    );
    const adminRead = await asAdmin(db, () => db.query('select name from storage.objects'));
    assert.equal(adminRead.rows.length, 1);

    // Creator can clean up a pending object, but not an approved one.
    const pendingDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1", [path],
    ));
    assert.equal(pendingDelete.affectedRows ?? pendingDelete.rowCount, 1);

    const approved = await createApprovedAsset(db);
    const approvedDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1", [approved.logical_path],
    ));
    assert.equal(approvedDelete.affectedRows ?? approvedDelete.rowCount, 0);
    const stillThere = await db.query(
      "select 1 from storage.objects where bucket_id = 'ccafe-media' and name = $1", [approved.logical_path],
    );
    assert.equal(stillThere.rows.length, 1);
  });

  test('verification claim freezes the object against delete and re-upload', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const created = await mediaCreate(db, 'frozen.png', MEDIA_MIME, MEDIA_BYTES);
    const path = created.storage_path;
    await asAdmin(db, () => db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [path],
    ));

    const claim = await mediaBegin(db, created.id);
    assert.equal(claim.claimed, true);

    // While verification is running, the creator cannot remove the bytes.
    const blockedDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1", [path],
    ));
    assert.equal(blockedDelete.affectedRows ?? blockedDelete.rowCount, 0);
    const stillThere = await db.query(
      "select 1 from storage.objects where bucket_id = 'ccafe-media' and name = $1", [path],
    );
    assert.equal(stillThere.rows.length, 1);

    // Nor can they insert over the frozen path.
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)", [path],
      )),
      /row-level security/,
    );

    // A failed verification clears the claim so cleanup remains possible.
    await mediaFail(db, created.id, 'decode_failed');
    const cleanup = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1", [path],
    ));
    assert.equal(cleanup.affectedRows ?? cleanup.rowCount, 1);
  });

  test('drafts accept approved uploads but reject pending, failed, or forged media refs', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const version = (await state(db)).version;

    const saved = await saveDraft(db, version, null, contentWithMedia('approved-media', approved.logical_path));
    assert.ok(saved.revision_id);

    const pending = await mediaCreate(db, 'pending.png', MEDIA_MIME, MEDIA_BYTES);
    await assert.rejects(
      saveDraft(db, version, saved.revision_id, contentWithMedia('pending-media', pending.logical_path)),
      /approved media asset/,
    );

    const failedAsset = await mediaCreate(db, 'failed.png', MEDIA_MIME, MEDIA_BYTES);
    await mediaFail(db, failedAsset.id, 'abandoned');
    await assert.rejects(
      saveDraft(db, version, saved.revision_id, contentWithMedia('failed-media', failedAsset.logical_path)),
      /approved media asset/,
    );

    await assert.rejects(
      saveDraft(db, version, saved.revision_id, contentWithMedia('forged-media', `media/${randomUUID()}`)),
      /approved media asset/,
    );

    const draft = await draftRow(db);
    assert.equal(draft.revision_id, saved.revision_id);
    assert.equal(draft.content.hero.image, approved.logical_path);
  });

  test('publish requires a ready public copy for every uploaded asset', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const version = (await state(db)).version;
    const beforeHistory = await count(db, 'content_history');

    const draft = await saveDraft(db, version, null, contentWithMedia('unprepared-publish', approved.logical_path));

    // Preflight reports the missing copy but changes nothing.
    const begin = await mediaPublishBegin(db, version, draft.revision_id, 'unprepared', randomUUID());
    assert.equal(begin.state, 'needs_prepare');
    assert.deepEqual(begin.needs_prepare, [approved.logical_path]);
    assert.equal(begin.assets.length, 1);
    assert.equal(begin.assets[0].public_state, 'none');
    assert.equal(begin.assets[0].object_path, null);

    // Direct admin_publish cannot bypass preparation.
    await assert.rejects(
      publish(db, version, draft.revision_id, null, 'unprepared', randomUUID()),
      /not ready for publication/,
    );
    assert.equal((await state(db)).version, version);
    assert.equal(await count(db, 'content_history'), beforeHistory);
    assert.notEqual(await draftRow(db), null, 'rejected publish must keep the draft');

    // A ready but still unlinked copy satisfies preflight; publishing links it.
    const prepared = await mediaPreparePublic(db, approved.id);
    assert.equal(prepared.state, 'staging');
    assert.match(prepared.object_path, /^published\/[0-9a-f-]{36}\/[0-9a-f]{64}$/);
    await insertPublicObject(db, prepared.object_path);
    await mediaConfirmPublic(db, approved.id, approved.sha256);

    const ready = await mediaPublishBegin(db, version, draft.revision_id, 'ready', randomUUID());
    assert.equal(ready.state, 'ready');
    assert.deepEqual(ready.needs_prepare, []);
    assert.equal(ready.assets[0].public_state, 'ready');

    const published = await publish(db, version, draft.revision_id, null, 'ready', randomUUID());
    assert.equal(published.version, version + 1);
    assert.equal((await state(db)).content.hero.image, approved.logical_path);
    assert.equal(await count(db, 'content_history'), beforeHistory + 1);

    const link = (await db.query(
      'select linked_version from public.media_public_assets where asset_id = $1',
      [approved.id],
    )).rows[0];
    assert.equal(link.linked_version, version + 1);

    // Original bundled assets remain publishable after a media publish.
    const after = await state(db);
    const clean = await saveDraft(db, after.version, null, contentWith('original-publish'));
    const original = await publish(db, after.version, clean.revision_id, null, 'original', randomUUID());
    assert.equal(original.version, after.version + 1);
    assert.equal((await state(db)).content.hero.image, defaultContent.hero.image);
  });

  test('public copies require the server secret and stay unreadable until linked', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);

    // The stored digest is not accepted by any public-copy RPC either.
    await assert.rejects(
      mediaPreparePublic(db, approved.id, FINALIZE_HASH),
      /finalize token is invalid/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        'select public.admin_media_prepare_public($1::uuid, $2::text) as result',
        [approved.id, FINALIZE_TOKEN],
      )),
      /admin only/,
    );

    const prepared = await mediaPreparePublic(db, approved.id);
    assert.equal(prepared.state, 'staging');

    // Retrying the staging step keeps the same immutable object name.
    const again = await mediaPreparePublic(db, approved.id);
    assert.equal(again.object_path, prepared.object_path);
    assert.equal(again.state, 'staging');

    // Confirmation requires the object to exist and the digest to match.
    await assert.rejects(
      mediaConfirmPublic(db, approved.id, approved.sha256),
      /public object is missing/,
    );
    await insertPublicObject(db, prepared.object_path);
    await assert.rejects(
      mediaConfirmPublic(db, approved.id, 'f'.repeat(64)),
      /does not match/,
    );

    const confirmed = await mediaConfirmPublic(db, approved.id, approved.sha256);
    assert.equal(confirmed.state, 'ready');
    assert.equal(confirmed.linked_version, null);
    const repeated = await mediaConfirmPublic(db, approved.id, approved.sha256);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.object_path, prepared.object_path);

    // Ready-but-unlinked: the admin sees it, an anonymous visitor does not.
    const adminRows = await asAdmin(db, () => db.query(
      'select state, linked_version from public.media_public_assets',
    ));
    assert.equal(adminRows.rows.length, 1);
    assert.equal(adminRows.rows[0].state, 'ready');
    assert.equal(adminRows.rows[0].linked_version, null);
    const anonRows = await asVisitor(db, () => db.query('select * from public.media_public_assets'));
    assert.equal(anonRows.rows.length, 0);

    // No API role can write the table directly; only the RPCs.
    for (const sql of [
      "insert into public.media_public_assets (asset_id, object_path, state, mime, bytes, width, height, pixel_count, sha256) values ($1, 'published/x/y', 'ready', 'image/png', 1, 1, 1, 1, $2)",
      "update public.media_public_assets set state = 'ready'",
      'delete from public.media_public_assets',
    ]) {
      await assert.rejects(
        asAdmin(db, () => db.query(sql, sql.includes('$1') ? [approved.id, MEDIA_SHA] : [])),
        /permission denied/,
        sql,
      );
    }
  });

  test('failed public preparation keeps the published version and draft, and retries recover', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const version = (await state(db)).version;
    const draft = await saveDraft(db, version, null, contentWithMedia('failure', approved.logical_path));

    const prepared = await mediaPreparePublic(db, approved.id);
    assert.equal(prepared.state, 'staging');

    // Simulate the server failing to upload/verify the public bytes.
    const failed = await mediaFailPublic(db, approved.id, 'upload_failed');
    assert.equal(failed.state, 'failed');
    assert.equal((await state(db)).version, version);
    assert.equal((await draftRow(db)).revision_id, draft.revision_id);

    // Direct publish is still refused; live version and draft are untouched.
    await assert.rejects(
      publish(db, version, draft.revision_id, null, 'failure', randomUUID()),
      /not ready for publication/,
    );
    assert.equal((await state(db)).version, version);
    assert.equal((await draftRow(db)).revision_id, draft.revision_id);

    // A retry allocates a fresh immutable capability instead of overwriting.
    const retry = await mediaPreparePublic(db, approved.id);
    assert.equal(retry.state, 'staging');
    assert.notEqual(retry.object_path, prepared.object_path);
    await insertPublicObject(db, retry.object_path);
    await mediaConfirmPublic(db, approved.id, approved.sha256);

    const published = await publish(db, version, draft.revision_id, null, 'failure', randomUUID());
    assert.equal(published.version, version + 1);
    assert.equal((await state(db)).content.hero.image, approved.logical_path);
  });

  test('publish preflight retry returns the prior result without another version or copy', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const { approved } = await createReadyPublicAsset(db);
    const version = (await state(db)).version;
    const draft = await saveDraft(db, version, null, contentWithMedia('idempotent', approved.logical_path));
    const operationId = randomUUID();

    const begin = await mediaPublishBegin(db, version, draft.revision_id, 'retry', operationId);
    assert.equal(begin.state, 'ready');
    const published = await publish(db, version, draft.revision_id, null, 'retry', operationId);
    assert.equal(published.version, version + 1);

    const copiesBefore = await count(db, 'media_public_assets');
    const retryBegin = await mediaPublishBegin(db, version, draft.revision_id, 'retry', operationId);
    assert.equal(retryBegin.state, 'published');
    assert.equal(retryBegin.result.version, version + 1);
    assert.equal(retryBegin.result.operation_id, operationId);

    // Reusing the id with a different note is a conflict, not a silent repeat.
    await assert.rejects(
      mediaPublishBegin(db, version, draft.revision_id, 'different', operationId),
      /different request parameters/,
    );
    assert.equal((await state(db)).version, version + 1);
    assert.equal(await count(db, 'media_public_assets'), copiesBefore);
  });

  test('restoring an older version keeps every published image readable', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const first = await createReadyPublicAsset(db);
    const second = await createReadyPublicAsset(db);
    const v0 = (await state(db)).version;

    const draftA = await saveDraft(db, v0, null, contentWithMedia('first-image', first.approved.logical_path));
    const publishedA = await publish(db, v0, draftA.revision_id, null, 'first', randomUUID());
    const vA = publishedA.version;

    const draftB = await saveDraft(db, vA, null, contentWithMedia('second-image', second.approved.logical_path));
    const publishedB = await publish(db, vA, draftB.revision_id, null, 'second', randomUUID());
    const vB = publishedB.version;

    const historyA = (await db.query(
      'select id from public.content_history where version = $1', [vA],
    )).rows[0];
    const restored = await restore(db, historyA.id, vB, 'restore-first', randomUUID());
    assert.equal(restored.version, vB + 1);

    const current = await state(db);
    assert.equal(current.version, vB + 1);
    assert.equal(current.content.hero.image, first.approved.logical_path);

    // Both copies stay linked and anonymously readable; the removed image does
    // not become private again.
    const links = (await db.query(
      'select asset_id, linked_version from public.media_public_assets',
    )).rows;
    assert.equal(links.length, 2);
    for (const link of links) assert.notEqual(link.linked_version, null);
    const anonRows = await asVisitor(db, () => db.query('select asset_id from public.media_public_assets'));
    assert.equal(anonRows.rows.length, 2);

    // A linked copy cannot be failed even after it left the current content.
    await assert.rejects(
      mediaFailPublic(db, second.approved.id, 'cleanup'),
      /cannot be failed/,
    );
  });

  test('unused approved uploads move through a recoverable trash and back', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const before = await mediaUsage(db, approved.id);
    assert.equal(before.deletable, true);
    assert.deepEqual(before.reasons, []);

    const operationId = randomUUID();
    const begun = await mediaDeleteBegin(db, approved.id, operationId);
    assert.equal(begun.state, 'staging');
    assert.equal(begun.trash_state, 'staging');
    assert.match(begun.object_path, /^trash\/[0-9a-f-]{36}\/[0-9a-f]{64}$/);
    assert.equal(begun.sha256, approved.sha256);
    assert.equal(
      (await db.query('select status from public.media_assets where id = $1', [approved.id])).rows[0].status,
      'deleting',
    );

    // Once deletion starts the asset is not a valid content reference and can
    // never be staged for publication.
    const version = (await state(db)).version;
    await assert.rejects(
      saveDraft(db, version, null, contentWithMedia('deleting', approved.logical_path)),
      /approved media asset/,
    );
    await assert.rejects(mediaPreparePublic(db, approved.id), /not approved/);
    await assert.rejects(mediaConfirmPublic(db, approved.id, approved.sha256), /not approved/);

    // The original private bytes cannot be removed before the trash copy is
    // committed; the legacy cleanup policy only covers pending/failed uploads.
    const earlyDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1",
      [approved.storage_path],
    ));
    assert.equal(earlyDelete.affectedRows ?? earlyDelete.rowCount, 0);

    // Commit requires the staged trash object and the same operation id.
    await assert.rejects(
      mediaDeleteFinish(db, approved.id, operationId, approved.sha256),
      /trash object is missing/,
    );
    await assert.rejects(
      mediaDeleteFinish(db, approved.id, randomUUID(), approved.sha256),
      /operation does not match/,
    );
    await assert.rejects(
      mediaDeleteFinish(db, approved.id, operationId, 'b'.repeat(64)),
      /digest does not match/,
    );

    await insertTrashObject(db, begun.object_path);
    const finished = await mediaDeleteFinish(db, approved.id, operationId, approved.sha256);
    assert.equal(finished.state, 'trashed');
    assert.equal(finished.sha256, approved.sha256);
    assert.equal(
      (await db.query('select status from public.media_assets where id = $1', [approved.id])).rows[0].status,
      'trashed',
    );

    // The active library is blocked and the usage report explains why.
    const blockedUsage = await mediaUsage(db, approved.id);
    assert.equal(blockedUsage.deletable, false);
    assert.ok(blockedUsage.reasons.includes('not_approved'));
    await assert.rejects(
      saveDraft(db, version, null, contentWithMedia('trashed', approved.logical_path)),
      /approved media asset/,
    );
    await assert.rejects(mediaPreparePublic(db, approved.id), /not approved/);

    // The trash list hides the random object name.
    const listed = await mediaTrashList(db);
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].asset_id, approved.id);
    assert.equal(listed.items[0].object_path, undefined);
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(begun.object_path.split('/')[2]));

    // Retries are idempotent and a different operation cannot take over.
    const repeatedBegin = await mediaDeleteBegin(db, approved.id, operationId);
    assert.equal(repeatedBegin.idempotent, true);
    assert.equal(repeatedBegin.state, 'trashed');
    const repeatedFinish = await mediaDeleteFinish(db, approved.id, operationId, approved.sha256);
    assert.equal(repeatedFinish.idempotent, true);
    await assert.rejects(
      mediaDeleteBegin(db, approved.id, randomUUID()),
      /already trashed/,
    );

    // Best-effort cleanup: a failure keeps both copies and stays retryable.
    const cleanupFailed = await mediaDeleteCleanup(db, approved.id, operationId, false, 'timeout');
    assert.equal(cleanupFailed.cleanup_state, 'pending');
    assert.match(cleanupFailed.cleanup_error, /timeout/);
    assert.equal(
      (await db.query(
        "select 1 from storage.objects where bucket_id = 'ccafe-trash' and name = $1",
        [begun.object_path],
      )).rows.length,
      1,
    );

    const cleanupDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1",
      [approved.storage_path],
    ));
    assert.equal(cleanupDelete.affectedRows ?? cleanupDelete.rowCount, 1);
    const cleanupDone = await mediaDeleteCleanup(db, approved.id, operationId, true, null);
    assert.equal(cleanupDone.cleanup_state, 'done');
    const cleanupRetry = await mediaDeleteCleanup(db, approved.id, null, true, null);
    assert.equal(cleanupRetry.cleanup_state, 'done');

    // The trash copy is readable by the server for a restore.
    const visibleTrash = await asAdmin(db, () => db.query(
      "select name from storage.objects where bucket_id = 'ccafe-trash' and name = $1",
      [begun.object_path],
    ));
    assert.equal(visibleTrash.rows.length, 1);

    const restoreOperation = randomUUID();
    const restoring = await mediaRestoreBegin(db, approved.id, restoreOperation);
    assert.equal(restoring.state, 'restoring');
    assert.equal(restoring.trash_object_path, begun.object_path);
    assert.equal(restoring.sha256, approved.sha256);
    await assert.rejects(
      mediaDeleteBegin(db, approved.id, randomUUID()),
      /being restored/,
    );
    await assert.rejects(mediaPreparePublic(db, approved.id), /not approved/);
    await assert.rejects(
      mediaRestoreFinish(db, approved.id, restoreOperation),
      /private object is missing/,
    );

    await insertObject(db, approved.storage_path);
    const restored = await mediaRestoreFinish(db, approved.id, restoreOperation);
    assert.equal(restored.state, 'approved');
    assert.equal(restored.sha256, approved.sha256);
    assert.equal((await mediaTrashList(db)).items.length, 0);

    // The bytes are usable again and the asset is deletable once more.
    assert.equal((await mediaUsage(db, approved.id)).deletable, true);
    const saved = await saveDraft(db, version, null, contentWithMedia('restored', approved.logical_path));
    assert.ok(saved.revision_id);

    const restoreRetry = await mediaRestoreBegin(db, approved.id, restoreOperation);
    assert.equal(restoreRetry.idempotent, true);
    const restoreFinishRetry = await mediaRestoreFinish(db, approved.id, restoreOperation);
    assert.equal(restoreFinishRetry.idempotent, true);

    // The trash copy is retained; restoring never permanently removes it.
    assert.equal(
      (await db.query(
        "select 1 from storage.objects where bucket_id = 'ccafe-trash' and name = $1",
        [begun.object_path],
      )).rows.length,
      1,
    );
  });

  test('deletion is refused while published, draft, or history reference the asset', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    // Published content plus its linked ready public copy.
    const published = await createReadyPublicAsset(db);
    const v0 = (await state(db)).version;
    const draft = await saveDraft(db, v0, null, contentWithMedia('published', published.approved.logical_path));
    await publish(db, v0, draft.revision_id, null, 'published', randomUUID());

    const publishedUsage = await mediaUsage(db, published.approved.id);
    assert.equal(publishedUsage.deletable, false);
    for (const reason of ['published', 'history']) {
      assert.ok(publishedUsage.reasons.includes(reason), `missing reason ${reason}`);
    }
    assert.equal(publishedUsage.reasons.includes('public_ready'), false);
    const publishedBlock = await mediaDeleteBegin(db, published.approved.id, randomUUID());
    assert.equal(publishedBlock.state, 'blocked');
    assert.ok(publishedBlock.reasons.includes('published'));
    assert.equal(publishedBlock.references.public_state, 'ready');
    assert.equal(
      (await db.query('select status from public.media_assets where id = $1', [published.approved.id])).rows[0].status,
      'approved',
    );

    // A draft reference alone blocks deletion.
    const draftOnly = await createApprovedAsset(db);
    const v1 = (await state(db)).version;
    const saved = await saveDraft(db, v1, null, contentWithMedia('draft-only', draftOnly.logical_path));
    const draftUsage = await mediaUsage(db, draftOnly.id);
    assert.equal(draftUsage.deletable, false);
    assert.ok(draftUsage.reasons.includes('draft'));
    assert.equal((await mediaDeleteBegin(db, draftOnly.id, randomUUID())).state, 'blocked');

    // Removing the draft reference makes it deletable; no draft row was deleted.
    const cleaned = await saveDraft(db, v1, saved.revision_id, contentWith('no-media'));
    assert.ok(cleaned.revision_id);
    assert.equal((await mediaUsage(db, draftOnly.id)).deletable, true);

    // A ready public copy that was never linked is not itself a content
    // reference. It is recorded for cleanup and removed with the asset.
    const unlinked = await createReadyPublicAsset(db);
    const unlinkedUsage = await mediaUsage(db, unlinked.approved.id);
    assert.equal(unlinkedUsage.deletable, true);
    assert.equal(unlinkedUsage.reasons.includes('public_ready'), false);
    assert.equal(unlinkedUsage.references.public_state, 'ready');
    const unlinkedOperation = randomUUID();
    const unlinkedBegun = await mediaDeleteBegin(db, unlinked.approved.id, unlinkedOperation);
    assert.equal(unlinkedBegun.state, 'staging');
    assert.equal(unlinkedBegun.public_object_path, unlinked.prepared.object_path);
    assert.equal(unlinkedBegun.public_cleanup_state, 'pending');
    assert.equal(
      (await db.query(
        'select state from public.media_public_assets where asset_id = $1',
        [unlinked.approved.id],
      )).rows[0].state,
      'ready',
      'a failed transfer must leave the ready public copy untouched',
    );
    await insertTrashObject(db, unlinkedBegun.object_path);
    const unlinkedFinished = await mediaDeleteFinish(
      db, unlinked.approved.id, unlinkedOperation, unlinked.approved.sha256,
    );
    assert.equal(unlinkedFinished.state, 'trashed');
    assert.equal(unlinkedFinished.public_cleanup_state, 'pending');
    assert.equal(
      (await db.query(
        'select state from public.media_public_assets where asset_id = $1',
        [unlinked.approved.id],
      )).rows[0].state,
      'failed',
      'the public capability is invalidated only at the delete commit point',
    );

    const targets = await mediaCleanupTargets(db, unlinked.approved.id);
    assert.equal(targets.public_object_path, unlinked.prepared.object_path);
    assert.equal(targets.public_cleanup_state, 'pending');
    const unlinkedCleanup = await mediaDeleteCleanup(
      db, unlinked.approved.id, unlinkedOperation, true, null, true, null,
    );
    assert.equal(unlinkedCleanup.cleanup_state, 'done');
    assert.equal(unlinkedCleanup.public_cleanup_state, 'done');
    assert.equal(unlinkedCleanup.public_cleanup_error, null);

    // A history-only reference keeps blocking after it leaves current content.
    const old = await createReadyPublicAsset(db);
    const v2 = (await state(db)).version;
    const draftOld = await saveDraft(db, v2, cleaned.revision_id, contentWithMedia('history-old', old.approved.logical_path));
    const publishedOld = await publish(db, v2, draftOld.revision_id, null, 'old', randomUUID());
    const draftNew = await saveDraft(db, publishedOld.version, null, contentWith('history-new'));
    await publish(db, publishedOld.version, draftNew.revision_id, null, 'new', randomUUID());

    const historyUsage = await mediaUsage(db, old.approved.id);
    assert.equal(historyUsage.deletable, false);
    assert.equal(historyUsage.references.published, false);
    assert.ok(historyUsage.references.history_count > 0);
    assert.ok(historyUsage.reasons.includes('history'));
    assert.equal((await mediaDeleteBegin(db, old.approved.id, randomUUID())).state, 'blocked');
  });

  test('public cleanup stays pending after failure and restore exposes it before clearing', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const ready = await createReadyPublicAsset(db);
    const operationId = randomUUID();
    const begun = await mediaDeleteBegin(db, ready.approved.id, operationId);
    await insertTrashObject(db, begun.object_path);
    await mediaDeleteFinish(db, ready.approved.id, operationId, ready.approved.sha256);

    // Private original removed, public object failed: both results are recorded
    // independently and neither is reported as a full success.
    const partial = await mediaDeleteCleanup(
      db,
      ready.approved.id,
      operationId,
      true,
      null,
      false,
      'public_object_delete_failed',
    );
    assert.equal(partial.cleanup_state, 'done');
    assert.equal(partial.public_cleanup_state, 'pending');
    assert.match(partial.public_cleanup_error, /public_object_delete_failed/);

    const targets = await mediaCleanupTargets(db, ready.approved.id);
    assert.equal(targets.public_object_path, ready.prepared.object_path);
    assert.equal(targets.public_cleanup_state, 'pending');

    // The successful private cleanup removed the original object; the failed
    // public cleanup left its object in place.
    await db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1",
      [ready.approved.storage_path],
    );

    // The restore path must receive the exact public name so the server can
    // remove it before the asset becomes approved again.
    const restoreOperation = randomUUID();
    const restoring = await mediaRestoreBegin(db, ready.approved.id, restoreOperation);
    assert.equal(restoring.state, 'restoring');
    assert.equal(restoring.public_object_path, ready.prepared.object_path);
    assert.equal(restoring.public_cleanup_pending, true);

    // The Netlify function deletes the pending public object before finish.
    await db.query(
      "delete from storage.objects where bucket_id = 'ccafe-public' and name = $1",
      [ready.prepared.object_path],
    );
    await insertObject(db, ready.approved.storage_path);
    const restored = await mediaRestoreFinish(db, ready.approved.id, restoreOperation);
    assert.equal(restored.state, 'approved');
    const trashRow = (await db.query(
      'select state, public_object_path, public_cleanup_state from public.media_trash where asset_id = $1',
      [ready.approved.id],
    )).rows[0];
    assert.deepEqual(trashRow, {
      state: 'restored',
      public_object_path: null,
      public_cleanup_state: 'done',
    });
    // The old public row stays failed; the next publish must allocate a fresh
    // capability instead of reusing the deleted name.
    assert.equal(
      (await db.query(
        'select state from public.media_public_assets where asset_id = $1',
        [ready.approved.id],
      )).rows[0].state,
      'failed',
    );
    const nextPrepare = await mediaPreparePublic(db, ready.approved.id);
    assert.equal(nextPrepare.state, 'staging');
    assert.notEqual(nextPrepare.object_path, ready.prepared.object_path);
  });

  test('public bucket admin read policy is limited to staging/failed copies', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const ready = await createReadyPublicAsset(db);
    const readyPath = ready.prepared.object_path;

    // A ready copy stays invisible to the admin SELECT policy; it is served only
    // through the public endpoint.
    const readyRows = await asAdmin(db, () => db.query(
      "select name from storage.objects where bucket_id = 'ccafe-public' and name = $1",
      [readyPath],
    ));
    assert.equal(readyRows.rows.length, 0);
    const userRows = await asUser(db, () => db.query(
      "select name from storage.objects where bucket_id = 'ccafe-public'",
    ));
    assert.equal(userRows.rows.length, 0);

    // delete_finish flips the public row to failed, which both the DELETE and
    // the SELECT policy accept. Supabase Storage performs DELETE ... RETURNING,
    // so a missing SELECT policy made the admin cleanup fail with AccessDenied
    // even when the DELETE policy allowed it.
    const operationId = randomUUID();
    const begun = await mediaDeleteBegin(db, ready.approved.id, operationId);
    await insertTrashObject(db, begun.object_path);
    await mediaDeleteFinish(db, ready.approved.id, operationId, ready.approved.sha256);
    assert.equal(
      (await db.query(
        'select state from public.media_public_assets where asset_id = $1',
        [ready.approved.id],
      )).rows[0].state,
      'failed',
    );

    const failedRows = await asAdmin(db, () => db.query(
      "select name from storage.objects where bucket_id = 'ccafe-public' and name = $1",
      [readyPath],
    ));
    assert.equal(failedRows.rows.length, 1);
    const failedDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-public' and name = $1",
      [readyPath],
    ));
    assert.equal(failedDelete.affectedRows ?? failedDelete.rowCount, 1);

    // Staging copies are readable and deletable so a failed upload can recover.
    const staging = await createApprovedAsset(db);
    const prepared = await mediaPreparePublic(db, staging.id);
    await insertPublicObject(db, prepared.object_path);
    const stagingRows = await asAdmin(db, () => db.query(
      "select name from storage.objects where bucket_id = 'ccafe-public' and name = $1",
      [prepared.object_path],
    ));
    assert.equal(stagingRows.rows.length, 1);
  });

  test('trash and restore require an admin, the exact server token, and matching operation ids', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const operationId = randomUUID();

    await assert.rejects(
      asVisitor(db, () => db.query(
        'select public.admin_media_delete_begin($1::uuid, $2::text, $3::uuid) as result',
        [approved.id, FINALIZE_TOKEN, operationId],
      )),
      /permission denied/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        'select public.admin_media_delete_begin($1::uuid, $2::text, $3::uuid) as result',
        [approved.id, FINALIZE_TOKEN, operationId],
      )),
      /admin only/,
    );
    await assert.rejects(
      mediaDeleteBegin(db, approved.id, operationId, 'wrong-token-0123456789abcdef'),
      /finalize token is invalid/,
    );
    await assert.rejects(
      asVisitor(db, () => db.query('select public.admin_media_usage($1::uuid) as result', [approved.id])),
      /permission denied/,
    );
    await assert.rejects(
      asVisitor(db, () => db.query('select public.admin_media_trash_list() as result')),
      /permission denied/,
    );

    const begun = await mediaDeleteBegin(db, approved.id, operationId);
    assert.equal(begun.state, 'staging');
    await assert.rejects(
      mediaDeleteBegin(db, approved.id, randomUUID()),
      /already in progress/,
    );
    await assert.rejects(
      mediaRestoreBegin(db, approved.id, randomUUID()),
      /not trashed/,
    );
    await insertTrashObject(db, begun.object_path);

    // An abort with the wrong operation id cannot release another delete.
    await assert.rejects(
      mediaDeleteAbort(db, approved.id, randomUUID(), 'wrong'),
      /cannot be aborted/,
    );
    const aborted = await mediaDeleteAbort(db, approved.id, operationId, 'storage_failed');
    assert.equal(aborted.state, 'approved');
    assert.equal(aborted.aborted, true);
    assert.equal(
      (await db.query('select status from public.media_assets where id = $1', [approved.id])).rows[0].status,
      'approved',
    );

    const abortRetry = await mediaDeleteAbort(db, approved.id, operationId, 'storage_failed');
    assert.equal(abortRetry.idempotent, true);
    await assert.rejects(
      mediaDeleteAbort(db, approved.id, randomUUID(), 'late'),
      /cannot be aborted/,
    );

    // A new operation allocates a fresh trash path and commits normally.
    const retryOperation = randomUUID();
    const second = await mediaDeleteBegin(db, approved.id, retryOperation);
    assert.equal(second.state, 'staging');
    assert.notEqual(second.object_path, begun.object_path);
    await insertTrashObject(db, second.object_path);
    await mediaDeleteFinish(db, approved.id, retryOperation, approved.sha256);

    await assert.rejects(
      mediaDeleteAbort(db, approved.id, retryOperation, 'late'),
      /already committed/,
    );
    await assert.rejects(
      mediaDeleteCleanup(db, approved.id, randomUUID(), true, null),
      /does not match/,
    );
    await assert.rejects(
      mediaRestoreFinish(db, approved.id, randomUUID()),
      /not in progress/,
    );
    await assert.rejects(
      mediaRestoreAbort(db, approved.id, randomUUID(), 'wrong'),
      /cannot be aborted/,
    );
  });

  test('trash storage policies allow only the exact allocated name and never delete', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const approved = await createApprovedAsset(db);
    const operationId = randomUUID();
    const begun = await mediaDeleteBegin(db, approved.id, operationId);

    // The exact allocated staging name is writable by an admin.
    await asAdmin(db, () => db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
      [begun.object_path],
    ));

    // Any other trash name is refused, and non-admins are refused entirely.
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
        [`trash/${approved.id}/${'d'.repeat(64)}`],
      )),
      /row-level security/,
    );
    await assert.rejects(
      asUser(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
        [begun.object_path],
      )),
      /row-level security/,
    );

    // No UPDATE policy: the name cannot be overwritten.
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-trash', $1)",
        [begun.object_path],
      )),
      /duplicate key|row-level security/,
    );

    await mediaDeleteFinish(db, approved.id, operationId, approved.sha256);

    // No DELETE policy: trash bytes are retained even for an admin.
    const trashDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-trash' and name = $1",
      [begun.object_path],
    ));
    assert.equal(trashDelete.affectedRows ?? trashDelete.rowCount, 0);

    // The original private object remains cleanable after the commit.
    const originalDelete = await asAdmin(db, () => db.query(
      "delete from storage.objects where bucket_id = 'ccafe-media' and name = $1",
      [approved.storage_path],
    ));
    assert.equal(originalDelete.affectedRows ?? originalDelete.rowCount, 1);

    // Restore can write back only the exact original private name.
    const restoreOperation = randomUUID();
    await mediaRestoreBegin(db, approved.id, restoreOperation);
    await assert.rejects(
      asAdmin(db, () => db.query(
        "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)",
        [`${approved.logical_path}-other`],
      )),
      /row-level security/,
    );
    await asAdmin(db, () => db.query(
      "insert into storage.objects (bucket_id, name) values ('ccafe-media', $1)",
      [approved.storage_path],
    ));
    const restored = await mediaRestoreFinish(db, approved.id, restoreOperation);
    assert.equal(restored.state, 'approved');

    // Restoring keeps the historical trash copy in place.
    assert.equal(
      (await db.query(
        "select 1 from storage.objects where bucket_id = 'ccafe-trash' and name = $1",
        [begun.object_path],
      )).rows.length,
      1,
    );
  });

  // -------------------------------------------------------------------------
  // Analytics
  // -------------------------------------------------------------------------

  const ANALYTICS_VISITOR = 'a'.repeat(16);
  const analyticsEvent = (overrides = {}) => ({
    e: 'pageview',
    s: 'session000000001',
    r: 'instagram.com',
    u: 'ig',
    device: 'desktop',
    browser: 'chrome',
    os: 'windows',
    ...overrides,
  });

  const analyticsIngest = (db, env, event, visitor = ANALYTICS_VISITOR, digest = ANALYTICS_SENT) =>
    asVisitor(db, async () => {
      const result = await db.query(
        'select public.analytics_ingest($1::text, $2::text, $3::jsonb, $4::text) as result',
        [digest, env, JSON.stringify(event), visitor],
      );
      return result.rows[0].result;
    });

  const analyticsSnapshot = (db, env, range) =>
    rpc(db, 'select public.admin_analytics_snapshot($1::text, $2::text) as result', [env, range]);

  test('تحليلات: الإدخال محمي ببصمة السر ويحفظ الحقول المنقّحة فقط', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const before = Date.now();
    assert.deepEqual(await analyticsIngest(db, 'preview', analyticsEvent()), { ok: true });

    const rows = (await db.query('select * from public.analytics_events')).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.env, 'preview');
    assert.equal(row.visitor, ANALYTICS_VISITOR);
    assert.equal(row.session, 'session000000001');
    assert.equal(row.type, 'pageview');
    assert.equal(row.referrer, 'instagram.com');
    assert.equal(row.utm, 'ig');
    assert.equal(row.device, 'desktop');
    assert.equal(row.browser, 'chrome');
    assert.equal(row.os, 'windows');
    // The database clock is authoritative, within a generous boundary.
    const at = new Date(row.occurred_at).getTime();
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000);

    // No IP, user agent, full URL, or arbitrary client fields exist.
    const columns = (
      await db.query(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'analytics_events'",
      )
    ).rows.map((item) => item.column_name);
    for (const forbidden of ['ip', 'user_agent', 'ua', 'url', 'password', 'token', 'extra']) {
      assert.equal(columns.includes(forbidden), false, forbidden);
    }

    // Environments are stored separately.
    assert.deepEqual(
      await analyticsIngest(db, 'production', analyticsEvent({ r: 'google.com', u: 'g' }), 'b'.repeat(16)),
      { ok: true },
    );
    assert.equal(
      (await db.query("select count(*)::int as n from public.analytics_events where env = 'production'")).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query("select count(*)::int as n from public.analytics_events where env = 'preview'")).rows[0].n,
      1,
    );
  });

  test('تحليلات: بصمة خاطئة أو حقول غير صالحة تُرفض قبل أي كتابة', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    const bad = [
      () => analyticsIngest(db, 'preview', analyticsEvent(), ANALYTICS_VISITOR, 'b'.repeat(64)),
      // Replaying the stored fingerprint, or the raw token, is rejected; only the
      // value the Function derives (D1) is accepted.
      () => analyticsIngest(db, 'preview', analyticsEvent(), ANALYTICS_VISITOR, ANALYTICS_HASH),
      () => analyticsIngest(db, 'preview', analyticsEvent(), ANALYTICS_VISITOR, ANALYTICS_TOKEN),
      () => analyticsIngest(db, 'preview', analyticsEvent(), ANALYTICS_VISITOR, 'short'),
      () => analyticsIngest(db, 'staging', analyticsEvent()),
      () => analyticsIngest(db, 'preview', analyticsEvent(), 'XYZ'),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), e: 'hack' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), s: '../../etc' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), r: 'https://evil.example/path?x=1' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), u: 'a b' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), device: 'hacked' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), browser: 'hacked' }),
      () => analyticsIngest(db, 'preview', { ...analyticsEvent(), os: 'hacked' }),
      () => analyticsIngest(db, 'preview', { e: 'section', s: 'session000000001', n: 'UPPER SPACE' }),
      () => analyticsIngest(db, 'preview', { e: 'mood', s: 'session000000001', n: '\u0000' }),
      () => analyticsIngest(db, 'preview', { e: 'click', s: 'session000000001', n: 'x'.repeat(81), k: 'call' }),
    ];
    for (const run of bad) await assert.rejects(run());
    assert.equal((await db.query('select count(*)::int as n from public.analytics_events')).rows[0].n, 0);

    // Valid boundary cases are clamped by the database.
    assert.deepEqual(
      await analyticsIngest(db, 'preview', { e: 'leave', s: 'session000000001', ms: 99999999, sc: 900 }),
      { ok: true },
    );
    const leave = (await db.query("select duration_ms, scroll from public.analytics_events where type = 'leave'")).rows[0];
    assert.equal(leave.duration_ms, 7200000);
    assert.equal(leave.scroll, 100);
  });

  test('تحليلات: البصمة المخزنة لا تُقبل كبديل عن السر، وقيمة الدالة وحدها تُقبل', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    // The stored value is D2. The Function sends D1. Replaying D2 must fail and
    // leave no event behind, proving a database leak cannot forge traffic.
    await assert.rejects(
      analyticsIngest(db, 'preview', analyticsEvent(), ANALYTICS_VISITOR, ANALYTICS_HASH),
      /forbidden/,
    );
    assert.equal((await db.query('select count(*)::int as n from public.analytics_events')).rows[0].n, 0);

    assert.deepEqual(await analyticsIngest(db, 'preview', analyticsEvent()), { ok: true });
    assert.equal((await db.query('select count(*)::int as n from public.analytics_events')).rows[0].n, 1);
  });

  test('تحليلات: الزائر وغير المدير لا يصلان إلى الجداول أو دوال الإدارة', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    for (const run of [
      () => asVisitor(db, () => db.query('select * from public.analytics_events')),
      () => asUser(db, () => db.query('select * from public.analytics_events')),
      () => asVisitor(db, () => db.query('select * from public.analytics_secrets')),
      () => asAdmin(db, () => db.query('select * from public.analytics_secrets')),
      () => asVisitor(db, () => db.query('select * from public.analytics_rate_limits')),
      () => asAdmin(db, () => db.query(
        "insert into public.analytics_events (env, day, occurred_at, visitor, session, type) values ('preview', current_date, now(), 'aaaaaaaaaaaaaaaa', 'session000000001', 'pageview')",
      )),
    ]) {
      await assert.rejects(run(), /permission denied/);
    }

    assert.deepEqual(await analyticsSnapshot(db, 'preview', '7d') && true, true);
    await assert.rejects(asUser(db, () => db.query("select public.admin_analytics_snapshot('preview', '7d')")), /admin only/);
    await assert.rejects(asVisitor(db, () => db.query("select public.admin_analytics_snapshot('preview', '7d')")), /permission denied/);
    await assert.rejects(asUser(db, () => db.query("select public.admin_analytics_clear('preview')")), /admin only/);
    await assert.rejects(asVisitor(db, () => db.query("select public.admin_analytics_clear('preview')")), /permission denied/);
  });

  test('تحليلات: اللقطة تعزل البيئة وتعيد أحداث الفترة والسابقة واللحظية', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await analyticsIngest(db, 'preview', analyticsEvent());
    await analyticsIngest(db, 'preview', { e: 'section', s: 'session000000001', n: 'menu' });
    await analyticsIngest(db, 'preview', { e: 'click', s: 'session000000001', n: 'اتصال', k: 'call' });
    await analyticsIngest(db, 'preview', { e: 'leave', s: 'session000000001', ms: 30000, sc: 20 });
    await analyticsIngest(db, 'production', analyticsEvent(), 'c'.repeat(16));

    const snapshot = await analyticsSnapshot(db, 'preview', '7d');
    assert.equal(snapshot.env, 'preview');
    assert.equal(snapshot.range, '7d');
    assert.equal(snapshot.current.length, 4);
    assert.ok(snapshot.current.every((event) => typeof event.t === 'number'));
    assert.ok(snapshot.current.every((event) => event.v === ANALYTICS_VISITOR));
    assert.equal(snapshot.previous.length, 0);
    assert.equal(snapshot.live.length, 4);
    assert.equal(snapshot.current.some((event) => event.e === 'click' && event.k === 'call'), true);

    const production = await analyticsSnapshot(db, 'production', '7d');
    assert.equal(production.current.length, 1);
    assert.equal(production.current[0].v, 'c'.repeat(16));

    await assert.rejects(analyticsSnapshot(db, 'staging', '7d'), /invalid environment/);
    await assert.rejects(analyticsSnapshot(db, 'preview', '1d'), /invalid range/);
  });

  test('تحليلات: المسح يخص بيئة واحدة فقط ولا يمس المحتوى', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await analyticsIngest(db, 'preview', analyticsEvent());
    await analyticsIngest(db, 'preview', { e: 'mood', s: 'session000000001', n: 'هادئ' });
    await analyticsIngest(db, 'production', analyticsEvent(), 'c'.repeat(16));

    const versionBefore = (await db.query('select version from public.published_content')).rows[0].version;
    const deleted = await rpc(db, "select public.admin_analytics_clear('preview') as result");
    assert.equal(deleted, 2);
    assert.equal((await db.query("select count(*)::int as n from public.analytics_events where env = 'preview'")).rows[0].n, 0);
    assert.equal((await db.query("select count(*)::int as n from public.analytics_events where env = 'production'")).rows[0].n, 1);
    assert.equal(
      (await db.query("select count(*)::int as n from public.analytics_rate_limits where env = 'preview'")).rows[0].n,
      0,
    );
    // The production counters (minute and day) survive a preview clear.
    assert.ok(
      (await db.query("select count(*)::int as n from public.analytics_rate_limits where env = 'production'")).rows[0].n > 0,
    );
    assert.equal((await db.query('select version from public.published_content')).rows[0].version, versionBefore);

    await assert.rejects(rpc(db, "select public.admin_analytics_clear('staging') as result"), /invalid environment/);
  });

  test('تحليلات: الحدود المشتركة دقيقة ويومية وتُستهلك حتى مع الرفض', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    // Minute boundary: 119 already used, so one event is accepted and the next
    // is rejected, matching the previous 120/minute design.
    await db.query(
      `insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
       values ('preview', 'minute', $1, date_trunc('minute', clock_timestamp()), 119)`,
      [ANALYTICS_VISITOR],
    );
    assert.deepEqual(await analyticsIngest(db, 'preview', analyticsEvent()), { ok: true });
    assert.deepEqual(
      await analyticsIngest(db, 'preview', { e: 'mood', s: 'session000000001', n: 'هادئ' }),
      { ok: false, reason: 'minute_limit' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.analytics_events')).rows[0].n, 1);

    // Day boundary: 5000 already used for the current Baghdad day. The first
    // ingest above already created the day row, so reset it instead of inserting
    // a duplicate primary key.
    await db.query("delete from public.analytics_rate_limits where env = 'preview' and scope = 'day'");
    await db.query(
      `insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
       values ('preview', 'day',
         to_char(clock_timestamp() at time zone 'Asia/Baghdad', 'YYYY-MM-DD'),
         (clock_timestamp() at time zone 'Asia/Baghdad')::date::timestamp at time zone 'Asia/Baghdad',
         5000)`,
    );
    assert.deepEqual(
      await analyticsIngest(db, 'preview', analyticsEvent(), 'd'.repeat(16)),
      { ok: false, reason: 'day_limit' },
    );
    assert.equal((await db.query('select count(*)::int as n from public.analytics_events')).rows[0].n, 1);
    assert.equal(
      (await db.query("select count(*)::int as n from public.analytics_rate_limits where scope = 'day'")).rows[0].n,
      1,
    );
  });

  test('تحليلات: التنظيف المجدول يحتفظ 90 يومًا فقط ولا يُنفَّذ من أدوار API', async (t) => {
    const db = await createDb();
    t.after(() => db.close());

    await db.query(
      `insert into public.analytics_events (env, day, occurred_at, visitor, session, type)
       values ('preview', (current_date - 91), now() - interval '91 days', $1, 'oldsession0000001', 'pageview')`,
      [ANALYTICS_VISITOR],
    );
    await db.query(
      `insert into public.analytics_events (env, day, occurred_at, visitor, session, type)
       values ('preview', current_date, now() - interval '89 days', $1, 'newsession0000001', 'pageview')`,
      [ANALYTICS_VISITOR],
    );
    await db.query(
      `insert into public.analytics_rate_limits (env, scope, bucket, window_start, count)
       values ('preview', 'minute', 'old', now() - interval '3 days', 1),
              ('preview', 'minute', 'new', now() - interval '1 hour', 1)`,
    );

    const purged = (await db.query('select public.analytics_purge_expired(90) as result')).rows[0].result;
    assert.ok(purged.events >= 1);
    assert.ok(purged.rate_limits >= 1);
    const sessions = (await db.query('select session from public.analytics_events order by session')).rows.map((row) => row.session);
    assert.deepEqual(sessions, ['newsession0000001']);
    const buckets = (await db.query("select bucket from public.analytics_rate_limits where env = 'preview' and scope = 'minute' order by bucket")).rows.map((row) => row.bucket);
    assert.deepEqual(buckets, ['new']);

    await assert.rejects(asVisitor(db, () => db.query('select public.analytics_purge_expired(90)')), /permission denied/);
    await assert.rejects(asAdmin(db, () => db.query('select public.analytics_purge_expired(90)')), /permission denied/);
    await assert.rejects(db.query('select public.analytics_purge_expired(0)'), /invalid retention/);
  });
}
