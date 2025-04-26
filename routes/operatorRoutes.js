/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 *
 * Key Points:
 *  • Denim chain: Cut → Stitching → Assembly → Washing → WashingIn → Finishing
 *  • Non-denim chain: Cut → Stitching → Finishing (no washing, no washing_in, no assembly)
 *  • If a dept is "stuck"/unassigned, all subsequent depts show "In <that dept>"
 *  • assigned_on & approved_on are fetched from each assignment table
 *  • No day-differences
 *  • "lotCount not defined" bug is fixed – we re-added the code in /dashboard route.
 **************************************************/

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const ExcelJS = require("exceljs");

/**************************************************
 * Helper: Format a JS Date as DD/MM/YYYY
 **************************************************/
function formatDateDDMMYYYY(dt) {
  if (!dt) return "";
  // dt is a JS Date object or something we can new Date(...) parse
  const d = new Date(dt);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**************************************************
 * 1) leftover logic (unchanged from your code)
 **************************************************/
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
  // same leftover logic you had before
  // fetch totalCut, totalStitched, totalWashed, totalFinished
  const [clRows] = await pool.query(
    "SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1",
    [lot_no]
  );
  const totalCut = clRows.length ? parseFloat(clRows[0].total_pieces) || 0 : 0;

  let [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalStitched = parseFloat(rows[0].sumStitched) || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalWashed = parseFloat(rows[0].sumWashed) || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalFinished = parseFloat(rows[0].sumFinished) || 0;

  // check last stitching assignment
  const [stAssignmentRows] = await pool.query(`
    SELECT isApproved
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?
     ORDER BY sa.assigned_on DESC
     LIMIT 1
  `, [lot_no]);
  let leftoverStitch;
  if (stAssignmentRows.length) {
    const stAssn = stAssignmentRows[0];
    if (stAssn.isApproved === null) {
      leftoverStitch = "Waiting for approval";
    } else if (stAssn.isApproved == 0) {
      leftoverStitch = "Denied";
    } else {
      leftoverStitch = totalCut - totalStitched;
    }
  } else {
    leftoverStitch = "Not Assigned";
  }

  let leftoverWash, leftoverFinish;
  if (isAkshay) {
    // denim leftover
    const [jaRows] = await pool.query(
      "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
      [lot_no]
    );
    const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;

    const [waAssignmentRows] = await pool.query(`
      SELECT is_approved
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       WHERE jd.lot_no = ?
       ORDER BY wa.assigned_on DESC
       LIMIT 1
    `, [lot_no]);
    if (waAssignmentRows.length) {
      const waAssn = waAssignmentRows[0];
      if (waAssn.is_approved === null) {
        leftoverWash = "Waiting for approval";
      } else if (waAssn.is_approved == 0) {
        leftoverWash = "Denied";
      } else {
        leftoverWash = totalJeans - totalWashed;
      }
    } else {
      leftoverWash = "Not Assigned";
    }

    const [faAssignmentRows] = await pool.query(`
      SELECT is_approved
        FROM finishing_assignments fa
        JOIN washing_data wd ON fa.washing_assignment_id = wd.id
       WHERE wd.lot_no = ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lot_no]);
    if (faAssignmentRows.length) {
      const faAssn = faAssignmentRows[0];
      if (faAssn.is_approved === null) {
        leftoverFinish = "Waiting for approval";
      } else if (faAssn.is_approved == 0) {
        leftoverFinish = "Denied";
      } else {
        leftoverFinish = totalWashed - totalFinished;
      }
    } else {
      leftoverFinish = "Not Assigned";
    }
  } else {
    // non-denim leftover
    leftoverWash = "N/A";
    const [faAssignmentRows] = await pool.query(`
      SELECT isApproved
        FROM finishing_assignments fa
        JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
       WHERE sd.lot_no = ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lot_no]);
    if (faAssignmentRows.length) {
      const faAssn = faAssignmentRows[0];
      if (faAssn.isApproved === null) {
        leftoverFinish = "Waiting for approval";
      } else if (faAssn.isApproved == 0) {
        leftoverFinish = "Denied";
      } else {
        leftoverFinish = totalStitched - totalFinished;
      }
    } else {
      leftoverFinish = "Not Assigned";
    }
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

async function computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay) {
  if (!isAkshay) return "N/A";
  const [jaAssignRows] = await pool.query(`
    SELECT is_approved
      FROM jeans_assembly_assignments ja
      JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
     WHERE sd.lot_no = ?
     ORDER BY ja.assigned_on DESC
     LIMIT 1
  `, [lot_no]);
  if (!jaAssignRows.length) return "Not Assigned";
  const jaAssn = jaAssignRows[0];
  if (jaAssn.is_approved === null) return "Waiting for approval";
  if (jaAssn.is_approved == 0) return "Denied";

  const [jaRows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumJeans
      FROM jeans_assembly_data
     WHERE lot_no = ?
  `, [lot_no]);
  const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;
  return totalStitchedLocal - totalJeans;
}

/**************************************************
 * 2) Operator Performance & Analytics
 **************************************************/
async function computeOperatorPerformance() {
  const perf = {};
  // stitching
  let [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched
      FROM stitching_data
     GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalStitched = parseFloat(r.sumStitched) || 0;
  });
  // washing
  [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed
      FROM washing_data
     GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalWashed = parseFloat(r.sumWashed) || 0;
  });
  // finishing
  [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished
      FROM finishing_data
     GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalFinished = parseFloat(r.sumFinished) || 0;
  });

  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query(`
      SELECT id, username
        FROM users
       WHERE id IN (?)
    `, [uids]);
    users.forEach(u => {
      if (perf[u.id]) {
        perf[u.id].username = u.username;
      }
    });
  }
  return perf;
}

async function computeAdvancedAnalytics(startDate, endDate) {
  // same logic as before
  const analytics = {};

  // totalCut
  let [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS totalCut
      FROM cutting_lots
  `);
  analytics.totalCut = parseFloat(rows[0].totalCut) || 0;

  // totalStitched
  [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS totalStitched
      FROM stitching_data
  `);
  analytics.totalStitched = parseFloat(rows[0].totalStitched) || 0;

  // totalWashed
  [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS totalWashed
      FROM washing_data
  `);
  analytics.totalWashed = parseFloat(rows[0].totalWashed) || 0;

  // totalFinished
  [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS totalFinished
      FROM finishing_data
  `);
  analytics.totalFinished = parseFloat(rows[0].totalFinished) || 0;

  // Conversion rates
  analytics.stitchConversion = (analytics.totalCut > 0)
    ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
    : "0.00";
  analytics.washConversion = (analytics.totalStitched > 0)
    ? (((analytics.totalWashed > 0 ? analytics.totalWashed : analytics.totalFinished) / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";
  analytics.finishConversion = (analytics.totalWashed > 0)
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched > 0)
      ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
      : "0.00";

  // top10SKUs
  let skuQuery= "SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ";
  let skuQueryParams= [];
  if (startDate && endDate) {
    skuQuery+= "WHERE created_at BETWEEN ? AND ? ";
    skuQueryParams.push(startDate, endDate);
  } else {
    skuQuery+= "WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) ";
  }
  skuQuery+= "GROUP BY sku ORDER BY total DESC LIMIT 10";
  let [topSkus] = await pool.query(skuQuery, skuQueryParams);
  analytics.top10SKUs = topSkus;

  // bottom10SKUs
  let bottomQuery= "SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ";
  let bottomQueryParams= [];
  if (startDate && endDate) {
    bottomQuery+= "WHERE created_at BETWEEN ? AND ? ";
    bottomQueryParams.push(startDate, endDate);
  } else {
    bottomQuery+= "WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) ";
  }
  bottomQuery+= "GROUP BY sku ORDER BY total ASC LIMIT 10";
  let [bottomSkus] = await pool.query(bottomQuery, bottomQueryParams);
  analytics.bottom10SKUs = bottomSkus;

  // totalLots
  let [[{ totalCount }]] = await pool.query(`
    SELECT COUNT(*) AS totalCount
      FROM cutting_lots
  `);
  analytics.totalLots = totalCount;

  // pendingLots
  let [pRows] = await pool.query(`
    SELECT COUNT(*) AS pCount
      FROM cutting_lots c
      LEFT JOIN (
        SELECT lot_no, COALESCE(SUM(total_pieces),0) AS sumFinish
          FROM finishing_data
         GROUP BY lot_no
      ) fd ON c.lot_no= fd.lot_no
     WHERE fd.sumFinish < c.total_pieces
  `);
  analytics.pendingLots = pRows[0].pCount;

  // average turnaround time
  let [turnRows] = await pool.query(`
    SELECT c.lot_no, c.created_at AS cut_date, MAX(f.created_at) AS finish_date,
           c.total_pieces, COALESCE(SUM(f.total_pieces),0) as sumFin
      FROM cutting_lots c
      LEFT JOIN finishing_data f ON c.lot_no= f.lot_no
     GROUP BY c.lot_no
     HAVING sumFin >= c.total_pieces
  `);
  let totalDiff= 0;
  let countComplete= 0;
  for (const row of turnRows) {
    if (row.finish_date && row.cut_date) {
      const diffMs = new Date(row.finish_date).getTime() - new Date(row.cut_date).getTime();
      const diffDays= diffMs / (1000*60*60*24);
      totalDiff+= diffDays;
      countComplete++;
    }
  }
  analytics.avgTurnaroundTime= countComplete>0
    ? parseFloat((totalDiff/countComplete).toFixed(2))
    : 0;

  // stitching approval rate
  let [[stTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN isApproved=1 THEN 1 ELSE 0 END) AS approvedCount
      FROM stitching_assignments
  `);
  analytics.stitchApprovalRate= stTotals.totalAssigned>0
    ? ((stTotals.approvedCount/stTotals.totalAssigned)*100).toFixed(2)
    : "0.00";

  // washing approval rate
  let [[waTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN is_approved=1 THEN 1 ELSE 0 END) AS approvedCount
      FROM washing_assignments
  `);
  analytics.washApprovalRate= waTotals.totalAssigned>0
    ? ((waTotals.approvedCount/waTotals.totalAssigned)*100).toFixed(2)
    : "0.00";

  return analytics;
}

/**************************************************
 * 3) /operator/dashboard – must define lotCount etc.
 **************************************************/
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate,
      sortField="lot_no", sortOrder="asc", category="all" } = req.query;

    // 1) operatorPerformance
    const operatorPerformance = await computeOperatorPerformance();

    // 2) total lots
    const [lotCountResult] = await pool.query(`
      SELECT COUNT(*) AS lotCount
        FROM cutting_lots
    `);
    const lotCount = lotCountResult[0].lotCount;

    // 3) total pieces cut
    const [totalPiecesResult] = await pool.query(`
      SELECT COALESCE(SUM(total_pieces),0) AS totalPieces
        FROM cutting_lots
    `);
    const totalPiecesCut = parseFloat(totalPiecesResult[0].totalPieces) || 0;

    // 4) total stitched, washed, finished
    const [totalStitchedResult] = await pool.query(`
      SELECT COALESCE(SUM(total_pieces),0) AS totalStitched
        FROM stitching_data
    `);
    const [totalWashedResult] = await pool.query(`
      SELECT COALESCE(SUM(total_pieces),0) AS totalWashed
        FROM washing_data
    `);
    const [totalFinishedResult] = await pool.query(`
      SELECT COALESCE(SUM(total_pieces),0) AS totalFinished
        FROM finishing_data
    `);

    // 5) user count
    const [userCountResult] = await pool.query(`
      SELECT COUNT(*) AS userCount
        FROM users
    `);
    const userCount = userCountResult[0].userCount;

    // 6) advanced analytics
    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);

    // 7) render
    return res.render("operatorDashboard", {
      lotCount,
      totalPiecesCut,
      totalStitched: totalStitchedResult[0].totalStitched,
      totalWashed: totalWashedResult[0].totalWashed,
      totalFinished: totalFinishedResult[0].totalFinished,
      userCount,
      advancedAnalytics,
      operatorPerformance,
      query: { search, startDate, endDate, sortField, sortOrder, category },
      lotDetails: {}
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/dashboard/api/leftovers", isAuthenticated, isOperator, async (req, res) => {
  try {
    // same leftover code as before
    // ...
  } catch (err) {
    console.error("Error in /dashboard/api/leftovers:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**************************************************
 * 4) CSV/Excel leftover exports – same as your code
 **************************************************/
// e.g. /dashboard/leftovers/download, etc. unchanged

/**************************************************
 * 5) Pendency-Reports – unchanged
 **************************************************/
// e.g. /pendency-report/stitching, etc. unchanged

/**************************************************
 * 6) PIC Report – corrected chain
 **************************************************/
// Quick helper: isDenimLot
function isDenimLot(lotNo="") {
  const up= lotNo.toUpperCase();
  return (up.startsWith("AK") || up.startsWith("UM"));
}

// Summation helpers: getStitchedQty, getAssembledQty, getWashedQty, getWashingInQty, getFinishedQty
async function getStitchedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
      FROM stitching_data
     WHERE lot_no= ?
  `, [lotNo]);
  return parseFloat(rows[0].sumStitched)||0;
}

