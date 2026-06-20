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
