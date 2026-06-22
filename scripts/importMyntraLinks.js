#!/usr/bin/env node
/**
 * importMyntraLinks.js — one-off, idempotent bulk-load of Myntra product links
 * from LINKS.csv into the `product_links` table (brand='kotty').
 *
 * LINKS.csv columns: article type, style name, size, SKU, Link
 *   - SKU is the EasyEcom size-SKU (e.g. KTTWOMENSPANT838XL). Some carry a
 *     marketplace prefix (L1_KTTTOP374L) or stray spaces (KOTTYMENSJEANS531_ 28).
 *   - Link is a bare `myntra.com/<id>` (no scheme).
 *
 * The PM read path (myntraByStyles in routes/productionManagerRoutes.js) prefix-
 * matches `product_links.sku REGEXP '^(style…)'`, and the views render the link
 * href RAW. So we must (a) strip the L#_ prefix + spaces so the stored sku begins
 * with the PM style, and (b) normalize the link to an absolute https URL.
 *
 * Stored at SIZE-SKU grain (one row per cleaned size-SKU). When a base listing and
 * its L1_ relist collapse to the same cleaned size-SKU, the NEWEST (max Myntra id)
 * wins. Only `myntra_link` is upserted — amazon/nykaa/flipkart are never touched.
 *
 * Usage:
 *   DB_PASSWORD=... node scripts/importMyntraLinks.js              # DRY RUN
 *   DB_PASSWORD=... node scripts/importMyntraLinks.js --apply      # WRITE
 *   ... --user=216           # created_by user id (else first admin/operator)
 *   ... --file=LINKS.csv     # source CSV (default: repo-root LINKS.csv)
 * Connection defaults target a cloud-sql-proxy on 127.0.0.1:3307; override with
 * DB_HOST / DB_PORT / DB_USER / DB_NAME.
 */

const mysql = require('mysql2/promise');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const USER_ARG = (process.argv.find((a) => a.startsWith('--user=')) || '').split('=')[1] || null;
const FILE_ARG = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1] || null;
const BRAND = 'kotty';
const BATCH = 1000;

const CSV_PATH = FILE_ARG
  ? path.resolve(FILE_ARG)
  : path.join(__dirname, '..', 'LINKS.csv');

// Clean a raw CSV SKU into the key we store: uppercase, drop embedded spaces,
// strip a leading marketplace prefix (L1_/L2_…) so it begins with the PM style.
function cleanSku(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^L\d+_/, '');
}

// Pull the trailing numeric id from a Myntra link and build an absolute URL.
function normalizeLink(raw) {
  const m = String(raw == null ? '' : raw).match(/(\d+)\s*$/);
  if (!m) return { id: null, link: null };
  const id = m[1];
  return { id, link: `https://www.myntra.com/${id}` };
}

// Parse the CSV into deduped { sku -> { link, id } } keeping the newest id.
function parseCsv(csvPath) {
  const buf = fs.readFileSync(csvPath);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const stats = { parsed: 0, skippedNoSku: 0, skippedNoId: 0, collapsed: 0 };
  const map = new Map(); // cleanSku -> { link, id (number) }

  for (const r of rows) {
    stats.parsed++;
    const sku = cleanSku(r.SKU || r.sku || r.Sku);
    const { id, link } = normalizeLink(r.Link || r.link || r.LINK);
    if (!sku) { stats.skippedNoSku++; continue; }
    if (!id) { stats.skippedNoId++; continue; }
    const idNum = Number(id);
    const prev = map.get(sku);
    if (prev) {
      stats.collapsed++;
      if (idNum > prev.id) map.set(sku, { link, id: idNum });
    } else {
      map.set(sku, { link, id: idNum });
    }
  }
  return { map, stats };
}

async function resolveUserId(conn) {
  if (USER_ARG) {
    const [[u]] = await conn.query('SELECT id FROM users WHERE id = ?', [USER_ARG]);
    if (!u) throw new Error(`--user=${USER_ARG} not found in users table`);
    return u.id;
  }
  // First admin/operator; fall back to lowest user id.
  const [rows] = await conn.query(`
    SELECT u.id FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE r.name IN ('admin', 'operator')
    ORDER BY u.id ASC LIMIT 1
  `).catch(() => [[]]);
  if (rows && rows.length) return rows[0].id;
  const [[any]] = await conn.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
  if (!any) throw new Error('No users found to attribute created_by');
  return any.id;
}

async function preflight(conn) {
  const [cols] = await conn.query('SHOW COLUMNS FROM product_links');
  const colNames = cols.map((c) => c.Field);
  const hasBrand = colNames.includes('brand');

  const [idx] = await conn.query('SHOW INDEX FROM product_links WHERE Non_unique = 0');
  // Group unique indexes by key name -> [columns in seq order]
  const uniques = {};
  for (const row of idx) {
    (uniques[row.Key_name] = uniques[row.Key_name] || []).push(row.Column_name);
  }
  const uniqueOnSkuAlone = Object.values(uniques)
    .some((c) => c.length === 1 && c[0] === 'sku');
  const uniqueOnBrandSku = Object.values(uniques)
    .some((c) => c.length === 2 && c.includes('brand') && c.includes('sku'));

  return { colNames, hasBrand, uniques, uniqueOnSkuAlone, uniqueOnBrandSku };
}

