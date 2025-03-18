/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 * 
 * Explanation:
 *  - This file contains all routes used by the Operator Dashboard.
 *  - It leverages concurrency in the main dashboard route so that
 *    data for multiple lots is fetched in parallel for performance.
 *  - The advancedAnalytics function now includes meaningful calculations
 *    for “avgTurnaroundTime”, “pendingLots”, “totalLots”, and “approval rates.”
 **************************************************/
const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const ExcelJS = require('exceljs');

/**
 * computeAdvancedLeftoversForLot(lot_no, isAkshay)
 *
 * Returns leftoverStitch, leftoverWash, leftoverFinish for a given lot, 
 * based on user assignments and approvals.
 */
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
  // 1) Grab total cut from cutting_lots:
  const [clRows] = await pool.query(
    "SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1",
    [lot_no]
  );
  const totalCut = clRows.length ? (clRows[0].total_pieces || 0) : 0;

  // 2) Grab total stitched, washed, finished:
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

  // 3) leftoverStitch logic:
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

  // 4) leftoverWash, leftoverFinish:
  let leftoverWash, leftoverFinish;
  if (isAkshay) {
    // For Akshay user: check jeans_assembly_data
    let [jaRows] = await pool.query(
      "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
      [lot_no]
    );
    const totalJeans = jaRows.length ? (jaRows[0].sumJeans || 0) : 0;

    // leftoverWash
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

    // leftoverFinish
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
    // For non-Akshay, leftoverWash is N/A and leftoverFinish is based on stitching_data
    leftoverWash = "N/A";
    const [faAssignmentRows] = await pool.query(
      "SELECT is_approved FROM finishing_assignments fa JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id WHERE sd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1",
      [lot_no]
    );
    if (faAssignmentRows.length) {
      const faAssn = faAssignmentRows[0];
      if (faAssn.is_approved === null) {
        leftoverFinish = "Waiting for approval";
      } else if (faAssn.is_approved == 0) {
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
 * For Akshay’s lots, leftover jeans = totalStitchedLocal - totalJeans
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

  // If approved, see how many jeans done:
  const [jaRows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalJeans = jaRows.length ? (jaRows[0].sumJeans || 0) : 0;
  return totalStitchedLocal - totalJeans;
}

/**
 * computeOperatorPerformance()
 *
 * Summarizes how many pieces each user has stitched, washed, finished overall.
 */
async function computeOperatorPerformance() {
  const perf = {};

  // Stitching
  let [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });

  // Washing
  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });

  // Finishing
  [rows] = await pool.query(
    "SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data GROUP BY user_id"
  );
  rows.forEach(r => {
    if (!perf[r.user_id])
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });

  // Attach username
  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query(
      "SELECT id, username FROM users WHERE id IN (?)",
      [uids]
    );
    users.forEach(u => {
      if (perf[u.id]) {
        perf[u.id].username = u.username;
      }
    });
  }
  return perf;
}

/**
 * computeAdvancedAnalytics(startDate, endDate)
 *
 * Provides:
 *  - totalCut, totalStitched, totalWashed, totalFinished
 *  - top10SKUs, bottom10SKUs (with optional date range)
 *  - avgTurnaroundTime, pendingLots, totalLots
 *  - stitchApprovalRate, washApprovalRate
 */
