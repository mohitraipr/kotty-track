const { test } = require('node:test');
const assert = require('node:assert');
// Requires config/db at import; NODE_ENV=test (set by `npm test`) skips the DB connect.
const { buildEnhancedRow } = require('../utils/picSizeReport.js');

// Regression guard for the approved/completed stage model (PR #479):
//   In      = this stage's APPROVED
//   Out     = this stage's COMPLETED
//   In-line = approved - completed (WIP on the machine)
//   Pending = completed - NEXT stage's approved (done, not yet picked up);
//             for terminal Finishing, completed - dispatched.

const LOT = { lot_no: 'test1', sku: 'KTTX', manual_lot_number: 'm1', remark: '', created_at: new Date() };
const NO_ASSIGNS = { stAssign: null, asmAssign: null, washAssign: null, washInAssign: null, finAssign: null };

test('denim: 100-piece assembly→washing handoff shows as Assembly Pending', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: true, totalCut: 1000,
    sums:     { stitchedQty: 1000, assembledQty: 1000, washedQty: 900, washingInQty: 0, finishedQty: 0 },
    approved: { stitchApproved: 1000, assemblyApproved: 1000, washingApproved: 900, washInApproved: 0, finishingApproved: 0 },
    assigns: NO_ASSIGNS, dispatched: 0,
  });
  // stitching: all handed to assembly
  assert.strictEqual(row.stitchInQty, 1000);
  assert.strictEqual(row.stitchOutQty, 1000);
  assert.strictEqual(row.stitchInline, 0);
  assert.strictEqual(row.stitchPendingQty, 0); // 1000 completed - 1000 assembly-approved
  // assembly: finished 1000 but washing only took 900 → 100 pending at the handoff
  assert.strictEqual(row.assemblyInQty, 1000);
  assert.strictEqual(row.assemblyOutQty, 1000);
  assert.strictEqual(row.assemblyPendingQty, 100);
  // washing: In = approved (900), not assembly's 1000
  assert.strictEqual(row.washingInQty_in, 900);
  assert.strictEqual(row.washingOutQty, 900);
  assert.strictEqual(row.washingPendingQty, 900); // 900 completed - 0 wash-in approved
  assert.strictEqual(row.washingStatus, 'Completed');
});

test('WIP: approved but not yet completed shows as In-line, not Pending', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: true, totalCut: 1000,
    sums:     { stitchedQty: 1000, assembledQty: 1000, washedQty: 500, washingInQty: 0, finishedQty: 0 },
    approved: { stitchApproved: 1000, assemblyApproved: 1000, washingApproved: 900, washInApproved: 0, finishingApproved: 0 },
    assigns: NO_ASSIGNS, dispatched: 0,
  });
  assert.strictEqual(row.washingInQty_in, 900);   // In = approved
  assert.strictEqual(row.washingOutQty, 500);     // Out = completed
  assert.strictEqual(row.washingInline, 400);     // 900 - 500 on the machine
  assert.strictEqual(row.washingPendingQty, 500); // 500 - 0 next-approved
  assert.strictEqual(row.washingStatus, 'In Progress');
});

test('finishing (terminal): Pending = completed - dispatched', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: true, totalCut: 200,
    sums:     { stitchedQty: 200, assembledQty: 200, washedQty: 200, washingInQty: 200, finishedQty: 200 },
    approved: { stitchApproved: 200, assemblyApproved: 200, washingApproved: 200, washInApproved: 200, finishingApproved: 200 },
    assigns: NO_ASSIGNS, dispatched: 150,
  });
  assert.strictEqual(row.finishingInQty, 200);
  assert.strictEqual(row.finishingOutQty, 200);
  assert.strictEqual(row.finishingPendingQty, 50); // 200 finished - 150 dispatched
});

test('hosiery: assembly/washing/wash-in are N/A; stitch pends against finishing', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: false, totalCut: 300,
    sums:     { stitchedQty: 300, assembledQty: 0, washedQty: 0, washingInQty: 0, finishedQty: 100 },
    approved: { stitchApproved: 300, assemblyApproved: 0, washingApproved: 0, washInApproved: 0, finishingApproved: 250 },
    assigns: NO_ASSIGNS, dispatched: 0,
  });
  assert.strictEqual(row.assemblyInQty, '—');
  assert.strictEqual(row.washingInQty_in, '—');
  assert.strictEqual(row.stitchInQty, 300);
  assert.strictEqual(row.stitchPendingQty, 50); // 300 stitched - 250 finishing-approved
});

test('inline/pending never go negative (corrupt data: completed > approved)', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: true, totalCut: 100,
    sums:     { stitchedQty: 100, assembledQty: 0, washedQty: 0, washingInQty: 0, finishedQty: 0 },
    approved: { stitchApproved: 80, assemblyApproved: 0, washingApproved: 0, washInApproved: 0, finishingApproved: 0 },
    assigns: NO_ASSIGNS, dispatched: 0,
  });
  assert.strictEqual(row.stitchInline, 0);       // max(0, 80 - 100)
  assert.ok(row.stitchPendingQty >= 0);
});
