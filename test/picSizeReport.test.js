const { test } = require('node:test');
const assert = require('node:assert');
// Requires config/db at import; NODE_ENV=test (set by `npm test`) skips the DB connect.
const { buildEnhancedRow, deriveLotStyle, fnv1a } = require('../utils/picSizeReport.js');
const { deriveStyle } = require('../utils/easyecomAnalytics.js');

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

// ── deriveLotStyle: decorated cutting-lot skus must still match their style ──
// Root cause of the "lot A639 missing from the style's PIC report" bug: the
// cutter saved the sku as "CCLADIESJEANS20/CC37"; deriveStyle() left the /CC37
// decoration in place so the exact style match dropped every row of the lot.

test('deriveLotStyle strips a /fabric-code decoration', () => {
  assert.strictEqual(deriveLotStyle('CCLADIESJEANS20/CC37'), 'CCLADIESJEANS20');
  assert.strictEqual(deriveLotStyle('KTTLADIESJEANS817/3236'), 'KTTLADIESJEANS817');
  assert.strictEqual(deriveLotStyle('KTTMANSJEANS229/224'), 'KTTMANSJEANS229');
});

test('deriveLotStyle trims stray whitespace', () => {
  assert.strictEqual(deriveLotStyle('KOTTYLADIESJEANS823 '), 'KOTTYLADIESJEANS823');
  assert.strictEqual(deriveLotStyle('  ktttop374  '), 'KTTTOP374');
});

test('deriveLotStyle matches deriveStyle for plain and size-suffixed skus', () => {
  for (const sku of ['CCLADIESJEANS20', 'KTTLADIESJEANS823M', 'KTTLADIESJEANS1003_3XL', 'KTTMENSJEANS381_28']) {
    assert.strictEqual(deriveLotStyle(sku), deriveStyle(sku));
  }
});

test('deriveLotStyle still distinguishes genuinely different styles (KTT677 vs KTT6770)', () => {
  assert.notStrictEqual(deriveLotStyle('KTT6770'), 'KTT677');
  assert.strictEqual(deriveLotStyle('KTT6770/12'), 'KTT6770');
});

test('deriveLotStyle handles empty/nullish input', () => {
  assert.strictEqual(deriveLotStyle(''), '');
  assert.strictEqual(deriveLotStyle(null), '');
  assert.strictEqual(deriveLotStyle(undefined), '');
});

// Cache keys used to be `len-first-last`, which collides for different lot
// sets sharing length and endpoints; the full-list hash must not.
test('fnv1a distinguishes lot lists with same length, first and last', () => {
  const a = ['ak100', 'ak250', 'ak999'].join(',');
  const b = ['ak100', 'ak251', 'ak999'].join(',');
  assert.notStrictEqual(fnv1a(a), fnv1a(b));
  assert.strictEqual(fnv1a(a), fnv1a(a)); // stable
});

// ── Manual date shadow columns ─────────────────────────────────────────────
const { PIC_REPORT_V2_COLUMNS } = require('../utils/picSizeReport.js');

test('manual date: assignedOn reflects the effective date and *ManualDate keys populate', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: true, totalCut: 100,
    sums:     { stitchedQty: 0, assembledQty: 0, washedQty: 0, washingInQty: 0, finishedQty: 0 },
    approved: { stitchApproved: 100, assemblyApproved: 0, washingApproved: 0, washInApproved: 0, finishingApproved: 0 },
    assigns: {
      ...NO_ASSIGNS,
      // What fetchLotEventAggregates now produces: assigned_on/approved_on are
      // already the effective (manual-preferred) date, manual_date is the raw shadow.
      stAssign: {
        is_approved: 1, assigned_on: '2026-08-03', approved_on: '2026-08-03',
        manual_date: '2026-08-03', opName: 'stitchA', user_id: 9,
      },
    },
    dispatched: 0,
  });
  assert.strictEqual(row.stitchManualDate, '03-08-2026');
  assert.ok(row.stitchAssignedOn.startsWith('03-08-2026'));
  // stages without a manual date stay blank (denim, no assign yet)
  assert.strictEqual(row.finishingManualDate, '');
  assert.strictEqual(row.washingManualDate, '');
});

test('manual date: non-denim lots show the N/A dash on denim-only stage manual dates', () => {
  const row = buildEnhancedRow({
    lot: LOT, isDenim: false, totalCut: 100,
    sums:     { stitchedQty: 0, assembledQty: 0, washedQty: 0, washingInQty: 0, finishedQty: 0 },
    approved: { stitchApproved: 0, assemblyApproved: 0, washingApproved: 0, washInApproved: 0, finishingApproved: 0 },
    assigns: NO_ASSIGNS, dispatched: 0,
  });
  assert.strictEqual(row.assemblyManualDate, '—');
  assert.strictEqual(row.washingManualDate, '—');
  assert.strictEqual(row.washInManualDate, '—');
});

test('manual date: PIC_REPORT_V2_COLUMNS carries the five stage manual-date columns', () => {
  const keys = PIC_REPORT_V2_COLUMNS.map(c => c.key);
  for (const k of ['stitchManualDate', 'assemblyManualDate', 'washingManualDate', 'washInManualDate', 'finishingManualDate']) {
    assert.ok(keys.includes(k), `missing column ${k}`);
  }
  const headers = PIC_REPORT_V2_COLUMNS.map(c => c.header);
  assert.ok(headers.includes('Stitch Manual Date'));
});
