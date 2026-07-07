// Cut planner: turn a per-size cut demand into cutting lots and the fabric to issue.
//
// Owner rulings (2026-06-18):
//  - CAD owns the marker (size ratio + layers). We produce QUANTITIES + LOTS only.
//  - CAD per-size consumption is the fabric truth: fabric = sum(size_qty * CAD consumption).
//    A size with no CAD figure is flagged, not guessed.
//  - A lot caps at 1,500 pieces (hard); split via n = ceil(total / 1500), sizes proportional.

// Fabric (meters) needed for a set of per-size quantities, using CAD per-size consumption.
// Sizes without a CAD figure are listed in missingSizes and left out of the total.
function fabricForCut(sizesQty, consumptionBySize) {
  const cons = consumptionBySize || {};
  const perSize = {};
  const missingSizes = [];
  let total = 0;
  for (const [size, rawQty] of Object.entries(sizesQty || {})) {
    const qty = Number(rawQty) || 0;
    if (qty <= 0) continue;
    const c = Number(cons[size]);
    if (!isFinite(c) || cons[size] == null) {
      missingSizes.push(size);
      continue;
    }
    perSize[size] = qty * c;
    total += perSize[size];
  }
  return { perSize, total, missingSizes, complete: missingSizes.length === 0 };
}

const MAX_LOT = 1500;
// Within one marker/lot, the largest size qty should be at most this many times the
// smallest. Beyond it the marker's size ratio is impractical to cut (e.g. 115:1 when a hot
// size sits next to a trivial one), so those sizes are split into separate lots instead of
// smeared proportionally across every lot. Volume-similar sizes stay together (good nesting);
// a trivial size peels off on its own. Env-overridable via PM_MARKER_MAX_RATIO.
const MAX_MARKER_RATIO = Number(process.env.PM_MARKER_MAX_RATIO) || 8;

function sumSizes(sizes) {
  return Object.values(sizes || {}).reduce((s, q) => s + (Number(q) || 0), 0);
}

// Group sizes by volume similarity. Walking largest -> smallest, keep adding to the current
// group while (groupMax / size) <= maxRatio; otherwise start a new group. So a dominant size
// stays with its near-volume neighbours (nesting stays good) while a trivial size (far below
// the group's max) peels into its own group instead of distorting the marker ratio.
function groupSizesByRatio(demandBySize, maxRatio) {
  const entries = Object.entries(demandBySize)
    .map(([s, q]) => [s, Number(q) || 0])
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1]);
  const groups = []; // [{ sizes: {size:qty}, max }]
  for (const [s, q] of entries) {
    const last = groups[groups.length - 1];
    if (last && last.max / q <= maxRatio) last.sizes[s] = q;
    else groups.push({ sizes: { [s]: q }, max: q });
  }
  return groups.map((g) => g.sizes);
}

// Proportional split of ONE size-map into <= maxLot lots (sizes proportional in every lot).
// n = ceil(total / maxLot); 1,500 is a hard cap (never above). Rounding remainders go to the
// earliest lots so per-size totals are exactly conserved.
function proportionalSplit(demandBySize, maxLot) {
  const total = sumSizes(demandBySize);
  if (total <= 0) return [];
  const n = Math.ceil(total / maxLot);
  const lots = Array.from({ length: n }, () => ({ sizes: {}, total: 0 }));
  for (const [size, rawQty] of Object.entries(demandBySize)) {
    const qty = Number(rawQty) || 0;
    if (qty <= 0) continue;
    const base = Math.floor(qty / n);
    let remainder = qty - base * n;
    for (let i = 0; i < n; i++) {
      const give = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      if (give > 0) { lots[i].sizes[size] = (lots[i].sizes[size] || 0) + give; lots[i].total += give; }
    }
  }
  return lots;
}

// Split per-size demand into cutting lots. SKEW-AWARE: sizes of wildly different volume don't
// share a marker — they're grouped by volume similarity first, then each group is split
// proportionally, every lot <= maxLot. Pass skewAware:false for a single proportional split
// across all sizes (legacy behaviour). Per-size totals are always exactly conserved.
function splitIntoLots(demandBySize, opts = {}) {
  const maxLot = opts.maxLot || MAX_LOT;
  const maxRatio = opts.maxRatio || MAX_MARKER_RATIO;
  const groups = opts.skewAware === false ? [demandBySize] : groupSizesByRatio(demandBySize, maxRatio);
  const lots = [];
  for (const group of groups) lots.push(...proportionalSplit(group, maxLot));
  return lots;
}

// Full cut plan: split a style's suggested cut into capped lots and attach the fabric to
// issue per lot from CAD per-size consumption (opts.consumptionBySize). CAD makes the marker
// for each lot's quantities — we do not. Fabric is null/incomplete when CAD data is missing.
function planCut(demandBySize, opts = {}) {
  const cons = opts.consumptionBySize || {};
  const rawLots = splitIntoLots(demandBySize, opts);
  const missing = new Set();
  const lots = rawLots.map((lot) => {
    const f = fabricForCut(lot.sizes, cons);
    f.missingSizes.forEach((s) => missing.add(s));
    return { sizes: lot.sizes, total: lot.total, fabricMeters: f.complete || f.total > 0 ? f.total : null, fabricComplete: f.complete };
  });
  const totalPieces = lots.reduce((s, l) => s + l.total, 0);
  const haveAnyCad = Object.keys(cons).length > 0 && lots.some((l) => l.fabricMeters != null && l.fabricMeters > 0);
  const fabricComplete = lots.length > 0 && lots.every((l) => l.fabricComplete);
  const totalFabricMeters = haveAnyCad ? lots.reduce((s, l) => s + (l.fabricMeters || 0), 0) : null;
  return {
    lots,
    lotCount: lots.length,
    totalPieces,
    totalFabricMeters,
    fabricComplete,
    missingSizes: [...missing],
  };
}

module.exports = { fabricForCut, splitIntoLots, groupSizesByRatio, proportionalSplit, planCut, sumSizes, MAX_LOT, MAX_MARKER_RATIO };
