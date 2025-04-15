/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 *
 * Key changes:
 *  • Removed all "converted-report" routes.
 *  • Updated PIC Report (/operator/dashboard/pic-report) to:
 *      - Include the new "washing_in" step
 *      - Fetch assigned_on and approved_on for each assignment
 *      - Removed day-differences (assigned_on→approved_on)
 *      - Instead, we now show the approved_on date for each department
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
    // For denim: also consider jeans_assembly
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
      "SELECT isApproved FROM finishing_assignments fa JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
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
 * Summaries for stitching, washing, finishing by user.
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
 * Summaries for top/bottom SKUs, total cut, stitched, washed, finished, etc.
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

  analytics.stitchConversion = analytics.totalCut > 0
    ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
    : "0.00";
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
  analytics.stitchApprovalRate = stTotals.totalAssigned > 0
    ? ((stTotals.approvedCount / stTotals.totalAssigned) * 100).toFixed(2)
    : "0.00";

  const [[waTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN is_approved=1 THEN 1 ELSE 0 END) AS approvedCount
    FROM washing_assignments
  `);
  analytics.washApprovalRate = waTotals.totalAssigned > 0
    ? ((waTotals.approvedCount / waTotals.totalAssigned) * 100).toFixed(2)
    : "0.00";

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
      lotDetails: {} // leftover data lazy-loaded via API
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * NEW: GET /operator/dashboard/api/leftovers
 * (Lazy-loading leftover data, same as your existing code)
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

      // Calculate leftover dispatch
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
    await pool.query(
      "UPDATE cutting_lots SET total_pieces = ?, remark = ? WHERE lot_no = ?",
      [newTotal, remark || null, lot_no]
    );
    return res.redirect("/operator/dashboard");
  } catch (err) {
    console.error("Error editing lot:", err);
    return res.status(500).send("Server error");
  }
});

/**************************************************
 * CSV/Excel Export and Pendency-Report routes remain the same below
 **************************************************/

// leftovers CSV for all lots
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

// Single-lot CSV
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

// Export entire cutting_lots table
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
 * The rest: Pendency-report routes for stitching, assembly, washing, finishing
 **************************************************/

// STITCHING Pendency
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

// ... The rest of your pendency routes remain unchanged ...
// (Assembly, Washing, Finishing) – unchanged ...
// (We've removed the day-diff columns and replaced them with approved_on in the PIC Report.)
 
/********************************************************************
 * GET /operator/dashboard/pic-report
 * 
 * Now includes:
 *  - assigned_on
 *  - approved_on
 * And DOES NOT calculate day-differences.
 ********************************************************************/

// HELPER: quick check for denim vs. non-denim
function isDenimLot(lotNo = "") {
  const up = lotNo.toUpperCase();
  return up.startsWith("AK") || up.startsWith("UM");
}

// HELPER: sum from stitching_data
async function getStitchedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
    FROM stitching_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumStitched) || 0;
}

// HELPER: sum from jeans_assembly_data
async function getAssembledQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumAsm
    FROM jeans_assembly_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumAsm) || 0;
}

// HELPER: sum from washing_in_data
async function getWashingInQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWashIn
    FROM washing_in_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWashIn) || 0;
}

// HELPER: sum from washing_data
async function getWashedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWash
    FROM washing_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWash) || 0;
}

// HELPER: sum from finishing_data
async function getFinishedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumFin
    FROM finishing_data
    WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumFin) || 0;
}

/**
 * get the last stitching assignment => returns { assigned_on, approved_on, etc. }
 */
async function getLastStitchingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT sa.id, sa.isApproved, sa.assigned_on, sa.approved_on, sa.user_id
    FROM stitching_assignments sa
    JOIN cutting_lots c ON sa.cutting_lot_id = c.id
    WHERE c.lot_no = ?
    ORDER BY sa.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id = ?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

// same pattern for assembly:
async function getLastAssemblyAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT ja.id, ja.is_approved, ja.assigned_on, ja.approved_on, ja.user_id
    FROM jeans_assembly_assignments ja
    JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
    WHERE sd.lot_no = ?
    ORDER BY ja.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

// washing_in
async function getLastWashingInAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT wia.id, wia.is_approved, wia.assigned_on, wia.approved_on, wia.user_id
    FROM washing_in_assignments wia
    JOIN washing_in_data wid ON wia.washing_data_id = wid.id
    WHERE wid.lot_no = ?
    ORDER BY wia.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

// washing
async function getLastWashingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT wa.id, wa.is_approved, wa.assigned_on, wa.approved_on, wa.user_id
    FROM washing_assignments wa
    JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
    WHERE jd.lot_no = ?
    ORDER BY wa.assigned_on DESC
    LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;
  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

// finishing
async function getLastFinishingAssignment(lotNo, isDenim) {
  if (isDenim) {
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
      FROM finishing_assignments fa
      JOIN washing_data wd ON fa.washing_assignment_id = wd.id
      WHERE wd.lot_no = ?
      ORDER BY fa.assigned_on DESC
      LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  } else {
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
      FROM finishing_assignments fa
      JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
      WHERE sd.lot_no = ?
      ORDER BY fa.assigned_on DESC
      LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;
    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  }
}

/**
 * getDepartmentStatuses – chain logic
 *  (We removed the day-difference logic, now we only store approvedOn)
 */
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washingInQty,
  washedQty,
  finishedQty,
  stAssign,
  asmAssign,
  washInAssign,
  washAssign,
  finAssign
}) {
  // placeholders
  let stitchingStatus = "N/A", stitchingOp = "", stitchingAssignedOn = "", stitchApprovedOn = "";
  let assemblyStatus = isDenim ? "N/A" : "—", assemblyOp = "", assemblyAssignedOn = "", assemblyApprovedOn = "";
  let washingInStatus = "N/A", washingInOp = "", washingInAssignedOn = "", washingInApprovedOn = "";
  let washingStatus = isDenim ? "N/A" : "—", washingOp = "", washingAssignedOn = "", washingApprovedOn = "";
  let finishingStatus = "N/A", finishingOp = "", finishingAssignedOn = "", finishingApprovedOn = "";

  // STITCHING
  if (!stAssign) {
    stitchingStatus = "In Cutting";
    if (isDenim) {
      assemblyStatus = "In Cutting";
      washingInStatus = "In Cutting";
      washingStatus = "In Cutting";
      finishingStatus = "In Cutting";
    } else {
      washingInStatus = "In Cutting";
      finishingStatus = "In Cutting";
    }
  } else {
    const { isApproved, assigned_on, approved_on, opName } = stAssign;
    stitchingOp = opName || "";
    stitchingAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
    stitchingApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (isApproved === null) {
      stitchingStatus = `Pending Approval by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingInStatus = "In Stitching";
        washingStatus = "In Stitching";
        finishingStatus = "In Stitching";
      } else {
        washingInStatus = "In Stitching";
        finishingStatus = "In Stitching";
      }
    } else if (isApproved == 0) {
      stitchingStatus = `Denied by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus = "In Stitching";
        washingInStatus = "In Stitching";
        washingStatus = "In Stitching";
        finishingStatus = "In Stitching";
      } else {
        washingInStatus = "In Stitching";
        finishingStatus = "In Stitching";
      }
    } else {
      // Approved
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

  // ASSEMBLY (Denim)
  if (isDenim) {
    if (!asmAssign) {
      assemblyStatus = "In Stitching";
      washingInStatus = "In Stitching";
      washingStatus = "In Stitching";
      finishingStatus = "In Stitching";
    } else {
      const { is_approved, assigned_on, approved_on, opName } = asmAssign;
      assemblyOp = opName || "";
      assemblyAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
      assemblyApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

      if (is_approved === null) {
        assemblyStatus = `Pending Approval by ${assemblyOp}`;
        washingInStatus = "In Assembly";
        washingStatus = "In Assembly";
        finishingStatus = "In Assembly";
      } else if (is_approved == 0) {
        assemblyStatus = `Denied by ${assemblyOp}`;
        washingInStatus = "In Assembly";
        washingStatus = "In Assembly";
        finishingStatus = "In Assembly";
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
  }

  // WASHING IN (both)
  if (!washInAssign) {
    if (isDenim) {
      washingInStatus = "In Assembly";
      washingStatus = "In Assembly";
      finishingStatus = "In Assembly";
    } else {
      washingInStatus = "In Stitching";
      finishingStatus = "In Stitching";
    }
  } else {
    const { is_approved, assigned_on, approved_on, opName } = washInAssign;
    washingInOp = opName || "";
    washingInAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
    washingInApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (is_approved === null) {
      washingInStatus = `Pending Approval by ${washingInOp}`;
      if (isDenim) {
        washingStatus = "In WashingIn";
        finishingStatus = "In WashingIn";
      } else {
        finishingStatus = "In WashingIn";
      }
    } else if (is_approved == 0) {
      washingInStatus = `Denied by ${washingInOp}`;
      if (isDenim) {
        washingStatus = "In WashingIn";
        finishingStatus = "In WashingIn";
      } else {
        finishingStatus = "In WashingIn";
      }
    } else {
      // partial or complete
      const compareQty = isDenim ? assembledQty : stitchedQty;
      if (washingInQty === 0) {
        washingInStatus = "In-Line";
      } else if (washingInQty >= compareQty && compareQty > 0) {
        washingInStatus = "Completed";
      } else {
        const pend = compareQty - washingInQty;
        washingInStatus = `${pend} Pending`;
      }
    }
  }

  // WASHING (Denim)
  if (isDenim) {
    if (!washAssign) {
      washingStatus = "In WashingIn";
      finishingStatus = "In WashingIn";
    } else {
      const { is_approved, assigned_on, approved_on, opName } = washAssign;
      washingOp = opName || "";
      washingAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
      washingApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

      if (is_approved === null) {
        washingStatus = `Pending Approval by ${washingOp}`;
        finishingStatus = "In Washing";
      } else if (is_approved == 0) {
        washingStatus = `Denied by ${washingOp}`;
        finishingStatus = "In Washing";
      } else {
        // partial or complete
        if (washedQty === 0) {
          washingStatus = "In-Line";
        } else if (washedQty >= washingInQty && washingInQty > 0) {
          washingStatus = "Completed";
        } else {
          const pend = washingInQty - washedQty;
          washingStatus = `${pend} Pending`;
        }
      }
    }
  }

  // FINISHING
  if (!finAssign) {
    finishingStatus = isDenim ? "In Washing" : "In WashingIn";
  } else {
    const { is_approved, assigned_on, approved_on, opName } = finAssign;
    finishingOp = opName || "";
    finishingAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "";
    finishingApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (is_approved === null) {
      finishingStatus = `Pending Approval by ${finishingOp}`;
    } else if (is_approved == 0) {
      finishingStatus = `Denied by ${finishingOp}`;
    } else {
      // partial or complete
      if (isDenim) {
        if (finishedQty === 0) {
          finishingStatus = "In-Line";
        } else if (finishedQty >= washedQty && washedQty > 0) {
          finishingStatus = "Completed";
        } else {
          const pend = washedQty - finishedQty;
          finishingStatus = `${pend} Pending`;
        }
      } else {
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
    washingInStatus,
    washingInOp,
    washingInAssignedOn,
    washingInApprovedOn,
    washingStatus,
    washingOp,
    washingAssignedOn,
    washingApprovedOn,
    finishingStatus,
    finishingOp,
    finishingAssignedOn,
    finishingApprovedOn
  };
}

/**
 * filterByDept – same as before, but we do NOT do any day-diff logic now.
 */
function filterByDept({
  department,
  isDenim,
  stitchingStatus,
  assemblyStatus,
  washingInStatus,
  washingStatus,
  finishingStatus
}) {
  let showRow = true;
  let actualStatus = "N/A";

  if (department === "all") {
    if (isDenim) {
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus = washingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus = washingInStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus = assemblyStatus;
      else actualStatus = stitchingStatus;
    } else {
      if (!finishingStatus.startsWith("N/A")) actualStatus = finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus = washingInStatus;
      else actualStatus = stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department === "cutting") {
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

  if (department === "washing_in") {
    actualStatus = washingInStatus;
    return { showRow, actualStatus };
  }

  if (department === "washing") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus = washingStatus;
    return { showRow, actualStatus };
  }

  if (department === "finishing") {
    actualStatus = finishingStatus;
    return { showRow, actualStatus };
  }

  return { showRow, actualStatus };
}

/**
 * GET /operator/dashboard/pic-report
 * Now we show assigned_on + approved_on for each dept, no day difference.
 */
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

    // Build dateWhere if needed
    let dateWhere = "";
    const dateParams = [];
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
        } else if (department === "washing_in") {
          dateWhere = `
            AND EXISTS (
              SELECT 1 
              FROM washing_in_assignments wia
              JOIN washing_in_data wid ON wia.washing_data_id = wid.id
              JOIN cutting_lots c2 ON wid.lot_no = c2.lot_no
              WHERE c2.lot_no = cl.lot_no
                AND DATE(wia.assigned_on) BETWEEN ? AND ?
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
        } else if (department === "finishing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1 
              FROM finishing_assignments fa
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

    // Build lotType clause
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

    // Base query
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
    const finalData = [];
    for (const lot of lots) {
      const lotNo = lot.lot_no;
      const totalCut = parseFloat(lot.total_pieces) || 0;
      const denim = isDenimLot(lotNo);

      const stitchedQty   = await getStitchedQty(lotNo);
      const assembledQty  = denim ? await getAssembledQty(lotNo) : 0;
      const washingInQty  = await getWashingInQty(lotNo);
      const washedQty     = denim ? await getWashedQty(lotNo) : 0;
      const finishedQty   = await getFinishedQty(lotNo);

      const stAssign  = await getLastStitchingAssignment(lotNo);
      const asmAssign = denim ? await getLastAssemblyAssignment(lotNo) : null;
      const wInAssign = await getLastWashingInAssignment(lotNo);
      const washAssign= denim ? await getLastWashingAssignment(lotNo) : null;
      const finAssign = await getLastFinishingAssignment(lotNo, denim);

      const {
        stitchingStatus,
        stitchingOp,
        stitchingAssignedOn,
        stitchingApprovedOn,
        assemblyStatus,
        assemblyOp,
        assemblyAssignedOn,
        assemblyApprovedOn,
        washingInStatus,
        washingInOp,
        washingInAssignedOn,
        washingInApprovedOn,
        washingStatus,
        washingOp,
        washingAssignedOn,
        washingApprovedOn,
        finishingStatus,
        finishingOp,
        finishingAssignedOn,
        finishingApprovedOn
      } = getDepartmentStatuses({
        isDenim: denim,
        totalCut,
        stitchedQty,
        assembledQty,
        washingInQty,
        washedQty,
        finishedQty,
        stAssign,
        asmAssign,
        washInAssign: wInAssign,
        washAssign,
        finAssign
      });

      // Filter logic by department + status
      const deptResult = filterByDept({
        department,
        isDenim: denim,
        stitchingStatus,
        assemblyStatus,
        washingInStatus,
        washingStatus,
        finishingStatus
      });
      if (!deptResult.showRow) continue;

      let actualStatus = deptResult.actualStatus.toLowerCase();
      if (status !== "all") {
        if (status === "not_assigned") {
          if (!actualStatus.startsWith("in ")) continue;
        } else {
          const want = status.toLowerCase();
          if (want === "inline" && actualStatus.includes("in-line")) {
            // ok
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
        createdAt: lot.created_at ? new Date(lot.created_at).toLocaleDateString() : "",
        remark: lot.remark || "",

        // STITCHING
        stitchAssignedOn: stitchingAssignedOn,
        stitchApprovedOn: stitchingApprovedOn,
        stitchOp: stitchingOp,
        stitchStatus: stitchingStatus,
        stitchedQty,

        // ASSEMBLY (if denim)
        assemblyAssignedOn,
        assemblyApprovedOn,
        assemblyOp,
        assemblyStatus,
        assembledQty,

        // WASHING IN
        washingInAssignedOn,
        washingInApprovedOn,
        washingInOp,
        washingInStatus,
        washingInQty,

        // WASHING (denim only)
        washingAssignedOn,
        washingApprovedOn,
        washingOp,
        washingStatus,
        washedQty,

        // FINISHING
        finishingAssignedOn,
        finishingApprovedOn,
        finishingOp,
        finishingStatus,
        finishedQty
      });
    }

    if (download === "1") {
      // Export to Excel
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Report (No DayDiff)";
      const sheet = workbook.addWorksheet("PIC-Report");

      // Remove day-diff columns, add approved_on columns
      sheet.columns = [
        { header: "Lot No", key: "lotNo", width: 15 },
        { header: "SKU", key: "sku", width: 12 },
        { header: "Lot Type", key: "lotType", width: 10 },
        { header: "Total Cut", key: "totalCut", width: 10 },
        { header: "Created At", key: "createdAt", width: 15 },
        { header: "Remark", key: "remark", width: 20 },

        // STITCHING
        { header: "Stitch Assigned On", key: "stitchAssignedOn", width: 20 },
        { header: "Stitch Approved On", key: "stitchApprovedOn", width: 20 },
        { header: "Stitch Operator", key: "stitchOp", width: 15 },
        { header: "Stitch Status", key: "stitchStatus", width: 25 },
        { header: "Stitched Qty", key: "stitchedQty", width: 15 },

        // ASSEMBLY
        { header: "Assembly Assigned On", key: "assemblyAssignedOn", width: 20 },
        { header: "Assembly Approved On", key: "assemblyApprovedOn", width: 20 },
        { header: "Assembly Operator", key: "assemblyOp", width: 15 },
        { header: "Assembly Status", key: "assemblyStatus", width: 25 },
        { header: "Assembled Qty", key: "assembledQty", width: 15 },

        // WASHING IN
        { header: "WashIn Assigned On", key: "washingInAssignedOn", width: 20 },
        { header: "WashIn Approved On", key: "washingInApprovedOn", width: 20 },
        { header: "WashIn Operator", key: "washingInOp", width: 15 },
        { header: "WashIn Status", key: "washingInStatus", width: 25 },
        { header: "WashIn Qty", key: "washingInQty", width: 15 },

        // WASHING
        { header: "Washing Assigned On", key: "washingAssignedOn", width: 20 },
        { header: "Washing Approved On", key: "washingApprovedOn", width: 20 },
        { header: "Washing Operator", key: "washingOp", width: 15 },
        { header: "Washing Status", key: "washingStatus", width: 25 },
        { header: "Washed Qty", key: "washedQty", width: 15 },

        // FINISHING
        { header: "Finishing Assigned On", key: "finishingAssignedOn", width: 20 },
        { header: "Finishing Approved On", key: "finishingApprovedOn", width: 20 },
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
          stitchApprovedOn: r.stitchApprovedOn,
          stitchOp: r.stitchOp,
          stitchStatus: r.stitchStatus,
          stitchedQty: r.stitchedQty,

          assemblyAssignedOn: r.assemblyAssignedOn,
          assemblyApprovedOn: r.assemblyApprovedOn,
          assemblyOp: r.assemblyOp,
          assemblyStatus: r.assemblyStatus,
          assembledQty: r.assembledQty,

          washingInAssignedOn: r.washingInAssignedOn,
          washingInApprovedOn: r.washingInApprovedOn,
          washingInOp: r.washingInOp,
          washingInStatus: r.washingInStatus,
          washingInQty: r.washingInQty,

          washingAssignedOn: r.washingAssignedOn,
          washingApprovedOn: r.washingApprovedOn,
          washingOp: r.washingOp,
          washingStatus: r.washingStatus,
          washedQty: r.washedQty,

          finishingAssignedOn: r.finishingAssignedOn,
          finishingApprovedOn: r.finishingApprovedOn,
          finishingOp: r.finishingOp,
          finishingStatus: r.finishingStatus,
          finishedQty: r.finishedQty
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="PICReport_ApprovedOn.xlsx"');
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // Render HTML
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

module.exports = router;
