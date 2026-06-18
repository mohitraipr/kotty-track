const { test } = require('node:test');
const assert = require('node:assert');
const {
  lotMetersPerPiece,
  isCleanLot,
  aggregateStyleConsumption,
  varianceVsStandard,
} = require('../utils/styleConsumption.js');

test('lotMetersPerPiece = table_length * layers / total_pieces', () => {
  // 5.25 m marker, 166 layers, 913 pieces -> ~0.955 m/piece (real KTTWOMENSPANT261 lot)
  const mpp = lotMetersPerPiece({ table_length: 5.25, layers: 166, total_pieces: 913 });
  assert.ok(Math.abs(mpp - 0.9545) < 0.001, `expected ~0.955, got ${mpp}`);
});

test('lotMetersPerPiece returns null on missing/zero inputs', () => {
  assert.strictEqual(lotMetersPerPiece({ table_length: 5.25, layers: 0, total_pieces: 900 }), null);
  assert.strictEqual(lotMetersPerPiece({ table_length: null, layers: 10, total_pieces: 900 }), null);
  assert.strictEqual(lotMetersPerPiece({ table_length: 5, layers: 10, total_pieces: 0 }), null);
});

test('isCleanLot accepts a normal lot', () => {
  assert.strictEqual(isCleanLot({ table_length: 5.25, layers: 166, total_pieces: 913 }), true);
});

test('isCleanLot rejects garbage table_length (data-entry error)', () => {
  // a real outlier seen in prod: table_length 3914
  assert.strictEqual(isCleanLot({ table_length: 3914, layers: 5, total_pieces: 100 }), false);
  // sub-meter marker is implausible
  assert.strictEqual(isCleanLot({ table_length: 0.2, layers: 5, total_pieces: 100 }), false);
});

test('isCleanLot rejects implausible meters-per-piece (too low / too high)', () => {
  // 6 m * 1 layer / 1000 pieces = 0.006 m/pc -> impossible
  assert.strictEqual(isCleanLot({ table_length: 6, layers: 1, total_pieces: 1000 }), false);
  // 6 m * 100 layers / 50 pieces = 12 m/pc -> impossible
  assert.strictEqual(isCleanLot({ table_length: 6, layers: 100, total_pieces: 50 }), false);
});

test('isCleanLot rejects a lot with no usable consumption', () => {
  assert.strictEqual(isCleanLot({ table_length: null, layers: 10, total_pieces: 900 }), false);
});

test('aggregateStyleConsumption groups by style and uses the median of clean lots', () => {
  const rows = [
    { sku: 'KTTWOMENSPANT261', table_length: 5.25, layers: 100, total_pieces: 550 }, // 0.954
    { sku: 'KTTWOMENSPANT261', table_length: 5.25, layers: 166, total_pieces: 913 }, // 0.954
    { sku: 'KTTWOMENSPANT261', table_length: 6, layers: 100, total_pieces: 500 },    // 1.20
    { sku: 'KTTLADIESJEANS823', table_length: 6, layers: 100, total_pieces: 600 },   // 1.00
  ];
  const out = aggregateStyleConsumption(rows);
  const pant = out.find((r) => r.style === 'KTTWOMENSPANT261');
  const jean = out.find((r) => r.style === 'KTTLADIESJEANS823');
  assert.strictEqual(pant.cleanLots, 3);
  assert.ok(Math.abs(pant.realMetersPerPiece - 0.954) < 0.01, `median ~0.954, got ${pant.realMetersPerPiece}`);
  assert.ok(Math.abs(jean.realMetersPerPiece - 1.0) < 0.001);
});

test('aggregateStyleConsumption excludes outlier lots from the figure', () => {
  const rows = [
    { sku: 'S1', table_length: 5, layers: 100, total_pieces: 500 },   // 1.0 clean
    { sku: 'S1', table_length: 3914, layers: 5, total_pieces: 100 },  // garbage, excluded
  ];
  const out = aggregateStyleConsumption(rows);
  const s1 = out.find((r) => r.style === 'S1');
  assert.strictEqual(s1.totalLots, 2);
  assert.strictEqual(s1.cleanLots, 1);
  assert.ok(Math.abs(s1.realMetersPerPiece - 1.0) < 0.001);
});

test('aggregateStyleConsumption returns null consumption when a style has no clean lots', () => {
  const rows = [{ sku: 'BAD', table_length: 3914, layers: 5, total_pieces: 100 }];
  const out = aggregateStyleConsumption(rows);
  const bad = out.find((r) => r.style === 'BAD');
  assert.strictEqual(bad.realMetersPerPiece, null);
  assert.strictEqual(bad.cleanLots, 0);
  assert.strictEqual(bad.totalLots, 1);
});

test('varianceVsStandard: real below standard = under (good), positive when over', () => {
  // real 0.955 vs standard 1.01 -> ~ -5.4% (consuming LESS than standard)
  const v = varianceVsStandard(0.955, 1.01);
  assert.ok(Math.abs(v.variancePct - -5.45) < 0.1, `expected ~-5.45, got ${v.variancePct}`);
  assert.strictEqual(v.status, 'under');

  // real 1.10 vs standard 1.00 -> +10% over standard (wasting fabric)
  const over = varianceVsStandard(1.1, 1.0);
  assert.ok(Math.abs(over.variancePct - 10) < 0.001);
  assert.strictEqual(over.status, 'over');
});

test('varianceVsStandard: within tolerance is on_target', () => {
  const v = varianceVsStandard(1.01, 1.0); // +1%, inside default 3% band
  assert.strictEqual(v.status, 'on_target');
});

test('varianceVsStandard: missing real or standard yields unknown status, null pct', () => {
  assert.deepStrictEqual(varianceVsStandard(null, 1.0), { variancePct: null, status: 'unknown' });
  assert.deepStrictEqual(varianceVsStandard(1.0, null), { variancePct: null, status: 'unknown' });
  assert.deepStrictEqual(varianceVsStandard(1.0, 0), { variancePct: null, status: 'unknown' });
});
