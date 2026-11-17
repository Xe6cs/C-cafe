// Two-connection PostgreSQL concurrency checks against the real C-cafe
// Supabase database (PostgreSQL 17.11) through the Supavisor pooler.
//
// These are DB-level tests, not HTTP tests: they use a temporary LOGIN role,
// explicit transactions, and the same JWT-claims GUCs that PostgREST uses.
// Real Auth-issued JWT/PostgREST tests live in http-cloud-check.mjs.
//
// Required environment (the suite fails clearly when any is missing):
//   CCAFE_PROJECT_REF          must be mzbhncsdpdbxsdswzruc
//   CCAFE_DB_CREDENTIALS_FILE  temp JSON with the temporary DB role credentials
//   CCAFE_CREDENTIALS_FILE     temp JSON with the two test Auth users
//
// Safety:
//   * Refuses any project ref other than mzbhncsdpdbxsdswzruc.
//   * Refuses a DB user that does not carry the project ref as its tenant.
//   * Requires the pristine imported state (version 1, no draft, no operations,
//     no verification checks) before writing anything.
//   * Every mutation happens inside an explicit transaction; failures roll back.
//   * The companion cleanup script restores the original content and removes
//     test-only rows, drafts, checks, operations, users, and the temporary role.

import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';

const { Client, types } = pg;
types.setTypeParser(20, (value) => Number(value)); // int8 -> number
const ALLOWED_REF = 'mzbhncsdpdbxsdswzruc';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `missing required environment variable ${name}; refusing to skip remote verification`,
    );
  }
  return value;
}

const ref = requireEnv('CCAFE_PROJECT_REF');
if (ref !== ALLOWED_REF) {
  throw new Error(`refusing project ref ${ref}; only ${ALLOWED_REF} is allowed`);
}

const db = JSON.parse(await readFile(requireEnv('CCAFE_DB_CREDENTIALS_FILE'), 'utf8'));
const auth = JSON.parse(await readFile(requireEnv('CCAFE_CREDENTIALS_FILE'), 'utf8'));
if (db.project_ref !== ALLOWED_REF || auth.project_ref !== ALLOWED_REF) {
  throw new Error('credentials do not belong to the allowed project');
}
if (!db.user || !db.user.endsWith(`.${ALLOWED_REF}`)) {
  throw new Error('DB user must use the project ref as its pooler tenant');
}
if (!['aws-0-us-east-2.pooler.supabase.com', `db.${ALLOWED_REF}.supabase.co`].includes(db.host)) {
  throw new Error(`refusing unexpected database host ${db.host}`);
}
if (!db.password || !auth.admin?.id) {
  throw new Error('missing database password or test admin identity');
}

const localContent = JSON.parse(await readFile(path.join(root, 'data', 'content.json'), 'utf8'));
const ADMIN_ID = auth.admin.id;

const SAVE_SQL = 'select public.admin_save_draft($1::bigint, $2::uuid, $3::jsonb) as result';
const DELETE_SQL = 'select public.admin_delete_draft($1::bigint, $2::uuid) as result';
const PUBLISH_SQL =
  'select public.admin_publish($1::bigint, $2::uuid, $3::jsonb, $4::text, $5::uuid) as result';
const RESTORE_SQL =
  'select public.admin_restore($1::bigint, $2::bigint, $3::text, $4::uuid) as result';
const BEGIN_CHECK_SQL = 'select public.admin_begin_public_check($1::bigint) as result';
const FINISH_CHECK_SQL =
  'select public.admin_finish_public_check($1::bigint, $2::text, $3::bigint, $4::text) as result';

