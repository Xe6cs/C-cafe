'use strict';
// يحوّل محتوى الموقع إلى صفحة HTML. كل قيمة تمر عبر esc أو safeUrl أو safeAsset قبل إخراجها.

const fs = require('node:fs');
const path = require('node:path');
const { ICONS } = require('./icons');
const { SECTION_ANCHORS } = require('./schema');

const SPRITE = fs.readFileSync(path.join(__dirname, 'brand-sprite.html'), 'utf8').trim();

const DEFAULT_LOGO = 'assets/brand/logo.svg';
const DEFAULT_MARK = 'assets/brand/mark.svg';
const DEFAULT_FAVICON = 'assets/brand/favicon.svg';

const FULL_LOGO_USES = '<use href="#p-arc"/><use href="#p-cup"/><use href="#p-steam1"/><use href="#p-steam2"/><use href="#p-word"/>';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeAsset(value) {
  const v = String(value || '');
  return /^assets\/[A-Za-z0-9_\-./]+$/.test(v) && !v.includes('..') ? v : '';
}

function safeUrl(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^#[\w-]+$/.test(v)) return v;
  if (/^(https?:\/\/|tel:|mailto:|sms:)/i.test(v)) return v;
  if (/^\/(?!\/)/.test(v)) return v;
  return '';
}

