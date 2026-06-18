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

function sumSizes(sizes) {
  return Object.values(sizes || {}).reduce((s, q) => s + (Number(q) || 0), 0);
}

// Split per-size demand into lots, each total <= maxLot, sizes PROPORTIONAL in every lot.
// n = ceil(total / maxLot); 1,500 is a hard cap (never above), a lot may dip below 1,200.
// Rounding remainders go to the earliest lots so per-size totals are exactly conserved.
function splitIntoLots(demandBySize, opts = {}) {
  const maxLot = opts.maxLot || MAX_LOT;
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

module.exports = { fabricForCut, splitIntoLots, planCut, sumSizes, MAX_LOT };
