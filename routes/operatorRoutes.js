/**************************************************
 * operatorRoutes.js
 **************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * Helper function to compute:
 *  - totalCut
 *  - totalStitched
 *  - totalWashed
 *  - totalFinished
 * Then leftoverStitch = totalCut - totalStitched (ONLY if assignedStitch = true)
 * leftoverWash = totalStitched - totalWashed (ONLY if assignedWash = true)
 * leftoverFinish = totalWashed - totalFinished (ONLY if assignedFinish = true)
 */
async function computeLeftoversForLot(lot_no) {
  // 1) totalCut
  let totalCut = 0;
  const [clRows] = await pool.query(`
    SELECT total_pieces
    FROM cutting_lots
    WHERE lot_no = ?
    LIMIT 1
  `, [lot_no]);
  if (clRows.length) {
    totalCut = clRows[0].total_pieces || 0;
  }

  // 2) totalStitched
  let [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
    FROM stitching_data
    WHERE lot_no = ?
  `, [lot_no]);
  const totalStitched = rows[0].sumStitched || 0;

  // 3) totalWashed
  [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWashed
    FROM washing_data
    WHERE lot_no = ?
  `, [lot_no]);
  const totalWashed = rows[0].sumWashed || 0;

  // 4) totalFinished
  [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumFinished
    FROM finishing_data
    WHERE lot_no = ?
  `, [lot_no]);
  const totalFinished = rows[0].sumFinished || 0;

  // 5) Check if there's a Stitching assignment for this lot
  const [stAssign] = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM stitching_assignments sa
    JOIN cutting_lots c ON sa.cutting_lot_id = c.id
    WHERE c.lot_no = ?
  `, [lot_no]);
  const assignedStitch = stAssign[0].cnt > 0;

  // 6) Check Washing assignment
  const [wAssign] = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM washing_assignments wa
    JOIN stitching_assignments sa ON wa.stitching_assignment_id = sa.id
    JOIN cutting_lots c ON sa.cutting_lot_id = c.id
    WHERE c.lot_no = ?
  `, [lot_no]);
  const assignedWash = wAssign[0].cnt > 0;

  // 7) Check Finishing assignment
  const [fAssign] = await pool.query(`
    SELECT COUNT(*) AS cnt
    FROM finishing_assignments fa
    LEFT JOIN stitching_assignments sa ON fa.stitching_assignment_id = sa.id
    LEFT JOIN washing_assignments wa ON fa.washing_assignment_id = wa.id
    LEFT JOIN cutting_lots c1 ON sa.cutting_lot_id = c1.id
    LEFT JOIN stitching_assignments sa2 ON wa.stitching_assignment_id = sa2.id
    LEFT JOIN cutting_lots c2 ON sa2.cutting_lot_id = c2.id
    WHERE (c1.lot_no = ? OR c2.lot_no = ?)
  `, [lot_no, lot_no]);
  const assignedFinish = fAssign[0].cnt > 0;

  // 8) If not assigned, leftover = null, else leftover = computed
  const leftoverStitch = assignedStitch ? (totalCut - totalStitched) : null;
  const leftoverWash   = assignedWash   ? (totalStitched - totalWashed) : null;
  let leftoverFinish = null;
  if (assignedFinish) {
    // If washing is assigned, use totalWashed, else fall back to totalStitched
    if (assignedWash) {
      leftoverFinish = totalWashed - totalFinished;
    } else {
      leftoverFinish = totalStitched - totalFinished;
    }
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

/**
 * Sum up total pieces by user (optional "operator performance")
 */
async function computeOperatorPerformance() {
  const perf = {}; // user_id => { username, totalStitched, totalWashed, totalFinished }

  // stitching_data
  let [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumStitched
    FROM stitching_data
    GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalStitched = r.sumStitched || 0;
  });

  // washing_data
  [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumWashed
    FROM washing_data
    GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalWashed = r.sumWashed || 0;
  });

  // finishing_data
  [rows] = await pool.query(`
    SELECT user_id, COALESCE(SUM(total_pieces),0) AS sumFinished
    FROM finishing_data
    GROUP BY user_id
  `);
  rows.forEach(r => {
    if (!perf[r.user_id]) {
      perf[r.user_id] = { totalStitched: 0, totalWashed: 0, totalFinished: 0 };
    }
    perf[r.user_id].totalFinished = r.sumFinished || 0;
  });

  // attach usernames
  const uids = Object.keys(perf);
  if (!uids.length) return perf;

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

  return perf;
}

/**
 * GET /operator/dashboard
 *  - ALWAYS show all lots from cutting_lots (even unassigned)
 *  - Also gather from stitching/washing/finishing assignments
 *  - Then aggregator "lotDetails" for leftover pieces, etc.
 */
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    // 1) STITCHING assignments
    const [stitchingAssignments] = await pool.query(`
      SELECT
        sa.id,
        sa.operator_id,
        sa.user_id,
        sa.cutting_lot_id,
        sa.target_day,
        sa.assigned_on,
        u.username AS assignedUser,
        (SELECT username FROM users WHERE id = sa.operator_id) AS operatorName,
        c.lot_no AS lot_no,
        c.sku AS sku
      FROM stitching_assignments sa
      JOIN users u ON sa.user_id = u.id
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      ORDER BY sa.assigned_on DESC
    `);

    // 2) WASHING assignments
    const [washingAssignments] = await pool.query(`
      SELECT
        wa.id,
        wa.operator_id,
        wa.user_id,
        wa.stitching_assignment_id,
        wa.target_day,
        wa.assigned_on,
        u.username AS assignedUser,
        (SELECT username FROM users WHERE id = wa.operator_id) AS operatorName,

        sa.cutting_lot_id,
        c.lot_no AS lot_no,
        c.sku AS sku
      FROM washing_assignments wa
      JOIN users u ON wa.user_id = u.id
      JOIN stitching_assignments sa ON wa.stitching_assignment_id = sa.id
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      ORDER BY wa.assigned_on DESC
    `);

    // 3) FINISHING assignments
    const [finishingAssignments] = await pool.query(`
      SELECT
        fa.id,
        fa.operator_id,
        fa.user_id,
        fa.stitching_assignment_id,
        fa.washing_assignment_id,
        fa.target_day,
        fa.assigned_on,
        u.username AS assignedUser,
        (SELECT username FROM users WHERE id = fa.operator_id) AS operatorName,

        sa.cutting_lot_id AS stitching_cut_lot_id,
        c1.lot_no AS stitching_lot_no,
        c1.sku    AS stitching_sku,

        wa.id AS washingId,
        sa2.cutting_lot_id AS washing_cut_lot_id,
        c2.lot_no AS washing_lot_no,
        c2.sku    AS washing_sku

      FROM finishing_assignments fa
      JOIN users u ON fa.user_id = u.id

      LEFT JOIN stitching_assignments sa 
             ON fa.stitching_assignment_id = sa.id
      LEFT JOIN cutting_lots c1 
             ON sa.cutting_lot_id = c1.id

      LEFT JOIN washing_assignments wa 
             ON fa.washing_assignment_id = wa.id
      LEFT JOIN stitching_assignments sa2 
             ON wa.stitching_assignment_id = sa2.id
      LEFT JOIN cutting_lots c2 
             ON sa2.cutting_lot_id = c2.id

      ORDER BY fa.assigned_on DESC
    `);

    // 4) OPERATOR PERFORMANCE (Optional aggregator)
    const operatorPerformance = await computeOperatorPerformance();

    // ============================================================
    // BUILD THE SET OF ALL LOT_NOS:
    //  - from cutting_lots (to show unassigned lots too)
    //  - from the assignment queries
    // ============================================================
    const allLotNos = new Set();

    // a) from cutting_lots
    const [allCuts] = await pool.query(`
      SELECT lot_no
      FROM cutting_lots
    `);
    allCuts.forEach(row => allLotNos.add(row.lot_no));

    // b) from stitching
    stitchingAssignments.forEach(a => {
      if (a.lot_no) allLotNos.add(a.lot_no);
    });
    // c) from washing
    washingAssignments.forEach(a => {
      if (a.lot_no) allLotNos.add(a.lot_no);
    });
    // d) from finishing
    finishingAssignments.forEach(a => {
      if (a.stitching_lot_no) allLotNos.add(a.stitching_lot_no);
      if (a.washing_lot_no) allLotNos.add(a.washing_lot_no);
    });

    const lotNoArray = [...allLotNos];

    // ============================================================
    // BUILD AGGREGATOR: lotDetails
    // ============================================================
    const lotDetails = {};

    for (const lot_no of lotNoArray) {
      // 1) cutting_lots row
      const [cutRows] = await pool.query(`
        SELECT *
        FROM cutting_lots
        WHERE lot_no = ?
        LIMIT 1
      `, [lot_no]);
      const cuttingLot = cutRows.length ? cutRows[0] : null;

      // 2) cutting_lot_sizes
      const [cuttingSizes] = await pool.query(`
        SELECT *
        FROM cutting_lot_sizes
        WHERE cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ?
        )
        ORDER BY size_label
      `, [lot_no]);

      // 3) cutting_lot_rolls
      const [cuttingRolls] = await pool.query(`
        SELECT *
        FROM cutting_lot_rolls
        WHERE cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ?
        )
        ORDER BY roll_no
      `, [lot_no]);

      // 4) stitching_data (+ sizes)
      const [stitchingData] = await pool.query(`
        SELECT *
        FROM stitching_data
        WHERE lot_no = ?
      `, [lot_no]);
      const stitchingDataIds = stitchingData.map(sd => sd.id);
      let stitchingDataSizes = [];
      if (stitchingDataIds.length) {
        const [szRows] = await pool.query(`
          SELECT *
          FROM stitching_data_sizes
          WHERE stitching_data_id IN (?)
        `, [stitchingDataIds]);
        stitchingDataSizes = szRows;
      }

      // 5) washing_data (+ sizes)
      const [washingData] = await pool.query(`
        SELECT *
        FROM washing_data
        WHERE lot_no = ?
      `, [lot_no]);
      const washingDataIds = washingData.map(wd => wd.id);
      let washingDataSizes = [];
      if (washingDataIds.length) {
        const [szRows] = await pool.query(`
          SELECT *
          FROM washing_data_sizes
          WHERE washing_data_id IN (?)
        `, [washingDataIds]);
        washingDataSizes = szRows;
      }

      // 6) finishing_data (+ sizes)
      const [finishingData] = await pool.query(`
        SELECT *
        FROM finishing_data
        WHERE lot_no = ?
      `, [lot_no]);
      const finishingDataIds = finishingData.map(fd => fd.id);
      let finishingDataSizes = [];
      if (finishingDataIds.length) {
        const [szRows] = await pool.query(`
          SELECT *
          FROM finishing_data_sizes
          WHERE finishing_data_id IN (?)
        `, [finishingDataIds]);
        finishingDataSizes = szRows;
      }

      // 7) department_confirmations
      const [departmentConfirmations] = await pool.query(`
        SELECT dc.*
        FROM department_confirmations dc
        JOIN lot_assignments la ON dc.lot_assignment_id = la.id
        WHERE la.cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ?
        )
      `, [lot_no]);

      // 8) lot_assignments
      const [lotAssignments] = await pool.query(`
        SELECT *
        FROM lot_assignments
        WHERE cutting_lot_id = (
          SELECT id FROM cutting_lots WHERE lot_no = ?
        )
      `, [lot_no]);

      // compute leftover, but only if assigned in that dept
      const { leftoverStitch, leftoverWash, leftoverFinish } = 
        await computeLeftoversForLot(lot_no);

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
        leftoverFinish
      };
    }

    return res.render('operatorDashboard', {
      stitchingAssignments,
      washingAssignments,
      finishingAssignments,
      lotDetails,
      operatorPerformance
    });
  } catch (err) {
    console.error('Error loading operator dashboard:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * GET /operator/dashboard/lot-tracking/:lot_no/download
 * Single-lot download (placeholder)
 */
router.get('/dashboard/lot-tracking/:lot_no/download', isAuthenticated, isOperator, async (req, res) => {
  const { lot_no } = req.params;
  res.send(`Download for lot_no ${lot_no} not implemented yet!`);
});

/**
 * GET /operator/dashboard/download-all-lots
 * Big "Download All" (placeholder)
 */
router.get('/dashboard/download-all-lots', isAuthenticated, isOperator, async (req, res) => {
  res.send('Download-all-lots not implemented yet!');
});

/*******************************************************
 * The REST: listing users, picking lots, assigning
 *******************************************************/

/**
 * GET /operator/dashboard/users-stitching
 */
router.get('/dashboard/users-stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'stitching_master'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json(users);
  } catch (err) {
    console.error('Error fetching stitching users:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/users-washing
 */
router.get('/dashboard/users-washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'washing_master'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json(users);
  } catch (err) {
    console.error('Error fetching washing users:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/users-finishing
 */
router.get('/dashboard/users-finishing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.username
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name = 'finishing'
        AND u.is_active = 1
      ORDER BY u.username ASC
    `);
    return res.json(users);
  } catch (err) {
    console.error('Error fetching finishing users:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/lots-stitching?user_id=xxx
 * Return up to 5 cutting_lots not assigned to that user in stitching_assignments
 */
router.get('/dashboard/lots-stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    const [lots] = await pool.query(`
      SELECT c.id, c.lot_no, c.sku
      FROM cutting_lots c
      WHERE c.id NOT IN (
        SELECT cutting_lot_id
        FROM stitching_assignments
        WHERE user_id = ?
      )
      ORDER BY c.created_at DESC
      
    `, [user_id]);

    return res.json(lots);
  } catch (err) {
    console.error('Error fetching cutting lots for stitching:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/lots-washing?user_id=xxx
 * Return up to 5 stitching_assignments not yet assigned to that user in washing_assignments
 */
router.get('/dashboard/lots-washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    const [assignments] = await pool.query(`
      SELECT sa.id,
             sa.cutting_lot_id,
             c.lot_no,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE sa.id NOT IN (
        SELECT stitching_assignment_id
        FROM washing_assignments
        WHERE user_id = ?
      )
      ORDER BY sa.assigned_on DESC
      LIMIT 5
    `, [user_id]);

    return res.json(assignments);
  } catch (err) {
    console.error('Error fetching stitching_assignments for washing:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/lots-finishing-from-stitching?user_id=xxx
 * Return up to 5 stitching_assignments not used in finishing_assignments
 * AND whose stitching_data.total_pieces > 0
 */
router.get('/dashboard/lots-finishing-from-stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    // We only show if stitching_data > 0
    const [lots] = await pool.query(`
      SELECT sa.id,
             c.lot_no,
             c.sku
      FROM stitching_assignments sa
      JOIN cutting_lots c 
        ON sa.cutting_lot_id = c.id
      JOIN stitching_data sd
        ON sd.lot_no = c.lot_no
       AND sd.sku = c.sku
      WHERE sa.id NOT IN (
        SELECT stitching_assignment_id
        FROM finishing_assignments
        WHERE stitching_assignment_id IS NOT NULL
      )
      AND sd.total_pieces > 0
      ORDER BY sa.assigned_on DESC
      LIMIT 5
    `);

    return res.json(lots);
  } catch (err) {
    console.error('Error finishing-from-stitching:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * GET /operator/dashboard/lots-finishing-from-washing?user_id=xxx
 * Return up to 5 washing_assignments not used in finishing_assignments
 * AND whose washing_data.total_pieces > 0
 */
router.get('/dashboard/lots-finishing-from-washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ error: 'Missing user_id' });
    }

    const [lots] = await pool.query(`
      SELECT wa.id,
             sa.cutting_lot_id,
             c.lot_no,
             c.sku
      FROM washing_assignments wa
      JOIN stitching_assignments sa 
        ON wa.stitching_assignment_id = sa.id
      JOIN cutting_lots c
        ON sa.cutting_lot_id = c.id
      JOIN washing_data wd
        ON wd.lot_no = c.lot_no
       AND wd.sku = c.sku
      WHERE wa.id NOT IN (
        SELECT washing_assignment_id
        FROM finishing_assignments
        WHERE washing_assignment_id IS NOT NULL
      )
      AND wa.user_id = ?
      AND wd.total_pieces > 0
      ORDER BY wa.assigned_on DESC
      LIMIT 5
    `, [user_id]);

    return res.json(lots);
  } catch (err) {
    console.error('Error finishing-from-washing:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /operator/dashboard/assign-stitching
 */
router.post('/dashboard/assign-stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id, cutting_lot_id, target_day } = req.body;
    const operator_id = req.session.user.id;

    await pool.query(`
      INSERT INTO stitching_assignments
      (operator_id, user_id, cutting_lot_id, target_day, assigned_on)
      VALUES (?, ?, ?, ?, NOW())
    `, [operator_id, user_id, cutting_lot_id, target_day || null]);

    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error assigning stitching:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * POST /operator/dashboard/assign-washing
 */
router.post('/dashboard/assign-washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id, stitching_assignment_id, target_day } = req.body;
    const operator_id = req.session.user.id;

    await pool.query(`
      INSERT INTO washing_assignments
      (operator_id, user_id, stitching_assignment_id, target_day, assigned_on)
      VALUES (?, ?, ?, ?, NOW())
    `, [operator_id, user_id, stitching_assignment_id, target_day || null]);

    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error assigning washing:', err);
    return res.status(500).send('Server error');
  }
});

/**
 * POST /operator/dashboard/assign-finishing-from-stitching
 */
router.post('/dashboard/assign-finishing-from-stitching', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id, stitching_assignment_id, target_day } = req.body;
    const operator_id = req.session.user.id;

    await pool.query(`
      INSERT INTO finishing_assignments
      (operator_id, user_id, stitching_assignment_id, target_day, assigned_on)
      VALUES (?, ?, ?, ?, NOW())
    `, [operator_id, user_id, stitching_assignment_id, target_day || null]);

    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error assigning finishing (stitching):', err);
    return res.status(500).send('Server error');
  }
});

/**
 * POST /operator/dashboard/assign-finishing-from-washing
 */
router.post('/dashboard/assign-finishing-from-washing', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { user_id, washing_assignment_id, target_day } = req.body;
    const operator_id = req.session.user.id;

    await pool.query(`
      INSERT INTO finishing_assignments
      (operator_id, user_id, washing_assignment_id, target_day, assigned_on)
      VALUES (?, ?, ?, ?, NOW())
    `, [operator_id, user_id, washing_assignment_id, target_day || null]);

    return res.redirect('/operator/dashboard');
  } catch (err) {
    console.error('Error assigning finishing (washing):', err);
    return res.status(500).send('Server error');
  }
});

module.exports = router;
