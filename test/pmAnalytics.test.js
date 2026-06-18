const { test } = require('node:test');
const assert = require('node:assert');
const {
  cutPrioritySummary, fabricNeededByType, wipByStage,
} = require('../utils/pmAnalytics.js');

test('cutPrioritySummary counts red/amber styles and totals suggested pieces', () => {
  const aggs = [
    { trigger: 'red', suggested_cut_qty: 1200 },
    { trigger: 'amber', suggested_cut_qty: 300 },
    { trigger: 'red', suggested_cut_qty: 0 },
    { trigger: 'green', suggested_cut_qty: 0 },
  ];
  const s = cutPrioritySummary(aggs);
  assert.strictEqual(s.red, 2);
  assert.strictEqual(s.amber, 1);
  assert.strictEqual(s.totalSuggested, 1500);
  assert.strictEqual(s.stylesNeedingCut, 2); // only the two with suggested > 0
});

test('fabricNeededByType prices suggested cuts via CAD, grouped by fabric type', () => {
  const recs = [
    { style: 'A', size: 'M', suggested_cut_qty: 100 },
    { style: 'A', size: 'L', suggested_cut_qty: 50 },
    { style: 'B', size: 'S', suggested_cut_qty: 200 }, // no CAD -> uncovered
  ];
  const cons = [
    { style: 'A', size_label: 'M', consumption_per_piece: 1.0, fabric_type: 'Denim' },
    { style: 'A', size_label: 'L', consumption_per_piece: 1.2, fabric_type: 'Denim' },
  ];
  const r = fabricNeededByType(recs, cons);
  assert.strictEqual(r.byType.length, 1);
  assert.strictEqual(r.byType[0].fabric_type, 'Denim');
  assert.ok(Math.abs(r.byType[0].meters - (100 * 1.0 + 50 * 1.2)) < 1e-9); // 160
  assert.strictEqual(r.byType[0].pieces, 150);
  assert.strictEqual(r.coveredPieces, 150);
  assert.strictEqual(r.uncoveredPieces, 200);
  assert.ok(Math.abs(r.totalMeters - 160) < 1e-9);
});

test('fabricNeededByType ignores zero/negative suggestions', () => {
  const r = fabricNeededByType(
    [{ style: 'A', size: 'M', suggested_cut_qty: 0 }],
    [{ style: 'A', size_label: 'M', consumption_per_piece: 1, fabric_type: 'X' }]
  );
  assert.strictEqual(r.totalMeters, 0);
  assert.strictEqual(r.coveredPieces, 0);
});

test('wipByStage computes in-hand pieces per stage (approved - completed - inline rejected)', () => {
  const rows = [
    { stage: 'stitching', approved: 1000, completed: 600, inline_rejected: 50 },
    { stage: 'finishing', approved: 400, completed: 400, inline_rejected: 0 },
  ];
  const w = wipByStage(rows);
  assert.strictEqual(w.byStage.stitching, 350);
  assert.strictEqual(w.byStage.finishing, 0);
  assert.strictEqual(w.totalInHand, 350);
});

test('wipByStage never returns negative WIP', () => {
  const w = wipByStage([{ stage: 'washing', approved: 100, completed: 140, inline_rejected: 0 }]);
  assert.strictEqual(w.byStage.washing, 0);
});
