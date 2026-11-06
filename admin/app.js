// هيكل لوحة التحكم: التنقل، المسودة، النشر، المعاينة الحية، السجل، والإعدادات.

import { h, svgIcon, UI, api, toast, reportError, confirmDialog, formatDateTime } from './dom.js';
import { renderContentForm, renderSectionsForm, renderMediaLibrary } from './forms.js';
import { renderStats, clearStats } from './stats.js';

const NAV = [
  { id: 'stats', label: 'نشاط الزوار', icon: 'chart' },
  { heading: 'إدارة الموقع' },
  { id: 'all', label: 'كل المحتوى', icon: 'layers' },
  { id: 'texts', label: 'النصوص', icon: 'type' },
  { id: 'images', label: 'الصور', icon: 'image' },
  { id: 'icons', label: 'الأيقونات', icon: 'shapes' },
  { id: 'links', label: 'الروابط', icon: 'link' },
  { id: 'sections', label: 'ترتيب الأقسام', icon: 'sections' },
  { heading: 'النظام' },
  { id: 'history', label: 'سجل النسخ', icon: 'history' },
  { id: 'settings', label: 'الإعدادات', icon: 'settings' },
];
const EDITOR_VIEWS = new Set(['all', 'texts', 'images', 'icons', 'links', 'sections']);

const state = {
  schema: [],
  linkTokens: [],
  linkAnchors: [],
  icons: {},
  content: null,
  published: null,
  access: {},
  open: new Set(),
  closed: new Set(),
};

const view = document.getElementById('view');
const titleEl = document.getElementById('page-title');
const publishBtn = document.getElementById('publish');
const discardBtn = document.getElementById('discard');
const draftState = document.getElementById('draft-state');
const publishBox = document.getElementById('publish-box');

let cleanup = null;
let syncTimer = null;
let syncing = Promise.resolve();
let currentRoute = '';

const isDirty = () => JSON.stringify(state.content) !== JSON.stringify(state.published);

function updateDraftState() {
  const dirty = isDirty();
  draftState.textContent = dirty ? 'تعديلات محفوظة كمسودة ولم تُنشر بعد' : 'كل التعديلات منشورة';
  draftState.classList.toggle('is-dirty', dirty);
  publishBtn.disabled = !dirty;
  discardBtn.hidden = !dirty;
}

// ---- المعاينة الحية -----------------------------------------------------------

const preview = (() => {
  const frame = h('iframe', { class: 'pv-frame', title: 'معاينة الموقع', src: '/admin-preview' });
  const stage = h('div', { class: 'pv-stage' }, frame);
  let device = 'mobile';
  let keepY = 0;
  let anchor = null;
  let mood = null;

  try {
    device = localStorage.getItem('ccafe-pv-device') || 'mobile';
  } catch { /* تبقى القيمة الافتراضية */ }

  function fit() {
    const width = device === 'mobile' ? 390 : 1280;
    const scale = Math.min(1, stage.clientWidth / width);
    frame.style.width = `${width}px`;
    frame.style.height = `${stage.clientHeight / scale}px`;
    frame.style.transform = `translateX(-50%) scale(${scale})`;
  }
  new ResizeObserver(fit).observe(stage);

  const win = () => {
    try {
      return frame.contentWindow && frame.contentWindow.document ? frame.contentWindow : null;
    } catch {
      return null;
    }
  };

  function applyMood() {
    const w = win();
    if (w && mood !== null) {
      const tab = w.document.getElementById(`tab-${mood}`);
      if (tab) tab.click();
    }
  }

  // scrollIntoView داخل الإطار يحرّك الصفحة الأم أيضًا، لذلك يُحسب الموضع يدويًا
  function scrollFrameTo(w, id) {
    const el = w.document.getElementById(id);
    if (!el) return false;
    w.scrollTo(0, el.getBoundingClientRect().top + w.scrollY);
    return true;
  }

  frame.addEventListener('load', () => {
    const w = win();
    if (!w) return;
    applyMood();
    if (anchor) {
      scrollFrameTo(w, anchor);
      anchor = null;
    } else {
      w.scrollTo(0, keepY);
    }
  });

  const deviceButtons = {};
  function setDevice(value) {
    device = value;
    try {
      localStorage.setItem('ccafe-pv-device', value);
    } catch { /* لا يؤثر */ }
    for (const [key, btn] of Object.entries(deviceButtons)) {
      btn.setAttribute('aria-pressed', key === value ? 'true' : 'false');
    }
    fit();
  }
  deviceButtons.mobile = h('button', { class: 'btn-icon', type: 'button', 'aria-label': 'عرض الجوال', title: 'جوال', onClick: () => setDevice('mobile') }, svgIcon(UI.phone));
  deviceButtons.desktop = h('button', { class: 'btn-icon', type: 'button', 'aria-label': 'عرض الكمبيوتر', title: 'كمبيوتر', onClick: () => setDevice('desktop') }, svgIcon(UI.monitor));

  const panel = h('aside', { class: 'pv', 'aria-label': 'معاينة حية' },
    h('div', { class: 'pv-bar' },
      h('span', { class: 'pv-title' }, 'معاينة حية'),
      h('span', { class: 'pv-tools' },
        deviceButtons.mobile,
        deviceButtons.desktop,
        h('button', {
          class: 'btn-icon pv-close',
          type: 'button',
          'aria-label': 'إغلاق المعاينة',
          onClick: () => panel.classList.remove('is-open'),
        }, svgIcon(UI.close)))),
    stage);
  setDevice(device);

  return {
    panel,
    fit,
    open() {
      panel.classList.add('is-open');
      fit();
    },
    reload() {
      const w = win();
      keepY = w ? w.scrollY : 0;
      if (w) w.location.reload();
      else frame.src = '/admin-preview';
    },
    scrollTo(id) {
      const w = win();
      if (!w || !scrollFrameTo(w, id)) anchor = id;
    },
    selectMood(index) {
      mood = index;
      applyMood();
    },
  };
})();

