// صفحة نشاط الزوار. الرسوم بلا مكتبات خارجية، وكل نص قادم من الزوار يُدرج كنص عادي.

import { h, s, api, reportError, confirmDialog, formatDateTime } from './dom.js';

const RANGES = [
  { id: 'today', label: 'اليوم', compare: 'عن أمس' },
  { id: '7d', label: '7 أيام', compare: 'عن الأيام السبعة السابقة' },
  { id: '30d', label: '30 يومًا', compare: 'عن الثلاثين يومًا السابقة' },
  { id: '90d', label: '90 يومًا', compare: 'عن التسعين يومًا السابقة' },
];
const SOURCES = { direct: 'زيارة مباشرة', instagram: 'إنستغرام', facebook: 'فيسبوك', google: 'Google', tiktok: 'تيك توك', whatsapp: 'واتساب', telegram: 'تيليغرام', snapchat: 'سناب شات', youtube: 'يوتيوب', x: 'X', bing: 'Bing', other: 'أخرى' };
const DEVICES = { mobile: 'جوال', desktop: 'كمبيوتر', tablet: 'جهاز لوحي', other: 'أخرى' };
const BROWSERS = { chrome: 'Chrome', safari: 'Safari', edge: 'Edge', firefox: 'Firefox', samsung: 'Samsung', opera: 'Opera', instagram: 'داخل إنستغرام', facebook: 'داخل فيسبوك', tiktok: 'داخل تيك توك', snapchat: 'داخل سناب شات', other: 'أخرى' };
const KINDS = { call: 'اتصال', directions: 'اتجاهات', instagram: 'إنستغرام', whatsapp: 'واتساب', email: 'بريد', external: 'رابط خارجي' };
const SECTIONS = [['moods', 'الأمزجة'], ['vibes', 'الأجواء'], ['students', 'العرض'], ['menu', 'المنيو'], ['visit', 'الزيارة والعنوان']];

const num = new Intl.NumberFormat('en-US');
const dayFormat = new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { day: 'numeric', month: 'short', timeZone: 'UTC' });

const formatDay = (key) => dayFormat.format(new Date(`${key}T00:00:00Z`));
function formatHour(hour) {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${hour < 12 ? 'ص' : 'م'}`;
}
function formatDuration(ms) {
  if (!ms) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} ث`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds} د`;
}

function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const rough = max / 3;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const m = rough / pow;
  const step = Math.max(1, (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow);
  const ticks = [];
  for (let v = 0; ; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

function deltaView(current, previous, compare) {
  if (!previous) return null;
  const change = Math.round(((current - previous) / previous) * 100);
  if (change === 0) return h('p', { class: 'delta' }, `بلا تغيير ${compare}`);
  const up = change > 0;
  return h('p', { class: `delta ${up ? 'delta-up' : 'delta-down'}` },
    h('span', { 'aria-hidden': 'true' }, up ? '▲ ' : '▼ '),
    `${up ? 'زيادة' : 'انخفاض'} ${Math.abs(change)}% ${compare}`);
}

function tile(label, value, delta) {
  return h('article', { class: 'tile-stat' },
    h('p', { class: 'tile-label' }, label),
    h('p', { class: 'tile-value' }, value),
    delta);
}

// أشرطة مرتبة بلون واحد: الاسم، ثم الشريط يمتد من اليمين، ثم القيمة عند طرفه
function rankedBars(rows, { share = true, total } = {}) {
  if (!rows.length) return h('p', { class: 'muted empty-line' }, 'لا توجد بيانات في هذه الفترة.');
  const max = Math.max(...rows.map((r) => r.value), 1);
  const sum = total || rows.reduce((acc, r) => acc + r.value, 0);
  return h('ul', { class: 'bars' }, rows.map((row) => {
    const percent = sum ? Math.round((row.value / sum) * 100) : 0;
    const bar = h('span', { class: 'bar-fill' });
    bar.style.width = `${Math.max((row.value / max) * 100, row.value ? 1.5 : 0)}%`;
    return h('li', { class: 'bar-row' },
      h('span', { class: 'bar-label', dir: 'auto', title: row.label }, row.label),
      h('span', { class: 'bar-track' }, bar),
      h('span', { class: 'bar-value' }, num.format(row.value), share ? h('small', {}, ` ${percent}%`) : null));
  }));
}

function panel(title, body, note, wide) {
  return h('section', { class: `card panel${wide ? ' panel-wide' : ''}` },
    h('h2', { class: 'panel-title' }, title),
    note ? h('p', { class: 'panel-note' }, note) : null,
    body);
}

// جدول مرافق لكل رسم حتى تكون الأرقام متاحة دون مؤشر الفأرة
function dataTable(key, openTables, headers, rows) {
  const details = h('details', { class: 'data-table', open: openTables.has(key) || null },
    h('summary', {}, 'عرض الأرقام'),
    h('div', { class: 'table-scroll' },
      h('table', {},
        h('thead', {}, h('tr', {}, headers.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, cell))))))));
  details.addEventListener('toggle', () => {
    if (details.open) openTables.add(key);
    else openTables.delete(key);
  });
  return details;
}

function tooltip() {
  const el = h('div', { class: 'viz-tip', hidden: true });
  return {
    el,
    show(rows, x, y, width) {
      el.replaceChildren(...rows.map(([value, label]) => h('div', { class: 'tip-row' },
        h('strong', {}, value), h('span', {}, label))));
      el.hidden = false;
      const w = el.offsetWidth;
      el.style.left = `${Math.max(0, Math.min(x - w / 2, width - w))}px`;
      el.style.top = `${y}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}

