'use strict';

const U = (s) => String(s == null ? '' : s).toUpperCase().trim();

// Bind a cut lot's (style, size_label) to an EasyEcom size-SKU.
// Primary: the human-authored pm_sku_resolution map. Fallback: concatenation
// (letter sizes attach directly, numeric/long sizes via underscore) validated
// against the canonical ecom SKU set. Returns the size-SKU or null.
function resolveSizeSku(style, sizeLabel, resolutionMap, canonSet) {
  const st = U(style);
  const lbl = U(sizeLabel);
  if (!st || !lbl) return null;
  const fromMap = resolutionMap.get(st + '||' + lbl);
  if (fromMap) return fromMap;
  const direct = st + lbl;
  if (canonSet.has(direct)) return direct;
  const underscored = st + '_' + lbl;
  if (canonSet.has(underscored)) return underscored;
  return null;
}

// Build the size_sku -> on-order qty map. In-flight = cut pieces net of pieces
// already dispatched (finishing); unresolved sizes are tallied, never dropped
// silently. The manual pm_open_cutting_lots rows are summed on top (transition).
function buildOnOrderMap({ inFlightRows, dispatchedMap, manualRows, resolutionMap, canonSet }) {
  const map = new Map();
  const unresolvedLotSet = new Set();
  let unresolvedPieces = 0;

  for (const r of (inFlightRows || [])) {
    const dispatched = dispatchedMap.get(U(r.lot_no) + '||' + U(r.size_label)) || 0;
    const net = (Number(r.cut_pieces) || 0) - dispatched;
    if (net <= 0) continue;
    const sku = resolveSizeSku(r.style, r.size_label, resolutionMap, canonSet);
    if (!sku) {
      unresolvedLotSet.add(U(r.lot_no));
      unresolvedPieces += net;
      continue;
    }
    map.set(sku, (map.get(sku) || 0) + net);
  }

  for (const r of (manualRows || [])) {
    const sku = U(r.sku);
    if (!sku) continue;
    map.set(sku, (map.get(sku) || 0) + (Number(r.qty) || 0));
  }

  return { map, unresolvedLots: unresolvedLotSet.size, unresolvedPieces };
}

function flagOn() {
  const v = String(process.env.PM_CLOSED_LOOP || '').toLowerCase();
  return v === '1' || v === 'true';
}

async function loadManualRows(pool) {
  const [rows] = await pool.query(
    `SELECT sku, COALESCE(SUM(qty), 0) AS qty FROM pm_open_cutting_lots
     WHERE closed_at IS NULL GROUP BY sku`
  );
  return rows.map((r) => ({ sku: r.sku, qty: Number(r.qty) || 0 }));
}

// Returns { onOrder: Map<size_sku, qty>, unresolved: { lots, pieces } }.
// Flag OFF -> manual table only (today's behavior). Flag ON -> union real
// in-flight lots (cut within windowDays, net of dispatches) with the manual table.
async function computeOnOrderBySku(pool, { windowDays } = {}) {
  // Always runs: manual rows are unioned on top of real lots when flag is ON,
  // or used as the sole source when flag is OFF.
  const manualRows = await loadManualRows(pool);

  if (!flagOn()) {
    const built = buildOnOrderMap({
      inFlightRows: [], dispatchedMap: new Map(), manualRows,
      resolutionMap: new Map(), canonSet: new Set(),
    });
    return { onOrder: built.map, unresolved: { lots: 0, pieces: 0 } };
  }

  const days = Number(windowDays || process.env.PM_INFLIGHT_WINDOW_DAYS || 120);

  const [inflight] = await pool.query(
    `SELECT cl.lot_no, cl.sku AS style, cls.size_label,
            COALESCE(cls.total_pieces, 0) AS cut_pieces
     FROM cutting_lots cl
     JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
     WHERE cl.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [days]
  );

  const [dispatched] = await pool.query(
    `SELECT lot_no, size_label, COALESCE(SUM(quantity), 0) AS qty
     FROM finishing_dispatches
     WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY lot_no, size_label`,
    [days]
  );
  const dispatchedMap = new Map(
    dispatched.map((r) => [U(r.lot_no) + '||' + U(r.size_label), Number(r.qty) || 0])
  );

  const [resolution] = await pool.query(
    `SELECT cl_sku, size_label, size_sku FROM pm_sku_resolution
     WHERE state = 'resolved' AND size_sku IS NOT NULL`
  );
  const resolutionMap = new Map(
    resolution.map((r) => [U(r.cl_sku) + '||' + U(r.size_label), U(r.size_sku)])
  );

  const [canonRows] = await pool.query(
    `SELECT DISTINCT UPPER(sku) AS sku FROM ee_suborders WHERE sku IS NOT NULL AND sku <> ''`
  );
  const canonSet = new Set(canonRows.map((r) => r.sku));

  const built = buildOnOrderMap({
    inFlightRows: inflight, dispatchedMap, manualRows, resolutionMap, canonSet,
  });
  return {
    onOrder: built.map,
    unresolved: { lots: built.unresolvedLots, pieces: built.unresolvedPieces },
  };
}

module.exports = { resolveSizeSku, buildOnOrderMap, computeOnOrderBySku, U };
