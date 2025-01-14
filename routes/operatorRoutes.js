/*********************************************************************
 * routes/operatorRoutes.js
 *
 * Features:
 * 1) Operator Dashboard (fancy UI)
 * 2) Confirm Cutting
 * 3) First-time assignment => /assign-lot-form/:lotNo + POST /assign-lot
 * 4) Partial pass leftover => /pass-lot/:assignmentId + POST /pass-lot
 * 5) target_day defaults to '2099-12-31' if not provided
 *********************************************************************/

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db'); // Ensure your DB config is correct
const { isAuthenticated, isOperator } = require('../middlewares/auth'); // Ensure these middleware functions are correctly implemented

// Optional: Define department flows
const departmentFlow = {
  denim: ['stitching_master', 'washing', 'finishing', 'marketplace'],
  non_denim: ['stitching_master', 'finishing', 'marketplace']
};

// Helper function to get the next department role
function getNextDept(flowType, currentRoleName) {
  const flow = departmentFlow[flowType] || [];
  const idx = flow.indexOf(currentRoleName);
  if (idx === -1 || idx >= flow.length - 1) return null;
  return flow[idx + 1];
}

/*-------------------------------------------------------------------
  GET /operator/dashboard
-------------------------------------------------------------------*/
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    const operatorId = req.session.user.id;

    // (A) Unconfirmed + Unassigned
    const [unassignedRows] = await pool.query(`
      SELECT
        cl.id AS lot_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        cl.total_pieces,
        cl.is_confirmed,
        cls.size_label,
        cls.total_pieces AS size_total_pieces,
        u.username AS created_by
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
      LEFT JOIN lot_assignments la ON la.cutting_lot_id = cl.id
      WHERE la.id IS NULL
        AND cl.is_confirmed = FALSE
      ORDER BY cl.created_at DESC, cls.size_label ASC
    `);

    // Organize unassigned lots by lot_id
    const unassignedMap = {};
    unassignedRows.forEach(row => {
      if (!unassignedMap[row.lot_id]) {
        unassignedMap[row.lot_id] = {
          lot_id: row.lot_id,
          lot_no: row.lot_no,
          sku: row.sku,
          fabric_type: row.fabric_type,
          flow_type: row.flow_type,
          total_pieces: row.total_pieces,
          is_confirmed: row.is_confirmed,
          created_by: row.created_by,
          sizes: []
        };
      }
      unassignedMap[row.lot_id].sizes.push({
        size_label: row.size_label,
        size_total_pieces: row.size_total_pieces
      });
    });
    const unassignedLots = Object.values(unassignedMap);

    // (B) Pending Operator Verification
    const [pendingVerifyRows] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        la.status,
        la.assigned_at,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        u.username AS dept_user,
        r.name AS dept_role
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u ON la.assigned_to_user_id = u.id
      JOIN roles r ON u.role_id = r.id
      WHERE la.status = 'dept_submitted'
        AND la.assigned_by_user_id = ?
      ORDER BY la.assigned_at DESC
    `, [operatorId]);

    // (C) Assigned (In Progress)
    const [assignedRows] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        la.assigned_pieces,
        la.status,
        la.assigned_at,
        u.username AS assigned_to,
        (
          SELECT IFNULL(SUM(dc.confirmed_pieces), 0)
          FROM department_confirmations dc
          WHERE dc.lot_assignment_id = la.id
        ) AS total_confirmed_by_dept
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u ON la.assigned_to_user_id = u.id
      WHERE la.assigned_by_user_id = ?
        AND la.status NOT IN ('dept_submitted', 'completed')
      ORDER BY la.assigned_at DESC
    `, [operatorId]);

    // (D) Confirmed but Unassigned
    const [confirmedButUnassigned] = await pool.query(`
      SELECT
        cl.id AS lot_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        cl.total_pieces,
        cl.is_confirmed
      FROM cutting_lots cl
      LEFT JOIN lot_assignments la ON la.cutting_lot_id = cl.id
      WHERE la.id IS NULL
        AND cl.is_confirmed = TRUE
      ORDER BY cl.created_at DESC
    `);

    res.render('operatorDashboard', {
      user: req.session.user,
      unassignedLots,
      pendingVerifications: pendingVerifyRows,
      assignedAssignments: assignedRows,
      confirmedButUnassigned
    });
  } catch (err) {
    console.error('Error GET /operator/dashboard:', err);
    req.flash('error', 'Failed to load Operator Dashboard.');
    return res.redirect('/');
  }
});

