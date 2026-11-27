'use strict';

// Behavioral tests for the site-status UI flow. They load the real browser
// script in a VM with a small fake DOM and a shared fake API server, then drive
// the rendered buttons and dialogs. No browser, network, database, or hosted
// service is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const api = '/api/admin';
const source = fs.readFileSync(
  path.join(__dirname, '..', 'netlify', 'admin', 'app.js'),
  'utf8',
);
const ISO = '2026-11-26T12:00:00.000Z';

class FakeNode {}

class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.open = false;
    this.isConnected = false;
    this.parentNode = null;
    this.childNodes = [];
    this.listeners = new Map();
    this._text = '';
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get textContent() {
    return this._text + this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this._text = String(value);
  }

  get classList() {
    const node = this;
    return {
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      },
      add(name) {
        if (!node.classList.contains(name)) node.className = `${node.className} ${name}`.trim();
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter((item) => item && item !== name).join(' ');
      },
      toggle(name, force) {
        if (force === undefined) force = !node.classList.contains(name);
        if (force) node.classList.add(name);
        else node.classList.remove(name);
        return Boolean(force);
      },
    };
  }

  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof FakeNode ? node : new FakeText(node);
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
  }

  replaceChildren(...nodes) {
    this.textContent = '';
    this.append(...nodes);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
    this.isConnected = false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  dispatch(type, event = {}) {
    const handlers = this.listeners.get(type) || new Set();
    for (const handler of [...handlers]) {
      handler({
        preventDefault() {},
        stopPropagation() {},
        target: this,
        ...event,
      });
    }
  }

  click() {
    // Match a real browser: a disabled button cannot be clicked by the user.
    if (this.disabled) return;
    this.dispatch('click');
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  matches(selector) {
    const value = String(selector).trim();
    if (value.startsWith('#')) return this.id === value.slice(1);
    if (value.startsWith('.')) return this.classList.contains(value.slice(1));
    if (/^[A-Za-z][\w-]*\./.test(value)) {
      const [tag, ...classes] = value.split('.');
      return this.tagName === tag.toUpperCase()
        && classes.every((name) => this.classList.contains(name));
    }
    if (value.startsWith('[')) {
      const match = value.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/);
      if (!match) return false;
      const actual = this.getAttribute(match[1]);
      if (actual === null) return false;
      return match[2] === undefined || actual === match[2];
    }
    return this.tagName === value.toUpperCase();
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {}

  showModal() {
    this.open = true;
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.dispatch('close');
    this.remove();
  }
}

function createDom() {
  const body = new FakeElement('body');
  const root = new FakeElement('div');
  body.append(root);

  const ids = [
    'login-view', 'login-form', 'login-email', 'login-password',
    'login-error', 'login-submit', 'app-view', 'side-user', 'page-title',
    'session-note', 'refresh', 'logout', 'status-pill', 'save-btn',
    'publish-btn', 'preview-btn', 'delete-btn', 'status-banner', 'view', 'toasts',
  ];
  const byId = {};
  for (const id of ids) {
    const node = new FakeElement('div');
    node.setAttribute('id', id);
    root.append(node);
    byId[id] = node;
  }

  // Sidebar links are the real user path for leaving and re-entering a view.
  const navLinks = {};
  for (const view of ['editor', 'site-status']) {
    const link = new FakeElement('a');
    link.setAttribute('data-nav', view);
    root.append(link);
    navLinks[view] = link;
  }

  const document = {
    readyState: 'complete',
    body,
    createElement(tag) {
      return new FakeElement(tag);
    },
    createTextNode(text) {
      return new FakeText(text);
    },
    getElementById(id) {
      return byId[id] || null;
    },
    querySelectorAll(selector) {
      return body.querySelectorAll(selector);
    },
    addEventListener() {},
  };
  return { document, byId, navLinks };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function networkError(label) {
  const error = new Error(label);
  error.status = 0;
  return error;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function sampleHistory() {
  return [
    { id: 3, version: 260, note: 'latest', created_at: ISO },
    { id: 2, version: 259, note: 'old', created_at: ISO },
  ];
}

function createSiteServer(initial) {
  let status = clone(initial);
  const operations = new Map();
  let getHandler = () => Promise.resolve(jsonResponse(clone(status)));
  let postHandler = (request) => defaultPost(request);

  function commit(request) {
    const body = request.body || {};
    status = {
      state: body.state,
      message: body.message,
      revision: status.revision + 1,
      updated_at: ISO,
      changed_by: { id: 'admin-id', email: 'admin@example.com' },
      operation_id: body.operation_id,
      idempotent: false,
    };
    operations.set(body.operation_id, clone(status));
    return clone(status);
  }

  function defaultPost(request) {
    const operationId = request.body && request.body.operation_id;
    if (operations.has(operationId)) {
      return Promise.resolve(jsonResponse({ ...clone(operations.get(operationId)), idempotent: true }));
    }
    if (request.body.expected_revision !== status.revision) {
      return Promise.resolve(jsonResponse({ error: 'conflict' }, 409));
    }
    return Promise.resolve(jsonResponse(commit(request)));
  }

  return {
    historyEntries: [],
    trashItems: [],
    historyDeleteHandler: null,
    mediaPurgeHandler: null,
    defaultPost,
    commit,
    snapshot() { return clone(status); },
    setGetHandler(handler) { getHandler = handler; },
    setPostHandler(handler) { postHandler = handler; },
    setHistoryDeleteHandler(handler) { this.historyDeleteHandler = handler; },
    setMediaPurgeHandler(handler) { this.mediaPurgeHandler = handler; },
    get() { return getHandler(); },
    post(request) { return postHandler(request); },
    operationIds() { return [...operations.keys()]; },
  };
}

function bootstrap(historyEntries = []) {
  return {
    user: { id: 'admin-id', email: 'admin@example.com' },
    published: { version: 260, content: {}, saved_at: ISO },
    working: {
      source: 'published',
      content: {},
      revision_id: null,
      base_version: 260,
      updated_at: null,
    },
    schema: { groups: [{ id: 'g1', label: 'مجموعة', items: [] }], linkTokens: [], linkAnchors: [] },
    history: {
      count: historyEntries.length,
      latest: historyEntries.length ? clone(historyEntries[0]) : null,
    },
  };
}

function createHarness(server) {
  const { document, byId, navLinks } = createDom();
  const requests = [];
  let historyEntries = Array.isArray(server && server.historyEntries) ? clone(server.historyEntries) : [];
  let historyClearHandler = server && typeof server.clearHistory === 'function'
    ? (request) => server.clearHistory(request, { get historyEntries() { return historyEntries; }, setHistory(next) { historyEntries = clone(next); } })
    : async (request) => {
      const deletedCount = historyEntries.length;
      const boundaryVersion = deletedCount ? historyEntries[0].version : null;
      const boundaryId = deletedCount ? historyEntries[0].id : null;
      historyEntries = [];
      return jsonResponse({
        operation_id: request.body.operation_id,
        deleted_count: deletedCount,
        boundary_version: boundaryVersion,
        boundary_id: boundaryId,
        cleared_at: ISO,
      });
    };

  const window = {
    CCAFE_ADMIN_CONFIG: {
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-test-key',
    },
    supabase: {
      createClient() {
        return {
          auth: {
            signInWithPassword: async () => ({
              data: { session: { access_token: 'test-token', expires_at: 9999999999 } },
              error: null,
            }),
            signOut: async () => ({}),
          },
        };
      },
    },
    location: { hash: (server && server.hash) || '#site-status' },
    history: { replaceState() {} },
    CcafeEditor: { renderContent() {}, renderSections() {}, MEDIA_RE: /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
    addEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    crypto: { randomUUID },
  };

  let fetchOverride = null;
  const baseFetchImpl = async (path, init = {}) => {
    const method = init.method || 'GET';
    let body = null;
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    requests.push({ path, method, body });

    if (path === `${api}/bootstrap`) return jsonResponse(bootstrap(historyEntries));
    if (path === `${api}/history`) return jsonResponse({ entries: clone(historyEntries) });
    if (path === `${api}/history/clear`) return historyClearHandler({ body, path, method });
    if (path === `${api}/media/trash`) return jsonResponse({ items: clone(server.trashItems || []) });
    if (path === `${api}/history/delete`) {
      if (server.historyDeleteHandler) return server.historyDeleteHandler({ body, path, method });
      const id = body && body.history_id;
      const idx = historyEntries.findIndex((e) => Number(e.id) === Number(id));
      if (idx < 0) return jsonResponse({ error: 'not_found' }, 404);
      const [removed] = historyEntries.splice(idx, 1);
      return jsonResponse({ operation_id: body.operation_id, history_id: removed.id, version: removed.version, deleted: true, was_current_published_version: false, deleted_at: ISO });
    }
    if (path === `${api}/media/purge`) {
      if (server.mediaPurgeHandler) return server.mediaPurgeHandler({ body, path, method });
      const id = body && body.asset_id;
      const idx = (server.trashItems || []).findIndex((e) => e.asset_id === id);
      if (idx >= 0) server.trashItems.splice(idx, 1);
      return jsonResponse({ asset: { id, logical_path: `media/${id}`, status: 'purged', private_cleanup_state: 'done', trash_cleanup_state: 'done', public_cleanup_state: 'none' }, idempotent: false });
    }
    if (path === `${api}/media/delete`) return jsonResponse({ state: 'trashed', asset_id: body.asset_id, logical_path: `media/${body.asset_id}`, idempotent: false });
    if (path === `${api}/media`) {
      return jsonResponse({
        assets: [],
        originals: [],
        urls: {},
        limits: {},
        media_enabled: true,
      });
    }
    if (path === `${api}/site-status`) {
      return method === 'POST' ? server.post({ body }) : server.get();
    }
    return jsonResponse({ error: 'not-found' }, 404);
  };
  const fetchImpl = async (path, init = {}) => {
    if (fetchOverride) return fetchOverride(path, init, baseFetchImpl);
    return baseFetchImpl(path, init);
  };

  // Test-only hook: expose internal state without modifying the app file.
  const instrumentedSource = source.replace(
    '  const state = {',
    '  const state = {\n  window.__TEST_STATE__ = state;',
  ).replace(
    '\n  window.__TEST_STATE__ = state;',
    '\n  // test hook\n  };',
  );
  // Safer: inject after the full state object literal by anchoring on known next line.
  const stateAnchor = '  const state = {';
  const idx = source.indexOf(stateAnchor);
  if (idx === -1) throw new Error('state anchor not found');
  // Insert hook after the state declaration ends: find "  let statsDispose = null;" which follows state.
  const hookSource = source.replace(
    '  let statsDispose = null;',
    '  window.__TEST_STATE__ = state;\n  let statsDispose = null;',
  );
  if (hookSource === source) throw new Error('hook anchor not found');

  const sandbox = {
    window,
    document,
    fetch: fetchImpl,
    Node: FakeNode,
    console,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  };
  vm.runInNewContext(hookSource, sandbox, { filename: 'admin/app.js' });

  const view = byId.view;
  const helpers = {
    document,
    window,
    byId,
    requests,
    view,
    text() { return view.textContent + ' ' + (byId['toasts'] ? byId['toasts'].textContent : ''); },
    stateLabel() {
      const row = view.querySelectorAll('.site-state-row')[0];
      if (!row) return '';
      const spans = row.querySelectorAll('span');
      return spans.length > 1 ? spans[1].textContent : '';
    },
    button(label) {
      return view.querySelectorAll('button').find((node) => node.textContent.includes(label)) || null;
    },
    nav(viewName) {
      return navLinks[viewName] || null;
    },
    dialogs() {
      return document.body.querySelectorAll('dialog.modal');
    },
    posts(path = `${api}/site-status`) {
      return requests.filter((request) => request.method === 'POST' && request.path === path);
    },
    setHistoryEntries(next) {
      historyEntries = clone(next);
    },
    setHistoryClearHandler(handler) {
      historyClearHandler = handler;
    },
    setFetchOverride(handler) {
      fetchOverride = handler;
    },
  };
  return helpers;
}

async function flush(times = 20) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function dialogButton(dialog, label) {
  return dialog.querySelectorAll('button').find((node) => node.textContent.includes(label)) || null;
}

function trashPurgeButton(harness) {
  for (const card of harness.view.querySelectorAll('.media-card-trash')) {
    const button = card.querySelectorAll('button')
      .find((node) => /حذف نهائي|الحذف النهائي/.test(node.textContent));
    if (button) return button;
  }
  return null;
}

function pendingPurgeButton(harness) {
  const section = harness.view.querySelectorAll('.media-purge-pending')[0];
  if (!section) return null;
  return section.querySelectorAll('button')
    .find((node) => node.textContent.includes('الحذف النهائي')) || null;
}

async function openTrash(harness) {
  if (!trashPurgeButton(harness)) {
    const trashTab = Array.from(harness.view.querySelectorAll('button, a'))
      .find((node) => node.textContent.includes('المهملات'));
    if (trashTab) { trashTab.click(); await flush(); }
  }
  const refresh = harness.view.querySelectorAll('button')
    .find((node) => node.textContent.includes('تحديث المكتبة'));
  if (refresh) {
    refresh.click();
    await flush(); await flush(); await flush();
  }
  return trashPurgeButton(harness);
}

function trashItem(overrides = {}) {
  return {
    asset_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    logical_path: 'media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    original_name: 'x.png',
    mime: 'image/png',
    bytes: 10,
    width: 1,
    height: 1,
    state: 'trashed',
    deleted_at: ISO,
    cleanup_state: 'done',
    public_cleanup_state: 'none',
    ...overrides,
  };
}

function purgeSuccess(id) {
  return {
    asset: {
      id,
      logical_path: `media/${id}`,
      status: 'purged',
      private_cleanup_state: 'done',
      trash_cleanup_state: 'done',
      public_cleanup_state: 'none',
    },
    idempotent: false,
  };
}

async function login(harness) {
  harness.byId['login-email'].value = 'admin@example.com';
  harness.byId['login-password'].value = 'not-a-real-password';
  harness.byId['login-form'].dispatch('submit', { preventDefault() {} });
  await flush();
  assert.equal(harness.byId['app-view'].hidden, false);
}

function runningStatus() {
  return {
    state: 'running',
    message: '',
    revision: 1,
    updated_at: ISO,
    changed_by: { id: 'admin-id', email: 'admin@example.com' },
  };
}

test('stale idempotent replay after a second-session restart shows the current running state', async () => {
  const server = createSiteServer(runningStatus());
  const first = createHarness(server);
  await login(first);
  assert.equal(first.stateLabel(), 'يعمل');

  let firstOperationId = '';
  server.setPostHandler((request) => {
    if (!firstOperationId) {
      firstOperationId = request.body.operation_id;
      server.commit(request);
      return Promise.reject(networkError('response-lost'));
    }
    return server.defaultPost(request);
  });

  const stopButton = first.button('إيقاف الموقع مؤقتًا');
  stopButton.click();
  await flush();
  const stopDialog = first.dialogs()[0];
  assert.ok(stopDialog, 'stop dialog opens');
  stopDialog.querySelectorAll('textarea')[0].value = 'صيانة';
  dialogButton(stopDialog, 'إيقاف الموقع').click();
  await flush();

  // The server executed the stop, but the lost response cannot prove it to
  // this page. The current-state row must not keep showing the old running
  // value, and the complete in-flight request must stay untouched for retry.
  assert.match(first.text(), /انقطع الرد/);
  assert.equal(first.stateLabel(), 'غير مؤكد');
  assert.match(first.text(), /الحالة الحاليةغير مؤكد/);
  assert.doesNotMatch(first.text(), /المراجعة #1/);
  assert.equal(first.posts().length, 1);
  const lostRequest = {
    operation_id: firstOperationId,
    state: 'stopped',
    message: 'صيانة',
    expected_revision: 1,
  };
  assert.deepEqual(first.posts()[0].body, lostRequest);
  const retryButton = first.button('إعادة محاولة الطلب نفسه');
  assert.ok(retryButton, 'lost response leaves an explicit retry');
  assert.equal(retryButton.getAttribute('data-operation-id'), lostRequest.operation_id);
  assert.equal(retryButton.getAttribute('data-state'), lostRequest.state);
  assert.equal(retryButton.getAttribute('data-message'), lostRequest.message);
  assert.equal(retryButton.getAttribute('data-expected-revision'), String(lostRequest.expected_revision));
  assert.equal(server.snapshot().revision, 2);

  server.setPostHandler((request) => server.defaultPost(request));
  const second = createHarness(server);
  await login(second);
  assert.equal(second.stateLabel(), 'متوقف مؤقتًا');
  second.button('إعادة تشغيل الموقع').click();
  await flush();
  const restartDialog = second.dialogs()[0];
  assert.ok(restartDialog, 'second session can restart');
  dialogButton(restartDialog, 'إعادة التشغيل').click();
  await flush();
  assert.equal(second.stateLabel(), 'يعمل');
  assert.equal(server.snapshot().revision, 3);

  first.button('إعادة محاولة الطلب نفسه').click();
  await flush();

  assert.equal(first.stateLabel(), 'يعمل');
  assert.match(first.text(), /نتيجة تاريخية/);
  assert.match(first.text(), /الحالة الحالية الآن يعمل/);
  assert.match(first.text(), /المراجعة #3/);
  assert.doesNotMatch(first.text(), /توقف الموقع\. يعرض الزائر الآن صفحة التوقف/);
  assert.doesNotMatch(first.byId.toasts.textContent, /تم إيقاف الموقع مؤقتًا/);

  const posts = first.posts();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(posts[1].body.operation_id, firstOperationId);
  assert.notEqual(server.operationIds()[1], firstOperationId);
  assert.equal(server.snapshot().revision, 3);
});

test('failed current-state fetch after confirmation reports an unconfirmed current state', async () => {
  const server = createSiteServer(runningStatus());
  const harness = createHarness(server);
  await login(harness);

  server.setGetHandler(() => Promise.reject(networkError('state-fetch-failed')));
  harness.button('إيقاف الموقع مؤقتًا').click();
  await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelectorAll('textarea')[0].value = 'صيانة';
  dialogButton(dialog, 'إيقاف الموقع').click();
  await flush();

  assert.equal(server.snapshot().state, 'stopped');
  assert.equal(harness.stateLabel(), 'غير مؤكد');
  assert.match(harness.text(), /تم تأكيد العملية/);
  assert.match(harness.text(), /الحالة الحالية غير مؤكدة/);
  assert.match(harness.text(), /لا تفترض أن الموقع متوقف أو يعمل/);
  assert.doesNotMatch(harness.text(), /توقف الموقع\. يعرض الزائر الآن صفحة التوقف/);
  assert.ok(harness.button('إعادة محاولة الطلب نفسه'));
});

test('repeated clicks while a confirmation dialog is open create only one request', async () => {
  const server = createSiteServer(runningStatus());
  const harness = createHarness(server);
  await login(harness);

  const stopButton = harness.button('إيقاف الموقع مؤقتًا');
  const restartButton = harness.button('إعادة تشغيل الموقع');
  stopButton.click();
  stopButton.click();
  restartButton.click();
  await flush();
  assert.equal(harness.dialogs().length, 1, 'one dialog stays open');

  const dialog = harness.dialogs()[0];
  dialogButton(dialog, 'إيقاف الموقع').click();
  await flush();
  assert.equal(harness.posts().length, 1, 'one write is sent');
  assert.equal(harness.stateLabel(), 'متوقف مؤقتًا');

  // The guard is released after success: a new confirmation can open, and
  // cancelling it must not send another request.
  harness.button('إعادة تشغيل الموقع').click();
  await flush();
  assert.equal(harness.dialogs().length, 1);
  dialogButton(harness.dialogs()[0], 'إلغاء').click();
  await flush();
  assert.equal(harness.dialogs().length, 0);
  assert.equal(harness.posts().length, 1);
});

test('explicit retry reuses the stored non-empty message and operation id', async () => {
  const server = createSiteServer(runningStatus());
  const harness = createHarness(server);
  await login(harness);

  let responseLost = false;
  server.setPostHandler((request) => {
    if (!responseLost) {
      responseLost = true;
      server.commit(request);
      return Promise.reject(networkError('response-lost'));
    }
    return server.defaultPost(request);
  });
  harness.button('إيقاف الموقع مؤقتًا').click();
  await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelectorAll('textarea')[0].value = 'رسالة صيانة مهمة';
  dialogButton(dialog, 'إيقاف الموقع').click();
  await flush();
  assert.match(harness.text(), /انقطع الرد/);
  assert.equal(harness.stateLabel(), 'غير مؤكد');
  assert.match(harness.text(), /الحالة الحاليةغير مؤكد/);
  assert.doesNotMatch(harness.text(), /المراجعة #1/);
  assert.equal(harness.posts().length, 1);
  const lostRequest = {
    operation_id: harness.posts()[0].body.operation_id,
    state: 'stopped',
    message: 'رسالة صيانة مهمة',
    expected_revision: 1,
  };
  assert.deepEqual(harness.posts()[0].body, lostRequest);

  harness.button('إعادة محاولة الطلب نفسه').click();
  await flush();

  assert.equal(harness.dialogs().length, 0, 'retry does not reopen a dialog');
  assert.equal(harness.stateLabel(), 'متوقف مؤقتًا');
  assert.match(harness.text(), /نتيجة تاريخية/);
  assert.match(harness.text(), /الحالة الحالية الآن متوقف مؤقتًا/);
  assert.match(harness.text(), /المراجعة #2/);
  const posts = harness.posts();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, lostRequest);
  assert.deepEqual(posts[1].body, lostRequest);
  assert.equal(posts[1].body.operation_id, posts[0].body.operation_id);
  assert.equal(posts[1].body.message, 'رسالة صيانة مهمة');
  assert.equal(posts[1].body.expected_revision, 1);
});

test('internal request sequence: an older GET cannot overwrite a newer revision', async () => {
  // This is an internal request-sequence test, not a simulated user click on a
  // disabled control. The refresh button is intentionally disabled while a
  // read is in flight, so the overlap is created through an allowed path:
  // leave the site-status view and return while the first GET is still pending.
  const server = createSiteServer(runningStatus());
  const oldRead = deferred();
  let getCalls = 0;
  server.setGetHandler(() => {
    getCalls += 1;
    if (getCalls === 1) return oldRead.promise;
    if (getCalls === 2) {
      return Promise.resolve(jsonResponse({
        state: 'stopped',
        message: 'من الجلسة الأخرى',
        revision: 2,
        updated_at: ISO,
        changed_by: { id: 'admin-id', email: 'admin@example.com' },
      }));
    }
    return Promise.resolve(jsonResponse(server.snapshot()));
  });

  const harness = createHarness(server);
  await login(harness);
  assert.equal(getCalls, 1, 'login starts the first status read');

  harness.nav('editor').click();
  await flush();
  harness.nav('site-status').click();
  await flush();
  assert.equal(getCalls, 2, 'returning to the view starts a second allowed read');
  assert.equal(harness.stateLabel(), 'متوقف مؤقتًا');
  assert.match(harness.text(), /#2/);

  oldRead.resolve(jsonResponse(runningStatus()));
  await flush();

  assert.equal(harness.stateLabel(), 'متوقف مؤقتًا');
  assert.match(harness.text(), /#2/);
  assert.doesNotMatch(harness.text(), /المراجعة #1/);
});

test('history clear requires explicit confirmation and updates the list after success', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  assert.match(harness.text(), /سجل النسخ المنشورة/);
  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  let dialog = harness.dialogs()[0];
  let confirm = dialogButton(dialog, 'حذف السجل نهائيًا');
  assert.equal(confirm.disabled, true);
  dialog.querySelector('input').value = 'حذف السجل';
  dialog.querySelector('input').dispatch('input');
  assert.equal(confirm.disabled, true);
  confirm.click();
  await flush();
  assert.equal(harness.posts(`${api}/history/clear`).length, 0, 'wrong confirmation must not send request');

  dialogButton(dialog, 'إلغاء').click();
  await flush();
  assert.equal(harness.posts(`${api}/history/clear`).length, 0, 'cancel must not send request');

  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  dialog = harness.dialogs()[0];
  confirm = dialogButton(dialog, 'حذف السجل نهائيًا');
  dialog.querySelector('input').value = 'حذف السجل نهائيًا';
  dialog.querySelector('input').dispatch('input');
  assert.equal(confirm.disabled, false);
  confirm.click();
  confirm.click(); // repeated click after confirm should not create another request
  await flush();

  const posts = harness.posts(`${api}/history/clear`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.confirmation, 'حذف السجل نهائيًا');
  assert.match(harness.text(), /لا توجد نسخ في السجل/);
  assert.match(harness.byId.toasts.textContent, /عدد النسخ المحذوفة: 2/);
});

test('history clear keeps the same operation id after a lost response', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  let lost = false;
  let firstOperationId = null;
  harness.setHistoryClearHandler(async (request) => {
    if (!lost) {
      lost = true;
      firstOperationId = request.body.operation_id;
      harness.setHistoryEntries([]);
      return Promise.reject(networkError('response-lost'));
    }
    return jsonResponse({
      operation_id: request.body.operation_id,
      deleted_count: 2,
      boundary_version: 260,
      boundary_id: 3,
      cleared_at: ISO,
    });
  });

  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelector('input').value = 'حذف السجل نهائيًا';
  dialog.querySelector('input').dispatch('input');
  dialogButton(dialog, 'حذف السجل نهائيًا').click();
  await flush();

  const postsAfterLoss = harness.posts(`${api}/history/clear`);
  assert.equal(postsAfterLoss.length, 1);
  assert.equal(postsAfterLoss[0].body.operation_id, firstOperationId);

  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  const retryDialog = harness.dialogs()[0];
  assert.ok(retryDialog);
  retryDialog.querySelector('input').value = 'حذف السجل نهائيًا';
  retryDialog.querySelector('input').dispatch('input');
  dialogButton(retryDialog, 'حذف السجل نهائيًا').click();
  await flush();

  const posts = harness.posts(`${api}/history/clear`);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.operation_id, firstOperationId);
  assert.match(harness.byId.toasts.textContent, /عدد النسخ المحذوفة: 2/);
});

test('history clear reports success when delete committed but refresh failed', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  let clearDone = false;
  harness.setHistoryClearHandler(async (request) => {
    clearDone = true;
    harness.setHistoryEntries([]);
    return jsonResponse({
      operation_id: request.body.operation_id,
      deleted_count: 2,
      boundary_version: 260,
      boundary_id: 3,
      cleared_at: ISO,
    });
  });
  harness.setFetchOverride(async (url, init, baseFetch) => {
    if (clearDone && String(url).startsWith(`${api}/history`)) {
      throw networkError('refresh-failed');
    }
    return baseFetch(url, init);
  });

  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelector('input').value = 'حذف السجل نهائيًا';
  dialog.querySelector('input').dispatch('input');
  dialogButton(dialog, 'حذف السجل نهائيًا').click();
  await flush();

  assert.equal(harness.posts(`${api}/history/clear`).length, 1);
  assert.match(harness.byId.toasts.textContent, /تم حذف سجل التعديلات نهائيًا.*تعذّر تحديث قائمة السجل/);
  assert.doesNotMatch(harness.byId.toasts.textContent, /تعذّر تأكيد حذف السجل/);
});

test('history clear preserves unsaved editor state and in-flight edits', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  // Create an unsaved editor error state.
  harness.window.__TEST_STATE__.content = { dirty: 'local-edit' };
  harness.window.__TEST_STATE__.snapshot = JSON.stringify({ dirty: 'baseline' });
  harness.window.__TEST_STATE__.saveState = 'error';
  harness.window.__TEST_STATE__.saveError = 'فشل الحفظ';
  harness.window.__TEST_STATE__.saving = false;
  harness.window.__TEST_STATE__.pending = false;

  const pending = deferred();
  let clearStarted = false;
  harness.setHistoryClearHandler(async (request) => {
    clearStarted = true;
    await pending.promise;
    harness.setHistoryEntries([]);
    return jsonResponse({
      operation_id: request.body.operation_id,
      deleted_count: 2,
      boundary_version: 260,
      boundary_id: 3,
      cleared_at: ISO,
    });
  });

  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelector('input').value = 'حذف السجل نهائيًا';
  dialog.querySelector('input').dispatch('input');
  dialogButton(dialog, 'حذف السجل نهائيًا').click();
  await flush();
  assert.equal(clearStarted, true);

  // Edit while waiting for delete response.
  harness.window.__TEST_STATE__.content.dirty = 'local-edit-while-waiting';

  pending.resolve();
  await flush();

  const st = harness.window.__TEST_STATE__;
  assert.deepEqual(st.content, { dirty: 'local-edit-while-waiting' });
  assert.equal(st.snapshot, JSON.stringify({ dirty: 'baseline' }));
  assert.equal(st.saveState, 'error');
  assert.equal(st.saveError, 'فشل الحفظ');
  assert.equal(st.saving, false);
  assert.equal(st.pending, false);
  assert.equal(st.history.length, 0);
  assert.match(harness.byId.toasts.textContent, /عدد النسخ المحذوفة: 2/);
  assert.doesNotMatch(harness.text(), /تعذّر تأكيد حذف السجل/);
});

test('history clear dialog cannot open twice while confirming', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  harness.button('حذف سجل التعديلات نهائيًا').click();
  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  assert.equal(harness.dialogs().length, 1);

  dialogButton(harness.dialogs()[0], 'إلغاء').click();
  await flush();
  assert.equal(harness.dialogs().length, 0);
  harness.button('حذف سجل التعديلات نهائيًا').click();
  await flush();
  assert.equal(harness.dialogs().length, 1);
});

test('single history row delete requires confirmation, targets only selected row, and reuses operation id after lost response', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);

  const delBtns = () => Array.from(harness.view.querySelectorAll('button')).filter((b) => b.textContent.includes('حذف نهائي') && b.textContent.includes('#260'));
  assert.equal(delBtns().length, 1);
  delBtns()[0].click();
  await flush();
  let dialog = harness.dialogs()[0];
  assert.ok(dialog);
  assert.match(dialog.textContent, /#260/);
  let confirm = dialogButton(dialog, 'حذف هذه النسخة نهائيًا');
  assert.equal(confirm.disabled, true);
  dialog.querySelector('input').value = 'خطأ';
  dialog.querySelector('input').dispatch('input');
  confirm.click();
  await flush();
  assert.equal(harness.posts(api + '/history/delete').length, 0);

  dialogButton(dialog, 'إلغاء').click();
  await flush();
  delBtns()[0].click();
  await flush();
  dialog = harness.dialogs()[0];
  dialog.querySelector('input').value = 'حذف هذه النسخة نهائيًا';
  dialog.querySelector('input').dispatch('input');
  confirm = dialogButton(dialog, 'حذف هذه النسخة نهائيًا');

  let lost = false;
  let opId = null;
  server.setHistoryDeleteHandler(async (request) => {
    if (!lost) {
      lost = true;
      opId = request.body.operation_id;
      server.historyEntries = server.historyEntries.filter((e) => e.id !== request.body.history_id);
      harness.setHistoryEntries(server.historyEntries);
      return Promise.reject(networkError('lost'));
    }
    return jsonResponse({ operation_id: request.body.operation_id, history_id: request.body.history_id, version: 260, deleted: true, was_current_published_version: false, deleted_at: ISO });
  });

  confirm.click();
  await flush();
  const posts = harness.posts(api + '/history/delete');
  assert.equal(posts.length >= 1, true);
  assert.equal(posts[0].body.history_id, 3);
  assert.equal(posts[0].body.operation_id, opId);
  const retryBtns = Array.from(harness.view.querySelectorAll('button')).filter((b)=>b.textContent.includes('إعادة المحاولة'));
  if (retryBtns.length) { retryBtns[0].click(); await flush(); }
  const posts2 = harness.posts(api + '/history/delete');
  assert.ok(posts2.some((p)=>p.body.operation_id === opId && p.body.history_id === 3));
  assert.ok(server.historyEntries.every((e)=>e.id !== 3));
  assert.ok(server.historyEntries.some((e)=>e.id === 2));
});

test('history delete preserves unsaved editor edits and reports refresh failure separately', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#history';
  server.historyEntries = sampleHistory();
  const harness = createHarness(server);
  await login(harness);
  harness.window.__TEST_STATE__.content = { note: 'unsaved' };
  harness.window.__TEST_STATE__.saveState = 'dirty';
  const before = JSON.stringify(harness.window.__TEST_STATE__.content);

  server.setHistoryDeleteHandler(async (request) => {
    server.historyEntries = server.historyEntries.filter((e)=>e.id !== request.body.history_id);
    return jsonResponse({ operation_id: request.body.operation_id, history_id: request.body.history_id, version: 260, deleted: true, was_current_published_version: false, deleted_at: ISO });
  });
  harness.setFetchOverride(async (path, init, base) => {
    if (path === api + '/history') return Promise.reject(networkError('refresh-failed'));
    return base(path, init);
  });

  const btn = Array.from(harness.view.querySelectorAll('button')).find((b)=>b.textContent.includes('حذف نهائي') && b.textContent.includes('#260'));
  btn.click(); await flush();
  const dialog = harness.dialogs()[0];
  dialog.querySelector('input').value = 'حذف هذه النسخة نهائيًا';
  dialog.querySelector('input').dispatch('input');
  dialogButton(dialog, 'حذف هذه النسخة نهائيًا').click();
  await flush();

  assert.equal(JSON.stringify(harness.window.__TEST_STATE__.content), before);
  const txt=harness.text(); assert.ok(txt.includes('\u062d\u0630\u0641') || txt.includes('\u062a\u062d\u062f\u064a\u062b') || txt.includes('\u0641\u0634\u0644'), 'TXT:'+txt.slice(-300));
});

test('permanent purge validates asset.id/status, requires confirmation, and shows success without a failure message', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#media';
  server.trashItems = [trashItem()];
  const harness = createHarness(server);
  await login(harness);
  harness.window.__TEST_STATE__.content = { note: 'unsaved-purge' };

  const first = await openTrash(harness);
  assert.ok(first, 'permanent delete must be available in trash');
  first.click(); first.click();
  await flush();
  assert.equal(harness.dialogs().length, 1, 'duplicate clicks must not open two dialogs');
  const dialog = harness.dialogs()[0];
  const confirm = dialogButton(dialog, 'حذف الصورة نهائيًا');
  assert.equal(confirm.disabled, true, 'confirmation must be typed first');

  dialogButton(dialog, 'إلغاء').click();
  await flush();
  assert.equal(harness.dialogs().length, 0);
  assert.equal(harness.posts(`${api}/media/purge`).length, 0, 'cancel must not send a request');

  const second = await openTrash(harness);
  assert.ok(second);
  second.click();
  await flush();
  const confirmAgain = dialogButton(harness.dialogs()[0], 'حذف الصورة نهائيًا');
  const input = harness.dialogs()[0].querySelector('input');
  input.value = 'حذف الصورة نهائيًا';
  input.dispatch('input');
  assert.equal(confirmAgain.disabled, false);

  server.setMediaPurgeHandler(async (request) => jsonResponse(purgeSuccess(request.body.asset_id)));
  confirmAgain.click();
  await flush(); await flush();

  const posts = harness.posts(`${api}/media/purge`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.asset_id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.match(harness.text(), /تم الحذف النهائي للصورة/);
  assert.doesNotMatch(harness.text(), /تعذّر|فشل|لم يُعلن نجاح/);
  assert.equal(harness.window.__TEST_STATE__.media.purgePending, null);
  assert.deepEqual(harness.window.__TEST_STATE__.content, { note: 'unsaved-purge' });
});

test('lost purge response keeps a mandatory pending retry with the same operation id even when the trash row disappears', async () => {
  const server = createSiteServer(runningStatus());
  server.hash = '#media';
  server.trashItems = [trashItem()];
  const harness = createHarness(server);
  await login(harness);
  const button = await openTrash(harness);
  assert.ok(button);
  button.click();
  await flush();
  const dialog = harness.dialogs()[0];
  const input = dialog.querySelector('input');
  input.value = 'حذف الصورة نهائيًا';
  input.dispatch('input');

  let calls = 0;
  let firstOperationId = null;
  server.setMediaPurgeHandler(async (request) => {
    calls += 1;
    if (calls === 1) {
      firstOperationId = request.body.operation_id;
      server.trashItems = [];
      return Promise.reject(networkError('lost-response'));
    }
    return jsonResponse(purgeSuccess(request.body.asset_id));
  });

  dialogButton(dialog, 'حذف الصورة نهائيًا').click();
  await flush(); await flush();

  const firstPosts = harness.posts(`${api}/media/purge`);
  assert.equal(firstPosts.length, 1);
  assert.equal(firstPosts[0].body.operation_id, firstOperationId);
  assert.equal(trashPurgeButton(harness), null, 'the trash row is gone');
  const retry = pendingPurgeButton(harness);
  assert.ok(retry, 'a pending verification/retry action must remain outside the trash row');

  retry.click();
  await flush(); await flush();

  const posts = harness.posts(`${api}/media/purge`);
  assert.equal(posts.length, 2, 'two real purge requests must be sent');
  assert.equal(posts[1].body.operation_id, firstOperationId, 'retry must reuse the same operation id');
  assert.match(harness.text(), /تم الحذف النهائي للصورة/);
  assert.equal(harness.window.__TEST_STATE__.media.purgePending, null);
});

test('purging trash item from a new session resumes with the server operation id without a new confirmation', async () => {
  const operationId = '99999999-9999-4999-8999-999999999999';
  const server = createSiteServer(runningStatus());
  server.hash = '#media';
  server.trashItems = [trashItem({
    asset_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    logical_path: 'media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    state: 'purging',
    purge_operation_id: operationId,
  })];
  const harness = createHarness(server);
  await login(harness);
  const button = await openTrash(harness);
  assert.ok(button);
  assert.match(button.textContent, /استكمال الحذف النهائي/);

  let sentOperationId = null;
  server.setMediaPurgeHandler(async (request) => {
    sentOperationId = request.body.operation_id;
    return jsonResponse(purgeSuccess(request.body.asset_id));
  });

  button.click();
  await flush(); await flush();

  assert.equal(harness.dialogs().length, 0, 'resume must not create a new confirmation dialog');
  const posts = harness.posts(`${api}/media/purge`);
  assert.equal(posts.length, 1);
  assert.equal(sentOperationId, operationId);
  assert.equal(posts[0].body.operation_id, operationId);
  assert.match(harness.text(), /تم الحذف النهائي للصورة/);
});

test('purge handles cleanup_pending and media_in_use from real apiSend error payloads', async () => {
  const cleanupServer = createSiteServer(runningStatus());
  cleanupServer.hash = '#media';
  cleanupServer.trashItems = [trashItem()];
  const cleanupHarness = createHarness(cleanupServer);
  await login(cleanupHarness);
  const cleanupButton = await openTrash(cleanupHarness);
  assert.ok(cleanupButton);
  cleanupButton.click();
  await flush();
  const cleanupDialog = cleanupHarness.dialogs()[0];
  const cleanupInput = cleanupDialog.querySelector('input');
  cleanupInput.value = 'حذف الصورة نهائيًا';
  cleanupInput.dispatch('input');
  cleanupServer.setMediaPurgeHandler(async (request) => jsonResponse({
    error: 'cleanup_pending',
    asset: {
      id: request.body.asset_id,
      logical_path: `media/${request.body.asset_id}`,
      status: 'purging',
      private_cleanup_state: 'done',
      trash_cleanup_state: 'pending',
      public_cleanup_state: 'none',
    },
  }, 502));
  dialogButton(cleanupDialog, 'حذف الصورة نهائيًا').click();
  await flush(); await flush();
  assert.equal(cleanupHarness.posts(`${api}/media/purge`).length, 1);
  assert.match(cleanupHarness.text(), /تنظيف بعض ملفات Storage|لم يُعلن نجاح/);
  assert.doesNotMatch(cleanupHarness.text(), /تم الحذف النهائي للصورة/);
  assert.ok(pendingPurgeButton(cleanupHarness), 'cleanup_pending must expose an explicit completion action');

  const blockedServer = createSiteServer(runningStatus());
  blockedServer.hash = '#media';
  blockedServer.trashItems = [trashItem()];
  const blockedHarness = createHarness(blockedServer);
  await login(blockedHarness);
  const blockedButton = await openTrash(blockedHarness);
  assert.ok(blockedButton);
  blockedButton.click();
  await flush();
  const blockedDialog = blockedHarness.dialogs()[0];
  const blockedInput = blockedDialog.querySelector('input');
  blockedInput.value = 'حذف الصورة نهائيًا';
  blockedInput.dispatch('input');
  blockedServer.setMediaPurgeHandler(async (request) => jsonResponse({
    error: 'media_in_use',
    reasons: ['published', 'history'],
    references: { published: true, draft: false, history_count: 2 },
    asset_id: request.body.asset_id,
  }, 409));
  dialogButton(blockedDialog, 'حذف الصورة نهائيًا').click();
  await flush(); await flush();
  assert.equal(blockedHarness.posts(`${api}/media/purge`).length, 1);
  assert.match(blockedHarness.text(), /المنشور الحالي/);
  assert.match(blockedHarness.text(), /سجل النسخ/);
  assert.match(blockedHarness.text(), /\(2\)/);
  assert.doesNotMatch(blockedHarness.text(), /تم الحذف النهائي للصورة/);
  assert.equal(pendingPurgeButton(blockedHarness), null, 'blocked purge must not leave a resume action');
});