'use strict';
// محرر المسودة: يبني النماذج من مخطط الخادم نفسه (lib/schema.js) ويحافظ على
// نفس مكونات لوحة التحكم الأصلية. الصور والأيقونات تُعرض للقراءة فقط.
//
// يعمل في المتصفح كـ window.CcafeEditor، ويُصدَّر أيضًا لاختبارات Node.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CcafeEditor = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FILTERS = {
    all: null,
    texts: ['text', 'textarea'],
    links: ['link', 'url'],
  };

  const PRESET_LINKS = new Set(['@phone', '@maps', '@instagram']);
  const IMAGE_RE = /^assets\/[A-Za-z0-9_./-]+$/;
  const MEDIA_RE = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  function h(tag, props, ...children) {
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

  function getAt(root, path) {
    return path.reduce((obj, key) => (obj === null || obj === undefined ? undefined : obj[key]), root);
  }

  function setAt(root, path, value) {
    const parent = getAt(root, path.slice(0, -1));
    if (parent && typeof parent === 'object') parent[path[path.length - 1]] = value;
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function fieldMatches(field, view) {
    const types = FILTERS[view];
    if (!types) return true;
    if (field.type === 'group' || field.type === 'list') {
      return field.fields.some((f) => fieldMatches(f, view));
    }
    return types.includes(field.type) || field.alsoIn === view;
  }

  function blankItem(fields) {
    const item = {};
    for (const field of fields) {
      if (field.type === 'toggle') item[field.key] = false;
      else if (field.type === 'list') item[field.key] = [];
      else if (field.type === 'group') item[field.key] = blankItem(field.fields);
      else item[field.key] = '';
    }
    return item;
  }

  function linkError(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (PRESET_LINKS.has(text)) return '';
    if (/^#[\w-]+$/.test(text)) return '';
    if (/^(https?:\/\/|tel:|mailto:|sms:)/i.test(text)) return '';
    if (/^\/(?!\/)/.test(text)) return '';
    return 'استخدم رابطًا يبدأ بـ https:// أو #قسم أو @phone.';
  }

  function urlError(value, field) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (field.key === 'phoneIntl') {
      return /^\+?[0-9 ()-]+$/.test(text) ? '' : 'اكتب الرقم بالصيغة الدولية، مثل +9647716673643';
    }
    return /^https?:\/\//i.test(text) ? '' : 'يجب أن يبدأ الرابط بـ https://';
  }

  function assetSrc(value, urls) {
    const v = String(value || '');
    if (MEDIA_RE.test(v)) {
      const url = urls && Object.prototype.hasOwnProperty.call(urls, v) ? urls[v] : '';
      return typeof url === 'string' && /^https:\/\//i.test(url) ? url : '';
    }
    return IMAGE_RE.test(v) && !v.includes('..') ? `/${v}` : '';
  }

  function wrapField(field, id, control, extra) {
    return h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, field.label),
      control,
      extra,
      field.help ? h('small', { class: 'field-help' }, field.help) : null);
  }

  let uid = 0;
  function nextId() {
    uid += 1;
    return `ef${uid}`;
  }

  function textField(field, path, ctx) {
    const id = nextId();
    const multiline = field.type === 'textarea';
    const value = getAt(ctx.content, path);
    const input = h(multiline ? 'textarea' : 'input', {
      id,
      class: 'input',
      dir: field.dir || 'auto',
      maxlength: field.maxLength,
      placeholder: field.placeholder,
      rows: multiline ? 4 : null,
      type: multiline ? null : 'text',
      onInput(event) {
        setAt(ctx.content, path, event.target.value);
        ctx.changed();
      },
    });
    input.value = value === null || value === undefined ? '' : String(value);
    return wrapField(field, id, input);
  }

  function urlInput(field, value, onValue, validator) {
    const warn = h('small', { class: 'field-warn', hidden: true });
    const validate = (v) => {
      const message = validator ? validator(v) : urlError(v, field);
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
      onInput(event) {
        const v = event.target.value.trim();
        onValue(v);
        validate(v);
      },
      onBlur(event) {
        let v = event.target.value.trim();
        if (v && field.key !== 'phoneIntl' && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/.test(v)) {
          v = `https://${v}`;
          event.target.value = v;
          onValue(v);
        }
        validate(v);
      },
    });
    validate(value);
    return { input, warn };
  }

  function urlField(field, path, ctx) {
    const { input, warn } = urlInput(field, getAt(ctx.content, path), (value) => {
      setAt(ctx.content, path, value);
      ctx.changed();
    });
    return wrapField(field, input.id, input, warn);
  }

  function linkField(field, path, ctx) {
    const id = nextId();
    const value = getAt(ctx.content, path);
    const presets = [...ctx.linkTokens, ...ctx.linkAnchors];
    const isPreset = (v) => v === '' || presets.some((preset) => preset.value === v);
    const custom = urlInput(field, isPreset(value) ? '' : value, (next) => {
      setAt(ctx.content, path, next);
      ctx.changed();
    }, linkError);
    custom.input.hidden = isPreset(value);

    const option = (preset) => h('option', { value: preset.value }, preset.label);
    const select = h('select', {
      id,
      class: 'input',
      onChange(event) {
        const isCustom = event.target.value === 'custom';
        custom.input.hidden = !isCustom;
        if (!isCustom) {
          custom.warn.hidden = true;
          setAt(ctx.content, path, event.target.value);
          ctx.changed();
        } else {
          custom.input.focus();
        }
      },
    },
    h('option', { value: '' }, 'بدون رابط'),
    h('optgroup', { label: 'بيانات الاتصال' }, ctx.linkTokens.map(option)),
    h('optgroup', { label: 'أقسام الصفحة' }, ctx.linkAnchors.map(option)),
    h('option', { value: 'custom' }, 'رابط مخصص…'));
    select.value = isPreset(value) ? value : 'custom';

    return wrapField(field, id, h('div', { class: 'link-control' }, select, custom.input), custom.warn);
  }

  function toggleInput(label, checked, ariaLabel, onChange) {
    return h('label', { class: 'switch-row' },
      h('input', {
        class: 'switch',
        type: 'checkbox',
        role: 'switch',
        checked: Boolean(checked),
        'aria-label': ariaLabel || null,
        onChange(event) {
          onChange(event.target.checked);
        },
      }),
      h('span', {}, label));
  }

  function toggleField(field, path, ctx) {
    return toggleInput(field.label, getAt(ctx.content, path), field.label, (checked) => {
      setAt(ctx.content, path, checked);
      ctx.changed();
    });
  }

  function readOnlyMedia(field, value, isIcon, ctx) {
    const src = !isIcon ? assetSrc(value, ctx && ctx.mediaUrls) : assetSrc(value, ctx && ctx.mediaUrls);
    let preview;
    if (src) {
      preview = h('span', { class: 'picker-thumb' }, h('img', { src, alt: '', loading: 'lazy' }));
    } else {
      preview = h('span', { class: 'picker-thumb picker-icon' },
        h('span', { class: 'icon-name', dir: 'ltr' }, value || '—'));
    }
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, field.label),
      h('div', { class: 'picker readonly-picker' },
        preview,
        h('div', { class: 'picker-info' },
          h('span', { class: 'picker-name', dir: 'ltr' }, value || (isIcon ? 'بدون أيقونة' : 'لا توجد صورة')),
          h('small', { class: 'field-help' },
            isIcon
              ? 'الأيقونة محفوظة كما هي؛ تغيير الأيقونات غير متاح في هذه المرحلة.'
              : 'مرجع الصورة محفوظ كما هو.'))));
  }

  function imageFieldControl(field, path, ctx) {
    const value = getAt(ctx.content, path);
    const urls = ctx.mediaUrls || {};
    const src = assetSrc(value, urls);
    const isMedia = MEDIA_RE.test(String(value || ''));
    const preview = src
      ? h('span', { class: 'picker-thumb' }, h('img', { src, alt: '', loading: 'lazy' }))
      : h('span', { class: 'picker-thumb picker-empty' }, '—');
    const actions = [];
    if (typeof ctx.pickImage === 'function') {
      actions.push(h('button', {
        class: 'btn btn-small',
        type: 'button',
        onClick() { ctx.pickImage(path); },
      }, 'اختيار من المكتبة'));
      if (value) {
        actions.push(h('button', {
          class: 'btn btn-ghost btn-small',
          type: 'button',
          onClick() {
            setAt(ctx.content, path, '');
            ctx.changed();
            ctx.rerender();
          },
        }, 'مسح'));
      }
    }
    const help = isMedia
      ? 'صورة مرفوعة معتمدة. عند نشر المسودة تُجهَّز نسخة عامة وتظهر للزائر.'
      : 'يمكنك اختيار أصل أصلي أو صورة مرفوعة معتمدة. رفع صور جديدة من مكتبة الوسائط.';
    return h('div', { class: 'field' },
      h('span', { class: 'field-label' }, field.label),
      h('div', { class: 'picker image-picker' },
        preview,
        h('div', { class: 'picker-info' },
          h('span', { class: 'picker-name', dir: 'ltr' }, value || 'لا توجد صورة'),
          h('small', { class: 'field-help' }, help)),
        actions.length ? h('div', { class: 'picker-actions' }, actions) : null));
  }

  function iconField(field, path, ctx) {
    return readOnlyMedia(field, getAt(ctx.content, path), true, ctx);
  }

  function groupField(field, path, ctx) {
    return h('fieldset', { class: 'fieldset' },
      h('legend', {}, field.label),
      renderFields(field.fields, path, ctx));
  }

  function listField(field, path, ctx) {
    const items = getAt(ctx.content, path);
    if (!Array.isArray(items)) return null;
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
          ctx.openItems.add(JSON.stringify([...path, items.length - 1]));
          ctx.changed();
          ctx.rerender();
        },
      }, '+', ` إضافة ${field.itemLabel}`) : null);
  }

  function listItem(field, path, items, item, index, ctx) {
    const itemPath = [...path, index];
    const key = JSON.stringify(itemPath);
    const titleOf = () => item[field.titleKey] || `${field.itemLabel} ${index + 1}`;
    const title = h('span', { class: 'item-title' }, titleOf());
    const stop = (fn) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      fn();
    };
    const move = (delta) => {
      const [moved] = items.splice(index, 1);
      items.splice(index + delta, 0, moved);
      ctx.changed();
      ctx.rerender();
    };

    const details = h('details', { class: 'item', open: ctx.openItems.has(key) || null },
      h('summary', {},
        h('span', { class: 'item-caret', 'aria-hidden': 'true' }, '▾'),
        assetSrc(item.image, ctx.mediaUrls) ? h('img', { class: 'item-thumb', src: assetSrc(item.image, ctx.mediaUrls), alt: '', loading: 'lazy' }) : null,
        title,
        h('span', { class: 'item-tools' },
          h('button', {
            class: 'btn-icon',
            type: 'button',
            'aria-label': `نقل ${titleOf()} للأعلى`,
            disabled: index === 0,
            onClick: stop(() => move(-1)),
          }, '↑'),
          h('button', {
            class: 'btn-icon',
            type: 'button',
            'aria-label': `نقل ${titleOf()} للأسفل`,
            disabled: index === items.length - 1,
            onClick: stop(() => move(1)),
          }, '↓'),
          h('button', {
            class: 'btn-icon btn-icon-danger',
            type: 'button',
            'aria-label': `حذف ${titleOf()}`,
            onClick: stop(() => {
              items.splice(index, 1);
              ctx.changed();
              ctx.rerender();
            }),
          }, '🗑'))),
      h('div', { class: 'item-body' }, renderFields(field.fields, itemPath, ctx)));

    details.addEventListener('toggle', () => {
      if (details.open) ctx.openItems.add(key);
      else ctx.openItems.delete(key);
    });
    details.addEventListener('input', () => {
      title.textContent = titleOf();
    });
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
        return imageFieldControl(field, path, ctx);
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
    return fields
      .filter((field) => fieldMatches(field, ctx.view))
      .map((field) => renderField(field, [...path, field.key], ctx));
  }

  function renderContent(container, ctx) {
    const groups = ctx.schema.filter((group) => group.fields.some((field) => fieldMatches(field, ctx.view)));
    const openAll = ctx.view !== 'all';
    const nodes = groups.map((group) => {
      const key = `group:${ctx.view}:${group.id}`;
      const open = ctx.openGroups.has(key) || (openAll && !ctx.closedGroups.has(key));
      const details = h('details', { class: 'card group', open: open || null },
        h('summary', {},
          h('span', { class: 'item-caret', 'aria-hidden': 'true' }, '▾'),
          h('span', { class: 'group-title' }, group.title),
          group.section && ctx.content[group.id] && ctx.content[group.id].visible === false
            ? h('span', { class: 'badge' }, 'مخفي')
            : null),
        h('div', { class: 'group-body' },
          group.hint ? h('p', { class: 'group-hint' }, group.hint) : null,
          renderFields(group.fields, [group.id], ctx)));
      details.addEventListener('toggle', () => {
        if (details.open) {
          ctx.openGroups.add(key);
          ctx.closedGroups.delete(key);
        } else {
          ctx.openGroups.delete(key);
          ctx.closedGroups.add(key);
        }
      });
      return details;
    });
    container.replaceChildren(...nodes);
  }

  function sectionTitle(groups, id) {
    const group = groups.find((item) => item.id === id);
    return group ? group.title : id;
  }

  function renderSections(container, ctx) {
    const order = ctx.content.layout.order;
    const groups = ctx.schema;
    const rows = order.map((id, index) => {
      const group = groups.find((item) => item.id === id);
      const title = group ? group.title : id;
      const move = (delta) => {
        const [moved] = order.splice(index, 1);
        order.splice(index + delta, 0, moved);
        ctx.changed();
        ctx.rerender();
      };
      return h('li', { class: 'section-row' },
        toggleInput(title, ctx.content[id].visible !== false, `إظهار قسم ${title}`, (checked) => {
          ctx.content[id].visible = checked;
          ctx.changed();
        }),
        h('span', { class: 'item-tools' },
          h('button', {
            class: 'btn-icon',
            type: 'button',
            'aria-label': `نقل ${title} للأعلى`,
            disabled: index === 0,
            onClick: () => move(-1),
          }, '↑'),
          h('button', {
            class: 'btn-icon',
            type: 'button',
            'aria-label': `نقل ${title} للأسفل`,
            disabled: index === order.length - 1,
            onClick: () => move(1),
          }, '↓')));
    });

    container.replaceChildren(
      h('section', { class: 'card pad' },
        h('p', { class: 'group-hint' }, 'الواجهة الرئيسية تبقى في الأعلى والتذييل في الأسفل. عند إخفاء قسم تختفي تلقائيًا الأزرار والروابط المؤدية إليه.'),
        h('ul', { class: 'section-list' }, rows)),
      h('section', { class: 'card group-plain' },
        h('div', { class: 'group-body' },
          h('h3', { class: 'plain-title' }, 'أجزاء ثابتة في الصفحة'),
          toggleInput('إظهار شريط الجوال السريع', ctx.content.quickbar.visible, 'إظهار شريط الجوال السريع', (checked) => {
            ctx.content.quickbar.visible = checked;
            ctx.changed();
          }),
          toggleInput('إظهار زر الهاتف في الترويسة', ctx.content.header.showCall, 'إظهار زر الهاتف في الترويسة', (checked) => {
            ctx.content.header.showCall = checked;
            ctx.changed();
          }))));
  }

  function formatValue(value) {
    if (value === true) return 'مفعّل';
    if (value === false) return 'مخفّف';
    if (value === null || value === undefined || value === '') return '—';
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }

  function collectFields(obj, fields, labelPrefix, keyPrefix, out) {
    for (const field of fields) {
      const key = `${keyPrefix}.${field.key}`;
      const label = `${labelPrefix}${field.label}`;
      const value = obj && typeof obj === 'object' ? obj[field.key] : undefined;
      if (field.type === 'group') {
        collectFields(isObject(value) ? value : {}, field.fields, `${label} · `, key, out);
      } else if (field.type === 'list') {
        const list = Array.isArray(value) ? value : [];
        out.set(key, { label: `${label} (عدد العناصر)`, value: list.length });
        list.forEach((item, index) => {
          collectFields(isObject(item) ? item : {}, field.fields, `${label} [${index + 1}] · `, `${key}[${index}]`, out);
        });
      } else {
        out.set(key, { label, value });
      }
    }
  }

  function diffContent(mine, theirs, groups) {
    const left = new Map();
    const right = new Map();
    for (const group of groups) {
      collectFields(isObject(mine) ? mine[group.id] || {} : {}, group.fields, `${group.title} · `, group.id, left);
      collectFields(isObject(theirs) ? theirs[group.id] || {} : {}, group.fields, `${group.title} · `, group.id, right);
    }

    const orderLabel = 'ترتيب الأقسام';
    const orderValue = (content) => (content && content.layout && Array.isArray(content.layout.order)
      ? content.layout.order.map((id) => sectionTitle(groups, id)).join(' ← ')
      : '');
    left.set('layout.order', { label: orderLabel, value: orderValue(mine) });
    right.set('layout.order', { label: orderLabel, value: orderValue(theirs) });

    for (const group of groups) {
      if (!group.section) continue;
      const key = `visibility.${group.id}`;
      left.set(key, { label: `إظهار قسم ${group.title}`, value: mine && mine[group.id] ? mine[group.id].visible !== false : true });
      right.set(key, { label: `إظهار قسم ${group.title}`, value: theirs && theirs[group.id] ? theirs[group.id].visible !== false : true });
    }

    const result = [];
    const keys = new Set([...left.keys(), ...right.keys()]);
    for (const key of keys) {
      const a = left.get(key);
      const b = right.get(key);
      const before = a ? a.value : undefined;
      const after = b ? b.value : undefined;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      result.push({
        label: (a || b).label,
        mine: a ? formatValue(before) : '—',
        theirs: b ? formatValue(after) : '—',
      });
      if (result.length >= 80) break;
    }
    return result;
  }

  return {
    renderContent,
    renderSections,
    diffContent,
    blankItem,
    linkError,
    urlError,
    fieldMatches,
    assetSrc,
    setContentAt: setAt,
    getContentAt: getAt,
    MEDIA_RE,
  };
});
