const { test } = require('node:test');
const assert = require('node:assert');
const {
  flagHighAgeingStyles, partitionBlocklist, computeEffective, autoReason,
} = require('../utils/highAgeing.js');

// Per-size cut-rec rows: { style, soh, drr }
const rows = [
  // FAST: 100 stock, 5/day → 20 days cover → NOT flagged
  { style: 'FAST', soh: 60, drr: 3 }, { style: 'FAST', soh: 40, drr: 2 },
  // SLOW: 300 stock, 1/day → 300 days cover → flagged
  { style: 'SLOW', soh: 200, drr: 0.6 }, { style: 'SLOW', soh: 100, drr: 0.4 },
  // DEAD: stock, zero sales → flagged (dead)
  { style: 'DEAD', soh: 150, drr: 0 },
  // EDGE: exactly 90 days (not > 90) → NOT flagged
  { style: 'EDGE', soh: 90, drr: 1 },
  // NOSTOCK: no stock → never flagged
  { style: 'NOSTOCK', soh: 0, drr: 0 },
];

test('flagHighAgeingStyles: flags >90-day cover and dead stock, not fast/edge/no-stock', () => {
  const flagged = flagHighAgeingStyles(rows);
  const names = flagged.map((f) => f.style).sort();
  assert.deepStrictEqual(names, ['DEAD', 'SLOW']);
  const slow = flagged.find((f) => f.style === 'SLOW');
  assert.strictEqual(slow.soh, 300);
  assert.strictEqual(slow.days_of_cover, 300);
  const dead = flagged.find((f) => f.style === 'DEAD');
  assert.strictEqual(dead.dead, true);
  assert.strictEqual(dead.days_of_cover, Infinity);
});

test('flagHighAgeingStyles: sorts worst-first (dead/highest cover first)', () => {
  const flagged = flagHighAgeingStyles(rows);
  assert.strictEqual(flagged[0].style, 'DEAD'); // Infinity sorts first
  assert.strictEqual(flagged[1].style, 'SLOW');
});

test('flagHighAgeingStyles: MIN_SOH floor drops tiny dead remnants', () => {
  // A 4-unit dead remnant is high-ageing by cover but below the 50-unit floor →
  // not worth blocking a re-cut over, so it must NOT be flagged.
  const f = flagHighAgeingStyles([{ style: 'REMNANT', soh: 4, drr: 0 }]);
  assert.deepStrictEqual(f, []);
  // With an explicit low floor it comes back (floor is configurable).
  const f2 = flagHighAgeingStyles([{ style: 'REMNANT', soh: 4, drr: 0 }], 90, 0);
  assert.deepStrictEqual(f2.map((x) => x.style), ['REMNANT']);
});

test('flagHighAgeingStyles: threshold is configurable', () => {
  // At threshold 500, SLOW (300d) drops out; DEAD (∞) stays
  const flagged = flagHighAgeingStyles(rows, 500);
  assert.deepStrictEqual(flagged.map((f) => f.style), ['DEAD']);
});

test('flagHighAgeingStyles: aggregates sizes to style level (case/space-normalized)', () => {
  const f = flagHighAgeingStyles([
    { style: ' slow ', soh: 200, drr: 0.6 }, { style: 'SLOW', soh: 100, drr: 0.4 },
  ]);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].style, 'SLOW');
  assert.strictEqual(f[0].soh, 300);
});

test('partitionBlocklist: splits manual_block and allow', () => {
  const { manual, allow } = partitionBlocklist([
    { style: 'A', mode: 'manual_block' }, { style: 'b', mode: 'allow' },
    { style: 'C', mode: 'manual_block' },
  ]);
  assert.deepStrictEqual([...manual.keys()].sort(), ['A', 'C']);
  assert.deepStrictEqual([...allow.keys()], ['B']);
});

test('computeEffective: (auto ∪ manual) − allow', () => {
  const flagged = flagHighAgeingStyles(rows); // DEAD, SLOW
  const eff = computeEffective(flagged, [
    { style: 'SLOW', mode: 'allow' },          // exempt an auto-flagged one
    { style: 'MANUAL1', mode: 'manual_block', reason: 'overstock' },
    { style: 'DEAD', mode: 'manual_block' },    // manual on an already-auto style (dedup)
  ]);
  const styles = [...eff.keys()].sort();
  assert.deepStrictEqual(styles, ['DEAD', 'MANUAL1']); // SLOW allowed out; DEAD stays; MANUAL1 in
  assert.strictEqual(eff.get('MANUAL1').source, 'Manual');
  assert.match(eff.get('MANUAL1').reason, /overstock/);
});

test('computeEffective: allow beats manual_block too (allow always wins)', () => {
  const eff = computeEffective([], [
    { style: 'X', mode: 'manual_block' }, { style: 'X', mode: 'allow' },
  ]);
  assert.strictEqual(eff.has('X'), false);
});

test('autoReason: dead vs days-of-cover wording', () => {
  assert.match(autoReason({ dead: true }), /no recent sales/);
  assert.match(autoReason({ dead: false, days_of_cover: 240.4 }), /240 days of cover/);
});