function contentWith(label) {
  const copy = structuredClone(localContent);
  copy.hero.big = label;
  return copy;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const client = new Client({
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 60000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch {
        // ignore teardown errors on a connection that never opened
      }
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function beginAs(client, userId, role = 'authenticated') {
  await client.query('begin');
  const claims = userId ? JSON.stringify({ sub: userId, role }) : '{}';
  await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query("select set_config('request.jwt.claim.sub', $1, true)", [userId || '']);
  await client.query(`set local role ${role}`);
  const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
  return pid;
}

async function call(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0].result;
}

function settle(promise) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

async function expectError(outcome, pattern, label) {
  if (outcome.ok) throw new Error(`${label}: expected an error but the call succeeded`);
  const message = String(outcome.error?.message || '');
  if (!pattern.test(message)) {
    throw new Error(`${label}: unexpected error "${message}"`);
  }
  return outcome.error;
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
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

async function readState() {
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    const site = (
      await client.query(
        'select version, content, public_check_id, public_check_state, public_check_observed_version from public.site_content where id = 1',
      )
    ).rows[0];
    const draft = (
      await client.query('select revision_id, content, base_version from public.draft where id = 1')
    ).rows[0] || null;
    const counts = (
      await client.query(
        `select
           (select count(*)::int from public.content_history) as history,
           (select count(*)::int from public.content_operations) as operations,
           (select count(*)::int from public.verification_checks) as checks,
           (select max(version)::int from public.content_history) as max_history_version,
           (select min(version)::int from public.content_history) as min_history_version`,
      )
    ).rows[0];
    await client.query('rollback');
    return { site, draft, counts };
  } finally {
    await client.end();
  }
}

async function deleteDraft(version, revision) {
  if (!revision) return;
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    await call(client, DELETE_SQL, [version, revision]);
    await client.query('commit');
  } finally {
    await client.end();
  }
}

async function findOriginalHistoryId() {
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    const rows = (
      await client.query('select id, content from public.content_history order by version desc')
    ).rows;
    await client.query('rollback');
    const found = rows.find((row) => isDeepStrictEqual(row.content, localContent));
    if (!found) throw new Error('no history row contains the original content');
    return found.id;
  } finally {
    await client.end();
  }
}

async function publishOnce(version, content, note = 'cloud concurrency test', operationId = randomUUID()) {
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    const result = await call(client, PUBLISH_SQL, [version, null, content, note, operationId]);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

async function saveOnce(version, revision, content) {
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    const result = await call(client, SAVE_SQL, [version, revision, content]);
    await client.query('commit');
    return result;
  } finally {
    await client.end();
  }
}

async function cleanupDraft(label) {
  try {
    const state = await readState();
    if (state.draft) {
      await deleteDraft(state.site.version, state.draft.revision_id);
    }
  } catch (error) {
    console.log(`WARN cleanup after "${label}" failed: ${error.message}`);
  }
}

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`FAIL ${name}: ${error.message}`);
  } finally {
    await cleanupDraft(name);
  }
}

const observer = await connect();
const preflight = (
  await observer.query(
    `select current_user, session_user, current_database() as db,
            current_setting('server_version') as version,
            current_setting('server_version_num') as version_num`,
  )
).rows[0];

if (preflight.version_num !== '170011' || !/^17\.11/.test(preflight.version)) {
  throw new Error(`expected PostgreSQL 17.11, got ${preflight.version} (${preflight.version_num})`);
}
if (preflight.db !== 'postgres') {
  throw new Error(`unexpected database ${preflight.db}`);
}

const initial = await readState();
if (!Number.isInteger(initial.site.version) || initial.site.version < 1) {
  throw new Error(`unexpected site content version ${initial.site.version}`);
}
if (!isDeepStrictEqual(initial.site.content, localContent)) {
  throw new Error(
    'suite requires the published content to match data/content.json (run the cleanup script first)',
  );
}
if (initial.draft || initial.counts.operations !== 0 || initial.counts.checks !== 0) {
  throw new Error(
    'suite requires no draft, operations, or verification checks before it starts (run the cleanup script first)',
  );
}

console.log(
  JSON.stringify({
    database: preflight.db,
    server_version: preflight.version,
    server_version_num: preflight.version_num,
    mode: 'two-connection DB concurrency',
  }),
);

let connectionError = null;

await check('db: viewer cannot call admin RPCs or write tables directly', async () => {
  const client = await connect();
  try {
    await beginAs(client, auth.viewer.id);
    const save = await settle(
      call(client, SAVE_SQL, [initial.site.version, null, localContent]),
    );
    await expectError(save, /admin only/i, 'viewer save_draft');
    await client.query('rollback');

    await beginAs(client, auth.viewer.id);
    const update = await settle(
      client.query('update public.site_content set version = version where id = 1'),
    );
    if (update.ok) throw new Error('viewer direct update unexpectedly succeeded');
    if (!/permission denied/i.test(String(update.error.message))) {
      throw new Error(`unexpected direct-write error: ${update.error.message}`);
    }
    await client.query('rollback');

    await beginAs(client, auth.viewer.id);
    const rows = await client.query('select count(*)::int as n from public.site_content');
    if (rows.rows[0].n !== 0) throw new Error('viewer saw admin rows through RLS');
    await client.query('rollback');
  } finally {
    await client.end();
  }
});

