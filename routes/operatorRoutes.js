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
      sortField="lot_no", sortOrder="asc", category="all", view } = req.query;

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


async function fetchPendencyRows(dept, searchLike, offset, limit) {
  let query = "";
  const params = [searchLike, offset, limit];
  if (dept === "assembly") {
    query = `
      SELECT ja.id AS assignment_id, sd.lot_no, u.username,
             ja.assigned_pieces AS assigned,
             COALESCE(SUM(jd.total_pieces),0) AS completed,
             ja.assigned_pieces - COALESCE(SUM(jd.total_pieces),0) AS pending
        FROM jeans_assembly_assignments ja
        JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
        JOIN users u ON ja.user_id = u.id
        LEFT JOIN jeans_assembly_data jd ON jd.assignment_id = ja.id
       WHERE sd.lot_no LIKE ?

       GROUP BY ja.id, sd.lot_no, u.username, ja.assigned_pieces

       ORDER BY ja.assigned_on DESC
       LIMIT ?, ?`;
  } else if (dept === "washing") {
    query = `
      SELECT wa.id AS assignment_id, jd.lot_no, u.username,
             wa.assigned_pieces AS assigned,
             COALESCE(SUM(wd.total_pieces),0) AS completed,
             wa.assigned_pieces - COALESCE(SUM(wd.total_pieces),0) AS pending
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        JOIN users u ON wa.user_id = u.id
        LEFT JOIN washing_data wd ON wd.washing_assignment_id = wa.id
       WHERE jd.lot_no LIKE ?

       GROUP BY wa.id, jd.lot_no, u.username, wa.assigned_pieces

       ORDER BY wa.assigned_on DESC
       LIMIT ?, ?`;
  } else {
    query = `
      SELECT sa.id AS assignment_id, c.lot_no, u.username,
             c.total_pieces AS assigned,
             COALESCE(SUM(sd.total_pieces),0) AS completed,
             c.total_pieces - COALESCE(SUM(sd.total_pieces),0) AS pending
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        JOIN users u ON sa.user_id = u.id
        LEFT JOIN stitching_data sd
               ON sd.user_id = sa.user_id
              AND sd.lot_no = c.lot_no
       WHERE c.lot_no LIKE ?

       GROUP BY sa.id, c.lot_no, u.username, c.total_pieces

       ORDER BY sa.assigned_on DESC
       LIMIT ?, ?`;
  } 

  const [rows] = await pool.query(query, params);
  return rows;
}