// خط زمني لسلسلة واحدة. يُرسم من اليمين إلى اليسار ليطابق اتجاه القراءة.
function lineChart(points, ariaLabel) {
  const wrap = h('div', { class: 'viz', tabindex: 0, role: 'img', 'aria-label': ariaLabel });
  const tip = tooltip();
  const svgHolder = h('div', {});
  wrap.append(svgHolder, tip.el);
  let active = null;
  let geometry = null;

  function draw() {
    const W = Math.max(wrap.clientWidth, 260);
    const H = 240;
    const pad = { top: 22, right: 38, bottom: 28, left: 34 };
    const n = points.length;
    const max = Math.max(...points.map((p) => p.value), 1);
    const ticks = niceTicks(max);
    const yMax = ticks[ticks.length - 1];
    const x = (i) => (n === 1 ? (W + pad.right - pad.left) / 2 : W - pad.right - (i * (W - pad.right - pad.left)) / (n - 1));
    const y = (v) => H - pad.bottom - (v / yMax) * (H - pad.top - pad.bottom);
    geometry = { x, y, W };

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg' });
    for (const t of ticks) {
      svg.append(
        s('line', { x1: pad.left, x2: W - pad.right, y1: y(t), y2: y(t), class: t === 0 ? 'axis' : 'grid' }),
        s('text', { x: W - pad.right + 8, y: y(t) + 4, class: 'tick', 'text-anchor': 'start' }, num.format(t)),
      );
    }
    const labelCount = Math.min(n, Math.max(2, Math.floor(W / 110)));
    const seen = new Set();
    for (let k = 0; k < labelCount; k += 1) {
      const i = labelCount === 1 ? 0 : Math.round((k * (n - 1)) / (labelCount - 1));
      if (seen.has(i)) continue;
      seen.add(i);
      svg.append(s('text', { x: x(i), y: H - 8, class: 'tick tick-rtl', 'text-anchor': 'middle' }, points[i].label));
    }
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
    if (n > 1) {
      svg.append(
        s('path', { d: `${line}L${x(n - 1).toFixed(1)} ${y(0)}L${x(0).toFixed(1)} ${y(0)}Z`, class: 'area' }),
        s('path', { d: line, class: 'line' }),
      );
    }
    const last = points[n - 1];
    svg.append(
      s('circle', { cx: x(n - 1), cy: y(last.value), r: 4, class: 'dot' }),
      s('text', { x: x(n - 1), y: y(last.value) - 12, class: 'end-label', 'text-anchor': 'middle' }, num.format(last.value)),
    );
    const cross = s('line', { y1: pad.top, y2: H - pad.bottom, class: 'crosshair', visibility: 'hidden' });
    const marker = s('circle', { r: 4, class: 'dot', visibility: 'hidden' });
    svg.append(cross, marker);
    const hit = s('rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent' });
    svg.append(hit);

    function select(i) {
      active = i;
      if (i === null) {
        cross.setAttribute('visibility', 'hidden');
        marker.setAttribute('visibility', 'hidden');
        tip.hide();
        return;
      }
      const p = points[i];
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('visibility', 'visible');
      marker.setAttribute('cx', x(i));
      marker.setAttribute('cy', y(p.value));
      marker.setAttribute('visibility', 'visible');
      tip.show([[p.label, ''], [num.format(p.value), 'زائر'], [num.format(p.sessions), 'زيارة'], [num.format(p.pageviews), 'مشاهدة صفحة']], x(i), 6, W);
    }
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const px = e.clientX - box.left;
      let best = 0;
      let dist = Infinity;
      for (let i = 0; i < n; i += 1) {
        const d = Math.abs(x(i) - px);
        if (d < dist) {
          dist = d;
          best = i;
        }
      }
      select(best);
    });
    hit.addEventListener('pointerleave', () => select(null));
    wrap.onkeydown = (e) => {
      const current = active === null ? n - 1 : active;
      // المحور معكوس: اليسار هو الأحدث
      if (e.key === 'ArrowLeft') select(Math.min(n - 1, current + 1));
      else if (e.key === 'ArrowRight') select(Math.max(0, current - 1));
      else if (e.key === 'Escape') select(null);
      else return;
      e.preventDefault();
    };
    wrap.onfocus = () => select(n - 1);
    wrap.onblur = () => select(null);
    svgHolder.replaceChildren(svg);
  }
  return { el: wrap, draw };
}

