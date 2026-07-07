const { test } = require('node:test');
const assert = require('node:assert');
const { fabricForCut, splitIntoLots, groupSizesByRatio, planCut } = require('../utils/cutPlanner.js');

// Owner ruling 2026-06-18: CAD per-size consumption is the fabric truth.
// fabric = sum(size_qty * CAD consumption). CAD owns the marker; we only do quantities+lots.

test('fabricForCut sums size_qty * CAD consumption per size', () => {
  const r = fabricForCut({ M: 200, L: 100 }, { M: 1.02, L: 1.05 });
  assert.ok(Math.abs(r.perSize.M - 204) < 1e-9);
  assert.ok(Math.abs(r.perSize.L - 105) < 1e-9);
  assert.ok(Math.abs(r.total - 309) < 1e-9);
  assert.deepStrictEqual(r.missingSizes, []);
  assert.strictEqual(r.complete, true);
});

test('fabricForCut flags sizes with no CAD consumption and excludes them from the total', () => {
  const r = fabricForCut({ M: 100, XXL: 50 }, { M: 1.02 }); // no CAD for XXL
  assert.ok(Math.abs(r.total - 102) < 1e-9); // only the M counted
  assert.deepStrictEqual(r.missingSizes, ['XXL']);
  assert.strictEqual(r.complete, false);
});

test('fabricForCut returns zero/complete for empty demand', () => {
  const r = fabricForCut({}, { M: 1.02 });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.missingSizes, []);
  assert.strictEqual(r.complete, true);
});

test('splitIntoLots caps at 1500, sizes proportional, never above the cap', () => {
  const lots = splitIntoLots({ M: 1300, L: 900, XL: 400, XXL: 200 }); // 2800 -> 2x1400
  assert.strictEqual(lots.length, 2);
  for (const lot of lots) assert.ok(lot.total <= 1500);
  assert.deepStrictEqual(lots[0].sizes, { M: 650, L: 450, XL: 200, XXL: 100 });
  assert.strictEqual(lots[0].total + lots[1].total, 2800);
});

test('splitIntoLots may dip below 1200 but never exceeds 1500', () => {
  const lots = splitIntoLots({ M: 1000, L: 600, XL: 310 }); // 1910 -> 2x955
  assert.strictEqual(lots.length, 2);
  for (const lot of lots) assert.ok(lot.total <= 1500);
});

test('splitIntoLots: empty/zero demand -> no lots', () => {
  assert.deepStrictEqual(splitIntoLots({}), []);
  assert.deepStrictEqual(splitIntoLots({ M: 0 }), []);
});

test('groupSizesByRatio keeps volume-similar sizes together, peels off trivial ones', () => {
  const g = groupSizesByRatio({ '6XL': 1151, '5XL': 701, '4XL': 496, '3XL': 171, XXL: 10 }, 8);
  // 6XL..3XL are within 8x of the group max (1151/171 = 6.7); XXL (115x) splits off.
  assert.strictEqual(g.length, 2);
  assert.deepStrictEqual(g[0], { '6XL': 1151, '5XL': 701, '4XL': 496, '3XL': 171 });
  assert.deepStrictEqual(g[1], { XXL: 10 });
});

test('splitIntoLots: extreme skew isolates the trivial size, never smears it across lots', () => {
  const lots = splitIntoLots({ '6XL': 1151, '5XL': 701, '4XL': 496, '3XL': 171, XXL: 10 });
  // big sizes -> proportional lots (group 2519 -> 2 lots); XXL -> its own single-size lot.
  const xxlLots = lots.filter((l) => Object.keys(l.sizes).length === 1 && l.sizes.XXL);
  assert.strictEqual(xxlLots.length, 1);
  assert.strictEqual(xxlLots[0].sizes.XXL, 10);
  assert.ok(lots.filter((l) => l.sizes['6XL']).every((l) => !('XXL' in l.sizes)));
  for (const l of lots) assert.ok(l.total <= 1500);
  // per-size totals exactly conserved across all lots
  const tot = {};
  for (const l of lots) for (const [s, q] of Object.entries(l.sizes)) tot[s] = (tot[s] || 0) + q;
  assert.deepStrictEqual(tot, { '6XL': 1151, '5XL': 701, '4XL': 496, '3XL': 171, XXL: 10 });
});

test('splitIntoLots: modest skew (<=8x) stays one proportional group (unchanged behaviour)', () => {
  const lots = splitIntoLots({ M: 1300, L: 900, XL: 400, XXL: 200 }); // 6.5x -> one group, 2 lots
  assert.strictEqual(lots.length, 2);
  assert.deepStrictEqual(lots[0].sizes, { M: 650, L: 450, XL: 200, XXL: 100 });
});

test('splitIntoLots skewAware:false forces a single proportional split', () => {
  const lots = splitIntoLots({ '6XL': 1151, XXL: 10 }, { skewAware: false }); // 1161 -> 1 lot, both sizes
  assert.strictEqual(lots.length, 1);
  assert.deepStrictEqual(lots[0].sizes, { '6XL': 1151, XXL: 10 });
});

test('planCut: lots + per-lot fabric from CAD consumption', () => {
  const plan = planCut(
    { M: 1304, L: 344, XS: 272 }, // total 1920 -> 2 lots
    { consumptionBySize: { M: 1.02, L: 1.05, XS: 0.9 } }
  );
  assert.strictEqual(plan.lotCount, 2);
  assert.strictEqual(plan.totalPieces, 1920);
  for (const lot of plan.lots) {
    assert.ok(lot.total <= 1500);
    // fabric of a lot = sum(size_qty * CAD consumption)
    const expect = lot.sizes.M * 1.02 + lot.sizes.L * 1.05 + lot.sizes.XS * 0.9;
    assert.ok(Math.abs(lot.fabricMeters - expect) < 1e-6);
  }
  assert.strictEqual(plan.fabricComplete, true);
});

test('planCut flags missing CAD sizes and still plans quantities', () => {
  const plan = planCut({ M: 800, XXL: 700 }, { consumptionBySize: { M: 1.02 } }); // no XXL
  assert.strictEqual(plan.fabricComplete, false);
  assert.deepStrictEqual(plan.missingSizes, ['XXL']);
  assert.ok(plan.totalPieces === 1500);
});

test('planCut with no CAD data: fabric null, quantities still planned', () => {
  const plan = planCut({ M: 700, L: 800 }, {});
  assert.ok(plan.lotCount >= 1);
  assert.strictEqual(plan.totalFabricMeters, null);
  assert.strictEqual(plan.fabricComplete, false);
});
