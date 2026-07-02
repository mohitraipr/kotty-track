// utils/picSizeReport.js
// Shared PIC / PIC-Size report helpers, extracted verbatim from routes/operatorRoutes.js
// so both the operator dashboard (/dashboard/pic-report, /dashboard/pic-size-report)
// and the production-manager dashboard can render the identical report format.
// (daysSince() below carries the effective runtime behaviour from operatorRoutes — see note.)

const { pool } = require('../config/db');
const { cache } = require('../utils/cache');
const ExcelJS = require('exceljs');
const { deriveStyle } = require('./easyecomAnalytics');

function isDenimLot(lotOrLotNo, isDenimCutter = null, flowType = null) {
  // If called with lot object that has flow_type or is_denim_cutter
  if (typeof lotOrLotNo === 'object' && lotOrLotNo !== null) {
    if (lotOrLotNo.flow_type) return lotOrLotNo.flow_type === 'denim';
    if (lotOrLotNo.is_denim_cutter !== null && lotOrLotNo.is_denim_cutter !== undefined) {
      return lotOrLotNo.is_denim_cutter === 1;
    }
    // Fallback to lot prefix
    const up = (lotOrLotNo.lot_no || '').toUpperCase();
    return up.startsWith("AK") || up.startsWith("UM");
  }
  // If called with flowType or isDenimCutter params
  if (flowType) return flowType === 'denim';
  if (isDenimCutter !== null && isDenimCutter !== undefined) return isDenimCutter === 1;
  // Fallback: called with just lot_no string
  const up = String(lotOrLotNo).toUpperCase();
  return up.startsWith("AK") || up.startsWith("UM");
}

