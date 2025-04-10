/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend – Optimized with Lazy Loading
 * (Kit Details functionality has been removed.)
 *
 * Key improvements:
 *  • The main /operator/dashboard route loads only summary stats.
 *  • A new API endpoint provides paged (lazy) data for Leftovers.
 *  • Extra queries now return assigned operator names.
 **************************************************/

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const ExcelJS = require("exceljs");

/**
 * computeAdvancedLeftoversForLot(lot_no, isAkshay)
 * Returns leftoverStitch, leftoverWash, leftoverFinish for a given lot.
 */
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
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

  const [stAssignmentRows] = await pool.query(
    "SELECT isApproved FROM stitching_assignments sa JOIN cutting_lots c ON sa.cutting_lot_id = c.id WHERE c.lot_no = ? ORDER BY sa.assigned_on DESC LIMIT 1",
    [lot_no]
  );
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
    const [jaRows] = await pool.query(
      "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
      [lot_no]
    );
    const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;

    const [waAssignmentRows] = await pool.query(
      "SELECT is_approved FROM washing_assignments wa JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1",
      [lot_no]
    );
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

    const [faAssignmentRows] = await pool.query(
      "SELECT is_approved FROM finishing_assignments fa JOIN washing_data wd ON fa.washing_assignment_id = wd.id WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
      [lot_no]
    );
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
    leftoverWash = "N/A";
    const [faAssignmentRows] = await pool.query(
      "SELECT is_approved FROM finishing_assignments fa JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
      [lot_no]
    );
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

/**
 * computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay)
 */
async function computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay) {
  if (!isAkshay) return "N/A";
  const [jaAssignRows] = await pool.query(
    "SELECT is_approved FROM jeans_assembly_assignments ja JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY ja.assigned_on DESC LIMIT 1",
    [lot_no]
  );
  if (!jaAssignRows.length) return "Not Assigned";
  const jaAssn = jaAssignRows[0];
  if (jaAssn.is_approved === null) return "Waiting for approval";
  if (jaAssn.is_approved == 0) return "Denied";
  const [jaRows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;
  return totalStitchedLocal - totalJeans;
}

/**
 * computeOperatorPerformance()
 */
async function computeOperatorPerformance() {
  const perf = {};
  let [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalStitched = parseFloat(r.sumStitched) || 0;
  });
  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = parseFloat(r.sumWashed) || 0;
  });
  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = parseFloat(r.sumFinished) || 0;
  });
  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query("SELECT id, username FROM users WHERE id IN (?)", [uids]);
    users.forEach(u => {
      if (perf[u.id]) perf[u.id].username = u.username;
    });
  }
  return perf;
}

/**
 * computeAdvancedAnalytics(startDate, endDate)
 */