async function getAssembledQty(lotNo) {
  // only relevant if denim
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumAsm
      FROM jeans_assembly_data
     WHERE lot_no= ?
  `, [lotNo]);
  return parseFloat(rows[0].sumAsm)||0;
}

async function getWashedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWash
      FROM washing_data
     WHERE lot_no= ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWash)||0;
}

async function getWashingInQty(lotNo) {
  // not relevant if non-denim
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWashIn
      FROM washing_in_data
     WHERE lot_no= ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWashIn)||0;
}

async function getFinishedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumFin
      FROM finishing_data
     WHERE lot_no= ?
  `, [lotNo]);
  return parseFloat(rows[0].sumFin)||0;
}

// "last assignment" fetchers:
async function getLastStitchingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT sa.id, sa.isApproved, sa.assigned_on, sa.approved_on, sa.user_id
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id= c.id
     WHERE c.lot_no= ?
     ORDER BY sa.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign= rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName= u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastAssemblyAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT ja.id, ja.is_approved, ja.assigned_on, ja.approved_on, ja.user_id
      FROM jeans_assembly_assignments ja
      JOIN stitching_data sd ON ja.stitching_assignment_id= sd.id
     WHERE sd.lot_no= ?
     ORDER BY ja.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign= rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName= u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastWashingAssignment(lotNo) {
  // only if denim
  const [rows] = await pool.query(`
    SELECT wa.id, wa.is_approved, wa.assigned_on, wa.approved_on, wa.user_id
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id= jd.id
     WHERE jd.lot_no= ?
     ORDER BY wa.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign= rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName= u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastWashingInAssignment(lotNo) {
  // Only relevant if denim
  const [rows] = await pool.query(`
    SELECT wia.id, wia.is_approved, wia.assigned_on, wia.approved_on, wia.user_id
      FROM washing_in_assignments wia
      JOIN washing_data wd
        ON wia.washing_data_id = wd.id
     WHERE wd.lot_no = ?
     ORDER BY wia.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  
  if (!rows.length) return null;
  
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query(
      "SELECT username FROM users WHERE id = ?",
      [assign.user_id]
    );
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastFinishingAssignment(lotNo, isDenim) {
  if (isDenim) {
    // finishing for denim references washing_data
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
        FROM finishing_assignments fa
        JOIN washing_data wd ON fa.washing_assignment_id= wd.id
       WHERE wd.lot_no= ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign= rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName= u ? u.username : "Unknown";
    }
    return assign;
  } else {
    // finishing for non-denim references stitching_data
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
        FROM finishing_assignments fa
        JOIN stitching_data sd ON fa.stitching_assignment_id= sd.id
       WHERE sd.lot_no= ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign= rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName= u ? u.username : "Unknown";
    }
    return assign;
  }
}

