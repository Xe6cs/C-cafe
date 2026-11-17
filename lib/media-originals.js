'use strict';
// كتالوج الأصول الأصلية الـ15 المرفقة مع الموقع.
//
// تُعرض في مكتبة الوسائط للقراءة والاختيار فقط. لا تُرفع إلى التخزين الخاص
// ولا تُحذف ولا تُعدَّل من لوحة التحكم. القيم (الحجم والأبعاد والبصمة) مولّدة
// من الملفات الفعلية، ويعاد التحقق من وجود الملف عند بناء الدوال.

const ORIGINALS = [
  {
    "id": "logo",
    "logical_path": "assets/brand/logo.svg",
    "label": "شعار سي كافيه",
    "kind": "brand",
    "mime": "image/svg+xml",
    "bytes": 7063,
    "width": 3255,
    "height": 1381,
    "sha256": "056bc15e4ab621384fc24733d0087265362cc7e195b7b9c621dfa2f9ecc05eac"
  },
  {
    "id": "mark",
    "logical_path": "assets/brand/mark.svg",
    "label": "رمز الكوب",
    "kind": "brand",
    "mime": "image/svg+xml",
    "bytes": 3762,
    "width": 1394,
    "height": 1381,
    "sha256": "ba303ea55d0d562ca3d3401cddbf7f85e6c20b93f59a4e26b7efb749ae3055b5"
  },
  {
    "id": "favicon",
    "logical_path": "assets/brand/favicon.svg",
    "label": "أيقونة الموقع",
    "kind": "brand",
    "mime": "image/svg+xml",
    "bytes": 3791,
    "width": 2200,
    "height": 2200,
    "sha256": "efe0d897a5b6e591ff0a3d0859a7fefe248fdf1462123c82ff152c716fc9e1a9"
  },
  {
    "id": "favicon-32",
    "logical_path": "assets/brand/favicon-32.png",
    "label": "أيقونة 32 بكسل",
    "kind": "brand",
    "mime": "image/png",
    "bytes": 1152,
    "width": 32,
    "height": 32,
    "sha256": "4ff06d1d722b56f58e483a33e864e27bf81ac9bb944ce607ddf4e3d2f00af0e3"
  },
  {
    "id": "apple-touch-icon",
    "logical_path": "assets/brand/apple-touch-icon.png",
    "label": "أيقونة شاشة الهاتف",
    "kind": "brand",
    "mime": "image/png",
    "bytes": 7199,
    "width": 180,
    "height": 180,
    "sha256": "ef5c1619fd99868ba306488097c9239a8a60c2695a3d2355dbef9b839f1a0013"
  },
  {
    "id": "og",
    "logical_path": "assets/brand/og.jpg",
    "label": "صورة المشاركة",
    "kind": "brand",
    "mime": "image/jpeg",
    "bytes": 49880,
    "width": 1200,
    "height": 630,
    "sha256": "1c0ed9502808f1f5a52fcc3b45bf998477c0ce4397c2972e1fd095ca2cf14f6c"
  },
  {
    "id": "coffee",
    "logical_path": "assets/photos/coffee.webp",
    "label": "قهوة",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 46530,
    "width": 1100,
    "height": 1100,
    "sha256": "266606dfceff027900cffd39b19fc248ba058da769d91b356ed81da0eced88d4"
  },
  {
    "id": "tea",
    "logical_path": "assets/photos/tea.webp",
    "label": "شاي",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 30468,
    "width": 1100,
    "height": 1100,
    "sha256": "faff235e897cee81610407d95e27a2a23022b93e9c228883bdacb2a0e6c69cb0"
  },
  {
    "id": "billiards",
    "logical_path": "assets/photos/billiards.webp",
    "label": "بلياردو",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 35046,
    "width": 1100,
    "height": 1100,
    "sha256": "2e131cf6e6046cd829ef9d1e3193ed630e230ea361aa72ee340f6dd8a0722bd8"
  },
  {
    "id": "stadium",
    "logical_path": "assets/photos/stadium.webp",
    "label": "ملعب",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 62628,
    "width": 1100,
    "height": 1100,
    "sha256": "c7322a3bdcbceaea56d339d471c25a7cc8120924d7b7dd1a6aec670c5bbbb58d"
  },
  {
    "id": "students",
    "logical_path": "assets/photos/students.webp",
    "label": "طلاب",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 92742,
    "width": 1100,
    "height": 1100,
    "sha256": "d77d8bb3a88327bc32a331be066c5a3d144e12388a9f7f1b8a49effcc3a7be13"
  },
  {
    "id": "games",
    "logical_path": "assets/photos/games.webp",
    "label": "ألعاب",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 54376,
    "width": 1100,
    "height": 1100,
    "sha256": "615d1892839ae87330e3c3c8b0f920b8dbe8e828e58bce287bf7836700239ff8"
  },
  {
    "id": "exterior",
    "logical_path": "assets/photos/exterior.webp",
    "label": "المبنى من الخارج",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 73010,
    "width": 1300,
    "height": 1730,
    "sha256": "8322559f740d9a16b9e8f651df58dc5b7c93c07204d89dc132a1669beea9917c"
  },
  {
    "id": "rooftop",
    "logical_path": "assets/photos/rooftop.webp",
    "label": "السطح",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 56022,
    "width": 1000,
    "height": 1331,
    "sha256": "2bee56b793bffb3c2afef7b09e1bff6e0d597caefdcc3a877a01d982f9ce691f"
  },
  {
    "id": "drink",
    "logical_path": "assets/photos/drink.webp",
    "label": "مشروب",
    "kind": "photo",
    "mime": "image/webp",
    "bytes": 27986,
    "width": 800,
    "height": 1067,
    "sha256": "f5f091593b55bcdded52b303252edfac66cbb523db2869dae8a1e94dd979c2be"
  }
];

const ORIGINAL_PATHS = new Set(ORIGINALS.map((item) => item.logical_path));

function publicOriginals() {
  return ORIGINALS.map((item) => ({
    logical_path: item.logical_path,
    label: item.label,
    kind: item.kind,
    mime: item.mime,
    bytes: item.bytes,
    width: item.width,
    height: item.height,
    read_only: true,
  }));
}

module.exports = { ORIGINALS, ORIGINAL_PATHS, publicOriginals };
