'use strict';
// مخطط محتوى الموقع: منه تُبنى نماذج لوحة التحكم، ويُنظَّف به كل ما يُحفظ.
// أنواع الحقول: text, textarea, link (وجهة مع خيارات جاهزة), url (عنوان خام),
// image, icon, toggle, group (حقول متداخلة), list (عناصر قابلة للإضافة والترتيب).

const MAX_TEXT = 4000;
const MAX_LIST = 200;

const text = (key, label, extra = {}) => ({ key, type: 'text', label, ...extra });
const area = (key, label, extra = {}) => ({ key, type: 'textarea', label, ...extra });
const link = (key, label, extra = {}) => ({ key, type: 'link', label, ...extra });
const url = (key, label, extra = {}) => ({ key, type: 'url', label, ...extra });
const image = (key, label, extra = {}) => ({ key, type: 'image', label, ...extra });
const icon = (key, label, extra = {}) => ({ key, type: 'icon', label, ...extra });
const toggle = (key, label, extra = {}) => ({ key, type: 'toggle', label, ...extra });
const group = (key, label, fields, extra = {}) => ({ key, type: 'group', label, fields, ...extra });
const list = (key, label, itemLabel, titleKey, fields, extra = {}) => ({ key, type: 'list', label, itemLabel, titleKey, fields, ...extra });
const button = (key, label) => group(key, label, [
  text('label', 'نص الزر', { help: 'اتركه فارغًا لإخفاء الزر.' }),
  link('href', 'وجهة الزر'),
  icon('icon', 'أيقونة الزر'),
]);

