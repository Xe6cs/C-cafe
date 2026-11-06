'use strict';
// تتبع الزوار: بلا كوكيز ولا تخزين لعناوين IP.
// يُميَّز الزائر داخل اليوم ببصمة أحادية الاتجاه تتغير كل يوم، فلا يمكن ربط أيامه ببعضها.
// كل يوم في ملف JSONL مستقل داخل data/events.

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // توقيت بغداد
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
const EVENT_TYPES = new Set(['pageview', 'section', 'mood', 'click', 'leave']);
const CLICK_KINDS = new Set(['call', 'directions', 'instagram', 'whatsapp', 'email', 'external', 'internal']);
const ACTION_KINDS = new Set(['call', 'directions', 'instagram', 'whatsapp', 'email', 'external']);
const MAX_EVENTS_PER_MINUTE = 120;
const MAX_EVENTS_PER_DAY = 200000;
const MAX_SESSION_MS = 2 * 60 * 60 * 1000;

const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|lighthouse|headless|pingdom|curl|wget|python-requests|node-fetch|axios|go-http|\bnode\b/i;

const SOURCE_PATTERNS = [
  ['instagram', /instagram|^ig$/],
  ['facebook', /facebook|^fb|\.fb\./],
  ['google', /google/],
  ['tiktok', /tiktok/],
  ['whatsapp', /whatsapp|wa\.me/],
  ['telegram', /telegram|^t\.me/],
  ['snapchat', /snapchat/],
  ['youtube', /youtube|youtu\.be/],
  ['x', /twitter|^t\.co|^x\.com/],
  ['bing', /bing/],
];

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, max);
}

function classifySource(ref, utm) {
  const r = String(ref || '').toLowerCase();
  const u = String(utm || '').toLowerCase();
  const probe = u || r;
  if (!probe) return 'direct';
  for (const [name, re] of SOURCE_PATTERNS) if (re.test(probe)) return name;
  return r || u;
}