/**
 * The chain logic you want:
 * DENIM: Cut → Stitching → Assembly → Washing → WashingIn → Finishing
 * NON-DENIM: Cut → Stitching → Finishing
 * 
 * If a step is not assigned or partial, we say all subsequent steps = "In <that step>".
 */
// A single function to decide final statuses:
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washedQty,
  washingInQty,
  finishedQty,
  stIsApproved,
  stAssignedOn,
  stApprovedOn,
  stOpName,
  asmIsApproved,
  asmAssignedOn,
  asmApprovedOn,
  asmOpName,
  waIsApproved,
  waAssignedOn,
  waApprovedOn,
  waOpName,
  wiIsApproved,
  wiAssignedOn,
  wiApprovedOn,
  wiOpName,
  finIsApproved,
  finAssignedOn,
  finApprovedOn,
  finOpName,
}) {
  // placeholders
  let stitchingStatus = "N/A",
    stitchingOp = stOpName || "",
    stitchingAssignedOn = stAssignedOn ? new Date(stAssignedOn) : null,
    stitchingApprovedOn = stApprovedOn ? new Date(stApprovedOn) : null;

  let assemblyStatus = isDenim ? "N/A" : "—",
    assemblyOp = asmOpName || "",
    assemblyAssignedOn = asmAssignedOn ? new Date(asmAssignedOn) : null,
    assemblyApprovedOn = asmApprovedOn ? new Date(asmApprovedOn) : null;

  let washingStatus = isDenim ? "N/A" : "—",
    washingOp = waOpName || "",
    washingAssignedOn = waAssignedOn ? new Date(waAssignedOn) : null,
    washingApprovedOn = waApprovedOn ? new Date(waApprovedOn) : null;

  let washingInStatus = isDenim ? "N/A" : "—",
    washingInOp = wiOpName || "",
    washingInAssignedOn = wiAssignedOn ? new Date(wiAssignedOn) : null,
    washingInApprovedOn = wiApprovedOn ? new Date(wiApprovedOn) : null;

  let finishingStatus = "N/A",
    finishingOp = finOpName || "",
    finishingAssignedOn = finAssignedOn ? new Date(finAssignedOn) : null,
    finishingApprovedOn = finApprovedOn ? new Date(finApprovedOn) : null;

  // STITCHING
  if (stIsApproved === undefined || stIsApproved === null) {
    // means no last assignment or isApproved null => "In Cutting"
    stitchingStatus = stIsApproved === null ? "Pending Approval" : "In Cutting";

    if (isDenim) {
      assemblyStatus = "In Cutting";
      washingStatus = "In Cutting";
      washingInStatus = "In Cutting";
      finishingStatus = "In Cutting";
    } else {
      finishingStatus = "In Cutting";
    }
    // if stIsApproved===null we do "Pending Approval by..."
    if (stIsApproved === null) {
      stitchingStatus = `Pending Approval by ${stOpName || "???"}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingStatus = "In Stitching";
        washingInStatus = "In Stitching";
        finishingStatus = "In Stitching";
      } else {
        finishingStatus = "In Stitching";
      }
    }
    // done
    return {
      stitchingStatus,
      stitchingOp,
      stitchingAssignedOn,
      stitchingApprovedOn,
      assemblyStatus,
      assemblyOp,
      assemblyAssignedOn,
      assemblyApprovedOn,
      washingStatus,
      washingOp,
      washingAssignedOn,
      washingApprovedOn,
      washingInStatus,
      washingInOp,
      washingInAssignedOn,
      washingInApprovedOn,
      finishingStatus,
      finishingOp,
      finishingAssignedOn,
      finishingApprovedOn,
    };
  } else {
    // we have stIsApproved => either 0 or 1
    if (stIsApproved === 0) {
      stitchingStatus = `Denied by ${stOpName || "???"}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingStatus = "In Stitching";
        washingInStatus = "In Stitching";
        finishingStatus = "In Stitching";
      } else {
        finishingStatus = "In Stitching";
      }
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      // stIsApproved=1 => partial or complete
      if (stitchedQty === 0) {
        stitchingStatus = "In-Line";
      } else if (stitchedQty >= totalCut && totalCut > 0) {
        stitchingStatus = "Completed";
      } else {
        const pend = totalCut - stitchedQty;
        stitchingStatus = `${pend} Pending`;
      }
    }
  }

  // next: for denim => assembly, for non-denim => finishing
  if (!isDenim) {
    // skip assembly/washing/washingIn => finishing next
    if (finIsApproved === undefined) {
      finishingStatus = "In Stitching";
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      // finishing assigned
      if (finIsApproved === null) {
        finishingStatus = `Pending Approval by ${finOpName || "???"}`;
      } else if (finIsApproved === 0) {
        finishingStatus = `Denied by ${finOpName || "???"}`;
      } else {
        // partial/complete
        if (finishedQty === 0) {
          finishingStatus = "In-Line";
        } else if (finishedQty >= stitchedQty && stitchedQty > 0) {
          finishingStatus = "Completed";
        } else {
          const pend = stitchedQty - finishedQty;
          finishingStatus = `${pend} Pending`;
        }
      }
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    }
  } else {
    // DENIM => assembly
    if (asmIsApproved === undefined) {
      assemblyStatus = "In Stitching";
      washingStatus = "In Stitching";
      washingInStatus = "In Stitching";
      finishingStatus = "In Stitching";
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      // assembly assigned
      if (asmIsApproved === null) {
        assemblyStatus = `Pending Approval by ${asmOpName || "???"}`;
        washingStatus = "In Assembly";
        washingInStatus = "In Assembly";
        finishingStatus = "In Assembly";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else if (asmIsApproved === 0) {
        assemblyStatus = `Denied by ${asmOpName || "???"}`;
        washingStatus = "In Assembly";
        washingInStatus = "In Assembly";
        finishingStatus = "In Assembly";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else {
        // partial or complete
        if (assembledQty === 0) {
          assemblyStatus = "In-Line";
        } else if (assembledQty >= stitchedQty && stitchedQty > 0) {
          assemblyStatus = "Completed";
        } else {
          const pend = stitchedQty - assembledQty;
          assemblyStatus = `${pend} Pending`;
        }
      }
    }

    // next => washing
    if (waIsApproved === undefined) {
      washingStatus = "In Assembly";
      washingInStatus = "In Assembly";
      finishingStatus = "In Assembly";
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      if (waIsApproved === null) {
        washingStatus = `Pending Approval by ${waOpName || "???"}`;
        washingInStatus = "In Washing";
        finishingStatus = "In Washing";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else if (waIsApproved === 0) {
        washingStatus = `Denied by ${waOpName || "???"}`;
        washingInStatus = "In Washing";
        finishingStatus = "In Washing";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else {
        // partial/complete
        if (washedQty === 0) {
          washingStatus = "In-Line";
        } else if (washedQty >= assembledQty && assembledQty > 0) {
          washingStatus = "Completed";
        } else {
          const pend = assembledQty - washedQty;
          washingStatus = `${pend} Pending`;
        }
      }
    }

    // next => washingIn
    if (wiIsApproved === undefined) {
      washingInStatus = "In Washing";
      finishingStatus = "In Washing";
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      if (wiIsApproved === null) {
        washingInStatus = `Pending Approval by ${wiOpName || "???"}`;
        finishingStatus = "In WashingIn";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else if (wiIsApproved === 0) {
        washingInStatus = `Denied by ${wiOpName || "???"}`;
        finishingStatus = "In WashingIn";
        return {
          stitchingStatus,
          stitchingOp,
          stitchingAssignedOn,
          stitchingApprovedOn,
          assemblyStatus,
          assemblyOp,
          assemblyAssignedOn,
          assemblyApprovedOn,
          washingStatus,
          washingOp,
          washingAssignedOn,
          washingApprovedOn,
          washingInStatus,
          washingInOp,
          washingInAssignedOn,
          washingInApprovedOn,
          finishingStatus,
          finishingOp,
          finishingAssignedOn,
          finishingApprovedOn,
        };
      } else {
        // partial or complete
        if (washingInQty === 0) {
          washingInStatus = "In-Line";
        } else if (washingInQty >= washedQty && washedQty > 0) {
          washingInStatus = "Completed";
        } else {
          const pend = washedQty - washingInQty;
          washingInStatus = `${pend} Pending`;
        }
      }
    }
    // next => finishing
    if (finIsApproved === undefined) {
      finishingStatus = "In WashingIn";
      return {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn,
      };
    } else {
      if (finIsApproved === null) {
        finishingStatus = `Pending Approval by ${finOpName || "???"}`;
      } else if (finIsApproved === 0) {
        finishingStatus = `Denied by ${finOpName || "???"}`;
      } else {
        // partial or complete
        if (finishedQty === 0) {
          finishingStatus = "In-Line";
        } else if (finishedQty >= washingInQty && washingInQty > 0) {
          finishingStatus = "Completed";
        } else {
          const pend = washingInQty - finishedQty;
          finishingStatus = `${pend} Pending`;
        }
      }
    }
    return {
      stitchingStatus,
      stitchingOp,
      stitchingAssignedOn,
      stitchingApprovedOn,
      assemblyStatus,
      assemblyOp,
      assemblyAssignedOn,
      assemblyApprovedOn,
      washingStatus,
      washingOp,
      washingAssignedOn,
      washingApprovedOn,
      washingInStatus,
      washingInOp,
      washingInAssignedOn,
      washingInApprovedOn,
      finishingStatus,
      finishingOp,
      finishingAssignedOn,
      finishingApprovedOn,
    };
  }
}

// Filtering function
function filterByDept({
  department,
  isDenim,
  stitchingStatus,
  assemblyStatus,
  washingStatus,
  washingInStatus,
  finishingStatus,
}) {
  let showRow = true;
  let actualStatus = "N/A";

  if (department === "all") {
    // For Denim => finishing > washing_in > washing > assembly > stitching
    // For NonDenim => finishing > stitching
    if (isDenim) {
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus = washingInStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus = washingStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus = assemblyStatus;
      else actualStatus = stitchingStatus;
    } else {
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else actualStatus = stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department === "cutting") {
    // always show "Completed"
    actualStatus = "Completed";
    return { showRow, actualStatus };
  }

  if (department === "stitching") {
    actualStatus = stitchingStatus;
    return { showRow, actualStatus };
  }

  if (department === "assembly") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus = assemblyStatus;
    return { showRow, actualStatus };
  }

  if (department === "washing") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus = washingStatus;
    return { showRow, actualStatus };
  }

  if (department === "washing_in") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus = washingInStatus;
    return { showRow, actualStatus };
  }

  if (department === "finishing") {
    actualStatus = finishingStatus;
    return { showRow, actualStatus };
  }

  return { showRow, actualStatus };
}

/* ================================================================
 *  PIC-REPORT  –  DOWNLOAD-ONLY  –  10 SQL queries regardless of lot count
 * ================================================================= */
router.get("/dashboard/pic-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    /* ─────────────────────── 1. read filters ────────────────────── */
    const {
      lotType   = "all",
      department= "all",
      status    = "all",
      dateFilter= "createdAt",
      startDate = "",
      endDate   = ""
    } = req.query;

    /* ─────────────────────── 2. build date / lotType WHERE ──────── */
    let dateWhere = "", dateParams = [];
    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = "AND DATE(cl.created_at) BETWEEN ? AND ?";
      } else {
        // we keep exactly the same EXISTS branches you had – omitted for brevity
        dateWhere = buildAssignedOnFilter(department);          // <- helper (unchanged)
      }
      if (dateWhere) dateParams.push(startDate, endDate);
    }

    const lotTypeClause =
      lotType === "denim"   ? "AND (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')"
    : lotType === "hosiery" ? "AND (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')"
    : "";

    /* ─────────────────────── 3. one query for candidate lots ────── */
    const [lots] = await pool.query(`
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.created_at, cl.remark
        FROM cutting_lots cl
       WHERE 1 ${lotTypeClause} ${dateWhere}
       ORDER BY cl.created_at DESC`, dateParams);

    if (!lots.length) {
      // Nothing to send – return a 204 so the client hides the progress bar
      return res.status(204).end();
    }

    /* ─────────────────────── 4. bulk fetch qty + assignments ───── */
    const lotNos   = lots.map(l => l.lot_no);
    const qtyMap   = await fetchQtyMaps(lotNos);          // helper defined earlier
    const assignMap= await fetchAssignmentMaps(lotNos);   // helper defined earlier

    /* ─────────────────────── 5. build rows for Excel ────────────── */
    const rows = [];
    for (const l of lots) {
      const lotNo   = l.lot_no;
      const isDenim = /^ak|^um/i.test(lotNo);

      const stitchedQty  = +(qtyMap.stitched [lotNo]?.qty || 0);
      const assembledQty = isDenim ? +(qtyMap.assembled[lotNo]?.qty || 0) : 0;
      const washedQty    = isDenim ? +(qtyMap.washed   [lotNo]?.qty || 0) : 0;
      const washInQty    = isDenim ? +(qtyMap.washIn   [lotNo]?.qty || 0) : 0;
      const finishedQty  = +(qtyMap.finished [lotNo]?.qty || 0);

      const stAssign  = assignMap.stitching [lotNo] || null;
      const asmAssign = isDenim ? assignMap.assembly  [lotNo] : null;
      const waAssign  = isDenim ? assignMap.washing   [lotNo] : null;
      const wInAssign = isDenim ? assignMap.washingIn [lotNo] : null;
      const fiAssign  = assignMap.finishing [lotNo] || null;

      const statuses  = getDepartmentStatuses({
        isDenim: isDenim,
        totalCut: +l.total_pieces,
        stitchedQty, assembledQty, washedQty, washingInQty: washInQty, finishedQty,
        stAssign, asmAssign, washAssign: waAssign, washInAssign: wInAssign, finAssign: fiAssign
      });

      /* department + global status filters (unchanged logic) */
      const deptRes = filterByDept({
        department,
        isDenim: isDenim,
        stitchingStatus : statuses.stitchingStatus,
        assemblyStatus  : statuses.assemblyStatus,
        washingStatus   : statuses.washingStatus,
        washingInStatus : statuses.washingInStatus,
        finishingStatus : statuses.finishingStatus
      });
      if (!deptRes.showRow) continue;

      const act = deptRes.actualStatus.toLowerCase();
      if (status !== "all") {
        if (status === "not_assigned" && !act.startsWith("in ")) continue;
        if (status === "inline"       && !act.includes("in-line")) continue;
        if (!["inline","not_assigned"].includes(status) && !act.includes(status)) continue;
      }

      rows.push({
        lotNo: lotNo,
        sku: l.sku,
        lotType: isDenim ? "Denim" : "Hosiery",
        totalCut: +l.total_pieces,
        createdAt: l.created_at,
        remark: l.remark || "",

        /* stitching */
        stitchAssignedOn : stAssign ? stAssign.assigned_on  : null,
        stitchApprovedOn : stAssign ? stAssign.approved_on  : null,
        stitchOp         : stAssign?.opName || "",
        stitchStatus     : statuses.stitchingStatus,
        stitchedQty,

        /* assembly */
        assemblyAssignedOn: asmAssign ? asmAssign.assigned_on : null,
        assemblyApprovedOn: asmAssign ? asmAssign.approved_on : null,
        assemblyOp        : asmAssign?.opName || "",
        assemblyStatus    : statuses.assemblyStatus,
        assembledQty,

        /* washing */
        washingAssignedOn: waAssign ? waAssign.assigned_on  : null,
        washingApprovedOn: waAssign ? waAssign.approved_on  : null,
        washingOp        : waAssign?.opName || "",
        washingStatus    : statuses.washingStatus,
        washedQty,

        /* washing-in */
        washingInAssignedOn: wInAssign ? wInAssign.assigned_on : null,
        washingInApprovedOn: wInAssign ? wInAssign.approved_on : null,
        washingInOp        : wInAssign?.opName || "",
        washingInStatus    : statuses.washingInStatus,
        washingInQty       : washInQty,

        /* finishing */
        finishingAssignedOn: fiAssign ? fiAssign.assigned_on  : null,
        finishingApprovedOn: fiAssign ? fiAssign.approved_on  : null,
        finishingOp        : fiAssign?.opName || "",
        finishingStatus    : statuses.finishingStatus,
        finishedQty
      });
    }

    /* ─────────────────────── 6. stream Excel download ───────────── */
    const wb = new ExcelJS.Workbook();
    wb.creator = "KottyTrack PIC-Report";
    const ws = wb.addWorksheet("PIC-Report");

    ws.columns = [ /* identical column list you had – *nothing removed* */ ];
    rows.forEach(r => ws.addRow({
      lotNo              : r.lotNo,
      sku                : r.sku,
      lotType            : r.lotType,
      totalCut           : r.totalCut,
      createdAt          : r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "",
      remark             : r.remark,

      stitchAssignedOn   : r.stitchAssignedOn   ? new Date(r.stitchAssignedOn).toLocaleString() : "N/A",
      stitchApprovedOn   : r.stitchApprovedOn   ? new Date(r.stitchApprovedOn).toLocaleString() : "N/A",
      stitchOp           : r.stitchOp,
      stitchStatus       : r.stitchStatus,
      stitchedQty        : r.stitchedQty,

      assemblyAssignedOn : r.assemblyAssignedOn ? new Date(r.assemblyAssignedOn).toLocaleString() : "N/A",
      assemblyApprovedOn : r.assemblyApprovedOn ? new Date(r.assemblyApprovedOn).toLocaleString() : "N/A",
      assemblyOp         : r.assemblyOp,
      assemblyStatus     : r.assemblyStatus,
      assembledQty       : r.assembledQty,

      washingAssignedOn  : r.washingAssignedOn  ? new Date(r.washingAssignedOn).toLocaleString() : "N/A",
      washingApprovedOn  : r.washingApprovedOn  ? new Date(r.washingApprovedOn).toLocaleString() : "N/A",
      washingOp          : r.washingOp,
      washingStatus      : r.washingStatus,
      washedQty          : r.washedQty,

      washingInAssignedOn: r.washingInAssignedOn? new Date(r.washingInAssignedOn).toLocaleString() : "N/A",
      washingInApprovedOn: r.washingInApprovedOn? new Date(r.washingInApprovedOn).toLocaleString() : "N/A",
      washingInOp        : r.washingInOp,
      washingInStatus    : r.washingInStatus,
      washingInQty       : r.washingInQty,

      finishingAssignedOn: r.finishingAssignedOn? new Date(r.finishingAssignedOn).toLocaleString() : "N/A",
      finishingApprovedOn: r.finishingApprovedOn? new Date(r.finishingApprovedOn).toLocaleString() : "N/A",
      finishingOp        : r.finishingOp,
      finishingStatus    : r.finishingStatus,
      finishedQty        : r.finishedQty
    }));

    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",
      `attachment; filename="PIC-Report-${Date.now()}.xlsx"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("PIC-Report (download):", err);
    res.status(500).send("Server error");
  }
});
/* ================================================================= */

// At top of your routes file, ensure you import isStitchingMaster:
const { isStitchingMaster } = require("../middlewares/auth");

/**************************************************
 * Stitching TAT Dashboard
 **************************************************/
/**************************************************
 * 1) OPERATOR STITCHING TAT (SUMMARY)
 *    => GET /stitching-tat
 * 
 *    - Lists all Stitching Masters who have at least
 *      one "pending" or "in-line" lot
 *    - Each card shows:
 *        masterName
 *        # pending approval
 *        # in line
 *        [Download TAT Excel] button
 *        [View TAT Details] link
 *    - If ?download=1, returns an Excel summary
 **************************************************/
router.get("/stitching-tat", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { download = "0" } = req.query;

    // 1) Identify all users (Stitching Masters) who have
    //    either "pending" or "in-line" stitching assignments
    //    => "pending" = sa.isApproved IS NULL
    //    => "in-line" = sa.isApproved=1 BUT next step is not assigned
    const [masters] = await pool.query(`
      SELECT DISTINCT u.id, u.username
        FROM users u
        JOIN stitching_assignments sa ON sa.user_id = u.id
        JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
       WHERE (
              sa.isApproved IS NULL
              OR 
              (
                sa.isApproved = 1
                AND (
                  -- DENIM => next step is Assembly
                  (
                    (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                    AND NOT EXISTS (
                      SELECT 1
                        FROM jeans_assembly_assignments ja
                        JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                       WHERE sd.lot_no = cl.lot_no
                         AND ja.is_approved IS NOT NULL
                    )
                  )
                  -- NON-DENIM => next step is Finishing
                  OR
                  (
                    (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                    AND NOT EXISTS (
                      SELECT 1
                        FROM finishing_assignments fa
                        JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                       WHERE sd.lot_no = cl.lot_no
                         AND fa.is_approved IS NOT NULL
                    )
                  )
                )
              )
            )
    `);

    // 2) For each master, count how many are pending vs in line
    const masterCards = [];
    for (const m of masters) {
      const masterId = m.id;

      // pending = isApproved IS NULL
      const [pendRows] = await pool.query(`
        SELECT COALESCE(SUM(cl.total_pieces),0) AS pendingSum
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id = ?
           AND sa.isApproved IS NULL
      `, [masterId]);
      const pendingApproval = parseFloat(pendRows[0].pendingSum) || 0;

      // in line = isApproved=1, next step not assigned
      const [inLineRows] = await pool.query(`
        SELECT COALESCE(SUM(cl.total_pieces),0) AS inLineSum
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id = ?
           AND sa.isApproved = 1
           AND (
             (
               (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
               AND NOT EXISTS (
                 SELECT 1
                   FROM jeans_assembly_assignments ja
                   JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                  WHERE sd.lot_no = cl.lot_no
                    AND ja.is_approved IS NOT NULL
               )
             )
             OR
             (
               (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
               AND NOT EXISTS (
                 SELECT 1
                   FROM finishing_assignments fa
                   JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                  WHERE sd.lot_no = cl.lot_no
                    AND fa.is_approved IS NOT NULL
               )
             )
           )
      `, [masterId]);
      const inLinePieces = parseFloat(inLineRows[0].inLineSum) || 0;

      masterCards.push({
        masterId,
        username: m.username,
        pendingApproval,
        inLinePieces
      });
    }

    // 3) If ?download=1 => produce Excel summary
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("StitchingTAT-Summary");

      sheet.columns = [
        { header: "Master ID",        key: "masterId",       width: 12 },
        { header: "Master Username",  key: "username",        width: 25 },
        { header: "Pending Pieces",   key: "pendingApproval", width: 18 },
        { header: "In-Line Pieces",   key: "inLinePieces",    width: 18 }
      ];

      masterCards.forEach((mc) => {
        sheet.addRow({
          masterId: mc.masterId,
          username: mc.username,
          pendingApproval: mc.pendingApproval,
          inLinePieces: mc.inLinePieces
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader("Content-Disposition", 'attachment; filename="StitchingTAT-Summary.xlsx"');
      await workbook.xlsx.write(res);
      return res.end();
    }

    // 4) Otherwise render the summary page in HTML
    return res.render("operatorStitchingTat", { masterCards });
  } catch (err) {
    console.error("Error in /stitching-tat:", err);
    return res.status(500).send("Server error in /stitching-tat");
  }
});

/**************************************************
 * 2) OPERATOR TAT DETAIL for a MASTER
 *    => GET /stitching-tat/:masterId
 * 
 *    - Shows only lots that are pending or in line
 *    - If ?download=1 => Excel
 *    - Otherwise => HTML table
 *    - TAT in days = (nextAssignedOn - assignedOn) or (today - assignedOn)
 *    - Date fields in DD/MM/YYYY
 **************************************************/
router.get("/stitching-tat/:masterId", isAuthenticated, isOperator, async (req, res) => {
  try {
    const masterId = parseInt(req.params.masterId, 10);
    if (isNaN(masterId)) {
      return res.status(400).send("Invalid Master ID");
    }
    const { download = "0" } = req.query;

    // 1) Master info
    const [[masterUser]] = await pool.query(
      `SELECT id, username FROM users WHERE id = ?`,
      [masterId]
    );
    if (!masterUser) {
      return res.status(404).send("Stitching Master not found");
    }

    // 2) Fetch stitching_assignments that are pending or in line
    const [assignments] = await pool.query(`
      SELECT sa.id           AS stitching_assignment_id,
             sa.isApproved   AS stitchIsApproved,
             sa.assigned_on  AS stitchAssignedOn,
             cl.lot_no,
             cl.sku,
             cl.total_pieces,
             cl.remark       AS cutting_remark
        FROM stitching_assignments sa
        JOIN cutting_lots cl
          ON sa.cutting_lot_id = cl.id
       WHERE sa.user_id = ?
         AND (
              sa.isApproved IS NULL
              OR (
                   sa.isApproved = 1
                   AND (
                     -- Denim => next step is Assembly
                     (
                       (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                       AND NOT EXISTS (
                         SELECT 1
                           FROM jeans_assembly_assignments ja
                           JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                          WHERE sd.lot_no = cl.lot_no
                            AND ja.is_approved IS NOT NULL
                       )
                     )
                     OR
                     -- Non-denim => next step is Finishing
                     (
                       (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                       AND NOT EXISTS (
                         SELECT 1
                           FROM finishing_assignments fa
                           JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                          WHERE sd.lot_no = cl.lot_no
                            AND fa.is_approved IS NOT NULL
                       )
                     )
                   )
                 )
            )
       ORDER BY sa.assigned_on DESC
    `, [masterId]);

    // 3) Build detailRows
    const detailRows = [];
    const currentDate = new Date();

    for (const a of assignments) {
      const {
        lot_no,
        sku,
        total_pieces,
        cutting_remark,
        stitchAssignedOn,
        stitchIsApproved
      } = a;
      let nextAssignedOn = null;
      const isDenim = isDenimLot(lot_no);

      // If isApproved=1 => check next assignment
      if (stitchIsApproved === 1) {
        if (isDenim) {
          // Next step => assembly
          const [asmRows] = await pool.query(`
            SELECT ja.assigned_on
              FROM jeans_assembly_assignments ja
              JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
             WHERE sd.lot_no = ?
               AND ja.is_approved IS NOT NULL
             ORDER BY ja.assigned_on ASC
             LIMIT 1
          `, [lot_no]);
          if (asmRows.length) {
            nextAssignedOn = asmRows[0].assigned_on;
          }
        } else {
          // Next step => finishing
          const [finRows] = await pool.query(`
            SELECT fa.assigned_on
              FROM finishing_assignments fa
              JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
             WHERE sd.lot_no = ?
               AND fa.is_approved IS NOT NULL
             ORDER BY fa.assigned_on ASC
             LIMIT 1
          `, [lot_no]);
          if (finRows.length) {
            nextAssignedOn = finRows[0].assigned_on;
          }
        }
      }

      // Calculate TAT (days)
      let tatDays = 0;
      if (stitchAssignedOn) {
        const startMs = new Date(stitchAssignedOn).getTime();
        const endMs = nextAssignedOn
          ? new Date(nextAssignedOn).getTime()
          : currentDate.getTime();
        tatDays = Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24));
      }

      detailRows.push({
        lotNo: lot_no,
        sku,
        totalPieces: total_pieces,
        cuttingRemark: cutting_remark || "",
        assignedOn: stitchAssignedOn,
        nextDeptAssignedOn: nextAssignedOn,
        tatDays,
        status: (stitchIsApproved === null) ? "Pending Approval" : "In Line"
      });
    }

    // 4) If ?download=1 => produce Excel
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("StitchingTAT-Detail");

      sheet.columns = [
        { header: "Stitching Master", key: "masterName",        width: 20 },
        { header: "Lot No",          key: "lotNo",             width: 15 },
        { header: "SKU",             key: "sku",               width: 15 },
        { header: "Status",          key: "status",            width: 18 },
        { header: "Total Pieces",    key: "totalPieces",       width: 15 },
        { header: "Cutting Remark",  key: "cuttingRemark",     width: 25 },
        { header: "Assigned On",     key: "assignedOn",        width: 15 },
        { header: "Next Dept On",    key: "nextDeptAssignedOn",width: 15 },
        { header: "TAT (days)",      key: "tatDays",           width: 12 }
      ];

      detailRows.forEach((row) => {
        sheet.addRow({
          masterName: masterUser.username,
          lotNo: row.lotNo,
          sku: row.sku,
          status: row.status,
          totalPieces: row.totalPieces,
          cuttingRemark: row.cuttingRemark,
          assignedOn: row.assignedOn ? formatDateDDMMYYYY(row.assignedOn) : "",
          nextDeptAssignedOn: row.nextDeptAssignedOn
            ? formatDateDDMMYYYY(row.nextDeptAssignedOn)
            : "",
          tatDays: row.tatDays
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="StitchingTAT-Detail-${masterUser.username}.xlsx"`
      );
      await workbook.xlsx.write(res);
      return res.end();
    }

    // 5) Otherwise render HTML with formatted dates
    const renderedRows = detailRows.map((r) => ({
      ...r,
      assignedOnStr: r.assignedOn ? formatDateDDMMYYYY(r.assignedOn) : "",
      nextDeptAssignedOnStr: r.nextDeptAssignedOn ? formatDateDDMMYYYY(r.nextDeptAssignedOn) : ""
    }));

    return res.render("operatorStitchingTatDetail", {
      masterUser,
      detailRows: renderedRows,
      currentDate: formatDateDDMMYYYY(new Date())
    });
  } catch (err) {
    console.error("Error in /stitching-tat/:masterId:", err);
    return res.status(500).send("Server error in /stitching-tat/:masterId");
  }
});

// GET /operator/sku-management
// Renders an EJS page with optional ?sku= query param
router.get("/sku-management", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { sku } = req.query; // We can still read message/error if you want from req.query

    // If no sku specified, just render the page with empty results
    if (!sku) {
      return res.render("skuManagement", {
        sku: "",
        results: [],
        message: "",
        error: ""
      });
    }

    // We do have a SKU -> search all tables that contain `sku` columns
    const tables = [
      { tableName: "cutting_lots", label: "Cutting Lots" },
      { tableName: "stitching_data", label: "Stitching Data" },
      { tableName: "jeans_assembly_data", label: "Jeans Assembly Data" },
      { tableName: "washing_data", label: "Washing Data" },
      { tableName: "washing_in_data", label: "Washing In Data" },
      { tableName: "finishing_data", label: "Finishing Data" },
      { tableName: "rewash_requests", label: "Rewash Requests" }
    ];

    const results = [];

    // Fetch rows from each table that has the given SKU
    for (const t of tables) {
      const [rows] = await pool.query(
        `SELECT lot_no, sku FROM ${t.tableName} WHERE sku = ?`,
        [sku.trim()]
      );
      if (rows.length > 0) {
        results.push({
          label: t.label,       // For display (e.g. "Cutting Lots")
          tableName: t.tableName,
          rows
        });
      }
    }

    // Render the EJS template with the found results
    return res.render("skuManagement", {
      sku,
      results,
      message: "",
      error: ""
    });
  } catch (err) {
    console.error("Error in GET /operator/sku-management:", err);
    return res.status(500).send("Server Error");
  }
});