// أعمدة الساعات: ساعة الذروة بالبرتقالي، والبقية رمادية
function hoursChart(hours) {
  const wrap = h('div', { class: 'viz', tabindex: 0, role: 'img', 'aria-label': 'عدد الزيارات حسب ساعة اليوم بتوقيت بغداد' });
  const tip = tooltip();
  const holder = h('div', {});
  wrap.append(holder, tip.el);
  const peak = hours.indexOf(Math.max(...hours));
  let active = null;

  function draw() {
    const W = Math.max(wrap.clientWidth, 260);
    const H = 200;
    const pad = { top: 22, right: 6, bottom: 26, left: 6 };
    const band = (W - pad.left - pad.right) / 24;
    const thick = Math.min(24, Math.max(4, band - 2));
    const max = Math.max(...hours, 1);
    const base = H - pad.bottom;
    const barH = (v) => (v / max) * (base - pad.top);
    const cx = (i) => W - pad.right - band * (i + 0.5);

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'viz-svg' });
    svg.append(s('line', { x1: pad.left, x2: W - pad.right, y1: base, y2: base, class: 'axis' }));
    const step = W < 420 ? 6 : 3;
    const marks = [];
    hours.forEach((value, i) => {
      if (i % step === 0) svg.append(s('text', { x: cx(i), y: H - 8, class: 'tick tick-rtl', 'text-anchor': 'middle' }, formatHour(i)));
      const bh = barH(value);
      const r = Math.min(4, bh, thick / 2);
      const x0 = cx(i) - thick / 2;
      const y0 = base - bh;
      const d = `M${x0} ${base}V${y0 + r}Q${x0} ${y0} ${x0 + r} ${y0}H${x0 + thick - r}Q${x0 + thick} ${y0} ${x0 + thick} ${y0 + r}V${base}Z`;
      const mark = s('path', { d, class: value && i === peak ? 'col col-peak' : 'col' });
      svg.append(mark);
      marks.push(mark);
      if (value && i === peak) svg.append(s('text', { x: cx(i), y: y0 - 7, class: 'end-label', 'text-anchor': 'middle' }, num.format(value)));
    });

    function select(i) {
      if (active !== null && marks[active]) marks[active].classList.remove('is-hover');
      active = i;
      if (i === null) {
        tip.hide();
        return;
      }
      marks[i].classList.add('is-hover');
      tip.show([[num.format(hours[i]), `زيارة · ${formatHour(i)}`]], cx(i), 4, W);
    }
    hours.forEach((_, i) => {
      const area = s('rect', { x: cx(i) - band / 2, y: 0, width: band, height: H, fill: 'transparent' });
      area.addEventListener('pointerenter', () => select(i));
      svg.append(area);
    });
    svg.addEventListener('pointerleave', () => select(null));
    wrap.onkeydown = (e) => {
      const current = active === null ? (peak >= 0 ? peak : 0) : active;
      if (e.key === 'ArrowLeft') select(Math.min(23, current + 1));
      else if (e.key === 'ArrowRight') select(Math.max(0, current - 1));
      else if (e.key === 'Escape') select(null);
      else return;
      e.preventDefault();
    };
    wrap.onfocus = () => select(peak >= 0 ? peak : 0);
    wrap.onblur = () => select(null);
    holder.replaceChildren(svg);
  }
  return { el: wrap, draw };
}