/*-------------------------------------------------------------------
  POST /operator/confirm-cutting
  For unconfirmed + unassigned lots => confirm actual pieces
-------------------------------------------------------------------*/
router.post('/confirm-cutting', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no, sizes } = req.body;
    if (!lot_no || !sizes || !Array.isArray(sizes)) {
      throw new Error('Missing lot_no or sizes in confirm-cutting.');
    }

    const [[lotRow]] = await pool.query(`
      SELECT id, is_confirmed, flow_type
      FROM cutting_lots
      WHERE lot_no = ?
    `, [lot_no]);

    if (!lotRow) {
      throw new Error(`Lot not found: ${lot_no}`);
    }

    if (lotRow.is_confirmed) {
      throw new Error(`Lot ${lot_no} already confirmed.`);
    }

    let totalActual = 0;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      for (const s of sizes) {
        const label = s.size_label;
        const actual = parseInt(s.actual_received, 10) || 0;

        // Verify the size exists
        const [[szCheck]] = await conn.query(`
          SELECT cls.id
          FROM cutting_lot_sizes cls
          JOIN cutting_lots c ON cls.cutting_lot_id = c.id
          WHERE c.lot_no = ? AND cls.size_label = ?
        `, [lot_no, label]);

        if (!szCheck) {
          throw new Error(`Size label ${label} not found in lot_no=${lot_no}`);
        }

        // Update the total_pieces for the size
        await conn.query(`
          UPDATE cutting_lot_sizes cls
          JOIN cutting_lots c ON cls.cutting_lot_id = c.id
          SET cls.total_pieces = ?
          WHERE c.lot_no = ? AND cls.size_label = ?
        `, [actual, lot_no, label]);

        totalActual += actual;
      }

      // Finalize the lot confirmation
      await conn.query(`
        UPDATE cutting_lots
        SET total_pieces = ?, is_confirmed = TRUE
        WHERE lot_no = ?
      `, [totalActual, lot_no]);

      await conn.commit();
      conn.release();

      req.flash('success', `Cutting confirmed for lot_no=${lot_no} (flow=${lotRow.flow_type}).`);
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in confirm-cutting transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error POST /operator/confirm-cutting:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  GET /operator/assign-lot-form/:lotNo
  For the first-time assignment of a confirmed but unassigned lot
