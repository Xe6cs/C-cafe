// نماذج تعديل المحتوى: تُبنى كلها من مخطط الخادم، وصفحات النصوص والصور والأيقونات والروابط
// هي عرض مفلتر للبيانات نفسها.

import { h, svgIcon, UI, api, toast, reportError, openModal, confirmDialog, formatBytes } from './dom.js';

const FILTERS = {
  all: null,
  texts: ['text', 'textarea'],
  images: ['image'],
  icons: ['icon'],
  links: ['link', 'url'],
};

const MEDIA_LABELS = {
  'assets/uploads': 'صورك المرفوعة',
  'assets/uploads/icons': 'أيقوناتك المرفوعة',
  'assets/photos': 'صور الموقع',
  'assets/brand': 'ملفات البراند',
};

let uid = 0;
const nextId = () => `f${(uid += 1)}`;

function fieldMatches(field, view) {
  const types = FILTERS[view];
  if (!types) return true;
  if (field.type === 'group' || field.type === 'list') return field.fields.some((f) => fieldMatches(f, view));
  return types.includes(field.type) || field.alsoIn === view;
}

const getAt = (root, path) => path.reduce((obj, key) => obj[key], root);
function setAt(root, path, value) {
  getAt(root, path.slice(0, -1))[path[path.length - 1]] = value;
}

function blankItem(fields) {
  const item = {};
  for (const f of fields) {
    if (f.type === 'toggle') item[f.key] = false;
    else if (f.type === 'list') item[f.key] = [];
    else if (f.type === 'group') item[f.key] = blankItem(f.fields);
    else item[f.key] = '';
  }
  return item;
}

function wrapField(field, id, control, extra) {
  return h('div', { class: 'field' },
    h('label', { class: 'field-label', for: id }, field.label),
    control,
    extra,
    field.help ? h('small', { class: 'field-help' }, field.help) : null);
}

function textField(field, path, ctx) {
  const id = nextId();
  const multiline = field.type === 'textarea';
  const input = h(multiline ? 'textarea' : 'input', {
    id,
    class: 'input',
    dir: field.dir || 'auto',
    maxlength: field.maxLength,
    placeholder: field.placeholder,
    rows: multiline ? 2 : null,
    type: multiline ? null : 'text',
    value: getAt(ctx.state.content, path),
    onInput(e) {
      setAt(ctx.state.content, path, e.target.value);
      ctx.changed();
    },
  });
  return wrapField(field, id, input);
}

function checkUrl(value, field) {
  if (!value) return '';
  if (field.key === 'phoneIntl') return /^\+?\d[\d\s-]{6,}$/.test(value) ? '' : 'اكتب الرقم بالصيغة الدولية، مثل +9647716673643';
  return /^(https?:\/\/|tel:|mailto:|sms:|\/|#)/i.test(value) ? '' : 'يجب أن يبدأ الرابط بـ https:// أو tel:';
}

function urlInput(field, value, onValue) {
  const warn = h('small', { class: 'field-warn', hidden: true });
  const validate = (v) => {
    const message = checkUrl(v, field);
    warn.textContent = message;
    warn.hidden = !message;
  };
  const input = h('input', {
    class: 'input',
    dir: 'ltr',
    type: 'text',
    id: nextId(),
    placeholder: field.placeholder || 'https://',
    value,
    onInput(e) {
      onValue(e.target.value.trim());
      validate(e.target.value.trim());
    },
    onBlur(e) {
      const v = e.target.value.trim();
      // من يكتب www.example.com يقصد رابط موقع
      if (v && field.key !== 'phoneIntl' && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v)) {
        e.target.value = `https://${v}`;
        onValue(e.target.value);
      }
      validate(e.target.value.trim());
    },
  });
  validate(value);
  return { input, warn };
}

function urlField(field, path, ctx) {
  const { input, warn } = urlInput(field, getAt(ctx.state.content, path), (v) => {
    setAt(ctx.state.content, path, v);
    ctx.changed();
  });
  return wrapField(field, input.id, input, warn);
}

