// أدوات مشتركة للواجهة. كل النصوص تُدرج نصًا عبر h()، فبيانات الزوار لا تُفسَّر كـ HTML أبدًا.

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'open', 'selected']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      if (PROPS.has(key)) el[key] = false;
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (PROPS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

// جسم الأيقونة ثابت من الخادم أو من هذا الملف، وليس من مدخلات خارجية
export function svgIcon(body, cls = 'ic') {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('class', cls);
  el.innerHTML = body;
  return el;
}

export const UI = {
  chart: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
  layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
  type: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  shapes: '<circle cx="7.5" cy="7.5" r="4.5"/><rect x="13" y="13" width="8" height="8" rx="1"/><path d="M17 3l4 7h-8z"/><path d="M3 20l4-7 4 7z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  sections: '<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/>',
  history: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  up: '<path d="M18 15l-6-6-6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M12 18h.01"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  close: '<path d="M18 6L6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  chevron: '<path d="M15 18l-6-6 6-6"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
};

export async function api(method, url, body, options = {}) {
  const init = { method, headers: { 'X-CCafe-Admin': '1' } };
  if (body !== undefined) {
    if (options.raw) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `تعذّر إكمال الطلب (${res.status})`);
  return data;
}

export function toast(message, { kind = 'info', action, onAction, duration = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', {}, message));
  const dismiss = () => el.remove();
  if (action) {
    el.append(h('button', {
      class: 'toast-action',
      type: 'button',
      onClick() {
        dismiss();
        onAction();
      },
    }, action));
  }
  box.append(el);
  setTimeout(dismiss, duration);
}

export const reportError = (err) => toast(err.message || 'حدث خطأ غير متوقع', { kind: 'error', duration: 7000 });

export function openModal({ title, wide, content, onClose }) {
  const dialog = h('dialog', { class: `modal${wide ? ' modal-wide' : ''}`, 'aria-label': title });
  const close = () => dialog.close();
  dialog.append(
    h('header', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'btn-icon', type: 'button', 'aria-label': 'إغلاق', onClick: close }, svgIcon(UI.close))),
    h('div', { class: 'modal-body' }, content),
  );
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (onClose) onClose();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { close, dialog };
}

export function confirmDialog({ title, text, confirmLabel = 'تأكيد', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const modal = openModal({
      title,
      content: h('div', { class: 'confirm' },
        h('p', {}, text),
        h('div', { class: 'confirm-actions' },
          h('button', {
            class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
            type: 'button',
            onClick() {
              answer = true;
              modal.close();
            },
          }, confirmLabel),
          h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => modal.close() }, 'إلغاء'))),
      onClose: () => resolve(answer),
    });
  });
}

export function formatDateTime(value) {
  return new Intl.DateTimeFormat('ar-IQ-u-nu-latn', {
    timeZone: 'Asia/Baghdad', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  }).format(value);
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
