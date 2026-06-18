const { test } = require('node:test');
const assert = require('node:assert');
const {
  cutPrioritySummary, fabricNeededByType, wipByStage,
  masterOutputSummary, fabricVarianceRows,
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

test('masterOutputSummary merges cut output with assignment counts per master', () => {
  const lots = [
    { master_id: 3, username: 'akshay', lots: 12, pieces: 9000 },
    { master_id: 9, username: 'imran', lots: 4, pieces: 3000 },
  ];
  const asg = [
    { assigned_master_id: 3, assigned: 5, cut: 4 },
    { assigned_master_id: 17, assigned: 2, cut: 0, username: 'kedar' },
  ];
  const out = masterOutputSummary(lots, asg);
  const ak = out.find(m => m.master_id === 3);
  assert.strictEqual(ak.pieces, 9000);
  assert.strictEqual(ak.assigned, 5);
  assert.strictEqual(ak.cut, 4);
  // a master with assignments but no cut output this window still shows up
  const kedar = out.find(m => m.master_id === 17);
  assert.strictEqual(kedar.username, 'kedar');
  assert.strictEqual(kedar.pieces, 0);
  assert.strictEqual(kedar.assigned, 2);
  // sorted by pieces desc
  assert.strictEqual(out[0].master_id, 3);
});

test('fabricVarianceRows compares real derived consumption to the CAD standard', () => {
  const derived = [
    { style: 'A', realMetersPerPiece: 0.955 },
    { style: 'B', realMetersPerPiece: 1.30 },
    { style: 'C', realMetersPerPiece: 1.00 }, // no CAD -> excluded
  ];
  const cad = [
    { style: 'A', standard: 1.01 },
    { style: 'B', standard: 1.10 },
  ];
  const rows = fabricVarianceRows(derived, cad);
  assert.strictEqual(rows.length, 2);
  // B is +18% over standard -> biggest variance, sorted first
  assert.strictEqual(rows[0].style, 'B');
  assert.strictEqual(rows[0].status, 'over');
  const a = rows.find(r => r.style === 'A');
  assert.strictEqual(a.status, 'under');
  assert.ok(Math.abs(a.variancePct - -5.45) < 0.1);
});