await check('db: same-revision saves have exactly one winner', async () => {
  const state = await readState();
  const version = state.site.version;
  const first = await saveOnce(version, null, contentWith('draft-initial'));
  if (!first.revision_id) throw new Error('initial save returned no revision');

  const a = await connect();
  const b = await connect();
  try {
    const pidA = await beginAs(a, ADMIN_ID);
    const pidB = await beginAs(b, ADMIN_ID);
    await call(a, SAVE_SQL, [version, first.revision_id, contentWith('save-winner')]);
    await waitForAdvisoryLock(observer, pidA);
    const bOutcome = settle(call(b, SAVE_SQL, [version, first.revision_id, contentWith('save-loser')]));
    await waitForBlocked(observer, pidB, pidA);
    await a.query('commit');
    const bResult = await bOutcome;
    await expectError(bResult, /stale draft revision/i, 'loser save');
    await b.query('rollback');

    const after = await readState();
    if (!after.draft) throw new Error('winner draft disappeared');
    if (after.draft.revision_id === first.revision_id) throw new Error('revision token was reused');
    if (after.draft.content.hero.big !== 'save-winner') {
      throw new Error(`unexpected winning content: ${after.draft.content.hero.big}`);
    }
    if (after.site.version !== version) throw new Error('draft save changed the published version');
    await deleteDraft(version, after.draft.revision_id);
  } finally {
    await a.end();
    await b.end();
  }
});

await check('db: publish of an old revision cannot delete a newer draft', async () => {
  const state = await readState();
  const version = state.site.version;
  const first = await saveOnce(version, null, contentWith('draft-old'));

  const a = await connect();
  const b = await connect();
  try {
    const pidA = await beginAs(a, ADMIN_ID);
    const pidB = await beginAs(b, ADMIN_ID);
    const saved = await call(a, SAVE_SQL, [
      version,
      first.revision_id,
      contentWith('draft-newer'),
    ]);
    await waitForAdvisoryLock(observer, pidA);
    const bOutcome = settle(
      call(b, PUBLISH_SQL, [version, first.revision_id, null, 'publish stale draft', randomUUID()]),
    );
    await waitForBlocked(observer, pidB, pidA);
    await a.query('commit');
    const bResult = await bOutcome;
    await expectError(bResult, /stale draft revision/i, 'stale publish');
    await b.query('rollback');

    const after = await readState();
    if (after.site.version !== version) throw new Error('stale publish changed the version');
    if (!after.draft || after.draft.revision_id !== saved.revision_id) {
      throw new Error('stale publish removed or replaced the newer draft');
    }
    if (after.draft.content.hero.big !== 'draft-newer') {
      throw new Error('newer draft content was lost');
    }
    if (after.counts.history !== state.counts.history) {
      throw new Error('stale publish wrote history');
    }
    await deleteDraft(version, after.draft.revision_id);
  } finally {
    await a.end();
    await b.end();
  }
});

await check('db: restore cannot remove a newer draft saved concurrently', async () => {
  const state = await readState();
  const version = state.site.version;
  const historyId = await findOriginalHistoryId();
  const first = await saveOnce(version, null, contentWith('draft-before-restore'));

  const a = await connect();
  const b = await connect();
  try {
    const pidA = await beginAs(a, ADMIN_ID);
    const pidB = await beginAs(b, ADMIN_ID);
    const saved = await call(a, SAVE_SQL, [version, first.revision_id, contentWith('draft-survives')]);
    await waitForAdvisoryLock(observer, pidA);
    const bOutcome = settle(
      call(b, RESTORE_SQL, [historyId, version, 'restore while saving', randomUUID()]),
    );
    await waitForBlocked(observer, pidB, pidA);
    await a.query('commit');
    const bResult = await bOutcome;
    if (!bResult.ok) throw new Error(`restore failed: ${bResult.error.message}`);
    await b.query('commit');

    const after = await readState();
    if (after.site.version !== version + 1) throw new Error('restore did not create one new version');
    if (!isDeepStrictEqual(after.site.content, localContent)) throw new Error('restore content mismatch');
    if (!after.draft || after.draft.revision_id !== saved.revision_id) {
      throw new Error('restore removed the newer draft');
    }
    if (after.draft.content.hero.big !== 'draft-survives') {
      throw new Error('restore overwrote the newer draft');
    }
    await deleteDraft(after.site.version, after.draft.revision_id);
  } finally {
    await a.end();
    await b.end();
  }
});