-------------------------------------------------------------------*/
router.get('/assign-lot-form/:lotNo', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    if (!lotNo) throw new Error('No lotNo param');

    // Fetch the confirmed lot
    const [[lot]] = await pool.query(`
      SELECT id AS lot_id, lot_no, sku, fabric_type, flow_type, total_pieces, is_confirmed
      FROM cutting_lots
      WHERE lot_no = ?
    `, [lotNo]);

    if (!lot) {
      req.flash('error', `Lot not found: ${lotNo}`);
      return res.redirect('/operator/dashboard');
    }

    if (!lot.is_confirmed) {
      req.flash('error', `Lot ${lotNo} is not confirmed yet.`);
      return res.redirect('/operator/dashboard');
    }

    // Fetch sizes for the lot
    const [sizeRows] = await pool.query(`
      SELECT size_label, total_pieces
      FROM cutting_lot_sizes
      WHERE cutting_lot_id = ?
    `, [lot.lot_id]);

    // Fetch active department users
    const [deptUsers] = await pool.query(`
      SELECT u.id AS userId, u.username, r.name AS roleName
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name IN ('stitching_master', 'washing', 'finishing', 'marketplace')
        AND u.is_active = TRUE
      ORDER BY r.name, u.username
    `);

    res.render('assignLotForm', {
      user: req.session.user,
      lot,
      sizes: sizeRows,
      deptUsers
    });
  } catch (err) {
    console.error('Error GET /operator/assign-lot-form:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  POST /operator/assign-lot
  Handle the first-time assignment of a lot to a department user
-------------------------------------------------------------------*/
router.post('/assign-lot', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_id, assigned_user_id, size_assignments, target_day } = req.body;
    if (!lot_id || !assigned_user_id || !size_assignments || !Array.isArray(size_assignments)) {
      throw new Error('Missing data in assign-lot.');
    }

    // Calculate total assigned pieces
    let totalAssigned = 0;
    for (const sz of size_assignments) {
      const pcs = parseInt(sz.assign_pieces, 10) || 0;
      totalAssigned += pcs;
    }

    // Set default target_day if not provided
    const finalTargetDay = (target_day && target_day.trim() !== '') ? target_day : '2099-12-31';

    const operatorId = req.session.user.id;
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Create a new lot_assignment
      const [laRes] = await conn.query(`
        INSERT INTO lot_assignments
          (cutting_lot_id, assigned_by_user_id, assigned_to_user_id, assigned_pieces, target_day, status)
        VALUES
          (?, ?, ?, ?, ?, 'assigned')
      `, [
        lot_id,
        operatorId,
        assigned_user_id,
        totalAssigned,
        finalTargetDay
      ]);
      const newAssignmentId = laRes.insertId;

      // Create size_assignments
      for (const sz of size_assignments) {
        const label = sz.size_label;
        const pcs = parseInt(sz.assign_pieces, 10) || 0;
        if (pcs > 0) {
          await conn.query(`
            INSERT INTO size_assignments
              (lot_assignment_id, size_label, assigned_pieces, completed_pieces, status)
            VALUES
              (?, ?, ?, 0, 'assigned')
          `, [newAssignmentId, label, pcs]);
        }
      }

      await conn.commit();
      conn.release();

      req.flash('success', 'Lot assigned to department successfully.');
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in /assign-lot transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error POST /operator/assign-lot:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  GET /operator/pass-lot/:assignmentId
  Display form to pass partial leftovers to next department, including target_day
-------------------------------------------------------------------*/
router.get('/pass-lot/:assignmentId', isAuthenticated, isOperator, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.assignmentId, 10);
    if (isNaN(assignmentId)) {
      throw new Error('Invalid assignmentId param');
    }

    // Fetch old assignment details
    const [[asg]] = await pool.query(`
      SELECT la.id AS assignment_id,
             la.cutting_lot_id,
             la.assigned_pieces,
             la.status,
             la.assigned_at,
             cl.lot_no,
             cl.sku,
             cl.fabric_type,
             cl.flow_type,
             u.username AS dept_user,
             r.name AS dept_role
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u ON la.assigned_to_user_id = u.id
      JOIN roles r ON u.role_id = r.id
      WHERE la.id = ?
    `, [assignmentId]);

    if (!asg) {
      req.flash('error', `No assignment found for ID=${assignmentId}`);
      return res.redirect('/operator/dashboard');
    }

    // Fetch size assignments and calculate leftovers
    const [sizes] = await pool.query(`
      SELECT
        id AS size_asg_id,
        size_label,
        assigned_pieces,
        completed_pieces
      FROM size_assignments
      WHERE lot_assignment_id = ?
    `, [assignmentId]);

    sizes.forEach(sz => {
      sz.leftover = Math.max(0, sz.assigned_pieces - sz.completed_pieces);
    });

    // Fetch active department users for the next assignment
    const [deptUsers] = await pool.query(`
      SELECT u.id AS userId, u.username, r.name AS roleName
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name IN ('stitching_master', 'washing', 'finishing', 'marketplace')
        AND u.is_active = TRUE
      ORDER BY r.name, u.username
    `);

    res.render('passLotForm', {
      user: req.session.user,
      assignment: asg,
      sizes,
      deptUsers
    });
  } catch (err) {
    console.error('Error GET /operator/pass-lot:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  POST /operator/pass-lot
  Handle passing partial leftovers to the next department, including target_day
-------------------------------------------------------------------*/
router.post('/pass-lot', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { old_assignment_id, partialPass, next_dept_user_id, operator_remark, next_target_day } = req.body;
    if (!old_assignment_id || !partialPass || !Array.isArray(partialPass) || !next_dept_user_id) {
      throw new Error('Missing data to pass partial leftover.');
    }

    const oldAsgId = parseInt(old_assignment_id, 10);
    const nextUserId = parseInt(next_dept_user_id, 10);
    const finalTargetDay = (next_target_day && next_target_day.trim() !== '') ? next_target_day : '2099-12-31';

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Fetch old assignment details
      const [[oldAsg]] = await conn.query(`
        SELECT la.id, la.cutting_lot_id, la.assigned_pieces,
               u.role_id, r.name AS dept_role_name,
               cl.flow_type
        FROM lot_assignments la
        JOIN users u ON la.assigned_to_user_id = u.id
        JOIN roles r ON u.role_id = r.id
        JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
        WHERE la.id = ?
      `, [oldAsgId]);

      if (!oldAsg) {
        throw new Error(`Old assignment not found: ID=${oldAsgId}`);
      }

      // Calculate total pieces to pass
      let sumPassed = 0;
      for (const p of partialPass) {
        sumPassed += parseInt(p.pass_pieces, 10) || 0;
      }

      // Create new assignment for the next department with target_day
      const operatorId = req.session.user.id;
      const [newAsg] = await conn.query(`
        INSERT INTO lot_assignments
          (cutting_lot_id, assigned_by_user_id, assigned_to_user_id, assigned_pieces, target_day, status)
        VALUES
          (?, ?, ?, ?, ?, 'assigned')
      `, [
        oldAsg.cutting_lot_id,
        operatorId,
        nextUserId,
        sumPassed,
        finalTargetDay
      ]);
      const newAssignmentId = newAsg.insertId;

      // Create size_assignments for the new assignment
      for (const p of partialPass) {
        const passPcs = parseInt(p.pass_pieces, 10) || 0;
        if (passPcs > 0) {
          await conn.query(`
            INSERT INTO size_assignments
              (lot_assignment_id, size_label, assigned_pieces, completed_pieces, status)
            VALUES
              (?, ?, ?, 0, 'assigned')
          `, [newAssignmentId, p.size_label, passPcs]);
        }
      }

      // Optional: Log the partial pass
      if (sumPassed > 0) {
        await conn.query(`
          INSERT INTO department_confirmations
            (lot_assignment_id, confirmed_by_user_id, confirmed_pieces, remarks)
          VALUES
            (?, ?, ?, ?)
        `, [oldAsgId, operatorId, sumPassed, operator_remark || null]);
      }

      await conn.commit();
      conn.release();

      req.flash('success', `Passed ${sumPassed} pieces to next dept user=${nextUserId}. Remark=${operator_remark || 'none'}`);
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in POST /operator/pass-lot transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error POST /operator/pass-lot:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  GET /operator/verify/:assignmentId
  Display verification form for partial completions
-------------------------------------------------------------------*/
router.get('/verify/:assignmentId', isAuthenticated, isOperator, async (req, res) => {
  try {
    const assignmentId = parseInt(req.params.assignmentId, 10);
    if (isNaN(assignmentId)) {
      throw new Error('Invalid assignmentId param');
    }

    // Fetch assignment details
    const [[asg]] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        cl.id AS lot_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.flow_type,
        la.assigned_pieces,
        la.status,
        la.assigned_at,
        u.username AS dept_user,
        r.name AS dept_role
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u ON la.assigned_to_user_id = u.id
      JOIN roles r ON u.role_id = r.id
      WHERE la.id = ?
    `, [assignmentId]);

    if (!asg) {
      req.flash('error', `No assignment found for ID=${assignmentId}`);
      return res.redirect('/operator/dashboard');
    }

    // Fetch size assignments
    const [sizes] = await pool.query(`
      SELECT
        id AS size_asg_id,
        size_label,
        assigned_pieces,
        completed_pieces,
        status
      FROM size_assignments
      WHERE lot_assignment_id = ?
    `, [assignmentId]);

    res.render('verifyAssignment', {
      user: req.session.user,
      assignment: asg,
      sizes
    });
  } catch (err) {
    console.error('Error GET /operator/verify:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  POST /operator/verify
  Handle verification of partial completions
-------------------------------------------------------------------*/
router.post('/verify', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { assignment_id, sizeSubmissions, operator_remark } = req.body;
    if (!assignment_id || !sizeSubmissions || !Array.isArray(sizeSubmissions)) {
      throw new Error('Missing verify data.');
    }

    const assignmentId = parseInt(assignment_id, 10);
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      let sumConfirmedNow = 0;
      for (const sc of sizeSubmissions) {
        const sizeAsgId = parseInt(sc.size_asg_id, 10);
        const finalCompleted = parseInt(sc.final_completed, 10) || 0;

        // Fetch current size assignment
        const [[szRow]] = await conn.query(`
          SELECT assigned_pieces, completed_pieces
          FROM size_assignments
          WHERE id = ?
        `, [sizeAsgId]);

        if (!szRow) {
          throw new Error(`No size_assignments row for ID=${sizeAsgId}`);
        }

        const leftover = szRow.assigned_pieces - szRow.completed_pieces;
        const passThisTime = Math.min(leftover, finalCompleted);

        // Update completed_pieces
        const newTotal = szRow.completed_pieces + passThisTime;
        await conn.query(`
          UPDATE size_assignments
          SET completed_pieces = ?
          WHERE id = ?
        `, [newTotal, sizeAsgId]);

        // Log the confirmation
        await conn.query(`
          INSERT INTO department_confirmations
            (lot_assignment_id, confirmed_by_user_id, confirmed_pieces, remarks)
          VALUES
            (?, ?, ?, ?)
        `, [assignmentId, req.session.user.id, passThisTime, operator_remark || null]);

        sumConfirmedNow += passThisTime;
      }

      // Check if there are any leftovers
      const [[szStats]] = await conn.query(`
        SELECT
          SUM(assigned_pieces) AS sum_assigned,
          SUM(completed_pieces) AS sum_completed
        FROM size_assignments
        WHERE lot_assignment_id = ?
      `, [assignmentId]);

      const leftoverTotal = (szStats.sum_assigned || 0) - (szStats.sum_completed || 0);
      let newStatus = 'in_progress';
      if (leftoverTotal <= 0) {
        newStatus = 'completed';
      }

      // Update the assignment status
      await conn.query(`
        UPDATE lot_assignments
        SET status = ?
        WHERE id = ?
      `, [newStatus, assignmentId]);

      await conn.commit();
      conn.release();

      req.flash('success', `Partial verified: ${sumConfirmedNow}, leftover=${leftoverTotal}, remark=${operator_remark || 'none'}`);
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Transaction Error /operator/verify:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error POST /operator/verify:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/*-------------------------------------------------------------------
  GET /operator/pendency/:lotNo
  Display pendency summary for a specific lot
-------------------------------------------------------------------*/
router.get('/pendency/:lotNo', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    if (!lotNo) {
      req.flash('error', 'No lotNo param');
      return res.redirect('/operator/dashboard');
    }

    // Fetch lot details
    const [[lotRow]] = await pool.query(`
      SELECT id AS lot_id, lot_no, sku, fabric_type, flow_type, total_pieces, is_confirmed
      FROM cutting_lots
      WHERE lot_no = ?
    `, [lotNo]);

    if (!lotRow) {
      req.flash('error', `Lot not found: ${lotNo}`);
      return res.redirect('/operator/dashboard');
    }

    // Fetch department assignments related to the lot
    const [deptRows] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        la.assigned_pieces,
        la.status,
        la.assigned_at,
        u.username AS assigned_to_user,
        r.name AS assigned_to_role,
        IFNULL(SUM(dc.confirmed_pieces), 0) AS total_confirmed
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u ON la.assigned_to_user_id = u.id
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN department_confirmations dc ON dc.lot_assignment_id = la.id
      WHERE cl.id = ?
      GROUP BY la.id
      ORDER BY la.assigned_at
    `, [lotRow.lot_id]);

    res.render('pendency', {
      user: req.session.user,
      lot: lotRow,
      deptAssignments: deptRows
    });
  } catch (err) {
    console.error('Error GET /operator/pendency:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

module.exports = router;
