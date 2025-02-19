/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 **************************************************/
const express = require("express");
const router = express.Router();
const axios = require('axios');
const { pool } = require("../config/db");
const { isAuthenticated, isOperator } = require("../middlewares/auth");

/**
 * computeAdvancedLeftoversForLot(lot_no, isAkshay)
 *
 * For Akshay lots (isAkshay=true) the stages are:
 *   Stitching → Jeans Assembly → Washing → Finishing,
 * with leftovers computed as:
 *   - leftoverStitch = totalCut - totalStitched
 *   - leftoverJeans = (computed separately)
 *   - leftoverWash = totalJeans - totalWashed
 *   - leftoverFinish = totalWashed - totalFinished
 *
 * For non-Akshay (hoisery) lots:
 *   - leftoverStitch = totalCut - totalStitched
 *   - leftoverWash = "N/A"
 *   - leftoverFinish = totalStitched - totalFinished
 *
 * In all cases, if an assignment exists but is waiting or denied,
 * the corresponding status is returned.
 */
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
  const [clRows] = await pool.query(
    "SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1",
    [lot_no]
  );
  const totalCut = clRows.length ? (clRows[0].total_pieces || 0) : 0;

  let [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalStitched = rows[0].sumStitched || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalWashed = rows[0].sumWashed || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalFinished = rows[0].sumFinished || 0;

  // Stitch Leftover
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
    // For Akshay lots: compute jeans assembly pieces.
    let totalJeans = 0;
    const [jaRows] = await pool.query(
      "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
      [lot_no]
    );
    totalJeans = jaRows.length ? (jaRows[0].sumJeans || 0) : 0;

    // Wash Leftover for Akshay
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

    // Finish Leftover for Akshay
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
    // For non-Akshay lots:
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
 *
 * For Akshay’s lots, leftover jeans = totalStitchedLocal - totalJeans.
 * For non-Akshay lots, returns "N/A".
 */
async function computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay) {
  if (!isAkshay) return "N/A";
  const [jaAssignRows] = await pool.query(
    "SELECT is_approved FROM jeans_assembly_assignments ja JOIN jeans_assembly_data jd ON ja.stitching_assignment_id = jd.id WHERE jd.lot_no = ? ORDER BY ja.assigned_on DESC LIMIT 1",
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


  const totalJeans = jaRows.length ? (jaRows[0].sumJeans || 0) : 0;
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
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });

  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });

  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });

  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query(
      "SELECT id, username FROM users WHERE id IN (?)",
      [uids]
    );
    users.forEach(u => {
      if (perf[u.id]) perf[u.id].username = u.username;
    });
  }
  return perf;
}

/**
 * computeAdvancedAnalytics()
 */
