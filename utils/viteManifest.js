// utils/viteManifest.js
//
// Bridges Vite-built React islands (frontend/) into the EJS shells. After
// `vite build`, each bundle lives in public/<island>/ with hashed filenames and
// a manifest at public/<island>/.vite/manifest.json mapping the source entry to
// them. This helper reads that manifest and returns ready-to-print HTML tags so
// the shell view can inject the correct <script type="module"> + <link> for the
// current build without hardcoding hashes.
//
// Two islands share this module:
//   - Tasks: entry src/main.tsx    -> public/tasks, base /public/tasks/
//   - QC:    entry src/qc/main.tsx  -> public/qc,    base /public/qc/

const fs = require('fs');
const path = require('path');

// Cache per-island; only in production (dev --watch changes hashes each build).
const caches = new Map();

function loadManifest(manifestPath) {
  if (process.env.NODE_ENV === 'production' && caches.has(manifestPath)) {
    return caches.get(manifestPath);
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  caches.set(manifestPath, parsed);
  return parsed;
}

/**
 * Generic tag builder for a Vite island.
 * @param {string} outDir   directory name under public/ (e.g. 'tasks', 'qc')
 * @param {string} entry    manifest entry key (source path, e.g. 'src/main.tsx')
 * @returns {{ jsTag: string, cssTags: string }}
 * Throws if the manifest/entry is missing (build hasn't run) so the route can
 * render a friendly "not built" message instead of a blank page.
 */
function assetTags(outDir, entry) {
  const manifestPath = path.join(__dirname, '..', 'public', outDir, '.vite', 'manifest.json');
  const assetBase = `/public/${outDir}/`;
  const manifest = loadManifest(manifestPath);
  const record = manifest[entry];
  if (!record || !record.file) {
    throw new Error(`Vite manifest missing entry "${entry}" — run the frontend build.`);
  }

  const jsTag = `<script type="module" src="${assetBase}${record.file}"></script>`;
  const cssTags = (record.css || [])
    .map((href) => `<link rel="stylesheet" href="${assetBase}${href}">`)
    .join('\n');

  return { jsTag, cssTags };
}

// Tasks island (must match frontend/vite.config.ts input + base).
function taskAssetTags() {
  return assetTags('tasks', 'src/main.tsx');
}

// QC island (must match frontend/vite.qc.config.ts input + base).
function qcAssetTags() {
  return assetTags('qc', 'src/qc/main.tsx');
}

const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'tasks', '.vite', 'manifest.json');

module.exports = { taskAssetTags, qcAssetTags, assetTags, MANIFEST_PATH };
