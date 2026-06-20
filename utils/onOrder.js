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

module.exports = { resolveSizeSku, buildOnOrderMap, U };