await check('db: publish is idempotent for the same operation ID and request', async () => {
  const before = await readState();
  const version = before.site.version;
  const operationId = randomUUID();
  const content = contentWith('operation-idempotent');

  const first = await publishOnce(version, content, 'idempotent publish', operationId);
  const second = await publishOnce(version, content, 'idempotent publish', operationId);

  if (first.version !== version + 1) throw new Error('first publish did not advance once');
  if (!isDeepStrictEqual(first, second)) throw new Error('retry did not return the original result');
  const after = await readState();
  if (after.site.version !== version + 1) throw new Error('retry created another version');
  if (after.counts.operations !== before.counts.operations + 1) {
    throw new Error('retry recorded another operation');
  }
  if (after.counts.history !== before.counts.history + 1) {
    throw new Error('retry added history');
  }
});

await check('db: operation ID reuse with different parameters is rejected', async () => {
  const before = await readState();
  const version = before.site.version;
  const operationId = randomUUID();
  await publishOnce(version, contentWith('operation-owner'), 'owner', operationId);
  const afterFirst = await readState();

  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    const outcome = await settle(
      call(client, PUBLISH_SQL, [
        afterFirst.site.version,
        null,
        contentWith('operation-other'),
        'different',
        operationId,
      ]),
    );
    await expectError(outcome, /operation id was reused|belongs to another operation/i, 'reused operation id');
    await client.query('rollback');
  } finally {
    await client.end();
  }

  const after = await readState();
  if (after.site.version !== afterFirst.site.version) throw new Error('reuse changed the version');
  if (after.counts.operations !== afterFirst.counts.operations) {
    throw new Error('reuse recorded another operation');
  }
});

await check('db: stale revision after delete/recreate is rejected', async () => {
  const state = await readState();
  const version = state.site.version;
  const first = await saveOnce(version, null, contentWith('revision-one'));

  const del = await connect();
  try {
    await beginAs(del, ADMIN_ID);
    const deleted = await call(del, DELETE_SQL, [version, first.revision_id]);
    if (deleted.deleted !== true) throw new Error('first delete failed');
    await del.query('commit');
  } finally {
    await del.end();
  }

  const second = await saveOnce(version, null, contentWith('revision-two'));

  const staleSave = await connect();
  try {
    await beginAs(staleSave, ADMIN_ID);
    const outcome = await settle(
      call(staleSave, SAVE_SQL, [version, first.revision_id, contentWith('stale-save')]),
    );
    await expectError(outcome, /stale draft revision/i, 'stale save');
    await staleSave.query('rollback');
  } finally {
    await staleSave.end();
  }

  const staleDelete = await connect();
  try {
    await beginAs(staleDelete, ADMIN_ID);
    const outcome = await settle(call(staleDelete, DELETE_SQL, [version, first.revision_id]));
    await expectError(outcome, /stale draft revision/i, 'stale delete');
    await staleDelete.query('rollback');
  } finally {
    await staleDelete.end();
  }

  const after = await readState();
  if (!after.draft || after.draft.revision_id !== second.revision_id) {
    throw new Error('recreated draft was not preserved');
  }
  await deleteDraft(version, second.revision_id);
});