const SCHEMA = [
  {
    id: 'contact',
    title: 'معلومات الاتصال',
    hint: 'تتغير هذه القيم في كل مكان تُستخدم فيه داخل الموقع.',
    fields: [
      text('name', 'اسم المكان'),
      text('phoneDisplay', 'رقم الهاتف كما يظهر للزوار', { dir: 'ltr' }),
      url('phoneIntl', 'رقم الهاتف الدولي للاتصال', { help: 'مثال: +9647716673643', placeholder: '+964...' }),
      text('address', 'العنوان الكامل'),
      text('street', 'الحي أو الشارع', { help: 'يُستخدم لتعريف المكان لدى محركات البحث.' }),
      text('city', 'المدينة'),
      url('mapsUrl', 'رابط خرائط Google'),
      url('instagramUrl', 'رابط إنستغرام'),
      text('instagramHandle', 'اسم الحساب في إنستغرام', { dir: 'ltr' }),
      text('lat', 'خط العرض على الخريطة', { dir: 'ltr' }),
      text('lng', 'خط الطول على الخريطة', { dir: 'ltr' }),
    ],
  },
  {
    id: 'seo',
    title: 'البحث والمشاركة',
    hint: 'كيف يظهر موقعك في Google وعند مشاركة رابطه.',
    fields: [
      text('title', 'عنوان الصفحة', { maxLength: 120 }),
      area('description', 'وصف الصفحة', { maxLength: 300 }),
      url('siteUrl', 'رابط الموقع بعد النشر', { help: 'مثال: https://ccafe.iq — ضروري لظهور صورة المشاركة.', placeholder: 'https://' }),
      image('ogImage', 'صورة المشاركة'),
      image('favicon', 'أيقونة تبويب المتصفح'),
      image('touchIcon', 'أيقونة شاشة الهاتف'),
    ],
  },
  {
    id: 'brand',
    title: 'الشعار',
    hint: 'يظهر في أعلى الموقع وأسفله.',
    fields: [
      image('logo', 'الشعار'),
      text('logoLabel', 'وصف الشعار لقارئات الشاشة'),
    ],
  },
  {
    id: 'header',
    title: 'الترويسة والقائمة العلوية',
    anchor: 'top',
    fields: [
      list('nav', 'روابط القائمة', 'رابط', 'label', [
        text('label', 'نص الرابط'),
        link('href', 'وجهة الرابط'),
      ]),
      toggle('showCall', 'إظهار زر الهاتف في الترويسة'),
      icon('callIcon', 'أيقونة زر الهاتف'),
    ],
  },
  {
    id: 'hero',
    title: 'الواجهة الرئيسية',
    anchor: 'top',
    fields: [
      image('mark', 'الرمز الكبير'),
      text('where', 'سطر الموقع'),
      text('line1', 'العنوان: السطر الأول'),
      text('big', 'العنوان: الكلمة الكبيرة'),
      text('line3', 'العنوان: السطر الأخير'),
      area('lead', 'الوصف القصير'),
      button('primary', 'الزر الأساسي'),
      button('secondary', 'الزر الثانوي'),
      list('facts', 'المعلومات السريعة أسفل الواجهة', 'معلومة', 'strong', [
        text('strong', 'الجزء البارز'),
        text('text', 'بقية النص'),
      ]),
    ],
  },
  {
    id: 'moods',
    title: 'الأمزجة',
    anchor: 'moods',
    section: true,
    fields: [
      text('kicker', 'العنوان الصغير'),
      text('title', 'عنوان القسم'),
      list('items', 'الأمزجة', 'مزاج', 'tab', [
        text('tab', 'اسم الزر'),
        text('title', 'العنوان'),
        area('text', 'النص'),
        text('note', 'سطر إضافي', { help: 'اختياري، يظهر باللون البرتقالي.' }),
        image('image', 'الصورة'),
        text('alt', 'وصف الصورة', { alsoIn: 'images' }),
      ]),
    ],
  },
  {
    id: 'vibes',
    title: 'الأجواء',
    anchor: 'vibes',
    section: true,
    fields: [
      text('kicker', 'العنوان الصغير'),
      text('title', 'عنوان القسم'),
      area('lead', 'الوصف'),
      list('tiles', 'صور المعرض', 'صورة', 'caption', [
        image('image', 'الصورة'),
        text('caption', 'التعليق على الصورة', { alsoIn: 'images' }),
        text('alt', 'وصف الصورة', { alsoIn: 'images' }),
        toggle('tall', 'صورة كبيرة', { alsoIn: 'images' }),
      ]),
      group('insta', 'بطاقة المتابعة', [
        toggle('visible', 'إظهار البطاقة'),
        text('text', 'النص'),
        text('handle', 'اسم الحساب', { dir: 'ltr', help: 'اتركه فارغًا لاستخدام اسم الحساب من معلومات الاتصال.' }),
        link('href', 'وجهة البطاقة'),
        icon('icon', 'أيقونة البطاقة'),
      ]),
    ],
  },
  {
    id: 'offer',
    title: 'العرض',
    anchor: 'students',
    section: true,
    fields: [
      text('number', 'الرقم الكبير', { dir: 'ltr' }),
      text('symbol', 'الرمز بجانب الرقم', { dir: 'ltr' }),
      text('kicker', 'العنوان الصغير'),
      text('title1', 'العنوان'),
      text('title2', 'تفاصيل العرض'),
      area('text', 'النص'),
      button('cta', 'زر العرض'),
    ],
  },
  {
    id: 'menu',
    title: 'المنيو',
    anchor: 'menu',
    section: true,
    fields: [
      text('kicker', 'العنوان الصغير'),
      text('title', 'عنوان القسم'),
      area('lead', 'الوصف'),
      button('primary', 'الزر الأساسي'),
      button('secondary', 'الزر الثانوي'),
      list('categories', 'الفئات', 'فئة', 'name', [
        text('name', 'اسم الفئة'),
        text('note', 'وصف قصير'),
        list('items', 'أصناف الفئة', 'صنف', 'name', [
          text('name', 'اسم الصنف'),
          text('note', 'وصف قصير'),
          text('price', 'السعر', { placeholder: 'مثال: 3,000 د.ع' }),
        ]),
      ]),
    ],
  },
  {
    id: 'visit',
    title: 'الزيارة والعنوان',
    anchor: 'visit',
    section: true,
    fields: [
      text('kicker', 'العنوان الصغير'),
      text('title', 'عنوان القسم'),
      list('facts', 'معلومات الزيارة', 'معلومة', 'label', [
        text('label', 'العنوان', { help: 'مثال: أوقات الدوام' }),
        text('value', 'القيمة', { help: 'مع الهاتف أو إنستغرام أو الخرائط: اتركها فارغة لتظهر القيمة من معلومات الاتصال.' }),
        link('href', 'وجهة الرابط'),
      ]),
      button('primary', 'الزر الأساسي'),
      button('secondary', 'الزر الثانوي'),
      toggle('mapVisible', 'إظهار الخريطة'),
    ],
  },
  {
    id: 'footer',
    title: 'التذييل',
    fields: [
      text('tagline', 'الشعار النصي'),
      text('small', 'السطر الصغير'),
    ],
  },
  {
    id: 'quickbar',
    title: 'شريط الجوال السريع',
    hint: 'يظهر أسفل الشاشة على الهواتف فقط.',
    fields: [
      toggle('visible', 'إظهار الشريط'),
      list('items', 'أزرار الشريط', 'زر', 'label', [
        text('label', 'نص الزر'),
        link('href', 'وجهة الزر'),
        icon('icon', 'أيقونة الزر'),
      ], { max: 4 }),
    ],
  },
];