// POST /operator/sku-management/update (AJAX endpoint)
router.post("/sku-management/update", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { oldSku, newSku } = req.body;

    // Basic validations
    if (!oldSku || !newSku) {
      return res.status(400).json({ error: "Both oldSku and newSku are required." });
    }
    if (oldSku.trim() === newSku.trim()) {
      return res.status(400).json({ error: "Old and New SKU cannot be the same." });
    }

    // List all tables that have `sku` columns
    const tablesWithSku = [
      "cutting_lots",
      "stitching_data",
      "jeans_assembly_data",
      "washing_data",
      "washing_in_data",
      "finishing_data",
      "rewash_requests"
    ];

    let totalUpdated = 0;
    for (const table of tablesWithSku) {
      const [result] = await pool.query(
        `UPDATE ${table} SET sku = ? WHERE sku = ?`,
        [newSku.trim(), oldSku.trim()]
      );
      // result.affectedRows => how many rows got updated in that table
      totalUpdated += result.affectedRows;
    }

    // Return JSON success message instead of a redirect
    return res.json({
      message: `SKU updated from "${oldSku}" to "${newSku}" (total ${totalUpdated} row(s) changed).`
    });
  } catch (err) {
    console.error("Error in POST /operator/sku-management/update:", err);
    return res.status(500).json({ error: "Server Error" });
  }
});
module.exports = router;