await check('db: stale public-check results cannot overwrite newer state', async () => {
  const state = await readState();
  const version = state.site.version;

  const begin = async (expected) => {
    const client = await connect();
    try {
      await beginAs(client, ADMIN_ID);
      const id = await call(client, BEGIN_CHECK_SQL, [expected]);
      await client.query('commit');
      return id;
    } finally {
      await client.end();
    }
  };
  const finish = async (checkId, checkState, observed) => {
    const client = await connect();
    try {
      await beginAs(client, ADMIN_ID);
      const applied = await call(client, FINISH_CHECK_SQL, [checkId, checkState, observed, null]);
      await client.query('commit');
      return applied;
    } finally {
      await client.end();
    }
  };

  const older = await begin(version);
  const newer = await begin(version);
  if ((await finish(older, 'matched', version)) !== false) {
    throw new Error('older check overwrote the newer registered attempt');
  }
  if ((await finish(newer, 'matched', version)) !== true) {
    throw new Error('newest check did not apply');
  }

  const stale = await begin(version);
  const published = await publishOnce(version, contentWith('new-version-after-check'), 'publish after check');
  if (published.version !== version + 1) throw new Error('publish did not advance');
  if ((await finish(stale, 'matched', version)) !== false) {
    throw new Error('stale check overwrote the newer version');
  }

  const after = await readState();
  if (after.site.version !== version + 1) throw new Error('unexpected version after stale check');
  if (after.site.public_check_state !== 'pending' || after.site.public_check_id !== null) {
    throw new Error('stale check changed the new version check state');
  }

  const fresh = await begin(version + 1);
  if ((await finish(fresh, 'matched', version + 1)) !== true) {
    throw new Error('fresh check did not apply');
  }
  const final = await readState();
  if (
    final.site.public_check_state !== 'matched' ||
    final.site.public_check_observed_version !== version + 1
  ) {
    throw new Error('fresh check state was not recorded');
  }
});

await check('db: history keeps only the newest 50 versions', async () => {
  const before = await readState();
  const start = before.site.version;
  const total = 55;
  for (let i = 1; i <= total; i += 1) {
    const result = await publishOnce(start + i - 1, contentWith(`retention-${i}`), `retention ${i}`);
    if (result.version !== start + i) throw new Error(`retention publish ${i} did not advance`);
  }
  const after = await readState();
  if (after.site.version !== start + total) throw new Error('unexpected final version');
  if (after.counts.history !== 50) throw new Error(`expected 50 history rows, got ${after.counts.history}`);
  if (after.counts.max_history_version !== start + total) {
    throw new Error('newest history row is missing');
  }
  if (after.counts.min_history_version !== start + total - 49) {
    throw new Error(`oldest retained version is ${after.counts.min_history_version}`);
  }
});

await check('db: a failed transaction leaves no partial change', async () => {
  const before = await readState();
  const version = before.site.version;
  const client = await connect();
  try {
    await beginAs(client, ADMIN_ID);
    await call(client, SAVE_SQL, [version, null, contentWith('rolled-back-draft')]);
    const invalid = await settle(
      call(client, PUBLISH_SQL, [version, null, {}, 'invalid inside transaction', randomUUID()]),
    );
    await expectError(invalid, /required top-level key/i, 'invalid publish inside transaction');
    await client.query('rollback');
  } finally {
    await client.end();
  }

  const after = await readState();
  if (after.site.version !== version) throw new Error('failed transaction changed the version');
  if (after.draft) throw new Error('failed transaction left a draft');
  if (after.counts.history !== before.counts.history) throw new Error('failed transaction wrote history');
  if (after.counts.operations !== before.counts.operations) {
    throw new Error('failed transaction recorded an operation');
  }
});

await check('db: concurrent publishes for the same version have one winner', async () => {
  const state = await readState();
  const version = state.site.version;
  const a = await connect();
  const b = await connect();
  try {
    const pidA = await beginAs(a, ADMIN_ID);
    const pidB = await beginAs(b, ADMIN_ID);
    await call(a, PUBLISH_SQL, [version, null, contentWith('publish-winner'), 'winner', randomUUID()]);
    await waitForAdvisoryLock(observer, pidA);
    const bOutcome = settle(
      call(b, PUBLISH_SQL, [version, null, contentWith('publish-loser'), 'loser', randomUUID()]),
    );
    await waitForBlocked(observer, pidB, pidA);
    await a.query('commit');
    const bResult = await bOutcome;
    await expectError(bResult, /stale published version/i, 'loser publish');
    await b.query('rollback');

    const after = await readState();
    if (after.site.version !== version + 1) throw new Error('expected exactly one new version');
    if (after.site.content.hero.big !== 'publish-winner') throw new Error('wrong winner content');
  } finally {
    await a.end();
    await b.end();
  }
});

await observer.end();

const failed = results.filter((r) => !r.ok);
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    mode: 'DB concurrency',
  }),
);
if (failed.length > 0) {
  console.error('Remote PostgreSQL concurrency verification failed.');
  process.exit(1);
}
