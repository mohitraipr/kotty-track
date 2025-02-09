/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 *
 * This file provides detailed analytics and lot information.
 * It includes:
 *  - Filtering by a “category” radio button (all, hoisery, denim)
 *    based on the cutting lot creator’s username.
 *  - Server‑side pagination (using page and limit query parameters).
 *  - Detailed aggregation of data from cutting, stitching, washing,
 *    finishing, and (if applicable) jeans assembly.
 *  - Computation of leftovers for each department. For each department,
 *    if the latest assignment is pending (NULL) or denied (0), a status
 *    string is returned.
 *  - The Jeans Assembly leftover is computed as:
 *      (total stitched pieces for the lot) – (sum of total_pieces from jeans_assembly_data)
 *    if the latest jeans assembly assignment is approved; otherwise, a
 *    status string is returned.
 *  - If the cutting lot’s creator (cutting_lots.created_by) contains "hoisery"
 *    (case‑insensitive), then washing, finishing, and jeans assembly data are hidden.
 *  - Advanced analytics (overall totals, conversion rates, SKU‑level stats, etc.)
 *    are computed.
 *
 * Every function is fully commented for clarity.
 **************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * computeAdvancedLeftoversForLot(lot_no)
 *
 * Calculates leftovers for Stitch, Wash, and Finish.
 * For each department, it checks the latest assignment and returns:
 * - A numeric leftover if approved.
 * - "Waiting for approval", "Denied", or "Not Assigned" otherwise.
 *
 * @param {string} lot_no - The lot number.
 * @returns {Object} { leftoverStitch, leftoverWash, leftoverFinish }
 */
