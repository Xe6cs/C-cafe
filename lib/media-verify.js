'use strict';
// التحقق الفعلي من الصور المرفوعة.
//
// لا نثق بالامتداد ولا بنوع MIME الذي يعلنه المتصفح: تُفكّ البايتات بمكتبة
// sharp، ويُشتق النوع والأبعاد من المحتوى نفسه. SVG مرفوض دائمًا، وكذلك أي
// صيغة غير PNG/JPEG/WebP، وأي صورة تتجاوز حدود الحجم/الأبعاد/البكسلات.
//
// تُستخدم نفس القواعد تقريبًا في قاعدة البيانات، لكن الفحص الحقيقي للبايتات
// لا يمكن أن يحدث هناك؛ لذلك finalize يتطلب رمزًا خادميًا يثبت أن هذا الفحص
// قد جرى قبل اعتماد الملف.

const crypto = require('node:crypto');

const MAX_BYTES = 15 * 1024 * 1024;
const MAX_DIMENSION = 8000;
const MAX_PIXELS = 32000000;
const MIN_BYTES = 1;

const ALLOWED_MIME = new Map([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
]);

const MEDIA_PATH_RE = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MEDIA_REF_RE = /^media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(reason) {
  return { ok: false, reason };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function loadSharp() {
  try {
    return require('sharp');
  } catch {
    return null;
  }
}

async function verifyImage(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES) return fail('empty');
  if (buffer.length > MAX_BYTES) return fail('too_large');

  const sharp = await loadSharp();
  if (!sharp) return fail('verifier_unavailable');

  let meta;
  try {
    // Read the header without a pixel-count limit so an over-limit image gets
    // the precise `pixels_too_large` reason (and never reaches a full decode).
    // The full decode below keeps the 32MP limit as a second line of defense.
    meta = await sharp(buffer, {
      failOn: 'error',
      limitInputPixels: false,
      animated: false,
    }).metadata();
  } catch {
    return fail('decode_failed');
  }

  const format = String(meta.format || '').toLowerCase();
  if (format === 'svg') return fail('svg_not_allowed');
  const mime = ALLOWED_MIME.get(format);
  if (!mime) return fail('unsupported_type');

  const width = meta.width;
  const height = meta.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    return fail('invalid_dimensions');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return fail('dimension_too_large');

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PIXELS) return fail('pixels_too_large');

  // metadata() reads the header; stats() forces a full decode so a truncated or
  // crafted file with a valid header cannot be approved.
  try {
    await sharp(buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).stats();
  } catch {
    return fail('decode_failed');
  }

  const declared = String(options.declaredMime || '').trim().toLowerCase();
  if (declared && declared !== mime) return fail('mime_mismatch');

  return {
    ok: true,
    format,
    mime,
    bytes: buffer.length,
    width,
    height,
    pixel_count: pixelCount,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

// يجمع كل مراجع media/<uuid> داخل المحتوى (بأي عمق) لاستخدامها في معاينة المدير.
function collectMediaRefs(value, out = new Set()) {
  if (typeof value === 'string') {
    if (MEDIA_REF_RE.test(value)) out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaRefs(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectMediaRefs(item, out);
  }
  return out;
}

module.exports = {
  MAX_BYTES,
  MAX_DIMENSION,
  MAX_PIXELS,
  ALLOWED_MIME,
  MEDIA_PATH_RE,
  MEDIA_REF_RE,
  verifyImage,
  sha256Hex,
  collectMediaRefs,
};