router.get("/dashboard/api/pendency", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { dept = "stitching", page = 1, size = 50, search = "" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(size);
    const rows = await fetchPendencyRows(dept, `%${search}%`, offset, parseInt(size));
    return res.json({ data: rows });
  } catch (err) {
    console.error("Error in /dashboard/api/pendency:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/dashboard/pendency/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { dept = "stitching", search = "" } = req.query;
    const rows = await fetchPendencyRows(dept, `%${search}%`, 0, 10000);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pendency");
    sheet.columns = [
      { header: "Lot No", key: "lot_no", width: 15 },
      { header: "Operator", key: "username", width: 20 },
      { header: "Assigned", key: "assigned", width: 12 },
      { header: "Completed", key: "completed", width: 12 },
      { header: "Pending", key: "pending", width: 12 }
    ];
    rows.forEach(r => sheet.addRow(r));
    res.setHeader("Content-Disposition", `attachment; filename="${dept}_pendency.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error in /dashboard/pendency/download:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/dashboard/api/lot", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lotNo } = req.query;
    if (!lotNo) return res.status(400).json({ error: "lotNo required" });
    const [[lot]] = await pool.query(
      `SELECT id, lot_no, sku, fabric_type, total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
      [lotNo]
    );
    if (!lot) return res.status(404).json({ error: "Lot not found" });
    const [sizes] = await pool.query(
      `SELECT size_label, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
      [lot.id]
    );
    return res.json({ lot, sizes });
  } catch (err) {
    console.error("Error in /dashboard/api/lot:", err);
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
  finAssign     // finishing_assignments
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
    stitchingAssignedOn= assigned_on? new Date(assigned_on).toLocaleString(): "N/A";
    stitchingApprovedOn= approved_on? new Date(approved_on).toLocaleString(): "N/A";

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
      // approved => partial or complete
      if (stitchedQty===0) {
        stitchingStatus= "In-Line";
      } else if (stitchedQty>= totalCut && totalCut>0) {
        stitchingStatus= "Completed";
      } else {
        const pend= totalCut- stitchedQty;
        stitchingStatus= `${pend} Pending`;
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
      assemblyAssignedOn= assigned_on? new Date(assigned_on).toLocaleString(): "N/A";
      assemblyApprovedOn= approved_on? new Date(approved_on).toLocaleString(): "N/A";

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
        // partial or complete
        if (assembledQty===0) {
          assemblyStatus= "In-Line";
        } else if (assembledQty>= stitchedQty && stitchedQty>0) {
          assemblyStatus= "Completed";
        } else {
          const pend= stitchedQty- assembledQty;
          assemblyStatus= `${pend} Pending`;
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
        washingAssignedOn= assigned_on? new Date(assigned_on).toLocaleString(): "N/A";
        washingApprovedOn= approved_on? new Date(approved_on).toLocaleString(): "N/A";

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
          // partial or complete
          if (washedQty===0) {
            washingStatus= "In-Line";
          } else if (washedQty>= assembledQty && assembledQty>0) {
            washingStatus= "Completed";
          } else {
            const pend= assembledQty- washedQty;
            washingStatus= `${pend} Pending`;
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
          washingInAssignedOn= assigned_on? new Date(assigned_on).toLocaleString(): "N/A";
          washingInApprovedOn= approved_on? new Date(approved_on).toLocaleString(): "N/A";

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
            // partial or complete
            if (washingInQty===0) {
              washingInStatus= "In-Line";
            } else if (washingInQty>= washedQty && washedQty>0) {
              washingInStatus= "Completed";
            } else {
              const pend= washedQty- washingInQty;
              washingInStatus= `${pend} Pending`;
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
    finishingAssignedOn= assigned_on? new Date(assigned_on).toLocaleString(): "N/A";
    finishingApprovedOn= approved_on? new Date(approved_on).toLocaleString(): "N/A";

    if (is_approved===null) {
      finishingStatus= `Pending Approval by ${finishingOp}`;
    } else if (is_approved==0) {
      finishingStatus= `Denied by ${finishingOp}`;
    } else {
      // partial or complete
      // for denim => finishing leftover vs washingIn
      // for non-denim => finishing leftover vs stitched
      if (isDenim) {
        if (finishedQty===0) {
          finishingStatus= "In-Line";
        } else if (finishedQty>= washingInQty && washingInQty>0) {
          finishingStatus= "Completed";
        } else {
          const pend= washingInQty- finishedQty;
          finishingStatus= `${pend} Pending`;
        }
      } else {
        // non-denim => finishing leftover vs. stitched
        if (finishedQty===0) {
          finishingStatus= "In-Line";
        } else if (finishedQty>= stitchedQty && stitchedQty>0) {
          finishingStatus= "Completed";
        } else {
          const pend= stitchedQty- finishedQty;
          finishingStatus= `${pend} Pending`;
        }
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

/** The final PIC Report route */
/*******************************************************************
 * PIC‑Report Route – with updated date‑filter for department "washing_in"
 *******************************************************************/
// ======================== REPLACEMENT CODE ========================

router.get("/dashboard/pic-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    const {
      lotType = "all",
      department = "all",
      status = "all",
      dateFilter = "createdAt",
      startDate = "",
      endDate = "",
      download = ""
    } = req.query;

    // 1) Build filters for main lots query
    let dateWhere = "";
    let dateParams = [];

    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        if (department === "stitching") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM stitching_assignments sa
                JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(sa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "assembly") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM jeans_assembly_assignments ja
                JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON sd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(ja.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_assignments wa
                JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
                JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing_in") {
          // <-- Updated to join washing_data instead of washing_in_data
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_in_assignments wia
                JOIN washing_data wd
                  ON wia.washing_data_id = wd.id
                JOIN cutting_lots c2
                  ON wd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wia.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "finishing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM finishing_assignments fa
                LEFT JOIN washing_data wd ON fa.washing_assignment_id = wd.id
                LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON (wd.lot_no = c2.lot_no OR sd.lot_no = c2.lot_no)
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(fa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        }
      }
    }

    let lotTypeClause = "";
    if (lotType === "denim") {
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) LIKE 'AK%'
          OR UPPER(cl.lot_no) LIKE 'UM%'
        )
      `;
    } else if (lotType === "hosiery") {
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) NOT LIKE 'AK%'
          AND UPPER(cl.lot_no) NOT LIKE 'UM%'
        )
      `;
    }

    // 2) Fetch all lots (ONE QUERY)
    const baseQuery = `
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.created_at, cl.remark,
             u.username AS created_by
        FROM cutting_lots cl
        JOIN users u ON cl.user_id = u.id
       WHERE 1=1
         ${lotTypeClause}
         ${dateWhere}
       ORDER BY cl.created_at DESC
    `;
    const [lots] = await pool.query(baseQuery, dateParams);

    // Gather all lot_nos in an array for IN () usage
    const lotNos = lots.map(l => l.lot_no);
    if (!lotNos.length) {
      // No lots found => just return
      if (download === "1") {
        return res.status(200).send("No data to download");
      } else {
        return res.render("operatorPICReport", {
          filters: { lotType, department, status, dateFilter, startDate, endDate },
          rows: []
        });
      }
    }

    // 3) Get the sums for each relevant table in a SINGLE UNION query (ONE QUERY)
    //    We'll store them in an object keyed by [lot_no].
    const [sumRows] = await pool.query(`
      SELECT 'stitched' AS sumType, lot_no, COALESCE(SUM(total_pieces), 0) AS sumVal
        FROM stitching_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'assembled' AS sumType, lot_no, COALESCE(SUM(total_pieces), 0) AS sumVal
        FROM jeans_assembly_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'washed' AS sumType, lot_no, COALESCE(SUM(total_pieces), 0) AS sumVal
        FROM washing_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'washing_in' AS sumType, lot_no, COALESCE(SUM(total_pieces), 0) AS sumVal
        FROM washing_in_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'finished' AS sumType, lot_no, COALESCE(SUM(total_pieces), 0) AS sumVal
        FROM finishing_data
       WHERE lot_no IN (?)
       GROUP BY lot_no
    `, [lotNos, lotNos, lotNos, lotNos, lotNos]);

    const lotSumsMap = {};
    // Initialize all sums to 0
    for (const ln of lotNos) {
      lotSumsMap[ln] = {
        stitchedQty: 0,
        assembledQty: 0,
        washedQty: 0,
        washingInQty: 0,
        finishedQty: 0
      };
    }
    // Fill in from sumRows
    for (const row of sumRows) {
      const ln = row.lot_no;
      if (!lotSumsMap[ln]) continue; // Safety
      switch (row.sumType) {
        case "stitched":    lotSumsMap[ln].stitchedQty   = parseFloat(row.sumVal) || 0; break;
        case "assembled":   lotSumsMap[ln].assembledQty  = parseFloat(row.sumVal) || 0; break;
        case "washed":      lotSumsMap[ln].washedQty     = parseFloat(row.sumVal) || 0; break;
        case "washing_in":  lotSumsMap[ln].washingInQty  = parseFloat(row.sumVal) || 0; break;
        case "finished":    lotSumsMap[ln].finishedQty   = parseFloat(row.sumVal) || 0; break;
      }
    }

    // 4) Get the *last* assignments for each department in separate queries (5 QUERIES total)
    //    We'll do a "self-join" approach to pick only the row with the max assigned_on per lot.

    // --- Stitching ---
    const [stRows] = await pool.query(`
      SELECT c.lot_no, sa.id, sa.isApproved AS is_approved,
             sa.assigned_on, sa.approved_on, sa.user_id,
             u.username AS opName
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        LEFT JOIN users u ON sa.user_id = u.id
        LEFT JOIN stitching_assignments sa2
               ON sa2.cutting_lot_id = sa.cutting_lot_id
              AND sa2.assigned_on > sa.assigned_on
       WHERE sa2.id IS NULL
         AND c.lot_no IN (?)
    `, [lotNos]);
    const stitchMap = {};
    for (const row of stRows) {
      stitchMap[row.lot_no] = row;
    }

    // --- Assembly ---
    const [asmRows] = await pool.query(`
      SELECT sd.lot_no, ja.id, ja.is_approved,
             ja.assigned_on, ja.approved_on, ja.user_id,
             u.username AS opName
        FROM jeans_assembly_assignments ja
        JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
        LEFT JOIN users u ON ja.user_id = u.id
        LEFT JOIN jeans_assembly_assignments ja2
               ON ja2.stitching_assignment_id = ja.stitching_assignment_id
              AND ja2.assigned_on > ja.assigned_on
       WHERE ja2.id IS NULL
         AND sd.lot_no IN (?)
    `, [lotNos]);
    const asmMap = {};
    for (const row of asmRows) {
      asmMap[row.lot_no] = row;
    }

    // --- Washing ---
    const [washRows] = await pool.query(`
      SELECT jd.lot_no, wa.id, wa.is_approved,
             wa.assigned_on, wa.approved_on, wa.user_id,
             u.username AS opName
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        LEFT JOIN users u ON wa.user_id = u.id
        LEFT JOIN washing_assignments wa2
               ON wa2.jeans_assembly_assignment_id = wa.jeans_assembly_assignment_id
              AND wa2.assigned_on > wa.assigned_on
       WHERE wa2.id IS NULL
         AND jd.lot_no IN (?)
    `, [lotNos]);
    const washMap = {};
    for (const row of washRows) {
      washMap[row.lot_no] = row;
    }

    // --- WashingIn ---
    const [winRows] = await pool.query(`
      SELECT wd.lot_no, wia.id, wia.is_approved,
             wia.assigned_on, wia.approved_on, wia.user_id,
             u.username AS opName
        FROM washing_in_assignments wia
        JOIN washing_data wd ON wia.washing_data_id = wd.id
        LEFT JOIN users u ON wia.user_id = u.id
        LEFT JOIN washing_in_assignments wia2
               ON wia2.washing_data_id = wia.washing_data_id
              AND wia2.assigned_on > wia.assigned_on
       WHERE wia2.id IS NULL
         AND wd.lot_no IN (?)
    `, [lotNos]);
    const winMap = {};
    for (const row of winRows) {
      winMap[row.lot_no] = row;
    }

    // --- Finishing ---
    // We have two possibilities: if denim => finishing references washing_data, else stitching_data.
    // To unify, we’ll just get all finishing_assignments that link either washing_data or stitching_data
    // by whichever is not null, then pick the last. Then we can figure out the lot_no in the SELECT.
    const [finRows] = await pool.query(`
      SELECT
        CASE
          WHEN fa.washing_assignment_id IS NOT NULL THEN wd.lot_no
          WHEN fa.stitching_assignment_id IS NOT NULL THEN sd.lot_no
        END AS lot_no,
        fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id,
        u.username AS opName
      FROM finishing_assignments fa
      LEFT JOIN washing_data wd ON fa.washing_assignment_id = wd.id
      LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
      LEFT JOIN users u         ON fa.user_id = u.id
      LEFT JOIN finishing_assignments fa2
             ON (
                  fa.washing_assignment_id IS NOT NULL
                  AND fa.washing_assignment_id = fa2.washing_assignment_id
                  AND fa2.assigned_on > fa.assigned_on
                )
                OR
                (
                  fa.stitching_assignment_id IS NOT NULL
                  AND fa.stitching_assignment_id = fa2.stitching_assignment_id
                  AND fa2.assigned_on > fa.assigned_on
                )
      WHERE fa2.id IS NULL
        AND (
             (wd.lot_no IN (?) AND wd.lot_no IS NOT NULL)
             OR
             (sd.lot_no IN (?) AND sd.lot_no IS NOT NULL)
            )
    `, [lotNos, lotNos]);
    const finMap = {};
    for (const row of finRows) {
      if (!row.lot_no) continue;
      finMap[row.lot_no] = row;
    }

    // 5) Now build finalData from these maps
    const finalData = [];
    for (const lot of lots) {
      const lotNo = lot.lot_no;
      const totalCut = parseFloat(lot.total_pieces) || 0;
      const denim = isDenimLot(lotNo);

      // Sums
      const sums = lotSumsMap[lotNo] || {};
      const stitchedQty  = sums.stitchedQty   || 0;
      const assembledQty = sums.assembledQty  || 0;
      const washedQty    = sums.washedQty     || 0;
      const washingInQty = sums.washingInQty  || 0;
      const finishedQty  = sums.finishedQty   || 0;

      // Last assignments
      const stAssign  = stitchMap[lotNo]  || null;
      const asmAssign = asmMap[lotNo]     || null;
      const washAssign= washMap[lotNo]    || null;
      const wInAssign = winMap[lotNo]     || null;
      const finAssign = finMap[lotNo]     || null;

      // Calculate statuses
      const statuses = getDepartmentStatuses({
        isDenim: denim,
        totalCut,
        stitchedQty,
        assembledQty,
        washedQty,
        washingInQty,
        finishedQty,
        stAssign,
        asmAssign,
        washAssign,
        washInAssign: wInAssign,
        finAssign
      });

      // Decide if we show row based on department filter
      const deptResult = filterByDept({
        department,
        isDenim: denim,
        stitchingStatus: statuses.stitchingStatus,
        assemblyStatus: statuses.assemblyStatus,
        washingStatus: statuses.washingStatus,
        washingInStatus: statuses.washingInStatus,
        finishingStatus: statuses.finishingStatus
      });
      if (!deptResult.showRow) continue;

      // Check overall status filter
      const actualStatus = deptResult.actualStatus.toLowerCase();
      if (status !== "all") {
        if (status === "not_assigned") {
          // means "In <some dept>"
          if (!actualStatus.startsWith("in ")) continue;
        } else {
          const want = status.toLowerCase();
          if (want === "inline" && actualStatus.includes("in-line")) {
            // pass
          } else if (!actualStatus.includes(want)) {
            continue;
          }
        }
      }

      finalData.push({
        lotNo,
        sku: lot.sku,
        lotType: denim ? "Denim" : "Hosiery",
        totalCut,
        createdAt: lot.created_at
          ? new Date(lot.created_at).toLocaleDateString()
          : "",
        remark: lot.remark || "",

        // Stitching
        stitchAssignedOn:   statuses.stitchingAssignedOn,
        stitchApprovedOn:   statuses.stitchingApprovedOn,
        stitchOp:           statuses.stitchingOp,
        stitchStatus:       statuses.stitchingStatus,
        stitchedQty,

        // Assembly
        assemblyAssignedOn: statuses.assemblyAssignedOn,
        assemblyApprovedOn: statuses.assemblyApprovedOn,
        assemblyOp:         statuses.assemblyOp,
        assemblyStatus:     statuses.assemblyStatus,
        assembledQty,

        // Washing
        washingAssignedOn:  statuses.washingAssignedOn,
        washingApprovedOn:  statuses.washingApprovedOn,
        washingOp:          statuses.washingOp,
        washingStatus:      statuses.washingStatus,
        washedQty,

        // WashingIn
        washingInAssignedOn: statuses.washingInAssignedOn,
        washingInApprovedOn: statuses.washingInApprovedOn,
        washingInOp:         statuses.washingInOp,
        washingInStatus:     statuses.washingInStatus,
        washingInQty,

        // Finishing
        finishingAssignedOn: statuses.finishingAssignedOn,
        finishingApprovedOn: statuses.finishingApprovedOn,
        finishingOp:         statuses.finishingOp,
        finishingStatus:     statuses.finishingStatus,
        finishedQty
      });
    }

    // 6) If download => Excel
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Report – Denim Chain with WashingIn";

      const sheet = workbook.addWorksheet("PIC-Report");
      sheet.columns = [
        { header: "Lot No",               key: "lotNo",                width: 15 },
        { header: "SKU",                  key: "sku",                  width: 12 },
        { header: "Lot Type",             key: "lotType",              width: 10 },
        { header: "Total Cut",            key: "totalCut",             width: 10 },
        { header: "Created At",           key: "createdAt",            width: 15 },
        { header: "Remark",               key: "remark",               width: 20 },

        // Stitching
        { header: "Stitch Assigned On",   key: "stitchAssignedOn",     width: 20 },
        { header: "Stitch Approved On",   key: "stitchApprovedOn",     width: 20 },
        { header: "Stitch Operator",      key: "stitchOp",             width: 15 },
        { header: "Stitch Status",        key: "stitchStatus",         width: 25 },
        { header: "Stitched Qty",         key: "stitchedQty",          width: 15 },

        // Assembly
        { header: "Assembly Assigned On", key: "assemblyAssignedOn",   width: 20 },
        { header: "Assembly Approved On", key: "assemblyApprovedOn",   width: 20 },
        { header: "Assembly Operator",    key: "assemblyOp",           width: 15 },
        { header: "Assembly Status",      key: "assemblyStatus",       width: 25 },
        { header: "Assembled Qty",        key: "assembledQty",         width: 15 },

        // Washing
        { header: "Washing Assigned On",  key: "washingAssignedOn",    width: 20 },
        { header: "Washing Approved On",  key: "washingApprovedOn",    width: 20 },
        { header: "Washing Operator",     key: "washingOp",            width: 15 },
        { header: "Washing Status",       key: "washingStatus",        width: 25 },
        { header: "Washed Qty",           key: "washedQty",            width: 15 },

        // Washing‑In
        { header: "WashIn Assigned On",   key: "washingInAssignedOn",  width: 20 },
        { header: "WashIn Approved On",   key: "washingInApprovedOn",  width: 20 },
        { header: "WashIn Operator",      key: "washingInOp",          width: 15 },
        { header: "WashIn Status",        key: "washingInStatus",      width: 25 },
        { header: "WashIn Qty",           key: "washingInQty",         width: 15 },

        // Finishing
        { header: "Finishing Assigned On",key: "finishingAssignedOn",  width: 20 },
        { header: "Finishing Approved On",key: "finishingApprovedOn",  width: 20 },
        { header: "Finishing Operator",   key: "finishingOp",          width: 15 },
        { header: "Finishing Status",     key: "finishingStatus",      width: 25 },
        { header: "Finished Qty",         key: "finishedQty",          width: 15 }
      ];

      finalData.forEach(r => {
        sheet.addRow({
          lotNo:               r.lotNo,
          sku:                 r.sku,
          lotType:             r.lotType,
          totalCut:            r.totalCut,
          createdAt:           r.createdAt,
          remark:              r.remark,

          // Stitching
          stitchAssignedOn:    r.stitchAssignedOn,
          stitchApprovedOn:    r.stitchApprovedOn,
          stitchOp:            r.stitchOp,
          stitchStatus:        r.stitchStatus,
          stitchedQty:         r.stitchedQty,

          // Assembly
          assemblyAssignedOn:  r.assemblyAssignedOn,
          assemblyApprovedOn:  r.assemblyApprovedOn,
          assemblyOp:          r.assemblyOp,
          assemblyStatus:      r.assemblyStatus,
          assembledQty:        r.assembledQty,

          // Washing
          washingAssignedOn:   r.washingAssignedOn,
          washingApprovedOn:   r.washingApprovedOn,
          washingOp:           r.washingOp,
          washingStatus:       r.washingStatus,
          washedQty:           r.washedQty,

          // WashingIn
          washingInAssignedOn: r.washingInAssignedOn,
          washingInApprovedOn: r.washingInApprovedOn,
          washingInOp:         r.washingInOp,
          washingInStatus:     r.washingInStatus,
          washingInQty:        r.washingInQty,

          // Finishing
          finishingAssignedOn: r.finishingAssignedOn,
          finishingApprovedOn: r.finishingApprovedOn,
          finishingOp:         r.finishingOp,
          finishingStatus:     r.finishingStatus,
          finishedQty:         r.finishedQty
        });
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="PICReport-FixedChain.xlsx"'
      );
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // 7) Render HTML
      return res.render("operatorPICReport", {
        filters: { lotType, department, status, dateFilter, startDate, endDate },
        rows: finalData
      });
    }
  } catch (err) {
    console.error("Error in /dashboard/pic-report:", err);
    return res.status(500).send("Server error");
  }
});

// Quick helper: isDenimLot
function isDenimLot(lotNo = "") {
  const up = lotNo.toUpperCase();
  return up.startsWith("AK") || up.startsWith("UM");
}

/**
 * getDepartmentStatuses() and filterByDept() remain the same as in your original code
 * (no changes needed, just reuse them).
 * ...
 */

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

// ====================== Single Route: /urgent-tat ======================
// ====================== Single Route: /urgent-tat ======================
const twilio = require("twilio");

// 1) Hard-coded Twilio Credentials
const TWILIO_ACCOUNT_SID    = "AC255689e642be728f80630c179ad7b70d";
const TWILIO_AUTH_TOKEN     = "86b13a472d5d64404d16ffcc444ef471";
const TWILIO_WHATSAPP_FROM  = "whatsapp:+14155238886";
const TWILIO_SMS_FROM       = "+19284272221";

// 2) Create Twilio Client
const TWILIO_CLIENT = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Hard-coded user → phone map
const USER_PHONE_MAP = {
  6:  "+919058893850",
  35: "+918368357980",
  8:  "+919582782336"
};

// Tiny helper: chunk text if >1600 chars. Splits by lines
function chunkMessage(text, limit=1600) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const ln of lines) {
    if ((current + ln + "\n").length > limit) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += ln + "\n";
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

/** Send one chunk via WhatsApp, fallback to SMS if WA fails. */
async function sendChunk(phone, body) {
  try {
    // Attempt WhatsApp
    await TWILIO_CLIENT.messages.create({
      from: TWILIO_WHATSAPP_FROM,
      to:   "whatsapp:" + phone,
      body
    });
    return { ok: true, via: "WhatsApp", error: null };
  } catch (waErr) {
    // fallback to SMS
    try {
      await TWILIO_CLIENT.messages.create({
        from: TWILIO_SMS_FROM,
        to:   phone,
        body
      });
      return { ok: true, via: "SMS", error: null };
    } catch (smsErr) {
      return { ok: false, via: null, error: smsErr.message };
    }
  }
}

/** Returns how many days since the dateValue. */
function daysSince(dateValue) {
  if (!dateValue) return 0;
  const msDiff = Date.now() - new Date(dateValue).getTime();
  return Math.floor(msDiff / (1000 * 60 * 60 * 24));
}

/**
 * GET  /urgent-tat   => Show a page with previews + single "Send" button
 * POST /urgent-tat   => Actually send
 */
router.route("/urgent-tat")
  .all(isAuthenticated, isOperator, async (req, res) => {
    try {
      // 1) Find all stitching_assignments older than 20 days
      //    but only for users that are in USER_PHONE_MAP
      const userIds = Object.keys(USER_PHONE_MAP).map(Number); // e.g. [6,35,8]
      if (!userIds.length) {
        // If we have no phone mappings, there's no reason to proceed
        const noMapHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Urgent TAT</title>
</head>
<body style="font-family:sans-serif; margin:40px;">
  <h2>No user phone mappings found.</h2>
</body>
</html>`;
        return res.end(noMapHtml);
      }

      const [rows] = await pool.query(`
        SELECT sa.user_id, u.username,
               cl.lot_no, cl.remark,
               sa.assigned_on
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
          JOIN users u         ON sa.user_id = u.id
         WHERE sa.assigned_on IS NOT NULL
           AND DATEDIFF(NOW(), sa.assigned_on) > 20
           AND sa.user_id IN (?)
         ORDER BY sa.user_id, sa.assigned_on
      `, [userIds]);

      // 2) Group them by user_id => { userId: { username, lines: [] } }
      const overdueMap = {};
      for (const r of rows) {
        const userId = r.user_id;
        if (!overdueMap[userId]) {
          overdueMap[userId] = {
            username: r.username,
            lines: []
          };
        }
        // e.g. "Lot 2594 sort no 618"
        const line = `Lot ${r.lot_no}${r.remark ? " " + r.remark.trim() : ""}`;
        overdueMap[userId].lines.push(line);
      }

      // If no results => show a "nothing to send" preview
      if (!Object.keys(overdueMap).length) {
        const emptyHtml = `
<!DOCTYPE html>
<html><head><title>Urgent TAT</title></head>
<body style="font-family:sans-serif; margin: 40px;">
  <h2>Urgent TAT (Over 20 days)</h2>
  <p>No lots are older than 20 days <strong>for mapped users</strong>. Nothing to send.</p>
</body></html>`;
        return res.end(emptyHtml);
      }

      // 3) Build a big text area preview
      let previewText = "";
      for (const [uid, val] of Object.entries(overdueMap)) {
        const header = `Master #${uid} - ${val.username}`;
        const body   = val.lines.join("\n");
        previewText += header + "\n" + body + "\n\n";
      }
      previewText = previewText.trimEnd();

      // 4) If POST => attempt to send
      let statusMessage = "";
      let errorMessage  = "";
      if (req.method === "POST") {
        const sendResults = [];
        for (const [uid, val] of Object.entries(overdueMap)) {
          const phone = USER_PHONE_MAP[uid];
          // create full text
          const fullText = val.lines.join("\n");
          const chunks   = chunkMessage(fullText);

          // send each chunk
          const outcomes = [];
          for (const c of chunks) {
            /* eslint-disable no-await-in-loop */
            const result = await sendChunk(phone, c);
            outcomes.push(result);
            if (!result.ok) break; // if 1 chunk fails, skip the rest
          }

          // analyze
          if (outcomes.every(o => o.ok)) {
            sendResults.push({
              userId: uid,
              username: val.username,
              success: `Sent ${outcomes.length} chunk(s) to ${phone} via ` +
                       outcomes.map(o => o.via).join(", ")
            });
          } else {
            const errChunk = outcomes.find(o => !o.ok);
            sendResults.push({
              userId: uid,
              username: val.username,
              error: `Failed chunk => ${errChunk?.error || "Unknown"}`
            });
          }
        }

        // build final status
        const successes = sendResults.filter(r => r.success);
        const fails     = sendResults.filter(r => r.error);

        if (successes.length) {
          statusMessage = "Successfully sent to:<br/>" + 
            successes.map(s => `• [${s.userId}] ${s.username}: ${s.success}`).join("<br/>");
        }
        if (fails.length) {
          errorMessage = "Some errors occurred:<br/>" +
            fails.map(f => `• [${f.userId}] ${f.username}: ${f.error}`).join("<br/>");
        }
      }

      // 5) Render a more professional HTML
      const htmlPage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Urgent TAT - All Masters</title>
  <style>
    body {
      font-family: "Segoe UI", Tahoma, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      background: #f9f9f9;
      padding: 20px;
      border-radius: 6px;
      color: #333;
    }
    h1, h2 {
      margin-bottom: 0.5em;
      line-height: 1.2;
    }
    .subtitle {
      color: #666;
      font-size: 0.9em;
      margin-bottom: 1em;
    }
    textarea {
      width: 100%;
      height: 220px;
      font-family: monospace;
      font-size: 14px;
      padding: 10px;
      border-radius: 4px;
      border: 1px solid #ccc;
      background: #fff;
    }
    .btn-submit {
      padding: 10px 24px;
      font-size: 15px;
      cursor: pointer;
      color: #fff;
      background: #007BFF;
      border: none;
      border-radius: 4px;
      margin-top: 8px;
    }
    .btn-submit:hover {
      background: #0056b3;
    }
    .alert {
      margin-top: 20px;
      padding: 15px;
      border-radius: 4px;
    }
    .alert.success {
      background: #d4edda;
      border: 1px solid #c3e6cb;
      color: #155724;
    }
    .alert.error {
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
    }
    .alert p {
      margin: 0;
      white-space: pre-line;
    }
  </style>
</head>
<body>
  <h1>Urgent TAT (Over 20 days)</h1>
  <div class="subtitle">Only sending to mapped Masters in USER_PHONE_MAP</div>

  <form method="POST">
    <textarea readonly>${previewText}</textarea>
    <br/>
    <button type="submit" class="btn-submit">Send TAT to All</button>
  </form>
  
  ${
    statusMessage
      ? `<div class="alert success"><p>${statusMessage}</p></div>`
      : ""
  }
  ${
    errorMessage
      ? `<div class="alert error"><p>${errorMessage}</p></div>`
      : ""
  }
</body>
</html>`;
      res.setHeader("Content-Type", "text/html");
      return res.end(htmlPage);

    } catch (err) {
      console.error("Error in /urgent-tat route:", err);
      return res.status(500).send("Server Error in /urgent-tat");
    }
  });


module.exports = router;