function iconHtml(value, cls = 'icon') {
  if (!value) return '';
  const lib = Object.prototype.hasOwnProperty.call(ICONS, value) ? ICONS[value] : null;
  if (lib) return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${lib.body}</svg>`;
  const asset = safeAsset(value);
  return asset ? `<img class="${cls} icon-img" src="${esc(asset)}" alt="">` : '';
}

function createContext(c) {
  const hidden = new Set(
    Object.entries(SECTION_ANCHORS).filter(([id]) => c[id] && c[id].visible === false).map(([, anchor]) => anchor),
  );
  return {
    // يعيد خصائص الرابط، أو null إذا لم تكن له وجهة صالحة أو كان يشير إلى قسم مخفي
    link(href) {
      let target = String(href || '').trim();
      if (target === '@phone') target = c.contact.phoneIntl ? `tel:${c.contact.phoneIntl.replace(/[^+\d]/g, '')}` : '';
      else if (target === '@maps') target = c.contact.mapsUrl;
      else if (target === '@instagram') target = c.contact.instagramUrl;
      const url = safeUrl(target);
      if (!url) return null;
      if (url.startsWith('#') && hidden.has(url.slice(1))) return null;
      const external = /^https?:\/\//i.test(url);
      return `href="${esc(url)}"${external ? ' target="_blank" rel="noopener"' : ''}`;
    },
  };
}

function button(btn, cls, ctx) {
  if (!btn || !btn.label) return '';
  const attrs = ctx.link(btn.href);
  if (!attrs) return '';
  const icon = iconHtml(btn.icon);
  const inner = btn.icon === 'arrow' ? `${esc(btn.label)} ${icon}` : `${icon} ${esc(btn.label)}`;
  return `<a class="btn ${cls}" ${attrs}>${inner.trim()}</a>`;
}

function actions(...buttons) {
  const html = buttons.filter(Boolean).join('\n          ');
  return html ? `<div class="actions">\n          ${html}\n        </div>` : '';
}

function kicker(text, extra = '') {
  if (!text) return '';
  const latin = /^[\u0000-ɏ\s]+$/.test(text);
  return `<p class="kicker${extra}"${latin ? ' lang="en"' : ''}>${esc(text)}</p>`;
}

function logoHtml(c, cls) {
  const logo = safeAsset(c.brand.logo) || DEFAULT_LOGO;
  if (logo === DEFAULT_LOGO) {
    return `<svg class="${cls}" viewBox="218 213 3255 1381" aria-hidden="true">${FULL_LOGO_USES}</svg>`;
  }
  return `<img class="${cls} logo-img" src="${esc(logo)}" alt="">`;
}

function heroMark(c) {
  const mark = safeAsset(c.hero.mark);
  if (!mark) return '';
  if (mark === DEFAULT_MARK) {
    return `<svg class="hero-mark" viewBox="218 213 1394 1381" aria-hidden="true">
      <use href="#p-arc"/>
      <use href="#p-cup"/>
      <use class="steam" href="#p-steam1"/>
      <use class="steam steam-b" href="#p-steam2"/>
    </svg>`;
  }
  return `<img class="hero-mark hero-mark-img" src="${esc(mark)}" alt="">`;
}

function renderHero(c, ctx) {
  const h = c.hero;
  const facts = h.facts
    .filter((f) => f.strong || f.text)
    .map((f) => `<li><strong>${esc(f.strong)}</strong> ${esc(f.text)}</li>`)
    .join('\n      ');
  return `<section class="hero" id="top">
    ${heroMark(c)}

    <div class="hero-body wrap">
      ${h.where ? `<p class="hero-where">${esc(h.where)}</p>` : ''}
      <h1>
        <span>${esc(h.line1)}</span>
        <span class="big">${esc(h.big)}</span>
        <span>${esc(h.line3)}</span>
      </h1>
      ${h.lead ? `<p class="hero-lead">${esc(h.lead)}</p>` : ''}
      ${actions(button(h.primary, 'btn-ink', ctx), button(h.secondary, 'btn-line', ctx))}
    </div>

    ${facts ? `<ul class="hero-facts wrap">\n      ${facts}\n    </ul>` : ''}
  </section>`;
}

function renderMoods(c) {
  const m = c.moods;
  const items = m.items.filter((item) => item.tab);
  if (!items.length) return '';
  const tabs = items
    .map((item, i) => `<button class="mood-tab" role="tab" id="tab-${i}" aria-controls="panel-${i}" aria-selected="${i === 0}"${i === 0 ? '' : ' tabindex="-1"'}>${esc(item.tab)}</button>`)
    .join('\n          ');
  const panels = items.map((item, i) => {
    const src = safeAsset(item.image);
    return `<article class="mood-panel${i === 0 ? ' is-active' : ''}" role="tabpanel" id="panel-${i}" aria-labelledby="tab-${i}" tabindex="0">
            <div class="mood-copy">
              ${item.title ? `<h3>${esc(item.title)}</h3>` : ''}
              ${item.text ? `<p>${esc(item.text)}</p>` : ''}
              ${item.note ? `<p class="mood-note">${esc(item.note)}</p>` : ''}
            </div>
            ${src ? `<img src="${esc(src)}"${i === 0 ? '' : ' loading="lazy"'} decoding="async" alt="${esc(item.alt)}">` : ''}
          </article>`;
  }).join('\n\n          ');
  return `<section class="section moods-section" id="moods">
    <div class="wrap">
      <header class="section-head reveal">
        ${kicker(m.kicker)}
        <h2>${esc(m.title)}</h2>
      </header>

      <div class="moods reveal" data-moods>
        <div class="mood-tabs" role="tablist" aria-label="اختار مزاجك" aria-orientation="vertical">
          ${tabs}
        </div>

        <div class="mood-stage">
          ${panels}
        </div>
      </div>
    </div>
  </section>`;
}

function renderVibes(c, ctx) {
  const v = c.vibes;
  const tiles = v.tiles
    .filter((t) => safeAsset(t.image))
    .map((t) => `<figure class="tile${t.tall ? ' tile-tall' : ''} reveal">
          <img src="${esc(safeAsset(t.image))}" loading="lazy" decoding="async" alt="${esc(t.alt)}">
          ${t.caption ? `<figcaption>${esc(t.caption)}</figcaption>` : ''}
        </figure>`)
    .join('\n        ');
  const attrs = v.insta.visible ? ctx.link(v.insta.href) : null;
  const handle = v.insta.handle || c.contact.instagramHandle;
  const insta = attrs
    ? `<a class="tile tile-insta reveal" ${attrs}>
          ${iconHtml(v.insta.icon, 'icon icon-xl')}
          ${v.insta.text ? `<span class="insta-text">${esc(v.insta.text)}</span>` : ''}
          <span class="insta-handle" dir="ltr">${esc(handle)}</span>
        </a>`
    : '';
  return `<section class="section vibes" id="vibes">
    <div class="wrap">
      <header class="section-head reveal">
        ${kicker(v.kicker)}
        <h2>${esc(v.title)}</h2>
        ${v.lead ? `<p class="section-lead">${esc(v.lead)}</p>` : ''}
      </header>

      <div class="gallery">
        ${tiles}
        ${insta}
      </div>
    </div>
  </section>`;
}

function renderOffer(c, ctx) {
  const o = c.offer;
  return `<section class="offer" id="students" aria-labelledby="offer-title">
    <div class="wrap offer-grid">
      <p class="offer-number reveal" dir="ltr" aria-hidden="true">${o.symbol ? `<span class="pct">${esc(o.symbol)}</span>` : ''}${esc(o.number)}</p>
      <div class="offer-copy reveal">
        ${kicker(o.kicker, ' kicker-ink')}
        <h2 id="offer-title"><span>${esc(o.title1)}</span> <span>${esc(o.title2)}</span></h2>
        ${o.text ? `<p>${esc(o.text)}</p>` : ''}
        ${button(o.cta, 'btn-ink', ctx)}
      </div>
    </div>
  </section>`;
}

function renderMenu(c, ctx) {
  const m = c.menu;
  const categories = m.categories
    .filter((cat) => cat.name)
    .map((cat) => {
      const items = cat.items
        .filter((item) => item.name)
        .map((item) => `<li><span class="menu-item-name">${esc(item.name)}</span>${item.note ? `<span class="menu-item-note">${esc(item.note)}</span>` : ''}${item.price ? `<span class="menu-price" dir="auto">${esc(item.price)}</span>` : ''}</li>`)
        .join('\n            ');
      return `<li>
          <div class="menu-row"><span class="menu-name">${esc(cat.name)}</span>${cat.note ? `<span class="menu-note">${esc(cat.note)}</span>` : ''}</div>
          ${items ? `<ul class="menu-items">\n            ${items}\n          </ul>` : ''}
        </li>`;
    })
    .join('\n        ');
  return `<section class="section menu" id="menu">
    <div class="wrap menu-grid">
      <header class="section-head reveal">
        ${kicker(m.kicker)}
        <h2>${esc(m.title)}</h2>
        ${m.lead ? `<p class="section-lead">${esc(m.lead)}</p>` : ''}
        ${actions(button(m.primary, 'btn-orange', ctx), button(m.secondary, 'btn-line', ctx))}
      </header>

      ${categories ? `<ul class="menu-list reveal">\n        ${categories}\n      </ul>` : ''}
    </div>
  </section>`;
}

function renderVisit(c, ctx) {
  const v = c.visit;
  const facts = v.facts
    .map((f) => {
      let value = f.value;
      if (!value && f.href === '@phone') value = c.contact.phoneDisplay;
      if (!value && f.href === '@instagram') value = c.contact.instagramHandle;
      if (!value && f.href === '@maps') value = c.contact.address;
      if (!f.label && !value) return '';
      const attrs = ctx.link(f.href);
      const body = attrs ? `<a ${attrs} dir="auto">${esc(value)}</a>` : esc(value);
      return `<div>
            <dt>${esc(f.label)}</dt>
            <dd>${body}</dd>
          </div>`;
    })
    .filter(Boolean)
    .join('\n          ');
  const lat = parseFloat(c.contact.lat);
  const lng = parseFloat(c.contact.lng);
  const hasMap = v.mapVisible && Number.isFinite(lat) && Number.isFinite(lng);
  const map = hasMap
    ? `<div class="map reveal">
        <iframe title="${esc(`موقع ${c.contact.name} على خرائط Google`)}" src="https://www.google.com/maps?q=${lat},${lng}&amp;hl=ar&amp;z=16&amp;output=embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
      </div>`
    : '';
  return `<section class="section visit" id="visit">
    <div class="wrap visit-grid${hasMap ? '' : ' visit-grid-solo'}">
      <div class="visit-info reveal">
        ${kicker(v.kicker)}
        <h2>${esc(v.title)}</h2>
        ${facts ? `<dl class="facts">\n          ${facts}\n        </dl>` : ''}
        ${actions(button(v.primary, 'btn-orange', ctx), button(v.secondary, 'btn-line', ctx))}
      </div>
      ${map}
    </div>
  </section>`;
}

const SECTION_RENDERERS = {
  moods: renderMoods,
  vibes: renderVibes,
  offer: renderOffer,
  menu: renderMenu,
  visit: renderVisit,
};

function renderHeadLinks(c) {
  const favicon = safeAsset(c.seo.favicon);
  const lines = [];
  if (favicon) {
    const type = favicon.endsWith('.svg') ? ' type="image/svg+xml"' : '';
    lines.push(`<link rel="icon" href="${esc(favicon)}"${type}>`);
    if (favicon === DEFAULT_FAVICON) lines.push('<link rel="icon" href="assets/brand/favicon-32.png" sizes="32x32" type="image/png">');
  }
  const touch = safeAsset(c.seo.touchIcon);
  if (touch) lines.push(`<link rel="apple-touch-icon" href="${esc(touch)}">`);
  return lines.join('\n  ');
}

function renderJsonLd(c, absolute) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'CafeOrCoffeeShop',
    name: c.contact.name,
    image: absolute(safeAsset(c.seo.ogImage)),
    telephone: c.contact.phoneIntl,
    address: {
      '@type': 'PostalAddress',
      streetAddress: c.contact.street,
      addressLocality: c.contact.city,
      addressCountry: 'IQ',
    },
    hasMap: c.contact.mapsUrl,
    sameAs: c.contact.instagramUrl ? [c.contact.instagramUrl] : [],
  };
  const lat = parseFloat(c.contact.lat);
  const lng = parseFloat(c.contact.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) data.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
  if (c.seo.siteUrl) data.url = c.seo.siteUrl;
  return JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
}

function renderPage(c, opts = {}) {
  const preview = Boolean(opts.preview);
  const ctx = createContext(c);
  const site = /^https?:\/\//i.test(c.seo.siteUrl) ? c.seo.siteUrl.replace(/\/+$/, '') : '';
  const absolute = (asset) => (site && asset ? `${site}/${asset}` : asset);
  const og = safeAsset(c.seo.ogImage);

  const nav = c.header.nav
    .map((item) => {
      const attrs = item.label ? ctx.link(item.href) : null;
      return attrs ? `<a ${attrs}>${esc(item.label)}</a>` : '';
    })
    .filter(Boolean)
    .join('\n    ');

  const callAttrs = c.header.showCall ? ctx.link('@phone') : null;
  const call = callAttrs
    ? `<a class="head-call" ${callAttrs}>
    ${iconHtml(c.header.callIcon)}
    <span dir="ltr">${esc(c.contact.phoneDisplay)}</span>
  </a>`
    : '';

  const sections = c.layout.order
    .filter((id) => c[id] && c[id].visible !== false)
    .map((id) => SECTION_RENDERERS[id](c, ctx))
    .filter(Boolean)
    .join('\n\n  ');

  const quickItems = c.quickbar.visible
    ? c.quickbar.items
      .map((item) => {
        const attrs = item.label ? ctx.link(item.href) : null;
        return attrs ? `<a ${attrs}>${iconHtml(item.icon)}${esc(item.label)}</a>` : '';
      })
      .filter(Boolean)
    : [];
  const quickbar = quickItems.length
    ? `<nav class="quickbar" style="--n:${quickItems.length}" aria-label="إجراءات سريعة">
  ${quickItems.join('\n  ')}
</nav>`
    : '';

  const logoLabel = c.brand.logoLabel || c.contact.name;
  const tracking = c.settings.tracking && !preview ? '<script src="track.js" defer></script>' : '';

  return `<!doctype html>
<!-- هذا الملف يُولَّد تلقائيًا من لوحة التحكم. عدّل المحتوى من /admin/ وليس من هنا. -->
<html lang="ar" dir="rtl"${preview ? ' class="is-preview"' : ''}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${esc(c.seo.title)}</title>
  <meta name="description" content="${esc(c.seo.description)}">
  <meta name="theme-color" content="#FA6A04">${preview ? '\n  <meta name="robots" content="noindex">' : ''}
  ${site ? `<link rel="canonical" href="${esc(site)}/">` : ''}

  ${renderHeadLinks(c)}

  <meta property="og:type" content="website">
  <meta property="og:locale" content="ar_IQ">
  <meta property="og:title" content="${esc(c.contact.name)}">
  <meta property="og:description" content="${esc(c.footer.tagline)}. ${esc(c.contact.address)}.">
  ${og ? `<meta property="og:image" content="${esc(absolute(og))}">` : ''}
  ${site ? `<meta property="og:url" content="${esc(site)}/">` : ''}
  <meta name="twitter:card" content="summary_large_image">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@300..900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css">
  <script>document.documentElement.classList.add('js');${preview ? 'window.CCAFE_PREVIEW=true;' : ''}</script>

  <script type="application/ld+json">
${renderJsonLd(c, absolute)}
  </script>
</head>
<body>
${SPRITE}

<a class="skip" href="#main">تخطّي إلى المحتوى</a>

<header class="site-head" data-head>
  <a class="logo" href="#top" aria-label="${esc(`${logoLabel}، إلى أعلى الصفحة`)}">
    ${logoHtml(c, 'logo-mark')}
  </a>
  <nav class="site-nav" aria-label="أقسام الموقع">
    ${nav}
  </nav>
  ${call}
</header>

<main id="main">
  ${renderHero(c, ctx)}

  ${sections}
</main>

<footer class="site-foot">
  <div class="wrap foot-grid">
    <div class="foot-logo-wrap" role="img" aria-label="${esc(logoLabel)}">${logoHtml(c, 'foot-logo')}</div>
    ${c.footer.tagline ? `<p class="foot-line">${esc(c.footer.tagline)}</p>` : ''}
    ${c.footer.small ? `<p class="foot-small">${esc(c.footer.small)}</p>` : ''}
  </div>
</footer>

${quickbar}

<script src="script.js"></script>
${tracking}
</body>
</html>
`;
}

module.exports = { renderPage, esc, safeUrl, safeAsset };
