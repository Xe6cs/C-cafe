// Explicit allow-list for the public site build.
//
// Only these files are copied into dist/. Anything not listed here is
// intentionally excluded: data/, admin/, supabase/, tests, env files, backups,
// server.js, and index.html (the page is served by the Netlify Function so a
// static file cannot shadow it).
//
// track.js is public by design: the page loads it only when the deployment
// explicitly enables analytics, and it posts to /api/track with no cookies and
// no identifiers beyond a per-tab session id.
//
// Add new public assets here deliberately. The build fails if data/content.json
// references an asset that is missing from this list.

export const PUBLIC_FILES = [
  'styles.css',
  'script.js',
  'track.js',

  'assets/brand/apple-touch-icon.png',
  'assets/brand/favicon-32.png',
  'assets/brand/favicon.svg',
  'assets/brand/logo.svg',
  'assets/brand/mark.svg',
  'assets/brand/og.jpg',

  'assets/photos/billiards.webp',
  'assets/photos/coffee.webp',
  'assets/photos/drink.webp',
  'assets/photos/exterior.webp',
  'assets/photos/games.webp',
  'assets/photos/rooftop.webp',
  'assets/photos/stadium.webp',
  'assets/photos/students.webp',
  'assets/photos/tea.webp',
];
