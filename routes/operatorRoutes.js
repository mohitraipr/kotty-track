/**************************************************
 * operatorRoutes.js
 * 
 * This file has been modified to remove assignment-
 * related endpoints and to enhance the lot tracking
 * dashboard. In addition to previous features, it now
 * also fetches (per lot) the last assigned user for 
 * stitching, washing, and finishing.
 **************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * Helper function: computeLeftoversForLot
 * Returns an object with leftoverStitch, leftoverWash and leftoverFinish.
 */
async function computeLeftoversForLot(lot_no) {
  // 1) totalCut
  let totalCut = 0;
  const [clRows] = await pool.query(
    `SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
    [lot_no]
  );
  if (clRows.length) {
    totalCut = clRows[0].total_pieces || 0;
  }

  // 2) totalStitched
  let [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalStitched = rows[0].sumStitched || 0;

  // 3) totalWashed
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalWashed = rows[0].sumWashed || 0;

  // 4) totalFinished
  [rows] = await pool.query(
    `SELECT COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data WHERE lot_no = ?`,
    [lot_no]
  );
  const totalFinished = rows[0].sumFinished || 0;

  // 5) Check if there is any stitching assignment for this lot
  const [stAssign] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM stitching_assignments sa
     JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?`,
    [lot_no]
  );
  const assignedStitch = stAssign[0].cnt > 0;

  // 6) Check washing assignment
  const [wAssign] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM washing_assignments wa
     JOIN stitching_assignments sa ON wa.stitching_assignment_id = sa.id
     JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?`,
    [lot_no]
  );
  const assignedWash = wAssign[0].cnt > 0;

  // 7) Check finishing assignment
  const [fAssign] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM finishing_assignments fa
     LEFT JOIN stitching_assignments sa ON fa.stitching_assignment_id = sa.id
     LEFT JOIN washing_assignments wa ON fa.washing_assignment_id = wa.id
     LEFT JOIN cutting_lots c1 ON sa.cutting_lot_id = c1.id
     LEFT JOIN stitching_assignments sa2 ON wa.stitching_assignment_id = sa2.id
     LEFT JOIN cutting_lots c2 ON sa2.cutting_lot_id = c2.id
     WHERE (c1.lot_no = ? OR c2.lot_no = ?)`,
    [lot_no, lot_no]
  );
  const assignedFinish = fAssign[0].cnt > 0;

  // 8) Compute leftovers if assigned; otherwise null.
  const leftoverStitch = assignedStitch ? (totalCut - totalStitched) : null;
  const leftoverWash = assignedWash ? (totalStitched - totalWashed) : null;
  let leftoverFinish = null;
  if (assignedFinish) {
    if (assignedWash) {
      leftoverFinish = totalWashed - totalFinished;
    } else {
      leftoverFinish = totalStitched - totalFinished;
    }
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

/**
 * Helper function: computeOperatorPerformance
 * Computes aggregated totals for each operator (by user_id)
 */
async function computeOperatorPerformance() {
  const perf = {}; // user_id => { username, totalStitched, totalWashed, totalFinished }

  // stitching_data
  let [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });

  // washing_data
  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });

  // finishing_data
  [rows] = await pool.query(
    `SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data GROUP BY user_id`
  );
  rows.forEach(r => {
    if (!perf[r.user_id]) perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });

  // Attach usernames
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
 * GET /operator/dashboard
 * Enhanced lot tracking dashboard – no assignment forms.
 * Supports filtering (search string and date range) and sorting.
 * Aggregates data from cutting_lots, sizes, rolls and computes leftovers.
 * Also fetches the last assigned user (if any) for stitching, washing and finishing.
 */
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate, sortField, sortOrder } = req.query;

    // 1) Get all lot numbers from cutting_lots.
    const [allCuts] = await pool.query(`SELECT lot_no FROM cutting_lots`);
    const allLotNos = new Set();
    allCuts.forEach(row => allLotNos.add(row.lot_no));
    let lotNoArray = Array.from(allLotNos);

    // 2) Apply search filter by lot_no substring.
    if (search) {
      lotNoArray = lotNoArray.filter(lot_no => lot_no.includes(search));
    }

    // 3) Apply date range filter (using cutting_lots.created_at).
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

    // 4) Sorting if requested.
    if (sortField) {
      lotNoArray.sort((a, b) => {
        if (sortOrder === 'desc') return b.localeCompare(a);
        return a.localeCompare(b);
      });
    }

    // 5) Build aggregator: for each lot_no, fetch associated data.
    const lotDetails = {};
    for (const lot_no of lotNoArray) {
      // Query cutting_lots joined with users to get creator's username.
      const [cutRows] = await pool.query(
        `SELECT cl.*, u.username AS created_by 
         FROM cutting_lots cl 
         JOIN users u ON cl.user_id = u.id 
         WHERE cl.lot_no = ? LIMIT 1`,
        [lot_no]
      );
      const cuttingLot = cutRows.length ? cutRows[0] : null;

      // cutting_lot_sizes
      const [cuttingSizes] = await pool.query(
        `SELECT * FROM cutting_lot_sizes
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY size_label`,
        [lot_no]
      );

      // cutting_lot_rolls
      const [cuttingRolls] = await pool.query(
        `SELECT * FROM cutting_lot_rolls
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)
         ORDER BY roll_no`,
        [lot_no]
      );

      // stitching_data and its sizes.
      const [stitchingData] = await pool.query(
        `SELECT * FROM stitching_data WHERE lot_no = ?`,
        [lot_no]
      );
      const stitchingDataIds = stitchingData.map(sd => sd.id);
      let stitchingDataSizes = [];
      if (stitchingDataIds.length) {
        const [szRows] = await pool.query(
          `SELECT * FROM stitching_data_sizes WHERE stitching_data_id IN (?)`,
          [stitchingDataIds]
        );
        stitchingDataSizes = szRows;
      }

      // washing_data and its sizes.
      const [washingData] = await pool.query(
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

      // finishing_data and its sizes.
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

      // department_confirmations (historical info).
      const [departmentConfirmations] = await pool.query(
        `SELECT dc.*
         FROM department_confirmations dc
         JOIN lot_assignments la ON dc.lot_assignment_id = la.id
         WHERE la.cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );

      // lot_assignments (historical info).
      const [lotAssignments] = await pool.query(
        `SELECT * FROM lot_assignments
         WHERE cutting_lot_id = (SELECT id FROM cutting_lots WHERE lot_no = ?)`,
        [lot_no]
      );

      // Compute leftovers.
      const { leftoverStitch, leftoverWash, leftoverFinish } = await computeLeftoversForLot(lot_no);

      // New queries: fetch the last assigned user for each department.
      const [stitchingAssignRows] = await pool.query(
        `SELECT u.username FROM stitching_assignments sa 
         JOIN cutting_lots c ON sa.cutting_lot_id = c.id 
         JOIN users u ON sa.user_id = u.id 
         WHERE c.lot_no = ? ORDER BY sa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const stitchingAssignedUser = stitchingAssignRows.length ? stitchingAssignRows[0].username : null;

      const [washingAssignRows] = await pool.query(
        `SELECT u.username FROM washing_assignments wa 
         JOIN stitching_assignments sa ON wa.stitching_assignment_id = sa.id 
         JOIN cutting_lots c ON sa.cutting_lot_id = c.id 
         JOIN users u ON wa.user_id = u.id 
         WHERE c.lot_no = ? ORDER BY wa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const washingAssignedUser = washingAssignRows.length ? washingAssignRows[0].username : null;

      const [finishingAssignRows] = await pool.query(
        `SELECT u.username FROM finishing_assignments fa 
         JOIN users u ON fa.user_id = u.id 
         LEFT JOIN stitching_assignments sa ON fa.stitching_assignment_id = sa.id 
         LEFT JOIN washing_assignments wa ON fa.washing_assignment_id = wa.id 
         LEFT JOIN cutting_lots c ON (sa.cutting_lot_id = c.id OR wa.stitching_assignment_id = sa.id)
         WHERE c.lot_no = ? ORDER BY fa.assigned_on DESC LIMIT 1`,
         [lot_no]
      );
      const finishingAssignedUser = finishingAssignRows.length ? finishingAssignRows[0].username : null;

      // Since we no longer have a lot_overrides table, set override to null.
      const override = null;

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
        departmentConfirmations,
        lotAssignments,
        leftoverStitch,
        leftoverWash,
        leftoverFinish,
        stitchingAssignedUser,
        washingAssignedUser,
        finishingAssignedUser,
        override
      };
    }

    // 6) Compute operator performance (optional).
    const operatorPerformance = await computeOperatorPerformance();

    return res.render('operatorDashboard', {
      lotDetails,
      operatorPerformance,
      query: { search, startDate, endDate, sortField, sortOrder }
    });
  } catch (err) {
    console.error('Error loading operator dashboard:', err);
    return res.status(500).send('Server error');
  }
});

// The edit-lot and export endpoints remain as in the previous version.
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

// ***** Assignment endpoints removed *****

module.exports = router;
