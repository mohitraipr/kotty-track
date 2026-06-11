// utils/skuResolver.js
//
// Loads the human-authored cutting-style -> ecom size-SKU map into
// pm_sku_resolution. Two inputs:
//   - SIZE sheet: explicit (cl_sku, size_label, size_sku) rows.
//   - STYLE sheet: per-style ruling (waist | letter | skip) expanded to size rows.
//
// Rules (locked):
//   - Every resolved size_sku MUST exist in the distinct ee_suborders SKU set;
//     rows that fail validation are rejected with a per-row reason, never loaded.
//   - Loaded rows are frozen mappings the binder trusts (upsert on (cl_sku,size_label)
//     so a later corrected upload can fix one, but a bad row never lands).
//   - Partial uploads are fine: only rows present in the sheet are processed.
//   - SKIP -> state='excluded' (a decision, not a gap).

const U = (s) => String(s == null ? '' : s).toUpperCase().trim();

async function getCanonSkuSet(pool) {
  const [rows] = await pool.query(
    'SELECT DISTINCT UPPER(sku) AS sku FROM ee_suborders WHERE sku IS NOT NULL AND sku <> ""'
  );
  return new Set(rows.map((r) => r.sku));
}

async function getStyleSizeLabels(pool, clSkus) {
  if (!clSkus.length) return new Map();
  const [rows] = await pool.query(
    `SELECT cl.sku AS cl_sku, cls.size_label
     FROM cutting_lots cl JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
     WHERE cl.sku IN (?) AND cls.size_label <> ''
     GROUP BY cl.sku, cls.size_label`,
    [clSkus]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.cl_sku)) map.set(r.cl_sku, new Set());
    map.get(r.cl_sku).add(r.size_label);
  }
  return map;
}

async function upsertRows(pool, rows, loadedBy) {
  // rows: [cl_sku, size_label, size_sku|null, state, source, ruling|null]
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await pool.query(
      `INSERT INTO pm_sku_resolution (cl_sku, size_label, size_sku, state, source, ruling, loaded_by)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         size_sku = VALUES(size_sku), state = VALUES(state), source = VALUES(source),
         ruling = VALUES(ruling), loaded_by = VALUES(loaded_by), updated_at = CURRENT_TIMESTAMP`,
      [chunk.map((r) => [...r, loadedBy ?? null])]
    );
  }
}

// SIZE sheet: explicit size_sku per row.
async function loadSizeRows(pool, inputRows, loadedBy) {
  const canon = await getCanonSkuSet(pool);
  const toLoad = [];
  const rejected = [];
  let skippedBlank = 0;
  for (const r of inputRows) {
    const clSku = String(r.cl_sku || '').trim();
    const sizeLabel = String(r.size_label || '').trim();
    const sizeSku = String(r.size_sku || '').trim();
    if (!clSku || !sizeLabel) continue;
    if (!sizeSku) { skippedBlank++; continue; }                 // leave unresolved, re-export later
    if (!canon.has(U(sizeSku))) {
      rejected.push({ cl_sku: clSku, size_label: sizeLabel, size_sku: sizeSku, reason: 'size_sku not found in ee_suborders' });
      continue;
    }
    toLoad.push([clSku, sizeLabel, U(sizeSku), 'resolved', 'size_sheet', null]);
  }
  if (toLoad.length) await upsertRows(pool, toLoad, loadedBy);
  return { loaded: toLoad.length, rejected, skippedBlank };
}

// STYLE sheet: per-style ruling expanded to size rows.
//   skip   -> every size_label excluded.
//   letter -> concat(cl_sku, size_label) [and _variant]; load if exactly one validates.
//   waist  -> needs per-size mapping (waist->letter) -> left for the size sheet, reported.
async function loadStyleRulings(pool, rulings, loadedBy) {
  const canon = await getCanonSkuSet(pool);
  const clean = rulings
    .map((r) => ({ cl_sku: String(r.style || r.cl_sku || '').trim(), ruling: String(r.ruling || '').trim().toLowerCase() }))
    .filter((r) => r.cl_sku && ['waist', 'letter', 'skip'].includes(r.ruling));
  const labelMap = await getStyleSizeLabels(pool, [...new Set(clean.map((r) => r.cl_sku))]);

  const toLoad = [];
  const summary = { excluded: 0, resolved_letter: 0, needs_size_sheet: 0, unresolved_letter: [], unknown_ruling: [] };
  for (const r of clean) {
    const labels = [...(labelMap.get(r.cl_sku) || [])];
    if (r.ruling === 'skip') {
      for (const lbl of labels) { toLoad.push([r.cl_sku, lbl, null, 'excluded', 'style_sheet', 'skip']); summary.excluded++; }
    } else if (r.ruling === 'letter') {
      for (const lbl of labels) {
        const cands = [...new Set([U(r.cl_sku) + U(lbl), U(r.cl_sku) + '_' + U(lbl)])];
        const matches = cands.filter((c) => canon.has(c));
        if (matches.length === 1) { toLoad.push([r.cl_sku, lbl, matches[0], 'resolved', 'style_sheet', 'letter']); summary.resolved_letter++; }
        else { summary.unresolved_letter.push({ cl_sku: r.cl_sku, size_label: lbl, reason: matches.length ? 'ambiguous letter match' : 'no letter match' }); }
      }
    } else if (r.ruling === 'waist') {
      // waist->letter is a per-size judgement; defer to the size sheet (stays resolver_failed).
      summary.needs_size_sheet += labels.length;
    }
  }
  if (toLoad.length) await upsertRows(pool, toLoad, loadedBy);
  return summary;
}

async function getResolutionStatus(pool) {
  const [[r]] = await pool.query(
    `SELECT
       SUM(state='resolved') AS resolved,
       SUM(state='excluded') AS excluded,
       COUNT(*) AS total
     FROM pm_sku_resolution`
  );
  return { resolved: Number(r.resolved) || 0, excluded: Number(r.excluded) || 0, total: Number(r.total) || 0 };
}

module.exports = { getCanonSkuSet, loadSizeRows, loadStyleRulings, getResolutionStatus };
