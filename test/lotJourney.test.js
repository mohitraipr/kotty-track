const { test } = require('node:test');
const assert = require('node:assert');
const {
  orderedStages, deriveStageStatus, dispatchSummary, currentStage,
} = require('../utils/lotJourney.js');

const DAY = 86400000;

test('orderedStages: denim runs the full chain, hosiery the short chain', () => {
  assert.deepStrictEqual(orderedStages('denim'),
    ['cutting', 'stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing']);
  assert.deepStrictEqual(orderedStages('hosiery'), ['cutting', 'stitching', 'finishing']);
});

test('orderedStages: unknown/null flow defaults to the hosiery chain', () => {
  assert.deepStrictEqual(orderedStages(null), ['cutting', 'stitching', 'finishing']);
  assert.deepStrictEqual(orderedStages('weird'), ['cutting', 'stitching', 'finishing']);
});

test('deriveStageStatus: not started when never entered', () => {
  const r = deriveStageStatus({ entered: null, exited: null }, 0);
  assert.strictEqual(r.status, 'not_started');
  assert.strictEqual(r.days, null);
});

test('deriveStageStatus: in progress when entered but not exited', () => {
  const entered = new Date('2026-06-10T00:00:00Z');
  const now = entered.getTime() + 3 * DAY;
  const r = deriveStageStatus({ entered, exited: null }, now);
  assert.strictEqual(r.status, 'in_progress');
  assert.strictEqual(r.days, 3);
});

test('deriveStageStatus: done when entered and exited, days = span', () => {
  const entered = new Date('2026-06-10T00:00:00Z');
  const exited = new Date('2026-06-15T00:00:00Z');
  const r = deriveStageStatus({ entered, exited }, Date.now());
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(r.days, 5);
});

test('dispatchSummary: totals, remaining, and per-size breakdown', () => {
  const r = dispatchSummary({ M: 200, L: 100 }, { M: 120, L: 100 });
  assert.strictEqual(r.totalFinished, 300);
  assert.strictEqual(r.totalDispatched, 220);
  assert.strictEqual(r.remaining, 80);
  assert.strictEqual(r.complete, false);
  assert.deepStrictEqual(r.bySize.M, { finished: 200, dispatched: 120, remaining: 80 });
  assert.deepStrictEqual(r.bySize.L, { finished: 100, dispatched: 100, remaining: 0 });
});

test('dispatchSummary: fully dispatched is complete', () => {
  const r = dispatchSummary({ M: 50 }, { M: 50 });
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.complete, true);
});

test('dispatchSummary: nothing finished is not complete', () => {
  const r = dispatchSummary({}, {});
  assert.strictEqual(r.totalFinished, 0);
  assert.strictEqual(r.complete, false);
});

test('currentStage: first in-progress or not-started stage; Done when all finished', () => {
  const tl1 = [
    { stage: 'cutting', status: 'done' },
    { stage: 'stitching', status: 'in_progress' },
    { stage: 'finishing', status: 'not_started' },
  ];
  assert.strictEqual(currentStage(tl1), 'stitching');
  const tl2 = [
    { stage: 'cutting', status: 'done' },
    { stage: 'stitching', status: 'done' },
    { stage: 'finishing', status: 'done' },
  ];
  assert.strictEqual(currentStage(tl2), 'Done');
});
