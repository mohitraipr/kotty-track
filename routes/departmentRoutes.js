/*********************************************************************
 * routes/departmentRoutes.js
 *
 * Departments (stitching/checking/washing/finishing/etc.)
 * 1. View assigned lots + their size assignments from `size_assignments`.
 * 2. Confirm partial or full pieces -> updates `size_assignments.completed_pieces`.
 * 3. Insert a record in `department_confirmations`.
 *********************************************************************/

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isDepartmentUser } = require('../middlewares/auth');

/**
 * GET /department/dashboard
 * Lists all lot_assignments and their size_assignments for the currently logged-in dept user,
 * focusing on those not fully completed.
 */
router.get('/dashboard', isAuthenticated, isDepartmentUser, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // We'll fetch all active assignments for this user
    // Then join with size_assignments to see the piece breakdown
    const [assignedRows] = await pool.query(`
      SELECT 
        la.id AS assignment_id,
        la.cutting_lot_id,
        la.status AS assignment_status,
        la.assigned_pieces AS assignment_total_pieces,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        la.assigned_at,
        sa.id AS size_assignment_id,
        sa.size_label,
        sa.assigned_pieces,
        sa.completed_pieces,
        sa.status AS size_status
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN size_assignments sa ON sa.lot_assignment_id = la.id
      WHERE la.assigned_to_user_id = ?
      ORDER BY la.assigned_at DESC, sa.id ASC
    `, [userId]);

    // Group them by assignment
    const assignmentsMap = {};
    for (const row of assignedRows) {
      if (!assignmentsMap[row.assignment_id]) {
        assignmentsMap[row.assignment_id] = {
          assignment_id: row.assignment_id,
          cutting_lot_id: row.cutting_lot_id,
          lot_no: row.lot_no,
          sku: row.sku,
          fabric_type: row.fabric_type,
          assignment_status: row.assignment_status,
          assigned_at: row.assigned_at,
          assignment_total_pieces: row.assignment_total_pieces,
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
    console.error('Error loading Department Dashboard:', err);
    req.flash('error', 'Failed to load Department Dashboard.');
    res.redirect('/');
  }
});

/**
 * POST /department/confirm
 * This is where a department user updates `completed_pieces` in `size_assignments`.
 * Also inserts a row in `department_confirmations` if needed.
 *
 * Body Example:
 * {
 *   "assignment_id": "123",
 *   "sizeConfirms": [
 *     {"size_assignment_id": 11, "completed_pieces": 50},
 *     {"size_assignment_id": 12, "completed_pieces": 120}
 *   ],
 *   "remarks": "All good"
 * }
 */
router.post('/confirm', isAuthenticated, isDepartmentUser, async (req, res) => {
  try {
    const { assignment_id, sizeConfirms, remarks } = req.body;
    const userId = req.session.user.id;

    if (!assignment_id || !sizeConfirms || !Array.isArray(sizeConfirms)) {
      throw new Error('Invalid confirm data.');
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1) Calculate how many pieces were just confirmed now
      let sumJustConfirmed = 0;

      for (const sc of sizeConfirms) {
        const sizeAssignmentId = parseInt(sc.size_assignment_id, 10);
        const completedPieces = parseInt(sc.completed_pieces, 10) || 0;

        // Find how many were assigned in size_assignments
        const [[sizeRow]] = await conn.query(`
          SELECT assigned_pieces, completed_pieces
          FROM size_assignments
          WHERE id = ?
        `, [sizeAssignmentId]);

        if (!sizeRow) {
          throw new Error(`Size assignment ID ${sizeAssignmentId} not found.`);
        }

        // Cannot exceed assigned
        if (completedPieces > sizeRow.assigned_pieces) {
          throw new Error(`Cannot confirm more than assigned in size_assignment_id ${sizeAssignmentId}.`);
        }

        // Possibly add to existing completed?
        const newCompleted = Math.min(
          sizeRow.assigned_pieces,
          sizeRow.completed_pieces + completedPieces
        );

        await conn.query(`
          UPDATE size_assignments
          SET completed_pieces = ?,
              status = CASE 
                WHEN ? >= assigned_pieces THEN 'completed'
                ELSE 'in_progress'
              END
          WHERE id = ?
        `, [newCompleted, newCompleted, sizeAssignmentId]);

        sumJustConfirmed += (completedPieces);
      }

      // 2) Insert department confirmation record
      await conn.query(`
        INSERT INTO department_confirmations
          (lot_assignment_id, confirmed_by_user_id, confirmed_pieces)
        VALUES
          (?, ?, ?)
      `, [assignment_id, userId, sumJustConfirmed]);

      // optional: store remarks if you want a remarks column
      if (remarks) {
        await conn.query(`
          UPDATE department_confirmations
          SET confirmed_at = NOW()
          WHERE lot_assignment_id = ?
          ORDER BY id DESC
          LIMIT 1
        `, [assignment_id]);
        // or if you want to store remarks in a separate column, you'd add that logic here
      }

      // 3) Check if entire assignment is completed (size-wise)
      const [[countRow]] = await conn.query(`
        SELECT 
          SUM(sa.assigned_pieces) AS total_assigned,
          SUM(sa.completed_pieces) AS total_completed
        FROM size_assignments sa
        WHERE sa.lot_assignment_id = ?
      `, [assignment_id]);

      let newStatus = 'in_progress';
      if (countRow.total_completed >= countRow.total_assigned) {
        newStatus = 'completed';
      }

      await conn.query(`
        UPDATE lot_assignments
        SET status = ?
        WHERE id = ?
      `, [newStatus, assignment_id]);

      await conn.commit();
      conn.release();

      req.flash('success', `Department pieces confirmed: ${sumJustConfirmed}`);
      return res.redirect('/department/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      throw transErr;
    }
  } catch (err) {
    console.error('Error in department/confirm:', err);
    req.flash('error', err.message || 'Failed to confirm pieces.');
    return res.redirect('/department/dashboard');
  }
});

module.exports = router;