async function computeAdvancedLeftoversForLot(lot_no) {
  // Get total pieces cut from the cutting_lots table.
  const [clRows] = await pool.query(
    `SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
    [lot_no]
  );
  const totalCut = clRows.length ? (clRows[0].total_pieces || 0) : 0;

  // Get total stitched pieces from the stitching_data table.
  let [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalStitched = rows[0].sumStitched || 0;

  // Get total washed pieces from the washing_data table.
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalWashed = rows[0].sumWashed || 0;

  // Get total finished pieces from the finishing_data table.
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalFinished = rows[0].sumFinished || 0;

  // --- Stitch Leftover Calculation ---
  const [stAssignmentRows] = await pool.query(
    `SELECT isApproved FROM stitching_assignments sa
     JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?
     ORDER BY sa.assigned_on DESC LIMIT 1`,
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

  // --- Wash Leftover Calculation ---
  const [waAssignmentRows] = await pool.query(
    `SELECT is_approved FROM washing_assignments wa
     JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
     WHERE jd.lot_no = ?
     ORDER BY wa.assigned_on DESC LIMIT 1`,
    [lot_no]
  );
  let leftoverWash;
  if (waAssignmentRows.length) {
    const waAssn = waAssignmentRows[0];
    if (waAssn.is_approved === null) {
      leftoverWash = "Waiting for approval";
    } else if (waAssn.is_approved == 0) {
      leftoverWash = "Denied";
    } else {
      leftoverWash = totalStitched - totalWashed;
    }
  } else {
    leftoverWash = "Not Assigned";
  }

  // --- Finish Leftover Calculation ---
  const [faAssignmentRows] = await pool.query(
    `SELECT is_approved FROM finishing_assignments fa
     JOIN washing_data wd ON fa.washing_assignment_id = wd.id
     WHERE wd.lot_no = ?
     ORDER BY fa.assigned_on DESC LIMIT 1`,
    [lot_no]
  );
  let leftoverFinish;
  if (faAssignmentRows.length) {
    const faAssn = faAssignmentRows[0];
    if (faAssn.is_approved === null) {
      leftoverFinish = "Waiting for approval";
    } else if (faAssn.is_approved == 0) {
      leftoverFinish = "Denied";
    } else {
      leftoverFinish = (waAssignmentRows.length)
        ? (totalWashed - totalFinished)
        : (totalStitched - totalFinished);
    }
  } else {
    leftoverFinish = "Not Assigned";
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

/**
 * computeJeansLeftover(lot_no, totalStitchedLocal)
 *
 * Computes the Jeans Assembly leftover:
 * - Retrieves the latest jeans assembly assignment.
 * - If pending or denied, returns a status string.
 * - If approved, calculates leftover = (total stitched pieces) - (total pieces processed in jeans assembly).
 *
 * @param {string} lot_no - The lot number.
 * @param {number} totalStitchedLocal - Total stitched pieces for the lot.
 * @returns {string|number} Jeans leftover or a status string.
 */
async function computeJeansLeftover(lot_no, totalStitchedLocal) {
  const [jaAssignRows] = await pool.query(
    `SELECT is_approved FROM jeans_assembly_assignments ja
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
        `SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?`,
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
 *
 * Aggregates the total pieces processed by each operator across stitching,
 * washing, and finishing.
 *
 * @returns {Object} An object keyed by operator user_id with their totals and username.
 */
async function computeOperatorPerformance() {
  const perf = {};
  let [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });
  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });
  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });
  const uids = Object.keys(perf);
  if (uids.length) {
    const [users] = await pool.query(
      `SELECT id, username FROM users WHERE id IN (?)`,
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
 *
 * Computes advanced analytics datapoints including:
 *  1. Overall departmental totals.
 *  2. Conversion percentages.
 *  3. Top 5 and bottom 5 SKUs overall.
 *  4. Weekly and monthly SKU-level analysis with growth percentages.
 *  5. Statistical measures: average, standard deviation, and median pieces per lot.
 *  6. SKU conversion rates.
 *  7. Top performing operators.
 *  8. Overall average turnaround time (cutting → finishing).
 *  9. Count of pending lots.
 * 10. Weekly and monthly new lot counts.
 * 11. Total number of lots.
 * 12. Overall SKU performance.
 * 13. Average turnaround time per SKU.
 * 14. Approval rates for assignments.
 *
 * @returns {Object} Advanced analytics datapoints.
 */
async function computeAdvancedAnalytics() {
  const analytics = {};

  // (1) Overall totals.
  const [cutTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalCut FROM cutting_lots`);
  const [stitchTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalStitched FROM stitching_data`);
  const [washTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalWashed FROM washing_data`);
  const [finishTotals] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS totalFinished FROM finishing_data`);
  analytics.totalCut = cutTotals[0].totalCut;
  analytics.totalStitched = stitchTotals[0].totalStitched;
  analytics.totalWashed = washTotals[0].totalWashed;
  analytics.totalFinished = finishTotals[0].totalFinished;

  // (2) Conversion percentages.
  analytics.stitchConversion = analytics.totalCut > 0 ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2) : "0.00";
  analytics.washConversion = analytics.totalStitched > 0
    ? ((analytics.totalWashed > 0 ? (analytics.totalWashed / analytics.totalStitched) : (analytics.totalFinished / analytics.totalStitched)) * 100).toFixed(2)
    : "0.00";
  analytics.finishConversion = analytics.totalWashed > 0
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched > 0 ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2) : "0.00");

  // (3) Top 5 and bottom 5 SKUs overall.
  const [skuTotals] = await pool.query(
    `SELECT sku, SUM(total_pieces) AS total FROM cutting_lots GROUP BY sku ORDER BY total DESC`
  );
  analytics.top5SKUs = skuTotals.slice(0, 5);
  analytics.bottom5SKUs = skuTotals.slice(-5).reverse();

  // (4) Weekly SKU-level analysis.
  const [weeklyData] = await pool.query(
    `SELECT CONCAT(YEAR(created_at),'-W', WEEK(created_at)) AS week, sku, SUM(total_pieces) AS total
     FROM cutting_lots GROUP BY week, sku ORDER BY week ASC, total DESC`
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
        growth[item.sku] = prevTotal > 0 ? (((item.total - prevTotal) / prevTotal) * 100).toFixed(2) : "N/A";
      });
    }
    weeklySKUDatapoints.push({ week, top5, bottom5, growth });
  }
  analytics.weeklySKUDatapoints = weeklySKUDatapoints;

  // (5) Monthly SKU-level analysis.
  const [monthlyData] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, sku, SUM(total_pieces) AS total
     FROM cutting_lots GROUP BY month, sku ORDER BY month ASC, total DESC`
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
      prevData.forEach(item => { prevMap[item.sku] = item.total; });
      skuArray.forEach(item => {
        const prevTotal = prevMap[item.sku] || 0;
        growth[item.sku] = prevTotal > 0 ? (((item.total - prevTotal) / prevTotal) * 100).toFixed(2) : "N/A";
      });
    }
    monthlySKUDatapoints.push({ month, top5, bottom5, growth });
  }
  analytics.monthlySKUDatapoints = monthlySKUDatapoints;

  // (6) Average pieces per lot and standard deviation.
  const [avgStd] = await pool.query(
    `SELECT AVG(total_pieces) AS avgPieces, STD(total_pieces) AS stdPieces FROM cutting_lots`
  );
  analytics.avgPiecesPerLot = parseFloat(avgStd[0].avgPieces).toFixed(2);
  analytics.stdPiecesPerLot = parseFloat(avgStd[0].stdPieces || 0).toFixed(2);

  // (7) Median pieces per lot.
  const [medianRows] = await pool.query(
    `SELECT AVG(t.total_pieces) AS medianCut FROM (
       SELECT a.total_pieces,
         (SELECT COUNT(*) FROM cutting_lots b WHERE b.total_pieces <= a.total_pieces) AS rn,
         (SELECT COUNT(*) FROM cutting_lots) AS cnt
       FROM cutting_lots a
     ) t
     WHERE t.rn IN (FLOOR((t.cnt+1)/2), CEIL((t.cnt+1)/2))`
  );
  analytics.medianCutPieces = medianRows[0].medianCut ? parseFloat(medianRows[0].medianCut).toFixed(2) : "N/A";

  // (8) SKU conversion rates.
  analytics.conversionCutToStitch = analytics.totalCut > 0 ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2) : "0.00";
  analytics.conversionStitchToWash = analytics.totalStitched > 0 ? ((analytics.totalWashed / analytics.totalStitched) * 100).toFixed(2) : "0.00";
  analytics.conversionWashToFinish = analytics.totalWashed > 0 ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched > 0 ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2) : "0.00");

  // (9) Top performing operators.
  const [topStitchOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total FROM stitching_data GROUP BY user_id ORDER BY total DESC LIMIT 1`
  );
  analytics.topOperatorStitch = topStitchOp.length ? topStitchOp[0] : null;
  const [topWashOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total FROM washing_data GROUP BY user_id ORDER BY total DESC LIMIT 1`
  );
  analytics.topOperatorWash = topWashOp.length ? topWashOp[0] : null;
  const [topFinishOp] = await pool.query(
    `SELECT user_id, SUM(total_pieces) AS total FROM finishing_data GROUP BY user_id ORDER BY total DESC LIMIT 1`
  );
  analytics.topOperatorFinish = topFinishOp.length ? topFinishOp[0] : null;

  // (10) Overall average turnaround time (days) from cutting to finishing.
  const [turnaroundRows] = await pool.query(
    `SELECT AVG(DATEDIFF(f.created_at, c.created_at)) AS avgTurnaround
     FROM cutting_lots c
     JOIN finishing_data f ON c.lot_no = f.lot_no`
  );
  analytics.avgTurnaroundTime = turnaroundRows[0].avgTurnaround ? parseFloat(turnaroundRows[0].avgTurnaround).toFixed(2) : "N/A";

  // (11) Count of pending lots.
  const [pendingRows] = await pool.query(
    `SELECT COUNT(*) AS pendingCount FROM (
       SELECT c.lot_no,
         (SELECT isApproved FROM stitching_assignments sa 
          JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id 
          WHERE c2.lot_no = c.lot_no ORDER BY sa.assigned_on DESC LIMIT 1) AS stitchStatus,
         (SELECT is_approved FROM washing_assignments wa 
          JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id 
          WHERE jd.lot_no = c.lot_no ORDER BY wa.assigned_on DESC LIMIT 1) AS washStatus,
         (SELECT is_approved FROM finishing_assignments fa 
          JOIN washing_data wd ON fa.washing_assignment_id = wd.id 
          WHERE wd.lot_no = c.lot_no ORDER BY fa.assigned_on DESC LIMIT 1) AS finishStatus
       FROM cutting_lots c
     ) AS sub
     WHERE (stitchStatus IS NULL OR stitchStatus = 0)
        OR (washStatus IS NULL OR washStatus = 0)
        OR (finishStatus IS NULL OR finishStatus = 0)`
  );
  analytics.pendingLots = pendingRows[0].pendingCount;

  // (12) Weekly new lot counts.
  const [weeklyNew] = await pool.query(
    `SELECT CONCAT(YEAR(created_at),'-W', WEEK(created_at)) AS week, COUNT(*) AS count
     FROM cutting_lots GROUP BY week ORDER BY week ASC`
  );
  analytics.weeklyNewLots = weeklyNew;

  // (13) Monthly new lot counts.
  const [monthlyNew] = await pool.query(
    `SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
     FROM cutting_lots GROUP BY month ORDER BY month ASC`
  );
  analytics.monthlyNewLots = monthlyNew;

  // (14) Total number of lots.
  const [lotCountRes] = await pool.query(`SELECT COUNT(*) AS totalLots FROM cutting_lots`);
  analytics.totalLots = lotCountRes[0].totalLots;

  // (15) Overall SKU performance.
  const [skuOverall] = await pool.query(
    `SELECT sku, SUM(total_pieces) AS totalPieces
     FROM cutting_lots GROUP BY sku ORDER BY totalPieces DESC`
  );
  analytics.skuOverallPerformance = skuOverall;

  // (16) Average turnaround time per SKU.
  const [skuTurnaround] = await pool.query(
    `SELECT c.sku, AVG(DATEDIFF(f.created_at, c.created_at)) AS avgTurnaround
     FROM cutting_lots c
     JOIN finishing_data f ON c.lot_no = f.lot_no
     GROUP BY c.sku`
  );
  analytics.skuTurnaround = skuTurnaround;

  // (17) Approval rates for assignments.
  const [stApproval] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN isApproved = 1 THEN 1 ELSE 0 END) AS approved
     FROM stitching_assignments`
  );
  analytics.stitchApprovalRate = stApproval[0].total > 0 ? ((stApproval[0].approved / stApproval[0].total) * 100).toFixed(2) : "N/A";
  const [washApproval] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved
     FROM washing_assignments`
  );
  analytics.washApprovalRate = washApproval[0].total > 0 ? ((washApproval[0].approved / washApproval[0].total) * 100).toFixed(2) : "N/A";
  const [finishApproval] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN is_approved = 1 THEN 1 ELSE 0 END) AS approved
     FROM finishing_assignments`
  );
  analytics.finishApprovalRate = finishApproval[0].total > 0 ? ((finishApproval[0].approved / finishApproval[0].total) * 100).toFixed(2) : "N/A";

  return analytics;
}

