const { test } = require('node:test');
const assert = require('node:assert');
const { trendBucketKey, buildTrendBuckets } = require('../utils/styleTrend.js');

test('trendBucketKey: daily returns the date', () => {
  assert.strictEqual(trendBucketKey('2026-06-17', 'daily'), '2026-06-17');
});
test('trendBucketKey: monthly returns YYYY-MM', () => {
  assert.strictEqual(trendBucketKey('2026-06-17', 'monthly'), '2026-06');
});
test('trendBucketKey: weekly returns the Monday of that week', () => {
  // 2026-06-15 is Monday; 17 (Wed) and 21 (Sun) fall in the same week; 22 is the next Monday.
  assert.strictEqual(trendBucketKey('2026-06-17', 'weekly'), '2026-06-15');
  assert.strictEqual(trendBucketKey('2026-06-21', 'weekly'), '2026-06-15');
  assert.strictEqual(trendBucketKey('2026-06-22', 'weekly'), '2026-06-22');
});

test('buildTrendBuckets: sales summed per bucket, inventory last-per-bucket (monthly)', () => {
  const r = buildTrendBuckets({
    salesDaily: [
      { date: '2026-05-30', qty: 10 }, { date: '2026-06-01', qty: 5 }, { date: '2026-06-15', qty: 7 },
    ],
    invDaily: [
      { date: '2026-05-30', qty: 100 }, { date: '2026-06-01', qty: 90 }, { date: '2026-06-15', qty: 80 },
    ],
    granularity: 'monthly',
  });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-05', qty: 10 }, { bucket: '2026-06', qty: 12 }]);
  // inventory = last value in each month (a stock level, not a sum)
  assert.deepStrictEqual(r.inventory, [{ bucket: '2026-05', qty: 100 }, { bucket: '2026-06', qty: 80 }]);
});

test('buildTrendBuckets: daily passes through, chronological', () => {
  const r = buildTrendBuckets({
    salesDaily: [{ date: '2026-06-02', qty: 3 }, { date: '2026-06-01', qty: 1 }],
    invDaily: [], granularity: 'daily',
  });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-06-01', qty: 1 }, { bucket: '2026-06-02', qty: 3 }]);
  assert.deepStrictEqual(r.inventory, []);
});

test('buildTrendBuckets: empty inputs → empty arrays', () => {
  const r = buildTrendBuckets({ salesDaily: [], invDaily: [], granularity: 'weekly' });
  assert.deepStrictEqual(r, { sales: [], inventory: [] });
});

const { computeStyleTrend } = require('../utils/styleTrend.js');

function fakePool(data) {
  return {
    async query(sql) {
      if (/FROM ee_sales_daily[\s\S]*UNION/.test(sql) || /SELECT DISTINCT sku FROM \(/.test(sql)) return [data.skuRows || []];
      if (/FROM ee_sales_daily/.test(sql)) return [data.salesRows || []];
      if (/FROM ee_inventory_daily_snapshot/.test(sql)) return [data.invRows || []];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('computeStyleTrend: resolves SKUs exactly via deriveStyle and buckets', async () => {
  const pool = fakePool({
    // KTTTOP374L belongs to style KTTTOP374; KTTTOP37XL belongs to KTTTOP37 (sibling) — must be excluded
    skuRows: [{ sku: 'KTTTOP374L' }, { sku: 'KTTTOP374M' }, { sku: 'KTTTOP37XL' }],
    salesRows: [{ date: '2026-06-01', qty: 4 }, { date: '2026-06-02', qty: 6 }],
    invRows: [{ date: '2026-06-01', qty: 50 }, { date: '2026-06-02', qty: 45 }],
  });
  const r = await computeStyleTrend(pool, { style: 'KTTTOP374', days: 30, granularity: 'daily' });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-06-01', qty: 4 }, { bucket: '2026-06-02', qty: 6 }]);
  assert.deepStrictEqual(r.inventory, [{ bucket: '2026-06-01', qty: 50 }, { bucket: '2026-06-02', qty: 45 }]);
});

test('computeStyleTrend: no matching SKUs → empty', async () => {
  const pool = fakePool({ skuRows: [{ sku: 'KTTTOP37XL' }] }); // only the sibling style
  const r = await computeStyleTrend(pool, { style: 'KTTTOP374', days: 30, granularity: 'daily' });
  assert.deepStrictEqual(r, { sales: [], inventory: [] });
});
