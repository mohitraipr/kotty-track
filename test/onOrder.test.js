// test/onOrder.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSizeSku, buildOnOrderMap, computeOnOrderBySku } = require('../utils/onOrder.js');

test('resolveSizeSku: prefers pm_sku_resolution map', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+LABEL against canon set', () => {
  const canon = new Set(['KTTTOP374L']);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', new Map(), canon), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+_+LABEL for numeric sizes', () => {
  const canon = new Set(['KTTMENSJEANS381_28']);
  assert.strictEqual(resolveSizeSku('KTTMENSJEANS381', '28', new Map(), canon), 'KTTMENSJEANS381_28');
});

test('resolveSizeSku: case-insensitive on inputs', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('ktttop374', 'l', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: returns null when nothing matches', () => {
  assert.strictEqual(resolveSizeSku('NOPE', 'XL', new Map(), new Set()), null);
});

const RMAP = new Map([
  ['KTTTOP374||M', 'KTTTOP374M'],
  ['KTTTOP374||L', 'KTTTOP374L'],
]);
const CANON = new Set(['KTTTOP374M', 'KTTTOP374L']);

test('buildOnOrderMap: nets dispatched pieces off the cut qty', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 80 }],
    dispatchedMap: new Map([['A1||M', 20]]),
    manualRows: [],
    resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374M'), 60);
  assert.strictEqual(res.unresolvedLots, 0);
});

test('buildOnOrderMap: fully dispatched lot-size contributes 0 and is omitted', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 50 }],
    dispatchedMap: new Map([['A1||M', 50]]),
    manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.has('KTTTOP374M'), false);
});

test('buildOnOrderMap: sums multiple lots into the same size-SKU', () => {
  const res = buildOnOrderMap({
    inFlightRows: [
      { lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 30 },
      { lot_no: 'A2', style: 'KTTTOP374', size_label: 'M', cut_pieces: 40 },
    ],
    dispatchedMap: new Map(), manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374M'), 70);
});

test('buildOnOrderMap: unresolved size tallied by distinct lot, not dropped silently', () => {
  const res = buildOnOrderMap({
    inFlightRows: [
      { lot_no: 'A1', style: 'WEIRDSTYLE', size_label: 'M', cut_pieces: 25 },
      { lot_no: 'A1', style: 'WEIRDSTYLE', size_label: 'L', cut_pieces: 15 },
    ],
    dispatchedMap: new Map(), manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.size, 0);
  assert.strictEqual(res.unresolvedLots, 1);   // one distinct lot_no
  assert.strictEqual(res.unresolvedPieces, 40);
});

test('buildOnOrderMap: unions manual rows on top of real lots', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'L', cut_pieces: 10 }],
    dispatchedMap: new Map(),
    manualRows: [{ sku: 'KTTTOP374L', qty: 5 }, { sku: 'KTTTOP374M', qty: 7 }],
    resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374L'), 15); // 10 real + 5 manual
  assert.strictEqual(res.map.get('KTTTOP374M'), 7);
});

// Fake pool dispatching by SQL shape (house pattern, cf. test/approvalCorrection.test.js).
function fakePool(data) {
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM pm_open_cutting_lots/.test(sql)) return [data.manual || []];
      if (/FROM cutting_lots/.test(sql)) return [data.inflight || []];
      if (/FROM finishing_dispatches/.test(sql)) return [data.dispatched || []];
      if (/FROM pm_sku_resolution/.test(sql)) return [data.resolution || []];
      if (/FROM ee_suborders/.test(sql)) return [data.canon || []];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('computeOnOrderBySku: flag OFF uses ONLY the manual table', async () => {
  delete process.env.PM_CLOSED_LOOP;
  const pool = fakePool({ manual: [{ sku: 'KTTTOP374L', qty: 12 }] });
  const res = await computeOnOrderBySku(pool);
  assert.strictEqual(res.onOrder.get('KTTTOP374L'), 12);
  assert.deepStrictEqual(res.unresolved, { lots: 0, pieces: 0 });
  // Only the manual query should have run.
  assert.strictEqual(pool.queries.some((q) => /FROM cutting_lots/.test(q)), false);
});

test('computeOnOrderBySku: flag ON nets real lots + unions manual + tallies unresolved', async () => {
  process.env.PM_CLOSED_LOOP = '1';
  const pool = fakePool({
    manual: [{ sku: 'KTTTOP374M', qty: 5 }],
    inflight: [
      { lot_no: 'A1', style: 'KTTTOP374', size_label: 'L', cut_pieces: 80 },
      { lot_no: 'B2', style: 'WEIRDSTYLE', size_label: 'XL', cut_pieces: 30 },
    ],
    dispatched: [{ lot_no: 'A1', size_label: 'L', qty: 20 }],
    resolution: [{ cl_sku: 'KTTTOP374', size_label: 'L', size_sku: 'KTTTOP374L' }],
    canon: [{ sku: 'KTTTOP374L' }],
  });
  const res = await computeOnOrderBySku(pool);
  assert.strictEqual(res.onOrder.get('KTTTOP374L'), 60); // 80 - 20 dispatched
  assert.strictEqual(res.onOrder.get('KTTTOP374M'), 5);  // manual
  assert.deepStrictEqual(res.unresolved, { lots: 1, pieces: 30 }); // WEIRDSTYLE/B2
  assert.strictEqual(pool.queries.length, 5); // 1 manual + 4 in-flight (cutting_lots, finishing_dispatches, pm_sku_resolution, ee_suborders)
  delete process.env.PM_CLOSED_LOOP;
});
