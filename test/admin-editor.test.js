'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const editor = require('../netlify/admin/editor');

const GROUPS = [
  {
    id: 'hero',
    title: 'الواجهة',
    fields: [
      { key: 'big', type: 'text', label: 'الكلمة الكبيرة' },
      { key: 'lead', type: 'textarea', label: 'الوصف' },
      { key: 'image', type: 'image', label: 'الصورة' },
    ],
  },
  {
    id: 'moods',
    title: 'الأمزجة',
    section: true,
    fields: [
      { key: 'title', type: 'text', label: 'العنوان' },
      { key: 'items', type: 'list', label: 'العناصر', itemLabel: 'مزاج', titleKey: 'tab', fields: [
        { key: 'tab', type: 'text', label: 'الاسم' },
      ] },
    ],
  },
  {
    id: 'vibes',
    title: 'الأجواء',
    section: true,
    fields: [{ key: 'title', type: 'text', label: 'العنوان' }],
  },
];

function content(overrides = {}) {
  return {
    hero: { big: 'أ', lead: 'ب', image: 'assets/photos/coffee.webp' },
    moods: { visible: true, title: 'الأمزجة', items: [{ tab: 'قهوة' }] },
    vibes: { visible: true, title: 'الأجواء' },
    layout: { order: ['moods', 'vibes'] },
    ...overrides,
  };
}

test('link validation accepts only safe destinations', () => {
  for (const value of ['', '@phone', '@maps', '@instagram', '#menu', '#top', 'https://example.com', 'http://x.test/a', 'tel:+964771', 'mailto:a@b.c', 'sms:+964', '/admin/']) {
    assert.equal(editor.linkError(value), '', value);
  }
  for (const value of ['javascript:alert(1)', '//evil.example', 'evil.example', 'data:text/html,x']) {
    assert.notEqual(editor.linkError(value), '', value);
  }
});

test('url validation handles phone and web links', () => {
  assert.equal(editor.urlError('', { key: 'siteUrl' }), '');
  assert.equal(editor.urlError('https://ccafe.iq', { key: 'siteUrl' }), '');
  assert.notEqual(editor.urlError('ccafe.iq', { key: 'siteUrl' }), '');
  assert.equal(editor.urlError('+9647716673643', { key: 'phoneIntl' }), '');
  assert.equal(editor.urlError('0771 667 3643', { key: 'phoneIntl' }), '');
  assert.notEqual(editor.urlError('phone', { key: 'phoneIntl' }), '');
});

test('asset paths are limited to the assets directory', () => {
  assert.equal(editor.assetSrc('assets/photos/coffee.webp'), '/assets/photos/coffee.webp');
  assert.equal(editor.assetSrc('assets/brand/logo.svg'), '/assets/brand/logo.svg');
  assert.equal(editor.assetSrc('../secret'), '');
  assert.equal(editor.assetSrc('/assets/logo.svg'), '');
  assert.equal(editor.assetSrc('https://example.com/x.png'), '');
  assert.equal(editor.assetSrc(''), '');
});

test('private media assets resolve only through approved https preview URLs', () => {
  const id = '9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b';
  const ref = `media/${id}`;
  const signed = 'https://example.supabase.co/storage/v1/object/sign/ccafe-media/media/x?token=abc';
  assert.equal(editor.assetSrc(ref, { [ref]: signed }), signed);
  assert.equal(editor.assetSrc(ref, {}), '');
  assert.equal(editor.assetSrc(ref, { [ref]: 'http://example.test/x' }), '');
  assert.equal(editor.assetSrc(ref, { [ref]: 'javascript:alert(1)' }), '');
  assert.equal(editor.assetSrc(`media/not-a-uuid`, { [`media/not-a-uuid`]: signed }), '');
  assert.equal(editor.MEDIA_RE.test(ref), true);
  assert.equal(editor.MEDIA_RE.test('media/../assets/photos/coffee.webp'), false);
});

test('content helpers read and write nested media references', () => {
  const doc = { hero: { image: `media/9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b` }, list: [{ image: '' }] };
  assert.equal(
    editor.getContentAt(doc, ['hero', 'image']),
    'media/9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b',
  );
  editor.setContentAt(doc, ['list', 0, 'image'], 'assets/photos/tea.webp');
  assert.equal(doc.list[0].image, 'assets/photos/tea.webp');
  editor.setContentAt(doc, ['hero', 'image'], '');
  assert.equal(doc.hero.image, '');
});


test('field filters cover text, links, and nested groups', () => {
  assert.equal(editor.fieldMatches({ type: 'text' }, 'texts'), true);
  assert.equal(editor.fieldMatches({ type: 'textarea' }, 'texts'), true);
  assert.equal(editor.fieldMatches({ type: 'image' }, 'texts'), false);
  assert.equal(editor.fieldMatches({ type: 'link' }, 'links'), true);
  assert.equal(editor.fieldMatches({ type: 'url' }, 'links'), true);
  assert.equal(editor.fieldMatches({ type: 'text' }, 'links'), false);
  assert.equal(editor.fieldMatches({ type: 'image', alsoIn: 'images' }, 'images'), true);
  const group = { type: 'group', fields: [{ key: 'a', type: 'text' }] };
  assert.equal(editor.fieldMatches(group, 'texts'), true);
  assert.equal(editor.fieldMatches(group, 'links'), false);
});

test('diffContent reports changed values, order, and visibility only', () => {
  const mine = content({
    hero: { big: 'جديد', lead: 'ب', image: 'assets/photos/coffee.webp' },
    moods: { visible: false, title: 'الأمزجة', items: [{ tab: 'قهوة' }] },
    layout: { order: ['vibes', 'moods'] },
  });
  const theirs = content({ hero: { big: 'قديم', lead: 'ب', image: 'assets/photos/coffee.webp' } });

  const diff = editor.diffContent(mine, theirs, GROUPS);
  const labels = diff.map((item) => item.label);
  assert.ok(labels.some((label) => label.includes('الكلمة الكبيرة')));
  assert.ok(labels.includes('ترتيب الأقسام'));
  assert.ok(labels.some((label) => label.includes('إظهار قسم الأمزجة')));

  const big = diff.find((item) => item.label.includes('الكلمة الكبيرة'));
  assert.equal(big.mine, 'جديد');
  assert.equal(big.theirs, 'قديم');

  const same = editor.diffContent(content(), content(), GROUPS);
  assert.equal(same.length, 0);
});

test('diffContent caps the number of reported fields', () => {
  const mine = content();
  const theirs = content();
  for (let i = 0; i < 120; i += 1) theirs.hero.big = `قيمة ${i}`;
  const diff = editor.diffContent(mine, theirs, GROUPS);
  assert.ok(diff.length <= 80);
});

test('blankItem builds schema-shaped empty list items', () => {
  assert.deepEqual(editor.blankItem([{ key: 'a', type: 'text' }]), { a: '' });
  assert.deepEqual(editor.blankItem([{ key: 'a', type: 'toggle' }]), { a: false });
  assert.deepEqual(editor.blankItem([{ key: 'a', type: 'list', fields: [] }]), { a: [] });
  assert.deepEqual(editor.blankItem([{ key: 'g', type: 'group', fields: [{ key: 'x', type: 'text' }] }]), { g: { x: '' } });
});
