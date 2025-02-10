/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 **************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * computeAdvancedLeftoversForLot(lot_no, isAkshay)
 *
 * For lots created by akshay (isAkshay=true) the stages are:
 *   Stitching → Jeans Assembly → Washing → Finishing,
 *   with leftovers computed as:
 *     - leftoverStitch = totalCut - totalStitched
 *     - leftoverJeans = (computed separately)
 *     - leftoverWash = totalJeans - totalWashed
 *     - leftoverFinish = totalWashed - totalFinished
 *
 * For all other lots (hoisery), only stitching and finishing are used:
 *     - leftoverStitch = totalCut - totalStitched
 *     - leftoverWash = "N/A"
 *     - leftoverFinish = totalStitched - totalFinished (if assigned & approved)
 *
 * In all cases, if an assignment exists but is still waiting/denied,
 * the corresponding status is returned.
 *
 * IMPORTANT FIX:
 * For non-Akshay (hoisery) lots, if no finishing assignment exists, the
 * leftoverFinish now returns "Not Assigned" rather than calculating the leftover.
 */
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
  // Get total pieces cut from the cutting_lots table.
  const [clRows] = await pool.query(
    `SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
    [lot_no]
  );
  const totalCut = clRows.length ? (clRows[0].total_pieces || 0) : 0;

  // Get total stitched
  let [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumStitched 
     FROM stitching_data 
     WHERE lot_no = ?`,
    [lot_no]
  );
  const totalStitched = rows[0].sumStitched || 0;

  // Get total washed
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumWashed 
     FROM washing_data 
     WHERE lot_no = ?`,
    [lot_no]
  );
  const totalWashed = rows[0].sumWashed || 0;

  // Get total finished
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumFinished 
     FROM finishing_data 
     WHERE lot_no = ?`,
    [lot_no]
  );
  const totalFinished = rows[0].sumFinished || 0;

  // --- Stitch leftover ---
  const [stAssignmentRows] = await pool.query(
    `SELECT isApproved 
     FROM stitching_assignments sa
     JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?
     ORDER BY sa.assigned_on DESC 
     LIMIT 1`,
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
    // For Akshay's lots: get total jeans assembly pieces.
    let totalJeans = 0;
    const [jaRows] = await pool.query(
      `SELECT COALESCE(SUM(total_pieces),0) AS sumJeans 
         FROM jeans_assembly_data 
         WHERE lot_no = ?`,
      [lot_no]
    );
    totalJeans = jaRows.length ? (jaRows[0].sumJeans || 0) : 0;

    // --- Wash leftover for Akshay ---
    const [waAssignmentRows] = await pool.query(
      `SELECT is_approved 
       FROM washing_assignments wa
       JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       WHERE jd.lot_no = ?
       ORDER BY wa.assigned_on DESC 
       LIMIT 1`,
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

    // --- Finish leftover for Akshay ---
    const [faAssignmentRows] = await pool.query(
      `SELECT is_approved 
       FROM finishing_assignments fa
       JOIN washing_data wd ON fa.washing_assignment_id = wd.id
       WHERE wd.lot_no = ?
       ORDER BY fa.assigned_on DESC 
       LIMIT 1`,
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
    // For hoisery (non-Akshay) lots:
    leftoverWash = "N/A";
    // --- Finish leftover for hoisery ---
    // We now check for a finishing assignment joined with stitching_data.
    const [faAssignmentRows] = await pool.query(
      `SELECT is_approved 
       FROM finishing_assignments fa
       JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
       WHERE sd.lot_no = ?
       ORDER BY fa.assigned_on DESC 
       LIMIT 1`,
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
      // FIX: Instead of calculating leftover when no finishing assignment exists,
      // we now report "Not Assigned".
      leftoverFinish = "Not Assigned";
    }
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

/**
 * computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay)
 *
 * For Akshay’s lots, leftover jeans assembly is computed as:
 *    totalStitchedLocal - totalJeans (with waiting/denied statuses checked)
 *
 * For non-Akshay (hoisery), jeans assembly is not applicable.
 */
async function computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay) {
  if (!isAkshay) {
    return "N/A";
  }
  const [jaAssignRows] = await pool.query(
    `SELECT is_approved 
     FROM jeans_assembly_assignments ja
     JOIN jeans_assembly_data jd ON ja.stitching_assignment_id = jd.id
     WHERE jd.lot_no = ?
     ORDER BY ja.assigned_on DESC LIMIT 1`,
    [lot_no]
  );
  let leftoverJeans;
  if (jaAssignRows.length) {
    const jaAssn = jaAssignRows[0];
    if (jaAssn.is_approved === null) {
      leftoverJeans = "Waiting for approval";
    } else if (jaAssn.is_approved == 0) {
      leftoverJeans = "Denied";
    } else {
      const [jaRows] = await pool.query(
        `SELECT COALESCE(SUM(total_pieces),0) AS sumJeans 
         FROM jeans_assembly_data 
         WHERE lot_no = ?`,
        [lot_no]
      );
      const totalJeans = jaRows[0].sumJeans || 0;
      leftoverJeans = totalStitchedLocal - totalJeans;
    }
  } else {
    leftoverJeans = "Not Assigned";
  }
  return leftoverJeans;
}

/**
 * computeOperatorPerformance()
 */
async function computeOperatorPerformance() {
  const perf = {};
  let [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched 
     FROM stitching_data 
     GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });

  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed 
     FROM washing_data 
     GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });

  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished 
     FROM finishing_data 
     GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });

  // Attach username
  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query(
      `SELECT id, username 
       FROM users 
       WHERE id IN (?)`,
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
  
  // (1) Overall totals
  const [cutTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalCut FROM cutting_lots`);
  const [stitchTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data`);
  const [washTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data`);
  const [finishTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data`);
  analytics.totalCut = cutTotals[0].totalCut;
  analytics.totalStitched = stitchTotals[0].totalStitched;
  analytics.totalWashed = washTotals[0].totalWashed;
  analytics.totalFinished = finishTotals[0].totalFinished;

  // (2) Conversion percentages
  analytics.stitchConversion = analytics.totalCut > 0
    ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
    : "0.00";
  analytics.washConversion = analytics.totalStitched > 0
    ? (
        (analytics.totalWashed > 0
          ? (analytics.totalWashed / analytics.totalStitched)
          : (analytics.totalFinished / analytics.totalStitched)) * 100
      ).toFixed(2)
    : "0.00";
  analytics.finishConversion = analytics.totalWashed > 0
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched > 0
      ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
      : "0.00"
    );

  // (3) Top/bottom 5 SKUs
  const [skuTotals] = await pool.query(
    `SELECT sku, SUM(total_pieces) AS total 
     FROM cutting_lots 
     GROUP BY sku 
     ORDER BY total DESC`
  );
  analytics.top5SKUs = skuTotals.slice(0, 5);
  analytics.bottom5SKUs = skuTotals.slice(-5).reverse();

  // (4) Weekly SKU-level analysis
  const [weeklyData] = await pool.query(
    `SELECT CONCAT(YEAR(created_at),'-W', WEEK(created_at)) AS week, sku, SUM(total_pieces) AS total
     FROM cutting_lots 
     GROUP BY week, sku 
     ORDER BY week ASC, total DESC`
  );
  const weeklyByWeek = {};
  weeklyData.forEach(row => {
    if (!weeklyByWeek[row.week]) weeklyByWeek[row.week] = [];
    weeklyByWeek[row.week].push({ sku: row.sku, total: row.total });
  });
  const weeklySKUDatapoints = [];
  const weeks = Object.keys(weeklyByWeek).sort();
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i];
    const skuArray = weeklyByWeek[week];
    const top5 = skuArray.slice(0, 5);
    const bottom5 = skuArray.slice(-5).reverse();
    const growth = {};
    if (i > 0) {
      const prevWeek = weeks[i - 1];
      const prevData = weeklyByWeek[prevWeek];
      const prevMap = {};
      prevData.forEach(item => { prevMap[item.sku] = item.total; });
      skuArray.forEach(item => {
        const prevTotal = prevMap[item.sku] || 0;
        growth[item.sku] = prevTotal > 0
          ? (((item.total - prevTotal) / prevTotal) * 100).toFixed(2)
          : "N/A";
      });
    }
    weeklySKUDatapoints.push({ week, top5, bottom5, growth });
  }
  analytics.weeklySKUDatapoints = weeklySKUDatapoints;

  // (5) Monthly SKU-level analysis
  const [monthlyData] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, sku, SUM(total_pieces) AS total
     FROM cutting_lots 
     GROUP BY month, sku 
     ORDER BY month ASC, total DESC`
  );
  const monthlyByMonth = {};
  monthlyData.forEach(row => {
    if (!monthlyByMonth[row.month]) monthlyByMonth[row.month] = [];
    monthlyByMonth[row.month].push({ sku: row.sku, total: row.total });
  });
  const monthlySKUDatapoints = [];
  const months = Object.keys(monthlyByMonth).sort();
  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const skuArray = monthlyByMonth[month];
    const top5 = skuArray.slice(0, 5);
    const bottom5 = skuArray.slice(-5).reverse();
    const growth = {};
    if (i > 0) {
      const prevMonth = months[i - 1];
      const prevData = monthlyByMonth[prevMonth];
      const prevMap = {};
      prevData.forEach(item => {
        prevMap[item.sku] = item.total;
      });
      skuArray.forEach(item => {
        const prevTotal = prevMap[item.sku] || 0;
        growth[item.sku] = prevTotal > 0
          ? (((item.total - prevTotal) / prevTotal) * 100).toFixed(2)
          : "N/A";
      });
    }
    monthlySKUDatapoints.push({ month, top5, bottom5, growth });
  }
  analytics.monthlySKUDatapoints = monthlySKUDatapoints;

  // (6) Average + standard deviation pieces
  const [avgStd] = await pool.query(
    `SELECT AVG(total_pieces) AS avgPieces, STD(total_pieces) AS stdPieces 
     FROM cutting_lots`
  );
  analytics.avgPiecesPerLot = avgStd[0].avgPieces
    ? parseFloat(avgStd[0].avgPieces).toFixed(2)
    : "N/A";
  analytics.stdPiecesPerLot = avgStd[0].stdPieces
    ? parseFloat(avgStd[0].stdPieces).toFixed(2)
    : "0.00";

  // (7) Median pieces
  const [medianRows] = await pool.query(
    `SELECT AVG(t.total_pieces) AS medianCut FROM (
       SELECT a.total_pieces,
         (SELECT COUNT(*) FROM cutting_lots b WHERE b.total_pieces <= a.total_pieces) AS rn,
         (SELECT COUNT(*) FROM cutting_lots) AS cnt
       FROM cutting_lots a
     ) t
     WHERE t.rn IN (
       FLOOR((t.cnt+1)/2), 
       CEIL((t.cnt+1)/2)
     )`
  );
  analytics.medianCutPieces = medianRows[0].medianCut
    ? parseFloat(medianRows[0].medianCut).toFixed(2)
    : "N/A";

  // (8) SKU conversion rates
  analytics.conversionCutToStitch = analytics.totalCut > 0
    ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
    : "0.00";
  analytics.conversionStitchToWash = analytics.totalStitched > 0
    ? ((analytics.totalWashed / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";
  analytics.conversionWashToFinish = analytics.totalWashed > 0
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched > 0
      ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
      : "0.00"
    );

  // (9) Top performing operators
  const [topStitchOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total 
     FROM stitching_data 
     GROUP BY user_id 
     ORDER BY total DESC 
     LIMIT 1`
  );
  analytics.topOperatorStitch = topStitchOp.length ? topStitchOp[0] : null;

  const [topWashOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total 
     FROM washing_data 
     GROUP BY user_id 
     ORDER BY total DESC 
     LIMIT 1`
  );
  analytics.topOperatorWash = topWashOp.length ? topWashOp[0] : null;

  const [topFinishOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total 
     FROM finishing_data 
     GROUP BY user_id 
     ORDER BY total DESC 
     LIMIT 1`
  );
  analytics.topOperatorFinish = topFinishOp.length ? topFinishOp[0] : null;

  // (10) Overall average turnaround time
  const [turnaroundRows] = await pool.query(
    `SELECT AVG(DATEDIFF(f.created_at, c.created_at)) AS avgTurnaround
     FROM cutting_lots c
     JOIN finishing_data f ON c.lot_no = f.lot_no`
  );
  analytics.avgTurnaroundTime = turnaroundRows[0].avgTurnaround
    ? parseFloat(turnaroundRows[0].avgTurnaround).toFixed(2)
    : "N/A";

  // (11) Count of pending lots
  const [pendingRows] = await pool.query(
    `SELECT COUNT(*) AS pendingCount 
     FROM (
       SELECT c.lot_no,
         (SELECT isApproved 
          FROM stitching_assignments sa 
          JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
          WHERE c2.lot_no = c.lot_no 
          ORDER BY sa.assigned_on DESC 
          LIMIT 1) AS stitchStatus,
         (SELECT is_approved 
          FROM washing_assignments wa 
          JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
          WHERE jd.lot_no = c.lot_no 
          ORDER BY wa.assigned_on DESC 
          LIMIT 1) AS washStatus,
         (SELECT is_approved 
          FROM finishing_assignments fa 
          JOIN washing_data wd ON fa.washing_assignment_id = wd.id
          WHERE wd.lot_no = c.lot_no 
          ORDER BY fa.assigned_on DESC 
          LIMIT 1) AS finishStatus
       FROM cutting_lots c
     ) AS sub
     WHERE (stitchStatus IS NULL OR stitchStatus = 0)
        OR (washStatus IS NULL OR washStatus = 0)
        OR (finishStatus IS NULL OR finishStatus = 0)`
  );
  analytics.pendingLots = pendingRows[0].pendingCount;

  // (12) Weekly new lot counts
  const [weeklyNew] = await pool.query(
    `SELECT CONCAT(YEAR(created_at),'-W', WEEK(created_at)) AS week, COUNT(*) AS count
     FROM cutting_lots 
     GROUP BY week 
     ORDER BY week ASC`
  );
  analytics.weeklyNewLots = weeklyNew;

  // (13) Monthly new lot counts
  const [monthlyNew] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
     FROM cutting_lots 
     GROUP BY month 
     ORDER BY month ASC`
  );
  analytics.monthlyNewLots = monthlyNew;

  // (14) Total number of lots
  const [lotCountRes] = await pool.query(`SELECT COUNT(*) AS totalLots FROM cutting_lots`);
  analytics.totalLots = lotCountRes[0].totalLots;

  // (15) Overall SKU performance
  const [skuOverall] = await pool.query(
    `SELECT sku, SUM(total_pieces) AS totalPieces
     FROM cutting_lots 
     GROUP BY sku 
     ORDER BY totalPieces DESC`
  );
  analytics.skuOverallPerformance = skuOverall;

  // (16) Avg turnaround per SKU
  const [skuTurnaround] = await pool.query(
    `SELECT c.sku, AVG(DATEDIFF(f.created_at, c.created_at)) AS avgTurnaround
     FROM cutting_lots c
     JOIN finishing_data f ON c.lot_no = f.lot_no
     GROUP BY c.sku`
  );
  analytics.skuTurnaround = skuTurnaround;

  // (17) Approval rates
  const [stApproval] = await pool.query(
    `SELECT COUNT(*) AS total, 
            SUM(CASE WHEN isApproved = 1 THEN 1 ELSE 0 END) AS approved
     FROM stitching_assignments`
  );
  analytics.stitchApprovalRate =
    stApproval[0].total > 0
      ? ((stApproval[0].approved / stApproval[0].total) * 100).toFixed(2)
      : "N/A";

  const [washApproval] = await pool.query(
    `SELECT COUNT(*) AS total, 
            SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved
     FROM washing_assignments`
  );
  analytics.washApprovalRate =
    washApproval[0].total > 0
      ? ((washApproval[0].approved / washApproval[0].total) * 100).toFixed(2)
      : "N/A";

  const [finishApproval] = await pool.query(
    `SELECT COUNT(*) AS total, 
            SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved
     FROM finishing_assignments`
  );
  analytics.finishApprovalRate =
    finishApproval[0].total > 0
      ? ((finishApproval[0].approved / finishApproval[0].total) * 100).toFixed(2)
      : "N/A";

  return analytics;
}

/**
 * GET /operator/dashboard
 */
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    const {
      search,
      startDate,
      endDate,
      sortField = 'lot_no',
      sortOrder = 'asc',
      category = 'all'
    } = req.query;

    // Default: no real limit => 9999 (you can raise/lower as you wish)
    let page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 9999; 
    if (limit < 1) limit = 9999;
    if (page < 1) page = 1;

    // Build dynamic WHERE
    const whereClauses = [];
    const params = [];

    // Category
    if (category === 'hoisery') {
      whereClauses.push(`u.username LIKE ?`);
      params.push('%hoisery%');
    } else if (category === 'denim') {
      whereClauses.push(`u.username NOT LIKE ?`);
      params.push('%hoisery%');
    }

    // Search
    if (search) {
      whereClauses.push(`cl.lot_no LIKE ?`);
      params.push(`%${search}%`);
    }

    // Date range
    if (startDate) {
      whereClauses.push(`cl.created_at >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      whereClauses.push(`cl.created_at <= ?`);
      params.push(endDate);
    }

    let finalWhere = '';
    if (whereClauses.length) {
      finalWhere = 'WHERE ' + whereClauses.join(' AND ');
    }

    const validSortFields = ['lot_no', 'created_at', 'sku', 'total_pieces'];
    const finalSortField = validSortFields.includes(sortField) ? sortField : 'lot_no';
    const finalSortOrder = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    // (1) Count
    const countSQL = `
      SELECT COUNT(*) AS total
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      ${finalWhere}
    `;
    const [countRows] = await pool.query(countSQL, params);
    const totalLotsFound = countRows[0].total || 0;

    // no real pagination, but we'll keep the structure
    const totalPages = Math.ceil(totalLotsFound / limit);
    if (page > totalPages && totalPages > 0) {
      page = totalPages;
    }
    const offset = (page - 1) * limit;

    // (2) fetch rows
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

    // Build aggregator
    const lotDetails = {};
    for (const lot_no of paginatedLotNos) {
      // cutting lot
      const [cutRows] = await pool.query(
        `SELECT cl.*, u.username AS created_by
         FROM cutting_lots cl
         JOIN users u ON cl.user_id = u.id
         WHERE cl.lot_no = ? 
         LIMIT 1`,
        [lot_no]
      );
      const cuttingLot = cutRows.length ? cutRows[0] : null;
      
      // Determine if this lot is by Akshay
      const isAkshay = (cuttingLot &&
                         cuttingLot.created_by &&
                         cuttingLot.created_by.toLowerCase() === 'akshay');

      // cutting sizes
      const [cuttingSizes] = await pool.query(
        `SELECT * FROM cutting_lot_sizes
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY size_label`,
        [lot_no]
      );

      // cutting rolls
      const [cuttingRolls] = await pool.query(
        `SELECT * FROM cutting_lot_rolls
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY roll_no`,
        [lot_no]
      );

      // stitching
      const [stitchingData] = await pool.query(
        `SELECT * FROM stitching_data 
         WHERE lot_no = ?`,
        [lot_no]
      );
      let totalStitchedLocal = 0;
      stitchingData.forEach(item => {
        totalStitchedLocal += item.total_pieces;
      });
      const stitchingDataIds = stitchingData.map(sd => sd.id);
      let stitchingDataSizes = [];
      if (stitchingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM stitching_data_sizes 
           WHERE stitching_data_id IN (?)`,
          [stitchingDataIds]
        );
        stitchingDataSizes = szRows;
      }

      // washing
      let [washingData] = await pool.query(
        `SELECT * FROM washing_data 
         WHERE lot_no = ?`,
        [lot_no]
      );
      const washingDataIds = washingData.map(wd => wd.id);
      let washingDataSizes = [];
      if (washingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM washing_data_sizes 
           WHERE washing_data_id IN (?)`,
          [washingDataIds]
        );
        washingDataSizes = szRows;
      }

      // finishing
      // Use 'let' so we can reassign if needed.
      let [finishingData] = await pool.query(
        `SELECT * FROM finishing_data 
         WHERE lot_no = ?`,
        [lot_no]
      );
      const finishingDataIds = finishingData.map(fd => fd.id);
      let finishingDataSizes = [];
      if (finishingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM finishing_data_sizes 
           WHERE finishing_data_id IN (?)`,
          [finishingDataIds]
        );
        finishingDataSizes = szRows;
      }

      // jeans assembly (only for Akshay)
      let jeansAssemblyData = [];
      let jeansAssemblyDataSizes = [];
      let jeansAssemblyAssignedUser = "N/A";
      if (isAkshay) {
        const [jaData] = await pool.query(
          `SELECT * FROM jeans_assembly_data 
           WHERE lot_no = ?`,
          [lot_no]
        );
        jeansAssemblyData = jaData;
        const jaDataIds = jaData.map(item => item.id);
        if (jaDataIds.length) {
          const [jaSizes] = await pool.query(
            `SELECT * FROM jeans_assembly_data_sizes 
             WHERE jeans_assembly_data_id IN (?)`,
            [jaDataIds]
          );
          jeansAssemblyDataSizes = jaSizes;
        }
        const [jaAssignRows] = await pool.query(
          `SELECT u.username, is_approved 
           FROM jeans_assembly_assignments ja
           JOIN users u ON ja.user_id = u.id
           JOIN jeans_assembly_data jd ON ja.stitching_assignment_id = jd.id
           WHERE jd.lot_no = ?
           ORDER BY ja.assigned_on DESC 
           LIMIT 1`,
          [lot_no]
        );
        if (jaAssignRows.length) {
          if (jaAssignRows[0].is_approved === null) {
            jeansAssemblyAssignedUser = "Waiting for approval";
          } else if (jaAssignRows[0].is_approved == 0) {
            jeansAssemblyAssignedUser = "Denied";
          } else {
            jeansAssemblyAssignedUser = jaAssignRows[0].username;
          }
        }
      } else {
        // For hoisery lots, we hide further steps.
        washingData = [];
        washingDataSizes = [];
        finishingData = [];
        finishingDataSizes = [];
        jeansAssemblyData = [];
        jeansAssemblyDataSizes = [];
      }

      // department confirmations
      const [deptConfResult] = await pool.query(
        `SELECT dc.* 
         FROM department_confirmations dc
         JOIN lot_assignments la ON dc.lot_assignment_id = la.id
         WHERE la.cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );
      const departmentConfirmations = deptConfResult;

      // lot assignments
      const [lotAssignResult] = await pool.query(
        `SELECT * FROM lot_assignments
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );
      const lotAssignments = lotAssignResult;

      // leftovers
      const leftovers = await computeAdvancedLeftoversForLot(lot_no, isAkshay);
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay);

      // status determination based on leftovers and assignment statuses
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

      // assigned users
      const [stAssign] = await pool.query(
        `SELECT u.username 
         FROM stitching_assignments sa
         JOIN cutting_lots c ON sa.cutting_lot_id = c.id
         JOIN users u ON sa.user_id = u.id
         WHERE c.lot_no = ?
         ORDER BY sa.assigned_on DESC 
         LIMIT 1`,
        [lot_no]
      );
      const stitchingAssignedUser = stAssign.length ? stAssign[0].username : "N/A";

      const [waAssign] = await pool.query(
        `SELECT u.username
         FROM washing_assignments wa
         JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
         JOIN users u ON wa.user_id = u.id
         WHERE jd.lot_no = ?
         ORDER BY wa.assigned_on DESC 
         LIMIT 1`,
        [lot_no]
      );
      const washingAssignedUser = waAssign.length ? waAssign[0].username : "N/A";

      const [fiAssign] = await pool.query(
        `SELECT u.username
         FROM finishing_assignments fa
         JOIN washing_data wd ON fa.washing_assignment_id = wd.id
         JOIN users u ON fa.user_id = u.id
         WHERE wd.lot_no = ?
         ORDER BY fa.assigned_on DESC 
         LIMIT 1`,
        [lot_no]
      );
      const finishingAssignedUser = fiAssign.length ? fiAssign[0].username : "N/A";

      lotDetails[lot_no] = {
        cuttingLot,
        cuttingSizes,
        cuttingRolls,
        stitchingData,
        stitchingDataSizes,
        washingData,
        washingDataSizes,
        finishingData,
        finishingDataSizes,
        jeansAssemblyData,
        jeansAssemblyDataSizes,
        departmentConfirmations,
        lotAssignments,
        leftovers: { ...leftovers, leftoverJeans },
        status,
        stitchingAssignedUser,
        washingAssignedUser,
        finishingAssignedUser,
        jeansAssemblyAssignedUser,
        override: null
      };
    }

    // operator performance
    const operatorPerformance = await computeOperatorPerformance();

    // summary stats
    const [lotCountResult] = await pool.query(
      `SELECT COUNT(*) AS lotCount FROM cutting_lots`
    );
    const lotCount = lotCountResult[0].lotCount;

    const [totalPiecesResult] = await pool.query(
      `SELECT COALESCE(SUM(total_pieces), 0) AS totalPieces 
       FROM cutting_lots`
    );
    const totalPiecesCut = totalPiecesResult[0].totalPieces;

    const [totalStitchedResult] = await pool.query(
      `SELECT COALESCE(SUM(total_pieces), 0) AS totalStitched 
       FROM stitching_data`
    );
    const [totalWashedResult] = await pool.query(
      `SELECT COALESCE(SUM(total_pieces), 0) AS totalWashed 
       FROM washing_data`
    );
    const [totalFinishedResult] = await pool.query(
      `SELECT COALESCE(SUM(total_pieces), 0) AS totalFinished 
       FROM finishing_data`
    );

    const [userCountResult] = await pool.query(
      `SELECT COUNT(*) AS userCount 
       FROM users`
    );
    const userCount = userCountResult[0].userCount;

    // advanced analytics
    const advancedAnalytics = await computeAdvancedAnalytics();

    // render
    return res.render('operatorDashboard', {
      lotDetails,
      operatorPerformance,
      query: {
        search,
        startDate,
        endDate,
        sortField,
        sortOrder,
        category
      },
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
    console.error('Error loading operator dashboard:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * POST /operator/dashboard/edit-lot
 */
router.post('/dashboard/edit-lot', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no, total_pieces, remark } = req.body;
    if (!lot_no) return res.status(400).send('Lot number is required');
    await pool.query(
      `UPDATE cutting_lots 
       SET total_pieces = ?, remark = ? 
       WHERE lot_no = ?`,
      [total_pieces || 0, remark || null, lot_no]
    );
    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error editing lot:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * GET /operator/dashboard/leftovers/download
 */
router.get('/dashboard/leftovers/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [lots] = await pool.query(`SELECT lot_no FROM cutting_lots`);
    let csvContent = "Lot No,Leftover Stitch,Leftover Wash,Leftover Finish,Leftover Jeans\n";
    for (const lotRow of lots) {
      const lot_no = lotRow.lot_no;
      // To determine which formula to use, fetch the cutting lot’s created_by.
      const [cutRows] = await pool.query(
        `SELECT u.username AS created_by 
         FROM cutting_lots cl
         JOIN users u ON cl.user_id = u.id
         WHERE cl.lot_no = ? 
         LIMIT 1`,
        [lot_no]
      );
      const isAkshay = (cutRows.length && cutRows[0].created_by.toLowerCase() === 'akshay');
      const leftovers = await computeAdvancedLeftoversForLot(lot_no, isAkshay);
      const [stData] = await pool.query(
        `SELECT COALESCE(SUM(total_pieces),0) AS sumStitched 
         FROM stitching_data 
         WHERE lot_no = ?`,
        [lot_no]
      );
      const totalStitchedLocal = stData[0].sumStitched || 0;
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay);
      csvContent += `${lot_no},${leftovers.leftoverStitch},${leftovers.leftoverWash},${leftovers.leftoverFinish},${leftoverJeans}\n`;
    }
    res.setHeader('Content-disposition', 'attachment; filename=Leftovers.csv');
    res.set('Content-Type', 'text/csv');
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting leftovers:', err);
    res.status(500).send('Server error');
  }
});

/**
 * GET /operator/dashboard/lot-tracking/:lot_no/download
 */
router.get('/dashboard/lot-tracking/:lot_no/download', isAuthenticated, isOperator, async (req, res) => {
  const { lot_no } = req.params;
  try {
    const [cutRows] = await pool.query(
      `SELECT * FROM cutting_lots 
       WHERE lot_no = ? 
       LIMIT 1`,
      [lot_no]
    );
    const cuttingLot = cutRows.length ? cutRows[0] : {};
    const [sizes] = await pool.query(
      `SELECT * FROM cutting_lot_sizes
       WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
       ORDER BY size_label`,
      [lot_no]
    );
    const [rolls] = await pool.query(
      `SELECT * FROM cutting_lot_rolls
       WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
       ORDER BY roll_no`,
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
    res.setHeader('Content-disposition', `attachment; filename=Lot_${lot_no}.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting lot:', err);
    res.status(500).send('Server error');
  }
});

/**
 * GET /operator/dashboard/download-all-lots
 */
router.get('/dashboard/download-all-lots', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [allCuts] = await pool.query(`SELECT * FROM cutting_lots`);
    let csvContent = `Lot No,SKU,Fabric Type,Total Pieces,Remark,Created At\n`;
    allCuts.forEach(cut => {
      csvContent += `${cut.lot_no},${cut.sku},${cut.fabric_type},${cut.total_pieces},${cut.remark},${cut.created_at}\n`;
    });
    res.setHeader('Content-disposition', `attachment; filename=All_Lots.csv`);
    res.set('Content-Type', 'text/csv');
    res.send(csvContent);
  } catch (err) {
    console.error('Error exporting all lots:', err);
    res.status(500).send('Server error');
  }
});

module.exports = router;
