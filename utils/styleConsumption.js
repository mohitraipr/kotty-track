// Derive REAL fabric consumption (meters per piece) per style from cutting history,
// and compare it against the theoretical/standard consumption to surface wastage.
//
// History rows come from SQL: per cutting lot we have the marker length
// (cutting_lots.table_length, in meters), the total layers spread
// (SUM(cutting_lot_rolls.layers)), and the pieces cut (cutting_lots.total_pieces).
// A lot's blended consumption = table_length * layers / total_pieces.

// Real meters of fabric consumed per garment for a single lot.
// Returns null when inputs are missing/invalid.
function lotMetersPerPiece(lot) {
  const tl = Number(lot && lot.table_length);
  const layers = Number(lot && lot.layers);
  const pieces = Number(lot && lot.total_pieces);
  if (!isFinite(tl) || !isFinite(layers) || !isFinite(pieces)) return null;
  if (tl <= 0 || layers <= 0 || pieces <= 0) return null;
  return (tl * layers) / pieces;
}

// Plausibility bounds for a cutting lot, tuned against real prod data. Lots outside
// these are data-entry errors (e.g. table_length 3914) and are excluded from the
// derived consumption so they can't poison a style's figure.
const CLEAN_BOUNDS = {
  minTableLength: 1,    // meters
  maxTableLength: 20,   // meters
  minMetersPerPiece: 0.3,
  maxMetersPerPiece: 5,
};

// Is this lot trustworthy enough to count toward a style's real consumption?
function isCleanLot(lot, bounds = CLEAN_BOUNDS) {
  const tl = Number(lot && lot.table_length);
  if (!isFinite(tl) || tl < bounds.minTableLength || tl > bounds.maxTableLength) return false;
  const mpp = lotMetersPerPiece(lot);
  if (mpp === null) return false;
  if (mpp < bounds.minMetersPerPiece || mpp > bounds.maxMetersPerPiece) return false;
  return true;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Per-style real consumption from cutting history. A lot's style is cutting_lots.sku
// (the factory style code, no size). Uses the MEDIAN of clean lots so a few bad rows
// can't skew the figure. Styles with no clean lots get realMetersPerPiece = null.
// rows: [{ sku, table_length, layers, total_pieces }]
function aggregateStyleConsumption(rows, bounds = CLEAN_BOUNDS) {
  const byStyle = new Map();
  for (const r of rows || []) {
    const style = r.sku;
    if (!byStyle.has(style)) byStyle.set(style, { style, totalLots: 0, clean: [] });
    const g = byStyle.get(style);
    g.totalLots += 1;
    if (isCleanLot(r, bounds)) g.clean.push(lotMetersPerPiece(r));
  }
  return [...byStyle.values()].map((g) => ({
    style: g.style,
    realMetersPerPiece: median(g.clean),
    cleanLots: g.clean.length,
    totalLots: g.totalLots,
  }));
}

// Compare real derived consumption to the theoretical/standard. Positive variance = the
// floor consumes MORE than standard (fabric waste to investigate); negative = under.
// Within +/- tolerancePct it's 'on_target'. Returns 'unknown' if either side is missing.
function varianceVsStandard(realMetersPerPiece, standardMetersPerPiece, tolerancePct = 3) {
  const real = Number(realMetersPerPiece);
  const std = Number(standardMetersPerPiece);
  if (!isFinite(real) || !isFinite(std) || std <= 0 || realMetersPerPiece == null || standardMetersPerPiece == null) {
    return { variancePct: null, status: 'unknown' };
  }
  const variancePct = ((real - std) / std) * 100;
  let status = 'on_target';
  if (variancePct > tolerancePct) status = 'over';
  else if (variancePct < -tolerancePct) status = 'under';
  return { variancePct, status };
}

module.exports = {
  lotMetersPerPiece,
  isCleanLot,
  aggregateStyleConsumption,
  varianceVsStandard,
  median,
  CLEAN_BOUNDS,
};