// الأقسام التي يمكن إخفاؤها وإعادة ترتيبها
const SECTION_IDS = SCHEMA.filter((g) => g.section).map((g) => g.id);
const SECTION_ANCHORS = Object.fromEntries(SCHEMA.filter((g) => g.section).map((g) => [g.id, g.anchor]));

const LINK_TOKENS = [
  { value: '@phone', label: 'الاتصال بالهاتف' },
  { value: '@maps', label: 'خرائط Google' },
  { value: '@instagram', label: 'إنستغرام' },
];
const LINK_ANCHORS = [
  { value: '#top', label: 'قسم: أعلى الصفحة' },
  { value: '#moods', label: 'قسم: الأمزجة' },
  { value: '#vibes', label: 'قسم: الأجواء' },
  { value: '#students', label: 'قسم: العرض' },
  { value: '#menu', label: 'قسم: المنيو' },
  { value: '#visit', label: 'قسم: الزيارة والعنوان' },
];

function cleanText(value, field) {
  const max = field.maxLength || MAX_TEXT;
  return String(value).replace(/\u0000/g, '').slice(0, max);
}

function normalizeField(field, value, fallback) {
  switch (field.type) {
    case 'toggle':
      if (typeof value === 'boolean') return value;
      return typeof fallback === 'boolean' ? fallback : false;
    case 'group':
      return normalizeFields(field.fields, isObject(value) ? value : {}, isObject(fallback) ? fallback : {});
    case 'list': {
      const source = Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
      return source
        .slice(0, field.max || MAX_LIST)
        .map((item) => normalizeFields(field.fields, isObject(item) ? item : {}, {}));
    }
    default:
      if (typeof value === 'string' || typeof value === 'number') return cleanText(value, field);
      return typeof fallback === 'string' ? fallback : '';
  }
}

function normalizeFields(fields, value, fallback) {
  const out = {};
  for (const field of fields) out[field.key] = normalizeField(field, value[field.key], fallback[field.key]);
  return out;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// يُخرج نسخة نظيفة مطابقة للمخطط: تُهمل المفاتيح المجهولة وتُكمَل الناقصة من الافتراضي
function normalize(input, defaults) {
  const source = isObject(input) ? input : {};
  const out = {};
  for (const g of SCHEMA) {
    const value = isObject(source[g.id]) ? source[g.id] : {};
    const fallback = defaults[g.id] || {};
    out[g.id] = normalizeFields(g.fields, value, fallback);
    if (g.section) {
      out[g.id].visible = typeof value.visible === 'boolean' ? value.visible : fallback.visible !== false;
    }
  }
  const requested = isObject(source.layout) && Array.isArray(source.layout.order) ? source.layout.order : defaults.layout.order;
  const order = requested.filter((id, i) => SECTION_IDS.includes(id) && requested.indexOf(id) === i);
  for (const id of SECTION_IDS) if (!order.includes(id)) order.push(id);
  out.layout = { order };
  const settings = isObject(source.settings) ? source.settings : {};
  out.settings = {
    tracking: typeof settings.tracking === 'boolean' ? settings.tracking : defaults.settings.tracking,
  };
  return out;
}

module.exports = { SCHEMA, SECTION_IDS, SECTION_ANCHORS, LINK_TOKENS, LINK_ANCHORS, normalize };