// ---------- PIC-Report v2 helpers (user-friendly schema) ----------
function parseLotRemark(remark) {
  if (!remark) return { externalLotNo: '', sortNo: '' };
  const s = String(remark);
  const lotMatch  = s.match(/LOT\s*N(?:O|UMBER)?\s*[:#-]?\s*([A-Za-z0-9_\-\/]+)/i);
  const sortMatch = s.match(/SORT\s*N(?:O|UMBER)?\s*[:#-]?\s*([A-Za-z0-9_\-\/]+)/i);
  return {
    externalLotNo: lotMatch  ? lotMatch[1]  : '',
    sortNo:        sortMatch ? sortMatch[1] : ''
  };
}

function fmtIST(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-');
}

function daysSince(dateValue) {
  // NOTE: operatorRoutes.js had two top-level daysSince() declarations; in sloppy
  // mode the LAST one won, so buildEnhancedRow effectively used this version.
  // Preserved verbatim here so the extracted report output is byte-identical.
  if (!dateValue) return 0;
  const msDiff = Date.now() - new Date(dateValue).getTime();
  return Math.floor(msDiff / (1000 * 60 * 60 * 24));
}

// Per-stage classifier. Returns a status that describes ONLY this stage.
//   isApplicable=false      => N/A (e.g. assembly/washing for hosiery)
//   no assignment           => Not Started
//   is_approved is null     => Pending Approval
//   is_approved == 0        => Denied
//   approved & out=0        => In Progress
//   approved & out >= in    => Completed
//   approved & 0<out<in     => Partial
function classifyStage({ assign, inQty, outQty, nextAssign, isApplicable }) {
  if (!isApplicable) {
    return { status: 'N/A', pending: 0, inline: '' };
  }
  if (!assign) {
    return { status: 'Not Started', pending: Math.max(0, inQty || 0), inline: '' };
  }
  const approved = (assign.is_approved !== undefined) ? assign.is_approved : assign.isApproved;
  if (approved === null || approved === undefined) {
    return { status: 'Pending Approval', pending: Math.max(0, (inQty || 0) - (outQty || 0)), inline: '' };
  }
  if (Number(approved) === 0) {
    return { status: 'Denied', pending: Math.max(0, (inQty || 0) - (outQty || 0)), inline: '' };
  }
  // approved
  if (!outQty || outQty <= 0) {
    return { status: 'In Progress', pending: Math.max(0, inQty || 0), inline: nextAssign ? 'Yes' : '' };
  }
  if (inQty > 0 && outQty >= inQty) {
    return { status: 'Completed', pending: 0, inline: nextAssign ? '' : 'Yes' };
  }
  return { status: 'Partial', pending: Math.max(0, inQty - outQty), inline: nextAssign ? 'Yes' : '' };
}

// Build a flat, user-friendly row: per-stage In/Out/Pending/Status/Inline + a top-level rollup.
function buildEnhancedRow({
  lot, isDenim, totalCut, sums, assigns,
  approved = {}, dispatched = 0,
  rewash = { requested: 0, pending: 0, completed: 0 },
  rejects = {}
}) {
  // Back-compat shim: callers may still pass `rewashQty` (a number for pending).
  if (typeof arguments[0].rewashQty === 'number') {
    rewash = { requested: 0, pending: arguments[0].rewashQty, completed: 0 };
  }
  const { stitchedQty, assembledQty, washedQty, washingInQty, finishedQty } = sums;
  const { stAssign, asmAssign, washAssign, washInAssign, finAssign } = assigns;

  // New per-stage model (approved/completed):
  //   In      = this stage's APPROVED pieces (what it took in)
  //   Out     = this stage's COMPLETED pieces
  //   In-line = approved − completed (on the machine right now)
  //   Pending = completed − NEXT stage's approved (done, not yet picked up).
  //             For the terminal Finishing stage, "next approved" = dispatched pieces.
  const stitchApproved    = Number(approved.stitchApproved)    || 0;
  const assemblyApproved  = Number(approved.assemblyApproved)  || 0;
  const washingApproved   = Number(approved.washingApproved)   || 0;
  const washInApproved    = Number(approved.washInApproved)    || 0;
  const finishingApproved = Number(approved.finishingApproved) || 0;
  const dispatchedQty     = Number(dispatched) || 0;

  const stageBlock = (approvedQty, completedQty, nextApprovedQty, applicable) => {
    if (!applicable) return { in: '—', out: '—', inline: '—', pending: '—', status: 'N/A' };
    const inn = Number(approvedQty) || 0;
    const out = Number(completedQty) || 0;
    const inline = Math.max(0, inn - out);
    const pending = Math.max(0, out - (Number(nextApprovedQty) || 0));
    let status = 'Not Started';
    if (inn > 0) status = out >= inn ? 'Completed' : 'In Progress';
    else if (out > 0) status = 'Completed';
    return { in: inn, out, inline, pending, status };
  };

  // DENIM:   Cut → Stitch → Assembly → Washing → WashIn → Finishing
  // HOSIERY: Cut → Stitch → Finishing  (assembly/washing/wash-in N/A)
  const stitch    = stageBlock(stitchApproved,    stitchedQty,   isDenim ? assemblyApproved : finishingApproved, true);
  const assembly  = stageBlock(assemblyApproved,  assembledQty,  washingApproved,    isDenim);
  const washing   = stageBlock(washingApproved,   washedQty,     washInApproved,     isDenim);
  const washIn    = stageBlock(washInApproved,    washingInQty,  finishingApproved,  isDenim);
  const finishing = stageBlock(finishingApproved, finishedQty,   dispatchedQty,      true);

  // Determine current stage: first non-Completed, non-NA in the chain.
  const chain = isDenim
    ? [['Stitching', stitch, stAssign],
       ['Assembly',  assembly, asmAssign],
       ['Washing',   washing,  washAssign],
       ['Wash-In',   washIn,   washInAssign],
       ['Finishing', finishing, finAssign]]
    : [['Stitching', stitch, stAssign],
       ['Finishing', finishing, finAssign]];

  let currentStage = 'Done';
  let currentPending = 0;
  let stageStartTs = lot.created_at || null;
  for (const [name, info, assign] of chain) {
    if (info.status === 'N/A') continue;
    if (info.status === 'Completed') {
      // advance start ts to this stage's approval
      if (assign && assign.approved_on) stageStartTs = assign.approved_on;
      continue;
    }
    currentStage = name;
    currentPending = info.pending;
    if (assign && assign.assigned_on) stageStartTs = assign.assigned_on;
    break;
  }

  const { externalLotNo: parsedExternalLotNo, sortNo } = parseLotRemark(lot.remark);
  // Prefer the authoritative, backfilled manual_lot_number column; fall back to
  // the value parsed live from the remark for any lot not yet backfilled.
  const externalLotNo = (lot.manual_lot_number && String(lot.manual_lot_number).trim())
    ? String(lot.manual_lot_number).trim()
    : parsedExternalLotNo;
  const opName = a => (a && a.opName) ? a.opName : '';

  return {
    // identification
    lotNo: lot.lot_no,
    externalLotNo,
    sortNo,
    fabricType: lot.fabric_type || '',
    sku: lot.sku,
    lotType: isDenim ? 'Denim' : 'Hosiery',
    createdAt: lot.created_at
      ? new Date(lot.created_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-')
      : '',
    manualCuttingDate: lot.manual_cutting_date
      ? new Date(lot.manual_cutting_date).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }).replace(/\//g, '-')
      : '',
    daysSinceCreated: daysSince(lot.created_at),
    totalCut,
    remark: lot.remark || '',

    // rollup
    currentStage,
    currentPendingQty: currentPending,
    daysInStage: daysSince(stageStartTs),

    // stitching
    stitchOp:        opName(stAssign),
    stitchAssignedOn: fmtIST(stAssign && stAssign.assigned_on),
    stitchApprovedOn: fmtIST(stAssign && stAssign.approved_on),
    stitchInQty:     stitch.in,
    stitchOutQty:    stitch.out,
    stitchPendingQty: stitch.pending,
    stitchStatus:    stitch.status,
    stitchInline:    stitch.inline,

    // assembly
    assemblyOp:        isDenim ? opName(asmAssign) : '—',
    assemblyAssignedOn: isDenim ? fmtIST(asmAssign && asmAssign.assigned_on) : '—',
    assemblyApprovedOn: isDenim ? fmtIST(asmAssign && asmAssign.approved_on) : '—',
    assemblyInQty:     assembly.in,
    assemblyOutQty:    assembly.out,
    assemblyPendingQty: assembly.pending,
    assemblyStatus:    assembly.status,
    assemblyInline:    assembly.inline,

    // washing
    washingOp:        isDenim ? opName(washAssign) : '—',
    washingAssignedOn: isDenim ? fmtIST(washAssign && washAssign.assigned_on) : '—',
    washingApprovedOn: isDenim ? fmtIST(washAssign && washAssign.approved_on) : '—',
    washingInQty_in:  washing.in,
    washingOutQty:    washing.out,
    washingPendingQty: washing.pending,
    washingStatus:    washing.status,
    washingInline:    washing.inline,

    // wash-in
    washInOp:        isDenim ? opName(washInAssign) : '—',
    washInAssignedOn: isDenim ? fmtIST(washInAssign && washInAssign.assigned_on) : '—',
    washInApprovedOn: isDenim ? fmtIST(washInAssign && washInAssign.approved_on) : '—',
    washInInQty:     washIn.in,
    washInOutQty:    washIn.out,
    washInPendingQty: washIn.pending,
    washInStatus:    washIn.status,
    washInInline:    washIn.inline,

    // rewash (pieces sent back from wash-in to washing for re-processing)
    rewashRequestedQty: rewash.requested || 0,
    rewashPendingQty:   rewash.pending   || 0,
    rewashCompletedQty: rewash.completed || 0,

    // rejects per stage (pieces removed from production due to defects)
    stitchRejectQty:     rejects.stitching   ? rejects.stitching.pieces   : 0,
    stitchRejectReasons: rejects.stitching   ? rejects.stitching.reasons  : '',
    washInRejectQty:     rejects.washing_in  ? rejects.washing_in.pieces  : 0,
    washInRejectReasons: rejects.washing_in  ? rejects.washing_in.reasons : '',
    finishingRejectQty:     rejects.finishing ? rejects.finishing.pieces  : 0,
    finishingRejectReasons: rejects.finishing ? rejects.finishing.reasons : '',
    totalRejectQty:
      ((rejects.stitching  && rejects.stitching.pieces)  || 0) +
      ((rejects.washing_in && rejects.washing_in.pieces) || 0) +
      ((rejects.finishing  && rejects.finishing.pieces)  || 0),

    // finishing
    finishingOp:        opName(finAssign),
    finishingAssignedOn: fmtIST(finAssign && finAssign.assigned_on),
    finishingApprovedOn: fmtIST(finAssign && finAssign.approved_on),
    finishingInQty:     finishing.in,
    finishingOutQty:    finishing.out,
    finishingPendingQty: finishing.pending,
    finishingStatus:    finishing.status,
    finishingInline:    finishing.inline
  };
}

// Per-stage column model (as of the approved/completed rework):
//   "Approved"  = pieces the stage took in (APPROVED)
//   "Completed" = pieces the stage COMPLETED
//   "In-line (WIP)" = approved − completed (on the machine right now)
//   "Pending Qty"   = completed − the NEXT stage's approved (done, not yet picked up);
//                     for Finishing, completed − dispatched.
const PIC_REPORT_V2_COLUMNS = [
  { header: 'Lot No',              key: 'lotNo',             width: 14 },
  { header: 'Manual Lot No',       key: 'externalLotNo',     width: 14 },
  { header: 'Fabric Type',         key: 'fabricType',        width: 14 },
  { header: 'SKU',                 key: 'sku',               width: 22 },
  { header: 'Lot Type',            key: 'lotType',           width: 9  },
  { header: 'Created At',          key: 'createdAt',         width: 12 },
  { header: 'Manual Cutting Date', key: 'manualCuttingDate', width: 14 },
  { header: 'Days Since Created',  key: 'daysSinceCreated',  width: 10 },
  { header: 'Total Cut',           key: 'totalCut',          width: 10 },
  { header: 'Current Stage',       key: 'currentStage',      width: 14 },
  { header: 'Current Pending Qty', key: 'currentPendingQty', width: 12 },
  { header: 'Days In Stage',       key: 'daysInStage',       width: 10 },
  { header: 'Remark',              key: 'remark',            width: 26 },

  { header: 'Stitch Operator',     key: 'stitchOp',          width: 14 },
  { header: 'Stitch Assigned On',  key: 'stitchAssignedOn',  width: 19 },
  { header: 'Stitch Approved On',  key: 'stitchApprovedOn',  width: 19 },
  { header: 'Stitch Approved',       key: 'stitchInQty',       width: 11 },
  { header: 'Stitch Completed',      key: 'stitchOutQty',      width: 11 },
  { header: 'Stitch Pending Qty',  key: 'stitchPendingQty',  width: 12 },
  { header: 'Stitch Status',       key: 'stitchStatus',      width: 16 },
  { header: 'Stitch In-line (WIP)',      key: 'stitchInline',      width: 9  },

  { header: 'Assembly Operator',     key: 'assemblyOp',          width: 14 },
  { header: 'Assembly Assigned On',  key: 'assemblyAssignedOn',  width: 19 },
  { header: 'Assembly Approved On',  key: 'assemblyApprovedOn',  width: 19 },
  { header: 'Assembly Approved',       key: 'assemblyInQty',       width: 11 },
  { header: 'Assembly Completed',      key: 'assemblyOutQty',      width: 11 },
  { header: 'Assembly Pending Qty',  key: 'assemblyPendingQty',  width: 12 },
  { header: 'Assembly Status',       key: 'assemblyStatus',      width: 16 },
  { header: 'Assembly In-line (WIP)',      key: 'assemblyInline',      width: 9  },

  { header: 'Washing Operator',     key: 'washingOp',          width: 14 },
  { header: 'Washing Assigned On',  key: 'washingAssignedOn',  width: 19 },
  { header: 'Washing Approved On',  key: 'washingApprovedOn',  width: 19 },
  { header: 'Washing Approved',       key: 'washingInQty_in',    width: 11 },
  { header: 'Washing Completed',      key: 'washingOutQty',      width: 11 },
  { header: 'Washing Pending Qty',  key: 'washingPendingQty',  width: 12 },
  { header: 'Washing Status',       key: 'washingStatus',      width: 16 },
  { header: 'Washing In-line (WIP)',      key: 'washingInline',      width: 9  },

  { header: 'Wash-In Operator',     key: 'washInOp',           width: 14 },
  { header: 'Wash-In Assigned On',  key: 'washInAssignedOn',   width: 19 },
  { header: 'Wash-In Approved On',  key: 'washInApprovedOn',   width: 19 },
  { header: 'Wash-In Approved',       key: 'washInInQty',        width: 11 },
  { header: 'Wash-In Completed',      key: 'washInOutQty',       width: 11 },
  { header: 'Wash-In Pending Qty',  key: 'washInPendingQty',   width: 12 },
  { header: 'Wash-In Status',       key: 'washInStatus',       width: 16 },
  { header: 'Wash-In In-line (WIP)',      key: 'washInInline',       width: 9  },

  { header: 'Rewash Requested',     key: 'rewashRequestedQty', width: 11 },
  { header: 'Rewash Pending',       key: 'rewashPendingQty',   width: 11 },
  { header: 'Rewash Completed',     key: 'rewashCompletedQty', width: 11 },

  { header: 'Finishing Operator',     key: 'finishingOp',          width: 14 },
  { header: 'Finishing Assigned On',  key: 'finishingAssignedOn',  width: 19 },
  { header: 'Finishing Approved On',  key: 'finishingApprovedOn',  width: 19 },
  { header: 'Finishing Approved',       key: 'finishingInQty',       width: 11 },
  { header: 'Finishing Completed',      key: 'finishingOutQty',      width: 11 },
  { header: 'Finishing Pending Qty',  key: 'finishingPendingQty',  width: 12 },
  { header: 'Finishing Status',       key: 'finishingStatus',      width: 16 },

  { header: 'Stitch Rejects',         key: 'stitchRejectQty',         width: 11 },
  { header: 'Stitch Reject Reasons',  key: 'stitchRejectReasons',     width: 28 },
  { header: 'Wash-In Rejects',        key: 'washInRejectQty',         width: 11 },
  { header: 'Wash-In Reject Reasons', key: 'washInRejectReasons',     width: 28 },
  { header: 'Finishing Rejects',      key: 'finishingRejectQty',      width: 11 },
  { header: 'Finishing Reject Reasons', key: 'finishingRejectReasons', width: 28 },
  { header: 'Total Rejects',          key: 'totalRejectQty',          width: 11 }
];

// ---------------------------------------------------------------------------
// Event-sourced aggregates (truth source for PIC reports).
//
// The legacy *_assignments / *_data tables are only partially kept in sync —
// roughly half of recent activity flows through the *_events tables instead.
// These helpers read directly from *_events / *_event_sizes so the reports
// reflect real lot location (e.g. AK5237 sitting inline at washer ADS even
// though washing_assignments has no row for it).
//
// Mapping back to the legacy shape:
//   stitchedQty   = SUM(stitching_events.complete)
//   assembledQty  = SUM(jeans_assembly_events.complete)
//   washedQty     = SUM(washing_events.complete)
//   washingInQty  = SUM(washing_in_events.complete)
//   finishedQty   = SUM(finishing_events.complete)
//
//   stitchMap[lot] / asmMap / washMap / winMap / finMap = a synthetic
//   "assignment-like" object built from the latest approve event for the
//   stage (is_approved=1, assigned_on=approved_on=latest approve ts,
//   opName=latest approver username). null when no approve event yet.
// ---------------------------------------------------------------------------
async function fetchLotEventAggregates(lotNos = []) {
  if (!lotNos.length) {
    return {
      lotSumsMap: {}, stitchMap: {}, asmMap: {}, washMap: {}, winMap: {}, finMap: {}
    };
  }
  const sorted = lotNos.slice().sort();
  const cacheKey = `lotAggEv-${sorted.length}-${sorted[0]}-${sorted[sorted.length - 1]}`;
  return cache.fetchCached(cacheKey, async () => {
    const aggSql = (table, key) => `
      SELECT '${key}' AS stage, cl.lot_no,
             SUM(CASE WHEN e.event_type='complete' THEN e.pieces ELSE 0 END) AS completed,
             SUM(CASE WHEN e.event_type='approve'  THEN e.pieces ELSE 0 END) AS approved
        FROM ${table} e
        JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
       WHERE cl.lot_no IN (?)
       GROUP BY cl.lot_no
    `;
    const aggQ = pool.query(
      [
        aggSql('stitching_events',       'stitched'),
        aggSql('jeans_assembly_events',  'assembled'),
        aggSql('washing_events',         'washed'),
        aggSql('washing_in_events',      'washing_in'),
        aggSql('finishing_events',       'finished'),
      ].join('\nUNION ALL\n'),
      [lotNos, lotNos, lotNos, lotNos, lotNos]
    );

    // Per-stage approve events, ordered so the first row per lot is the latest.
    const opSql = (table) => `
      SELECT cl.lot_no, e.created_at, u.username AS opName, e.operator_id
        FROM ${table} e
        JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
        JOIN users u ON u.id = e.operator_id
       WHERE cl.lot_no IN (?) AND e.event_type = 'approve'
       ORDER BY e.created_at DESC, e.id DESC
    `;
    const stApprovesQ  = pool.query(opSql('stitching_events'),       [lotNos]);
    const asmApprovesQ = pool.query(opSql('jeans_assembly_events'),  [lotNos]);
    const washApprovesQ= pool.query(opSql('washing_events'),         [lotNos]);
    const winApprovesQ = pool.query(opSql('washing_in_events'),      [lotNos]);
    const finApprovesQ = pool.query(opSql('finishing_events'),       [lotNos]);

    // Dispatched pieces per lot (the "next approval" for the terminal finishing stage).
    const dispQ = pool.query(
      `SELECT lot_no, COALESCE(SUM(quantity),0) AS dispatched
         FROM finishing_dispatches WHERE lot_no IN (?) GROUP BY lot_no`, [lotNos]);

    const [
      [aggRows],
      [stApproves],
      [asmApproves],
      [washApproves],
      [winApproves],
      [finApproves],
      [dispRows],
    ] = await Promise.all([aggQ, stApprovesQ, asmApprovesQ, washApprovesQ, winApprovesQ, finApprovesQ, dispQ]);

    const lotSumsMap = {};
    lotNos.forEach(ln => {
      lotSumsMap[ln] = {
        stitchedQty:0, assembledQty:0, washedQty:0, washingInQty:0, finishedQty:0,
        // approved (pieces the stage took in) — parallel to the completed sums above
        stitchApproved:0, assemblyApproved:0, washingApproved:0, washInApproved:0, finishingApproved:0,
        dispatched:0,
      };
    });
    for (const r of aggRows) {
      const m = lotSumsMap[r.lot_no];
      if (!m) continue;
      const completed = parseFloat(r.completed) || 0;
      const approved  = parseFloat(r.approved)  || 0;
      switch (r.stage) {
        case 'stitched':   m.stitchedQty   = completed; m.stitchApproved     = approved; break;
        case 'assembled':  m.assembledQty  = completed; m.assemblyApproved   = approved; break;
        case 'washed':     m.washedQty     = completed; m.washingApproved    = approved; break;
        case 'washing_in': m.washingInQty  = completed; m.washInApproved     = approved; break;
        case 'finished':   m.finishedQty   = completed; m.finishingApproved  = approved; break;
      }
    }
    for (const r of dispRows) {
      if (lotSumsMap[r.lot_no]) lotSumsMap[r.lot_no].dispatched = parseFloat(r.dispatched) || 0;
    }

    const latestApproveMap = (rows) => {
      const m = {};
      for (const r of rows) {
        if (m[r.lot_no]) continue; // first occurrence is latest (DESC order)
        m[r.lot_no] = {
          is_approved: 1,
          assigned_on: r.created_at,
          approved_on: r.created_at,
          opName:      r.opName,
          user_id:     r.operator_id,
        };
      }
      return m;
    };

    return {
      lotSumsMap,
      stitchMap: latestApproveMap(stApproves),
      asmMap:    latestApproveMap(asmApproves),
      washMap:   latestApproveMap(washApproves),
      winMap:    latestApproveMap(winApproves),
      finMap:    latestApproveMap(finApproves),
    };
  });
}

// Per-(lot, size) completed pieces by stage, from *_event_sizes.
async function fetchLotSizeEventSums(lotNos = []) {
  if (!lotNos.length) return {};
  const sorted = lotNos.slice().sort();
  const cacheKey = `lotSizeEv-${sorted.length}-${sorted[0]}-${sorted[sorted.length - 1]}`;
  return cache.fetchCached(cacheKey, async () => {
    const sizeSql = (eventsTbl, sizesTbl, key) => `
      SELECT '${key}' AS stage, cl.lot_no, s.size_label,
             COALESCE(SUM(CASE WHEN e.event_type='complete' THEN s.pieces ELSE 0 END),0) AS completed,
             COALESCE(SUM(CASE WHEN e.event_type='approve'  THEN s.pieces ELSE 0 END),0) AS approved
        FROM ${sizesTbl} s
        JOIN ${eventsTbl} e ON e.id = s.event_id
        JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
       WHERE cl.lot_no IN (?) AND e.event_type IN ('complete','approve')
       GROUP BY cl.lot_no, s.size_label
    `;
    const [rows] = await pool.query(
      [
        sizeSql('stitching_events',      'stitching_event_sizes',      'stitched'),
        sizeSql('jeans_assembly_events', 'jeans_assembly_event_sizes', 'assembled'),
        sizeSql('washing_events',        'washing_event_sizes',        'washed'),
        sizeSql('washing_in_events',     'washing_in_event_sizes',     'washing_in'),
        sizeSql('finishing_events',      'finishing_event_sizes',      'finished'),
      ].join('\nUNION ALL\n'),
      [lotNos, lotNos, lotNos, lotNos, lotNos]
    );
    const map = {}; // key = `${lot_no}|${size_label}`
    for (const r of rows) {
      const k = `${r.lot_no}|${r.size_label}`;
      if (!map[k]) map[k] = {
        stitchedQty:0, assembledQty:0, washedQty:0, washingInQty:0, finishedQty:0,
        stitchApproved:0, assemblyApproved:0, washingApproved:0, washInApproved:0, finishingApproved:0,
      };
      const completed = parseFloat(r.completed) || 0;
      const approved  = parseFloat(r.approved)  || 0;
      switch (r.stage) {
        case 'stitched':   map[k].stitchedQty  = completed; map[k].stitchApproved    = approved; break;
        case 'assembled':  map[k].assembledQty = completed; map[k].assemblyApproved  = approved; break;
        case 'washed':     map[k].washedQty    = completed; map[k].washingApproved   = approved; break;
        case 'washing_in': map[k].washingInQty = completed; map[k].washInApproved    = approved; break;
        case 'finished':   map[k].finishedQty  = completed; map[k].finishingApproved = approved; break;
      }
    }
    return map;
  });
}

/**
 * The chain logic you want:
 * DENIM: Cut → Stitching → Assembly → Washing → WashingIn → Finishing
 * NON-DENIM: Cut → Stitching → Finishing
 * 
 * If a step is not assigned or partial, we say all subsequent steps = "In <that step>".
 */
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washedQty,
  washingInQty,
  finishedQty,
  stAssign,     // stitching_assignments
  asmAssign,    // jeans_assembly_assignments
  washAssign,   // washing_assignments
  washInAssign, // washing_in_assignments
  finAssign,    // finishing_assignments
  // Per-stage APPROVED sums + dispatched. A lot is "N Pending" at a stage when it
  // COMPLETED more than the NEXT stage has APPROVED (taken in). Terminal finishing
  // measures completed vs dispatched. Defaults keep old callers working.
  stitchApproved = 0,
  assemblyApproved = 0,
  washingApproved = 0,
  washInApproved = 0,
  finishingApproved = 0,
  dispatched = 0
}) {
  // placeholders
  let stitchingStatus="N/A", stitchingOp="", stitchingAssignedOn="N/A", stitchingApprovedOn="N/A";
  let assemblyStatus= isDenim? "N/A" : "—", assemblyOp="", assemblyAssignedOn="N/A", assemblyApprovedOn="N/A";
  let washingStatus= isDenim? "N/A" : "—", washingOp="", washingAssignedOn="N/A", washingApprovedOn="N/A";
  // for non-denim, we skip washing & assembly & washing_in entirely
  let washingInStatus= isDenim? "N/A": "—", washingInOp="", washingInAssignedOn="N/A", washingInApprovedOn="N/A";
  let finishingStatus="N/A", finishingOp="", finishingAssignedOn="N/A", finishingApprovedOn="N/A";

  // STITCHING
  if (!stAssign) {
    stitchingStatus= "In Cutting";
    // everything after stitching is "In Cutting"
    if (isDenim) {
      assemblyStatus= "In Cutting";
      washingStatus= "In Cutting";
      washingInStatus= "In Cutting";
      finishingStatus= "In Cutting";
    } else {
      finishingStatus= "In Cutting";
    }
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
      washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
      washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
      finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
    };
  } else {
    // we have a stitching assignment
    const { isApproved, assigned_on, approved_on, opName } = stAssign;
    stitchingOp= opName|| "";
    stitchingAssignedOn = assigned_on
      ? new Date(assigned_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";
    stitchingApprovedOn = approved_on
      ? new Date(approved_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";

    if (isApproved=== null) {
      stitchingStatus= `Pending Approval by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else if (isApproved==0) {
      stitchingStatus= `Denied by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else {
      // approved => check dispatch to next stage
      if (stitchedQty===0) {
        stitchingStatus= "In-Line";
      } else if (isDenim) {
        // Denim: compare against what assembly received
        if (!asmAssign) {
          stitchingStatus= "Completed-Inline";
        } else if (assemblyApproved < stitchedQty) {
          const pend= stitchedQty - assemblyApproved;
          stitchingStatus= `${pend} Pending`;
        } else {
          stitchingStatus= !washAssign ? "Completed-Inline" : "Completed";
        }
      } else {
        // Hosiery: compare against what finishing APPROVED (took in)
        if (!finAssign) {
          stitchingStatus= "Completed-Inline";
        } else if (finishingApproved < stitchedQty) {
          const pend= stitchedQty - finishingApproved;
          stitchingStatus= `${pend} Pending`;
        } else {
          stitchingStatus= "Completed";
        }
      }
    }
  }

  // for non-denim, the next step is finishing
  // for denim: next step is assembly
  if (!isDenim) {
    // NON-DENIM => skip assembly, washing, washingIn
    // finishing next
    // if there's no finishing assignment, or partial finishing => we do that logic below
    // keep going...
  } else {
    // DENIM => assembly next
    if (!asmAssign) {
      assemblyStatus= "In Stitching";
      washingStatus= "In Stitching";
      washingInStatus= "In Stitching";
      finishingStatus= "In Stitching";
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else {
      // we have assembly
      const { is_approved, assigned_on, approved_on, opName }= asmAssign;
      assemblyOp= opName|| "";
      assemblyAssignedOn = assigned_on
        ? new Date(assigned_on)
            .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
            .replace(/\//g, '-')
        : "N/A";
      assemblyApprovedOn = approved_on
        ? new Date(approved_on)
            .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
            .replace(/\//g, '-')
        : "N/A";

      if (is_approved=== null) {
        assemblyStatus= `Pending Approval by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else if (is_approved==0) {
        assemblyStatus= `Denied by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else {
        // approved => check dispatch to washing
        if (assembledQty===0) {
          assemblyStatus= "In-Line";
        } else if (!washAssign) {
          assemblyStatus= "Completed-Inline";
        } else if (washingApproved < assembledQty) {
          const pend= assembledQty - washingApproved;
          assemblyStatus= `${pend} Pending`;
        } else {
          assemblyStatus= !washInAssign ? "Completed-Inline" : "Completed";
        }
      }

      // next => washing
      if (!washAssign) {
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else {
        const { is_approved, assigned_on, approved_on, opName }= washAssign;
        washingOp= opName|| "";
        washingAssignedOn = assigned_on
          ? new Date(assigned_on)
              .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "N/A";
        washingApprovedOn = approved_on
          ? new Date(approved_on)
              .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "N/A";

        if (is_approved=== null) {
          washingStatus= `Pending Approval by ${washingOp}`;
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else if (is_approved==0) {
          washingStatus= `Denied by ${washingOp}`;
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else {
          // approved => check dispatch to washingIn
          if (washedQty===0) {
            washingStatus= "In-Line";
          } else if (!washInAssign) {
            washingStatus= "Completed-Inline";
          } else if (washInApproved < washedQty) {
            const pend= washedQty - washInApproved;
            washingStatus= `${pend} Pending`;
          } else {
            washingStatus= !finAssign ? "Completed-Inline" : "Completed";
          }
        }

        // next => washingIn
        if (!washInAssign) {
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else {
          const { is_approved, assigned_on, approved_on, opName }= washInAssign;
          washingInOp= opName|| "";
          washingInAssignedOn = assigned_on
            ? new Date(assigned_on)
                .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
                .replace(/\//g, '-')
            : "N/A";
          washingInApprovedOn = approved_on
            ? new Date(approved_on)
                .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
                .replace(/\//g, '-')
            : "N/A";

          if (is_approved===null) {
            washingInStatus= `Pending Approval by ${washingInOp}`;
            finishingStatus= "In WashingIn";
            return {
              stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
              assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
              washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
              washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
              finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
            };
          } else if (is_approved==0) {
            washingInStatus= `Denied by ${washingInOp}`;
            finishingStatus= "In WashingIn";
            return {
              stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
              assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
              washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
              washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
              finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
            };
          } else {
            // approved => check dispatch to finishing
            if (washingInQty===0) {
              washingInStatus= "In-Line";
            } else if (!finAssign) {
              washingInStatus= "Completed-Inline";
            } else if (finishingApproved < washingInQty) {
              const pend= washingInQty - finishingApproved;
              washingInStatus= `${pend} Pending`;
            } else {
              washingInStatus= "Completed";
            }
          }
        }
      }
    }
  }

  // for non-denim, we skip assembly/washing/washingIn entirely
  // next => finishing
  if (!finAssign) {
    if (isDenim) {
      finishingStatus= "In WashingIn";   // if no finishing assignment
    } else {
      finishingStatus= "In Stitching";   // for non-denim
    }
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
      washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
      washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
      finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
    };
  } else {
    const { is_approved, assigned_on, approved_on, opName }= finAssign;
    finishingOp= opName|| "";
    finishingAssignedOn = assigned_on
      ? new Date(assigned_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";
    finishingApprovedOn = approved_on
      ? new Date(approved_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";

    if (is_approved===null) {
      finishingStatus= `Pending Approval by ${finishingOp}`;
    } else if (is_approved==0) {
      finishingStatus= `Denied by ${finishingOp}`;
    } else {
      // Terminal stage — "next approval" is dispatch: finished pieces stay pending
      // until they're dispatched out. Same rule for denim and hosiery.
      if (finishedQty===0) {
        finishingStatus= "In-Line";
      } else if (dispatched >= finishedQty) {
        finishingStatus= "Completed";
      } else {
        const pend= finishedQty - dispatched;
        finishingStatus= `${pend} Pending`;
      }
    }
  }

  return {
    stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
    assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
    washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
    washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
    finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
  };
}

/** filterByDept */
function filterByDept({
  department, isDenim,
  stitchingStatus,
  assemblyStatus,
  washingStatus,
  washingInStatus,
  finishingStatus
}) {
  let showRow= true;
  let actualStatus= "N/A";

  if (department==="all") {
    if (isDenim) {
      // finishing if not N/A, else washingIn, else washing, else assembly, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus= washingInStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus= washingStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus= assemblyStatus;
      else actualStatus= stitchingStatus;
    } else {
      // non-denim => finishing, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else actualStatus= stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department==="cutting") {
    // always show "Completed"
    actualStatus= "Completed";
    return { showRow, actualStatus };
  }

  if (department==="stitching") {
    actualStatus= stitchingStatus;
    return { showRow, actualStatus };
  }

  if (department==="assembly") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= assemblyStatus;
    return { showRow, actualStatus };
  }

  if (department==="washing") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= washingStatus;
    return { showRow, actualStatus };
  }

  if (department==="washing_in") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= washingInStatus;
    return { showRow, actualStatus };
  }

  if (department==="finishing") {
    actualStatus= finishingStatus;
    return { showRow, actualStatus };
  }

  return { showRow, actualStatus };
}

// ────────────────────────────────────────────────────────────────────
// Public builders — assemble the size-wise PIC report (one row per lot+size)
// and its workbook. Used by the operator size route and the PM report route.
// ────────────────────────────────────────────────────────────────────

// Build the per-(lot,size) enriched rows. Options mirror the operator route
// filters; inProductionOnly restricts to lots still in production across ALL
// styles (net cut - dispatched > 0), bounded to a recent window so ancient
// never-dispatched lots don't linger (matches utils/onOrder.js in-flight window).
async function buildPicSizeRows({
  lotType = 'all',
  department = 'all',
  status = 'all',
  dateFilter = 'createdAt',
  startDate = '',
  endDate = '',
  inProductionOnly = false,
  inProductionWindowDays = 120,
  style = '',
} = {}) {
  // Row cap: the operator (date-windowed) path keeps its historical 5000 cap; the
  // "all in-production" path needs headroom so it doesn't silently drop older
  // in-production lots (the 120d window is ~6.5k lot×size rows and growing).
  const rowLimit = inProductionOnly ? 50000 : 5000;
  // Optional style scope (e.g. the PM style page). Matches via deriveStyle() so both
  // style-level and size-suffixed cutting_lots.sku values resolve correctly — the SQL
  // LIKE is a prefilter; the exact match happens per-row in the assembly loop below.
  const styleUpper = String(style || '').trim().toUpperCase();
  let dateWhere = '';
  const dateParams = [];

  if (inProductionOnly && !startDate && !endDate) {
    dateWhere = ' AND cl.created_at >= (NOW() - INTERVAL ? DAY) ';
    dateParams.push(inProductionWindowDays);
  } else {
    let sd = startDate;
    let ed = endDate;
    if (!sd || !ed) {
      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      ed = today.toISOString().split('T')[0];
      sd = weekAgo.toISOString().split('T')[0];
    }
    if (dateFilter === 'createdAt') {
      dateWhere = ' AND DATE(cl.created_at) BETWEEN ? AND ? ';
      dateParams.push(sd, ed);
    } else if (dateFilter === 'assignedOn') {
      const evtTable = {
        stitching: 'stitching_events',
        assembly: 'jeans_assembly_events',
        washing: 'washing_events',
        washing_in: 'washing_in_events',
        finishing: 'finishing_events',
      }[department];
      if (evtTable) {
        dateWhere = `
          AND EXISTS (
            SELECT 1 FROM ${evtTable} e
             WHERE e.cutting_lot_id = cl.id
               AND e.event_type = 'approve'
               AND DATE(e.created_at) BETWEEN ? AND ?
          )`;
        dateParams.push(sd, ed);
      }
    }
  }

  // Style scope prefilter (exact match happens per-row via deriveStyle below).
  // Appended after the date clause so params stay in query order.
  if (styleUpper) {
    dateWhere += ' AND cl.sku LIKE ? ';
    dateParams.push(`${styleUpper}%`);
  }

  let lotTypeClause = '';
  if (lotType === 'denim') {
    lotTypeClause = `
      AND (
        cl.flow_type = 'denim'
        OR (cl.flow_type IS NULL AND u.is_denim_cutter = 1)
        OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND (cl.lot_no LIKE 'AK%' OR cl.lot_no LIKE 'UM%'))
      )`;
  } else if (lotType === 'hosiery') {
    lotTypeClause = `
      AND (
        cl.flow_type = 'hosiery'
        OR (cl.flow_type IS NULL AND u.is_denim_cutter = 0)
        OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND cl.lot_no NOT LIKE 'AK%' AND cl.lot_no NOT LIKE 'UM%')
      )`;
  }

  const baseQuery = `
    SELECT cl.lot_no, cl.manual_lot_number, cl.sku, cl.fabric_type, cls.size_label, cls.total_pieces, cl.created_at, cl.remark, cl.flow_type,
           u.username AS created_by, u.is_denim_cutter
      FROM cutting_lots cl
      JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
      JOIN users u ON cl.user_id = u.id
     WHERE 1=1
       ${lotTypeClause}
       ${dateWhere}
     ORDER BY cl.created_at DESC
     LIMIT ${rowLimit}`;
  const [rows] = await pool.query(baseQuery, dateParams);

  const lotNos = [...new Set(rows.map((r) => r.lot_no))];
  if (!lotNos.length) return [];

  const sizeEventSums = await fetchLotSizeEventSums(lotNos);

  const [dispatchRows] = await pool.query(`
    SELECT fdp.lot_no, fdp.size_label,
           COALESCE(SUM(fdp.quantity),0) AS dispatchedQty,
           GROUP_CONCAT(DISTINCT fdp.destination ORDER BY fdp.sent_at DESC SEPARATOR ', ') AS destinations
      FROM finishing_dispatches fdp
     WHERE fdp.lot_no IN (?)
     GROUP BY fdp.lot_no, fdp.size_label`, [lotNos]);
  const dispatchMap = {};
  for (const d of dispatchRows) {
    dispatchMap[`${d.lot_no}|${d.size_label}`] = {
      dispatchedQty: parseFloat(d.dispatchedQty) || 0,
      destinations: d.destinations || '',
    };
  }

  const sizeSumsMap = {};
  for (const r of rows) {
    const key = `${r.lot_no}|${r.size_label}`;
    const fromEvents = sizeEventSums[key];
    sizeSumsMap[key] = fromEvents
      ? { ...fromEvents }
      : { stitchedQty: 0, assembledQty: 0, washedQty: 0, washingInQty: 0, finishedQty: 0 };
  }

  const { stitchMap, asmMap, washMap, winMap, finMap } = await fetchLotEventAggregates(lotNos);

  const [rewashRows2] = await pool.query(
    `SELECT lot_no,
            SUM(total_requested) AS requestedQty,
            SUM(CASE WHEN status='pending'   THEN total_requested ELSE 0 END) AS pendingQty,
            SUM(CASE WHEN status='completed' THEN total_requested ELSE 0 END) AS completedQty
       FROM rewash_requests
      WHERE lot_no IN (?)
      GROUP BY lot_no`, [lotNos]);
  const rewashMap = {};
  for (const r of rewashRows2) {
    rewashMap[r.lot_no] = {
      requested: parseFloat(r.requestedQty) || 0,
      pending: parseFloat(r.pendingQty) || 0,
      completed: parseFloat(r.completedQty) || 0,
    };
  }

  const [sizeRejectRows] = await pool.query(
    `SELECT rd.lot_no, rd.stage, rds.size_label,
            COALESCE(SUM(rds.pieces),0) AS pieces,
            GROUP_CONCAT(DISTINCT NULLIF(rd.reason,'') ORDER BY rd.reason SEPARATOR '; ') AS reasons
       FROM reject_data rd
       JOIN reject_data_sizes rds ON rds.reject_data_id = rd.id
      WHERE rd.lot_no IN (?)
      GROUP BY rd.lot_no, rd.stage, rds.size_label`, [lotNos]);
  const rejectSizeMap = {};
  for (const r of sizeRejectRows) {
    const key = `${r.lot_no}|${r.size_label}`;
    if (!rejectSizeMap[key]) rejectSizeMap[key] = {};
    rejectSizeMap[key][r.stage] = { pieces: parseFloat(r.pieces) || 0, reasons: r.reasons || '' };
  }

  const finalData = [];
  for (const row of rows) {
    // Exact style scope: the SQL LIKE prefilter can over-match (e.g. KTT677 vs KTT6770),
    // so confirm the derived style equals the requested one — same semantics as the
    // dashboard's r.style === style filtering.
    if (styleUpper && deriveStyle(row.sku) !== styleUpper) continue;
    const lotNo = row.lot_no;
    const sizeLabel = row.size_label;
    const totalCut = parseFloat(row.total_pieces) || 0;
    const denim = isDenimLot(row);

    const sums = sizeSumsMap[`${lotNo}|${sizeLabel}`] || {};
    const stitchedQty = sums.stitchedQty || 0;
    const assembledQty = sums.assembledQty || 0;
    const washedQty = sums.washedQty || 0;
    const washingInQty = sums.washingInQty || 0;
    const finishedQty = sums.finishedQty || 0;
    // per-size approved (In) + dispatched (finishing's "next approval")
    const approvedSums = {
      stitchApproved: sums.stitchApproved || 0,
      assemblyApproved: sums.assemblyApproved || 0,
      washingApproved: sums.washingApproved || 0,
      washInApproved: sums.washInApproved || 0,
      finishingApproved: sums.finishingApproved || 0,
    };
    const dispatch = dispatchMap[`${lotNo}|${sizeLabel}`] || {};
    const dispatchedQty = dispatch.dispatchedQty || 0;

    const stAssign = stitchMap[lotNo] || null;
    const asmAssign = asmMap[lotNo] || null;
    const washAssign = washMap[lotNo] || null;
    const wInAssign = winMap[lotNo] || null;
    const finAssign = finMap[lotNo] || null;

    const statuses = getDepartmentStatuses({
      isDenim: denim, totalCut, stitchedQty, assembledQty, washedQty, washingInQty, finishedQty,
      stAssign, asmAssign, washAssign, washInAssign: wInAssign, finAssign,
      ...approvedSums, dispatched: dispatchedQty,
    });

    const deptResult = filterByDept({
      department, isDenim: denim,
      stitchingStatus: statuses.stitchingStatus,
      assemblyStatus: statuses.assemblyStatus,
      washingStatus: statuses.washingStatus,
      washingInStatus: statuses.washingInStatus,
      finishingStatus: statuses.finishingStatus,
    });
    if (!deptResult.showRow) continue;

    const actualStatus = deptResult.actualStatus.toLowerCase();
    if (status !== 'all') {
      if (status === 'not_assigned') {
        if (!actualStatus.startsWith('in ')) continue;
      } else {
        const want = status.toLowerCase();
        if (want === 'inline' && actualStatus.includes('in-line')) {
          // keep
        } else if (!actualStatus.includes(want)) {
          continue;
        }
      }
    }

    const lotForBuilder = {
      lot_no: lotNo,
      manual_lot_number: row.manual_lot_number,
      sku: row.sku,
      fabric_type: row.fabric_type,
      remark: row.remark,
      created_at: row.created_at,
    };
    const enriched = buildEnhancedRow({
      lot: lotForBuilder,
      isDenim: denim,
      totalCut,
      sums: { stitchedQty, assembledQty, washedQty, washingInQty, finishedQty },
      assigns: { stAssign, asmAssign, washAssign, washInAssign: wInAssign, finAssign },
      approved: approvedSums,
      dispatched: dispatchedQty,
      rewash: rewashMap[lotNo] || { requested: 0, pending: 0, completed: 0 },
      rejects: rejectSizeMap[`${lotNo}|${sizeLabel}`] || {},
    });
    enriched.size = sizeLabel;
    enriched.sku_size = `${row.sku}_${sizeLabel}`;
    enriched.dispatchedQty = dispatchedQty;
    enriched.destinations = dispatch.destinations || '';

    // In-production = this lot+size still has undispatched pieces.
    if (inProductionOnly && (totalCut - enriched.dispatchedQty) <= 0) continue;

    finalData.push(enriched);
  }
  return finalData;
}

// Build the PIC-Size workbook from finalData. Column set is identical to the
// operator size route (shared PIC_REPORT_V2_COLUMNS + Size + dispatch columns).
function buildPicSizeWorkbook(finalData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PIC Size Report v2';
  const sheet = workbook.addWorksheet('PIC-Size-Report');

  const sizeCols = [
    { header: 'Lot No',              key: 'lotNo',             width: 14 },
    { header: 'Manual Lot No',       key: 'externalLotNo',     width: 14 },
    { header: 'Fabric Type',         key: 'fabricType',        width: 14 },
    { header: 'SKU',                 key: 'sku',               width: 22 },
    { header: 'Size',                key: 'size',              width: 8  },
    { header: 'SKU_Size',            key: 'sku_size',          width: 24 },
    { header: 'Lot Type',            key: 'lotType',           width: 9  },
    { header: 'Created At',          key: 'createdAt',         width: 12 },
    { header: 'Days Since Created',  key: 'daysSinceCreated',  width: 10 },
    { header: 'Lot Total Cut',       key: 'totalCut',          width: 10 },
    { header: 'Current Stage',       key: 'currentStage',      width: 14 },
    { header: 'Current Pending Qty', key: 'currentPendingQty', width: 12 },
    { header: 'Days In Stage',       key: 'daysInStage',       width: 10 },
    { header: 'Remark',              key: 'remark',            width: 26 },
  ];
  const stageColKeys = new Set([
    'stitchOp','stitchAssignedOn','stitchApprovedOn','stitchInQty','stitchOutQty','stitchPendingQty','stitchStatus','stitchInline',
    'assemblyOp','assemblyAssignedOn','assemblyApprovedOn','assemblyInQty','assemblyOutQty','assemblyPendingQty','assemblyStatus','assemblyInline',
    'washingOp','washingAssignedOn','washingApprovedOn','washingInQty_in','washingOutQty','washingPendingQty','washingStatus','washingInline',
    'washInOp','washInAssignedOn','washInApprovedOn','washInInQty','washInOutQty','washInPendingQty','washInStatus','washInInline',
    'rewashRequestedQty','rewashPendingQty','rewashCompletedQty',
    'finishingOp','finishingAssignedOn','finishingApprovedOn','finishingInQty','finishingOutQty','finishingPendingQty','finishingStatus',
    'stitchRejectQty','stitchRejectReasons','washInRejectQty','washInRejectReasons','finishingRejectQty','finishingRejectReasons','totalRejectQty',
  ]);
  for (const c of PIC_REPORT_V2_COLUMNS) {
    if (stageColKeys.has(c.key)) sizeCols.push(c);
  }
  sizeCols.push({ header: 'Dispatched Qty',       key: 'dispatchedQty', width: 12 });
  sizeCols.push({ header: 'Dispatch Destination', key: 'destinations',  width: 26 });
  sheet.columns = sizeCols;

  for (const r of finalData) sheet.addRow(r);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', xSplit: 6, ySplit: 1 }];
  return workbook;
}

module.exports = {
  isDenimLot,
  parseLotRemark,
  fmtIST,
  daysSince,
  classifyStage,
  buildEnhancedRow,
  PIC_REPORT_V2_COLUMNS,
  fetchLotEventAggregates,
  fetchLotSizeEventSums,
  getDepartmentStatuses,
  filterByDept,
  buildPicSizeRows,
  buildPicSizeWorkbook,
};