async function main() {
  console.log(`\n=== Myntra link import (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`Source: ${CSV_PATH}`);

  if (!fs.existsSync(CSV_PATH)) throw new Error(`CSV not found: ${CSV_PATH}`);

  // 1) Parse CSV (no DB needed)
  const { map, stats } = parseCsv(CSV_PATH);
  console.log('\n-- parse --');
  console.log(`  rows parsed:        ${stats.parsed}`);
  console.log(`  skipped (no sku):   ${stats.skippedNoSku}`);
  console.log(`  skipped (no id):    ${stats.skippedNoId}`);
  console.log(`  collapsed dups:     ${stats.collapsed} (base + L1_ relist, newest id wins)`);
  console.log(`  distinct size-SKUs: ${map.size}`);
  const sample = [...map.entries()].slice(0, 5)
    .map(([sku, v]) => `    ${sku} -> ${v.link}`).join('\n');
  console.log('  sample:\n' + sample);

  // 2) DB connection + pre-flight
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3307', 10),
    user: process.env.DB_USER || 'kotty_user',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'kotty_db',
    multipleStatements: false,
  });

  try {
    const pf = await preflight(conn);
    console.log('\n-- pre-flight --');
    console.log(`  brand column present: ${pf.hasBrand}`);
    console.log(`  unique indexes: ${JSON.stringify(pf.uniques)}`);

    const userId = await resolveUserId(conn);
    console.log(`  created_by user id:   ${userId}`);

    // Overlap risk only matters when uniqueness is on sku alone (a kotty upsert
    // would clobber a same-sku NOWI row's myntra_link).
    let overlap = 0;
    if (pf.uniqueOnSkuAlone && !pf.uniqueOnBrandSku && pf.hasBrand) {
      const skus = [...map.keys()];
      for (let i = 0; i < skus.length; i += 5000) {
        const chunk = skus.slice(i, i + 5000);
        const [[c]] = await conn.query(
          'SELECT COUNT(*) AS n FROM product_links WHERE brand <> ? AND sku IN (?)',
          [BRAND, chunk]
        );
        overlap += c.n;
      }
      console.log(`  non-kotty SKUs that would collide (UNIQUE on sku alone): ${overlap}`);
      if (overlap > 0) {
        console.log('\n  ⚠ STOP: incoming kotty SKUs collide with non-kotty rows and the unique');
        console.log('    key is on `sku` alone. Applying would overwrite their myntra_link.');
        console.log('    Resolve (e.g. add UNIQUE(brand,sku)) before --apply.');
        if (APPLY) throw new Error('Aborting --apply: non-kotty SKU overlap with UNIQUE(sku).');
      }
    }

    // 3) Coverage vs PM universe (ee_product_master.style), read-only.
    try {
      const [[univ]] = await conn.query(
        'SELECT COUNT(DISTINCT style) AS n FROM ee_product_master WHERE style IS NOT NULL AND style <> "" AND active = 1'
      );
      // A PM style is "linked" if any stored sku begins with it. Approximate with
      // the cleaned size-SKUs we are about to store: derive their style prefix by
      // stripping the trailing size, and intersect with the master style set.
      const [masterStyles] = await conn.query(
        'SELECT DISTINCT style FROM ee_product_master WHERE style IS NOT NULL AND style <> "" AND active = 1'
      );
      const masterSet = new Set(masterStyles.map((r) => String(r.style).toUpperCase()));
      const sizeRe = /(?:_(?:3XL|4XL|5XL|6XL)|_\d{2,3}|XXL|XL|XS|S|M|L)$/;
      const linkedStyles = new Set();
      for (const sku of map.keys()) {
        const st = sku.replace(sizeRe, '') || sku;
        if (masterSet.has(st)) linkedStyles.add(st);
      }
      const pct = univ.n ? ((linkedStyles.size / univ.n) * 100).toFixed(1) : '0';
      console.log('\n-- coverage --');
      console.log(`  active PM styles (ee_product_master): ${univ.n}`);
      console.log(`  of those now linked:                  ${linkedStyles.size} (${pct}%)`);
    } catch (e) {
      console.log('\n-- coverage -- (skipped: ' + e.message + ')');
    }

    // 4) Apply
    if (!APPLY) {
      console.log('\n(dry run — re-run with --apply to write)\n');
      return;
    }

    // Backup existing rows for the SKUs we are about to touch.
    const skus = [...map.keys()];
    const existing = [];
    for (let i = 0; i < skus.length; i += 5000) {
      const chunk = skus.slice(i, i + 5000);
      const [rows] = await conn.query(
        'SELECT id, brand, sku, amazon_link, myntra_link, nykaa_link, flipkart_link, created_by FROM product_links WHERE sku IN (?)',
        [chunk]
      );
      existing.push(...rows);
    }
    const dir = path.join(__dirname, 'import-backups');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(dir, `myntra-links-${ts}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({
      startedAt: ts, source: CSV_PATH, brand: BRAND, userId,
      incoming: map.size, existingTouched: existing.length, existing,
    }, null, 2));
    console.log(`\nBackup of ${existing.length} pre-existing rows -> ${backupFile}`);

    const entries = [...map.entries()];
    let written = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH);
      const values = chunk.map(([sku, v]) => [BRAND, sku, v.link, userId]);
      await conn.query(
        `INSERT INTO product_links (brand, sku, myntra_link, created_by) VALUES ?
         ON DUPLICATE KEY UPDATE myntra_link = VALUES(myntra_link), updated_at = NOW()`,
        [values]
      );
      written += chunk.length;
      if (written % 10000 === 0 || written === entries.length) {
        console.log(`  upserted ${written}/${entries.length}`);
      }
    }
    console.log(`\n✓ Done. Upserted ${written} size-SKU links (brand=${BRAND}).\n`);
  } finally {
    await conn.end();
  }
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
