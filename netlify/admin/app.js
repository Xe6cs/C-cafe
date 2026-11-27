'use strict';
// لوحة تحرير المسودة: تسجيل الدخول عبر Supabase Auth، قراءة المسودة أو المحتوى
// المنشور، تحرير النصوص والروابط والإعدادات وترتيب الأقسام، حفظ المسودة عبر
// /api/admin/draft، نشر المسودة أو استعادة نسخة عبر RPC محمي، معاينة المسودة في
// iframe معزول، والتحقق من ظهور الإصدار على أصل معاينة Netlify.
//
// الأمان:
//   * الجلسة تبقى في الذاكرة فقط (persistSession: false) ولا تُخزَّن في
//     localStorage/sessionStorage أو الكوكيز.
//   * لا يُطبع البريد أو كلمة المرور أو رمز الوصول في السجل.
//   * كل النصوص تُدرج عبر textContent، ولا تُفسَّر بيانات المحتوى كـ HTML.
//   * النشر والاستعادة يمران عبر API إداري وJWT، ولا يُستدعى أي RPC مباشرة.
//   * رفع الصور يمر بثلاث خطوات: إنشاء مسار على الخادم، رفع مباشر إلى bucket
//     خاص بجلسة المدير، ثم تحقق خادمي من البايتات قبل الاعتماد. لا يُقبل من
//     العميل أي رابط تنزيل، ولا تُخزَّن روابط القراءة الموقعة.
(function () {
  const API = '/api/admin';
  const MAX_NOTE = 500;
  const MAX_OPERATION_NOTE = 200;
  const MAX_SITE_MESSAGE = 300;
  const TOAST_MS = 5000;
  const AUTOSAVE_MS = 1200;
  const MEDIA_TARGET_BYTES = 4 * 1024 * 1024;
  const MEDIA_COMPRESS_MAX_DIMENSION = 4000;
  const MEDIA_REFRESH_MS = 240000;
  const MEDIA_REF_RE = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  const EDITOR_VIEWS = new Set(['editor', 'texts', 'links', 'sections']);
  const VIEWS = new Set([...EDITOR_VIEWS, 'preview', 'published', 'history', 'media', 'stats', 'site-status']);

  const TITLES = {
    editor: 'كل المحتوى',
    texts: 'النصوص',
    links: 'الروابط',
    sections: 'ترتيب الأقسام',
    preview: 'معاينة المسودة',
    published: 'المحتوى المنشور',
    history: 'سجل النسخ',
    media: 'مكتبة الوسائط',
    stats: 'نشاط الزوار',
    'site-status': 'حالة الموقع',
  };

  const state = {
    client: null,
    token: '',
    session: null,
    user: null,
    published: null,
    working: null,
    content: null,
    snapshot: '',
    schema: null,
    history: [],
    historySummary: null,
    loadedAt: null,
    view: 'editor',
    busy: false,
    saveState: 'saved',
    saveError: '',
    saving: false,
    pending: false,
    saveTimer: null,
    conflict: null,
    preview: { loading: false, html: '', source: '', error: '', loadedAt: null },
    previewStale: true,
    publish: { busy: false, pending: null },
    restore: { busy: false, pending: null },
    historyClear: { busy: false, pending: null, confirming: false },
    siteStatus: {
      // `value` comes only from GET /api/admin/site-status. A write result is
      // historical confirmation; it is never treated as the current state.
      value: null,
      loaded: false,
      loading: false,
      loadSeq: 0,
      loadInflight: 0,
      error: '',
      busy: false,
      dialogBusy: false,
      currentUnconfirmed: false,
      notice: '',
      noticeKind: '',
      pending: null,
      confirmed: null,
    },
    media: {
      loaded: false,
      loadedAt: 0,
      loading: false,
      error: '',
      assets: [],
      originals: [],
      urls: {},
      limits: null,
      enabled: false,
      uploading: false,
      progress: '',
      action: { id: '', kind: '' },
      trash: {
        loaded: false,
        loadedAt: 0,
        loading: false,
        error: '',
        items: [],
      },
    },
    verify: {
      seq: 0,
      busy: false,
      version: null,
      state: 'idle',
      observed: null,
      detail: '',
      checkedAt: null,
    },
    ui: {
      openGroups: new Set(),
      closedGroups: new Set(),
      openItems: new Set(),
    },
  };

  const els = {};
  let toastSeq = 0;

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else if (key === 'hidden') node.hidden = Boolean(value);
        else if (key === 'disabled') node.disabled = Boolean(value);
        else if (key === 'checked') node.checked = Boolean(value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
          node.setAttribute(key, value === true ? '' : String(value));
        }
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function deepClone(value) {
    return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
  }

  function cacheElements() {
    for (const id of [
      'login-view', 'login-form', 'login-email', 'login-password',
      'login-error', 'login-submit', 'app-view', 'side-user', 'page-title',
      'session-note', 'refresh', 'logout', 'status-pill', 'save-btn',
      'publish-btn', 'preview-btn', 'delete-btn', 'status-banner', 'view', 'toasts',
    ]) {
      els[id] = byId(id);
    }
  }

  function formatDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', {
        timeZone: 'Asia/Baghdad',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString();
    }
  }

  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', {
        timeZone: 'Asia/Baghdad',
        hour: 'numeric',
        minute: '2-digit',
      }).format(date);
    } catch {
      return '';
    }
  }

  function toast(message, kind = 'info') {
    if (!els.toasts) return;
    const id = `toast-${++toastSeq}`;
    const node = el('div', {
      class: `toast toast-${kind}`,
      id,
      role: kind === 'error' ? 'alert' : 'status',
    }, el('span', { text: message }));
    els.toasts.append(node);
    window.setTimeout(() => {
      if (node.isConnected) node.remove();
    }, TOAST_MS);
  }

  // نافذة حوار أصلية: تحصر التركيز وتُغلق بـEscape أو بزر الإغلاق.
  // onClose يُستدعى مرة واحدة عند أي إغلاق، بما في ذلك Escape.
  function openModal({ title, body, actions, wide, onClose }) {
    const dialog = el('dialog', { class: `modal${wide ? ' modal-wide' : ''}` });
    let closed = false;

    function close() {
      if (closed) return;
      closed = true;
      if (dialog.open) dialog.close();
      else dialog.remove();
    }

    const head = el('div', { class: 'modal-head' },
      el('h2', { text: title || '' }),
      el('button', {
        class: 'btn-icon modal-close',
        type: 'button',
        'aria-label': 'إغلاق',
        onClick: close,
      }, '×'));
    const content = el('div', { class: 'modal-body' }, body || []);
    const footer = el('div', { class: 'modal-foot' },
      (actions || []).map((action) => el('button', {
        class: action.class || 'btn btn-ghost',
        type: 'button',
        disabled: action.disabled === true,
        onClick() {
          if (typeof action.onClick === 'function') action.onClick(close);
          else close();
        },
      }, action.label)));

    dialog.append(head, content, footer);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (typeof onClose === 'function') onClose();
    });

    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    const focusTarget = dialog.querySelector('button');
    if (focusTarget) focusTarget.focus();
    return close;
  }

  function confirmDialog({ title, text, confirmLabel, danger }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      openModal({
        title,
        body: el('p', { class: 'dialog-text', text: text || '' }),
        actions: [
          {
            label: 'إلغاء',
            class: 'btn btn-ghost',
            onClick(close) { done(false); close(); },
          },
          {
            label: confirmLabel || 'تأكيد',
            class: danger ? 'btn btn-danger' : 'btn btn-primary',
            onClick(close) { done(true); close(); },
          },
        ],
        // الإغلاق بـEscape أو زر × أو النقر خارج الحوار يُعد إلغاءً.
        onClose() { done(false); },
      });
    });
  }

  // حوار عملية نشر/استعادة: تأكيد صريح مع ملاحظة اختيارية (حد 200 حرفًا).
  function operationDialog({ title, text, confirmLabel, noteLabel }) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const input = el('input', {
        class: 'input',
        type: 'text',
        maxlength: String(MAX_OPERATION_NOTE),
        autocomplete: 'off',
        dir: 'auto',
        placeholder: 'اختياري',
      });
      const body = [
        el('p', { class: 'dialog-text', text: text || '' }),
        el('label', { class: 'field' },
          el('span', { class: 'field-label', text: noteLabel || 'ملاحظة اختيارية (تظهر في سجل النسخ)' }),
          input),
      ];
      openModal({
        title,
        body,
        actions: [
          {
            label: 'إلغاء',
            class: 'btn btn-ghost',
            onClick(close) { done(null); close(); },
          },
          {
            label: confirmLabel || 'تأكيد',
            class: 'btn btn-primary',
            onClick(close) {
              const note = input.value.trim().slice(0, MAX_OPERATION_NOTE);
              done({ note });
              close();
            },
          },
        ],
        onClose() { done(null); },
      });
    });
  }

  function newOperationId() {
    const cryptoObj = window.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
      return cryptoObj.randomUUID();
    }
    const bytes = new Uint8Array(16);
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
      throw new Error('crypto-unavailable');
    }
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // إعادة استخدام المعرّف لنفس الطلب فقط. إن تغيّرت النسخة أو المراجعة أو
  // الملاحظة، فهذا طلب مختلف ويأخذ معرّفًا جديدًا. makePending يسمح لحالة
  // الموقع بتخزين الطلب كاملًا بدل بصمة المعرّف وحدها.
  function operationIdFor(bucket, signature, makePending) {
    if (bucket.pending && bucket.pending.signature === signature) {
      return bucket.pending.operation_id || bucket.pending.operationId;
    }
    const operationId = newOperationId();
    bucket.pending = typeof makePending === 'function'
      ? makePending(operationId, signature)
      : { operationId, signature };
    return operationId;
  }

  function setLoginError(message) {
    els['login-error'].textContent = message || '';
    els['login-error'].hidden = !message;
  }

  function setLoginBusy(busy) {
    state.busy = busy;
    els['login-submit'].disabled = busy;
    els['login-email'].disabled = busy;
    els['login-password'].disabled = busy;
    els['login-submit'].textContent = busy ? 'جارٍ تسجيل الدخول…' : 'تسجيل الدخول';
  }

  function showLoginView() {
    els['app-view'].hidden = true;
    els['login-view'].hidden = false;
    els.view.replaceChildren();
    els['status-banner'].replaceChildren();
    els['login-password'].value = '';
  }

  function showAppView() {
    els['login-view'].hidden = true;
    els['app-view'].hidden = false;
    els['side-user'].textContent = state.user && state.user.email ? state.user.email : '';
    updateSessionNote();
    els.view.focus();
  }

  function updateSessionNote() {
    const expires = state.session ? formatClock(Number(state.session.expires_at)) : '';
    const loaded = state.loadedAt ? formatDateTime(state.loadedAt) : '';
    els['session-note'].textContent = expires
      ? `آخر تحديث ${loaded} · الجلسة صالحة حتى ${expires}`
      : `آخر تحديث ${loaded}`;
  }

  function resetState() {
    clearTimeout(state.saveTimer);
    state.token = '';
    state.session = null;
    state.user = null;
    state.published = null;
    state.working = null;
    state.content = null;
    state.snapshot = '';
    state.schema = null;
    state.history = [];
    state.historySummary = null;
    state.loadedAt = null;
    state.saveState = 'saved';
    state.saveError = '';
    state.saving = false;
    state.pending = false;
    state.conflict = null;
    state.preview = { loading: false, html: '', source: '', error: '', loadedAt: null };
    state.previewStale = true;
    state.publish = { busy: false, pending: null };
    state.restore = { busy: false, pending: null };
    state.historyClear = { busy: false, pending: null, confirming: false };
    state.siteStatus = {
      value: null,
      loaded: false,
      loading: false,
      loadSeq: 0,
      loadInflight: 0,
      error: '',
      busy: false,
      dialogBusy: false,
      currentUnconfirmed: false,
      notice: '',
      noticeKind: '',
      pending: null,
      confirmed: null,
    };
    state.media = {
      loaded: false,
      loadedAt: 0,
      loading: false,
      error: '',
      assets: [],
      originals: [],
      urls: {},
      limits: null,
      enabled: false,
      uploading: false,
      progress: '',
      action: { id: '', kind: '' },
      trash: {
        loaded: false,
        loadedAt: 0,
        loading: false,
        error: '',
        items: [],
      },
    };
    state.verify = {
      seq: 0,
      busy: false,
      version: null,
      state: 'idle',
      observed: null,
      detail: '',
      checkedAt: null,
    };
    state.ui.openGroups.clear();
    state.ui.closedGroups.clear();
    state.ui.openItems.clear();
    els['side-user'].textContent = '';
    els['session-note'].textContent = '';
  }

  async function localSignOut() {
    if (!state.client) return;
    try {
      await state.client.auth.signOut({ scope: 'local' });
    } catch {
      // الجلسة في الذاكرة فقط؛ تجاهل خطأ الإنهاء المحلي.
    }
  }

  async function endSession(message) {
    await localSignOut();
    resetState();
    showLoginView();
    if (message) setLoginError(message);
  }

  function createClient() {
    const config = window.CCAFE_ADMIN_CONFIG;
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error('config');
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('vendor');
    }
    return window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        flowType: 'implicit',
        // حتى لو تغيّر الافتراضي مستقبلًا، لا تُكتب الجلسة في أي تخزين دائم.
        storage: {
          getItem() { return null; },
          setItem() {},
          removeItem() {},
        },
      },
    });
  }

  function authErrorMessage(error) {
    const value = String(
      (error && (error.code || error.message || error.error_description)) || '',
    ).toLowerCase();
    if (value.includes('invalid login credentials') || value.includes('invalid_credentials')) {
      return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
    }
    if (value.includes('email not confirmed') || value.includes('email_not_confirmed')) {
      return 'هذا الحساب غير مؤكد. لا يمكن إكمال الدخول.';
    }
    if (value.includes('too many') || value.includes('rate limit') || value.includes('over_email_send_rate_limit')) {
      return 'محاولات دخول كثيرة. انتظر قليلًا ثم حاول مجددًا.';
    }
    if (value.includes('user not found') || value.includes('user_not_found')) {
      return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
    }
    return 'تعذّر تسجيل الدخول. تحقق من الاتصال ثم حاول مجددًا.';
  }

  function requestHeaders(accept) {
    return {
      Authorization: `Bearer ${state.token}`,
      Accept: accept || 'application/json',
    };
  }

  async function apiGet(path) {
    if (!state.token) {
      const error = new Error('missing-session');
      error.status = 401;
      throw error;
    }
    const response = await fetch(path, {
      method: 'GET',
      headers: requestHeaders('application/json'),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error('admin-request-failed');
      error.status = response.status;
      error.code = data && typeof data.error === 'string' ? data.error : '';
      throw error;
    }
    if (!data || typeof data !== 'object') {
      const error = new Error('invalid-response');
      error.status = 502;
      throw error;
    }
    return data;
  }

  async function apiSend(path, body) {
    if (!state.token) {
      const error = new Error('missing-session');
      error.status = 401;
      throw error;
    }
    const response = await fetch(path, {
      method: 'POST',
      headers: {
        ...requestHeaders('application/json'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error('admin-request-failed');
      error.status = response.status;
      error.code = data && typeof data.error === 'string' ? data.error : '';
      error.payload = data;
      throw error;
    }
    if (!data || typeof data !== 'object') {
      const error = new Error('invalid-response');
      error.status = 502;
      throw error;
    }
    return data;
  }

  async function apiGetText(path) {
    if (!state.token) {
      const error = new Error('missing-session');
      error.status = 401;
      throw error;
    }
    const response = await fetch(path, {
      method: 'GET',
      headers: requestHeaders('text/html'),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error('admin-request-failed');
      error.status = response.status;
      error.code = '';
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.error === 'string') error.code = parsed.error;
      } catch {
        // الرد ليس JSON؛ لا نعرض نص الخطأ الخام.
      }
      throw error;
    }
    return {
      text,
      source: response.headers.get('X-CCafe-Preview-Source') || '',
    };
  }

  function normalizeEntry(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Number.isSafeInteger(value.id) || value.id < 1) return null;
    if (!Number.isSafeInteger(value.version) || value.version < 1) return null;
    if (typeof value.created_at !== 'string') return null;
    const note = typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE) : null;
    return { id: value.id, version: value.version, created_at: value.created_at, note };
  }

  function normalizeHistory(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeEntry).filter(Boolean);
  }

  function normalizeMediaAsset(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.id !== 'string' || !window.CcafeEditor.MEDIA_RE.test(`media/${value.id}`)) return null;
    const logical = typeof value.logical_path === 'string' ? value.logical_path : '';
    if (logical !== `media/${value.id}`) return null;
    if (!['pending', 'approved', 'failed'].includes(value.status)) return null;
    if (typeof value.original_name !== 'string') return null;
    if (typeof value.created_at !== 'string') return null;
    const asset = {
      id: value.id,
      logical_path: logical,
      status: value.status,
      original_name: value.original_name.slice(0, 120),
      created_at: value.created_at,
      finalized_at: typeof value.finalized_at === 'string' ? value.finalized_at : null,
      selectable: value.status === 'approved' && value.selectable === true,
    };
    if (asset.status === 'approved') {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
      if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) return null;
      if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
      if (value.width < 1 || value.height < 1) return null;
      asset.mime = value.mime;
      asset.bytes = value.bytes;
      asset.width = value.width;
      asset.height = value.height;
    } else {
      asset.selectable = false;
      asset.failure_reason = typeof value.failure_reason === 'string'
        ? value.failure_reason.slice(0, 200)
        : null;
    }
    return asset;
  }

  function normalizeOriginal(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.logical_path !== 'string'
      || !/^assets\/[A-Za-z0-9_./-]+$/.test(value.logical_path)
      || value.logical_path.includes('..')) {
      return null;
    }
    if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
    return {
      logical_path: value.logical_path,
      label: typeof value.label === 'string' ? value.label.slice(0, 120) : value.logical_path,
      kind: value.kind === 'brand' ? 'brand' : 'photo',
      mime: typeof value.mime === 'string' ? value.mime : '',
      bytes: Number.isSafeInteger(value.bytes) ? value.bytes : 0,
      width: value.width,
      height: value.height,
    };
  }

  function normalizeMedia(data) {
    if (!isPlainObject(data)) return null;
    if (!Array.isArray(data.assets) || !Array.isArray(data.originals)) return null;
    const assets = data.assets.map(normalizeMediaAsset);
    const originals = data.originals.map(normalizeOriginal);
    if (assets.some((item) => !item) || originals.some((item) => !item)) return null;

    const urls = {};
    if (isPlainObject(data.urls)) {
      for (const [key, url] of Object.entries(data.urls)) {
        if (!MEDIA_REF_RE.test(key)) continue;
        if (typeof url !== 'string' || !/^https:\/\//i.test(url)) continue;
        urls[key] = url;
      }
    }

    const limits = isPlainObject(data.limits) ? {
      max_bytes: Number.isSafeInteger(data.limits.max_bytes) ? data.limits.max_bytes : 0,
      max_dimension: Number.isSafeInteger(data.limits.max_dimension) ? data.limits.max_dimension : 0,
      max_pixels: Number.isSafeInteger(data.limits.max_pixels) ? data.limits.max_pixels : 0,
      mime_types: Array.isArray(data.limits.mime_types)
        ? data.limits.mime_types.filter((mime) => ['image/png', 'image/jpeg', 'image/webp'].includes(mime))
        : ['image/png', 'image/jpeg', 'image/webp'],
      preview_ttl_seconds: Number.isSafeInteger(data.limits.preview_ttl_seconds)
        ? data.limits.preview_ttl_seconds
        : 0,
    } : null;

    return {
      assets,
      originals,
      urls,
      limits,
      enabled: data.media_enabled === true,
    };
  }

  function normalizeTrashItem(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.asset_id !== 'string'
      || !window.CcafeEditor.MEDIA_RE.test(`media/${value.asset_id}`)) {
      return null;
    }
    if (value.logical_path !== `media/${value.asset_id}`) return null;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)) return null;
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1) return null;
    if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)) return null;
    if (value.width < 1 || value.height < 1) return null;
    if (typeof value.original_name !== 'string') return null;
    if (value.state !== 'trashed' && value.state !== 'restoring') return null;
    if (value.cleanup_state !== 'pending' && value.cleanup_state !== 'done') return null;
    if (value.public_cleanup_state !== undefined
      && value.public_cleanup_state !== 'none'
      && value.public_cleanup_state !== 'pending'
      && value.public_cleanup_state !== 'done') return null;
    return {
      asset_id: value.asset_id,
      logical_path: value.logical_path,
      original_name: value.original_name.slice(0, 120),
      mime: value.mime,
      bytes: value.bytes,
      width: value.width,
      height: value.height,
      deleted_at: typeof value.deleted_at === 'string' ? value.deleted_at : null,
      state: value.state,
      cleanup_state: value.cleanup_state,
      cleanup_error: typeof value.cleanup_error === 'string'
        ? value.cleanup_error.slice(0, 200)
        : null,
      public_cleanup_state: value.public_cleanup_state === 'pending'
        || value.public_cleanup_state === 'done'
        ? value.public_cleanup_state
        : 'none',
      public_cleanup_error: typeof value.public_cleanup_error === 'string'
        ? value.public_cleanup_error.slice(0, 200)
        : null,
      restore_error: typeof value.restore_error === 'string'
        ? value.restore_error.slice(0, 200)
        : null,
    };
  }

  function normalizeTrash(data) {
    if (!isPlainObject(data) || !Array.isArray(data.items)) return null;
    const items = data.items.map(normalizeTrashItem);
    if (items.some((item) => !item)) return null;
    return { items, enabled: data.media_enabled === true };
  }

  function normalizeUsage(value) {
    if (!isPlainObject(value)) return null;
    if (typeof value.asset_id !== 'string') return null;
    if (typeof value.deletable !== 'boolean') return null;
    const reasons = Array.isArray(value.reasons)
      ? value.reasons.filter((item) => typeof item === 'string')
      : [];
    const refs = isPlainObject(value.references) ? value.references : {};
    return {
      asset_id: value.asset_id,
      deletable: value.deletable,
      reasons,
      references: {
        published: refs.published === true,
        draft: refs.draft === true,
        history_count: Number.isSafeInteger(refs.history_count) ? refs.history_count : 0,
        public_state: typeof refs.public_state === 'string' ? refs.public_state : null,
      },
    };
  }

  function mediaActionBusy(id, kind) {
    return state.media.action.id === id
      && (kind ? state.media.action.kind === kind : true);
  }

  function anyMediaAction() {
    return Boolean(state.media.action.id);
  }

  async function loadMedia(force) {
    if (!state.user || state.media.loading) return;
    if (!force && state.media.loaded
      && Date.now() - state.media.loadedAt < MEDIA_REFRESH_MS) {
      return;
    }
    const wasLoaded = state.media.loaded;
    state.media.loading = true;
    state.media.error = '';
    if (state.view === 'media') renderMediaView();
    try {
      const data = await apiGet(`${API}/media`);
      const media = normalizeMedia(data);
      if (!media) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }
      state.media.assets = media.assets;
      state.media.originals = media.originals;
      state.media.urls = media.urls;
      state.media.limits = media.limits;
      state.media.enabled = media.enabled;
      state.media.loaded = true;
      state.media.loadedAt = Date.now();
    } catch (error) {
      if (error && error.status === 401) {
        state.media.error = 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مجددًا.';
      } else if (error && error.status === 403) {
        state.media.error = 'هذا الحساب لا يملك صلاحية قراءة مكتبة الوسائط.';
      } else {
        state.media.error = 'تعذّر تحميل مكتبة الوسائط. تحقق من الاتصال ثم أعد المحاولة.';
      }
    } finally {
      state.media.loading = false;
      if (state.view === 'media') renderMediaView();
      else if (state.view !== 'media' && state.user) updateStatus();
      // After a reload the editor may already hold approved `media/<uuid>`
      // references while `state.media.urls` is still empty, so the previews
      // render as placeholders. Re-render once the first media load resolves.
      if (!wasLoaded && state.media.loaded && state.content
        && EDITOR_VIEWS.has(state.view)) {
        renderEditorView();
      }
    }
  }

  async function loadTrash(force) {
    if (!state.user || state.media.trash.loading) return;
    if (!force && state.media.trash.loaded
      && Date.now() - state.media.trash.loadedAt < MEDIA_REFRESH_MS) {
      return;
    }
    state.media.trash.loading = true;
    state.media.trash.error = '';
    if (state.view === 'media') renderMediaView();
    try {
      const data = await apiGet(`${API}/media/trash`);
      const trash = normalizeTrash(data);
      if (!trash) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }
      state.media.trash.items = trash.items;
      state.media.trash.loaded = true;
      state.media.trash.loadedAt = Date.now();
    } catch (error) {
      if (error && error.status === 401) {
        state.media.trash.error = 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مجددًا.';
      } else if (error && error.status === 403) {
        state.media.trash.error = 'هذا الحساب لا يملك صلاحية قراءة سلة المهملات.';
      } else {
        state.media.trash.error = 'تعذّر تحميل سلة المهملات. تحقق من الاتصال ثم أعد المحاولة.';
      }
    } finally {
      state.media.trash.loading = false;
      if (state.view === 'media') renderMediaView();
    }
  }

  async function refreshMediaLibrary() {
    state.media.loaded = false;
    state.media.trash.loaded = false;
    await Promise.all([loadMedia(true), loadTrash(true)]);
  }

  function mediaActionErrorText(error, action) {
    if (error && error.status === 401) {
      return 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مجددًا.';
    }
    if (error && error.status === 403) {
      return 'هذا الحساب لا يملك صلاحية إدارة الصور.';
    }
    if (error && error.status === 404) {
      return 'الصورة غير موجودة أو لم تعد متاحة. أعد تحميل المكتبة.';
    }
    if (error && error.status === 409) {
      return action === 'restore'
        ? 'تعارض في الاسترداد: الملف الحالي لا يطابق النسخة المحفوظة. لم يُستبدل أي ملف.'
        : 'تعارض: تغيّرت حالة الصورة. أعد تحميل المكتبة ثم حاول مجددًا.';
    }
    if (error && error.code === 'media_object_missing') {
      return 'ملف الصورة مفقود من التخزين؛ لم تُحذف أو تُستعد. راجع السلة أو اتصل بالمسؤول.';
    }
    if (error && error.code === 'media_unavailable') {
      return 'خدمة إدارة الصور غير مهيأة على الخادم.';
    }
    if (error && error.code === 'storage_unavailable') {
      return 'تعذّر الوصول إلى التخزين. لم تكتمل العملية؛ أعد المحاولة.';
    }
    return action === 'restore'
      ? 'تعذّر استرداد الصورة. بقيت في سلة المهملات.'
      : 'تعذّر حذف الصورة. لم يتغيّر شيء.';
  }

  function mediaUsageReasonText(reason) {
    switch (reason) {
      case 'not_approved':
        return 'الصورة غير معتمدة أو أنها ليست في المكتبة النشطة.';
      case 'published':
        return 'الصورة مستخدمة في المحتوى المنشور الحالي.';
      case 'draft':
        return 'الصورة مستخدمة في المسودة الحالية.';
      case 'history':
        return 'الصورة مستخدمة في نسخة محفوظة في سجل النسخ.';
      default:
        return 'الصورة مرتبطة بمحتوى محفوظ.';
    }
  }

  function mediaUsageList(usage) {
    return el('ul', { class: 'media-reasons' }, usage.reasons.map((reason) =>
      el('li', { text: mediaUsageReasonText(reason) })));
  }

  function showMediaUsageBlocked(asset, usage) {
    openModal({
      title: 'لا يمكن حذف الصورة',
      body: [
        el('p', {
          class: 'dialog-text',
          text: `الصورة «${asset.original_name || asset.logical_path}» ما زالت مرتبطة بمحتوى محفوظ، لذلك لم تُحذف.`,
        }),
        usage && usage.reasons.length ? mediaUsageList(usage) : null,
        el('p', {
          class: 'group-hint',
          text: 'أزل الصورة من المنشور والمسودة أولًا. لا يمكن حذف نسخة من السجل أو تعديل المحتوى المنشور لتحرير صورة من مراجعها.',
        }),
      ],
      actions: [{ label: 'إغلاق' }],
    });
  }

  function deleteMediaConfirm(asset) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      openModal({
        title: 'حذف صورة مرفوعة',
        body: el('div', { class: 'media-confirm' },
          mediaThumb(state.media.urls[asset.logical_path], asset.original_name),
          el('div', { class: 'media-confirm-info' },
            el('p', {
              class: 'dialog-text',
              text: `ستُنقل الصورة «${asset.original_name}» إلى سلة المهملات وتبقى قابلة للاسترداد.`,
            }),
            el('p', {
              class: 'group-hint',
              text: 'لن تُحذف الأصول الأصلية. لا يوجد حذف نهائي تلقائي، ولا تُحذف صورة مستخدمة في المنشور أو المسودة أو السجل.',
            }))),
        actions: [
          {
            label: 'إلغاء',
            class: 'btn btn-ghost',
            onClick(close) { done(false); close(); },
          },
          {
            label: 'حذف إلى السلة',
            class: 'btn btn-danger',
            onClick(close) { done(true); close(); },
          },
        ],
        onClose() { done(false); },
      });
    });
  }

  async function deleteMediaAsset(asset) {
    if (!state.user || anyMediaAction() || asset.status !== 'approved') return;

    state.media.action = { id: asset.id, kind: 'usage' };
    renderMediaView();
    try {
      const data = await apiGet(`${API}/media/usage?id=${encodeURIComponent(asset.id)}`);
      const usage = normalizeUsage(data.usage);
      if (!usage || !usage.deletable) {
        showMediaUsageBlocked(asset, usage);
        return;
      }

      const confirmed = await deleteMediaConfirm(asset);
      if (!confirmed) return;

      state.media.action = { id: asset.id, kind: 'delete' };
      renderMediaView();

      const result = await apiSend(`${API}/media/delete`, {
        asset_id: asset.id,
        operation_id: newOperationId(),
      });
      if (!result || !isPlainObject(result.asset) || result.asset.status !== 'trashed') {
        throw new Error('invalid-response');
      }
      const clean = result.asset.cleanup_state === 'done'
        && result.asset.public_cleanup_state !== 'pending';
      toast(
        clean
          ? 'نُقلت الصورة إلى سلة المهملات ويمكن استردادها.'
          : 'نُقلت الصورة إلى سلة المهملات، وما زال تنظيف بعض الملفات معلّقًا ويمكن إعادة المحاولة.',
        clean ? 'success' : 'info',
      );
      await refreshMediaLibrary();
    } catch (error) {
      if (error && error.status === 409 && error.code === 'media_in_use') {
        const payload = isPlainObject(error.payload) ? error.payload : {};
        showMediaUsageBlocked(asset, {
          deletable: false,
          reasons: Array.isArray(payload.reasons)
            ? payload.reasons.filter((item) => typeof item === 'string')
            : [],
        });
      } else {
        toast(mediaActionErrorText(error, 'delete'), 'error');
      }
    } finally {
      state.media.action = { id: '', kind: '' };
      if (state.view === 'media') renderMediaView();
    }
  }

  async function restoreMediaAsset(item) {
    if (!state.user || anyMediaAction()) return;
    const confirmed = await confirmDialog({
      title: 'استرداد صورة',
      text: `سيعاد الملف «${item.original_name}» بعد التحقق من تطابق بايتاته مع النسخة المحفوظة، ثم يصبح قابلًا للاختيار من جديد.`,
      confirmLabel: 'استرداد',
    });
    if (!confirmed) return;

    state.media.action = { id: item.asset_id, kind: 'restore' };
    renderMediaView();
    try {
      const result = await apiSend(`${API}/media/restore`, {
        asset_id: item.asset_id,
        operation_id: newOperationId(),
      });
      if (!result || !isPlainObject(result.asset) || result.asset.status !== 'approved') {
        throw new Error('invalid-response');
      }
      toast('استُعيدت الصورة وأصبحت متاحة للاختيار.', 'success');
      await refreshMediaLibrary();
    } catch (error) {
      toast(mediaActionErrorText(error, 'restore'), 'error');
      await loadTrash(true);
    } finally {
      state.media.action = { id: '', kind: '' };
      if (state.view === 'media') renderMediaView();
    }
  }

  async function cleanupMediaAsset(item) {
    if (!state.user || anyMediaAction()) return;
    state.media.action = { id: item.asset_id, kind: 'cleanup' };
    renderMediaView();
    try {
      const result = await apiSend(`${API}/media/cleanup`, { asset_id: item.asset_id });
      if (!result || (result.cleanup_state !== 'done' && result.cleanup_state !== 'pending')) {
        throw new Error('invalid-response');
      }
      const publicPending = result.public_cleanup_state === 'pending';
      if (result.cleanup_state === 'done' && !publicPending) {
        toast('اكتمل تنظيف الملفات المؤقتة.', 'success');
      } else {
        toast(
          publicPending
            ? 'تعذّر تنظيف النسخة العامة. سلة المهملات سليمة ويمكن إعادة المحاولة.'
            : 'تعذّر تنظيف الملف الأصلي. سلة المهملات سليمة ويمكن إعادة المحاولة.',
          'error',
        );
      }
      await loadTrash(true);
    } catch (error) {
      toast(mediaActionErrorText(error, 'cleanup'), 'error');
    } finally {
      state.media.action = { id: '', kind: '' };
      if (state.view === 'media') renderMediaView();
    }
  }

  function mediaErrorText(reason) {
    switch (reason) {
      case 'svg_not_allowed':
        return 'صيغة SVG غير مسموحة للرفع. استخدم PNG أو JPEG أو WebP.';
      case 'unsupported_type':
      case 'mime_mismatch':
        return 'نوع الملف لا يطابق محتواه أو غير مدعوم. المسموح: PNG أو JPEG أو WebP.';
      case 'decode_failed':
        return 'تعذّر فك الصورة؛ الملف تالف أو ليست صورة صالحة.';
      case 'too_large':
        return 'حجم الصورة أكبر من الحد المسموح (15 MiB).';
      case 'dimension_too_large':
        return 'أبعاد الصورة أكبر من الحد المسموح (8000 بكسل لكل بُعد).';
      case 'pixels_too_large':
        return 'عدد بكسلات الصورة أكبر من الحد المسموح (32 مليون بكسل).';
      case 'empty':
        return 'الملف فارغ.';
      case 'verifier_unavailable':
        return 'التحقق من الصور غير متاح على الخادم الآن.';
      default:
        return 'تعذّر اعتماد الصورة. لم تُضف إلى المكتبة.';
    }
  }

  function uploadErrorText(error) {
    const reason = error && error.reason ? error.reason : '';
    if (reason) return mediaErrorText(reason);
    if (error && error.code === 'invalid_image') return mediaErrorText(error.payload && error.payload.reason);
    if (error && error.status === 401) return 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مجددًا.';
    if (error && error.status === 403) return 'هذا الحساب لا يملك صلاحية رفع الصور.';
    if (error && error.status === 409) return 'تعارض: تغيّرت حالة الملف. أعد تحميل المكتبة ثم حاول مجددًا.';
    if (error && error.status === 413) return 'حجم الطلب أكبر من الحد المسموح.';
    if (error && error.code === 'media_unavailable') return 'خدمة اعتماد الصور غير مهيأة على الخادم.';
    if (error && error.code === 'upload_not_ready') return 'لم يصل الملف إلى التخزين بعد. أعد المحاولة بعد لحظات.';
    return 'تعذّر رفع الصورة. لم تُضف إلى المكتبة.';
  }

  function readImageSize(file) {
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(file).then((bitmap) => ({
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close() { if (typeof bitmap.close === 'function') bitmap.close(); },
      })).catch(() => null);
    }
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve({
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        close() { URL.revokeObjectURL(url); },
      });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/webp', quality);
    });
  }

  async function compressImage(decoded, maxBytes) {
    let scale = Math.min(
      1,
      MEDIA_COMPRESS_MAX_DIMENSION / Math.max(decoded.width, decoded.height),
    );
    let last = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const width = Math.max(1, Math.round(decoded.width * scale));
      const height = Math.max(1, Math.round(decoded.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(decoded.source, 0, 0, width, height);
      const blob = await canvasBlob(canvas, Math.max(0.5, 0.92 - attempt * 0.1));
      if (blob && blob.size > 0) {
        last = { blob, width, height };
        if (blob.size <= maxBytes) return last;
      }
      scale *= 0.8;
    }
    return last;
  }

  function storageOrigin() {
    const config = window.CCAFE_ADMIN_CONFIG;
    if (!config || typeof config.supabaseUrl !== 'string') return '';
    try {
      const url = new URL(config.supabaseUrl);
      return url.protocol === 'https:' ? url.origin : '';
    } catch {
      return '';
    }
  }

  async function uploadMediaFile(file) {
    const limits = state.media.limits || {
      max_bytes: 15 * 1024 * 1024,
      max_dimension: 8000,
      max_pixels: 32000000,
      mime_types: ['image/png', 'image/jpeg', 'image/webp'],
    };
    if (!state.media.enabled) {
      toast('رفع الصور غير مهيأ على الخادم. راجع إعدادات النشر.', 'error');
      return false;
    }
    if (!file || !limits.mime_types.includes(file.type)) {
      toast('نوع الملف غير مدعوم. المسموح: PNG أو JPEG أو WebP.', 'error');
      return false;
    }
    if (file.size < 1 || file.size > limits.max_bytes) {
      toast(mediaErrorText('too_large'), 'error');
      return false;
    }

    const decoded = await readImageSize(file);
    if (!decoded) {
      toast(mediaErrorText('decode_failed'), 'error');
      return false;
    }

    let payload = file;
    let uploadWidth = decoded.width;
    let uploadHeight = decoded.height;
    try {
      if (uploadWidth < 1 || uploadHeight < 1) {
        toast(mediaErrorText('decode_failed'), 'error');
        return false;
      }
      if (uploadWidth > limits.max_dimension || uploadHeight > limits.max_dimension) {
        toast(mediaErrorText('dimension_too_large'), 'error');
        return false;
      }
      if (uploadWidth * uploadHeight > limits.max_pixels) {
        toast(mediaErrorText('pixels_too_large'), 'error');
        return false;
      }

      if (file.size > MEDIA_TARGET_BYTES) {
        const compressed = await compressImage(decoded, MEDIA_TARGET_BYTES);
        if (!compressed || !compressed.blob || compressed.blob.size > limits.max_bytes) {
          toast('تعذّر ضغط الصورة إلى الحجم المسموح. جرّب صورة أصغر.', 'error');
          return false;
        }
        payload = new File([compressed.blob], file.name, {
          type: compressed.blob.type || 'image/webp',
          lastModified: file.lastModified,
        });
        uploadWidth = compressed.width;
        uploadHeight = compressed.height;
      }

      const mime = payload.type;
      if (!limits.mime_types.includes(mime)) {
        toast(mediaErrorText('unsupported_type'), 'error');
        return false;
      }

      const name = (file.name || 'image').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'image';
      state.media.uploading = true;
      state.media.progress = `جارٍ رفع ${name}…`;
      if (state.view === 'media') renderMediaView();

      let assetId = '';
      try {
        const created = await apiSend(`${API}/media`, {
          original_name: name,
          declared_mime: mime,
          declared_bytes: payload.size,
        });
        const asset = created && created.asset;
        if (!asset || typeof asset.id !== 'string'
          || asset.logical_path !== `media/${asset.id}`
          || !MEDIA_REF_RE.test(asset.logical_path)) {
          const error = new Error('invalid-response');
          error.status = 502;
          throw error;
        }
        assetId = asset.id;

        const origin = storageOrigin();
        if (!origin) {
          const error = new Error('config');
          error.status = 503;
          throw error;
        }
        const uploadUrl = `${origin}/storage/v1/object/ccafe-media/${asset.logical_path}`;
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            apikey: String(window.CCAFE_ADMIN_CONFIG.supabaseAnonKey || ''),
            Authorization: `Bearer ${state.token}`,
            'Content-Type': mime,
            'x-upsert': 'false',
          },
          body: payload,
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) {
          const error = new Error('upload-failed');
          error.status = response.status === 409 ? 409 : 502;
          throw error;
        }

        const finalized = await apiSend(`${API}/media/finalize`, { asset_id: assetId });
        const approved = finalized && finalized.asset;
        if (!approved || approved.id !== assetId
          || approved.logical_path !== asset.logical_path
          || approved.status !== 'approved'
          || approved.selectable !== true) {
          const error = new Error('invalid-response');
          error.status = 502;
          throw error;
        }

        toast(`اعتُمدت الصورة «${name}» وأصبحت متاحة للاختيار.`, 'success');
        return true;
      } catch (error) {
        if (assetId) {
          try {
            await apiSend(`${API}/media/abandon`, { asset_id: assetId });
          } catch {
            // تنظيف أفضل جهد: تبقى السجلات مرئية للمدير إن فشل الإلغاء.
          }
        }
        toast(uploadErrorText(error), 'error');
        return false;
      } finally {
        state.media.uploading = false;
        state.media.progress = '';
        loadMedia(true);
      }
    } finally {
      decoded.close();
    }
  }

  async function handleMediaFiles(fileList) {
    if (!state.user || state.media.uploading) return;
    const files = Array.from(fileList || []);
    for (const file of files) {
      if (state.media.uploading) break;
      // Sequential uploads keep the UI readable and avoid parallel finalize calls.
      await uploadMediaFile(file);
    }
  }

  function validSchema(value) {
    return isPlainObject(value)
      && Array.isArray(value.groups)
      && Array.isArray(value.linkTokens)
      && Array.isArray(value.linkAnchors)
      && value.groups.length > 0;
  }

  function validWorking(value) {
    return isPlainObject(value)
      && (value.source === 'draft' || value.source === 'published')
      && isPlainObject(value.content)
      && (value.revision_id === null || typeof value.revision_id === 'string')
      && Number.isSafeInteger(value.base_version)
      && value.base_version >= 1
      && (value.updated_at === null || typeof value.updated_at === 'string');
  }

  function applyBootstrap(data, reset) {
    if (!data.user || typeof data.user.id !== 'string') {
      const error = new Error('invalid-user');
      error.status = 502;
      throw error;
    }
    if (!data.published || !Number.isSafeInteger(data.published.version)
      || !isPlainObject(data.published.content)) {
      const error = new Error('invalid-published');
      error.status = 502;
      throw error;
    }
    if (!validWorking(data.working)) {
      const error = new Error('invalid-working');
      error.status = 502;
      throw error;
    }
    if (!validSchema(data.schema)) {
      const error = new Error('invalid-schema');
      error.status = 502;
      throw error;
    }

    state.user = {
      id: data.user.id,
      email: typeof data.user.email === 'string' ? data.user.email : '',
    };
    state.published = {
      version: data.published.version,
      content: data.published.content,
      saved_at: typeof data.published.saved_at === 'string' ? data.published.saved_at : '',
    };
    state.working = {
      source: data.working.source,
      content: data.working.content,
      revision_id: data.working.revision_id,
      base_version: data.working.base_version,
      updated_at: data.working.updated_at,
    };
    state.schema = {
      groups: data.schema.groups,
      linkTokens: data.schema.linkTokens,
      linkAnchors: data.schema.linkAnchors,
    };
    state.historySummary = data.history && typeof data.history === 'object'
      ? {
        count: Number.isSafeInteger(data.history.count) ? data.history.count : 0,
        latest: normalizeEntry(data.history.latest),
      }
      : { count: 0, latest: null };

    if (reset) {
      state.content = deepClone(state.working.content);
      state.snapshot = JSON.stringify(state.content);
      state.saveState = 'saved';
      state.saveError = '';
      state.saving = false;
      state.pending = false;
      state.conflict = null;
      state.previewStale = true;
    }
  }

  async function loadDashboard(reset) {
    const bootstrap = await apiGet(`${API}/bootstrap`);
    applyBootstrap(bootstrap, reset);
    const history = await apiGet(`${API}/history`);
    state.history = normalizeHistory(history.entries);
    state.loadedAt = new Date();
    render();
    showAppView();
    loadMedia(true);
  }

  async function onLogin(event) {
    event.preventDefault();
    if (state.busy) return;

    const email = els['login-email'].value.trim();
    const password = els['login-password'].value;
    setLoginError('');

    if (!email || !password) {
      setLoginError('أدخل البريد الإلكتروني وكلمة المرور.');
      return;
    }

    setLoginBusy(true);
    try {
      const result = await state.client.auth.signInWithPassword({ email, password });
      if (result.error) {
        setLoginError(authErrorMessage(result.error));
        return;
      }
      const session = result.data && result.data.session;
      if (!session || !session.access_token) {
        setLoginError('تعذّر إنشاء الجلسة. حاول مرة أخرى.');
        return;
      }

      state.session = session;
      state.token = session.access_token;
      els['login-password'].value = '';
      await loadDashboard(true);
      await loadSiteStatus(true);
    } catch (error) {
      if (error && error.status === 401) {
        await endSession('انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مرة أخرى.');
      } else if (error && error.status === 403) {
        await endSession('هذا الحساب لا يملك صلاحية المدير.');
      } else {
        await localSignOut();
        resetState();
        showLoginView();
        setLoginError('تعذّر تحميل بيانات الإدارة. تحقق من الاتصال ثم حاول مجددًا.');
      }
    } finally {
      setLoginBusy(false);
    }
  }

  async function onLogout() {
    if (state.busy) return;
    if (hasUnsavedChanges()) {
      const ok = await confirmDialog({
        title: 'تسجيل الخروج',
        text: 'لديك تغييرات غير محفوظة. تسجيل الخروج سيتجاهلها. هل تريد المتابعة؟',
        confirmLabel: 'تسجيل الخروج',
        danger: true,
      });
      if (!ok) return;
    }
    state.busy = true;
    try {
      if (state.client) await state.client.auth.signOut({ scope: 'global' });
    } catch {
      // حتى لو فشل إنهاء الجلسة عالميًا، تُمسح النسخة المحلية فورًا.
    } finally {
      state.busy = false;
      resetState();
      showLoginView();
      setLoginError('');
      toast('تم تسجيل الخروج.', 'success');
    }
  }

  function hasUnsavedChanges() {
    if (!state.content) return false;
    return state.saveState === 'conflict'
      || state.saveState === 'error'
      || state.saving
      || state.pending
      || JSON.stringify(state.content) !== state.snapshot;
  }

  function markChanged() {
    if (!state.content) return;
    state.saveState = state.conflict ? 'conflict' : 'dirty';
    state.saveError = '';
    state.previewStale = true;
    updateStatus();
    scheduleAutosave();
  }

  function scheduleAutosave(delay) {
    if (state.conflict) return;
    clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(() => {
      requestSave('auto');
    }, Number.isFinite(delay) ? delay : AUTOSAVE_MS);
  }

  async function requestSave(trigger) {
    clearTimeout(state.saveTimer);
    if (!state.user || !state.content) return;
    if (state.saving) {
      state.pending = true;
      return;
    }
    if (state.conflict) {
      if (trigger === 'manual') openConflictDialog();
      return;
    }

    const sent = JSON.stringify(state.content);
    if (sent === state.snapshot) {
      state.saveState = 'saved';
      updateStatus();
      if (trigger === 'manual') toast('لا توجد تغييرات جديدة للحفظ.');
      return;
    }

    const sentContent = deepClone(state.content);
    const expectedVersion = state.published.version;
    const expectedRevision = state.working.revision_id;
    state.saving = true;
    state.pending = false;
    state.saveState = 'saving';
    state.saveError = '';
    updateStatus();

    try {
      const result = await apiSend(`${API}/draft`, {
        expected_version: expectedVersion,
        expected_revision: expectedRevision,
        content: sentContent,
      });
      if (typeof result.revision_id !== 'string'
        || !Number.isSafeInteger(result.base_version)
        || typeof result.updated_at !== 'string') {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }

      state.working = {
        source: 'draft',
        content: sentContent,
        revision_id: result.revision_id,
        base_version: result.base_version,
        updated_at: result.updated_at,
      };
      state.previewStale = true;

      if (JSON.stringify(state.content) === sent) {
        state.snapshot = sent;
        state.saveState = 'saved';
      } else {
        state.saveState = 'dirty';
        state.pending = true;
      }
      if (trigger === 'manual') toast('تم حفظ المسودة.', 'success');
    } catch (error) {
      if (error && (error.status === 409 || error.code === 'conflict')) {
        await enterConflict();
      } else if (error && error.status === 401) {
        state.saveState = 'error';
        state.saveError = 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مجددًا؛ تعديلاتك ما زالت في هذه الصفحة.';
      } else if (error && error.status === 403) {
        state.saveState = 'error';
        state.saveError = 'هذا الحساب لم يعد يملك صلاحية المدير. لم تُحفظ التغييرات.';
      } else if (error && error.code === 'invalid_content') {
        state.saveState = 'error';
        state.saveError = 'رفض الخادم المحتوى. تحقق من الروابط وقيم الأرقام ثم أعد المحاولة.';
      } else {
        state.saveState = 'error';
        state.saveError = 'تعذّر حفظ المسودة. تحقق من الاتصال ثم أعد المحاولة.';
      }
    } finally {
      state.saving = false;
      if (state.pending && state.saveState !== 'conflict' && state.saveState !== 'error') {
        state.pending = false;
        scheduleAutosave(200);
      } else if (state.saveState !== 'saving') {
        state.pending = false;
      }
      updateStatus();
    }
  }

  async function enterConflict() {
    state.saveState = 'conflict';
    state.saveError = '';
    let working = null;
    let published = null;
    let diff = [];
    try {
      const server = await apiGet(`${API}/bootstrap`);
      if (validWorking(server.working) && server.published) {
        working = {
          source: server.working.source,
          content: server.working.content,
          revision_id: server.working.revision_id,
          base_version: server.working.base_version,
          updated_at: server.working.updated_at,
        };
        published = {
          version: server.published.version,
          saved_at: typeof server.published.saved_at === 'string' ? server.published.saved_at : '',
        };
        diff = window.CcafeEditor.diffContent(state.content, working.content, state.schema.groups);
      }
    } catch {
      working = null;
      published = null;
      diff = [];
    }
    state.conflict = { working, published, diff, fetchedAt: new Date() };
    updateStatus();
  }

  async function refreshConflict() {
    if (!state.conflict) return;
    await enterConflict();
  }

  async function reloadConflictVersion() {
    if (!state.conflict || !state.conflict.working) {
      toast('تعذّر جلب النسخة الأحدث. أعد المحاولة أولًا.', 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'إعادة تحميل النسخة الأحدث',
      text: 'سيُستبدل ما كتبته في هذه الصفحة بالنسخة المحفوظة من الجلسة الأخرى. هل تريد المتابعة؟',
      confirmLabel: 'إعادة التحميل',
      danger: true,
    });
    if (!ok) return;

    const working = state.conflict.working;
    if (state.conflict.published) {
      state.published.version = state.conflict.published.version;
      state.published.saved_at = state.conflict.published.saved_at;
    }
    state.working = {
      source: working.source,
      content: working.content,
      revision_id: working.revision_id,
      base_version: working.base_version,
      updated_at: working.updated_at,
    };
    state.content = deepClone(working.content);
    state.snapshot = JSON.stringify(state.content);
    state.saveState = 'saved';
    state.conflict = null;
    state.previewStale = true;
    updateStatus();
    render();
    toast('تم تحميل أحدث نسخة من المسودة.', 'success');
  }

  async function overwriteConflict() {
    if (!state.conflict || !state.conflict.working) {
      toast('تعذّر جلب النسخة الأحدث. أعد المحاولة أولًا.', 'error');
      return;
    }
    const ok = await confirmDialog({
      title: 'حفظ نسختي فوق النسخة الأحدث',
      text: 'سيستبدل حفظك محتوى المسودة المحفوظ من الجلسة الأخرى. هل تريد المتابعة؟',
      confirmLabel: 'حفظ نسختي',
      danger: true,
    });
    if (!ok) return;

    if (state.conflict.published) {
      state.published.version = state.conflict.published.version;
      state.published.saved_at = state.conflict.published.saved_at;
    }
    state.working = {
      source: state.conflict.working.source,
      content: state.conflict.working.content,
      revision_id: state.conflict.working.revision_id,
      base_version: state.conflict.working.base_version,
      updated_at: state.conflict.working.updated_at,
    };
    state.conflict = null;
    state.saveState = 'dirty';
    state.pending = false;
    updateStatus();
    await requestSave('manual');
  }

  function openConflictDialog() {
    const conflict = state.conflict;
    if (!conflict) return;

    const body = [];
    body.push(el('p', {
      class: 'dialog-text',
      text: 'لم يُستبدل ما كتبته. هذه نسخة الجلسة الأخرى، وهذه فروق الحقول القابلة للتحرير.',
    }));

    if (!conflict.working) {
      body.push(el('p', { class: 'field-warn', text: 'تعذّر جلب أحدث نسخة من الخادم.' }));
    } else if (conflict.diff.length === 0) {
      body.push(el('p', { class: 'dialog-text', text: 'لم تظهر فروق في الحقول القابلة للتحرير؛ ربما تغيّر الإصدار المنشور أو ترتيب الأقسام فقط.' }));
    } else {
      const rows = conflict.diff.map((item) => el('tr', {},
        el('td', { dataset: { label: 'الحقل' } }, el('span', { text: item.label })),
        el('td', { dataset: { label: 'نسختي' }, class: 'diff-value' }, el('span', { dir: 'auto', text: item.mine })),
        el('td', { dataset: { label: 'النسخة الأخرى' }, class: 'diff-value' }, el('span', { dir: 'auto', text: item.theirs }))));
      body.push(el('div', { class: 'table-scroll diff-scroll' },
        el('table', { class: 'recent diff-table' },
          el('thead', {}, el('tr', {},
            el('th', { scope: 'col', text: 'الحقل' }),
            el('th', { scope: 'col', text: 'نسختي' }),
            el('th', { scope: 'col', text: 'النسخة الأخرى' }))),
          el('tbody', {}, rows))));
    }

    const actions = [
      {
        label: 'إغلاق',
        class: 'btn btn-ghost',
        onClick(close) { close(); },
      },
    ];
    if (conflict.working) {
      actions.push({
        label: 'إعادة تحميل النسخة الأحدث',
        class: 'btn btn-danger-ghost',
        onClick(close) { close(); reloadConflictVersion(); },
      });
      actions.push({
        label: 'حفظ نسختي',
        class: 'btn btn-primary',
        onClick(close) { close(); overwriteConflict(); },
      });
    } else {
      actions.push({
        label: 'إعادة المحاولة',
        class: 'btn btn-primary',
        onClick(close) { close(); refreshConflict(); },
      });
    }

    openModal({ title: 'مراجعة التعارض', body, actions, wide: true });
  }

  async function onDeleteDraft() {
    if (state.saving) {
      toast('انتظر اكتمال الحفظ ثم أعد المحاولة.', 'error');
      return;
    }
    if (!state.working || !state.working.revision_id) return;
    const ok = await confirmDialog({
      title: 'حذف المسودة',
      text: 'سيُحذف draft الحالي نهائيًا، ويعود المحرر إلى المحتوى المنشور. لا يتأثر المحتوى المنشور أو سجل النسخ. هل تريد المتابعة؟',
      confirmLabel: 'حذف المسودة',
      danger: true,
    });
    if (!ok) return;

    try {
      await apiSend(`${API}/draft/delete`, {
        expected_version: state.published.version,
        expected_revision: state.working.revision_id,
      });
      clearTimeout(state.saveTimer);
      state.previewStale = true;
      await loadDashboard(true);
      toast('حُذفت المسودة. المحرر يعرض المحتوى المنشور.', 'success');
    } catch (error) {
      if (error && (error.status === 409 || error.code === 'conflict')) {
        await enterConflict();
        toast('تغيّرت المسودة قبل الحذف. راجع التعارض.', 'error');
      } else if (error && error.status === 401) {
        toast('انتهت الجلسة. سجّل الدخول مجددًا.', 'error');
      } else if (error && error.status === 403) {
        toast('هذا الحساب لا يملك صلاحية المدير.', 'error');
      } else {
        toast('تعذّر حذف المسودة. حاول مرة أخرى.', 'error');
      }
    }
  }

  function invalidateVerification() {
    state.verify.seq += 1;
    state.verify.busy = false;
    state.verify.version = null;
    state.verify.state = 'idle';
    state.verify.observed = null;
    state.verify.detail = '';
    state.verify.checkedAt = null;
  }

  function operationBlocked() {
    if (!state.user) return true;
    if (state.publish.busy || state.restore.busy || state.historyClear.busy || state.siteStatus.busy) {
      toast('عملية نشر أو استعادة أو حذف للسجل أو تغيير لحالة الموقع قيد التنفيذ. انتظر اكتمالها.', 'error');
      return true;
    }
    if (state.saving || state.pending) {
      toast('انتظر اكتمال حفظ أحدث تعديل قبل المتابعة.', 'error');
      return true;
    }
    if (state.conflict) {
      openConflictDialog();
      return true;
    }
    return false;
  }

  function validPublishResult(value, operationId, version) {
    return isPlainObject(value)
      && Number.isSafeInteger(value.version)
      && value.version > version
      && typeof value.saved_at === 'string'
      && value.operation_id === operationId
      && value.source === 'draft';
  }

  function validRestoreResult(value, operationId, historyId, version) {
    return isPlainObject(value)
      && Number.isSafeInteger(value.version)
      && value.version > version
      && typeof value.saved_at === 'string'
      && value.operation_id === operationId
      && value.source === 'restore'
      && value.restored_from === historyId;
  }

  async function onPublish() {
    if (operationBlocked()) return;
    const working = state.working;
    if (!working || !working.revision_id) {
      toast('لا توجد مسودة محفوظة. احفظ المسودة أولًا ثم انشر.', 'error');
      return;
    }
    if (hasUnsavedChanges()) {
      toast('احفظ أحدث تعديل قبل النشر. النشر يستخدم آخر نسخة محفوظة فقط.', 'error');
      return;
    }

    const expectedVersion = state.published.version;
    const revision = working.revision_id;
    const choice = await operationDialog({
      title: 'نشر المسودة',
      text: `سيُنشر محتوى المسودة المحفوظة كإصدار جديد بعد الإصدار الحالي #${expectedVersion}. بعد نجاح النشر تُحذف هذه المراجعة فقط من المسودة؛ أي مسودة أحدث لا تُحذف. لا يتأثر أي شيء قبل التأكيد.`,
      confirmLabel: 'نشر',
      noteLabel: 'ملاحظة النشر (تظهر في سجل النسخ)',
    });
    if (!choice) return;

    const note = choice.note || null;
    invalidateVerification();
    state.publish.busy = true;
    updateStatus();

    let operationId;
    try {
      operationId = operationIdFor(
        state.publish,
        `publish:${expectedVersion}:${revision}:${note || ''}`,
      );
    } catch {
      state.publish.busy = false;
      updateStatus();
      toast('تعذّر توليد معرّف العملية في هذا المتصفح. استخدم متصفحًا يدعم crypto.randomUUID.', 'error');
      return;
    }

    try {
      const result = await apiSend(`${API}/publish`, {
        expected_version: expectedVersion,
        expected_draft_revision: revision,
        operation_id: operationId,
        note,
      });
      if (!validPublishResult(result, operationId, expectedVersion)) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }

      state.publish.pending = null;
      toast(`نُشر الإصدار #${result.version}. جارٍ التحقق من ظهوره…`, 'success');
      try {
        await loadDashboard(true);
      } catch (error) {
        await handleLoadError(error, 'نُشر المحتوى، لكن تعذّر تحديث اللوحة. أعد التحديث.');
      }
      await runVerification(result.version);
    } catch (error) {
      if (error && error.status === 409) {
        state.publish.pending = null;
        await enterConflict();
        toast('تعارض: تغيّرت المسودة أو الإصدار المنشور. لم يُنشأ إصدار جديد. راجع الفروق.', 'error');
      } else if (error && error.status === 401) {
        state.publish.pending = null;
        await endSession('انتهت الجلسة. سجّل الدخول مجددًا؛ لم يُؤكد نشر جديد.');
      } else if (error && error.status === 403) {
        state.publish.pending = null;
        toast('هذا الحساب لا يملك صلاحية النشر.', 'error');
      } else if (error && error.status === 422) {
        state.publish.pending = null;
        if (error.code === 'media_not_ready') {
          toast('لم تصبح إحدى الصور جاهزة للنشر العام. لم يتغيّر المنشور ولم تُحذف المسودة؛ أعد المحاولة.', 'error');
        } else {
          toast('رفض الخادم طلب النشر. تحقق من المحتوى ثم أعد المحاولة.', 'error');
        }
      } else if (error && error.code === 'media_prepare_failed') {
        // The operation id is kept: no version was published, and retrying
        // reuses the same staging object instead of creating another copy.
        toast('تعذّر تجهيز نسخة عامة من إحدى الصور. لم يتغيّر المنشور ولم تُحذف المسودة. أعد المحاولة.', 'error');
      } else if (error && error.code === 'media_unavailable') {
        toast('تجهيز الصور العامة غير متاح على الخادم الآن. لم يتغيّر المنشور ولم تُحذف المسودة.', 'error');
      } else {
        // The write may have committed before the response was lost. Keep the
        // operation id: retrying the same request returns the original result.
        toast('انقطع الرد قبل تأكيد النشر. أعد المحاولة من «نشر المسودة» لاستخدام نفس العملية دون إنشاء نسخة إضافية.', 'error');
      }
    } finally {
      state.publish.busy = false;
      updateStatus();
    }
  }

  async function onRestore(entry) {
    if (!entry || !Number.isSafeInteger(entry.id) || entry.id < 1) return;
    if (operationBlocked()) return;
    if (!state.working) return;
    if (hasUnsavedChanges()) {
      toast('احفظ تعديلاتك أو تجاهلها قبل الاستعادة. الاستعادة لا تحذف مسودة أحدث.', 'error');
      return;
    }

    const expectedVersion = state.published.version;
    const hasDraft = Boolean(state.working.revision_id);
    const draftImpact = hasDraft
      ? `المسودة الحالية ستبقى محفوظة ولن تُحذف، لكنها مبنية على الإصدار #${state.working.base_version}. بعد الاستعادة ستحتاج إلى حفظها مجددًا قبل أن تصبح قابلة للنشر.`
      : 'لا توجد مسودة حالياً، لذا لن تتأثر أي مسودة.';
    const choice = await operationDialog({
      title: 'استعادة نسخة من السجل',
      text: `ستنشئ الاستعادة إصدارًا جديدًا (#${expectedVersion + 1}) بمحتوى النسخة #${entry.version}. لا تعود أرقام الإصدارات إلى الخلف ولا يُحذف أي إصدار قديم. ${draftImpact}`,
      confirmLabel: `استعادة #${entry.version}`,
      noteLabel: 'ملاحظة الاستعادة (تظهر في سجل النسخ)',
    });
    if (!choice) return;

    const note = choice.note || null;
    invalidateVerification();
    state.restore.busy = true;
    updateStatus();

    let operationId;
    try {
      operationId = operationIdFor(
        state.restore,
        `restore:${entry.id}:${expectedVersion}:${note || ''}`,
      );
    } catch {
      state.restore.busy = false;
      updateStatus();
      toast('تعذّر توليد معرّف العملية في هذا المتصفح.', 'error');
      return;
    }

    try {
      const result = await apiSend(`${API}/restore`, {
        history_id: entry.id,
        expected_version: expectedVersion,
        operation_id: operationId,
        note,
      });
      if (!validRestoreResult(result, operationId, entry.id, expectedVersion)) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }

      state.restore.pending = null;
      toast(`أُنشئ الإصدار #${result.version} من النسخة #${entry.version}.`, 'success');
      try {
        await loadDashboard(true);
      } catch (error) {
        await handleLoadError(error, 'تمت الاستعادة، لكن تعذّر تحديث اللوحة. أعد التحديث.');
      }
      await runVerification(result.version);
    } catch (error) {
      if (error && error.status === 401) {
        state.restore.pending = null;
        await endSession('انتهت الجلسة. سجّل الدخول مجددًا.');
      } else if (error && error.status === 403) {
        state.restore.pending = null;
        toast('هذا الحساب لا يملك صلاحية الاستعادة.', 'error');
      } else if (error && error.status === 409) {
        state.restore.pending = null;
        try {
          await loadDashboard(true);
        } catch {
          // A refresh failure must not hide the conflict message.
        }
        toast('تعارض: تغيّر الإصدار المنشور قبل الاستعادة. حُدّثت اللوحة ولم تُنشأ نسخة جديدة.', 'error');
      } else if (error && error.status === 422) {
        state.restore.pending = null;
        toast('رفض الخادم طلب الاستعادة. أعد تحميل السجل ثم حاول مجددًا.', 'error');
      } else {
        // Keep the operation id: the restore may have committed before the
        // response was lost. Retrying the same entry reuses that result.
        toast('تعذّر تأكيد نتيجة الاستعادة بسبب انقطاع الرد. أعد المحاولة من زر الاستعادة نفسه.', 'error');
      }
    } finally {
      state.restore.busy = false;
      updateStatus();
      if (state.view === 'history') renderHistory();
    }
  }

  function clearHistoryDialog() {
    const CONFIRMATION = 'حذف السجل نهائيًا';
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const input = el('input', {
        class: 'input',
        type: 'text',
        autocomplete: 'off',
        dir: 'auto',
        placeholder: CONFIRMATION,
        'aria-label': 'اكتب عبارة التأكيد',
      });
      const warning = el('p', { class: 'field-warn', hidden: true });
      let confirmButton = null;
      const sync = () => {
        const matches = input.value.trim() === CONFIRMATION;
        if (confirmButton) confirmButton.disabled = !matches;
        warning.hidden = matches || input.value.trim() === '';
        warning.textContent = matches ? '' : `اكتب العبارة التالية كما هي: ${CONFIRMATION}`;
      };
      input.addEventListener('input', sync);

      const body = [
        el('p', { class: 'dialog-text' },
          'سيُحذف جميع نسخ سجل المحتوى الموجودة الآن فقط. لن يتغير المحتوى المنشور الحالي أو رقمه، ولن تتأثر المسودة أو مكتبة الوسائط أو المستخدمون أو حالة الموقع وسجل عملياتها أو التحليلات.'),
        el('p', { class: 'dialog-text' },
          'بعد الحذف لن تكون الاستعادة من اللوحة ممكنة للنسخ المحذوفة. هذا الإجراء لا يزيل النسخ الاحتياطية السابقة خارج هذه اللوحة.'),
        el('label', { class: 'field' },
          el('span', { class: 'field-label', text: `اكتب «${CONFIRMATION}» للتأكيد` }),
          input),
        warning,
      ];

      openModal({
        title: 'حذف سجل التعديلات نهائيًا',
        body,
        actions: [
          {
            label: 'إلغاء',
            class: 'btn btn-ghost',
            onClick(close) { done(false); close(); },
          },
          {
            label: 'حذف السجل نهائيًا',
            class: 'btn btn-danger',
            disabled: true,
            onClick(close) {
              if (input.value.trim() !== CONFIRMATION) {
                sync();
                return;
              }
              done(true);
              close();
            },
          },
        ],
        onClose() { done(false); },
      });
      const dialogs = document.body.querySelectorAll('dialog');
      const dialog = dialogs[dialogs.length - 1];
      confirmButton = dialog
        ? Array.from(dialog.querySelectorAll('button')).find((node) => node.textContent.includes('حذف السجل نهائيًا')) || null
        : null;
      sync();
    });
  }

  async function refreshHistoryOnly() {
    const history = await apiGet(`${API}/history`);
    const entries = normalizeHistory(history.entries);
    state.history = entries;
    state.historySummary = {
      count: entries.length,
      latest: entries.length ? entries[0] : null,
    };
    state.loadedAt = new Date();
  }

  async function onClearHistory() {
    if (state.historyClear.confirming || state.historyClear.busy) return;
    if (operationBlocked()) return;
    state.historyClear.confirming = true;
    let confirmed = false;
    try {
      confirmed = await clearHistoryDialog();
    } finally {
      // Keep confirming true while the confirmed request is being sent; it is
      // released in the request finally block. If cancelled, release now.
      if (!confirmed) state.historyClear.confirming = false;
    }
    if (!confirmed) return;

    state.historyClear.busy = true;
    updateStatus();
    if (state.view === 'history') renderHistory();

    let operationId;
    try {
      operationId = operationIdFor(
        state.historyClear,
        'clear-history:حذف السجل نهائيًا',
      );
    } catch {
      state.historyClear.busy = false;
      state.historyClear.confirming = false;
      updateStatus();
      if (state.view === 'history') renderHistory();
      toast('تعذّر توليد معرّف العملية في هذا المتصفح.', 'error');
      return;
    }

    try {
      const result = await apiSend(`${API}/history/clear`, {
        operation_id: operationId,
        confirmation: 'حذف السجل نهائيًا',
      });
      if (!isPlainObject(result)
        || result.operation_id !== operationId
        || !Number.isSafeInteger(result.deleted_count)
        || result.deleted_count < 0) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }

      state.historyClear.pending = null;
      let refreshed = true;
      try {
        await refreshHistoryOnly();
      } catch (error) {
        refreshed = false;
        if (error && error.status === 401) {
          await endSession('انتهت الجلسة. سجّل الدخول مجددًا.');
          return;
        }
        if (error && error.status === 403) {
          await endSession('هذا الحساب لا يملك صلاحية المدير.');
          return;
        }
        toast(
          `تم حذف سجل التعديلات نهائيًا. عدد النسخ المحذوفة: ${result.deleted_count}. لكن تعذّر تحديث قائمة السجل؛ أعد التحديث.`,
          'error',
        );
      }
      if (refreshed) {
        toast(`تم حذف سجل التعديلات نهائيًا. عدد النسخ المحذوفة: ${result.deleted_count}.`, 'success');
      }
    } catch (error) {
      if (error && error.status === 401) {
        state.historyClear.pending = null;
        await endSession('انتهت الجلسة. سجّل الدخول مجددًا.');
      } else if (error && error.status === 403) {
        state.historyClear.pending = null;
        toast('هذا الحساب لا يملك صلاحية حذف السجل.', 'error');
      } else if (error && error.status === 409) {
        state.historyClear.pending = null;
        toast('تعارض في عملية حذف السجل. أعد تحميل السجل ثم حاول مجددًا.', 'error');
      } else if (error && error.status === 422 || (error && error.status === 400)) {
        state.historyClear.pending = null;
        toast('رفض الخادم طلب حذف السجل. تحقق من التأكيد ثم أعد المحاولة.', 'error');
      } else {
        // Keep the same operation id: the clear may have committed before the
        // response was lost. Retrying the same request replays the original
        // result and must not delete newer history rows.
        toast('تعذّر تأكيد حذف السجل بسبب انقطاع الرد. أعد المحاولة من نفس الزر؛ لن تُحذف نسخ أحدث بإعادة الطلب نفسه.', 'error');
      }
    } finally {
      state.historyClear.busy = false;
      state.historyClear.confirming = false;
      updateStatus();
      if (state.view === 'history') renderHistory();
    }
  }

  async function runVerification(version) {
    if (!Number.isSafeInteger(version) || version < 1) return;
    const seq = state.verify.seq + 1;
    state.verify.seq = seq;
    state.verify.busy = true;
    state.verify.version = version;
    state.verify.state = 'checking';
    state.verify.observed = null;
    state.verify.detail = '';
    state.verify.checkedAt = null;
    renderStatusBanner();

    try {
      const data = await apiGet(`${API}/verify?version=${version}`);
      if (seq !== state.verify.seq) return;
      if (!isPlainObject(data) || data.version !== version) {
        state.verify.state = 'failed';
        state.verify.detail = 'invalid_response';
        return;
      }
      if (data.state === 'matched') {
        state.verify.state = 'matched';
        state.verify.observed = Number.isSafeInteger(data.observed_version)
          ? data.observed_version
          : version;
        toast(`تم تأكيد ظهور الإصدار #${version} على صفحة المعاينة.`, 'success');
      } else if (data.state === 'superseded') {
        state.verify.state = 'superseded';
      } else {
        state.verify.state = 'failed';
        state.verify.observed = Number.isSafeInteger(data.observed_version)
          ? data.observed_version
          : null;
        state.verify.detail = typeof data.detail === 'string' && data.detail
          ? data.detail
          : 'not_confirmed';
      }
      state.verify.checkedAt = typeof data.checked_at === 'string'
        ? data.checked_at
        : new Date().toISOString();
    } catch (error) {
      if (seq !== state.verify.seq) return;
      if (error && error.status === 401) {
        await endSession('انتهت الجلسة أثناء التحقق. سجّل الدخول مجددًا.');
        return;
      }
      state.verify.state = 'failed';
      state.verify.detail = error && error.status === 409
        ? 'stale_version'
        : error && error.status === 503
          ? 'origin_unavailable'
          : 'request_failed';
      state.verify.checkedAt = new Date().toISOString();
    } finally {
      if (seq === state.verify.seq) {
        state.verify.busy = false;
        renderStatusBanner();
        updateStatus();
      }
    }
  }

  async function onRefresh() {
    if (state.busy) return;
    if (state.saving) {
      toast('انتظر اكتمال الحفظ ثم حدّث البيانات.', 'error');
      return;
    }
    if (hasUnsavedChanges() || state.conflict) {
      const ok = await confirmDialog({
        title: 'تحديث البيانات',
        text: 'لديك تغييرات غير محفوظة أو تعارض. تحديث البيانات سيتجاهلها ويعرض أحدث نسخة محفوظة. هل تريد المتابعة؟',
        confirmLabel: 'تحديث',
        danger: true,
      });
      if (!ok) return;
    }
    state.busy = true;
    els.refresh.disabled = true;
    els.refresh.textContent = 'جارٍ التحديث…';
    try {
      await loadDashboard(true);
      await loadSiteStatus(true);
      if (state.view === 'preview') await loadPreview();
      toast('تم تحديث البيانات.', 'success');
    } catch (error) {
      await handleLoadError(error, 'تعذّر تحديث البيانات. حاول مرة أخرى.');
    } finally {
      state.busy = false;
      els.refresh.disabled = false;
      els.refresh.textContent = 'تحديث';
    }
  }

  async function handleLoadError(error, fallback) {
    if (error && error.status === 401) {
      await endSession('انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مرة أخرى.');
      return;
    }
    if (error && error.status === 403) {
      await endSession('هذا الحساب لا يملك صلاحية المدير.');
      return;
    }
    toast(fallback || 'تعذّر تحميل البيانات. حاول مرة أخرى.', 'error');
  }

  async function loadPreview() {
    if (state.preview.loading) return;
    state.preview.loading = true;
    state.preview.error = '';
    state.previewStale = false;
    if (state.view === 'preview') renderPreviewView();
    try {
      const result = await apiGetText(`${API}/preview`);
      state.preview.html = result.text;
      state.preview.source = result.source;
      state.preview.loadedAt = new Date();
    } catch (error) {
      state.preview.html = '';
      state.preview.source = '';
      state.preview.error = error && error.status === 403
        ? 'هذا الحساب لا يملك صلاحية المدير.'
        : error && error.status === 401
          ? 'انتهت الجلسة. سجّل الدخول مجددًا.'
          : 'تعذّر تحضير المعاينة. حاول مرة أخرى.';
    } finally {
      state.preview.loading = false;
      if (state.view === 'preview') renderPreviewView();
    }
  }

  function normalizeSiteStatus(value) {
    if (!isPlainObject(value)) return null;
    if (value.state !== 'running' && value.state !== 'stopped') return null;
    if (typeof value.message !== 'string'
      || [...value.message].length > MAX_SITE_MESSAGE) return null;
    if (!Number.isSafeInteger(value.revision) || value.revision < 1) return null;
    if (typeof value.updated_at !== 'string') return null;
    if (!isPlainObject(value.changed_by)) return null;
    if (value.changed_by.id !== null && typeof value.changed_by.id !== 'string') return null;
    if (typeof value.changed_by.email !== 'string') return null;
    return {
      state: value.state,
      message: value.message,
      revision: value.revision,
      updated_at: value.updated_at,
      changed_by: {
        id: value.changed_by.id,
        email: value.changed_by.email,
      },
    };
  }

  function normalizeSiteStatusWrite(value, operationId) {
    const status = normalizeSiteStatus(value);
    if (!status) return null;
    if (!isPlainObject(value) || value.operation_id !== operationId
      || typeof value.idempotent !== 'boolean') return null;
    return { ...status, idempotent: value.idempotent };
  }

  function siteStateLabel(stateValue) {
    return stateValue === 'stopped' ? 'متوقف مؤقتًا' : 'يعمل';
  }

  function siteStatusUnconfirmedNotice(result) {
    const prefix = result && result.idempotent
      ? 'العملية المطلوبة كانت مؤكدة سابقًا بنتيجة تاريخية، '
      : 'تم تأكيد العملية على الخادم، ';
    return `${prefix}لكن تعذّر جلب الحالة الحالية. الحالة الحالية غير مؤكدة؛ لا تفترض أن الموقع متوقف أو يعمل. استخدم «إعادة محاولة الطلب نفسه» لمراجعة العملية ذاتها.`;
  }

  // الرد المفقود لا يعني أن العملية فشلت ولا أنها نجحت؛ نتيجة GET القديمة
  // لا تصلح وصفًا للحالة الحالية بعد إرسال الطلب.
  function siteStatusAmbiguousNotice() {
    return 'انقطع الرد قبل تأكيد تغيير الحالة، فلا يمكن الجزم بما إذا نُفّذ الطلب. الحالة الحالية غير مؤكدة؛ لا تفترض أن الموقع متوقف أو يعمل. استخدم «إعادة محاولة الطلب نفسه» لمراجعة العملية ذاتها.';
  }

  function siteStatusCurrentNotice(request, result, current) {
    const historical = result.idempotent
      ? `العملية المطلوبة كانت مؤكدة سابقًا بنتيجة تاريخية (${siteStateLabel(result.state)})، ولم تُنشأ عملية جديدة. `
      : 'تم تأكيد العملية على الخادم. ';
    const currentText = `الحالة الحالية الآن ${siteStateLabel(current.state)} (المراجعة #${current.revision}) حسب قراءة جديدة من الخادم.`;
    if (current.state === request.state) return `${historical}${currentText}`;
    return `${historical}${currentText} لم تُعرض النتيجة التاريخية كحالة حالية؛ يبدو أن جلسة أخرى غيّرت الحالة بعدها.`;
  }

  // كل قراءة تأخذ رقمًا متسلسلًا. الاستجابة القديمة تُتجاهل، ولا تُكتب أبدًا
  // فوق مراجعة أحدث ظهرت في الواجهة حتى لو وصلت بعدها.
  async function loadSiteStatus(force, options = {}) {
    if (!state.user) return { ok: false, applied: false };
    if (!force && state.siteStatus.loaded && state.siteStatus.loadInflight === 0) {
      return { ok: true, applied: true, value: state.siteStatus.value };
    }

    const seq = ++state.siteStatus.loadSeq;
    state.siteStatus.loadInflight += 1;
    state.siteStatus.loading = true;
    if (!options.quiet) state.siteStatus.error = '';
    if (state.user && state.view === 'site-status') renderSiteStatusView();

    let authError = '';
    let result = { ok: false, applied: false, stale: false };
    try {
      const data = await apiGet(`${API}/site-status`);
      const value = normalizeSiteStatus(data);
      if (!value) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }
      if (seq !== state.siteStatus.loadSeq) {
        result.stale = true;
      } else {
        const current = state.siteStatus.value;
        const applied = !current || value.revision >= current.revision;
        if (applied) {
          state.siteStatus.value = value;
          state.siteStatus.loaded = true;
          state.siteStatus.currentUnconfirmed = false;
        }
        result = { ok: true, applied, value, stale: false };
      }
    } catch (error) {
      if (seq !== state.siteStatus.loadSeq) {
        result.stale = true;
      } else if (error && error.status === 401) {
        authError = 'انتهت الجلسة أو أصبحت غير صالحة. سجّل الدخول مرة أخرى.';
      } else if (error && error.status === 403) {
        authError = 'هذا الحساب لا يملك صلاحية المدير.';
      } else if (!options.quiet) {
        state.siteStatus.error = 'تعذّر تحميل حالة الموقع. تحقق من الاتصال ثم أعد المحاولة.';
      }
    } finally {
      state.siteStatus.loadInflight = Math.max(0, state.siteStatus.loadInflight - 1);
      state.siteStatus.loading = state.siteStatus.loadInflight > 0;
      if (state.user && state.view === 'site-status') renderSiteStatusView();
    }
    if (authError) await endSession(authError);
    return result;
  }

  function siteStatusNotice() {
    const item = state.siteStatus;
    if (item.loading) {
      return el('div', { class: 'status-banner status-banner-note', role: 'status' },
        el('strong', { text: 'جارٍ تحميل حالة الموقع…' }));
    }
    if (item.error) {
      return el('div', { class: 'status-banner status-banner-error', role: 'alert' },
        el('strong', { text: 'تعذّر تحميل الحالة' }),
        el('p', { text: item.error }));
    }
    if (item.notice) {
      const kind = item.noticeKind === 'conflict'
        ? 'status-banner-conflict'
        : item.noticeKind === 'error'
          ? 'status-banner-error'
          : item.noticeKind === 'note'
            ? 'status-banner-note'
            : 'status-banner-success';
      const role = item.noticeKind === 'error' || item.noticeKind === 'conflict' ? 'alert' : 'status';
      return el('div', { class: `status-banner ${kind}`, role },
        el('p', { text: item.notice }));
    }
    return null;
  }

  function stopSiteDialog() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const input = el('textarea', {
        class: 'input',
        dir: 'rtl',
        rows: '4',
        maxlength: String(MAX_SITE_MESSAGE * 2),
        placeholder: 'رسالة اختيارية تظهر للزائر أثناء التوقف',
      });
      const counter = el('p', { class: 'field-help', text: `0 / ${MAX_SITE_MESSAGE}` });
      const warn = el('p', { class: 'field-warn', hidden: true, text: `الرسالة أطول من ${MAX_SITE_MESSAGE} حرفًا.` });
      const tooLong = () => [...input.value].length > MAX_SITE_MESSAGE;
      input.addEventListener('input', () => {
        counter.textContent = `${[...input.value].length} / ${MAX_SITE_MESSAGE}`;
        warn.hidden = !tooLong();
      });
      openModal({
        title: 'إيقاف الموقع مؤقتًا',
        body: el('div', { class: 'editor-form' },
          el('p', { class: 'dialog-text', text: 'سيُوقف عرض الموقع للزائر فورًا بعد تأكيد الخادم. سيرى الزائر صفحة بسيطة تحمل الرسالة التالية إن كتبتها. يمكنك إعادة تشغيل الموقع لاحقًا من هذه الصفحة.' }),
          el('label', { class: 'field' },
            el('span', { class: 'field-label', text: 'رسالة الزائر (اختيارية)' }),
            input,
            counter,
            warn)),
        actions: [
          {
            label: 'إلغاء',
            class: 'btn btn-ghost',
            onClick(close) { done(null); close(); },
          },
          {
            label: 'إيقاف الموقع',
            class: 'btn btn-danger',
            onClick(close) {
              if (tooLong()) {
                warn.hidden = false;
                input.focus();
                return;
              }
              done(input.value);
              close();
            },
          },
        ],
        onClose() { done(null); },
      });
    });
  }

  async function sendSiteStatusRequest(request) {
    // يُستدعى بعد إغلاق الحوار، لذا علامة الحوار لا تمنع الإرسال هنا؛ زر
    // إعادة المحاولة وحده يتحقق من علامة الحوار قبل استدعائه.
    if (!state.user || state.siteStatus.busy) return;
    const pending = deepClone(request);
    state.siteStatus.busy = true;
    state.siteStatus.notice = state.siteStatus.pending
      ? 'جارٍ إعادة إرسال الطلب المعلّق نفسه…'
      : 'جارٍ تأكيد تغيير الحالة…';
    state.siteStatus.noticeKind = 'note';
    if (state.view === 'site-status') renderSiteStatusView();

    try {
      const result = await apiSend(`${API}/site-status`, {
        state: pending.state,
        message: pending.message,
        expected_revision: pending.expected_revision,
        operation_id: pending.operation_id,
      });
      const confirmed = normalizeSiteStatusWrite(result, pending.operation_id);
      if (!confirmed) {
        const error = new Error('invalid-response');
        error.status = 502;
        throw error;
      }

      // نتيجة الكتابة (بما فيها idempotent replay) سجل تاريخي فقط. الحالة
      // الحالية تُجلب بقراءة جديدة قبل أي رسالة نجاح نهائية.
      state.siteStatus.confirmed = {
        ...confirmed,
        requested_state: pending.state,
        requested_message: pending.message,
        expected_revision: pending.expected_revision,
      };
      state.siteStatus.notice = confirmed.idempotent
        ? 'العملية مؤكدة سابقًا بنتيجة تاريخية. جارٍ جلب الحالة الحالية…'
        : 'تم تأكيد العملية. جارٍ جلب الحالة الحالية…';
      state.siteStatus.noticeKind = 'note';
      if (state.view === 'site-status') renderSiteStatusView();

      const fetched = await loadSiteStatus(true, { quiet: true });
      if (!state.user) return;
      state.siteStatus.error = '';
      if (!fetched.ok || !fetched.applied) {
        state.siteStatus.currentUnconfirmed = true;
        state.siteStatus.notice = siteStatusUnconfirmedNotice(confirmed);
        state.siteStatus.noticeKind = 'error';
        return;
      }

      state.siteStatus.pending = null;
      state.siteStatus.currentUnconfirmed = false;
      state.siteStatus.notice = siteStatusCurrentNotice(pending, confirmed, fetched.value);
      state.siteStatus.noticeKind = 'success';
      if (fetched.value.state === pending.state) {
        toast(fetched.value.state === 'stopped'
          ? 'تم إيقاف الموقع مؤقتًا.'
          : 'تمت إعادة تشغيل الموقع.', 'success');
      }
    } catch (error) {
      if (error && error.status === 401) {
        state.siteStatus.pending = null;
        state.siteStatus.confirmed = null;
        await endSession('انتهت الجلسة. سجّل الدخول مجددًا؛ لم تُؤكد حالة الموقع.');
        return;
      }
      if (error && error.status === 403) {
        state.siteStatus.pending = null;
        state.siteStatus.confirmed = null;
        state.siteStatus.notice = 'هذا الحساب لا يملك صلاحية تغيير حالة الموقع.';
        state.siteStatus.noticeKind = 'error';
      } else if (error && error.status === 409) {
        state.siteStatus.pending = null;
        state.siteStatus.confirmed = null;
        state.siteStatus.notice = 'تعارض: تغيّرت حالة الموقع من جلسة أخرى. حُدّثت الحالة ولم يُنفَّذ التغيير.';
        state.siteStatus.noticeKind = 'conflict';
        await loadSiteStatus(true);
      } else if (error && error.status === 422) {
        state.siteStatus.pending = null;
        state.siteStatus.confirmed = null;
        state.siteStatus.notice = 'رفض الخادم طلب تغيير الحالة. راجع الرسالة ثم أعد المحاولة.';
        state.siteStatus.noticeKind = 'error';
      } else {
        // الرد ضاع؛ العملية قد تكون نُفّذت. لا تُعرض نتيجة GET القديمة كحالة
        // حالية، بل احتفظ بالطلب كاملًا لإعادة مقصودة واحدة بمعرّفها وبياناتها،
        // من غير توليد عملية جديدة أو إعادة تلقائية. أخطاء الرفض الصريحة
        // (401/403/409/422) لها فروعها ولا تُعتبر دليلًا على تنفيذ العملية.
        state.siteStatus.currentUnconfirmed = true;
        state.siteStatus.notice = siteStatusAmbiguousNotice();
        state.siteStatus.noticeKind = 'error';
      }
    } finally {
      state.siteStatus.busy = false;
      if (state.user && state.view === 'site-status') renderSiteStatusView();
    }
  }

  async function changeSiteStatus(target, message) {
    if (operationBlocked()) return;
    if (state.siteStatus.pending) {
      toast('هناك طلب غير مؤكد بانتظار إعادة المحاولة. استخدم زر إعادة محاولة الطلب نفسه.', 'error');
      return;
    }
    const status = state.siteStatus.value;
    if (!status) {
      toast('لم تُحمّل حالة الموقع بعد. أعد المحاولة.', 'error');
      return;
    }

    let operationId;
    try {
      operationId = operationIdFor(
        state.siteStatus,
        JSON.stringify([target, message, status.revision]),
        (id, signature) => ({
          operation_id: id,
          signature,
          state: target,
          message,
          expected_revision: status.revision,
        }),
      );
    } catch {
      toast('تعذّر توليد معرّف العملية في هذا المتصفح.', 'error');
      return;
    }

    await sendSiteStatusRequest({
      operation_id: operationId,
      state: target,
      message,
      expected_revision: status.revision,
    });
  }

  async function retryPendingSiteStatus() {
    if (!state.user || state.siteStatus.busy || state.siteStatus.dialogBusy) return;
    const pending = deepClone(state.siteStatus.pending);
    if (!pending || typeof pending.operation_id !== 'string'
      || (pending.state !== 'running' && pending.state !== 'stopped')
      || typeof pending.message !== 'string'
      || !Number.isSafeInteger(pending.expected_revision)) return;
    await sendSiteStatusRequest(pending);
  }

  async function onStopSite() {
    if (operationBlocked()) return;
    if (state.siteStatus.dialogBusy) {
      toast('حوار تأكيد مفتوح بالفعل. أكمله أو ألغه قبل المتابعة.', 'error');
      return;
    }
    state.siteStatus.dialogBusy = true;
    if (state.view === 'site-status') renderSiteStatusView();
    try {
      const message = await stopSiteDialog();
      if (message === null) return;
      await changeSiteStatus('stopped', message);
    } finally {
      state.siteStatus.dialogBusy = false;
      if (state.user && state.view === 'site-status') renderSiteStatusView();
    }
  }

  async function onRestartSite() {
    if (operationBlocked()) return;
    if (state.siteStatus.dialogBusy) {
      toast('حوار تأكيد مفتوح بالفعل. أكمله أو ألغه قبل المتابعة.', 'error');
      return;
    }
    state.siteStatus.dialogBusy = true;
    if (state.view === 'site-status') renderSiteStatusView();
    try {
      const confirmed = await confirmDialog({
        title: 'إعادة تشغيل الموقع',
        text: 'سيعود المحتوى المنشور الحالي للظهور للزائر. لا تُنشأ نسخة جديدة، ولن تُستعاد مسودة أو تُحذف.',
        confirmLabel: 'إعادة التشغيل',
      });
      if (!confirmed) return;
      await changeSiteStatus('running', '');
    } finally {
      state.siteStatus.dialogBusy = false;
      if (state.user && state.view === 'site-status') renderSiteStatusView();
    }
  }

  function renderSiteStatusView() {
    const item = state.siteStatus;
    const value = item.value;
    const uncertain = item.currentUnconfirmed;
    const known = Boolean(value) && !uncertain;
    const stopped = known && value.state === 'stopped';
    const label = uncertain ? 'غير مؤكد' : !value ? '—' : stopped ? 'متوقف مؤقتًا' : 'يعمل';
    const badgeClass = uncertain || !value
      ? 'badge status-pill status-conflict'
      : stopped
        ? 'badge status-pill status-conflict'
        : 'badge status-pill status-saved';

    const page = el('div', { class: 'readonly-page' });
    const notice = siteStatusNotice();
    if (notice) page.append(notice);

    page.append(el('section', { class: 'card pad content-meta', 'aria-labelledby': 'site-status-title' },
      el('h2', { id: 'site-status-title', text: 'حالة عرض الموقع' }),
      el('p', { class: 'actions-note', text: 'تتحكم هذه الصفحة في عرض الموقع للزائر فقط. لا تغير المحتوى المنشور، والمسودات، وسجل النسخ، والوسائط، وحسابات المستخدمين.' }),
      el('div', { class: 'site-state-row' },
        el('span', { class: 'meta-label', text: 'الحالة الحالية' }),
        el('span', { class: badgeClass, text: label })),
      uncertain
        ? el('p', { class: 'site-message', dir: 'rtl', text: 'تعذّر تأكيد الحالة الحالية بعد العملية؛ لا تُعرض نتيجة قديمة أو نتيجة العملية كحالة حالية.' })
        : known
          ? el('p', { class: 'site-message', dir: 'rtl', text: stopped && value.message ? value.message : 'لا توجد رسالة للزائر.' })
          : null,
      el('div', { class: 'meta-grid' },
        metaRow('رقم المراجعة', known ? `#${value.revision}` : '—'),
        metaRow('آخر تغيير', known ? formatDateTime(value.updated_at) : '—'),
        metaRow('آخر من غيّر الحالة', known && value.changed_by.email ? value.changed_by.email : '—'))));

    const blocked = item.loading || item.busy || item.dialogBusy || Boolean(item.pending);
    page.append(el('section', { class: 'card pad site-status-actions', 'aria-labelledby': 'site-status-actions-title' },
      el('h2', { id: 'site-status-actions-title', text: 'تغيير الحالة' }),
      el('p', { class: 'actions-note', text: 'عند التوقف تُعرض للزائر صفحة بسيطة برمز 503 ورسالة اختيارية، ويبقى الدخول ولوحة التحكم والواجهات الإدارية والملفات العامة متاحة. رسالة الزائر نص عادي ولا تتجاوز 300 حرفًا. إعادة التشغيل تمسح الرسالة ولا تؤثر على أي إصدار محفوظ.' }),
      el('div', { class: 'actions-row' },
        el('button', {
          class: 'btn btn-danger',
          type: 'button',
          disabled: blocked || !known || stopped,
          onClick: onStopSite,
        }, item.dialogBusy ? 'جارٍ التأكيد…' : item.busy && known && !stopped ? 'جارٍ الإيقاف…' : 'إيقاف الموقع مؤقتًا'),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: blocked || !known || !stopped,
          onClick: onRestartSite,
        }, item.dialogBusy ? 'جارٍ التأكيد…' : item.busy && known && stopped ? 'جارٍ إعادة التشغيل…' : 'إعادة تشغيل الموقع'),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          disabled: item.loading || item.busy || item.dialogBusy,
          onClick() { loadSiteStatus(true); },
        }, item.loading ? 'جارٍ التحديث…' : 'تحديث الحالة'))));

    if (item.pending) {
      page.append(el('div', { class: 'banner-actions site-status-retry' },
        el('p', {
          class: 'group-hint',
          text: `طلب غير مؤكد: ${siteStateLabel(item.pending.state)} · المراجعة المتوقعة #${item.pending.expected_revision}.`,
        }),
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          disabled: item.busy || item.dialogBusy,
          onClick: retryPendingSiteStatus,
          'data-operation-id': item.pending.operation_id,
          'data-state': item.pending.state,
          'data-message': item.pending.message,
          'data-expected-revision': String(item.pending.expected_revision),
        }, 'إعادة محاولة الطلب نفسه')));
    }

    els.view.replaceChildren(page);
  }

  function statusLabel() {
    switch (state.saveState) {
      case 'saving': return 'جارٍ الحفظ…';
      case 'dirty': return 'تغييرات غير محفوظة';
      case 'error': return 'فشل الحفظ';
      case 'conflict': return 'تعارض';
      default: return 'محفوظ';
    }
  }

  function updateStatus() {
    if (!els['status-pill']) return;
    els['status-pill'].textContent = statusLabel();
    els['status-pill'].className = `badge status-pill status-${state.saveState}`;

    const busyOp = state.publish.busy || state.restore.busy || state.historyClear.busy;
    const save = els['save-btn'];
    if (save) {
      save.textContent = state.saveState === 'saving'
        ? 'جارٍ الحفظ…'
        : state.saveState === 'error'
          ? 'إعادة المحاولة'
          : 'حفظ';
      save.disabled = !state.user
        || state.saving
        || state.saveState === 'conflict'
        || busyOp;
    }

    const publish = els['publish-btn'];
    if (publish) {
      publish.textContent = state.publish.busy
        ? 'جارٍ النشر…'
        : state.restore.busy
          ? 'جارٍ الاستعادة…'
          : state.historyClear.busy
            ? 'جارٍ حذف السجل…'
            : 'نشر المسودة';
      publish.disabled = !state.user
        || busyOp
        || state.saving
        || state.pending
        || Boolean(state.conflict)
        || !state.working
        || !state.working.revision_id
        || hasUnsavedChanges();
    }

    const del = els['delete-btn'];
    if (del) {
      del.disabled = !state.user
        || busyOp
        || state.saving
        || !state.working
        || !state.working.revision_id;
    }
    const preview = els['preview-btn'];
    if (preview) preview.disabled = !state.user;

    updateSessionNote();
    renderStatusBanner();
  }

  function verificationReason(detail, observed) {
    switch (detail) {
      case 'site_stopped':
        return 'الموقع متوقف مؤقتًا، لذا لا توجد صفحة محتوى يمكن التحقق منها. أعد الفحص بعد إعادة التشغيل.';
      case 'site_state_unknown':
        return 'تعذّر تأكيد حالة الموقع على الخادم؛ لم تُعتبر صفحة التوقف دليلًا على النشر.';
      case 'fallback_snapshot':
        return 'الصفحة العامة قدّمت نسخة fallback، وهي ليست تأكيدًا للنشر.';
      case 'not_live':
        return 'مصدر الصفحة ليس النسخة الحية المنشورة.';
      case 'version_mismatch':
        return observed
          ? `الصفحة تعرض الإصدار #${observed} بدلًا من الإصدار المطلوب.`
          : 'الصفحة تعرض إصدارًا مختلفًا عن الإصدار المطلوب.';
      case 'version_marker_missing':
        return 'لم تُعثر على علامة نسخة المحتوى في صفحة المعاينة.';
      case 'non_numeric_version':
        return 'علامة النسخة في الصفحة ليست رقم إصدار صالحًا.';
      case 'header_version_mismatch':
        return 'ترويسة الإصدار لا تطابق علامة النسخة في الصفحة.';
      case 'stale_version':
        return 'تغيّر الإصدار المنشور قبل اكتمال الفحص. حدّث البيانات ثم أعد الفحص.';
      case 'origin_unavailable':
        return 'لم يُضبط أصل معاينة Netlify المسموح للفحص على الخادم.';
      case 'fetch_failed':
      case 'read_failed':
        return 'تعذّر جلب صفحة المعاينة من الخادم.';
      case 'superseded':
        return 'ظهر فحص أحدث أثناء هذا الفحص؛ لم تُستبدل الحالة الأحدث.';
      default:
        return detail && /^http_\d+$/.test(detail)
          ? `أعادت صفحة المعاينة رمز HTTP ${detail.slice(5)}.`
          : 'تعذّر تأكيد ظهور الإصدار على صفحة المعاينة.';
    }
  }

  function renderVerificationBanner() {
    const verify = state.verify;
    if (verify.state === 'idle') return null;

    if (verify.state === 'checking') {
      return el('section', { class: 'status-banner status-banner-note', role: 'status' },
        el('strong', { text: 'جارٍ التحقق من الظهور' }),
        el('p', { text: `يُفحص أصل المعاينة الحالي للتأكد من ظهور الإصدار #${verify.version}.` }));
    }

    if (verify.state === 'matched') {
      return el('section', { class: 'status-banner status-banner-success', role: 'status' },
        el('strong', { text: 'تم تأكيد الظهور' }),
        el('p', { text: `الصفحة العامة تعرض الإصدار #${verify.version} من المصدر الحي.` }),
        verify.checkedAt ? el('p', { class: 'group-hint', text: `وقت الفحص: ${formatDateTime(verify.checkedAt)}` }) : null);
    }

    if (verify.state === 'superseded') {
      return el('section', { class: 'status-banner status-banner-note', role: 'note' },
        el('strong', { text: 'نتيجة فحص أحدث' }),
        el('p', { text: verificationReason('superseded', verify.observed) }));
    }

    const version = verify.version ? `#${verify.version}` : '';
    return el('section', { class: 'status-banner status-banner-error', role: 'alert' },
      el('strong', { text: 'تم الحفظ، تعذر تأكيد الظهور' }),
      el('p', { text: `حُفظ الإصدار ${version} في قاعدة البيانات، لكن لم يتأكد ظهوره على الصفحة العامة. لم تُعد محاولة النشر تلقائيًا.` }),
      el('p', { text: verificationReason(verify.detail, verify.observed) }),
      verify.checkedAt ? el('p', { class: 'group-hint', text: `وقت الفحص: ${formatDateTime(verify.checkedAt)}` }) : null,
      el('div', { class: 'banner-actions' },
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          disabled: verify.busy || !verify.version,
          onClick() { runVerification(verify.version); },
        }, verify.busy ? 'جارٍ إعادة الفحص…' : 'إعادة الفحص'),
        el('a', {
          class: 'btn btn-small btn-ghost',
          href: '/',
          target: '_blank',
          rel: 'noopener',
        }, 'فتح الموقع')));
  }

  function renderStatusBanner() {
    if (!els['status-banner']) return;
    const banner = els['status-banner'];
    banner.replaceChildren();

    if (state.saveState === 'conflict' && state.conflict) {
      const canResolve = Boolean(state.conflict.working);
      banner.append(el('section', { class: 'status-banner status-banner-conflict', role: 'alert' },
        el('strong', { text: 'تعارض في الحفظ' }),
        el('p', {
          text: 'عُدّلت المسودة من جلسة أخرى. لم يُستبدل ما كتبته في هذه الصفحة. راجع الفروق قبل إعادة التحميل.',
        }),
        el('div', { class: 'banner-actions' },
          el('button', {
            class: 'btn btn-small btn-primary',
            type: 'button',
            onClick: canResolve ? openConflictDialog : refreshConflict,
          }, canResolve ? 'مراجعة الفروق' : 'إعادة المحاولة'),
          canResolve ? el('button', {
            class: 'btn btn-small btn-ghost',
            type: 'button',
            onClick: reloadConflictVersion,
          }, 'إعادة تحميل النسخة الأحدث') : null,
          canResolve ? el('button', {
            class: 'btn btn-small btn-danger-ghost',
            type: 'button',
            onClick: overwriteConflict,
          }, 'حفظ نسختي') : null)));
    } else if (state.saveState === 'error') {
      banner.append(el('section', { class: 'status-banner status-banner-error', role: 'alert' },
        el('strong', { text: 'فشل الحفظ' }),
        el('p', { text: state.saveError || 'تعذّر حفظ المسودة.' }),
        el('div', { class: 'banner-actions' },
          el('button', {
            class: 'btn btn-small btn-primary',
            type: 'button',
            onClick() { requestSave('manual'); },
          }, 'إعادة المحاولة'))));
    }

    const verifyBanner = renderVerificationBanner();
    if (verifyBanner) banner.append(verifyBanner);
  }

  function editorContext() {
    return {
      content: state.content,
      schema: state.schema.groups,
      linkTokens: state.schema.linkTokens,
      linkAnchors: state.schema.linkAnchors,
      view: state.view,
      openGroups: state.ui.openGroups,
      closedGroups: state.ui.closedGroups,
      openItems: state.ui.openItems,
      changed: markChanged,
      mediaUrls: state.media.urls,
      pickImage(path) { openMediaPicker(path); },
      rerender() { renderEditorView(); },
    };
  }

  function editorHeader() {
    const draftExists = Boolean(state.working && state.working.revision_id);
    const meta = [
      ['المصدر الحالي', state.working && state.working.source === 'draft' ? 'مسودة محفوظة' : 'المحتوى المنشور'],
      ['الإصدار المنشور', `#${state.published.version}`],
      ['آخر حفظ للمسودة', state.working && state.working.updated_at ? formatDateTime(state.working.updated_at) : '—'],
      ['حالة الحفظ', statusLabel()],
    ];
    return el('section', { class: 'card pad editor-head', 'aria-labelledby': 'editor-title' },
      el('h2', { id: 'editor-title', text: TITLES[state.view] || 'تحرير المسودة' }),
      el('p', { class: 'group-hint' },
        'تحرير النصوص والروابط والإعدادات وترتيب الأقسام. يمكنك اختيار صورة من مكتبة الوسائط (أصل أصلي أو صورة مرفوعة معتمدة)، ورفع صور جديدة من المكتبة. تُنشر الصور المرفوعة المعتمدة مع المسودة عبر نسخة عامة، وتُعرض التحليلات التجريبية في صفحة نشاط الزوار.'),
      el('p', { class: 'group-hint' },
        draftExists
          ? 'يُحفظ التعديل في المسودة تلقائيًا بعد توقف الكتابة، أو بالضغط على «حفظ». المسودة لا تغيّر الموقع المنشور حتى تنشرها.'
          : 'لا توجد مسودة بعد. أول حفظ سينشئ مسودة جديدة من المحتوى المنشور دون تغيير الموقع المنشور.'),
      el('div', { class: 'meta-grid' },
        meta.map(([label, value]) => el('div', { class: 'meta-row' },
          el('span', { class: 'meta-label', text: label }),
          el('span', { class: 'meta-value', text: value })))));
  }

  function renderEditorView() {
    if (!state.content || !state.schema) return;
    const page = el('div', { class: 'editor-page' });
    page.append(editorHeader());
    const form = el('div', { class: 'editor-form' });
    if (state.view === 'sections') {
      window.CcafeEditor.renderSections(form, editorContext());
    } else {
      window.CcafeEditor.renderContent(form, editorContext());
    }
    page.append(form);
    els.view.replaceChildren(page);
  }

  let statsDispose = null;

  function renderStatsView() {
    if (statsDispose) {
      statsDispose();
      statsDispose = null;
    }
    const host = el('div', { class: 'readonly-page' });
    els.view.replaceChildren(host);
    if (!window.CcafeStats || typeof window.CcafeStats.mount !== 'function') {
      host.replaceChildren(el('section', { class: 'card empty-state' },
        el('h2', { text: 'تعذّر تحميل الصفحة' }),
        el('p', { text: 'ملف واجهة التحليلات غير متاح على هذا النشر.' })));
      return;
    }
    statsDispose = window.CcafeStats.mount(host, {
      apiGet,
      apiSend,
      confirmDialog,
      toast,
      formatDateTime,
      canClear: true,
    });
  }

  function renderPublished() {
    const published = state.published;
    const summary = state.historySummary || { count: state.history.length, latest: null };
    const count = Number.isSafeInteger(summary.count) ? summary.count : state.history.length;
    const draft = state.working && state.working.revision_id ? 'مسودة محفوظة' : 'لا توجد مسودة';

    const tiles = el('div', { class: 'tiles' },
      tile('الإصدار المنشور', `#${published.version}`),
      tile('نسخ في السجل', String(count)),
      tile('آخر حفظ منشور', published.saved_at ? formatDateTime(published.saved_at) : '—'),
      tile('المسودة', draft));

    const meta = el('section', { class: 'card pad content-meta', 'aria-labelledby': 'meta-title' },
      el('h2', { id: 'meta-title', text: 'بيانات النسخة المنشورة' }),
      el('div', { class: 'meta-grid' },
        metaRow('رقم الإصدار', `#${published.version}`),
        metaRow('وقت الحفظ', published.saved_at ? formatDateTime(published.saved_at) : '—'),
        metaRow('المصدر', 'public.published_content'),
        metaRow('نوع العرض', 'نص آمن للقراءة فقط')));

    const content = el('section', { class: 'card pad content-card', 'aria-labelledby': 'content-title' },
      el('h2', { id: 'content-title', text: 'محتوى النسخة المنشورة' }),
      el('p', { class: 'content-note', text: 'يُعرض المحتوى كما هو كنص عادي (JSON) ولا يُنفَّذ كـ HTML.' }),
      el('pre', { class: 'json-view', dir: 'ltr', tabindex: '0' },
        JSON.stringify(published.content, null, 2)));

    const actions = el('section', { class: 'card pad readonly-actions', 'aria-labelledby': 'actions-title' },
      el('h2', { id: 'actions-title', text: 'إجراءات الوسائط' }),
      el('p', { class: 'actions-note', text: 'مكتبة الوسائط متاحة للمدير: عرض الأصول الأصلية والصور المرفوعة المعتمدة، ورفع صور جديدة، ونقل صورة مرفوعة غير مستخدمة إلى سلة مهملات قابلة للاسترداد. لا تُحذف الأصول الأصلية ولا تُحذف صورة مرتبطة بالمنشور أو المسودة أو السجل. تُعرض التحليلات التجريبية في صفحة نشاط الزوار. تُجهَّز نسخة عامة من كل صورة معتمدة عند نشر المسودة.' }),
      el('div', { class: 'actions-row' },
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onClick() { selectView('media'); },
        }, 'فتح مكتبة الوسائط'),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onClick() { selectView('media'); },
        }, 'إدارة حذف الصور'),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          onClick() { selectView('stats'); },
        }, 'نشاط الزوار')));

    els.view.replaceChildren(el('div', { class: 'readonly-page' }, notice(), tiles, meta, content, actions));
  }

  function notice() {
    return el('div', { class: 'readonly-banner', role: 'note' },
      el('strong', { text: 'لوحة تحكم المحتوى. ' }),
      'يمكنك تحرير النصوص والروابط والإعدادات، حفظ المسودة، نشرها كإصدار جديد، واستعادة أي نسخة من السجل. النشر والاستعادة ينشئان إصدارًا جديدًا ولا يعيدان ترقيم السجل. مكتبة الوسائط متاحة للعرض والاختيار ورفع الصور الخاصة، وتُنسخ الصور المعتمدة إلى مساحة عامة عند النشر، كما يمكن نقل صورة مرفوعة غير مستخدمة إلى سلة مهملات قابلة للاسترداد، وتُعرض التحليلات في صفحة نشاط الزوار للمدير فقط.');
  }

  function tile(label, value) {
    return el('div', { class: 'tile-stat' },
      el('span', { class: 'tile-label', text: label }),
      el('span', { class: 'tile-value', text: value }));
  }

  function metaRow(label, value) {
    return el('div', { class: 'meta-row' },
      el('span', { class: 'meta-label', text: label }),
      el('span', { class: 'meta-value', text: value }));
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '—';
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  }

  function formatDimensions(width, height) {
    return Number.isSafeInteger(width) && Number.isSafeInteger(height)
      ? `${width}×${height}`
      : '—';
  }

  function mediaThumb(src, label) {
    if (src) {
      return el('span', { class: 'media-thumb' },
        el('img', { src, alt: '', loading: 'lazy', decoding: 'async' }));
    }
    return el('span', { class: 'media-thumb media-thumb-empty' }, el('span', { text: label || '—' }));
  }

  function originalCard(item) {
    return el('figure', { class: 'media-card' },
      mediaThumb(`/${item.logical_path}`, item.label),
      el('span', { class: 'media-name', dir: 'ltr', text: item.logical_path }),
      el('span', { class: 'media-meta' },
        el('span', { text: formatDimensions(item.width, item.height) }),
        el('span', { class: 'badge badge-on', text: 'أصل أصلي' })));
  }

  function uploadCard(asset) {
    const src = asset.status === 'approved' ? state.media.urls[asset.logical_path] : '';
    const statusLabel = asset.status === 'approved'
      ? 'معتمد'
      : asset.status === 'pending'
        ? 'بانتظار التحقق'
        : 'فشل';
    const badgeClass = asset.status === 'approved'
      ? 'badge badge-on'
      : asset.status === 'pending'
        ? 'badge'
        : 'badge badge-off';
    const meta = asset.status === 'approved'
      ? `${formatDimensions(asset.width, asset.height)} · ${formatBytes(asset.bytes)}`
      : asset.failure_reason
        ? mediaErrorText(asset.failure_reason)
        : '—';
    const deleteButton = asset.status === 'approved'
      ? el('button', {
        class: 'btn btn-small btn-danger-ghost',
        type: 'button',
        disabled: anyMediaAction(),
        title: 'نقل الصورة إلى سلة المهملات',
        onClick() { deleteMediaAsset(asset); },
      }, mediaActionBusy(asset.id, 'delete')
        ? 'جارٍ الحذف…'
        : mediaActionBusy(asset.id, 'usage')
          ? 'جارٍ التحقق…'
          : 'حذف')
      : null;
    return el('figure', { class: 'media-card' },
      mediaThumb(src, 'لا معاينة'),
      el('span', { class: 'media-name', dir: 'ltr', text: asset.original_name }),
      el('span', { class: 'media-meta' },
        el('span', { class: 'media-meta-text', text: meta }),
        el('span', { class: badgeClass, text: statusLabel })),
      deleteButton
        ? el('div', { class: 'media-card-actions' }, deleteButton)
        : null);
  }

  function trashCard(item) {
    const restoring = mediaActionBusy(item.asset_id, 'restore');
    const cleaning = mediaActionBusy(item.asset_id, 'cleanup');
    const busy = anyMediaAction();
    const stateLabel = item.state === 'restoring' ? 'قيد الاسترداد' : 'في سلة المهملات';
    const cleanupLabel = item.cleanup_state === 'done'
      ? 'نُظّف الملف الأصلي'
      : 'تنظيف الأصل معلّق';
    const publicCleanupLabel = item.public_cleanup_state === 'done'
      ? 'نُظّفت النسخة العامة'
      : 'تنظيف النسخة العامة معلّق';
    const publicCleanupPending = item.public_cleanup_state === 'pending';
    const needsCleanup = item.cleanup_state === 'pending' || publicCleanupPending;
    const meta = `${formatDimensions(item.width, item.height)} · ${formatBytes(item.bytes)}`;
    return el('figure', { class: 'media-card media-card-trash' },
      mediaThumb('', 'في السلة'),
      el('span', { class: 'media-name', dir: 'ltr', text: item.original_name }),
      el('span', { class: 'media-meta' },
        el('span', { class: 'media-meta-text', text: meta }),
        el('span', { class: 'badge badge-off', text: stateLabel })),
      el('span', { class: 'media-meta' },
        el('span', {
          class: 'media-meta-text',
          text: item.deleted_at ? `حُذفت ${formatDateTime(item.deleted_at)}` : '—',
        }),
        el('span', {
          class: item.cleanup_state === 'done' ? 'badge badge-on' : 'badge',
          text: cleanupLabel,
        })),
      item.public_cleanup_state !== 'none'
        ? el('span', {
          class: publicCleanupPending ? 'badge' : 'badge badge-on',
          text: publicCleanupLabel,
        })
        : null,
      item.cleanup_error || item.public_cleanup_error
        ? el('span', {
          class: 'group-hint',
          text: 'تعذّر تنظيف بعض الملفات سابقًا؛ النسخة المحفوظة سليمة ويمكن إعادة المحاولة.',
        })
        : null,
      el('div', { class: 'media-card-actions' },
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          disabled: busy || item.state !== 'trashed',
          onClick() { restoreMediaAsset(item); },
        }, restoring ? 'جارٍ الاسترداد…' : 'استرداد'),
        needsCleanup
          ? el('button', {
            class: 'btn btn-small btn-ghost',
            type: 'button',
            disabled: busy,
            onClick() { cleanupMediaAsset(item); },
          }, cleaning ? 'جارٍ التنظيف…' : 'إعادة محاولة التنظيف')
          : null));
  }

  function mediaSection(title, items, renderItem) {
    return el('section', { class: 'card pad media-section' },
      el('h3', { class: 'media-title', text: title }),
      items.length
        ? el('div', { class: 'media-grid' }, items.map(renderItem))
        : el('p', { class: 'group-hint', text: 'لا توجد عناصر في هذا القسم.' }));
  }

  function renderMediaView() {
    const media = state.media;
    const page = el('div', { class: 'readonly-page' });
    const limits = media.limits;

    const head = el('section', { class: 'card pad media-head', 'aria-labelledby': 'media-title' },
      el('h2', { id: 'media-title', text: 'مكتبة الوسائط' }),
      el('p', { class: 'group-hint' },
        'الأصول الأصلية الـ15 للقراءة والاختيار فقط ولا يمكن حذفها. يمكن للمدير حذف صورة مرفوعة غير مستخدمة؛ تُنقل إلى سلة المهملات وتبقى قابلة للاسترداد. لا يُحذف أي ملف نهائيًا تلقائيًا. تُجهَّز نسخة عامة من الصور المعتمدة عند نشر المسودة.'),
      limits ? el('p', { class: 'group-hint' },
        `الأنواع: PNG أو JPEG أو WebP. الحد الأقصى ${formatBytes(limits.max_bytes)}، وأقصى بُعد ${limits.max_dimension.toLocaleString('en-US')} بكسل، وأقصى ${limits.max_pixels.toLocaleString('en-US')} بكسل إجمالًا.`) : null,
      el('div', { class: 'media-head-actions' },
        el('button', {
          class: 'btn btn-small btn-ghost',
          type: 'button',
          disabled: media.loading || media.trash.loading || media.uploading || anyMediaAction(),
          onClick() { loadMedia(true); loadTrash(true); },
        }, media.loading || media.trash.loading ? 'جارٍ التحديث…' : 'تحديث المكتبة')));

    if (!media.enabled) {
      head.append(el('p', { class: 'field-warn', text: 'رفع الصور غير مهيأ على الخادم. العرض والاختيار فقط متاحان للأصول الأصلية.' }));
    }

    page.append(head);

    if (media.loading && !media.loaded) {
      page.append(el('div', { class: 'card pad preview-loading', role: 'status' }, 'جارٍ تحميل مكتبة الوسائط…'));
    } else if (media.error) {
      page.append(el('section', { class: 'card pad' },
        el('p', { class: 'field-warn', text: media.error }),
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          onClick() { loadMedia(true); },
        }, 'إعادة المحاولة')));
    }

    if (media.enabled) {
      const input = el('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp',
        multiple: true,
        hidden: true,
        onChange(event) {
          const files = Array.from(event.target.files || []);
          event.target.value = '';
          handleMediaFiles(files);
        },
      });
      const drop = el('button', {
        class: 'dropzone',
        type: 'button',
        disabled: media.uploading,
        onClick() { input.click(); },
        onDragOver(event) {
          event.preventDefault();
          if (!media.uploading) event.currentTarget.classList.add('is-over');
        },
        onDragLeave(event) {
          event.currentTarget.classList.remove('is-over');
        },
        onDrop(event) {
          event.preventDefault();
          event.currentTarget.classList.remove('is-over');
          if (!media.uploading) handleMediaFiles(event.dataTransfer.files);
        },
      }, media.uploading
        ? (media.progress || 'جارٍ رفع الصورة…')
        : 'اسحب صورة هنا أو اضغط للاختيار');
      page.append(el('section', { class: 'card pad media-upload', 'aria-labelledby': 'upload-title' },
        el('h3', { id: 'upload-title', class: 'media-title', text: 'رفع صورة جديدة' }),
        el('p', { class: 'group-hint' },
          'تُضغط الصور الكبيرة في المتصفح إلى نحو 4 MiB قبل الرفع. يبقى الملف خاصًا وغير قابل للاختيار حتى يتحقق الخادم من محتواه وأبعاده.'),
        input,
        drop));
    }

    const approved = media.assets.filter((asset) => asset.status === 'approved');
    const pending = media.assets.filter((asset) => asset.status === 'pending');
    const failed = media.assets.filter((asset) => asset.status === 'failed');

    page.append(el('div', { class: 'media-groups' },
      mediaSection(`الأصول الأصلية (${media.originals.length})`, media.originals, originalCard),
      mediaSection(`الصور المرفوعة المعتمدة (${approved.length})`, approved, uploadCard),
      mediaSection(`بانتظار التحقق (${pending.length})`, pending, uploadCard),
      mediaSection(`صور مرفوضة (${failed.length})`, failed, uploadCard)));

    const trash = media.trash;
    const trashSection = el('section', { class: 'card pad media-section', 'aria-labelledby': 'media-trash-title' },
      el('h3', { id: 'media-trash-title', class: 'media-title', text: `سلة المهملات (${trash.items.length})` }),
      el('p', { class: 'group-hint' },
        'الصور المحذوفة تبقى هنا بملفاتها الخاصة. الاسترداد يعيد الملف نفسه بعد التحقق من بصمته؛ لا حذف نهائي تلقائي.'),
      trash.error
        ? el('div', { class: 'media-trash-error' },
          el('p', { class: 'field-warn', text: trash.error }),
          el('button', {
            class: 'btn btn-small btn-primary',
            type: 'button',
            onClick() { loadTrash(true); },
          }, 'إعادة المحاولة'))
        : trash.loading && !trash.loaded
          ? el('p', { class: 'group-hint', text: 'جارٍ تحميل سلة المهملات…' })
          : trash.items.length
            ? el('div', { class: 'media-grid' }, trash.items.map(trashCard))
            : el('p', { class: 'group-hint', text: 'سلة المهملات فارغة.' }));
    page.append(trashSection);

    els.view.replaceChildren(page);
  }

  function applyMediaSelection(path, value, close) {
    window.CcafeEditor.setContentAt(state.content, path, value);
    close();
    markChanged();
    render();
  }

  function openMediaPicker(path) {
    if (!state.user || !state.content) return;
    if (!state.media.loaded && !state.media.loading) {
      toast('جارٍ تحميل مكتبة الوسائط…', 'info');
      loadMedia(true);
      return;
    }
    if (state.media.loading && !state.media.loaded) {
      toast('مكتبة الوسائط قيد التحميل. أعد المحاولة بعد لحظات.', 'info');
      return;
    }

    const current = window.CcafeEditor.getContentAt
      ? window.CcafeEditor.getContentAt(state.content, path)
      : '';
    const approved = state.media.assets.filter((asset) => asset.status === 'approved');
    const body = el('div', { class: 'media-picker' },
      el('p', { class: 'group-hint' },
        'اختر أصلًا أصليًا أو صورة مرفوعة معتمدة. الصور المرفوعة تُعرض بروابط قراءة مؤقتة للمدير فقط.'),
      el('div', { class: 'media-picker-current' },
        el('span', { class: 'media-name', dir: 'ltr', text: current || 'لا توجد صورة محددة' }),
        el('button', {
          class: 'btn btn-small btn-ghost',
          type: 'button',
          onClick() { applyMediaSelection(path, '', close); },
        }, 'مسح الصورة')),
      el('h3', { class: 'media-title', text: 'الأصول الأصلية' }),
      el('div', { class: 'media-grid' }, state.media.originals.map((item) => el('button', {
        class: 'media-card media-pick',
        type: 'button',
        title: item.label,
        onClick() { applyMediaSelection(path, item.logical_path, close); },
      },
      mediaThumb(`/${item.logical_path}`, item.label),
      el('span', { class: 'media-name', dir: 'ltr', text: item.label })))),
      el('h3', { class: 'media-title', text: 'الصور المرفوعة المعتمدة' }),
      approved.length
        ? el('div', { class: 'media-grid' }, approved.map((asset) => el('button', {
          class: 'media-card media-pick',
          type: 'button',
          title: asset.original_name,
          onClick() { applyMediaSelection(path, asset.logical_path, close); },
        },
        mediaThumb(state.media.urls[asset.logical_path], asset.original_name),
        el('span', { class: 'media-name', dir: 'ltr', text: asset.original_name }),
        el('span', { class: 'media-meta' },
          el('span', { text: formatDimensions(asset.width, asset.height) }),
          el('span', { class: 'badge badge-on', text: 'معتمد' })))))
        : el('p', { class: 'group-hint', text: 'لا توجد صور مرفوعة معتمدة بعد. ارفع صورة من مكتبة الوسائط.' }));

    let close = () => {};
    close = openModal({
      title: 'اختيار صورة',
      body,
      wide: true,
      actions: [{ label: 'إلغاء' }],
    });
  }

  function renderHistory() {
    const entries = state.history;
    const countText = `${entries.length} ${entries.length === 1 ? 'نسخة' : 'نسخ'}`;
    const actionBusy = state.publish.busy || state.restore.busy || state.historyClear.busy;

    const head = el('div', { class: 'history-head' },
      el('div', { class: 'history-head-title' },
        el('h2', { id: 'history-title', text: 'سجل النسخ المنشورة' }),
        el('span', { class: 'history-count', text: countText })),
      el('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        disabled: actionBusy,
        onClick(event) {
          event.preventDefault();
          onClearHistory();
        },
      }, state.historyClear.busy ? 'جارٍ حذف السجل…' : 'حذف سجل التعديلات نهائيًا'));

    let body;
    if (entries.length === 0) {
      body = el('div', { class: 'empty-readonly' },
        el('strong', { text: 'لا توجد نسخ في السجل.' }),
        el('span', { text: 'سيظهر هنا كل إصدار منشور عند توفره.' }));
    } else {
      const current = state.published ? state.published.version : null;
      const busy = actionBusy;
      const rows = entries.map((entry) => {
        const isCurrent = entry.version === current;
        return el('tr', { class: isCurrent ? 'row-current' : null },
          el('td', { dataset: { label: 'الإصدار' } }, el('span', { text: `#${entry.version}` })),
          el('td', { dataset: { label: 'التاريخ' } }, el('span', { text: formatDateTime(entry.created_at) })),
          el('td', { class: 'note-cell', dataset: { label: 'الملاحظة' } },
            el('span', { text: entry.note || '—' })),
          el('td', { dataset: { label: 'الحالة' } },
            el('span', { class: `badge${isCurrent ? ' badge-on' : ''}`, text: isCurrent ? 'النسخة الحالية' : 'نسخة محفوظة' })),
          el('td', { dataset: { label: 'إجراء' } },
            el('button', {
              class: 'btn btn-small btn-ghost restore-btn',
              type: 'button',
              disabled: busy || isCurrent,
              title: isCurrent ? 'هذه هي النسخة المنشورة الحالية' : `استعادة محتوى الإصدار #${entry.version}`,
              onClick(event) {
                event.preventDefault();
                onRestore(entry);
              },
            }, 'استعادة')));
      });

      body = el('div', { class: 'table-scroll' },
        el('table', { class: 'recent' },
          el('thead', {},
            el('tr', {},
              el('th', { scope: 'col', text: 'الإصدار' }),
              el('th', { scope: 'col', text: 'التاريخ' }),
              el('th', { scope: 'col', text: 'الملاحظة' }),
              el('th', { scope: 'col', text: 'الحالة' }),
              el('th', { scope: 'col', text: 'إجراء' }))),
          el('tbody', {}, rows)));
    }

    els.view.replaceChildren(el('div', { class: 'readonly-page' },
      notice(),
      el('section', { class: 'card pad history-card', 'aria-labelledby': 'history-title' },
        head,
        el('p', { class: 'group-hint' },
          'الاستعادة تنشئ إصدارًا جديدًا بمحتوى النسخة المختارة ولا تعيد ترقيم الإصدارات ولا تحذف أي نسخة. تُحفظ آخر 50 نسخة.'),
        el('p', { class: 'group-hint' },
          'حذف السجل يزيل نسخ سجل المحتوى الموجودة عند تنفيذ العملية فقط. لا يغيّر المحتوى المنشور الحالي أو رقمه أو المسودة أو الوسائط أو المستخدمين أو حالة الموقع وسجل عملياتها أو التحليلات. بعد الحذف لن تكون الاستعادة من اللوحة ممكنة للنسخ المحذوفة، وقد تبقى نسخ احتياطية سابقة خارج هذه اللوحة.'),
        body)));
  }

  function renderPreviewView() {
    const sourceLabel = state.preview.source === 'draft' ? 'مسودة محفوظة' : 'المحتوى المنشور';
    const head = el('section', { class: 'card pad preview-head' },
      el('h2', { text: 'معاينة خاصة' }),
      el('p', { class: 'group-hint' },
        'تُعرض أحدث نسخة محفوظة من المسودة (أو المحتوى المنشور إن لم توجد مسودة) بقالب الموقع الحالي. المعاينة معزولة ولا تشغّل التتبع ولا تصل إلى جلسة اللوحة.'),
      el('div', { class: 'meta-grid' },
        metaRow('المصدر', sourceLabel),
        metaRow('آخر حفظ', state.working && state.working.updated_at ? formatDateTime(state.working.updated_at) : '—'),
        metaRow('وقت المعاينة', state.preview.loadedAt ? formatDateTime(state.preview.loadedAt) : '—')),
      el('p', { class: 'group-hint preview-isolation-note' },
        'المعاينة معزولة عمدًا: الخريطة والتفاعلات التي تعتمد على JavaScript محجوبة داخل هذه اللوحة. اختبرها على الصفحة العامة بعد النشر.'),
      el('div', { class: 'preview-actions' },
        el('button', {
          class: 'btn btn-small btn-ghost',
          type: 'button',
          disabled: state.preview.loading,
          onClick() { loadPreview(); },
        }, state.preview.loading ? 'جارٍ التحضير…' : 'تحديث المعاينة'),
        hasUnsavedChanges() ? el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          disabled: state.saving,
          onClick() { requestSave('manual'); },
        }, 'حفظ ثم معاينة') : null));

    const page = el('div', { class: 'preview-page' }, head);
    if (hasUnsavedChanges()) {
      page.append(el('div', { class: 'status-banner status-banner-note', role: 'note' },
        el('strong', { text: 'تنبيه: ' }),
        'لديك تغييرات غير محفوظة. المعاينة تعرض آخر نسخة محفوظة فقط.'));
    }

    if (state.preview.loading) {
      page.append(el('div', { class: 'card pad preview-loading', role: 'status' }, 'جارٍ تحضير المعاينة…'));
    } else if (state.preview.error) {
      page.append(el('section', { class: 'card pad' },
        el('p', { class: 'field-warn', text: state.preview.error }),
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          onClick() { loadPreview(); },
        }, 'إعادة المحاولة')));
    } else if (state.preview.html) {
      const frame = el('iframe', {
        class: 'preview-frame',
        title: 'معاينة المسودة',
        sandbox: '',
        referrerpolicy: 'no-referrer',
        loading: 'eager',
      });
      frame.srcdoc = state.preview.html;
      page.append(el('div', { class: 'card preview-shell' }, frame));
    } else {
      page.append(el('section', { class: 'card pad' },
        el('p', { class: 'group-hint', text: 'لم تُحمَّل المعاينة بعد.' }),
        el('button', {
          class: 'btn btn-small btn-primary',
          type: 'button',
          onClick() { loadPreview(); },
        }, 'تحميل المعاينة')));
    }

    els.view.replaceChildren(page);
  }

  function updateNavigation() {
    document.title = `${TITLES[state.view] || 'تحرير المسودة'} — لوحة تحكم سي كافيه`;
    els['page-title'].textContent = TITLES[state.view] || 'تحرير المسودة';
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === state.view;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function render() {
    updateNavigation();
    updateStatus();
    if (!state.content && state.view !== 'site-status') return;
    if (EDITOR_VIEWS.has(state.view)) renderEditorView();
    else if (state.view === 'preview') renderPreviewView();
    else if (state.view === 'history') renderHistory();
    else if (state.view === 'media') renderMediaView();
    else if (state.view === 'stats') renderStatsView();
    else if (state.view === 'site-status') renderSiteStatusView();
    else renderPublished();
  }

  function selectView(view, focus = true) {
    if (!state.user) return;
    state.view = VIEWS.has(view) ? view : 'editor';
    if (window.location.hash !== `#${state.view}`) {
      window.history.replaceState(null, '', `#${state.view}`);
    }
    render();
    if (state.view === 'preview' && (state.previewStale || !state.preview.html)) {
      loadPreview();
    }
    if (state.view === 'media') {
      loadMedia(false);
      loadTrash(false);
    }
    if (state.view === 'site-status') loadSiteStatus(false);
    if (EDITOR_VIEWS.has(state.view)) loadMedia(false);
    if (focus) els.view.focus();
  }

  function onSaveClick() {
    if (state.saveState === 'conflict') {
      openConflictDialog();
      return;
    }
    requestSave('manual');
  }

  function bindEvents() {
    els['login-form'].addEventListener('submit', onLogin);
    els.refresh.addEventListener('click', onRefresh);
    els.logout.addEventListener('click', onLogout);
    els['save-btn'].addEventListener('click', onSaveClick);
    if (els['publish-btn']) els['publish-btn'].addEventListener('click', onPublish);
    els['preview-btn'].addEventListener('click', () => selectView('preview'));
    els['delete-btn'].addEventListener('click', onDeleteDraft);

    document.querySelectorAll('[data-nav]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        selectView(link.dataset.nav);
      });
    });

    document.querySelectorAll('[data-action="logout"]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        onLogout();
      });
    });

    window.addEventListener('hashchange', () => {
      if (!state.user) return;
      const view = window.location.hash.replace(/^#/, '');
      if (VIEWS.has(view) && view !== state.view) selectView(view);
    });

    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    });

    window.addEventListener('pagehide', () => {
      clearTimeout(state.saveTimer);
      state.token = '';
    });
  }

  function init() {
    cacheElements();
    bindEvents();
    const initial = window.location.hash.replace(/^#/, '');
    state.view = VIEWS.has(initial) ? initial : 'editor';

    try {
      state.client = createClient();
    } catch (error) {
      showLoginView();
      setLoginError(error && error.message === 'config'
        ? 'إعدادات الاتصال غير متوفرة. راجع إعدادات النشر.'
        : 'تعذّر تحميل مكتبة الدخول. راجع إعدادات النشر.');
      return;
    }

    showLoginView();
    setLoginError('');
    els['login-email'].focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