function changed() {
  updateDraftState();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncDraft, 400);
}

function syncDraft() {
  syncTimer = null;
  const payload = JSON.stringify({ content: state.content });
  syncing = syncing
    .then(() => api('PUT', 'api/draft', JSON.parse(payload)))
    .then(() => preview.reload())
    .catch(reportError);
  return syncing;
}

let lastAnchor = null;
const formContext = (route, rerender) => ({
  state,
  view: route,
  changed,
  rerender,
  selectMood: (i) => preview.selectMood(i),
  scrollPreview(anchor) {
    if (anchor !== lastAnchor) {
      lastAnchor = anchor;
      preview.scrollTo(anchor);
    }
  },
});

function renderEditor(route) {
  const form = h('div', { class: 'form-col' });
  const library = route === 'images' ? h('div', {}) : null;
  const body = h('div', {});
  const rerender = () => {
    const ctx = formContext(route, rerender);
    if (route === 'sections') renderSectionsForm(body, ctx);
    else renderContentForm(body, ctx);
  };
  if (library) renderMediaLibrary(library);
  form.append(body);
  if (library) form.append(library);
  rerender();
  view.replaceChildren(
    h('div', { class: 'editor' },
      form,
      preview.panel,
      h('button', { class: 'btn btn-primary pv-fab', type: 'button', onClick: () => preview.open() }, svgIcon(UI.eye), 'معاينة')),
  );
  preview.fit();
}

// ---- سجل النسخ -----------------------------------------------------------------

async function renderHistory() {
  const list = h('ol', { class: 'history' }, h('li', { class: 'muted' }, 'جارٍ التحميل…'));
  view.replaceChildren(h('section', { class: 'card pad' },
    h('p', { class: 'group-hint' }, 'تُحفظ نسخة كاملة من الموقع عند كل نشر، وتُبقى آخر 50 نسخة. استعادة نسخة قديمة تنشرها فورًا وتبقى النسخة الحالية في السجل.'),
    list));
  const { items } = await api('GET', 'api/history');
  list.replaceChildren(...items.map((item, index) => h('li', { class: 'history-row' },
    h('div', {},
      h('strong', {}, formatDateTime(item.at)),
      h('span', { class: 'muted' }, ` · ${item.note}`),
      index === 0 ? h('span', { class: 'badge badge-on' }, 'المنشورة الآن') : null),
    index === 0 ? null : h('button', {
      class: 'btn btn-small',
      type: 'button',
      async onClick() {
        const ok = await confirmDialog({
          title: 'استعادة نسخة سابقة',
          text: `سيعود الموقع فورًا إلى نسخة ${formatDateTime(item.at)}.${isDirty() ? ' وستضيع التعديلات غير المنشورة.' : ''}`,
          confirmLabel: 'استعادة ونشر',
        });
        if (!ok) return;
        try {
          clearTimeout(syncTimer);
          const res = await api('POST', 'api/history/restore', { id: item.id });
          state.published = res.published;
          replaceContent(res.published);
          preview.reload();
          toast('تمت استعادة النسخة ونشرها');
        } catch (err) {
          reportError(err);
        }
      },
    }, 'استعادة'))));
}