function linkField(field, path, ctx) {
  const id = nextId();
  const value = getAt(ctx.state.content, path);
  const presets = [...ctx.state.linkTokens, ...ctx.state.linkAnchors];
  const isPreset = (v) => v === '' || presets.some((p) => p.value === v);
  const custom = urlInput(field, isPreset(value) ? '' : value, (v) => {
    setAt(ctx.state.content, path, v);
    ctx.changed();
  });
  custom.input.hidden = isPreset(value);
  const option = (p) => h('option', { value: p.value }, p.label);
  const select = h('select', {
    id,
    class: 'input',
    onChange(e) {
      const isCustom = e.target.value === 'custom';
      custom.input.hidden = !isCustom;
      if (!isCustom) {
        custom.warn.hidden = true;
        setAt(ctx.state.content, path, e.target.value);
        ctx.changed();
      } else {
        custom.input.focus();
      }
    },
  },
  h('option', { value: '' }, 'بدون رابط'),
  h('optgroup', { label: 'بيانات الاتصال' }, ctx.state.linkTokens.map(option)),
  h('optgroup', { label: 'أقسام الصفحة' }, ctx.state.linkAnchors.map(option)),
  h('option', { value: 'custom' }, 'رابط مخصص…'));
  select.value = isPreset(value) ? value : 'custom';
  return wrapField(field, id, h('div', { class: 'link-control' }, select, custom.input), custom.warn);
}

function toggleField(field, path, ctx) {
  return h('label', { class: 'switch-row' },
    h('input', {
      class: 'switch',
      type: 'checkbox',
      role: 'switch',
      checked: Boolean(getAt(ctx.state.content, path)),
      onChange(e) {
        setAt(ctx.state.content, path, e.target.checked);
        ctx.changed();
      },
    }),
    h('span', {}, field.label));
}

