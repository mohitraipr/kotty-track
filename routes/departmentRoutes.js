/*********************************************************************
 * routes/departmentRoutes.js
 *
 * Allows partial leftover. Dept user can confirm partial repeatedly.
 * Then operator sees 'dept_submitted' => verifies => partial pass forward.
 *********************************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isDepartmentUser } = require('../middlewares/auth');

/**
 * GET /department/dashboard
 * Enhanced styling
 */
router.get('/dashboard', isAuthenticated, isDepartmentUser, async (req, res) => {
  try {
    const userId = req.session.user.id;

    const [rows] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        la.cutting_lot_id,
        la.status AS assignment_status,
        la.assigned_pieces AS assignment_total_pieces,
        la.assigned_at,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        sa.id AS size_assignment_id,
        sa.size_label,
        sa.assigned_pieces,
        sa.completed_pieces,
        sa.status AS size_status
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id=cl.id
      JOIN size_assignments sa ON sa.lot_assignment_id=la.id
      WHERE la.assigned_to_user_id=?
      ORDER BY la.assigned_at DESC, sa.id ASC
    `, [userId]);

    // group them
    const assignmentsMap = {};
    for (const row of rows) {
      if (!assignmentsMap[row.assignment_id]) {
        assignmentsMap[row.assignment_id] = {
          assignment_id: row.assignment_id,
          cutting_lot_id: row.cutting_lot_id,
          assignment_status: row.assignment_status,
          assignment_total_pieces: row.assignment_total_pieces,
          assigned_at: row.assigned_at,
          lot_no: row.lot_no,
          sku: row.sku,
          fabric_type: row.fabric_type,
          flow_type: row.flow_type,
          sizes: []
        };
      }
      assignmentsMap[row.assignment_id].sizes.push({
        size_assignment_id: row.size_assignment_id,
        size_label: row.size_label,
        assigned_pieces: row.assigned_pieces,
        completed_pieces: row.completed_pieces,
        size_status: row.size_status
      });
    }

    const myAssignments = Object.values(assignmentsMap);

    res.render('departmentDashboard', {
      user: req.session.user,
      myAssignments
    });
  } catch (err) {
    console.error('Error GET /department/dashboard:', err);
    req.flash('error', 'Failed to load Department Dashboard.');
    res.redirect('/');
  }
});

/**
 * POST /department/confirm
 * partial confirm => leftover
 * set assignment => 'dept_submitted'
 */
router.post('/confirm', isAuthenticated, isDepartmentUser, async (req, res) => {
  try {
    const { assignment_id, sizeConfirms, remarks } = req.body;
    if (!assignment_id || !sizeConfirms || !Array.isArray(sizeConfirms)) {
      throw new Error('Invalid confirm data.');
    }

    const userId = req.session.user.id;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let sumJustConfirmed = 0;
      for (const sc of sizeConfirms) {
        const sizeAsgId = parseInt(sc.size_assignment_id, 10);
        const completedNow = parseInt(sc.completed_pieces, 10) || 0;

        // read old
        const [[szRow]] = await conn.query(`
          SELECT assigned_pieces, completed_pieces
          FROM size_assignments
          WHERE id=?
        `, [sizeAsgId]);
        if (!szRow) {
          throw new Error(`Size assignment ID=${sizeAsgId} not found.`);
        }
        const leftover = szRow.assigned_pieces - szRow.completed_pieces;
        const finalCompleted = Math.min(leftover, completedNow);

        // update
        await conn.query(`
          UPDATE size_assignments
          SET completed_pieces=completed_pieces + ?
          WHERE id=?
        `, [finalCompleted, sizeAsgId]);

        sumJustConfirmed += finalCompleted;
      }

      // set lot_assignments => 'dept_submitted'
      await conn.query(`
        UPDATE lot_assignments
        SET status='dept_submitted'
        WHERE id=?
      `, [assignment_id]);

      // optionally store remarks in a separate table

      await conn.commit();
      conn.release();

      req.flash('success', `Dept partial confirm: ${sumJustConfirmed} pieces. Waiting operator verification.`);
      return res.redirect('/department/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error POST /department/confirm trans:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/department/dashboard');
    }
  } catch (err) {
    console.error('Error in department/confirm:', err);
    req.flash('error', err.message);
    return res.redirect('/department/dashboard');
  }
});

module.exports = router;