async function computeAdvancedAnalytics(startDate, endDate) {
  const analytics = {};
  const [cutTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalCut FROM cutting_lots");
  const [stitchTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
  const [washTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
  const [finishTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");

  analytics.totalCut = parseFloat(cutTotals[0].totalCut) || 0;
  analytics.totalStitched = parseFloat(stitchTotals[0].totalStitched) || 0;
  analytics.totalWashed = parseFloat(washTotals[0].totalWashed) || 0;
  analytics.totalFinished = parseFloat(finishTotals[0].totalFinished) || 0;

  analytics.stitchConversion = analytics.totalCut > 0 ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2) : "0.00";
  analytics.washConversion = analytics.totalStitched > 0
    ? (((analytics.totalWashed > 0 ? analytics.totalWashed : analytics.totalFinished) / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";
  analytics.finishConversion = analytics.totalWashed > 0
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : analytics.totalStitched > 0
      ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
      : "0.00";

  let skuQuery = "SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ";
  let skuQueryParams = [];
  if (startDate && endDate) {
    skuQuery += "WHERE created_at BETWEEN ? AND ? ";
    skuQueryParams.push(startDate, endDate);
  } else {
    skuQuery += "WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) ";
  }
  skuQuery += "GROUP BY sku ORDER BY total DESC LIMIT 10";
  const [topSkus] = await pool.query(skuQuery, skuQueryParams);
  analytics.top10SKUs = topSkus;

  let bottomQuery = "SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ";
  let bottomQueryParams = [];
  if (startDate && endDate) {
    bottomQuery += "WHERE created_at BETWEEN ? AND ? ";
    bottomQueryParams.push(startDate, endDate);
  } else {
    bottomQuery += "WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) ";
  }
  bottomQuery += "GROUP BY sku ORDER BY total ASC LIMIT 10";
  const [bottomSkus] = await pool.query(bottomQuery, bottomQueryParams);
  analytics.bottom10SKUs = bottomSkus;

  const [[{ totalCount }]] = await pool.query("SELECT COUNT(*) AS totalCount FROM cutting_lots");
  analytics.totalLots = totalCount;

  const [pRows] = await pool.query(`
    SELECT COUNT(*) AS pCount
    FROM cutting_lots c
    LEFT JOIN (
      SELECT lot_no, COALESCE(SUM(total_pieces),0) AS sumFinish
      FROM finishing_data
      GROUP BY lot_no
    ) fd ON c.lot_no = fd.lot_no
    WHERE fd.sumFinish < c.total_pieces
  `);
  analytics.pendingLots = pRows[0].pCount;

  const [turnRows] = await pool.query(`
    SELECT c.lot_no, c.created_at AS cut_date, MAX(f.created_at) AS finish_date, c.total_pieces,
           COALESCE(SUM(f.total_pieces),0) as sumFin
    FROM cutting_lots c
    LEFT JOIN finishing_data f ON c.lot_no = f.lot_no
    GROUP BY c.lot_no
    HAVING sumFin >= c.total_pieces
  `);
  let totalDiff = 0;
  let countComplete = 0;
  for (const row of turnRows) {
    if (row.finish_date && row.cut_date) {
      const diffMs = new Date(row.finish_date).getTime() - new Date(row.cut_date).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      totalDiff += diffDays;
      countComplete++;
    }
  }
  analytics.avgTurnaroundTime = countComplete > 0 ? parseFloat((totalDiff / countComplete).toFixed(2)) : 0;

  const [[stTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN isApproved=1 THEN 1 ELSE 0 END) AS approvedCount
    FROM stitching_assignments
  `);
  analytics.stitchApprovalRate = stTotals.totalAssigned > 0 ? ((stTotals.approvedCount / stTotals.totalAssigned) * 100).toFixed(2) : "0.00";

  const [[waTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN is_approved=1 THEN 1 ELSE 0 END) AS approvedCount
    FROM washing_assignments
  `);
  analytics.washApprovalRate = waTotals.totalAssigned > 0 ? ((waTotals.approvedCount / waTotals.totalAssigned) * 100).toFixed(2) : "0.00";

  return analytics;
}

/**
 * GET /operator/dashboard
 * Main dashboard route loads only summary stats.
 */
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate, sortField = "lot_no", sortOrder = "asc", category = "all" } = req.query;
    const operatorPerformance = await computeOperatorPerformance();
    const [lotCountResult] = await pool.query("SELECT COUNT(*) AS lotCount FROM cutting_lots");
    const lotCount = lotCountResult[0].lotCount;
    const [totalPiecesResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalPieces FROM cutting_lots");
    const totalPiecesCut = parseFloat(totalPiecesResult[0].totalPieces) || 0;
    const [totalStitchedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
    const [totalWashedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
    const [totalFinishedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");
    const [userCountResult] = await pool.query("SELECT COUNT(*) AS userCount FROM users");
    const userCount = userCountResult[0].userCount;
    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);

    // Kit Details removed – only Leftovers (and Notes) remain.
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
      lotDetails: {} // empty; leftover data will be lazy-loaded via API
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * NEW: GET /operator/dashboard/api/leftovers
 * API endpoint for lazy loading Leftover data (for Tabulator).
 */
router.get("/dashboard/api/leftovers", isAuthenticated, isOperator, async (req, res) => {
  try {
    let page = parseInt(req.query.page) || 1;
    let size = parseInt(req.query.size) || 100;
    if (page < 1) page = 1;
    const offset = (page - 1) * size;
    const searchParam = req.query.search || "";

    const whereClauses = [];
    const params = [];
    if (searchParam) {
      whereClauses.push("(cl.lot_no LIKE ? OR cl.sku LIKE ?)");
      params.push(`%${searchParam}%`, `%${searchParam}%`);
    }
    const whereSQL = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const [[countRow]] = await pool.query(`
      SELECT COUNT(*) AS totalCount
      FROM cutting_lots cl
      ${whereSQL}
    `, params);
    const totalCount = countRow.totalCount;

    const leftoverSQL = `
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.remark, u.username AS created_by
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      ${whereSQL}
      ORDER BY cl.lot_no
      LIMIT ? OFFSET ?
    `;
    params.push(size, offset);
    const [lots] = await pool.query(leftoverSQL, params);

    const leftoverData = await Promise.all(lots.map(async (lot) => {
      const isAkshay = (lot.created_by || "").toLowerCase() === "akshay";
      const leftovers = await computeAdvancedLeftoversForLot(lot.lot_no, isAkshay);
      let [stData] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?",
        [lot.lot_no]
      );
      const totalStitchedLocal = parseFloat(stData[0].sumStitched) || 0;
      const leftoverJeans = await computeJeansLeftover(lot.lot_no, totalStitchedLocal, isAkshay);

      // Get assigned operator names:
      const [stAssignResult] = await pool.query(
        "SELECT u.username FROM stitching_assignments sa JOIN users u ON sa.user_id = u.id JOIN cutting_lots c ON sa.cutting_lot_id = c.id WHERE c.lot_no = ? ORDER BY sa.assigned_on DESC LIMIT 1",
        [lot.lot_no]
      );
      const stitchingOperator = stAssignResult.length ? stAssignResult[0].username : "N/A";

      let assemblyOperator = "N/A";
      if (isAkshay) {
        const [jaAssignResult] = await pool.query(
          "SELECT u.username FROM jeans_assembly_assignments ja JOIN users u ON ja.user_id = u.id JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY ja.assigned_on DESC LIMIT 1",
          [lot.lot_no]
        );
        assemblyOperator = jaAssignResult.length ? jaAssignResult[0].username : "N/A";
      }

      let washOperator = "N/A";
      if (isAkshay) {
        const [waAssignResult] = await pool.query(
          "SELECT u.username FROM washing_assignments wa JOIN users u ON wa.user_id = u.id JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1",
          [lot.lot_no]
        );
        washOperator = waAssignResult.length ? waAssignResult[0].username : "N/A";
      }

      let finishOperator = "N/A";
      if (isAkshay) {
        const [fiAssignResult1] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN washing_data wd ON fa.washing_assignment_id = wd.id WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lot.lot_no]
        );
        finishOperator = fiAssignResult1.length ? fiAssignResult1[0].username : "N/A";
      } else {
        const [fiAssignResult2] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lot.lot_no]
        );
        finishOperator = fiAssignResult2.length ? fiAssignResult2[0].username : "N/A";
      }

      const [[cutRow]] = await pool.query("SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1", [lot.lot_no]);
      const totalCutVal = cutRow ? parseFloat(cutRow.total_pieces) || 0 : 0;
      const [[dispatchRow]] = await pool.query("SELECT COALESCE(SUM(quantity),0) AS totalDispatched FROM finishing_dispatches WHERE lot_no = ?", [lot.lot_no]);
      const totalDispatched = parseFloat(dispatchRow.totalDispatched) || 0;
      const totalPiecesLeft = totalCutVal - totalDispatched;
      const [[sumFinRow]] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS sumFinish FROM finishing_data WHERE lot_no = ?", [lot.lot_no]);
      const sumFinish = parseFloat(sumFinRow.sumFinish) || 0;
      const dispatchLeftover = sumFinish > 0 ? (sumFinish - totalDispatched) : "Not Assigned";

      return {
        kitNumber: lot.lot_no,
        sku: lot.sku,
        totalPieces: lot.total_pieces,
        leftoverStitch: leftovers.leftoverStitch,
        leftoverAssembly: isAkshay ? leftoverJeans : "N/A",
        leftoverWash: leftovers.leftoverWash,
        leftoverFinish: leftovers.leftoverFinish,
        remark: lot.remark || "None",
        totalPiecesLeft,
        dispatchLeftover,
        stitchingOperator,
        assemblyOperator,
        washOperator,
        finishOperator,
        lotType: lot.created_by.toLowerCase(),
        searchString: `${lot.lot_no} ${lot.sku} ${lot.total_pieces} ${leftovers.leftoverStitch} ${isAkshay ? leftoverJeans : "N/A"} ${leftovers.leftoverWash} ${leftovers.leftoverFinish}`
      };
    }));

    return res.json({
      data: leftoverData,
      page,
      size,
      total_count: totalCount
    });
  } catch (err) {
    console.error("Error in /dashboard/api/leftovers:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * POST /operator/dashboard/edit-lot
 */
router.post("/dashboard/edit-lot", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no, total_pieces, remark } = req.body;
    if (!lot_no) return res.status(400).send("Lot number is required");
    const newTotal = total_pieces && !isNaN(total_pieces) ? total_pieces : 0;
    await pool.query("UPDATE cutting_lots SET total_pieces = ?, remark = ? WHERE lot_no = ?", [newTotal, remark || null, lot_no]);
    return res.redirect("/operator/dashboard");
  } catch (err) {
    console.error("Error editing lot:", err);
    return res.status(500).send("Server error");
  }
});

/**************************************************
 * CSV/Excel Export and Pendency-Report routes remain unchanged.
 * (Include your existing routes for these functionalities.)
 **************************************************/

/**************************************************
 * GET /operator/dashboard/leftovers/download
 * – Export leftover CSV for all lots.
 **************************************************/
router.get("/dashboard/leftovers/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [lots] = await pool.query("SELECT lot_no FROM cutting_lots");
    let csvContent = "Lot No,Leftover Stitch,Leftover Wash,Leftover Finish,Leftover Assembly\n";
    for (const { lot_no } of lots) {
      const [cutRows] = await pool.query(
        "SELECT u.username AS created_by FROM cutting_lots cl JOIN users u ON cl.user_id = u.id WHERE cl.lot_no = ? LIMIT 1",
        [lot_no]
      );
      const isAkshay = cutRows.length && cutRows[0].created_by.toLowerCase() === "akshay";
      const leftovers = await computeAdvancedLeftoversForLot(lot_no, isAkshay);
      const [stData] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?",
        [lot_no]
      );
      const totalStitchedLocal = parseFloat(stData[0].sumStitched) || 0;
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay);
      csvContent += `${lot_no},${leftovers.leftoverStitch},${leftovers.leftoverWash},${leftovers.leftoverFinish},${leftoverJeans}\n`;
    }
    res.setHeader("Content-disposition", "attachment; filename=Leftovers.csv");
    res.set("Content-Type", "text/csv");
    res.send(csvContent);
  } catch (err) {
    console.error("Error exporting leftovers:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * GET /operator/dashboard/lot-tracking/:lot_no/download
 * – Export single-lot CSV.
 */
router.get("/dashboard/lot-tracking/:lot_no/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no } = req.params;
    const [cutRows] = await pool.query("SELECT * FROM cutting_lots WHERE lot_no = ? LIMIT 1", [lot_no]);
    if (!cutRows.length) return res.status(404).send("Lot not found");
    const cuttingLot = cutRows[0];
    cuttingLot.total_pieces = parseFloat(cuttingLot.total_pieces) || 0;

    const [sizes] = await pool.query(
      "SELECT * FROM cutting_lot_sizes WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY size_label",
      [lot_no]
    );
    const [rolls] = await pool.query(
      "SELECT * FROM cutting_lot_rolls WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY roll_no",
      [lot_no]
    );

    let csvContent = `Lot No,SKU,Fabric Type,Total Pieces,Remark\n`;
    csvContent += `${cuttingLot.lot_no},${cuttingLot.sku},${cuttingLot.fabric_type},${cuttingLot.total_pieces},${cuttingLot.remark}\n\n`;
    csvContent += `Sizes:\nSize Label,Pattern Count,Total Pieces\n`;
    sizes.forEach(s => {
      csvContent += `${s.size_label},${s.pattern_count},${s.total_pieces}\n`;
    });
    csvContent += `\nRolls:\nRoll No,Weight Used,Layers,Total Pieces\n`;
    rolls.forEach(r => {
      csvContent += `${r.roll_no},${r.weight_used},${r.layers},${r.total_pieces}\n`;
    });
    res.setHeader("Content-disposition", `attachment; filename=Lot_${lot_no}.csv`);
    res.set("Content-Type", "text/csv");
    res.send(csvContent);
  } catch (err) {
    console.error("Error exporting lot:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * GET /operator/dashboard/download-all-lots
 * – Export entire cutting_lots table as CSV.
 */
router.get("/dashboard/download-all-lots", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [allCuts] = await pool.query("SELECT * FROM cutting_lots");
    let csvContent = `Lot No,SKU,Fabric Type,Total Pieces,Remark,Created At\n`;
    allCuts.forEach(cut => {
      csvContent += `${cut.lot_no},${cut.sku},${cut.fabric_type},${parseFloat(cut.total_pieces) || 0},${cut.remark},${cut.created_at}\n`;
    });
    res.setHeader("Content-disposition", "attachment; filename=All_Lots.csv");
    res.set("Content-Type", "text/csv");
    res.send(csvContent);
  } catch (err) {
    console.error("Error exporting all lots:", err);
    return res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/stitching
 * – The Stitching Pendency Dashboard.
 **************************************************/
router.get('/pendency-report/stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [usersSummary] = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.username,
        COUNT(sa.id) AS total_assignments,
        SUM(CASE WHEN sd.id IS NOT NULL THEN 1 ELSE 0 END) AS completed_assignments,
        SUM(CASE WHEN sd.id IS NULL THEN 1 ELSE 0 END) AS pending_assignments
      FROM stitching_assignments sa
      JOIN users u ON sa.user_id = u.id
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      LEFT JOIN stitching_data sd ON c.lot_no = sd.lot_no
      WHERE sa.isApproved = 1
      GROUP BY u.id, u.username
      ORDER BY u.username
    `);

    const selectedUserId = req.query.user_id || "";
    let detailedAssignments = [];
    let detailedSummary = { totalAssigned: 0, totalPending: 0 };

    if (selectedUserId) {
      const [assignRows] = await pool.query(`
        SELECT sa.id AS assignment_id, sa.cutting_lot_id, sa.assigned_on,
               c.lot_no, c.total_pieces
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        WHERE sa.user_id = ?
        ORDER BY sa.assigned_on DESC
      `, [selectedUserId]);

      const assignmentInfo = await Promise.all(assignRows.map(async asg => {
        const [stDataRows] = await pool.query(`
          SELECT id, total_pieces 
          FROM stitching_data 
          WHERE lot_no = ? 
          LIMIT 1
        `, [asg.lot_no]);
        let stitchedTotal = 0;
        let stDataId = null;
        if (stDataRows.length > 0) {
          stDataId = stDataRows[0].id;
          stitchedTotal = parseFloat(stDataRows[0].total_pieces) || 0;
        }
        const lotTotal = parseFloat(asg.total_pieces) || 0;
        const pendingTotal = lotTotal - stitchedTotal;

        const [sizeRows] = await pool.query(`
          SELECT id, size_label, total_pieces 
          FROM cutting_lot_sizes 
          WHERE cutting_lot_id = ?
        `, [asg.cutting_lot_id]);
        let sizes = [];
        for (const size of sizeRows) {
          let stitchedSize = 0;
          if (stDataId) {
            const [[{ stitched }]] = await pool.query(`
              SELECT COALESCE(SUM(pieces), 0) AS stitched
              FROM stitching_data_sizes
              WHERE stitching_data_id = ? AND size_label = ?
            `, [stDataId, size.size_label]);
            stitchedSize = stitched;
          }
          const pendingSize = parseFloat(size.total_pieces) - stitchedSize;
          sizes.push({
            size_label: size.size_label,
            total: size.total_pieces,
            stitched: stitchedSize,
            pending: pendingSize
          });
        }
        return {
          assignment_id: asg.assignment_id,
          lot_no: asg.lot_no,
          total_pieces: lotTotal,
          stitched: stitchedTotal,
          pending: pendingTotal,
          assigned_on: asg.assigned_on,
          sizes
        };
      }));

      detailedAssignments = assignmentInfo;
      detailedAssignments.forEach(asg => {
        detailedSummary.totalAssigned += asg.total_pieces;
        detailedSummary.totalPending += asg.pending;
      });
    }

    return res.render("operatorStitchingPendencyReport", {
      usersSummary,
      selectedUserId,
      detailedAssignments,
      detailedSummary,
      query: req.query
    });
  } catch (err) {
    console.error("Error generating stitching pendency report:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/stitching/download
 * – Generate Excel for the detailed pendency of a stitching operator.
 **************************************************/
router.get('/pendency-report/stitching/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const selectedUserId = req.query.user_id || "";
    if (!selectedUserId) return res.status(400).send("User not selected.");

    const [assignRows] = await pool.query(`
      SELECT sa.id AS assignment_id, sa.cutting_lot_id, sa.assigned_on,
             c.lot_no, c.total_pieces
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
      ORDER BY sa.assigned_on DESC
    `, [selectedUserId]);

    const assignmentInfo = await Promise.all(assignRows.map(async asg => {
      const [stDataRows] = await pool.query(`
        SELECT id, total_pieces
        FROM stitching_data
        WHERE lot_no = ?
        LIMIT 1
      `, [asg.lot_no]);
      let stitchedTotal = 0, stDataId = null;
      if (stDataRows.length > 0) {
        stDataId = stDataRows[0].id;
        stitchedTotal = parseFloat(stDataRows[0].total_pieces) || 0;
      }
      const lotTotal = parseFloat(asg.total_pieces) || 0;
      const pendingTotal = lotTotal - stitchedTotal;

      const [sizeRows] = await pool.query(`
        SELECT id, size_label, total_pieces
        FROM cutting_lot_sizes
        WHERE cutting_lot_id = ?
      `, [asg.cutting_lot_id]);
      let sizes = [];
      for (const size of sizeRows) {
        let stitchedSize = 0;
        if (stDataId) {
          const [[{ stitched }]] = await pool.query(`
            SELECT COALESCE(SUM(pieces), 0) AS stitched
            FROM stitching_data_sizes
            WHERE stitching_data_id = ? AND size_label = ?
          `, [stDataId, size.size_label]);
          stitchedSize = stitched;
        }
        const pendingSize = parseFloat(size.total_pieces) - stitchedSize;
        sizes.push({
          size_label: size.size_label,
          total: size.total_pieces,
          stitched: stitchedSize,
          pending: pendingSize
        });
      }
      return {
        assignment_id: asg.assignment_id,
        lot_no: asg.lot_no,
        total_pieces: lotTotal,
        stitched: stitchedTotal,
        pending: pendingTotal,
        assigned_on: asg.assigned_on,
        sizes
      };
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Operator Dashboard';
    const worksheet = workbook.addWorksheet('Stitching Report');

    worksheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 15 },
      { header: 'Stitched', key: 'stitched', width: 15 },
      { header: 'Pending', key: 'pending', width: 15 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 },
      { header: 'Size Breakdown', key: 'sizes', width: 50 }
    ];

    assignmentInfo.forEach(asg => {
      let sizesText = asg.sizes.map(sz => {
        return `${sz.size_label}: ${sz.stitched}/${sz.total} stitched, ${sz.pending} pending`;
      }).join(" | ");
      worksheet.addRow({
        lot_no: asg.lot_no,
        total_pieces: asg.total_pieces,
        stitched: asg.stitched,
        pending: asg.pending,
        assigned_on: new Date(asg.assigned_on).toLocaleString(),
        sizes: sizesText
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="StitchingPendencyReport.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Excel for stitching pendency:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/assembly
 * Jeans Assembly Pendency Dashboard.
 **************************************************/
router.get('/pendency-report/assembly', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [usersSummary] = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.username,
        COUNT(jaa.id) AS total_assignments,
        SUM(CASE WHEN jad.id IS NOT NULL THEN 1 ELSE 0 END) AS completed_assignments,
        SUM(CASE WHEN jad.id IS NULL THEN 1 ELSE 0 END) AS pending_assignments
      FROM jeans_assembly_assignments jaa
      JOIN users u ON jaa.user_id = u.id
      JOIN stitching_data sd ON jaa.stitching_assignment_id = sd.id
      LEFT JOIN jeans_assembly_data jad ON sd.lot_no = jad.lot_no
      WHERE jaa.is_approved = 1
      GROUP BY u.id, u.username
      ORDER BY u.username
    `);

    const selectedUserId = req.query.user_id || "";
    let detailedAssignments = [];
    let detailedSummary = { totalAssigned: 0, totalPending: 0 };

    if (selectedUserId) {
      const [assignRows] = await pool.query(`
        SELECT jaa.id AS assignment_id,
               jaa.stitching_assignment_id,
               jaa.assigned_on,
               sd.lot_no,
               sd.total_pieces
        FROM jeans_assembly_assignments jaa
        JOIN stitching_data sd ON jaa.stitching_assignment_id = sd.id
        WHERE jaa.user_id = ?
        ORDER BY jaa.assigned_on DESC
      `, [selectedUserId]);

      const assignmentInfo = await Promise.all(assignRows.map(async asg => {
        const [assemblyDataRows] = await pool.query(`
          SELECT id, total_pieces
          FROM jeans_assembly_data
          WHERE lot_no = ?
          LIMIT 1
        `, [asg.lot_no]);

        let assembledTotal = 0;
        let assemblyDataId = null;
        if (assemblyDataRows.length > 0) {
          assemblyDataId = assemblyDataRows[0].id;
          assembledTotal = parseFloat(assemblyDataRows[0].total_pieces) || 0;
        }
        const lotTotal = parseFloat(asg.total_pieces) || 0;
        const pendingTotal = lotTotal - assembledTotal;

        let sizes = [];
        if (assemblyDataId) {
          const [sizeRows] = await pool.query(`
            SELECT size_label, SUM(pieces) AS assembled
            FROM jeans_assembly_data_sizes
            WHERE jeans_assembly_data_id = ?
            GROUP BY size_label
          `, [assemblyDataId]);

          const [origSizeRows] = await pool.query(`
            SELECT size_label, SUM(pieces) AS stitched
            FROM stitching_data_sizes
            WHERE stitching_data_id = ?
            GROUP BY size_label
          `, [asg.stitching_assignment_id]);

          for (const orig of origSizeRows) {
            let aRow = sizeRows.find(s => s.size_label === orig.size_label);
            let assemCount = aRow ? aRow.assembled : 0;
            let pendingThisSize = (orig.stitched || 0) - assemCount;
            sizes.push({
              size_label: orig.size_label,
              total: orig.stitched,
              assembled: assemCount,
              pending: pendingThisSize
            });
          }
        }
        return {
          assignment_id: asg.assignment_id,
          lot_no: asg.lot_no,
          total_pieces: lotTotal,
          assembled: assembledTotal,
          pending: pendingTotal,
          assigned_on: asg.assigned_on,
          sizes
        };
      }));

      detailedAssignments = assignmentInfo;
      detailedAssignments.forEach(asg => {
        detailedSummary.totalAssigned += asg.total_pieces;
        detailedSummary.totalPending += asg.pending;
      });
    }

    return res.render("operatorAssemblyPendencyReport", {
      usersSummary,
      selectedUserId,
      detailedAssignments,
      detailedSummary,
      query: req.query
    });
  } catch (err) {
    console.error("Error generating jeans assembly pendency report:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/assembly/download
 * – Generate Excel for the detailed Jeans Assembly Pendency report.
 **************************************************/
router.get('/pendency-report/assembly/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const selectedUserId = req.query.user_id || "";
    if (!selectedUserId) return res.status(400).send("User not selected.");

    const [assignRows] = await pool.query(`
      SELECT jaa.id AS assignment_id,
             jaa.stitching_assignment_id,
             jaa.assigned_on,
             sd.lot_no,
             sd.total_pieces
      FROM jeans_assembly_assignments jaa
      JOIN stitching_data sd ON jaa.stitching_assignment_id = sd.id
      WHERE jaa.user_id = ?
      ORDER BY jaa.assigned_on DESC
    `, [selectedUserId]);

    const assignmentInfo = await Promise.all(assignRows.map(async asg => {
      const [assemblyDataRows] = await pool.query(`
        SELECT id, total_pieces
        FROM jeans_assembly_data
        WHERE lot_no = ?
        LIMIT 1
      `, [asg.lot_no]);
      let assembledTotal = 0, assemblyDataId = null;
      if (assemblyDataRows.length > 0) {
        assemblyDataId = assemblyDataRows[0].id;
        assembledTotal = parseFloat(assemblyDataRows[0].total_pieces) || 0;
      }
      const lotTotal = parseFloat(asg.total_pieces) || 0;
      const pendingTotal = lotTotal - assembledTotal;

      let sizesText = "N/A";
      if (assemblyDataId) {
        const [jaSizeRows] = await pool.query(`
          SELECT size_label, SUM(pieces) AS assembled
          FROM jeans_assembly_data_sizes
          WHERE jeans_assembly_data_id = ?
          GROUP BY size_label
        `, [assemblyDataId]);
        const [stSizeRows] = await pool.query(`
          SELECT size_label, SUM(pieces) AS stitched
          FROM stitching_data_sizes
          WHERE stitching_data_id = ?
          GROUP BY size_label
        `, [asg.stitching_assignment_id]);
        const sizeStrings = [];
        stSizeRows.forEach(st => {
          let match = jaSizeRows.find(x => x.size_label === st.size_label);
          let asmCount = match ? match.assembled : 0;
          let pend = (st.stitched || 0) - asmCount;
          sizeStrings.push(`${st.size_label}: ${asmCount}/${st.stitched} assembled, ${pend} pending`);
        });
        if (sizeStrings.length) sizesText = sizeStrings.join(" | ");
      }

      return {
        lot_no: asg.lot_no,
        total_pieces: lotTotal,
        assembled: assembledTotal,
        pending: pendingTotal,
        assigned_on: asg.assigned_on,
        sizes: sizesText
      };
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Operator Dashboard – Jeans Assembly Pendency';
    const worksheet = workbook.addWorksheet('AssemblyPendency');

    worksheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 15 },
      { header: 'Assembled', key: 'assembled', width: 15 },
      { header: 'Pending', key: 'pending', width: 15 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 },
      { header: 'Size Breakdown', key: 'sizes', width: 50 }
    ];

    assignmentInfo.forEach(asg => {
      worksheet.addRow({
        lot_no: asg.lot_no,
        total_pieces: asg.total_pieces,
        assembled: asg.assembled,
        pending: asg.pending,
        assigned_on: new Date(asg.assigned_on).toLocaleString(),
        sizes: asg.sizes
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="JeansAssemblyPendency.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Jeans Assembly Excel pendency:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/washing
 * Washing Pendency Dashboard:
 * 1) Summary for each washing operator.
 * 2) Detailed view for a chosen washing operator.
 **************************************************/
router.get('/pendency-report/washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Summary for washing operators:
    const [usersSummary] = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.username,
        COUNT(wa.id) AS total_assignments,
        SUM(CASE WHEN wd.id IS NOT NULL THEN 1 ELSE 0 END) AS completed_assignments,
        SUM(CASE WHEN wd.id IS NULL THEN 1 ELSE 0 END) AS pending_assignments
      FROM washing_assignments wa
      JOIN users u ON wa.user_id = u.id
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      LEFT JOIN washing_data wd ON jd.lot_no = wd.lot_no
      WHERE wa.is_approved = 1
      GROUP BY u.id, u.username
      ORDER BY u.username
    `);

    const selectedUserId = req.query.user_id || "";
    let detailedAssignments = [];
    let detailedSummary = { totalAssigned: 0, totalPending: 0 };

    if (selectedUserId) {
      const [assignRows] = await pool.query(`
        SELECT wa.id AS assignment_id,
               wa.jeans_assembly_assignment_id,
               wa.assigned_on,
               jd.lot_no,
               jd.total_pieces
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        WHERE wa.user_id = ?
        ORDER BY wa.assigned_on DESC
      `, [selectedUserId]);

      const assignmentInfo = await Promise.all(assignRows.map(async asg => {
        const [washDataRows] = await pool.query(`
          SELECT id, total_pieces
          FROM washing_data
          WHERE lot_no = ?
          LIMIT 1
        `, [asg.lot_no]);
        let washedTotal = 0;
        let washDataId = null;
        if (washDataRows.length > 0) {
          washDataId = washDataRows[0].id;
          washedTotal = parseFloat(washDataRows[0].total_pieces) || 0;
        }
        const lotTotal = parseFloat(asg.total_pieces) || 0;
        const pendingTotal = lotTotal - washedTotal;
        // (Optional: include size breakdown if washing sizes are stored)
        return {
          assignment_id: asg.assignment_id,
          lot_no: asg.lot_no,
          total_pieces: lotTotal,
          washed: washedTotal,
          pending: pendingTotal,
          assigned_on: asg.assigned_on
        };
      }));

      assignmentInfo.forEach(asg => {
        detailedSummary.totalAssigned += asg.total_pieces;
        detailedSummary.totalPending += asg.pending;
      });
      detailedAssignments = assignmentInfo;
    }

    return res.render("operatorWashingPendencyReport", {
      usersSummary,
      selectedUserId,
      detailedAssignments,
      detailedSummary,
      query: req.query
    });
  } catch (err) {
    console.error("Error generating washing pendency report:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/washing/download
 * – Generate Excel for the detailed washing pendency report.
 **************************************************/
router.get('/pendency-report/washing/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const selectedUserId = req.query.user_id || "";
    if (!selectedUserId) return res.status(400).send("User not selected.");

    const [assignRows] = await pool.query(`
      SELECT wa.id AS assignment_id,
             wa.jeans_assembly_assignment_id,
             wa.assigned_on,
             jd.lot_no,
             jd.total_pieces
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      WHERE wa.user_id = ?
      ORDER BY wa.assigned_on DESC
    `, [selectedUserId]);

    const assignmentInfo = await Promise.all(assignRows.map(async asg => {
      const [washDataRows] = await pool.query(`
        SELECT id, total_pieces
        FROM washing_data
        WHERE lot_no = ?
        LIMIT 1
      `, [asg.lot_no]);
      let washedTotal = 0, washDataId = null;
      if (washDataRows.length > 0) {
        washDataId = washDataRows[0].id;
        washedTotal = parseFloat(washDataRows[0].total_pieces) || 0;
      }
      const lotTotal = parseFloat(asg.total_pieces) || 0;
      const pendingTotal = lotTotal - washedTotal;
      return {
        lot_no: asg.lot_no,
        total_pieces: lotTotal,
        washed: washedTotal,
        pending: pendingTotal,
        assigned_on: asg.assigned_on
      };
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Operator Dashboard – Washing Pendency';
    const worksheet = workbook.addWorksheet('WashingPendency');

    worksheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 15 },
      { header: 'Washed', key: 'washed', width: 15 },
      { header: 'Pending', key: 'pending', width: 15 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 }
    ];

    assignmentInfo.forEach(asg => {
      worksheet.addRow({
        lot_no: asg.lot_no,
        total_pieces: asg.total_pieces,
        washed: asg.washed,
        pending: asg.pending,
        assigned_on: new Date(asg.assigned_on).toLocaleString()
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="WashingPendency.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Excel for washing pendency:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/finishing
 * Finishing Pendency Dashboard:
 * 1) Summary for each finishing operator.
 * 2) Detailed view for a selected finishing operator.
 **************************************************/
router.get('/pendency-report/finishing', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Summary for finishing operators.
    // For Akshay lots, finishing is from washing_data to finishing_data;
    // for non-Akshay lots, from stitching_data to finishing_data.
    const [usersSummary] = await pool.query(`
      SELECT 
        u.id AS user_id,
        u.username,
        COUNT(fa.id) AS total_assignments,
        SUM(CASE WHEN fData.id IS NOT NULL THEN 1 ELSE 0 END) AS completed_assignments,
        SUM(CASE WHEN fData.id IS NULL THEN 1 ELSE 0 END) AS pending_assignments
      FROM finishing_assignments fa
      JOIN users u ON fa.user_id = u.id
      LEFT JOIN (
        SELECT lot_no, id FROM finishing_data
      ) fData ON (
        CASE 
          WHEN fa.washing_assignment_id IS NOT NULL 
          THEN (SELECT lot_no FROM washing_data WHERE id = fa.washing_assignment_id LIMIT 1)
          ELSE (SELECT lot_no FROM stitching_data WHERE id = fa.stitching_assignment_id LIMIT 1)
        END
      )
      WHERE fa.is_approved = 1
      GROUP BY u.id, u.username
      ORDER BY u.username
    `);

    const selectedUserId = req.query.user_id || "";
    let detailedAssignments = [];
    let detailedSummary = { totalAssigned: 0, totalPending: 0 };

    if (selectedUserId) {
      // Detailed view: For each finishing assignment for the operator, decide which data to use:
      const [assignRows] = await pool.query(`
        SELECT fa.id AS assignment_id,
               fa.assigned_on,
               CASE 
                 WHEN fa.washing_assignment_id IS NOT NULL 
                 THEN (SELECT lot_no FROM washing_data WHERE id = fa.washing_assignment_id LIMIT 1)
                 ELSE (SELECT lot_no FROM stitching_data WHERE id = fa.stitching_assignment_id LIMIT 1)
               END AS lot_no,
               CASE 
                 WHEN fa.washing_assignment_id IS NOT NULL 
                 THEN (SELECT total_pieces FROM washing_data WHERE id = fa.washing_assignment_id LIMIT 1)
                 ELSE (SELECT total_pieces FROM stitching_data WHERE id = fa.stitching_assignment_id LIMIT 1)
               END AS total_pieces
        FROM finishing_assignments fa
        WHERE fa.user_id = ?
        ORDER BY fa.assigned_on DESC
      `, [selectedUserId]);

      const assignmentInfo = await Promise.all(assignRows.map(async asg => {
        const [fDataRows] = await pool.query(`
          SELECT id, total_pieces
          FROM finishing_data
          WHERE lot_no = ?
          LIMIT 1
        `, [asg.lot_no]);
        let finishedTotal = 0;
        if (fDataRows.length > 0) {
          finishedTotal = parseFloat(fDataRows[0].total_pieces) || 0;
        }
        const lotTotal = parseFloat(asg.total_pieces) || 0;
        const pendingTotal = lotTotal - finishedTotal;
        // Size breakdown can be added here if finishing_data_sizes is available.
        return {
          assignment_id: asg.assignment_id,
          lot_no: asg.lot_no,
          total_pieces: lotTotal,
          finished: finishedTotal,
          pending: pendingTotal,
          assigned_on: asg.assigned_on
        };
      }));

      assignmentInfo.forEach(asg => {
        detailedSummary.totalAssigned += asg.total_pieces;
        detailedSummary.totalPending += asg.pending;
      });
      detailedAssignments = assignmentInfo;
    }

    return res.render("operatorFinishingPendencyReport", {
      usersSummary,
      selectedUserId,
      detailedAssignments,
      detailedSummary,
      query: req.query
    });
  } catch (err) {
    console.error("Error generating finishing pendency report:", err);
    res.status(500).send("Server error");
  }
});

/**************************************************
 * GET /operator/pendency-report/finishing/download
 * – Generate Excel for the detailed finishing pendency report.
 **************************************************/
router.get('/pendency-report/finishing/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const selectedUserId = req.query.user_id || "";
    if (!selectedUserId) return res.status(400).send("User not selected.");

    const [assignRows] = await pool.query(`
      SELECT fa.id AS assignment_id,
             fa.assigned_on,
             CASE 
               WHEN fa.washing_assignment_id IS NOT NULL 
               THEN (SELECT lot_no FROM washing_data WHERE id = fa.washing_assignment_id LIMIT 1)
               ELSE (SELECT lot_no FROM stitching_data WHERE id = fa.stitching_assignment_id LIMIT 1)
             END AS lot_no,
             CASE 
               WHEN fa.washing_assignment_id IS NOT NULL 
               THEN (SELECT total_pieces FROM washing_data WHERE id = fa.washing_assignment_id LIMIT 1)
               ELSE (SELECT total_pieces FROM stitching_data WHERE id = fa.stitching_assignment_id LIMIT 1)
             END AS total_pieces
      FROM finishing_assignments fa
      WHERE fa.user_id = ?
      ORDER BY fa.assigned_on DESC
    `, [selectedUserId]);

    const assignmentInfo = await Promise.all(assignRows.map(async asg => {
      const [fDataRows] = await pool.query(`
        SELECT id, total_pieces
        FROM finishing_data
        WHERE lot_no = ?
        LIMIT 1
      `, [asg.lot_no]);
      let finishedTotal = 0;
      if (fDataRows.length > 0) {
        finishedTotal = parseFloat(fDataRows[0].total_pieces) || 0;
      }
      const lotTotal = parseFloat(asg.total_pieces) || 0;
      const pendingTotal = lotTotal - finishedTotal;
      return {
        lot_no: asg.lot_no,
        total_pieces: lotTotal,
        finished: finishedTotal,
        pending: pendingTotal,
        assigned_on: asg.assigned_on
      };
    }));

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Operator Dashboard – Finishing Pendency';
    const worksheet = workbook.addWorksheet('FinishingPendency');

    worksheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 15 },
      { header: 'Finished', key: 'finished', width: 15 },
      { header: 'Pending', key: 'pending', width: 15 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 }
    ];

    assignmentInfo.forEach(asg => {
      worksheet.addRow({
        lot_no: asg.lot_no,
        total_pieces: asg.total_pieces,
        finished: asg.finished,
        pending: asg.pending,
        assigned_on: new Date(asg.assigned_on).toLocaleString()
      });
    });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="FinishingPendency.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Excel for finishing pendency:", err);
    res.status(500).send("Server error");
  }
});
// Add this new route at the end of your operatorRoutes.js

// GET /operator/dashboard/converted-report
// GET /operator/dashboard/converted-report
router.get("/dashboard/converted-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    // Extract query parameters:
    // - lotType: "all" | "akshay" | "non-akshay"
    // - filterStage: "cutting" | "stitching" | "finishing" | "jeans" | "washing"
    // - startDate & endDate: date range for the chosen stage
    const { lotType = "all", filterStage = "cutting", startDate, endDate } = req.query;
    const now = new Date();
    const defaultEnd = now.toISOString().slice(0,10);
    const defaultStart = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
    const stageStart = startDate || defaultStart;
    const stageEnd   = endDate || defaultEnd;
    
    // Build a lotType filter clause based on the creator username.
    let lotTypeClause = "";
    if (lotType === "akshay") {
      lotTypeClause = " AND LOWER(u.username) = 'akshay'";
    } else if (lotType === "non-akshay") {
      lotTypeClause = " AND LOWER(u.username) <> 'akshay'";
    }
    
    // Build the base query depending on the filterStage.
    // For "cutting", use cutting_lots.created_at;
    // for others, use a subquery to get the latest record's created_at.
    let baseQuery = "";
    let params = [];
    if (filterStage === "cutting") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces, cl.created_at AS stageDate, u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE DATE(cl.created_at) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY cl.created_at DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "stitching") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM stitching_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM stitching_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "finishing") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM finishing_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM finishing_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "jeans") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM jeans_assembly_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM jeans_assembly_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "washing") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM washing_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM washing_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    }
    
    const [lots] = await pool.query(baseQuery, params);
    
    // For each lot, get additional stage data (stitching, finishing, and if Akshay: jeans assembly and washing).
    const reportData = await Promise.all(lots.map(async (lot) => {
      const lotNo = lot.lot_no;
      const cuttingQty = parseFloat(lot.total_pieces) || 0;
      const isAkshay = lot.created_by.toLowerCase() === "akshay";
      
      // Stitching Data
      const [stRows] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces), 0) AS stitchingQuantity, MAX(created_at) AS stitchingDate FROM stitching_data WHERE lot_no = ?",
        [lotNo]
      );
      const stitchingQuantity = parseFloat(stRows[0].stitchingQuantity) || 0;
      const stitchingDate = stRows[0].stitchingDate ? new Date(stRows[0].stitchingDate) : null;
      const [stOpRows] = await pool.query(
        "SELECT u.username FROM stitching_assignments sa JOIN users u ON sa.user_id = u.id WHERE sa.cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY sa.assigned_on DESC LIMIT 1",
        [lotNo]
      );
      const stitchingUsername = stOpRows.length ? stOpRows[0].username : "N/A";
      // Compute leftover from cutting not stitched.
      const cuttingStitchingQty = cuttingQty - stitchingQuantity;
      
      // Finishing Data
      const [fiRows] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces), 0) AS finishingQuantity, MAX(created_at) AS finishingDate FROM finishing_data WHERE lot_no = ?",
        [lotNo]
      );
      const finishingQuantity = parseFloat(fiRows[0].finishingQuantity) || 0;
      const finishingDate = fiRows[0].finishingDate ? new Date(fiRows[0].finishingDate) : null;
      let finishingUsername = "N/A";
      if (isAkshay) {
        const [fiOpRows1] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN washing_data wd ON fa.washing_assignment_id = wd.id WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        finishingUsername = fiOpRows1.length ? fiOpRows1[0].username : "N/A";
      } else {
        const [fiOpRows2] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        finishingUsername = fiOpRows2.length ? fiOpRows2[0].username : "N/A";
      }
      
      // For Akshay lots: Jeans Assembly & Washing Data
      let jeansAssemblyQuantity = "N/A";
      let jeansAssemblyDate = null;
      let jeansAssemblyUser = "N/A";
      let jeansStitchingQty = "N/A";
      let washingQuantity = "N/A";
      let washingDate = null;
      let washingUsername = "N/A";
      if (isAkshay) {
        const [jaRows] = await pool.query(
          "SELECT COALESCE(SUM(total_pieces), 0) AS jaQuantity, MAX(created_at) AS jaDate FROM jeans_assembly_data WHERE lot_no = ?",
          [lotNo]
        );
        jeansAssemblyQuantity = parseFloat(jaRows[0].jaQuantity) || 0;
        jeansAssemblyDate = jaRows[0].jaDate ? new Date(jaRows[0].jaDate) : null;
        const [jaOpRows] = await pool.query(
          "SELECT u.username FROM jeans_assembly_assignments ja JOIN users u ON ja.user_id = u.id JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY ja.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        jeansAssemblyUser = jaOpRows.length ? jaOpRows[0].username : "N/A";
        jeansStitchingQty = stitchingQuantity - jeansAssemblyQuantity;
        
        const [waRows] = await pool.query(
          "SELECT COALESCE(SUM(total_pieces), 0) AS washingQuantity, MAX(created_at) AS washingDate FROM washing_data WHERE lot_no = ?",
          [lotNo]
        );
        washingQuantity = parseFloat(waRows[0].washingQuantity) || 0;
        washingDate = waRows[0].washingDate ? new Date(waRows[0].washingDate) : null;
        const [waOpRows] = await pool.query(
          "SELECT u.username FROM washing_assignments wa JOIN users u ON wa.user_id = u.id JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        washingUsername = waOpRows.length ? waOpRows[0].username : "N/A";
      }
      
      return {
        lot_no: lotNo,
        remark: lot.remark,
        sku: lot.sku,
        total_pieces: cuttingQty,
        created_at: new Date(lot.stageDate),
        stitchingQuantity,
        stitchingUsername,
        stitchingDate,
        cuttingStitchingQty,
        finishingQuantity,
        finishingUsername,
        finishingDate,
        isAkshay,
        jeansAssemblyQuantity,
        jeansAssemblyUser,
        jeansAssemblyDate,
        jeansStitchingQty,
        washingQuantity,
        washingUsername,
        washingDate
      };
    }));
    
    const filters = {
      lotType,
      filterStage,
      startDate: stageStart,
      endDate: stageEnd
    };
    
    return res.render("operatorConvertedReport", { reportData, filters });
  } catch (err) {
    console.error("Error generating converted report:", err);
    return res.status(500).send("Server error");
  }
});

// GET /operator/dashboard/converted-report/download
router.get("/dashboard/converted-report/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    // Use the same query parameters and logic as the UI route
    const { lotType = "all", filterStage = "cutting", startDate, endDate } = req.query;
    const now = new Date();
    const defaultEnd = now.toISOString().slice(0,10);
    const defaultStart = new Date(now.getTime()-10*24*60*60*1000).toISOString().slice(0,10);
    const stageStart = startDate || defaultStart;
    const stageEnd   = endDate || defaultEnd;
    
    let lotTypeClause = "";
    if (lotType === "akshay") {
      lotTypeClause = " AND LOWER(u.username) = 'akshay'";
    } else if (lotType === "non-akshay") {
      lotTypeClause = " AND LOWER(u.username) <> 'akshay'";
    }
    
    let baseQuery = "";
    let params = [];
    if (filterStage === "cutting") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces, cl.created_at AS stageDate, u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE DATE(cl.created_at) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY cl.created_at DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "stitching") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM stitching_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM stitching_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "finishing") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM finishing_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM finishing_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "jeans") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM jeans_assembly_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM jeans_assembly_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    } else if (filterStage === "washing") {
      baseQuery = `
        SELECT cl.lot_no, cl.remark, cl.sku, cl.total_pieces,
          (SELECT MAX(created_at) FROM washing_data WHERE lot_no = cl.lot_no) AS stageDate,
          u.username AS created_by
        FROM cutting_lots cl 
        JOIN users u ON cl.user_id = u.id
        WHERE (SELECT MAX(created_at) FROM washing_data WHERE lot_no = cl.lot_no) BETWEEN ? AND ? ${lotTypeClause}
        ORDER BY stageDate DESC
      `;
      params = [stageStart, stageEnd];
    }
    
    const [lots] = await pool.query(baseQuery, params);
    
    const reportData = await Promise.all(lots.map(async (lot) => {
      const lotNo = lot.lot_no;
      const cuttingQty = parseFloat(lot.total_pieces) || 0;
      const isAkshay = lot.created_by.toLowerCase() === "akshay";
      
      const [stRows] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces), 0) AS stitchingQuantity, MAX(created_at) AS stitchingDate FROM stitching_data WHERE lot_no = ?",
        [lotNo]
      );
      const stitchingQuantity = parseFloat(stRows[0].stitchingQuantity) || 0;
      const stitchingDate = stRows[0].stitchingDate ? new Date(stRows[0].stitchingDate) : null;
      const [stOpRows] = await pool.query(
        "SELECT u.username FROM stitching_assignments sa JOIN users u ON sa.user_id = u.id WHERE sa.cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY sa.assigned_on DESC LIMIT 1",
        [lotNo]
      );
      const stitchingUsername = stOpRows.length ? stOpRows[0].username : "N/A";
      const cuttingStitchingQty = cuttingQty - stitchingQuantity;
      
      const [fiRows] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces), 0) AS finishingQuantity, MAX(created_at) AS finishingDate FROM finishing_data WHERE lot_no = ?",
        [lotNo]
      );
      const finishingQuantity = parseFloat(fiRows[0].finishingQuantity) || 0;
      const finishingDate = fiRows[0].finishingDate ? new Date(fiRows[0].finishingDate) : null;
      let finishingUsername = "N/A";
      if (isAkshay) {
        const [fiOpRows1] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN washing_data wd ON fa.washing_assignment_id = wd.id WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        finishingUsername = fiOpRows1.length ? fiOpRows1[0].username : "N/A";
      } else {
        const [fiOpRows2] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN users u ON fa.user_id = u.id JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        finishingUsername = fiOpRows2.length ? fiOpRows2[0].username : "N/A";
      }
      
      let jeansAssemblyQuantity = "N/A";
      let jeansAssemblyDate = null;
      let jeansAssemblyUser = "N/A";
      let jeansStitchingQty = "N/A";
      let washingQuantity = "N/A";
      let washingDate = null;
      let washingUsername = "N/A";
      if (isAkshay) {
        const [jaRows] = await pool.query(
          "SELECT COALESCE(SUM(total_pieces), 0) AS jaQuantity, MAX(created_at) AS jaDate FROM jeans_assembly_data WHERE lot_no = ?",
          [lotNo]
        );
        jeansAssemblyQuantity = parseFloat(jaRows[0].jaQuantity) || 0;
        jeansAssemblyDate = jaRows[0].jaDate ? new Date(jaRows[0].jaDate) : null;
        const [jaOpRows] = await pool.query(
          "SELECT u.username FROM jeans_assembly_assignments ja JOIN users u ON ja.user_id = u.id JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY ja.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        jeansAssemblyUser = jaOpRows.length ? jaOpRows[0].username : "N/A";
        jeansStitchingQty = stitchingQuantity - jeansAssemblyQuantity;
        
        const [waRows] = await pool.query(
          "SELECT COALESCE(SUM(total_pieces), 0) AS washingQuantity, MAX(created_at) AS washingDate FROM washing_data WHERE lot_no = ?",
          [lotNo]
        );
        washingQuantity = parseFloat(waRows[0].washingQuantity) || 0;
        washingDate = waRows[0].washingDate ? new Date(waRows[0].washingDate) : null;
        const [waOpRows] = await pool.query(
          "SELECT u.username FROM washing_assignments wa JOIN users u ON wa.user_id = u.id JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1",
          [lotNo]
        );
        washingUsername = waOpRows.length ? waOpRows[0].username : "N/A";
      }
      
      return {
        lot_no: lotNo,
        remark: lot.remark,
        sku: lot.sku,
        total_pieces: cuttingQty,
        created_at: new Date(lot.stageDate),
        stitchingQuantity,
        stitchingUsername,
        stitchingDate,
        cuttingStitchingQty,
        finishingQuantity,
        finishingUsername,
        finishingDate,
        isAkshay,
        jeansAssemblyQuantity,
        jeansAssemblyUser,
        jeansAssemblyDate,
        jeansStitchingQty,
        washingQuantity,
        washingUsername,
        washingDate
      };
    }));
    
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Operator Dashboard - Converted Report";
    const worksheet = workbook.addWorksheet("Converted Report");
    
    // Define columns – for all lots plus extra columns for Akshay.
    let columns = [
      { header: "Lot No", key: "lot_no", width: 15 },
      { header: "Remark", key: "remark", width: 20 },
      { header: "SKU", key: "sku", width: 15 },
      { header: "Total Pieces", key: "total_pieces", width: 15 },
      { header: "Created At", key: "created_at", width: 20 },
      { header: "Stitching Qty", key: "stitchingQuantity", width: 15 },
      { header: "Stitching User", key: "stitchingUsername", width: 15 },
      { header: "Stitching Date", key: "stitchingDate", width: 20 },
      { header: "Cutting-Stitching Qty", key: "cuttingStitchingQty", width: 20 },
      { header: "Finishing Qty", key: "finishingQuantity", width: 15 },
      { header: "Finishing User", key: "finishingUsername", width: 15 },
      { header: "Finishing Date", key: "finishingDate", width: 20 }
    ];
    // Add extra columns only if filtering for Akshay or All (and if the lot is Akshay).
    if (lotType === "akshay" || lotType === "all") {
      columns = columns.concat([
        { header: "Jeans Assembly Qty", key: "jeansAssemblyQuantity", width: 20 },
        { header: "Jeans Assembly User", key: "jeansAssemblyUser", width: 20 },
        { header: "Jeans Assembly Date", key: "jeansAssemblyDate", width: 20 },
        { header: "Jeans-Stitching Qty", key: "jeansStitchingQty", width: 20 },
        { header: "Washing Qty", key: "washingQuantity", width: 15 },
        { header: "Washing User", key: "washingUsername", width: 15 },
        { header: "Washing Date", key: "washingDate", width: 20 }
      ]);
    }
    worksheet.columns = columns;
    
    reportData.forEach(item => {
      worksheet.addRow({
        lot_no: item.lot_no,
        remark: item.remark,
        sku: item.sku,
        total_pieces: item.total_pieces,
        created_at: item.created_at.toLocaleString(),
        stitchingQuantity: item.stitchingQuantity,
        stitchingUsername: item.stitchingUsername,
        stitchingDate: item.stitchingDate ? item.stitchingDate.toLocaleString() : "N/A",
        cuttingStitchingQty: item.cuttingStitchingQty,
        finishingQuantity: item.finishingQuantity,
        finishingUsername: item.finishingUsername,
        finishingDate: item.finishingDate ? item.finishingDate.toLocaleString() : "N/A",
        jeansAssemblyQuantity: item.isAkshay ? item.jeansAssemblyQuantity : "N/A",
        jeansAssemblyUser: item.isAkshay ? item.jeansAssemblyUser : "N/A",
        jeansAssemblyDate: item.isAkshay && item.jeansAssemblyDate ? item.jeansAssemblyDate.toLocaleString() : "N/A",
        jeansStitchingQty: item.isAkshay ? item.jeansStitchingQty : "N/A",
        washingQuantity: item.isAkshay ? item.washingQuantity : "N/A",
        washingUsername: item.isAkshay ? item.washingUsername : "N/A",
        washingDate: item.isAkshay && item.washingDate ? item.washingDate.toLocaleString() : "N/A"
      });
    });
    
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="ConvertedReport.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Excel for converted report:", err);
    res.status(500).send("Server error");
  }
});
/********************************************************************
 * GET /operator/dashboard/pic-report
 * Shows a form allowing the user to filter and see “Pendency / In-Line / Completed” data
 * for each department (Cutting, Stitching, Assembly, Washing, Finishing).
 * “download=1” triggers Excel export instead of HTML.
 ********************************************************************/
/**
 * GET /operator/dashboard/pic-report
 * 
 * Lets the user filter by:
 *  • Lot Type (all, denim, hosiery) – denim if lot_no starts with "AK" or "UM".
 *  • Department (all, cutting, stitching, assembly, washing, finishing).
 *  • Status (all, pending, inline, completed, denied, not_assigned).
 *  • Date Filter: createdAt or assignedOn
 *  • Start/End date
 * 
 * The key logic is a CHAIN approach:
 *   Cutting → Stitching → (Denim only) Assembly → (Denim only) Washing → Finishing
 * 
 * If a department is NOT assigned, we mark *that* dept and all subsequent
 * depts as "In {previous dept}."
 * 
 * This ensures if, say, there's no stitching assignment,
 * everything from stitching onward is "In Cutting."
 * 
 * Or if there's a stitching assignment but no assembly assignment,
 * then assembly, washing, finishing = "In Stitching."
 */
router.get("/dashboard/pic-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    // 1) Parse query
    const {
      lotType = "all",            // "all" | "denim" | "hosiery"
      department = "all",         // "all" | "cutting" | "stitching" | "assembly" | "washing" | "finishing"
      status = "all",             // "all" | "pending" | "inline" | "completed" | "denied" | "not_assigned"
      dateFilter = "createdAt",   // "createdAt" | "assignedOn"
      startDate = "",
      endDate = "",
      download = ""
    } = req.query;

    // 2) Build date filtering for cutting_lots (createdAt) or assignments (assignedOn)
    let dateWhere = "";
    const dateParams = [];
    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        // Filter by assignment dates for the chosen department if not "all"
        // (You can refine or expand to handle all depts if needed.)
        if (department === "stitching") {
          dateWhere = `
            AND EXISTS (
              SELECT 1 FROM stitching_assignments sa
              JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
              WHERE c2.lot_no = cl.lot_no
                AND DATE(sa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "assembly") {
          dateWhere = `
            AND EXISTS (
              SELECT 1 FROM jeans_assembly_assignments ja
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
              SELECT 1 FROM washing_assignments wa
              JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
              JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
              WHERE c2.lot_no = cl.lot_no
                AND DATE(wa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "finishing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1 FROM finishing_assignments fa
              LEFT JOIN washing_data wd ON fa.washing_assignment_id = wd.id
              LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
              JOIN cutting_lots c2 ON (
                wd.lot_no = c2.lot_no OR sd.lot_no = c2.lot_no
              )
              WHERE c2.lot_no = cl.lot_no
                AND DATE(fa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        }
      }
    }

    // 3) Build "lotType" filter
    let lotTypeClause = "";
    if (lotType === "denim") {
      // Denim => lot_no starts with AK or UM (case-insensitive)
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) LIKE 'AK%'
          OR UPPER(cl.lot_no) LIKE 'UM%'
        )
      `;
    } else if (lotType === "hosiery") {
      // Hosiery => everything else
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) NOT LIKE 'AK%'
          AND UPPER(cl.lot_no) NOT LIKE 'UM%'
        )
      `;
    }

    // 4) Fetch from cutting_lots
    const baseQuery = `
      SELECT
        cl.lot_no,
        cl.sku,
        cl.total_pieces,
        cl.created_at,
        cl.remark,
        u.username AS created_by
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      WHERE 1=1
        ${lotTypeClause}
        ${dateWhere}
      ORDER BY cl.created_at DESC
    `;
    const [lots] = await pool.query(baseQuery, dateParams);

    // 5) Prepare results
    const finalData = [];
    for (const lot of lots) {
      const lotNo = lot.lot_no;
      const isDenim = isDenimLot(lotNo); // "AK"/"UM" => denim
      const totalCut = parseFloat(lot.total_pieces) || 0;

      // Gather sums from each data table
      const stitchedQty   = await getStitchedQty(lotNo);
      const assembledQty  = isDenim ? await getAssembledQty(lotNo) : 0;
      const washedQty     = isDenim ? await getWashedQty(lotNo) : 0;
      const finishedQty   = await getFinishedQty(lotNo);

      // Grab the last assignment rows
      const stAssign  = await getLastStitchingAssignment(lotNo);
      const asmAssign = isDenim ? await getLastAssemblyAssignment(lotNo) : null;
      const washAssign= isDenim ? await getLastWashingAssignment(lotNo) : null;
      const finAssign = await getLastFinishingAssignment(lotNo, isDenim);

      // Build each department’s status using a chain approach
      const {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn
      } = getDepartmentStatuses({
        isDenim,
        totalCut,
        stitchedQty,
        assembledQty,
        washedQty,
        finishedQty,
        stAssign,
        asmAssign,
        washAssign,
        finAssign
      });

      // 6) Now filter out by department & status
      const deptResult = filterByDept({
        department,
        isDenim,
        stitchingStatus,
        assemblyStatus,
        washingStatus,
        finishingStatus
      });
      if (!deptResult.showRow) {
        // skip
        continue;
      }
      // if user selected a status != all, check if that step’s status matches
      if (status !== "all") {
        const check = deptResult.actualStatus.toLowerCase();
        const want = status.toLowerCase();

        // If user said "not_assigned", that means we want "In Cutting", "In Stitching", etc.
        // So let's unify the logic
        if (want === "not_assigned") {
          // We'll treat any string starting with "In " as "not assigned"
          if (!check.startsWith("in ")) {
            continue;
          }
        } else if (!check.includes(want)) {
          // handle small synonyms: "inline" => "in-line"
          if (want === "inline" && check.includes("in-line")) {
            // pass
          } else if (want === "pending" && check.includes("pending")) {
            // pass
          } else if (want === "denied" && check.includes("denied")) {
            // pass
          } else if (want === "completed" && check.includes("completed")) {
            // pass
          } else {
            continue;
          }
        }
      }

      // 7) All filters passed => add row
      finalData.push({
        lotNo,
        sku: lot.sku,
        lotType: isDenim ? "Denim" : "Hosiery",
        totalCut,
        createdAt: lot.created_at ? new Date(lot.created_at).toLocaleDateString() : "",
        remark: lot.remark || "",

        stitchAssignedOn: stitchingAssignedOn,
        stitchOp: stitchingOp,
        stitchStatus: stitchingStatus,
        stitchedQty,

        assemblyAssignedOn,
        assemblyOp,
        assemblyStatus,
        assembledQty,

        washingAssignedOn,
        washingOp,
        washingStatus,
        washedQty,

        finishingAssignedOn,
        finishingOp,
        finishingStatus,
        finishedQty
      });
    }

    // 8) Download or Render
    if (download === "1") {
      return exportPICExcel(res, finalData);
    } else {
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

/** 
 * HELPER: isDenimLot => true if lotNo starts with "AK" or "UM" 
 */
function isDenimLot(lotNo="") {
  const up = lotNo.toUpperCase();
  return up.startsWith("AK") || up.startsWith("UM");
}

/**
 * HELPER: filterByDept – decides if we show the row based on user’s "department"
 * and returns the actualStatus for "status" filter matching.
 */
function filterByDept({
  department,
  isDenim,
  stitchingStatus,
  assemblyStatus,
  washingStatus,
  finishingStatus
}) {
  let showRow = true;
  let actualStatus = "N/A";

  if (department === "all") {
    // We pick finishing if it’s not "N/A," else washing, else assembly, else stitching
    if (isDenim) {
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus = washingStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus = assemblyStatus;
      else actualStatus = stitchingStatus;
    } else {
      // hosiery
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else actualStatus = stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department === "cutting") {
    // If the user chooses "cutting," you might always show "Completed" or skip entirely.
    // Let’s say we show everything as "Completed from day 1." 
    actualStatus = "Completed";
    return { showRow, actualStatus };
  }

  if (department === "stitching") {
    actualStatus = stitchingStatus;
    return { showRow, actualStatus };
  }

  if (department === "assembly") {
    if (!isDenim) {
      // no assembly in hosiery
      return { showRow: false, actualStatus: "N/A" };
    }
    actualStatus = assemblyStatus;
    return { showRow, actualStatus };
  }

  if (department === "washing") {
    if (!isDenim) {
      return { showRow: false, actualStatus: "N/A" };
    }
    actualStatus = washingStatus;
    return { showRow, actualStatus };
  }

  if (department === "finishing") {
    actualStatus = finishingStatus;
    return { showRow, actualStatus };
  }

  // fallback
  return { showRow, actualStatus };
}

/** 
 * HELPER: getDepartmentStatuses – the chain logic
 * 
 *  For Denim: 
 *   1) If no stitching assignment => 
 *      stitching="In Cutting", assembly/washing/finishing="In Cutting" => done
 *   2) If stitching is Denied => 
 *      stitching="Denied by X", assembly/washing/finishing="In Stitching" => done
 *   3) If stitching is NotApproved => 
 *      stitching="Has Not been Approved By X", assembly/washing/finishing="In Stitching" => done
 *   4) If stitching is Approved => partial or complete => we fill "In-Line"/"x Pending"/"Completed"
 *      then move on to Assembly:
 *      • If no assembly => assembly/washing/finishing="In Stitching"
 *      • Else check approval => possibly "Denied", then washing/finishing="In Assembly", etc.
 *      • If assembly is good => partial or complete => "Pending" or "Completed"
 *        move to washing, etc...
 *      and so forth until finishing.
 * 
 * For Hosiery:
 *   1) If no stitching => stitching/finishing="In Cutting"
 *   2) If stitching is Denied => stitching="Denied...", finishing="In Stitching"
 *   3) If notApproved => stitching="Has Not...", finishing="In Stitching"
 *   4) If approved => partial or complete => proceed to finishing
 *      If no finishing => finishing="In Stitching"
 *      else check finishing assignment => done
 */
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washedQty,
  finishedQty,
  stAssign,
  asmAssign,
  washAssign,
  finAssign
}) {
  // For convenience, define placeholders
  let stitchingStatus  = "N/A";
  let stitchingOp      = "";
  let stitchingAssignedOn = "";
  let assemblyStatus   = isDenim ? "N/A" : "—"; // just for clarity
  let assemblyOp       = "";
  let assemblyAssignedOn = "";
  let washingStatus    = isDenim ? "N/A" : "—";
  let washingOp        = "";
  let washingAssignedOn= "";
  let finishingStatus  = "N/A";
  let finishingOp      = "";
  let finishingAssignedOn= "";

  //
  // 1) Stitching
  //
  if (!stAssign) {
    // no stitching assignment => from stitching onward is "In Cutting"
    stitchingStatus = "In Cutting";
    if (isDenim) {
      assemblyStatus = "In Cutting";
      washingStatus  = "In Cutting";
      finishingStatus= "In Cutting";
    } else {
      finishingStatus= "In Cutting";
    }
    // done
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn,
      washingStatus, washingOp, washingAssignedOn,
      finishingStatus, finishingOp, finishingAssignedOn
    };
  } else {
    const { isApproved, assigned_on, user_id } = stAssign;
    if (assigned_on) {
      stitchingAssignedOn = new Date(assigned_on).toLocaleString();
    }
    // operator
    const stOpName = user_id ? (/* we would have looked up the user before? or store it in stAssign? */ stAssign.opName || "Unknown") : "";
    stitchingOp = stOpName;

    if (isApproved === null) {
      stitchingStatus = `Has Not been Approved By ${stOpName}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingStatus  = "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn,
        washingStatus, washingOp, washingAssignedOn,
        finishingStatus, finishingOp, finishingAssignedOn
      };
    } else if (isApproved == 0) {
      stitchingStatus = `Denied by ${stOpName}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingStatus  = "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn,
        washingStatus, washingOp, washingAssignedOn,
        finishingStatus, finishingOp, finishingAssignedOn
      };
    } else {
      // isApproved=1 => partial or complete
      if (stitchedQty === 0) {
        stitchingStatus = "In-Line"; // assigned, not started
      } else if (stitchedQty >= totalCut && totalCut > 0) {
        stitchingStatus = "Completed";
      } else {
        const pend = totalCut - stitchedQty;
        stitchingStatus = `${pend} Pending`;
      }
    }
  }

  //
  // 2) Assembly (denim only)
  //
  if (isDenim) {
    if (!asmAssign) {
      // no assembly => assembly/washing/finishing = "In Stitching"
      assemblyStatus = "In Stitching";
      washingStatus  = "In Stitching";
      finishingStatus= "In Stitching";
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn,
        washingStatus, washingOp, washingAssignedOn,
        finishingStatus, finishingOp, finishingAssignedOn
      };
    } else {
      const { is_approved, assigned_on, user_id } = asmAssign;
      assemblyAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
      const asmOpName = asmAssign.opName || "Unknown";
      assemblyOp = asmOpName;

      if (is_approved === null) {
        assemblyStatus = `Has Not been Approved By ${asmOpName}`;
        washingStatus  = "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn,
          washingStatus, washingOp, washingAssignedOn,
          finishingStatus, finishingOp, finishingAssignedOn
        };
      } else if (is_approved == 0) {
        assemblyStatus = `Denied by ${asmOpName}`;
        washingStatus  = "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn,
          washingStatus, washingOp, washingAssignedOn,
          finishingStatus, finishingOp, finishingAssignedOn
        };
      } else {
        // is_approved=1 => partial or complete
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
  }

  //
  // 3) Washing (denim only)
  //
  if (isDenim) {
    if (!washAssign) {
      washingStatus  = "In Assembly";
      finishingStatus= "In Assembly";
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn,
        washingStatus, washingOp, washingAssignedOn,
        finishingStatus, finishingOp, finishingAssignedOn
      };
    } else {
      const { is_approved, assigned_on, user_id } = washAssign;
      washingAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
      const washOpName = washAssign.opName || "Unknown";
      washingOp = washOpName;

      if (is_approved === null) {
        washingStatus = `Has Not been Approved By ${washOpName}`;
        finishingStatus = "In Washing";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn,
          washingStatus, washingOp, washingAssignedOn,
          finishingStatus, finishingOp, finishingAssignedOn
        };
      } else if (is_approved == 0) {
        washingStatus = `Denied by ${washOpName}`;
        finishingStatus = "In Washing";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn,
          washingStatus, washingOp, washingAssignedOn,
          finishingStatus, finishingOp, finishingAssignedOn
        };
      } else {
        // approved => partial or complete
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
  }

  //
  // 4) Finishing
  //
  if (!finAssign) {
    // "In Washing" if denim, else "In Stitching" if hosiery
    finishingStatus = isDenim ? "In Washing" : "In Stitching";
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn,
      washingStatus, washingOp, washingAssignedOn,
      finishingStatus, finishingOp, finishingAssignedOn
    };
  } else {
    // we have a finishing assignment
    const { is_approved, isApproved, assigned_on, user_id } = finAssign;
    const finalIsApproved = (typeof is_approved !== "undefined") ? is_approved : isApproved;
    if (assigned_on) {
      finishingAssignedOn = new Date(assigned_on).toLocaleString();
    }
    const finOpName = finAssign.opName || "Unknown";
    finishingOp = finOpName;

    if (finalIsApproved === null) {
      finishingStatus = `Has Not been Approved By ${finOpName}`;
    } else if (finalIsApproved == 0) {
      finishingStatus = `Denied by ${finOpName}`;
    } else {
      // approved => partial or complete
      if (isDenim) {
        // finishing vs. washed
        if (finishedQty === 0) {
          finishingStatus = "In-Line";
        } else if (finishedQty >= washedQty && washedQty > 0) {
          finishingStatus = "Completed";
        } else {
          const pend = washedQty - finishedQty;
          finishingStatus = `${pend} Pending`;
        }
      } else {
        // hosiery => finishing vs. stitched
        if (finishedQty === 0) {
          finishingStatus = "In-Line";
        } else if (finishedQty >= stitchedQty && stitchedQty > 0) {
          finishingStatus = "Completed";
        } else {
          const pend = stitchedQty - finishedQty;
          finishingStatus = `${pend} Pending`;
        }
      }
    }
  }

  return {
    stitchingStatus, stitchingOp, stitchingAssignedOn,
    assemblyStatus, assemblyOp, assemblyAssignedOn,
    washingStatus, washingOp, washingAssignedOn,
    finishingStatus, finishingOp, finishingAssignedOn
  };
}

/** 
 * QUICK HELPERS to fetch sums/assignments 
 * (In your real code, you might do these lookups inline
 * or unify them, but here they're separated for clarity.)
 */
async function getStitchedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
    FROM stitching_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumStitched) || 0;
}
async function getAssembledQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumAsm
    FROM jeans_assembly_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumAsm) || 0;
}
async function getWashedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWash
    FROM washing_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWash) || 0;
}
async function getFinishedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumFin
    FROM finishing_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumFin) || 0;
}

/** 
 * Return the last Stitching assignment for this lot, plus operator name if needed 
 */
async function getLastStitchingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT sa.id, sa.isApproved, sa.assigned_on, sa.user_id
    FROM stitching_assignments sa
    JOIN cutting_lots c ON sa.cutting_lot_id = c.id
    WHERE c.lot_no = ?
    ORDER BY sa.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  // fetch operator name
  if (assign.user_id) {
    const [[u]] = await pool.query(`
      SELECT username FROM users WHERE id=?
    `, [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

/** 
 * Last Jeans Assembly assignment for a denim lot 
 */
async function getLastAssemblyAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT ja.id, ja.is_approved, ja.assigned_on, ja.user_id
    FROM jeans_assembly_assignments ja
    JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
    WHERE sd.lot_no = ?
    ORDER BY ja.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query(`
      SELECT username FROM users WHERE id=?
    `, [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

/** 
 * Last Washing assignment for a denim lot 
 */
async function getLastWashingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT wa.id, wa.is_approved, wa.assigned_on, wa.user_id
    FROM washing_assignments wa
    JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
    WHERE jd.lot_no = ?
    ORDER BY wa.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query(`
      SELECT username FROM users WHERE id=?
    `, [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

/** 
 * Last Finishing assignment:
 *  - Denim => finishing_assignments linked from washing_data
 *  - Hosiery => finishing_assignments linked from stitching_data
 */
async function getLastFinishingAssignment(lotNo, isDenim) {
  if (isDenim) {
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.user_id
      FROM finishing_assignments fa
      JOIN washing_data wd ON fa.washing_assignment_id = wd.id
      WHERE wd.lot_no = ?
      ORDER BY fa.assigned_on DESC
      LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query(`
        SELECT username FROM users WHERE id=?
      `, [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  } else {
    // hosiery
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.user_id
      FROM finishing_assignments fa
      JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
      WHERE sd.lot_no = ?
      ORDER BY fa.assigned_on DESC
      LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query(`
        SELECT username FROM users WHERE id=?
      `, [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  }
}

/** 
 * exportPICExcel – simpler version: 
 * Creates an Excel from finalData and sends to the client.
 */
async function exportPICExcel(res, finalData) {
  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PIC Report";
  const sheet = workbook.addWorksheet("PIC-Report");

  sheet.columns = [
    { header: "Lot No", key: "lotNo", width: 15 },
    { header: "SKU", key: "sku", width: 12 },
    { header: "Lot Type", key: "lotType", width: 10 },
    { header: "Total Cut", key: "totalCut", width: 10 },
    { header: "Created At", key: "createdAt", width: 15 },
    { header: "Remark", key: "remark", width: 20 },

    { header: "Stitch Assigned On", key: "stitchAssignedOn", width: 20 },
    { header: "Stitch Operator", key: "stitchOp", width: 15 },
    { header: "Stitch Status", key: "stitchStatus", width: 25 },
    { header: "Stitched Qty", key: "stitchedQty", width: 15 },

    { header: "Assembly Assigned On", key: "assemblyAssignedOn", width: 20 },
    { header: "Assembly Operator", key: "assemblyOp", width: 15 },
    { header: "Assembly Status", key: "assemblyStatus", width: 25 },
    { header: "Assembled Qty", key: "assembledQty", width: 15 },

    { header: "Washing Assigned On", key: "washingAssignedOn", width: 20 },
    { header: "Washing Operator", key: "washingOp", width: 15 },
    { header: "Washing Status", key: "washingStatus", width: 25 },
    { header: "Washed Qty", key: "washedQty", width: 15 },

    { header: "Finishing Assigned On", key: "finishingAssignedOn", width: 20 },
    { header: "Finishing Operator", key: "finishingOp", width: 15 },
    { header: "Finishing Status", key: "finishingStatus", width: 25 },
    { header: "Finished Qty", key: "finishedQty", width: 15 }
  ];

  finalData.forEach(r => {
    sheet.addRow({
      lotNo: r.lotNo,
      sku: r.sku,
      lotType: r.lotType,
      totalCut: r.totalCut,
      createdAt: r.createdAt,
      remark: r.remark,

      stitchAssignedOn: r.stitchAssignedOn,
      stitchOp: r.stitchOp,
      stitchStatus: r.stitchStatus,
      stitchedQty: r.stitchedQty,

      assemblyAssignedOn: r.assemblyAssignedOn,
      assemblyOp: r.assemblyOp,
      assemblyStatus: r.assemblyStatus,
      assembledQty: r.assembledQty,

      washingAssignedOn: r.washingAssignedOn,
      washingOp: r.washingOp,
      washingStatus: r.washingStatus,
      washedQty: r.washedQty,

      finishingAssignedOn: r.finishingAssignedOn,
      finishingOp: r.finishingOp,
      finishingStatus: r.finishingStatus,
      finishedQty: r.finishedQty
    });
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="PendencyInLineCompletedReport.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}


module.exports = router;








  
