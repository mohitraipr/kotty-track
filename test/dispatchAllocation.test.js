const { test } = require('node:test');
const assert = require('node:assert');
const { aggregateLotSizes, allocateAcrossBatches } = require('../utils/dispatchAllocation.js');

const batches = [
  { finishing_data_id: 10, sizes: [
    { size_label: 'M', produced: 100, dispatched: 40, available: 60 },
    { size_label: 'L', produced: 50, dispatched: 50, available: 0 },
  ] },
  { finishing_data_id: 11, sizes: [
    { size_label: 'm', produced: 30, dispatched: 0, available: 30 },
    { size_label: 'XL', produced: 20, dispatched: 5, available: 15 },
  ] },
];

test('aggregateLotSizes: merges duplicate labels across batches, case-insensitively', () => {
  const agg = aggregateLotSizes(batches);
  const m = agg.find((s) => s.size_label.toUpperCase() === 'M');
  assert.deepStrictEqual(m, { size_label: 'M', produced: 130, dispatched: 40, available: 90 });
  assert.strictEqual(agg.length, 3); // M, L, XL
  const l = agg.find((s) => s.size_label === 'L');
  assert.strictEqual(l.available, 0);
});

test('allocateAcrossBatches: FIFO — drains the oldest batch before the next', () => {
  const { rows, error } = allocateAcrossBatches([{ size_label: 'M', pieces: 75 }], batches);
  assert.strictEqual(error, undefined);
  assert.deepStrictEqual(rows, [
    { finishing_data_id: 10, size_label: 'M', pieces: 60 },
    { finishing_data_id: 11, size_label: 'm', pieces: 15 },
  ]);
});

test('allocateAcrossBatches: exact fit in one batch produces one row', () => {
  const { rows } = allocateAcrossBatches([{ size_label: 'XL', pieces: 15 }], batches);
  assert.deepStrictEqual(rows, [{ finishing_data_id: 11, size_label: 'XL', pieces: 15 }]);
});

test('allocateAcrossBatches: over-ask fails with the lot-level available count', () => {
  const { error } = allocateAcrossBatches([{ size_label: 'M', pieces: 91 }], batches);
  assert.match(error, /only 90 pieces available/);
});

test('allocateAcrossBatches: fully-dispatched size fails clearly', () => {
  const { error } = allocateAcrossBatches([{ size_label: 'L', pieces: 1 }], batches);
  assert.match(error, /nothing available/);
});

test('allocateAcrossBatches: unknown size fails', () => {
  const { error } = allocateAcrossBatches([{ size_label: 'XXL', pieces: 1 }], batches);
  assert.match(error, /nothing available/);
});

test('allocateAcrossBatches: empty / zero / negative requests are rejected', () => {
  assert.match(allocateAcrossBatches([], batches).error, /No positive/);
  assert.match(allocateAcrossBatches([{ size_label: 'M', pieces: 0 }], batches).error, /No positive/);
  assert.match(allocateAcrossBatches([{ size_label: 'M', pieces: -5 }], batches).error, /No positive/);
});

test('allocateAcrossBatches: duplicate size in the request is rejected, not merged', () => {
  const { error } = allocateAcrossBatches(
    [{ size_label: 'M', pieces: 10 }, { size_label: 'm', pieces: 10 }], batches);
  assert.match(error, /more than once/);
});

test('allocateAcrossBatches: multi-size request allocates each independently', () => {
  const { rows } = allocateAcrossBatches(
    [{ size_label: 'M', pieces: 61 }, { size_label: 'XL', pieces: 10 }], batches);
  assert.deepStrictEqual(rows, [
    { finishing_data_id: 10, size_label: 'M', pieces: 60 },
    { finishing_data_id: 11, size_label: 'm', pieces: 1 },
    { finishing_data_id: 11, size_label: 'XL', pieces: 10 },
  ]);
});