async function computeAdvancedAnalytics(startDate, endDate) {
  const analytics = {};

  // 1) Overall totals from each stage:
  const [cutTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalCut FROM cutting_lots");
  const [stitchTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
  const [washTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
  const [finishTotals] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");

  analytics.totalCut = cutTotals[0].totalCut;
  analytics.totalStitched = stitchTotals[0].totalStitched;
  analytics.totalWashed = washTotals[0].totalWashed;
  analytics.totalFinished = finishTotals[0].totalFinished;

  // 2) Conversion rates:
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

  // 3) SKU analytics (Top 10 / Bottom 10) by total cut pieces:
  let skuQuery = "SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ";
  let skuQueryParams = [];
  if (startDate && endDate) {
    skuQuery += "WHERE created_at BETWEEN ? AND ? ";
    skuQueryParams.push(startDate, endDate);
  } else {
    // default last 10 days if no date range provided
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

  // 4) More advanced stats: totalLots, pendingLots, avgTurnaroundTime, approval rates
  // (A) totalLots => total # of cutting_lots
  const [[{ totalCount }]] = await pool.query("SELECT COUNT(*) AS totalCount FROM cutting_lots");
  analytics.totalLots = totalCount;

  // (B) pendingLots => lots whose sum(finishing_data) < totalPieces
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

  // (C) avgTurnaroundTime => for lots that are fully finished, compute days from cutting_lots.created_at to the max finishing_data.created_at
  const [turnRows] = await pool.query(`
    SELECT 
      c.lot_no,
      c.created_at AS cut_date,
      MAX(f.created_at) AS finish_date,
      c.total_pieces,
      COALESCE(SUM(f.total_pieces),0) as sumFin
    FROM cutting_lots c
    LEFT JOIN finishing_data f ON c.lot_no = f.lot_no
    GROUP BY c.lot_no
    HAVING sumFin >= c.total_pieces
  `);
  let totalDiff = 0;
  let countComplete = 0;
  for(const row of turnRows) {
    if(row.finish_date && row.cut_date) {
      const diffMs = new Date(row.finish_date).getTime() - new Date(row.cut_date).getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      totalDiff += diffDays;
      countComplete++;
    }
  }
  analytics.avgTurnaroundTime = countComplete > 0 ? parseFloat((totalDiff / countComplete).toFixed(2)) : 0;

  // (D) stitchApprovalRate => ratio of approved stitching_assignments to total
  const [[stTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN isApproved=1 THEN 1 ELSE 0 END) AS approvedCount
    FROM stitching_assignments
  `);
  if(stTotals.totalAssigned > 0) {
    analytics.stitchApprovalRate = ((stTotals.approvedCount / stTotals.totalAssigned) * 100).toFixed(2);
  } else {
    analytics.stitchApprovalRate = "0.00";
  }

  // (E) washApprovalRate => ratio of approved washing_assignments to total
  const [[waTotals]] = await pool.query(`
    SELECT COUNT(*) AS totalAssigned,
           SUM(CASE WHEN is_approved=1 THEN 1 ELSE 0 END) AS approvedCount
    FROM washing_assignments
  `);
  if(waTotals.totalAssigned > 0) {
    analytics.washApprovalRate = ((waTotals.approvedCount / waTotals.totalAssigned) * 100).toFixed(2);
  } else {
    analytics.washApprovalRate = "0.00";
  }

  return analytics;
}

/**
 * GET /operator/dashboard
 * - Main Operator Dashboard route
 * - Aggregates leftover, operator performance, advanced analytics, etc.
 */
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    // 1) read filters from query
    const { search, startDate, endDate, sortField = "lot_no", sortOrder = "asc", category = "all" } = req.query;
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 9999;
    if (limit < 1) limit = 9999;
    if (page < 1) page = 1;

    // 2) build where clauses
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
    let finalWhere = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    // 3) sorting
    const validSortFields = ["lot_no", "created_at", "sku", "total_pieces"];
    const finalSortField = validSortFields.includes(sortField) ? sortField : "lot_no";
    const finalSortOrder = sortOrder.toLowerCase() === "desc" ? "DESC" : "ASC";

    // 4) count total lots
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

    // 5) fetch the actual page of lots
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

    // 6) gather details for each lot in parallel
    const lotDetailsArr = await Promise.all(
      paginatedLotNos.map(async (lot_no) => {
        // Basic cutting lot info
        const [[cuttingLot]] = await pool.query(`
          SELECT cl.*, u.username AS created_by
          FROM cutting_lots cl
          JOIN users u ON cl.user_id = u.id
          WHERE cl.lot_no = ?
          LIMIT 1
        `, [lot_no]);
        if (!cuttingLot) return null;

        // gather sizes/rolls
        const [cuttingSizes] = await pool.query(`
          SELECT * 
          FROM cutting_lot_sizes 
          WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
        `, [lot_no]);
        const [cuttingRolls] = await pool.query(`
          SELECT * 
          FROM cutting_lot_rolls
          WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
        `, [lot_no]);

        // stitching, washing, finishing data
        const [stitchingData] = await pool.query(`
          SELECT * FROM stitching_data
          WHERE lot_no = ?
        `, [lot_no]);
        let totalStitchedLocal = 0;
        stitchingData.forEach(sd => { totalStitchedLocal += sd.total_pieces; });

        let [washingData] = await pool.query(`
          SELECT * FROM washing_data
          WHERE lot_no = ?
        `, [lot_no]);
        const [finishingData] = await pool.query(`
          SELECT * FROM finishing_data
          WHERE lot_no = ?
        `, [lot_no]);

        // isAkshay check
        const isAkshay = (cuttingLot.created_by || "").toLowerCase() === "akshay";
        if(!isAkshay) {
          // non-Akshay => no washing
          washingData = [];
        }

        // leftover calculations
        const [leftovers, leftoverJeans] = await Promise.all([
          computeAdvancedLeftoversForLot(lot_no, isAkshay),
          computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay)
        ]);

        // fetch assigned operators
        const [[stAssign]] = await pool.query(`
          SELECT u.username
          FROM stitching_assignments sa
          JOIN cutting_lots c ON sa.cutting_lot_id = c.id
          JOIN users u ON sa.user_id = u.id
          WHERE c.lot_no = ?
          ORDER BY sa.assigned_on DESC
          LIMIT 1
        `, [lot_no]);
        let stitchingAssignedUser = stAssign ? stAssign.username : "N/A";

        let jeansAssemblyAssignedUser = "N/A";
        if(isAkshay) {
          const [[jaAssign]] = await pool.query(`
            SELECT u.username
            FROM jeans_assembly_assignments ja
            JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
            JOIN users u ON ja.user_id = u.id
            WHERE sd.lot_no = ?
            ORDER BY ja.assigned_on DESC
            LIMIT 1
          `, [lot_no]);
          if(jaAssign) jeansAssemblyAssignedUser = jaAssign.username;
        }

        let washingAssignedUser = "N/A";
        if(isAkshay) {
          const [[waAssign]] = await pool.query(`
            SELECT u.username
            FROM washing_assignments wa
            JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
            JOIN users u ON wa.user_id = u.id
            WHERE jd.lot_no = ?
            ORDER BY wa.assigned_on DESC
            LIMIT 1
          `, [lot_no]);
          if(waAssign) washingAssignedUser = waAssign.username;
        }

        let finishingAssignedUser = "N/A";
        if(isAkshay) {
          const [[fiAssign]] = await pool.query(`
            SELECT u.username
            FROM finishing_assignments fa
            JOIN washing_data wd ON fa.washing_assignment_id = wd.id
            JOIN users u ON fa.user_id = u.id
            WHERE wd.lot_no = ?
            ORDER BY fa.assigned_on DESC
            LIMIT 1
          `, [lot_no]);
          if(fiAssign) finishingAssignedUser = fiAssign.username;
        } else {
          const [[fiAssign]] = await pool.query(`
            SELECT u.username
            FROM finishing_assignments fa
            JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
            JOIN users u ON fa.user_id = u.id
            WHERE sd.lot_no = ?
            ORDER BY fa.assigned_on DESC
            LIMIT 1
          `, [lot_no]);
          if(fiAssign) finishingAssignedUser = fiAssign.username;
        }

        // dispatch leftover logic
        const [[{ total_pieces: totalCutVal }]] = await pool.query(`
          SELECT total_pieces
          FROM cutting_lots
          WHERE lot_no = ?
          LIMIT 1
        `, [lot_no]);
        const [[{ totalDispatched }]] = await pool.query(`
          SELECT COALESCE(SUM(quantity),0) AS totalDispatched
          FROM finishing_dispatches
          WHERE lot_no = ?
        `, [lot_no]);
        const [[{ sumFinish }]] = await pool.query(`
          SELECT COALESCE(SUM(total_pieces),0) AS sumFinish
          FROM finishing_data
          WHERE lot_no = ?
        `, [lot_no]);
        const totalPiecesLeft = totalCutVal - totalDispatched;
        let dispatchLeftover = (sumFinish > 0) ? (sumFinish - totalDispatched) : "Not Assigned";

        // final status determination
        let status = "Complete";
        if (
          [leftovers.leftoverStitch, leftoverJeans].includes("Waiting for approval") ||
          [leftovers.leftoverStitch, leftoverJeans].includes("Denied")
        ) {
          status = "Pending/Denied";
        } else if (
          [leftovers.leftoverStitch, leftoverJeans].includes("Not Assigned")
        ) {
          status = "Not Assigned";
        }

        return {
          lot_no,
          cuttingLot,
          cuttingSizes,
          cuttingRolls,
          stitchingData,
          washingData,
          finishingData,
          leftovers: {
            leftoverStitch: leftovers.leftoverStitch,
            leftoverWash: leftovers.leftoverWash,
            leftoverFinish: leftovers.leftoverFinish,
            leftoverJeans
          },
          status,
          stitchingAssignedUser,
          jeansAssemblyAssignedUser,
          washingAssignedUser,
          finishingAssignedUser,
          totalPiecesLeft,
          dispatchLeftover
        };
      })
    );

    // 7) convert array => object keyed by lot_no
    const lotDetails = {};
    lotDetailsArr.forEach(item => {
      if(item) {
        lotDetails[item.lot_no] = item;
      }
    });

    // 8) gather extra data for the top portion of the dashboard
    const operatorPerformance = await computeOperatorPerformance();
    const [[{ lotCount }]] = await pool.query("SELECT COUNT(*) AS lotCount FROM cutting_lots");
    const [[{ totalPieces }]] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalPieces FROM cutting_lots");
    const [[{ totalStitched }]] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data");
    const [[{ totalWashed }]] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data");
    const [[{ totalFinished }]] = await pool.query("SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data");
    const [[{ userCount }]] = await pool.query("SELECT COUNT(*) AS userCount FROM users");
    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);

    // 9) render the EJS
    return res.render("operatorDashboard", {
      lotDetails,
      operatorPerformance,
      query: { search, startDate, endDate, sortField, sortOrder, category },
      lotCount,
      totalPiecesCut: totalPieces,
      totalStitched,
      totalWashed,
      totalFinished,
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

/**
 * POST /operator/dashboard/edit-lot
 *
 * Allows updating the total_pieces and remark for a given lot_no.
 */
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

/**
 * GET /operator/dashboard/leftovers/download
 * – Export leftover CSV for all lots
 */
router.get("/dashboard/leftovers/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [lots] = await pool.query("SELECT lot_no FROM cutting_lots");
    let csvContent = "Lot No,Leftover Stitch,Leftover Wash,Leftover Finish,Leftover Assembly\n";
    for (const { lot_no } of lots) {
      // check if akshay:
      const [[{ username }]] = await pool.query(`
        SELECT u.username
        FROM cutting_lots cl
        JOIN users u ON cl.user_id = u.id
        WHERE cl.lot_no = ?
        LIMIT 1
      `, [lot_no]);
      const isAkshay = username && username.toLowerCase() === "akshay";

      // compute leftovers
      const leftovers = await computeAdvancedLeftoversForLot(lot_no, isAkshay);

      let [stData] = await pool.query(`
        SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
        FROM stitching_data
        WHERE lot_no = ?
      `, [lot_no]);
      const leftoverJeans = await computeJeansLeftover(lot_no, stData[0].sumStitched, isAkshay);

      // Append to CSV row
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
 * – Export single-lot CSV
 */
router.get("/dashboard/lot-tracking/:lot_no/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no } = req.params;
    const [cutRows] = await pool.query("SELECT * FROM cutting_lots WHERE lot_no = ? LIMIT 1",[lot_no]);
    if(!cutRows.length) return res.status(404).send("Lot not found");
    const cuttingLot = cutRows[0];

    const [sizes] = await pool.query(`
      SELECT * FROM cutting_lot_sizes
      WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
      ORDER BY size_label
    `, [lot_no]);
    const [rolls] = await pool.query(`
      SELECT * FROM cutting_lot_rolls
      WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
      ORDER BY roll_no
    `, [lot_no]);

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
 * – Export entire cutting_lots table as CSV
 */
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

/**
 * GET /operator/pendency-report/stitching
 * – The Stitching Pendency Dashboard
 */
router.get('/pendency-report/stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    // 1) Summary for all stitching users
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

    // 2) Detailed view for selected user
    const selectedUserId = req.query.user_id || "";
    let detailedAssignments = [];
    let detailedSummary = { totalAssigned: 0, totalPending: 0 };

    if (selectedUserId) {
      // Grab all stitching_assignments for that user
      const [assignRows] = await pool.query(`
        SELECT sa.id AS assignment_id, sa.cutting_lot_id, sa.assigned_on,
               c.lot_no, c.total_pieces
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        WHERE sa.user_id = ?
        ORDER BY sa.assigned_on DESC
      `, [selectedUserId]);

      // Use Promise.all to gather data for each assignment in parallel
      const assignmentInfo = await Promise.all(assignRows.map(async asg => {
        const [stDataRows] = await pool.query(`
          SELECT id, total_pieces 
          FROM stitching_data 
          WHERE lot_no = ? 
          LIMIT 1
        `,[asg.lot_no]);

        let stitchedTotal = 0;
        let stDataId = null;
        if (stDataRows.length > 0) {
          stDataId = stDataRows[0].id;
          stitchedTotal = parseFloat(stDataRows[0].total_pieces) || 0;
        }
        const lotTotal = parseFloat(asg.total_pieces) || 0;
        const pendingTotal = lotTotal - stitchedTotal;

        // Size breakdown
        const [sizeRows] = await pool.query(`
          SELECT id, size_label, total_pieces 
          FROM cutting_lot_sizes 
          WHERE cutting_lot_id = ?
        `,[asg.cutting_lot_id]);

        let sizes = [];
        for (const size of sizeRows) {
          let stitchedSize = 0;
          if (stDataId) {
            const [[{ stitched }]] = await pool.query(`
              SELECT COALESCE(SUM(pieces), 0) AS stitched
              FROM stitching_data_sizes
              WHERE stitching_data_id = ? AND size_label = ?
            `,[stDataId, size.size_label]);
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

      // Summarize
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

/**
 * GET /operator/pendency-report/stitching/download
 * – Generate Excel for the detailed pendency of a user
 */
router.get('/pendency-report/stitching/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const selectedUserId = req.query.user_id || "";
    if (!selectedUserId) {
      return res.status(400).send("User not selected.");
    }
    // replicate logic from above for data
    const [assignRows] = await pool.query(`
      SELECT sa.id AS assignment_id, sa.cutting_lot_id, sa.assigned_on,
             c.lot_no, c.total_pieces
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.user_id = ?
      ORDER BY sa.assigned_on DESC
    `,[selectedUserId]);

    const assignmentInfo = await Promise.all(assignRows.map(async asg => {
      const [stDataRows] = await pool.query(`
        SELECT id, total_pieces
        FROM stitching_data
        WHERE lot_no = ?
        LIMIT 1
      `,[asg.lot_no]);
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
      `,[asg.cutting_lot_id]);

      let sizes = [];
      for (const size of sizeRows) {
        let stitchedSize = 0;
        if (stDataId) {
          const [[{ stitched }]] = await pool.query(`
            SELECT COALESCE(SUM(pieces), 0) AS stitched
            FROM stitching_data_sizes
            WHERE stitching_data_id = ? AND size_label = ?
          `,[stDataId, size.size_label]);
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

    // Build Excel file
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Operator Dashboard';
    const worksheet = workbook.addWorksheet('Stitching Report');

    // define columns
    worksheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Total Pieces', key: 'total_pieces', width: 15 },
      { header: 'Stitched', key: 'stitched', width: 15 },
      { header: 'Pending', key: 'pending', width: 15 },
      { header: 'Assigned On', key: 'assigned_on', width: 20 },
      { header: 'Size Breakdown', key: 'sizes', width: 50 }
    ];

    // add rows
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

    // stream workbook to response
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="StitchingPendencyReport.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error generating Excel for stitching pendency:", err);
    res.status(500).send("Server error");
  }
});

module.exports = router;
