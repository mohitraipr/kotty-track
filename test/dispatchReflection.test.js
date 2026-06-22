const { test } = require('node:test');
const assert = require('node:assert');
const { assessReflection, addDays, daysBetween } = require('../utils/dispatchReflection.js');

const P = { graceDays: 3, deadlineDays: 7, tolerancePct: 15 };

test('addDays / daysBetween do UTC calendar math', () => {
  assert.strictEqual(addDays('2026-06-20', 3), '2026-06-23');
  assert.strictEqual(daysBetween('2026-06-20', '2026-06-23'), 3);
});

test('reflected: SOH rises by ~dispatched within window', () => {
  const v = assessReflection({
    sohBefore: 10,
    dispatches: [{ date: '2026-06-01', qty: 20 }, { date: '2026-06-02', qty: 30 }, { date: '2026-06-03', qty: 20 }],
    sales: [],
    snapshots: [{ date: '2026-06-03', qty: 10 }, { date: '2026-06-04', qty: 80 }],
    today: '2026-06-10', ...P,
  });
  assert.strictEqual(v.status, 'reflected');
  assert.strictEqual(v.gap_qty, 0);
  assert.strictEqual(v.reflected_date, '2026-06-04');
  assert.strictEqual(v.lag_days, 1); // 06-04 minus last dispatch 06-03
});

test('sales-masked: net SOH dips but recovers to expected → still reflected', () => {
  const v = assessReflection({
    sohBefore: 5,
    dispatches: [{ date: '2026-06-01', qty: 30 }],
    sales: [{ date: '2026-06-01', qty: 35 }],
    // expected on 06-02 = 5 + 30 - 35 = 0; actual 0 → reflected
    snapshots: [{ date: '2026-06-01', qty: 0 }, { date: '2026-06-02', qty: 0 }],
    today: '2026-06-10', ...P,
  });
  assert.strictEqual(v.status, 'reflected');
});

test('not_reflected: SOH flat past deadline', () => {
  const v = assessReflection({
    sohBefore: 10,
    dispatches: [{ date: '2026-06-01', qty: 50 }],
    sales: [],
    snapshots: [{ date: '2026-06-01', qty: 10 }, { date: '2026-06-09', qty: 10 }],
    today: '2026-06-15', ...P, // deadline = 06-08
  });
  assert.strictEqual(v.status, 'not_reflected');
  assert.strictEqual(v.gap_qty, 50);
});

test('pending: dispatch today, within grace/deadline', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-20', qty: 40 }],
    sales: [],
    snapshots: [{ date: '2026-06-20', qty: 0 }],
    today: '2026-06-21', ...P,
  });
  assert.strictEqual(v.status, 'pending');
});

test('partial: about half showed up past deadline', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-01', qty: 100 }],
    sales: [],
    snapshots: [{ date: '2026-06-01', qty: 0 }, { date: '2026-06-09', qty: 50 }],
    today: '2026-06-15', ...P, // deadline 06-08; f=0.5 → partial
  });
  assert.strictEqual(v.status, 'partial');
  assert.strictEqual(v.reflected_qty, 50);
  assert.strictEqual(v.gap_qty, 50);
});

test('no dispatches → reflected/no-op verdict', () => {
  const v = assessReflection({ sohBefore: 0, dispatches: [], sales: [], snapshots: [], today: '2026-06-10', ...P });
  assert.strictEqual(v.status, 'reflected');
  assert.strictEqual(v.dispatched_qty, 0);
});

test('late branch is sales-adjusted: heavy sales explain low SOH → reflected', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-01', qty: 100 }],
    sales: [{ date: '2026-06-05', qty: 90 }],
    // expected at 06-09 = 0 + 100 - 90 = 10; actual 10 → caught up despite low SOH
    snapshots: [{ date: '2026-06-01', qty: 0 }, { date: '2026-06-09', qty: 10 }],
    today: '2026-06-15', ...P,
  });
  assert.strictEqual(v.status, 'reflected');
  assert.strictEqual(v.gap_qty, 0);
});

test('late branch (partial): last snapshot precedes the final batch → not full reflection', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-01', qty: 60 }, { date: '2026-06-07', qty: 40 }],
    sales: [],
    snapshots: [{ date: '2026-06-04', qty: 30 }], // before the 2nd batch → main loop can't confirm full reflection
    today: '2026-06-20', ...P, // deadline = 06-07 + 7 = 06-14, already past
  });
  assert.strictEqual(v.status, 'partial');
  assert.strictEqual(v.reflected_qty, 30);
  assert.strictEqual(v.gap_qty, 70);
});

test('late branch (not_reflected): almost nothing arrived by deadline', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-01', qty: 60 }, { date: '2026-06-07', qty: 40 }],
    sales: [],
    snapshots: [{ date: '2026-06-04', qty: 5 }],
    today: '2026-06-20', ...P,
  });
  assert.strictEqual(v.status, 'not_reflected');
  assert.strictEqual(v.gap_qty, 95);
});

const { reconcileDispatchReflection } = require('../utils/dispatchReflection.js');

function ymd(d) { return d; }
function fakePool(data) {
  return {
    upserts: [],
    async query(sql, params) {
      if (/FROM finishing_dispatches/.test(sql) && /GROUP BY/.test(sql)) return [data.dispatchGroups || []];
      if (/FROM pm_sku_resolution/.test(sql)) return [data.resolution || []];
      if (/FROM ee_suborders/.test(sql)) return [data.canon || []];
      if (/MAX\(snapshot_date\)/.test(sql)) return [[{ qty: data.sohBefore != null ? data.sohBefore : null }]];
      if (/FROM ee_inventory_daily_snapshot/.test(sql)) return [data.snapshots || []];
      if (/FROM ee_sales_daily/.test(sql)) return [data.sales || []];
      if (/INSERT INTO pm_dispatch_reflection/.test(sql)) { this.upserts.push(params); return [{ affectedRows: 1 }]; }
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('reconcileDispatchReflection: resolves, assesses, and upserts a reflected lot', async () => {
  const pool = fakePool({
    dispatchGroups: [{ lot_no: 'A1', size_label: 'L', dispatched_qty: 50, first_dispatch_date: '2026-06-01', last_dispatch_date: '2026-06-02', batch_count: 2, style: 'KTTTOP374' }],
    resolution: [{ cl_sku: 'KTTTOP374', size_label: 'L', size_sku: 'KTTTOP374L' }],
    canon: [{ sku: 'KTTTOP374L' }],
    sohBefore: 0,
    snapshots: [{ date: '2026-06-03', qty: 50 }],
    sales: [],
  });
  const r = await reconcileDispatchReflection(pool, { today: '2026-06-10' });
  assert.strictEqual(r.processed, 1);
  assert.strictEqual(r.reflected, 1);
  assert.strictEqual(pool.upserts.length, 1);
});

test('reconcileDispatchReflection: unresolved size_sku → pending/unresolved, still upserted', async () => {
  const pool = fakePool({
    dispatchGroups: [{ lot_no: 'B2', size_label: 'XL', dispatched_qty: 20, first_dispatch_date: '2026-06-01', last_dispatch_date: '2026-06-01', batch_count: 1, style: 'WEIRD' }],
    resolution: [], canon: [],
  });
  const r = await reconcileDispatchReflection(pool, { today: '2026-06-10' });
  assert.strictEqual(r.unresolved, 1);
  assert.strictEqual(pool.upserts.length, 1);
});