function imageField(field, path, ctx) {
  const value = getAt(ctx.state.content, path);
  const set = (v) => {
    setAt(ctx.state.content, path, v);
    ctx.changed();
    ctx.rerender();
  };
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, field.label),
    h('div', { class: 'picker' },
      h('button', {
        class: 'picker-thumb',
        type: 'button',
        'aria-label': `تغيير ${field.label}`,
        onClick: () => pickImage(ctx, set),
      }, value ? h('img', { src: `../${value}`, alt: '', loading: 'lazy' }) : svgIcon(UI.image)),
      h('div', { class: 'picker-info' },
        h('span', { class: 'picker-name', dir: 'ltr' }, value ? value.split('/').pop() : 'لا توجد صورة'),
        h('div', { class: 'picker-actions' },
          h('button', { class: 'btn btn-small', type: 'button', onClick: () => pickImage(ctx, set) }, 'تغيير'),
          value ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', onClick: () => set('') }, 'إزالة') : null))));
}

function iconPreview(value, ctx) {
  if (!value) return h('span', { class: 'icon-none' }, '—');
  const lib = ctx.state.icons[value];
  if (lib) return svgIcon(lib.body, 'ic ic-lg');
  return h('img', { src: `../${value}`, alt: '', class: 'ic-lg' });
}

function iconName(value, ctx) {
  if (!value) return 'بدون أيقونة';
  const lib = ctx.state.icons[value];
  return lib ? lib.label : 'أيقونة مرفوعة';
}

function iconField(field, path, ctx) {
  const value = getAt(ctx.state.content, path);
  const set = (v) => {
    setAt(ctx.state.content, path, v);
    ctx.changed();
    ctx.rerender();
  };
  return h('div', { class: 'field' },
    h('span', { class: 'field-label' }, field.label),
    h('div', { class: 'picker' },
      h('button', {
        class: 'picker-thumb picker-icon',
        type: 'button',
        'aria-label': `تغيير ${field.label}`,
        onClick: () => pickIcon(ctx, set),
      }, iconPreview(value, ctx)),
      h('div', { class: 'picker-info' },
        h('span', { class: 'picker-name' }, iconName(value, ctx)),
        h('div', { class: 'picker-actions' },
          h('button', { class: 'btn btn-small', type: 'button', onClick: () => pickIcon(ctx, set) }, 'تغيير')))));
}

function groupField(field, path, ctx) {
  const parentLabel = getAt(ctx.state.content, [...path, 'label']);
  return h('fieldset', { class: 'fieldset' },
    h('legend', {}, field.label, ctx.view !== 'texts' && parentLabel ? h('span', { class: 'legend-note' }, ` · ${parentLabel}`) : null),
    renderFields(field.fields, path, ctx));
}

function listField(field, path, ctx) {
  const items = getAt(ctx.state.content, path);
  const addable = !field.max || items.length < field.max;
  return h('div', { class: 'list' },
    h('div', { class: 'list-head' },
      h('h4', {}, field.label),
      h('span', { class: 'count' }, String(items.length))),
    items.map((item, index) => listItem(field, path, items, item, index, ctx)),
    addable ? h('button', {
      class: 'btn btn-add',
      type: 'button',
      onClick() {
        items.push(blankItem(field.fields));
        ctx.state.open.add(JSON.stringify([...path, items.length - 1]));
        ctx.changed();
        ctx.rerender();
      },
    }, svgIcon(UI.plus), `إضافة ${field.itemLabel}`) : null);
}

function listItem(field, path, items, item, index, ctx) {
  const itemPath = [...path, index];
  const key = JSON.stringify(itemPath);
  const titleOf = () => item[field.titleKey] || `${field.itemLabel} ${index + 1}`;
  const title = h('span', { class: 'item-title' }, titleOf());
  const stop = (fn) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  const move = (delta) => {
    const [moved] = items.splice(index, 1);
    items.splice(index + delta, 0, moved);
    ctx.changed();
    ctx.rerender();
  };
  const details = h('details', { class: 'item', open: ctx.state.open.has(key) || null },
    h('summary', {},
      svgIcon(UI.chevron, 'ic item-caret'),
      item.image ? h('img', { class: 'item-thumb', src: `../${item.image}`, alt: '', loading: 'lazy' }) : null,
      title,
      h('span', { class: 'item-tools' },
        h('button', { class: 'btn-icon', type: 'button', 'aria-label': `نقل ${titleOf()} للأعلى`, disabled: index === 0, onClick: stop(() => move(-1)) }, svgIcon(UI.up)),
        h('button', { class: 'btn-icon', type: 'button', 'aria-label': `نقل ${titleOf()} للأسفل`, disabled: index === items.length - 1, onClick: stop(() => move(1)) }, svgIcon(UI.down)),
        h('button', {
          class: 'btn-icon btn-icon-danger',
          type: 'button',
          'aria-label': `حذف ${titleOf()}`,
          onClick: stop(() => {
            const [removed] = items.splice(index, 1);
            ctx.changed();
            ctx.rerender();
            toast(`حُذف: ${removed[field.titleKey] || field.itemLabel}`, {
              action: 'تراجع',
              onAction() {
                items.splice(index, 0, removed);
                ctx.changed();
                ctx.rerender();
              },
            });
          }),
        }, svgIcon(UI.trash)))),
    h('div', { class: 'item-body' }, renderFields(field.fields, itemPath, ctx)));
  details.addEventListener('toggle', () => {
    if (details.open) ctx.state.open.add(key);
    else ctx.state.open.delete(key);
  });
  details.addEventListener('input', () => {
    title.textContent = titleOf();
  });
  // عند تعديل مزاج معيّن تعرضه المعاينة مباشرة. يُستخدم click لأن toggle ينطلق أيضًا عند الرسم الأول.
  if (path[0] === 'moods') {
    details.addEventListener('focusin', () => ctx.selectMood(index));
    details.querySelector('summary').addEventListener('click', () => ctx.selectMood(index));
  }
  return details;
}

function renderField(field, path, ctx) {
  switch (field.type) {
    case 'textarea':
    case 'text':
      return textField(field, path, ctx);
    case 'url':
      return urlField(field, path, ctx);
    case 'link':
      return linkField(field, path, ctx);
    case 'toggle':
      return toggleField(field, path, ctx);
    case 'image':
      return imageField(field, path, ctx);
    case 'icon':
      return iconField(field, path, ctx);
    case 'group':
      return groupField(field, path, ctx);
    case 'list':
      return listField(field, path, ctx);
    default:
      return null;
  }
}

function renderFields(fields, path, ctx) {
  return fields.filter((f) => fieldMatches(f, ctx.view)).map((f) => renderField(f, [...path, f.key], ctx));
}

export function renderContentForm(container, ctx) {
  const groups = ctx.state.schema.filter((g) => g.fields.some((f) => fieldMatches(f, ctx.view)));
  // في الصفحات المفلترة تُفتح المجموعات كلها، لأن عدد الحقول فيها قليل
  const openAll = ctx.view !== 'all';
  const nodes = groups.map((g) => {
    const key = `group:${ctx.view}:${g.id}`;
    const open = ctx.state.open.has(key) || (openAll && !ctx.state.closed.has(key));
    const details = h('details', { class: 'card group', open: open || null },
      h('summary', {},
        svgIcon(UI.chevron, 'ic item-caret'),
        h('span', { class: 'group-title' }, g.title),
        g.section && ctx.state.content[g.id].visible === false ? h('span', { class: 'badge' }, 'مخفي') : null),
      h('div', { class: 'group-body' },
        g.hint ? h('p', { class: 'group-hint' }, g.hint) : null,
        renderFields(g.fields, [g.id], ctx)));
    details.addEventListener('toggle', () => {
      if (details.open) {
        ctx.state.open.add(key);
        ctx.state.closed.delete(key);
      } else {
        ctx.state.open.delete(key);
        ctx.state.closed.add(key);
      }
    });
    if (g.anchor) {
      // click وليس toggle، لأن toggle ينطلق أيضًا عند الرسم الأول فتقفز المعاينة دون طلب
      details.querySelector('summary').addEventListener('click', () => ctx.scrollPreview(g.anchor));
      details.addEventListener('focusin', (e) => {
        if (!e.target.closest('summary')) ctx.scrollPreview(g.anchor);
      });
    }
    return details;
  });
  container.replaceChildren(...nodes);
}

// ---- ترتيب الأقسام وإظهارها ---------------------------------------------------

export function renderSectionsForm(container, ctx) {
  const { content, schema } = ctx.state;
  const order = content.layout.order;
  const rows = order.map((id, index) => {
    const group = schema.find((g) => g.id === id);
    const move = (delta) => {
      const [moved] = order.splice(index, 1);
      order.splice(index + delta, 0, moved);
      ctx.changed();
      ctx.rerender();
    };
    return h('li', { class: 'section-row' },
      h('label', { class: 'switch-row' },
        h('input', {
          class: 'switch',
          type: 'checkbox',
          role: 'switch',
          checked: content[id].visible !== false,
          'aria-label': `إظهار قسم ${group.title}`,
          onChange(e) {
            content[id].visible = e.target.checked;
            ctx.changed();
          },
        }),
        h('span', {}, group.title)),
      h('span', { class: 'item-tools' },
        h('button', { class: 'btn-icon', type: 'button', 'aria-label': `نقل ${group.title} للأعلى`, disabled: index === 0, onClick: () => move(-1) }, svgIcon(UI.up)),
        h('button', { class: 'btn-icon', type: 'button', 'aria-label': `نقل ${group.title} للأسفل`, disabled: index === order.length - 1, onClick: () => move(1) }, svgIcon(UI.down))));
  });
  container.replaceChildren(
    h('section', { class: 'card pad' },
      h('p', { class: 'group-hint' }, 'الواجهة الرئيسية تبقى في الأعلى والتذييل في الأسفل. عند إخفاء قسم تختفي تلقائيًا الأزرار والروابط المؤدية إليه.'),
      h('ul', { class: 'section-list' }, rows)),
    h('section', { class: 'card group-plain' },
      h('div', { class: 'group-body' },
        h('h3', { class: 'plain-title' }, 'أجزاء ثابتة في الصفحة'),
        toggleField({ label: 'إظهار شريط الجوال السريع' }, ['quickbar', 'visible'], ctx),
        toggleField({ label: 'إظهار زر الهاتف في الترويسة' }, ['header', 'showCall'], ctx))),
  );
}

// ---- مكتبة الوسائط -------------------------------------------------------------

async function optimizeImage(file) {
  if (['image/svg+xml', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

export async function uploadFile(file, kind = 'image') {
  const body = await optimizeImage(file);
  const params = new URLSearchParams({ name: file.name, kind });
  return api('POST', `api/media?${params}`, body, { raw: true });
}

function uploadZone({ kind = 'image', label, onUploaded }) {
  const input = h('input', {
    type: 'file',
    accept: 'image/jpeg,image/png,image/webp,image/gif,image/svg+xml,image/x-icon',
    multiple: kind === 'image',
    hidden: true,
    onChange: (e) => handle([...e.target.files]),
  });
  const status = h('span', {}, label);
  const zone = h('button', {
    class: 'dropzone',
    type: 'button',
    onClick: () => input.click(),
    onDragover(e) {
      e.preventDefault();
      zone.classList.add('is-over');
    },
    onDragleave: () => zone.classList.remove('is-over'),
    onDrop(e) {
      e.preventDefault();
      zone.classList.remove('is-over');
      handle([...e.dataTransfer.files]);
    },
  }, svgIcon(UI.upload), status);

  async function handle(files) {
    if (!files.length) return;
    zone.disabled = true;
    status.textContent = 'جارٍ الرفع…';
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await uploadFile(file, kind));
      onUploaded(uploaded);
    } catch (err) {
      reportError(err);
    } finally {
      zone.disabled = false;
      status.textContent = label;
      input.value = '';
    }
  }
  return h('div', {}, zone, input);
}

function pickImage(ctx, onPick) {
  const grid = h('div', { class: 'media-groups' }, h('p', { class: 'muted' }, 'جارٍ التحميل…'));
  const modal = openModal({
    title: 'اختر صورة',
    wide: true,
    content: [
      uploadZone({
        label: 'ارفع صورة جديدة: اسحبها إلى هنا أو اضغط للاختيار',
        onUploaded(items) {
          modal.close();
          onPick(items[0].path);
          toast('تم رفع الصورة');
        },
      }),
      grid,
    ],
  });
  api('GET', 'api/media')
    .then(({ items }) => {
      const usable = items.filter((m) => m.folder !== 'assets/uploads/icons');
      grid.replaceChildren(...groupMedia(usable).map(([folder, list]) => h('section', {},
        h('h3', { class: 'media-title' }, MEDIA_LABELS[folder] || folder),
        h('div', { class: 'media-grid' }, list.map((m) => h('button', {
          class: 'media-card media-pick',
          type: 'button',
          onClick() {
            modal.close();
            onPick(m.path);
          },
        },
        h('span', { class: 'media-thumb' }, h('img', { src: `../${m.path}`, alt: '', loading: 'lazy' })),
        h('span', { class: 'media-name', dir: 'ltr' }, m.name)))))));
    })
    .catch(reportError);
}

function groupMedia(items) {
  const groups = new Map();
  for (const m of items) {
    if (!groups.has(m.folder)) groups.set(m.folder, []);
    groups.get(m.folder).push(m);
  }
  return [...groups.entries()];
}

function pickIcon(ctx, onPick) {
  const choose = (value) => {
    modal.close();
    onPick(value);
  };
  const uploaded = h('div', { class: 'icon-grid' });
  const modal = openModal({
    title: 'اختر أيقونة',
    wide: true,
    content: [
      h('div', { class: 'icon-grid' },
        h('button', { class: 'icon-card', type: 'button', onClick: () => choose('') },
          h('span', { class: 'icon-none' }, '—'), h('span', {}, 'بدون')),
        Object.entries(ctx.state.icons).map(([key, icon]) => h('button', { class: 'icon-card', type: 'button', onClick: () => choose(key) },
          svgIcon(icon.body, 'ic ic-lg'), h('span', {}, icon.label)))),
      h('h3', { class: 'media-title' }, 'أيقوناتك المرفوعة'),
      uploaded,
      uploadZone({
        kind: 'icon',
        label: 'ارفع أيقونة خاصة (SVG أو PNG بخلفية شفافة)',
        onUploaded: (items) => choose(items[0].path),
      }),
    ],
  });
  api('GET', 'api/media')
    .then(({ items }) => {
      uploaded.replaceChildren(...items.filter((m) => m.folder === 'assets/uploads/icons').map((m) => h('button', { class: 'icon-card', type: 'button', onClick: () => choose(m.path) },
        h('img', { src: `../${m.path}`, alt: '', class: 'ic-lg' }), h('span', { dir: 'ltr' }, m.name.slice(0, 14)))));
    })
    .catch(reportError);
}

export function renderMediaLibrary(container) {
  const grid = h('div', { class: 'media-groups' });

  async function load() {
    const { items } = await api('GET', 'api/media');
    grid.replaceChildren(...groupMedia(items).map(([folder, list]) => h('section', {},
      h('h3', { class: 'media-title' }, MEDIA_LABELS[folder] || folder),
      h('div', { class: 'media-grid' }, list.map((m) => h('article', { class: 'media-card' },
        h('a', { class: 'media-thumb', href: `../${m.path}`, target: '_blank', rel: 'noopener', 'aria-label': `فتح ${m.name}` },
          h('img', { src: `../${m.path}`, alt: '', loading: 'lazy' })),
        h('span', { class: 'media-name', dir: 'ltr' }, m.name),
        h('div', { class: 'media-meta' },
          m.used ? h('span', { class: 'badge badge-on' }, 'مستخدمة') : h('span', { class: 'muted' }, formatBytes(m.size)),
          m.deletable && !m.used ? h('button', {
            class: 'btn-icon btn-icon-danger',
            type: 'button',
            'aria-label': `حذف ${m.name}`,
            async onClick() {
              const ok = await confirmDialog({ title: 'حذف الصورة', text: `هل تريد حذف ${m.name} من المكتبة؟`, confirmLabel: 'حذف', danger: true });
              if (!ok) return;
              try {
                await api('DELETE', `api/media?${new URLSearchParams({ path: m.path })}`);
                toast('حُذفت الصورة');
                await load();
              } catch (err) {
                reportError(err);
              }
            },
          }, svgIcon(UI.trash)) : null)))))));
  }

  container.replaceChildren(h('section', { class: 'card group-plain' },
    h('div', { class: 'group-body' },
      h('h3', { class: 'plain-title' }, 'مكتبة الصور'),
      h('p', { class: 'group-hint' }, 'تُضغط الصور تلقائيًا قبل الرفع لتبقى صفحة موقعك سريعة.'),
      uploadZone({
        label: 'ارفع صورًا: اسحبها إلى هنا أو اضغط للاختيار',
        onUploaded(items) {
          toast(items.length > 1 ? `تم رفع ${items.length} صور` : 'تم رفع الصورة');
          load().catch(reportError);
        },
      }),
      grid)));
  load().catch(reportError);
}