function parseAgent(ua) {
  const device = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) ? 'tablet' : (/Mobi|iPhone|Android/i.test(ua) ? 'mobile' : 'desktop');
  let browser = 'other';
  if (/Instagram/i.test(ua)) browser = 'instagram';
  else if (/FBAN|FBAV|FB_IAB/i.test(ua)) browser = 'facebook';
  else if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) browser = 'tiktok';
  else if (/Snapchat/i.test(ua)) browser = 'snapchat';
  else if (/Edg\//i.test(ua)) browser = 'edge';
  else if (/SamsungBrowser/i.test(ua)) browser = 'samsung';
  else if (/OPR\//i.test(ua)) browser = 'opera';
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'firefox';
  else if (/Chrome|CriOS/i.test(ua)) browser = 'chrome';
  else if (/Safari/i.test(ua)) browser = 'safari';
  let os = 'other';
  if (/Android/i.test(ua)) os = 'android';
  else if (/iPhone|iPad|iPod/i.test(ua)) os = 'ios';
  else if (/Windows/i.test(ua)) os = 'windows';
  else if (/Mac OS/i.test(ua)) os = 'macos';
  else if (/Linux/i.test(ua)) os = 'linux';
  return { device, browser, os };
}

function dayKey(t) {
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function hourOf(t) {
  return new Date(t + TZ_OFFSET_MS).getUTCHours();
}

function rankedCounts(map, limit) {
  const rows = [...map.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
  if (!limit || rows.length <= limit) return rows;
  const head = rows.slice(0, limit);
  const rest = rows.slice(limit).reduce((sum, r) => sum + r.value, 0);
  head.push({ key: 'other', value: rest });
  return head;
}

function inc(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

class Analytics {
  constructor({ dir, secret }) {
    this.dir = dir;
    this.secret = secret;
    this.minuteCounts = new Map();
    this.dayCounts = new Map();
    this.cache = new Map();
    this.writeQueue = Promise.resolve();
    const timer = setInterval(() => this.minuteCounts.clear(), 60 * 1000);
    timer.unref();
  }

  visitorHash(ip, ua, day) {
    return crypto.createHash('sha256').update(`${this.secret}|${day}|${ip}|${ua}`).digest('hex').slice(0, 16);
  }

  // يتحقق من الحدث القادم من الزائر ويحفظه. المدخلات غير موثوقة دائمًا.
  async record(raw, { ip, ua }, now = Date.now()) {
    if (!raw || typeof raw !== 'object') return false;
    const agent = String(ua || '');
    if (!agent || BOT_RE.test(agent)) return false;
    if (!EVENT_TYPES.has(raw.e)) return false;
    const session = String(raw.s || '');
    if (!/^[a-z0-9]{8,32}$/.test(session)) return false;

    const day = dayKey(now);
    const visitor = this.visitorHash(ip, agent, day);
    const perMinute = (this.minuteCounts.get(visitor) || 0) + 1;
    this.minuteCounts.set(visitor, perMinute);
    if (perMinute > MAX_EVENTS_PER_MINUTE) return false;
    if (!(await this.withinDailyLimit(day))) return false;

    const event = { t: now, v: visitor, s: session, e: raw.e };
    switch (raw.e) {
      case 'pageview': {
        const ref = clean(raw.r, 100).toLowerCase();
        if (/^[a-z0-9.-]+$/.test(ref)) event.r = ref;
        const utm = clean(raw.u, 40).toLowerCase();
        if (/^[a-z0-9._-]+$/.test(utm)) event.u = utm;
        Object.assign(event, parseAgent(agent));
        break;
      }
      case 'section': {
        const name = clean(raw.n, 32);
        if (!/^[a-z0-9_-]+$/.test(name)) return false;
        event.n = name;
        break;
      }
      case 'mood':
        event.n = clean(raw.n, 60);
        if (!event.n) return false;
        break;
      case 'click':
        event.n = clean(raw.n, 80);
        event.k = CLICK_KINDS.has(raw.k) ? raw.k : 'external';
        break;
      case 'leave': {
        const ms = Number(raw.ms);
        const scroll = Number(raw.sc);
        event.ms = Number.isFinite(ms) ? Math.max(0, Math.min(ms, MAX_SESSION_MS)) : 0;
        event.sc = Number.isFinite(scroll) ? Math.max(0, Math.min(Math.round(scroll), 100)) : 0;
        break;
      }
      default:
        return false;
    }

    this.dayCounts.set(day, this.dayCounts.get(day) + 1);
    await this.append(day, event);
    return true;
  }

  async withinDailyLimit(day) {
    if (!this.dayCounts.has(day)) {
      this.dayCounts.clear();
      const existing = await this.readDay(day);
      this.dayCounts.set(day, existing.length);
    }
    return this.dayCounts.get(day) < MAX_EVENTS_PER_DAY;
  }

  append(day, event) {
    this.cache.delete(day);
    this.writeQueue = this.writeQueue
      .then(async () => {
        await fsp.mkdir(this.dir, { recursive: true });
        await fsp.appendFile(path.join(this.dir, `${day}.jsonl`), `${JSON.stringify(event)}\n`);
      })
      .catch((err) => console.error('تعذّر حفظ حدث زيارة:', err.message));
    return this.writeQueue;
  }

  async readDay(day) {
    const file = path.join(this.dir, `${day}.jsonl`);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return [];
    }
    const cached = this.cache.get(day);
    if (cached && cached.size === stat.size) return cached.events;
    const raw = await fsp.readFile(file, 'utf8');
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line));
      } catch { /* سطر تالف: يُتجاهل */ }
    }
    this.cache.set(day, { size: stat.size, events });
    return events;
  }

  async readDays(keys) {
    const parts = await Promise.all(keys.map((k) => this.readDay(k)));
    return parts.flat();
  }

  aggregate(events) {
    const sessions = new Map();
    const visitors = new Set();
    const moods = new Map();
    const clicks = new Map();
    const clickKinds = new Map();
    let pageviews = 0;

    for (const e of events) {
      let s = sessions.get(e.s);
      if (!s) {
        s = { id: e.s, first: e.t, last: e.t, seen: false, sections: new Set(), moods: [], actions: [], dur: 0, scroll: 0 };
        sessions.set(e.s, s);
      }
      s.first = Math.min(s.first, e.t);
      s.last = Math.max(s.last, e.t);
      if (e.e === 'pageview') {
        pageviews += 1;
        visitors.add(`${dayKey(e.t)}|${e.v}`);
        if (!s.seen) {
          s.seen = true;
          s.source = classifySource(e.r, e.u);
          s.device = e.device;
          s.browser = e.browser;
          s.os = e.os;
        }
      } else if (e.e === 'section') {
        s.sections.add(e.n);
      } else if (e.e === 'mood') {
        inc(moods, e.n);
        s.moods.push(e.n);
      } else if (e.e === 'click') {
        inc(clickKinds, e.k);
        if (e.k !== 'internal') {
          inc(clicks, `${e.k}\u0000${e.n}`);
          s.actions.push({ kind: e.k, label: e.n });
        }
      } else if (e.e === 'leave') {
        s.dur = Math.max(s.dur, e.ms || 0);
        s.scroll = Math.max(s.scroll, e.sc || 0);
      }
    }

    const real = [...sessions.values()].filter((s) => s.seen);
    const timed = real.filter((s) => s.dur > 0);
    const acted = real.filter((s) => s.actions.some((a) => ACTION_KINDS.has(a.kind)));
    return {
      real,
      moods,
      clicks,
      totals: {
        visitors: visitors.size,
        sessions: real.length,
        pageviews,
        avgDurationMs: timed.length ? Math.round(timed.reduce((sum, s) => sum + s.dur, 0) / timed.length) : 0,
        calls: clickKinds.get('call') || 0,
        directions: clickKinds.get('directions') || 0,
        instagram: clickKinds.get('instagram') || 0,
        actionSessions: acted.length,
      },
    };
  }

  series(events, keys, hourly, now) {
    const buckets = new Map();
    const labels = hourly
      ? Array.from({ length: hourOf(now) + 1 }, (_, h) => String(h))
      : keys;
    for (const key of labels) buckets.set(key, { key, visitors: new Set(), sessions: new Set(), pageviews: 0 });
    for (const e of events) {
      if (e.e !== 'pageview') continue;
      const bucket = buckets.get(hourly ? String(hourOf(e.t)) : dayKey(e.t));
      if (!bucket) continue;
      bucket.pageviews += 1;
      bucket.visitors.add(e.v);
      bucket.sessions.add(e.s);
    }
    return labels.map((key) => {
      const b = buckets.get(key);
      return { key, visitors: b.visitors.size, sessions: b.sessions.size, pageviews: b.pageviews };
    });
  }

  async stats(rangeKey, now = Date.now()) {
    const range = RANGES[rangeKey] ? rangeKey : '7d';
    const days = RANGES[range];
    const keys = Array.from({ length: days }, (_, i) => dayKey(now - (days - 1 - i) * DAY_MS));
    const prevKeys = Array.from({ length: days }, (_, i) => dayKey(now - (2 * days - 1 - i) * DAY_MS));

    const events = await this.readDays(keys);
    const current = this.aggregate(events);
    const previous = this.aggregate(await this.readDays(prevKeys));

    const sources = new Map();
    const devices = new Map();
    const browsers = new Map();
    const systems = new Map();
    const sections = new Map();
    const hours = new Array(24).fill(0);
    for (const s of current.real) {
      inc(sources, s.source);
      inc(devices, s.device);
      inc(browsers, s.browser);
      inc(systems, s.os);
      hours[hourOf(s.first)] += 1;
      for (const name of s.sections) inc(sections, name);
    }

    const recent = current.real
      .slice()
      .sort((a, b) => b.first - a.first)
      .slice(0, 25)
      .map((s) => ({
        at: s.first,
        source: s.source,
        device: s.device,
        browser: s.browser,
        os: s.os,
        durationMs: s.dur,
        scroll: s.scroll,
        sections: s.sections.size,
        moods: [...new Set(s.moods)].slice(0, 6),
        actions: s.actions.slice(0, 8),
      }));

    const liveEvents = await this.readDays([...new Set([dayKey(now - 5 * 60 * 1000), dayKey(now)])]);
    const live = new Set(liveEvents.filter((e) => now - e.t <= 5 * 60 * 1000).map((e) => e.s)).size;

    return {
      range,
      generatedAt: now,
      live,
      totals: current.totals,
      previous: previous.totals,
      series: this.series(events, keys, range === 'today', now),
      hourly: range === 'today',
      sources: rankedCounts(sources, 8),
      devices: rankedCounts(devices),
      browsers: rankedCounts(browsers, 6),
      systems: rankedCounts(systems),
      moods: rankedCounts(current.moods, 10),
      clicks: rankedCounts(current.clicks, 12)
        .filter((row) => row.key !== 'other')
        .map((row) => {
          const [kind, label] = row.key.split('\u0000');
          return { kind, label, value: row.value };
        }),
      sections: Object.fromEntries(sections),
      hours,
      recent,
    };
  }

  async clear() {
    let names = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(names.filter((n) => n.endsWith('.jsonl')).map((n) => fsp.rm(path.join(this.dir, n), { force: true })));
    this.cache.clear();
    this.dayCounts.clear();
  }
}

module.exports = { Analytics, classifySource, parseAgent, dayKey };