// ---- الإعدادات -----------------------------------------------------------------

function renderSettings() {
  const { access } = state;
  const base = access.site || 'https://رابط-موقعك';
  const linkInput = h('input', { class: 'input', dir: 'ltr', readonly: true, value: `${base}${access.remotePath}`, 'aria-label': 'الرابط السري' });

  let notrack = false;
  try {
    notrack = localStorage.getItem('ccafe-notrack') === '1';
  } catch { /* يبقى الافتراضي */ }

  view.replaceChildren(h('div', { class: 'settings' },
    h('section', { class: 'card pad' },
      h('h2', { class: 'panel-title' }, 'الوصول إلى لوحة التحكم'),
      h('p', {}, 'لا توجد كلمة مرور. من الجهاز الذي يشغّل الموقع تفتح اللوحة مباشرة، ومن أي جهاز آخر افتح الرابط السري أدناه مرة واحدة فيتذكر الجهاز الإذن.'),
      h('p', { class: 'notice notice-warn' }, 'من يملك هذا الرابط يستطيع تعديل موقعك كاملًا، فلا تشاركه. وإذا تسرّب اضغط «تغيير الرابط» لإلغائه وإخراج كل الأجهزة.'),
      h('div', { class: 'copy-row' },
        linkInput,
        h('button', {
          class: 'btn',
          type: 'button',
          async onClick() {
            try {
              await navigator.clipboard.writeText(linkInput.value);
              toast('نُسخ الرابط');
            } catch {
              linkInput.select();
              toast('حدد الرابط وانسخه يدويًا', { kind: 'error' });
            }
          },
        }, svgIcon(UI.copy), 'نسخ'),
        h('button', {
          class: 'btn btn-ghost',
          type: 'button',
          async onClick() {
            const ok = await confirmDialog({ title: 'تغيير الرابط السري', text: 'سيتوقف الرابط الحالي عن العمل وتخرج كل الأجهزة البعيدة من اللوحة.', confirmLabel: 'تغيير الرابط', danger: true });
            if (!ok) return;
            try {
              const res = await api('POST', 'api/access/rotate', {});
              access.remotePath = res.remotePath;
              linkInput.value = `${base}${res.remotePath}`;
              toast('تم تغيير الرابط');
            } catch (err) {
              reportError(err);
            }
          },
        }, 'تغيير الرابط')),
      access.site ? null : h('small', { class: 'field-help' }, 'بعد نشر الموقع أضف رابطه في «كل المحتوى ← البحث والمشاركة» ليكتمل الرابط السري هنا.')),

    h('section', { class: 'card pad' },
      h('h2', { class: 'panel-title' }, 'تتبع الزوار'),
      h('label', { class: 'switch-row' },
        h('input', {
          class: 'switch',
          type: 'checkbox',
          role: 'switch',
          checked: state.content.settings.tracking,
          onChange(e) {
            state.content.settings.tracking = e.target.checked;
            changed();
          },
        }),
        h('span', {}, 'تشغيل التتبع في الموقع'),
      ),
      h('small', { class: 'field-help' }, 'يسري بعد نشر التعديلات.'),
      h('label', { class: 'switch-row' },
        h('input', {
          class: 'switch',
          type: 'checkbox',
          role: 'switch',
          checked: notrack,
          onChange(e) {
            try {
              if (e.target.checked) localStorage.setItem('ccafe-notrack', '1');
              else localStorage.removeItem('ccafe-notrack');
              toast(e.target.checked ? 'لن تُحسب زيارات هذا المتصفح' : 'ستُحسب زيارات هذا المتصفح');
            } catch (err) {
              reportError(err);
            }
          },
        }),
        h('span', {}, 'لا تحسب زياراتي من هذا المتصفح'),
      ),
      h('p', { class: 'privacy' }, 'ما يُسجَّل: وقت الزيارة، مصدرها، نوع الجهاز والمتصفح، الأقسام التي وصل إليها الزائر، ما ضغط عليه، ومدة البقاء. لا تُستخدم كوكيز، ولا يُحفظ عنوان IP، ولا يُربط الزائر بين يوم وآخر.'),
      h('button', {
        class: 'btn btn-danger-ghost',
        type: 'button',
        async onClick() {
          try {
            if (await clearStats()) toast('مُسحت بيانات الزيارات');
          } catch (err) {
            reportError(err);
          }
        },
      }, svgIcon(UI.trash), 'مسح كل بيانات الزيارات'))));
}