async function computeAdvancedAnalytics() {
  const analytics = {};
  const [cutTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalCut FROM cutting_lots");
  const [stitchTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
  const [washTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
  const [finishTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");

  analytics.totalCut = cutTotals[0].totalCut;
  analytics.totalStitched = stitchTotals[0].totalStitched;
  analytics.totalWashed = washTotals[0].totalWashed;
  analytics.totalFinished = finishTotals[0].totalFinished;

  analytics.stitchConversion = analytics.totalCut > 0 ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2) : "0.00";
  analytics.washConversion = analytics.totalStitched > 0
    ? (((analytics.totalWashed > 0 ? analytics.totalWashed : analytics.totalFinished) / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";
  analytics.finishConversion = analytics.totalWashed > 0
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : analytics.totalStitched > 0
    ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";

  const [skuTotals] = await pool.query("SELECT sku, SUM(total_pieces) AS total FROM cutting_lots GROUP BY sku ORDER BY total DESC");
  analytics.top5SKUs = skuTotals.slice(0, 5);
  analytics.bottom5SKUs = skuTotals.slice(-5).reverse();

  return analytics;
}

/**
 * GET /operator/dashboard
 */
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate, sortField = "lot_no", sortOrder = "asc", category = "all" } = req.query;
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 9999;
    if (limit < 1) limit = 9999;
    if (page < 1) page = 1;

    const whereClauses = [];
    const params = [];
    if (category === "hoisery") {
      whereClauses.push("u.username LIKE ?");
      params.push("%hoisery%");
    } else if (category === "denim") {
      whereClauses.push("u.username NOT LIKE ?");
      params.push("%hoisery%");
    }
    if (search) {
      whereClauses.push("cl.lot_no LIKE ?");
      params.push(`%${search}%`);
    }
    if (startDate) {
      whereClauses.push("cl.created_at >= ?");
      params.push(startDate);
    }
    if (endDate) {
      whereClauses.push("cl.created_at <= ?");
      params.push(endDate);
    }
    let finalWhere = "";
    if (whereClauses.length) {
      finalWhere = "WHERE " + whereClauses.join(" AND ");
    }
    const validSortFields = ["lot_no", "created_at", "sku", "total_pieces"];
    const finalSortField = validSortFields.includes(sortField) ? sortField : "lot_no";
    const finalSortOrder = sortOrder.toLowerCase() === "desc" ? "DESC" : "ASC";

    // Count total lots
    const countSQL = `
      SELECT COUNT(*) AS total
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      ${finalWhere}
    `;
    const [countRows] = await pool.query(countSQL, params);
    const totalLotsFound = countRows[0].total || 0;
    const totalPages = Math.ceil(totalLotsFound / limit);
    if (page > totalPages && totalPages > 0) page = totalPages;
    const offset = (page - 1) * limit;

    // Fetch lot numbers for current page
    const dataSQL = `
      SELECT cl.lot_no
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      ${finalWhere}
      ORDER BY ${finalSortField} ${finalSortOrder}
      LIMIT ? OFFSET ?
    `;
    const dataParams = [...params, limit, offset];
    const [paginatedRows] = await pool.query(dataSQL, dataParams);
    const paginatedLotNos = paginatedRows.map(r => r.lot_no);

    // Build details for each lot
    const lotDetails = {};
    for (const lot_no of paginatedLotNos) {
      // Cutting lot details
      const [cutRows] = await pool.query(
        `SELECT cl.*, u.username AS created_by
         FROM cutting_lots cl
         JOIN users u ON cl.user_id = u.id
         WHERE cl.lot_no = ?
         LIMIT 1`,
        [lot_no]
      );
      if (!cutRows.length) continue;
      const cuttingLot = cutRows[0];
      const isAkshay = (cuttingLot.created_by || "").toLowerCase() === "akshay";

      // Cutting sizes and rolls
      const [cuttingSizes] = await pool.query(
        "SELECT * FROM cutting_lot_sizes WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY size_label",
        [lot_no]
      );
      const [cuttingRolls] = await pool.query(
        "SELECT * FROM cutting_lot_rolls WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?) ORDER BY roll_no",
        [lot_no]
      );

      // Stitching data and compute total stitched for this lot
      const [stitchingData] = await pool.query("SELECT * FROM stitching_data WHERE lot_no = ?", [lot_no]);
      let totalStitchedLocal = 0;
      stitchingData.forEach(item => { totalStitchedLocal += item.total_pieces; });

      // Compute leftovers
      const leftovers = await computeAdvancedLeftoversForLot(lot_no, isAkshay);
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay);

      // Washing and finishing data (for Akshay only; for non-Akshay, washing is empty)
      let [washingData] = await pool.query("SELECT * FROM washing_data WHERE lot_no = ?", [lot_no]);
      let [finishingData] = await pool.query("SELECT * FROM finishing_data WHERE lot_no = ?", [lot_no]);
      if (!isAkshay) {
        washingData = [];
      }

      // Lot assignments
      const [lotAssignResult] = await pool.query(
        "SELECT * FROM lot_assignments WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)",
        [lot_no]
      );
      const lotAssignments = lotAssignResult;

      // Assigned operators
      const [stAssign] = await pool.query(
        "SELECT u.username FROM stitching_assignments sa JOIN cutting_lots c ON sa.cutting_lot_id = c.id JOIN users u ON sa.user_id = u.id WHERE c.lot_no = ? ORDER BY sa.assigned_on DESC LIMIT 1",
        [lot_no]
      );
      const stitchingAssignedUser = stAssign.length ? stAssign[0].username : "N/A";
      let washingAssignedUser = "N/A";
      if (isAkshay) {
        const [waAssign] = await pool.query(
          "SELECT u.username FROM washing_assignments wa JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id JOIN users u ON wa.user_id = u.id WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1",
          [lot_no]
        );
        washingAssignedUser = waAssign.length ? waAssign[0].username : "N/A";
      }
      let finishingAssignedUser = "N/A";
      if (isAkshay) {
        const [fiAssign] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN washing_data wd ON fa.washing_assignment_id = wd.id JOIN users u ON fa.user_id = u.id WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lot_no]
        );
        finishingAssignedUser = fiAssign.length ? fiAssign[0].username : "N/A";
      } else {
        const [fiAssign] = await pool.query(
          "SELECT u.username FROM finishing_assignments fa JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id JOIN users u ON fa.user_id = u.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
          [lot_no]
        );
        finishingAssignedUser = fiAssign.length ? fiAssign[0].username : "N/A";
      }

      // Compute Total Leftover = cutting_lots.total_pieces - sum(finishing_dispatches.quantity)
      const [[cutRow]] = await pool.query(
        "SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1",
        [lot_no]
      );
      const totalCutVal = cutRow ? cutRow.total_pieces : 0;
      const [dispatchRows] = await pool.query(
        "SELECT COALESCE(SUM(quantity),0) AS totalDispatched FROM finishing_dispatches WHERE lot_no = ?",
        [lot_no]
      );
      const totalDispatched = dispatchRows[0].totalDispatched || 0;
      const totalPiecesLeft = totalCutVal - totalDispatched;

      // Compute Dispatch Leftover = sum(finishing_data.total_pieces) - totalDispatched
      const [[sumFinRows]] = await pool.query(
        "SELECT COALESCE(SUM(total_pieces),0) AS sumFinish FROM finishing_data WHERE lot_no = ?",
        [lot_no]
      );
      let dispatchLeftover;
      if (sumFinRows.sumFinish > 0) {
        dispatchLeftover = sumFinRows.sumFinish - totalDispatched;
      } else {
        dispatchLeftover = "Not Assigned";
      }

      // Determine overall status based on leftovers and assignments
      let status = "Complete";
      const leftoverVals = Object.values(leftovers);
      if (
        leftoverVals.includes("Waiting for approval") ||
        leftoverVals.includes("Denied") ||
        leftoverJeans === "Waiting for approval" ||
        leftoverJeans === "Denied"
      ) {
        status = "Pending/Denied";
      } else if (
        leftoverVals.includes("Not Assigned") ||
        leftoverJeans === "Not Assigned"
      ) {
        status = "Not Assigned";
      }

      lotDetails[lot_no] = {
        cuttingLot,
        cuttingSizes,
        cuttingRolls,
        stitchingData,
        washingData,
        finishingData,
        lotAssignments,
        leftovers: {
          leftoverStitch: leftovers.leftoverStitch,
          leftoverWash: leftovers.leftoverWash,
          leftoverFinish: leftovers.leftoverFinish,
          leftoverJeans
        },
        status,
        stitchingAssignedUser,
        washingAssignedUser,
        finishingAssignedUser,
        totalPiecesLeft,
        dispatchLeftover
      };
    }

    const operatorPerformance = await computeOperatorPerformance();
    const [lotCountResult] = await pool.query("SELECT COUNT(*) AS lotCount FROM cutting_lots");
    const lotCount = lotCountResult[0].lotCount;
    const [totalPiecesResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalPieces FROM cutting_lots");
    const totalPiecesCut = totalPiecesResult[0].totalPieces;
    const [totalStitchedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
    const [totalWashedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
    const [totalFinishedResult] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");
    const [userCountResult] = await pool.query("SELECT COUNT(*) AS userCount FROM users");
    const userCount = userCountResult[0].userCount;
    const advancedAnalytics = await computeAdvancedAnalytics();

    return res.render("operatorDashboard", {
      lotDetails,
      operatorPerformance,
      query: { search, startDate, endDate, sortField, sortOrder, category },
      lotCount,
      totalPiecesCut,
      totalStitched: totalStitchedResult[0].totalStitched,
      totalWashed: totalWashedResult[0].totalWashed,
      totalFinished: totalFinishedResult[0].totalFinished,
      userCount,
      advancedAnalytics,
      currentPage: page,
      totalPages,
      limit,
      totalLotsFound
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});

// POST: Edit Lot
router.post("/dashboard/edit-lot", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no, total_pieces, remark } = req.body;
    if (!lot_no) return res.status(400).send("Lot number is required");
    await pool.query(
      "UPDATE cutting_lots SET total_pieces = ?, remark = ? WHERE lot_no = ?",
      [total_pieces || 0, remark || null, lot_no]
    );
    return res.redirect("/operator/dashboard");
  } catch (err) {
    console.error("Error editing lot:", err);
    return res.status(500).send("Server error");
  }
});

// GET: Export Leftovers CSV
router.get("/dashboard/leftovers/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [lots] = await pool.query("SELECT lot_no FROM cutting_lots");
    let csvContent = "Lot No,Leftover Stitch,Leftover Wash,Leftover Finish,Leftover Assembly\n";
    for (const lotRow of lots) {
      const lot_no = lotRow.lot_no;
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
      const totalStitchedLocal = stData[0].sumStitched || 0;
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

// GET: Export Single Lot CSV
router.get("/dashboard/lot-tracking/:lot_no/download", isAuthenticated, isOperator, async (req, res) => {
  const { lot_no } = req.params;
  try {
    const [cutRows] = await pool.query("SELECT * FROM cutting_lots WHERE lot_no = ? LIMIT 1", [lot_no]);
    const cuttingLot = cutRows.length ? cutRows[0] : {};
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

// GET: Export All Lots CSV
router.get("/dashboard/download-all-lots", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [allCuts] = await pool.query("SELECT * FROM cutting_lots");
    let csvContent = `Lot No,SKU,Fabric Type,Total Pieces,Remark,Created At\n`;
    allCuts.forEach(cut => {
      csvContent += `${cut.lot_no},${cut.sku},${cut.fabric_type},${cut.total_pieces},${cut.remark},${cut.created_at}\n`;
    });
    res.setHeader("Content-disposition", "attachment; filename=All_Lots.csv");
    res.set("Content-Type", "text/csv");
    res.send(csvContent);
  } catch (err) {
    console.error("Error exporting all lots:", err);
    return res.status(500).send("Server error");
  }
});



module.exports = router;
