const { test } = require('node:test');
const assert = require('node:assert');
const {
  orderedStages, deriveStageStatus, dispatchSummary, currentStage, mergeActivity,
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

test('mergeActivity: merges all sources into one ascending feed', () => {
  const feed = mergeActivity({
    cutting: { created_at: '2026-06-01T10:00:00Z', by: 'cutter1', total_pieces: 300, note: 'first cut' },
    stageEvents: {
      stitching: [
        { event_type: 'approve', pieces: 300, remark: '', created_at: '2026-06-03T09:00:00Z', username: 'stitchA' },
        { event_type: 'complete', pieces: 290, remark: 'ok', created_at: '2026-06-08T17:00:00Z', username: 'stitchA' },
      ],
      finishing: [
        { event_type: 'reject', pieces: 5, remark: 'stains', created_at: '2026-06-12T11:00:00Z', username: 'finB' },
      ],
    },
    dispatches: [
      { destination: 'Warehouse', quantity: 100, size_label: 'M', created_at: '2026-06-14T08:00:00Z' },
    ],
    audits: [
      { action: 'qty_edit', detail: '{"size":"L","from":50,"to":40}', performed_by_name: 'op1', created_at: '2026-06-05T12:00:00Z' },
    ],
  });
  assert.deepStrictEqual(feed.map((f) => f.kind),
    ['created', 'approve', 'admin', 'complete', 'reject', 'dispatch']);
  assert.deepStrictEqual(feed.map((f) => f.stage),
    ['cutting', 'stitching', 'admin', 'stitching', 'finishing', 'dispatch']);
  assert.strictEqual(feed[0].pieces, 300);
  assert.strictEqual(feed[0].by, 'cutter1');
  assert.strictEqual(feed[2].label, 'Qty edit');
  assert.strictEqual(feed[2].note, 'size: L, from: 50, to: 40');
  assert.strictEqual(feed[4].note, 'stains');
  assert.strictEqual(feed[5].note, '→ Warehouse · size M');
  assert.strictEqual(feed[5].pieces, 100);
});

test('mergeActivity: empty/missing sources produce an empty feed, not a crash', () => {
  assert.deepStrictEqual(mergeActivity(), []);
  assert.deepStrictEqual(mergeActivity({ cutting: null, stageEvents: {}, dispatches: [], audits: [] }), []);
  // rows missing created_at are skipped rather than sorted to a bogus position
  const feed = mergeActivity({ stageEvents: { stitching: [{ event_type: 'approve', pieces: 10 }] } });
  assert.deepStrictEqual(feed, []);
});

test('mergeActivity: audit-only lot still gets a feed; object detail is summarized', () => {
  const feed = mergeActivity({
    audits: [{ action: 'flow_change', detail: { from: 'hosiery', to: 'denim' }, performed_by_name: 'op2', created_at: '2026-06-02T10:00:00Z' }],
  });
  assert.strictEqual(feed.length, 1);
  assert.strictEqual(feed[0].label, 'Flow change');
  assert.strictEqual(feed[0].note, 'from: hosiery, to: denim');
  assert.strictEqual(feed[0].by, 'op2');
});

test('mergeActivity: equal timestamps keep source order (stable sort)', () => {
  const t = '2026-06-10T10:00:00Z';
  const feed = mergeActivity({
    stageEvents: {
      stitching: [
        { event_type: 'approve', pieces: 1, created_at: t, username: 'a' },
        { event_type: 'complete', pieces: 1, created_at: t, username: 'a' },
      ],
    },
    dispatches: [{ destination: 'Warehouse', quantity: 1, size_label: 'S', created_at: t }],
  });
  assert.deepStrictEqual(feed.map((f) => f.kind), ['approve', 'complete', 'dispatch']);
});

test('mergeActivity: unknown admin action and unparseable detail pass through raw', () => {
  const feed = mergeActivity({
    audits: [{ action: 'something_new', detail: 'free text', performed_by_name: null, created_at: '2026-06-02T10:00:00Z' }],
  });
  assert.strictEqual(feed[0].label, 'something_new');
  assert.strictEqual(feed[0].note, 'free text');
  assert.strictEqual(feed[0].by, null);
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
