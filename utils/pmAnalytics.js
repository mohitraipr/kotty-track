// Pure aggregations behind the Production Manager summary cards + analytics page.
// DB queries live in routes/productionManagerRoutes.js; these turn the raw rows into the
// numbers shown on screen, so the logic is unit-tested.

// Cut priority card: how many styles need cutting now (red) / soon (amber), and the total
// pieces suggested. Input = the per-style aggregates (aggregateStyles output).
function cutPrioritySummary(styleAggregates) {
  let red = 0; let amber = 0; let totalSuggested = 0; let stylesNeedingCut = 0;
  for (const s of styleAggregates || []) {
    if (s.trigger === 'red') red += 1;
    else if (s.trigger === 'amber') amber += 1;
    const sug = Number(s.suggested_cut_qty) || 0;
    totalSuggested += sug;
    if (sug > 0) stylesNeedingCut += 1;
  }
  return { red, amber, totalSuggested, stylesNeedingCut };
}

// Fabric-needed card: price the suggested cuts using CAD per-size consumption, grouped by
// fabric type. Sizes/styles with no CAD figure are counted as "uncovered" (not priced).
//   recRows: [{ style, size, suggested_cut_qty }]
//   consumptionRows: [{ style, size_label, consumption_per_piece, fabric_type }]
function fabricNeededByType(recRows, consumptionRows) {
  const cons = new Map();
  for (const c of consumptionRows || []) {
    cons.set(`${c.style}|${c.size_label}`, { per: Number(c.consumption_per_piece), type: c.fabric_type || '(unknown)' });
  }
  const byType = new Map();
  let totalMeters = 0; let coveredPieces = 0; let uncoveredPieces = 0;
  for (const r of recRows || []) {
    const qty = Number(r.suggested_cut_qty) || 0;
    if (qty <= 0) continue;
    const hit = cons.get(`${r.style}|${r.size}`);
    if (!hit || !isFinite(hit.per)) { uncoveredPieces += qty; continue; }
    const meters = qty * hit.per;
    const e = byType.get(hit.type) || { fabric_type: hit.type, meters: 0, pieces: 0 };
    e.meters += meters; e.pieces += qty;
    byType.set(hit.type, e);
    totalMeters += meters; coveredPieces += qty;
  }
  const types = [...byType.values()].sort((a, b) => b.meters - a.meters);
  return { byType: types, totalMeters, coveredPieces, uncoveredPieces };
}

// WIP card: pieces currently held at each stage = approved - completed - inline_rejected
// (the inline work-in-progress), floored at 0. rows: [{ stage, approved, completed, inline_rejected }]
function wipByStage(rows) {
  const byStage = {};
  let totalInHand = 0;
  for (const r of rows || []) {
    const inHand = Math.max(0, (Number(r.approved) || 0) - (Number(r.completed) || 0) - (Number(r.inline_rejected) || 0));
    byStage[r.stage] = inHand;
    totalInHand += inHand;
  }
  return { byStage, totalInHand };
}

module.exports = { cutPrioritySummary, fabricNeededByType, wipByStage };
