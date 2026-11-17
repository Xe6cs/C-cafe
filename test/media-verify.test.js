'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const { verifyImage } = require('../lib/media-verify');

test('verifyImage rejects a 35MP image by pixel count, not by a single dimension', async () => {
  const big = await sharp({
    create: { width: 7000, height: 5000, channels: 3, background: { r: 20, g: 40, b: 80 } },
  }).jpeg({ quality: 60 }).toBuffer();

  const result = await verifyImage(big, { declaredMime: 'image/jpeg' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pixels_too_large');
});

test('verifyImage rejects an over-limit single dimension with a distinct reason', async () => {
  const wide = await sharp({
    create: { width: 8001, height: 1, channels: 3, background: { r: 1, g: 2, b: 3 } },
  }).png().toBuffer();

  const result = await verifyImage(wide, { declaredMime: 'image/png' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'dimension_too_large');
});

test('verifyImage accepts a small PNG and derives its real properties', async () => {
  const png = await sharp({
    create: { width: 5, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();

  const result = await verifyImage(png, { declaredMime: 'image/png' });
  assert.equal(result.ok, true);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.width, 5);
  assert.equal(result.height, 4);
  assert.equal(result.pixel_count, 20);
  assert.equal(result.bytes, png.length);
});

test('verifyImage rejects GIF even though it can decode the header', async () => {
  // 1x1 transparent GIF. The header is readable, so the rejection comes from
  // the PNG/JPEG/WebP allowlist rather than from a decode failure.
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const result = await verifyImage(gif, { declaredMime: 'image/gif' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported_type');
});

