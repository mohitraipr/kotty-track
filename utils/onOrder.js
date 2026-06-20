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

module.exports = { resolveSizeSku, U };
