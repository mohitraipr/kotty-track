// utils/viteManifest.js
//
// Bridges the Vite-built React island (frontend/) into the EJS shell. After
// `vite build`, the bundle lives in public/tasks/ with hashed filenames, and a
// manifest at public/tasks/.vite/manifest.json maps the source entry to them.
// This helper reads that manifest and returns ready-to-print HTML tags so the
// shell view can inject the correct <script type="module"> + <link> for the
// current build without hardcoding hashes.

const fs = require('fs');
const path = require('path');

// Vite 5/6 writes the manifest under a `.vite/` subdirectory of the out dir.
const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'tasks', '.vite', 'manifest.json');
// Must match rollupOptions.input in frontend/vite.config.ts.
const ENTRY = 'src/main.tsx';
// Must match `base` in frontend/vite.config.ts (served via app.use('/public', ...)).
const ASSET_BASE = '/public/tasks/';

let cache = null;

function loadManifest() {
  // Cache only in production; in dev (--watch) the hashes change between builds.
  if (cache && process.env.NODE_ENV === 'production') return cache;
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  cache = parsed;
  return parsed;
}

/**
 * Returns { jsTag, cssTags } HTML strings for the tasks island entry.
 * Throws if the manifest/entry is missing (i.e. the frontend build hasn't run)
 * so the route can render a friendly "not built" message instead of a blank page.
 */
function taskAssetTags() {
  const manifest = loadManifest();
  const entry = manifest[ENTRY];
  if (!entry || !entry.file) {
    throw new Error(`Vite manifest missing entry "${ENTRY}" — run the frontend build.`);
  }

  const jsTag = `<script type="module" src="${ASSET_BASE}${entry.file}"></script>`;
  const cssTags = (entry.css || [])
    .map((href) => `<link rel="stylesheet" href="${ASSET_BASE}${href}">`)
    .join('\n');

  return { jsTag, cssTags };
}

module.exports = { taskAssetTags, MANIFEST_PATH };