// ---- التنقل --------------------------------------------------------------------

function renderNav(active) {
  const nav = document.getElementById('side-nav');
  nav.replaceChildren(...NAV.map((item) => {
    if (item.heading) return h('p', { class: 'nav-heading' }, item.heading);
    return h('a', { href: `#/${item.id}`, class: item.id === active ? 'is-active' : null, 'aria-current': item.id === active ? 'page' : null },
      svgIcon(UI[item.icon]), item.label);
  }));
}

function renderRoute(id) {
  if (cleanup) cleanup();
  cleanup = null;
  try {
    if (id === 'stats') cleanup = renderStats(view, { access: state.access });
    else if (id === 'history') renderHistory().catch(reportError);
    else if (id === 'settings') renderSettings();
    else renderEditor(id);
  } catch (err) {
    reportError(err);
  }
}

function route() {
  const id = location.hash.replace(/^#\/?/, '') || 'stats';
  const item = NAV.find((n) => n.id === id);
  if (!item) {
    location.hash = '#/stats';
    return;
  }
  if (id === currentRoute) return;
  currentRoute = id;
  renderNav(id);
  titleEl.textContent = item.label;
  document.title = `${item.label} · لوحة تحكم سي كافيه`;
  publishBox.hidden = !(EDITOR_VIEWS.has(id) || id === 'settings');
  preview.panel.classList.remove('is-open');
  window.scrollTo(0, 0);
  renderRoute(id);
}

// عند استبدال المحتوى كاملًا يُعاد بناء النموذج، لأن عناصره ترتبط بالقوائم القديمة
function replaceContent(content) {
  state.content = structuredClone(content);
  updateDraftState();
  renderRoute(currentRoute);
}

publishBtn.addEventListener('click', async () => {
  publishBtn.disabled = true;
  try {
    clearTimeout(syncTimer);
    await syncing;
    const res = await api('POST', 'api/publish', { content: state.content });
    state.published = res.published;
    replaceContent(res.published);
    toast('تم نشر التعديلات على الموقع', { kind: 'success' });
  } catch (err) {
    reportError(err);
    updateDraftState();
  }
});

discardBtn.addEventListener('click', async () => {
  const ok = await confirmDialog({ title: 'تجاهل التعديلات', text: 'سيعود كل شيء إلى آخر نسخة منشورة.', confirmLabel: 'تجاهل التعديلات', danger: true });
  if (!ok) return;
  try {
    clearTimeout(syncTimer);
    await syncing;
    const res = await api('DELETE', 'api/draft');
    replaceContent(res.content);
    preview.reload();
  } catch (err) {
    reportError(err);
  }
});

window.addEventListener('hashchange', route);

(async function start() {
  try {
    const data = await api('GET', 'api/bootstrap');
    Object.assign(state, {
      schema: data.schema,
      linkTokens: data.linkTokens,
      linkAnchors: data.linkAnchors,
      icons: data.icons,
      content: data.content,
      published: data.published,
      access: data.access,
    });
    updateDraftState();
    route();
  } catch (err) {
    view.replaceChildren(h('div', { class: 'card pad' }, h('p', {}, 'تعذّر تحميل لوحة التحكم. تأكد أن الخادم يعمل ثم أعد تحميل الصفحة.')));
    reportError(err);
  }
})();