/**
 * GET /operator/dashboard
 *
 * Renders the operator dashboard with filtering, category selection,
 * and pagination.
 *
 * Query Parameters:
 *  - search: string to search in lot numbers.
 *  - startDate, endDate: date range filters (cutting_lots.created_at).
 *  - sortField, sortOrder: sorting parameters.
 *  - category: "all", "hoisery", or "denim" (based on created_by username).
 *  - page: page number (default 1).
 *  - limit: number of lots per page (default 10).
 *
 * For each lot, detailed data from cutting, stitching, washing, finishing,
 * and (if applicable) jeans assembly is aggregated. If the creator’s username
 * contains "hoisery", then washing, finishing, and jeans assembly data are hidden.
 *
 * Finally, summary statistics and advanced analytics are computed.
 */
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Retrieve query parameters.
    const { search, startDate, endDate, sortField, sortOrder, category } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;

    let lotNoArray = [];

    // Apply category filter.
    if (category === 'hoisery') {
      const [filtered] = await pool.query(
        `SELECT cl.lot_no FROM cutting_lots cl 
         JOIN users u ON cl.user_id = u.id 
         WHERE u.username LIKE '%hoisery%'`
      );
      lotNoArray = filtered.map(row => row.lot_no);
    } else if (category === 'denim') {
      const [filtered] = await pool.query(
        `SELECT cl.lot_no FROM cutting_lots cl 
         JOIN users u ON cl.user_id = u.id 
         WHERE u.username NOT LIKE '%hoisery%'`
      );
      lotNoArray = filtered.map(row => row.lot_no);
    } else {
      // All lots.
      const [allCuts] = await pool.query(`SELECT lot_no FROM cutting_lots`);
      allCuts.forEach(row => lotNoArray.push(row.lot_no));
    }

    // Apply search filter on lot_no.
    if (search) {
      lotNoArray = lotNoArray.filter(lot_no => lot_no.includes(search));
    }

    // Apply date range filter.
    if (startDate || endDate) {
      const [filteredLots] = await pool.query(
        `SELECT lot_no FROM cutting_lots
         WHERE (? IS NULL OR created_at >= ?)
           AND (? IS NULL OR created_at <= ?)`,
        [startDate || null, startDate || null, endDate || null, endDate || null]
      );
      const filteredSet = new Set(filteredLots.map(r => r.lot_no));
      lotNoArray = lotNoArray.filter(lot_no => filteredSet.has(lot_no));
    }

    // Apply sorting.
    if (sortField) {
      lotNoArray.sort((a, b) => {
        if (sortOrder === 'desc') return b.localeCompare(a);
        return a.localeCompare(b);
      });
    }

    // --- Pagination: Slice the lotNoArray ---
    const totalLotsFound = lotNoArray.length;
    const totalPages = Math.ceil(totalLotsFound / limit);
    const startIndex = (page - 1) * limit;
    const paginatedLotNos = lotNoArray.slice(startIndex, startIndex + limit);

    // Build detailed aggregator for each lot in paginatedLotNos.
    const lotDetails = {};
    for (const lot_no of paginatedLotNos) {
      // Fetch cutting lot details.
      const [cutRows] = await pool.query(
        `SELECT cl.*, u.username AS created_by 
         FROM cutting_lots cl 
         JOIN users u ON cl.user_id = u.id 
         WHERE cl.lot_no = ? LIMIT 1`,
        [lot_no]
      );
      const cuttingLot = cutRows.length ? cutRows[0] : null;

      // Fetch cutting lot sizes.
      const [cuttingSizes] = await pool.query(
        `SELECT * FROM cutting_lot_sizes
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY size_label`,
        [lot_no]
      );

      // Fetch cutting lot rolls.
      const [cuttingRolls] = await pool.query(
        `SELECT * FROM cutting_lot_rolls
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY roll_no`,
        [lot_no]
      );

      // Fetch stitching data.
      const [stitchingData] = await pool.query(
        `SELECT * FROM stitching_data WHERE lot_no = ?`,
        [lot_no]
      );
      let totalStitchedLocal = 0;
      stitchingData.forEach(item => { totalStitchedLocal += item.total_pieces; });
      const stitchingDataIds = stitchingData.map(sd => sd.id);
      let stitchingDataSizes = [];
      if (stitchingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM stitching_data_sizes WHERE stitching_data_id IN (?)`,
          [stitchingDataIds]
        );
        stitchingDataSizes = szRows;
      }

      // Fetch washing data.
      let [washingData] = await pool.query(
        `SELECT * FROM washing_data WHERE lot_no = ?`,
        [lot_no]
      );
      const washingDataIds = washingData.map(wd => wd.id);
      let washingDataSizes = [];
      if (washingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM washing_data_sizes WHERE washing_data_id IN (?)`,
          [washingDataIds]
        );
        washingDataSizes = szRows;
      }

      // Fetch finishing data.
      const [finishingData] = await pool.query(
        `SELECT * FROM finishing_data WHERE lot_no = ?`,
        [lot_no]
      );
      const finishingDataIds = finishingData.map(fd => fd.id);
      let finishingDataSizes = [];
      if (finishingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM finishing_data_sizes WHERE finishing_data_id IN (?)`,
          [finishingDataIds]
        );
        finishingDataSizes = szRows;
      }

      // Fetch Jeans Assembly data (only if cutting lot creator is not "hoisery").
      let jeansAssemblyData = [];
      let jeansAssemblyDataSizes = [];
      let jeansAssemblyAssignedUser = "N/A";
      if (cuttingLot && cuttingLot.created_by && !cuttingLot.created_by.toLowerCase().includes('hoisery')) {
        const [jaData] = await pool.query(`SELECT * FROM jeans_assembly_data WHERE lot_no = ?`, [lot_no]);
        jeansAssemblyData = jaData;
        const jaDataIds = jaData.map(item => item.id);
        if (jaDataIds.length) {
          const [jaSizes] = await pool.query(`SELECT * FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id IN (?)`, [jaDataIds]);
          jeansAssemblyDataSizes = jaSizes;
        }
        const [jaAssignRows] = await pool.query(
          `SELECT u.username, is_approved FROM jeans_assembly_assignments ja
           JOIN users u ON ja.user_id = u.id
           JOIN jeans_assembly_data jd ON ja.stitching_assignment_id = jd.id
           WHERE jd.lot_no = ?
           ORDER BY ja.assigned_on DESC LIMIT 1`,
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
        // For lots created by "hoisery", hide washing, finishing, and jeans assembly data.
        washingData = [];
        washingDataSizes = [];
        finishingData = [];
        finishingDataSizes = [];
        jeansAssemblyData = [];
        jeansAssemblyDataSizes = [];
      }

      // Fetch department confirmations.
      const [deptConfResult] = await pool.query(
        `SELECT dc.* 
         FROM department_confirmations dc
         JOIN lot_assignments la ON dc.lot_assignment_id = la.id
         WHERE la.cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );
      const departmentConfirmations = deptConfResult;

      // Fetch lot assignments.
      const [lotAssignResult] = await pool.query(
        `SELECT * FROM lot_assignments
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );
      const lotAssignments = lotAssignResult;

      // Compute leftovers.
      const leftovers = await computeAdvancedLeftoversForLot(lot_no);
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal);

      // Determine overall status.
      let status = "Complete";
      if (
        ["Waiting for approval", "Denied"].some(val => Object.values(leftovers).includes(val)) ||
        leftoverJeans === "Waiting for approval" || leftoverJeans === "Denied"
      ) {
        status = "Pending/Denied";
      } else if (
        ["Not Assigned"].some(val => Object.values(leftovers).includes(val)) ||
        leftoverJeans === "Not Assigned"
      ) {
        status = "Not Assigned";
      }

      // Fetch last assigned users.
      const [stitchingAssignRows] = await pool.query(
        `SELECT u.username FROM stitching_assignments sa 
         JOIN cutting_lots c ON sa.cutting_lot_id = c.id 
         JOIN users u ON sa.user_id = u.id 
         WHERE c.lot_no = ? ORDER BY sa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const stitchingAssignedUser = stitchingAssignRows.length ? stitchingAssignRows[0].username : "N/A";
      const [washingAssignRows] = await pool.query(
        `SELECT u.username FROM washing_assignments wa 
         JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id 
         JOIN users u ON wa.user_id = u.id 
         WHERE jd.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const washingAssignedUser = washingAssignRows.length ? washingAssignRows[0].username : "N/A";
      const [finishingAssignRows] = await pool.query(
        `SELECT u.username FROM finishing_assignments fa 
         JOIN washing_data wd ON fa.washing_assignment_id = wd.id 
         JOIN users u ON fa.user_id = u.id 
         WHERE wd.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const finishingAssignedUser = finishingAssignRows.length ? finishingAssignRows[0].username : "N/A";

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

    // Compute operator performance.
    const operatorPerformance = await computeOperatorPerformance();

    // Summary statistics.
    const [lotCountResult] = await pool.query(`SELECT COUNT(*) as lotCount FROM cutting_lots`);
    const lotCount = lotCountResult[0].lotCount;
    const [totalPiecesResult] = await pool.query(`SELECT COALESCE(SUM(total_pieces), 0) as totalPieces FROM cutting_lots`);
    const totalPiecesCut = totalPiecesResult[0].totalPieces;
    const [totalStitchedResult] = await pool.query(`SELECT COALESCE(SUM(total_pieces), 0) as totalStitched FROM stitching_data`);
    const [totalWashedResult] = await pool.query(`SELECT COALESCE(SUM(total_pieces), 0) as totalWashed FROM washing_data`);
    const [totalFinishedResult] = await pool.query(`SELECT COALESCE(SUM(total_pieces), 0) as totalFinished FROM finishing_data`);
    const [userCountResult] = await pool.query(`SELECT COUNT(*) as userCount FROM users`);
    const userCount = userCountResult[0].userCount;

    // Compute advanced analytics.
    const advancedAnalytics = await computeAdvancedAnalytics();

    // Render the dashboard.
    return res.render('operatorDashboard', {
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
      totalLotsFound: lotNoArray.length
    });
  } catch (err) {
    console.error('Error loading operator dashboard:', err);
    return res.status(500).send('Server error');
  }
});

