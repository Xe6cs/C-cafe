'use strict';

// /api/track: token-gated ingest, server-side identity/time, strict payload
// validation, and shared-limit behaviour. fetch is always mocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { handler } = require('../netlify/functions/track');
const { BOT_RE } = require('../lib/analytics');

const TOKEN = 'a'.repeat(64);
const anon = 'anon-test-key';

function configure(overrides = {}) {
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY = anon;
  process.env.CCAFE_ANALYTICS_ENV = 'preview';
  process.env.CCAFE_ANALYTICS_INGEST_TOKEN = TOKEN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restore() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  delete process.env.CCAFE_ANALYTICS_ENV;
  delete process.env.CCAFE_ANALYTICS_INGEST_TOKEN;
  delete process.env.CCAFE_SUPABASE_TIMEOUT_MS;
  delete global.fetch;
}

function trackEvent(body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    httpMethod: 'POST',
    path: '/api/track',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0 Safari/537.36',
      'x-nf-client-connection-ip': '203.0.113.9',
      'content-type': 'text/plain',
      ...headers,
    },
    body: text,
    isBase64Encoded: false,
  };
}

function okFetch(calls) {
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };
}

function baghdadDay(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test('a valid pageview is sanitized and sent with server identity only', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    const before = Date.now();
    const result = await handler(trackEvent({
      e: 'pageview',
      s: 'abcdef1234567890',
      r: 'instagram.com',
      u: 'ig',
      device: 'hacked',
      browser: 'hacked',
      os: 'hacked',
      extra: 'must-not-be-stored',
    }));
    assert.equal(result.statusCode, 204);
    assert.equal(result.body, '');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/v1\/rpc\/analytics_ingest$/);
    assert.equal(calls[0].init.headers.apikey, anon);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${anon}`);
    assert.doesNotMatch(calls[0].init.body, /203\.0\.113\.9|Mozilla/);
    assert.doesNotMatch(calls[0].init.body, /hacked|must-not-be-stored/);

    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.p_env, 'preview');
    assert.equal(
      sent.p_token_sha256,
      crypto.createHash('sha256').update(`ingest|${TOKEN}`).digest('hex'),
    );
    assert.match(sent.p_visitor, /^[0-9a-f]{16}$/);
    assert.equal(sent.p_event.e, 'pageview');
    assert.equal(sent.p_event.s, 'abcdef1234567890');
    assert.equal(sent.p_event.r, 'instagram.com');
    assert.equal(sent.p_event.u, 'ig');
    // The server classifies the real user agent, not the client fields.
    assert.equal(sent.p_event.device, 'desktop');
    assert.equal(sent.p_event.browser, 'chrome');
    assert.equal(sent.p_event.os, 'windows');
    assert.equal(sent.p_event.t, undefined);
    assert.equal(sent.p_event.v, undefined);

    const expected = crypto
      .createHmac('sha256', TOKEN)
      .update(`visitor|preview|${baghdadDay(before)}|203.0.113.9|Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/121.0 Safari/537.36`)
      .digest('hex')
      .slice(0, 16);
    assert.equal(sent.p_visitor, expected);
  } finally {
    restore();
  }
});

test('visitor hashes change with environment, address, and day but not with the session', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    await handler(trackEvent({ e: 'section', s: 'aaaaaaaa1111', n: 'menu' }));
    await handler(trackEvent({ e: 'section', s: 'bbbbbbbb2222', n: 'menu' }));
    await handler(trackEvent({ e: 'section', s: 'aaaaaaaa1111', n: 'menu' }, {
      'x-nf-client-connection-ip': '198.51.100.4',
    }));
    process.env.CCAFE_ANALYTICS_ENV = 'production';
    await handler(trackEvent({ e: 'section', s: 'aaaaaaaa1111', n: 'menu' }));
    const sent = calls.map((call) => JSON.parse(call.init.body));
    assert.equal(sent[0].p_visitor, sent[1].p_visitor);
    assert.notEqual(sent[0].p_visitor, sent[2].p_visitor);
    assert.notEqual(sent[0].p_visitor, sent[3].p_visitor);
    assert.equal(sent[3].p_env, 'production');
  } finally {
    restore();
  }
});

test('the endpoint is disabled unless the environment is explicit', async () => {
  configure({ CCAFE_ANALYTICS_ENV: undefined });
  const calls = [];
  okFetch(calls);
  try {
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }))).statusCode, 503);
    process.env.CCAFE_ANALYTICS_ENV = 'staging';
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }))).statusCode, 503);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('missing token or Supabase configuration fails closed', async () => {
  configure({ CCAFE_ANALYTICS_INGEST_TOKEN: undefined });
  const calls = [];
  okFetch(calls);
  try {
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }))).statusCode, 503);
    process.env.CCAFE_ANALYTICS_INGEST_TOKEN = 'short';
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }))).statusCode, 503);
    delete process.env.SUPABASE_ANON_KEY;
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }))).statusCode, 503);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('only POST is accepted and cross-site origins are rejected', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    const get = await handler({ httpMethod: 'GET', path: '/api/track', headers: {} });
    assert.equal(get.statusCode, 405);
    assert.equal(get.headers.Allow, 'POST');

    const cross = await handler(trackEvent(
      { e: 'pageview', s: 'abcdef1234567890' },
      { origin: 'https://evil.example', host: 'c-cafe-preview.netlify.app' },
    ));
    assert.equal(cross.statusCode, 403);
    assert.equal(calls.length, 0);

    const same = await handler(trackEvent(
      { e: 'pageview', s: 'abcdef1234567890' },
      { origin: 'https://c-cafe-preview.netlify.app', host: 'c-cafe-preview.netlify.app' },
    ));
    assert.equal(same.statusCode, 204);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('bots and requests without a user agent are dropped without fetching', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    assert.match('Googlebot/2.1', BOT_RE);
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }, {
      'user-agent': 'Googlebot/2.1',
    }))).statusCode, 204);
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }, {
      'user-agent': '',
    }))).statusCode, 204);
    assert.equal((await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }, {
      'x-nf-client-connection-ip': '',
      'x-forwarded-for': '',
    }))).statusCode, 204);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('malformed, oversized, and invalid events are rejected before ingest', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    const bad = [
      '{',
      'null',
      '[]',
      JSON.stringify({ e: 'hack', s: 'abcdef1234567890' }),
      JSON.stringify({ e: 'pageview', s: '../../etc/passwd' }),
      JSON.stringify({ e: 'pageview', s: 'short' }),
      JSON.stringify({ e: 'section', s: 'abcdef1234567890', n: 'UPPER SPACE' }),
      JSON.stringify({ e: 'mood', s: 'abcdef1234567890', n: '\u0000\u0001' }),
    ];
    for (const body of bad) {
      assert.equal((await handler(trackEvent(body))).statusCode, 400, body);
    }

    const click = await handler(trackEvent({
      e: 'click',
      s: 'abcdef1234567890',
      n: 'اتصال',
      k: 'made-up',
    }));
    assert.equal(click.statusCode, 204);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.p_event.k, 'external');

    const largeBody = JSON.stringify({ e: 'mood', s: 'abcdef1234567890', n: 'x'.repeat(5000) });
    assert.equal((await handler(trackEvent(largeBody))).statusCode, 413);
    const declared = await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }, {
      'content-length': '99999',
    }));
    assert.equal(declared.statusCode, 413);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('leave events are clamped and unknown fields are ignored', async () => {
  configure();
  const calls = [];
  okFetch(calls);
  try {
    const result = await handler(trackEvent({
      e: 'leave',
      s: 'abcdef1234567890',
      ms: -5,
      sc: 900,
      n: 'not-allowed',
      k: 'call',
    }));
    assert.equal(result.statusCode, 204);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.p_event.ms, 0);
    assert.equal(sent.p_event.sc, 100);
    assert.equal(sent.p_event.n, undefined);
    assert.equal(sent.p_event.k, undefined);
  } finally {
    restore();
  }
});

test('an ingest failure returns 503 without throwing', async () => {
  configure();
  global.fetch = async () => ({ ok: false, status: 503, async json() { return { message: 'down' }; } });
  try {
    const result = await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }));
    assert.equal(result.statusCode, 503);
  } finally {
    restore();
  }
});

test('a throwing ingest reports 503 and never leaks the error', async () => {
  configure();
  global.fetch = async () => { throw new Error('socket hang up with secret'); };
  try {
    const result = await handler(trackEvent({ e: 'pageview', s: 'abcdef1234567890' }));
    assert.equal(result.statusCode, 503);
    assert.doesNotMatch(result.body, /socket|secret/i);
  } finally {
    restore();
  }
});