function recentTable(rows) {
  if (!rows.length) return h('p', { class: 'muted empty-line' }, 'لا توجد زيارات في هذه الفترة.');
  const body = rows.map((row) => {
    const parts = [];
    if (row.sections) parts.push(h('span', { class: 'chip' }, `شاف ${row.sections} ${row.sections === 1 ? 'قسم' : 'أقسام'}`));
    for (const mood of row.moods) parts.push(h('span', { class: 'chip', dir: 'auto' }, `مزاج: ${mood}`));
    for (const action of row.actions) {
      parts.push(h('span', { class: 'chip chip-action', dir: 'auto' }, `${KINDS[action.kind] || action.kind}: ${action.label}`));
    }
    return h('tr', {},
      h('td', { class: 'nowrap', 'data-label': 'الوقت' }, formatDateTime(row.at)),
      h('td', { 'data-label': 'المصدر', dir: 'auto' }, SOURCES[row.source] || row.source),
      h('td', { 'data-label': 'الجهاز' }, `${DEVICES[row.device] || row.device} · ${BROWSERS[row.browser] || row.browser}`),
      h('td', { class: 'nowrap', 'data-label': 'مدة البقاء' }, formatDuration(row.durationMs)),
      h('td', { 'data-label': 'النشاط' }, parts.length ? h('div', { class: 'chips' }, parts) : h('span', { class: 'muted' }, 'تصفّح فقط')));
  });
  return h('div', { class: 'table-scroll' },
    h('table', { class: 'recent' },
      h('thead', {}, h('tr', {}, ['الوقت', 'المصدر', 'الجهاز', 'مدة البقاء', 'النشاط'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', {}, body)));
}

export function renderStats(container, { access }) {
  let range = '7d';
  try {
    range = sessionStorage.getItem('ccafe-range') || '7d';
  } catch { /* تبقى القيمة الافتراضية */ }
  let lastJson = '';
  let timer = null;
  const charts = [];
  const openTables = new Set();
  const observer = new ResizeObserver(() => charts.forEach((c) => c.draw()));

  const live = h('p', { class: 'live', role: 'status' });
  const filters = h('div', { class: 'seg', role: 'group', 'aria-label': 'الفترة' });
  const content = h('div', { class: 'stats-body' });
  const notice = access.local
    ? h('p', { class: 'notice' }, 'الموقع يعمل الآن على جهازك فقط، لذلك تُسجَّل هنا زياراتك من هذا الجهاز. ستظهر زيارات زبائنك بعد نشر الموقع على خادم متصل بالإنترنت.')
    : null;

  container.replaceChildren(h('div', { class: 'stats' },
    h('div', { class: 'stats-filter' }, filters, live),
    notice,
    content));

  function renderFilters() {
    filters.replaceChildren(...RANGES.map((r) => h('button', {
      type: 'button',
      class: r.id === range ? 'is-on' : null,
      'aria-pressed': r.id === range ? 'true' : 'false',
      onClick() {
        range = r.id;
        try {
          sessionStorage.setItem('ccafe-range', range);
        } catch { /* لا يؤثر */ }
        renderFilters();
        load();
      },
    }, r.label)));
  }

  function renderLive(count) {
    live.replaceChildren(
      h('span', { class: `live-dot${count ? ' is-on' : ''}`, 'aria-hidden': 'true' }),
      count ? `${num.format(count)} ${count === 1 ? 'زائر' : 'زوار'} على الموقع الآن` : 'لا يوجد زوار على الموقع الآن',
    );
  }

  function view(data) {
    observer.disconnect();
    charts.length = 0;
    const { totals: t, previous: p } = data;
    const compare = RANGES.find((r) => r.id === data.range).compare;

    if (!t.sessions) {
      content.replaceChildren(h('section', { class: 'card empty-state' },
        h('h2', {}, 'لا توجد زيارات في هذه الفترة'),
        h('p', {}, 'عندما يفتح أحد موقعك ستظهر هنا زياراته ومصدرها وما ضغط عليه.'),
        h('a', { class: 'btn btn-primary', href: '/', target: '_blank', rel: 'noopener' }, 'افتح الموقع لتجربة التتبع')));
      return;
    }

    const points = data.series.map((row) => ({
      label: data.hourly ? formatHour(Number(row.key)) : formatDay(row.key),
      value: row.visitors,
      sessions: row.sessions,
      pageviews: row.pageviews,
    }));
    const trend = lineChart(points, `عدد الزوار خلال الفترة: ${num.format(t.visitors)}`);
    const hours = hoursChart(data.hours);
    charts.push(trend, hours);

    const hero = h('section', { class: 'card panel hero-panel' },
      h('div', { class: 'hero-figure' },
        h('p', { class: 'tile-label' }, 'الزوار'),
        h('p', { class: 'hero-value' }, num.format(t.visitors)),
        deltaView(t.visitors, p.visitors, compare)),
      trend.el,
      dataTable('trend', openTables, [data.hourly ? 'الساعة' : 'اليوم', 'الزوار', 'الزيارات', 'مشاهدات الصفحة'],
        points.slice().reverse().map((row) => [row.label, num.format(row.value), num.format(row.sessions), num.format(row.pageviews)])));

    const tiles = h('div', { class: 'tiles' },
      tile('الزيارات', num.format(t.sessions), deltaView(t.sessions, p.sessions, compare)),
      tile('متوسط مدة البقاء', formatDuration(t.avgDurationMs), deltaView(t.avgDurationMs, p.avgDurationMs, compare)),
      tile('ضغطات الاتصال', num.format(t.calls), deltaView(t.calls, p.calls, compare)),
      tile('ضغطات الاتجاهات', num.format(t.directions), deltaView(t.directions, p.directions, compare)),
      tile('ضغطات إنستغرام', num.format(t.instagram), deltaView(t.instagram, p.instagram, compare)),
      tile('زيارات فيها تفاعل', `${t.sessions ? Math.round((t.actionSessions / t.sessions) * 100) : 0}%`, h('p', { class: 'delta' }, `${num.format(t.actionSessions)} من ${num.format(t.sessions)} زيارة`)));

    const label = (map) => (row) => ({ label: map[row.key] || row.key, value: row.value });
    const clickRows = data.clicks.map((row) => ({ label: `${row.label || '—'} · ${KINDS[row.kind] || row.kind}`, value: row.value }));
    const reach = SECTIONS.map(([id, name]) => ({ label: name, value: data.sections[id] || 0 }));
    const peakValue = Math.max(...data.hours);
    const peakHour = data.hours.indexOf(peakValue);

    content.replaceChildren(
      hero,
      tiles,
      h('div', { class: 'panels' },
        panel('مصادر الزيارات', rankedBars(data.sources.map(label(SOURCES)))),
        panel('الأزرار الأكثر ضغطًا', rankedBars(clickRows, { share: false })),
        panel('الأجهزة', rankedBars(data.devices.map(label(DEVICES)))),
        panel('المتصفحات', rankedBars(data.browsers.map(label(BROWSERS)))),
        panel('الأمزجة المختارة', rankedBars(data.moods.map((row) => ({ label: row.key, value: row.value })))),
        panel('وصول الزوار إلى أقسام الصفحة', rankedBars(reach, { total: t.sessions }), 'نسبة الزيارات التي وصلت إلى كل قسم.'),
        panel('أوقات الذروة',
          h('div', {},
            hours.el,
            dataTable('hours', openTables, ['الساعة', 'الزيارات'], data.hours.map((v, i) => [formatHour(i), num.format(v)]))),
          peakValue ? `أكثر ساعة نشاطًا: ${formatHour(peakHour)} بتوقيت بغداد.` : null,
          true)),
      panel('آخر الزيارات', recentTable(data.recent)),
    );
    charts.forEach((c) => {
      observer.observe(c.el);
      c.draw();
    });
  }

  async function load() {
    const wanted = range;
    content.classList.add('is-loading');
    try {
      const data = await api('GET', `api/stats?range=${wanted}`);
      if (wanted !== range) return;
      renderLive(data.live);
      const { generatedAt, live: _live, ...comparable } = data;
      const json = JSON.stringify(comparable);
      if (json !== lastJson) {
        lastJson = json;
        view(data);
      }
    } catch (err) {
      reportError(err);
    } finally {
      content.classList.remove('is-loading');
    }
  }

  renderFilters();
  load();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, 20000);

  return () => {
    clearInterval(timer);
    observer.disconnect();
  };
}

export async function clearStats() {
  const ok = await confirmDialog({
    title: 'مسح بيانات الزيارات',
    text: 'سيُحذف كل سجل الزيارات نهائيًا ولا يمكن استعادته. محتوى الموقع لن يتأثر.',
    confirmLabel: 'مسح نهائيًا',
    danger: true,
  });
  if (!ok) return false;
  await api('DELETE', 'api/stats');
  return true;
}