// Endpoint to edit lot details.
router.post('/dashboard/edit-lot', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no, total_pieces, remark } = req.body;
    if (!lot_no) return res.status(400).send('Lot number is required');
    await pool.query(
      `UPDATE cutting_lots SET total_pieces = ?, remark = ? WHERE lot_no = ?`,
      [total_pieces || 0, remark || null, lot_no]
    );
    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error editing lot:', err);
    return res.status(500).send('Server error');
  }
});

// Endpoint to download detailed leftover data as CSV.
router.get('/dashboard/leftovers/download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [lots] = await pool.query(`SELECT lot_no FROM cutting_lots`);
    let csvContent = "Lot No,Leftover Stitch,Leftover Wash,Leftover Finish,Leftover Jeans\n";
    for (const lotRow of lots) {
      const lot_no = lotRow.lot_no;
      const leftovers = await computeAdvancedLeftoversForLot(lot_no);
      const [stData] = await pool.query(`SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?`, [lot_no]);
      const totalStitchedLocal = stData[0].sumStitched || 0;
      const leftoverJeans = await computeJeansLeftover(lot_no, totalStitchedLocal);
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

// Endpoint to download a specific lot's data as CSV.
router.get('/dashboard/lot-tracking/:lot_no/download', isAuthenticated, isOperator, async (req, res) => {
  const { lot_no } = req.params;
  try {
    const [cutRows] = await pool.query(
      `SELECT * FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
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

// Endpoint to download all lots as CSV.
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
