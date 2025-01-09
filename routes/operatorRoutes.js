/*********************************************************************
 * routes/operatorRoutes.js
 *
 * No leftover logic; we pass the "completed" pieces from each dept
 * to the next dept. The uncompleted remain behind.
 *********************************************************************/
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * GET /operator/dashboard
 *  (A) Unconfirmed + Unassigned
 *  (B) Assigned
 *  (C) Confirmed but Unassigned
 */
router.get('/dashboard', isAuthenticated, isOperator, async (req, res) => {
  try {
    const operatorId = req.session.user.id;
    console.log('DEBUG GET /operator/dashboard => operatorId:', operatorId);

    // (A) Unconfirmed + Unassigned (no lot_assignments + is_confirmed=FALSE)
    const [unassignedRows] = await pool.query(`
      SELECT
        cl.id AS lot_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.remark,
        cl.total_pieces,
        cl.is_confirmed,
        cl.created_at,
        u.username AS created_by,
        cls.size_label,
        cls.total_pieces AS size_total_pieces
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
      LEFT JOIN lot_assignments la ON la.cutting_lot_id = cl.id
      WHERE la.id IS NULL
        AND cl.is_confirmed=FALSE
      ORDER BY cl.created_at DESC, cls.size_label ASC
    `);

    const unassignedMap = {};
    for (const row of unassignedRows) {
      if (!unassignedMap[row.lot_id]) {
        unassignedMap[row.lot_id] = {
          lot_id: row.lot_id,
          lot_no: row.lot_no,
          sku: row.sku,
          fabric_type: row.fabric_type,
          remark: row.remark,
          total_pieces: row.total_pieces,
          is_confirmed: row.is_confirmed,
          created_by: row.created_by,
          created_at: row.created_at,
          sizes: []
        };
      }
      unassignedMap[row.lot_id].sizes.push({
        size_label: row.size_label,
        size_total_pieces: row.size_total_pieces
      });
    }
    const unassignedLots = Object.values(unassignedMap);

    // (B) Assigned by operator
    // We'll show a "Completed" button so the operator can pass completed pieces onward
    const [assignedRows] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        cl.lot_no,
        la.assigned_pieces,
        la.target_day,
        la.status,
        la.assigned_at,
        u_to.username AS assigned_to,
        IFNULL(SUM(dc.confirmed_pieces), 0) AS total_confirmed_by_dept
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id = cl.id
      JOIN users u_to ON la.assigned_to_user_id = u_to.id
      LEFT JOIN department_confirmations dc ON dc.lot_assignment_id = la.id
      WHERE la.assigned_by_user_id=?
      GROUP BY la.id
      ORDER BY la.assigned_at DESC
    `, [operatorId]);

    // (C) Confirmed but unassigned
    const [confirmedButUnassigned] = await pool.query(`
      SELECT
        cl.id AS lot_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        cl.remark,
        cl.total_pieces,
        cl.is_confirmed,
        cl.created_at
      FROM cutting_lots cl
      LEFT JOIN lot_assignments la ON la.cutting_lot_id=cl.id
      WHERE la.id IS NULL
        AND cl.is_confirmed=TRUE
      ORDER BY cl.created_at DESC
    `);

    res.render('operatorDashboard', {
      user: req.session.user,
      unassignedLots,
      assignedAssignments: assignedRows,
      confirmedButUnassigned
    });
  } catch (err) {
    console.error('Error in GET /operator/dashboard:', err);
    req.flash('error', 'Failed to load Operator Dashboard.');
    return res.redirect('/');
  }
});

/**
 * POST /operator/confirm-cutting
 * Confirms a new lot (size by size).
 */
router.post('/confirm-cutting', isAuthenticated, isOperator, async (req, res) => {
  console.log('DEBUG POST /operator/confirm-cutting body=', req.body);

  try {
    const { lot_no, sizes } = req.body;
    if (!lot_no || !sizes) {
      throw new Error('Missing lot_no or sizes in confirm-cutting.');
    }

    const [[lotRow]] = await pool.query(`
      SELECT id, is_confirmed
      FROM cutting_lots
      WHERE lot_no=?
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

        // check if size_label valid
        const [[checkSZ]] = await conn.query(`
          SELECT cls.id
          FROM cutting_lot_sizes cls
          JOIN cutting_lots c ON cls.cutting_lot_id=c.id
          WHERE c.lot_no=? AND cls.size_label=?
        `, [lot_no, label]);
        if (!checkSZ) {
          throw new Error(`Size label ${label} not found in lot_no=${lot_no}`);
        }

        // update
        await conn.query(`
          UPDATE cutting_lot_sizes cls
          JOIN cutting_lots c ON cls.cutting_lot_id=c.id
          SET cls.total_pieces=?
          WHERE c.lot_no=? AND cls.size_label=?
        `, [actual, lot_no, label]);

        totalActual += actual;
      }

      // finalize
      await conn.query(`
        UPDATE cutting_lots
        SET total_pieces=?, is_confirmed=TRUE
        WHERE lot_no=?
      `, [totalActual, lot_no]);

      await conn.commit();
      conn.release();

      req.flash('success', `Cutting confirmed for lot_no=${lot_no}.`);
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in confirm-cutting transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error in POST /operator/confirm-cutting:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/**
 * POST /operator/assign-lot
 * For the "initial" assignment of a confirmed lot
 */
router.post('/assign-lot', isAuthenticated, isOperator, async (req, res) => {
  console.log('DEBUG POST /operator/assign-lot body=', req.body);

  try {
    const {
      lot_id,
      assigned_user_id,
      size_assignments,
      target_day
    } = req.body;

    if (!lot_id || !assigned_user_id || !size_assignments) {
      throw new Error('Missing data to assign lot.');
    }

    // sum up assigned
    let totalAssigned = 0;
    size_assignments.forEach(sz => {
      totalAssigned += parseInt(sz.assign_pieces, 10) || 0;
    });

    const operatorId = req.session.user.id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // create lot_assignments row
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
        target_day || '2099-12-31'
      ]);
      const newAssignmentId = laRes.insertId;

      // create size_assignments
      for (const sz of size_assignments) {
        const label = sz.size_label;
        const pcs = parseInt(sz.assign_pieces, 10) || 0;

        // check existence in cutting_lot_sizes
        const [[szCheck]] = await conn.query(`
          SELECT id
          FROM cutting_lot_sizes
          WHERE cutting_lot_id=? AND size_label=?
        `, [lot_id, label]);
        if (!szCheck) {
          throw new Error(`Size ${label} invalid for cutting_lot_id=${lot_id}`);
        }

        await conn.query(`
          INSERT INTO size_assignments
            (lot_assignment_id, size_label, assigned_pieces, completed_pieces, status)
          VALUES
            (?, ?, ?, 0, 'assigned')
        `, [newAssignmentId, label, pcs]);
      }

      await conn.commit();
      conn.release();

      req.flash('success', 'Lot assigned to next department successfully.');
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in /assign-lot transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error in POST /assign-lot:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/**
 * GET /operator/completed/:assignmentId
 * Show how many pieces each size has "completed_pieces".
 * We'll pass those completed pieces forward to the next dept.
 */
router.get('/completed/:assignmentId', isAuthenticated, isOperator, async (req, res) => {
  console.log('DEBUG GET /operator/completed/:assignmentId ->', req.params.assignmentId);

  try {
    const assignmentId = parseInt(req.params.assignmentId, 10);
    if (isNaN(assignmentId)) {
      throw new Error('Invalid assignmentId param');
    }

    // fetch the assignment + lot info
    const [[asg]] = await pool.query(`
      SELECT
        la.id AS assignment_id,
        cl.lot_no,
        cl.sku,
        cl.fabric_type,
        la.assigned_pieces,
        la.status
      FROM lot_assignments la
      JOIN cutting_lots cl ON la.cutting_lot_id=cl.id
      WHERE la.id=?
    `, [assignmentId]);
    if (!asg) {
      req.flash('error', `No assignment found for ID=${assignmentId}`);
      return res.redirect('/operator/dashboard');
    }

    // fetch size_assignments
    const [sizes] = await pool.query(`
      SELECT
        id AS size_asg_id,
        size_label,
        assigned_pieces,
        completed_pieces
      FROM size_assignments
      WHERE lot_assignment_id=?
    `, [assignmentId]);

    // We'll build an EJS form that shows "completed_pieces" for each size
    // The operator can pass some or all of those completed to the next dept
    res.render('completedForm', {
      user: req.session.user,
      assignment: asg,
      sizes
    });
  } catch (err) {
    console.error('Error in GET /operator/completed:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/**
 * POST /operator/reassign-completed
 * The operator chooses how many of the "completed" pieces from each size
 * to pass on to the next dept. The "uncompleted" remain in the old assignment.
 */
router.post('/reassign-completed', isAuthenticated, isOperator, async (req, res) => {
  console.log('DEBUG POST /operator/reassign-completed =>', req.body);

  try {
    const {
      assignment_id,
      next_dept_user_id,
      target_day,
      completed_sizes
    } = req.body;

    if (!assignment_id || !next_dept_user_id || !completed_sizes) {
      throw new Error('Missing data to reassign completed pieces.');
    }

    // fetch old assignment to see cutting_lot_id
    const [[oldAsg]] = await pool.query(`
      SELECT la.cutting_lot_id
      FROM lot_assignments la
      WHERE la.id=?
    `, [assignment_id]);
    if (!oldAsg) {
      throw new Error(`Assignment not found for ID=${assignment_id}`);
    }

    // sum up the new dept assignment
    let sumCompleted = 0;
    for (const c of completed_sizes) {
      sumCompleted += parseInt(c.completed_to_pass, 10) || 0;
    }

    const operatorId = req.session.user.id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1) create new lot_assignments row
      const [newAsg] = await conn.query(`
        INSERT INTO lot_assignments
          (cutting_lot_id, assigned_by_user_id, assigned_to_user_id, assigned_pieces, target_day, status)
        VALUES
          (?, ?, ?, ?, ?, 'assigned')
      `, [
        oldAsg.cutting_lot_id,
        operatorId,
        next_dept_user_id,
        sumCompleted,
        target_day || '2099-12-31'
      ]);
      const newAsgId = newAsg.insertId;

      // 2) create size_assignments for the "completed" pieces
      for (const c of completed_sizes) {
        const label = c.size_label;
        const passCount = parseInt(c.completed_to_pass, 10) || 0;
        if (passCount > 0) {
          // insert a row for the new assignment, assigned_pieces=passCount, completed_pieces=0
          await conn.query(`
            INSERT INTO size_assignments
              (lot_assignment_id, size_label, assigned_pieces, completed_pieces, status)
            VALUES
              (?, ?, ?, 0, 'assigned')
          `, [newAsgId, label, passCount]);
        }
      }

      await conn.commit();
      conn.release();

      req.flash('success', `Reassigned ${sumCompleted} completed pieces to next department user ID=${next_dept_user_id}.`);
      return res.redirect('/operator/dashboard');
    } catch (transErr) {
      await conn.rollback();
      conn.release();
      console.error('Error in /reassign-completed transaction:', transErr);
      req.flash('error', transErr.message);
      return res.redirect('/operator/dashboard');
    }
  } catch (err) {
    console.error('Error in POST /operator/reassign-completed:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/**
 * GET /operator/assign-lot-form/:lotNo
 * (For initially confirmed but unassigned lots)
 */
router.get('/assign-lot-form/:lotNo', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    if (!lotNo) throw new Error('No lotNo param');

    const [[lot]] = await pool.query(`
      SELECT id AS lot_id, lot_no, sku, fabric_type, is_confirmed, total_pieces
      FROM cutting_lots
      WHERE lot_no=?
    `, [lotNo]);
    if (!lot) {
      req.flash('error', `Lot not found for lot_no=${lotNo}`);
      return res.redirect('/operator/dashboard');
    }
    if (!lot.is_confirmed) {
      req.flash('error', `Lot ${lotNo} not confirmed yet.`);
      return res.redirect('/operator/dashboard');
    }

    // fetch sizes
    const [sizeRows] = await pool.query(`
      SELECT size_label, total_pieces
      FROM cutting_lot_sizes
      WHERE cutting_lot_id=?
    `, [lot.lot_id]);

    // next roles, if needed
    const [nextRoles] = await pool.query(`
      SELECT id, name
      FROM roles
      WHERE name IN ('stitching_master','checking','washing','finishing','marketplace')
      ORDER BY name
    `);

    res.render('assignLotForm', {
      user: req.session.user,
      lot,
      sizes: sizeRows,
      nextRoles
    });
  } catch (err) {
    console.error('Error in GET /operator/assign-lot-form:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

/**
 * GET /operator/get-dept-users
 * Ajax route for next dept user
 */
router.get('/get-dept-users', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { roleId } = req.query;
    if (!roleId) {
      return res.status(400).json({ error: 'Missing roleId param' });
    }

    const [users] = await pool.query(`
      SELECT id, username
      FROM users
      WHERE role_id=?
        AND is_active=TRUE
      ORDER BY username
    `, [roleId]);

    return res.json({ users });
  } catch (err) {
    console.error('Error in GET /operator/get-dept-users:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * (Optional) GET /operator/pendency/:lotNo
 * Summarize departmental usage for each assignment if you want a chain overview
 */
router.get('/pendency/:lotNo', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lotNo = req.params.lotNo;
    if (!lotNo) {
      req.flash('error', 'No lotNo param');
      return res.redirect('/operator/dashboard');
    }

    // fetch the lot
    const [[lotRow]] = await pool.query(`
      SELECT id AS lot_id, lot_no, sku, fabric_type, is_confirmed, total_pieces
      FROM cutting_lots
      WHERE lot_no=?
    `, [lotNo]);
    if (!lotRow) {
      req.flash('error', `Lot not found: ${lotNo}`);
      return res.redirect('/operator/dashboard');
    }

    // fetch assignments + partial confirmations
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
      JOIN cutting_lots cl ON la.cutting_lot_id=cl.id
      JOIN users u ON la.assigned_to_user_id=u.id
      JOIN roles r ON u.role_id=r.id
      LEFT JOIN department_confirmations dc ON dc.lot_assignment_id=la.id
      WHERE cl.id=?
      GROUP BY la.id
      ORDER BY la.assigned_at
    `, [lotRow.lot_id]);

    res.render('pendency', {
      user: req.session.user,
      lot: lotRow,
      deptAssignments: deptRows
    });
  } catch (err) {
    console.error('Error in GET /operator/pendency:', err);
    req.flash('error', err.message);
    return res.redirect('/operator/dashboard');
  }
});

module.exports = router;
