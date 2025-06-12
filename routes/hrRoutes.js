const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor, isOperator } = require('../middlewares/auth');

/*******************************************************************
 * Supervisor Employee Management
 *******************************************************************/

// GET /supervisor/employees - list employees & form
router.get('/supervisor/employees', isAuthenticated, isSupervisor, async (req, res) => {
  try {
    const [employees] = await pool.query(
      `SELECT e.*,
              (SELECT status FROM employee_status_history
                 WHERE employee_id = e.id
                 ORDER BY changed_at DESC LIMIT 1) AS current_status
         FROM employees e
        WHERE e.created_by = ?
        ORDER BY e.created_at DESC`,
      [req.session.user.id]
    );
    res.render('supervisorEmployees', {
      user: req.session.user,
      employees,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading employees:', err);
    req.flash('error', 'Failed to load employees.');
    res.redirect('/');
  }
});

// POST /supervisor/employees - create employee
router.post('/supervisor/employees', isAuthenticated, isSupervisor, async (req, res) => {
  const { punching_id, name, salary_type, salary_amount, phone, working_hours } = req.body;
  if (!punching_id || !name || !salary_type || !salary_amount || !working_hours) {
    req.flash('error', 'Missing required fields.');
    return res.redirect('/supervisor/employees');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO employees (
          punching_id,
          name,
          salary_type,
          salary_amount,
          working_hours,
          phone,
          is_active,
          created_at,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 1, NOW(), ?)`,
      [
        punching_id,
        name,
        salary_type,
        salary_amount,
        working_hours,
        phone || null,
        req.session.user.id
      ]
    );
    await conn.query(
      `INSERT INTO employee_status_history (employee_id, status, changed_at) VALUES (?, 1, NOW())`,
      [result.insertId]
    );
    await conn.commit();
    req.flash('success', 'Employee created.');
  } catch (err) {
    await conn.rollback();
    console.error('Error creating employee:', err);
    req.flash('error', 'Failed to create employee.');
  } finally {
    conn.release();
  }
  res.redirect('/supervisor/employees');
});

// POST /supervisor/employees/:id/toggle - activate/deactivate
router.post('/supervisor/employees/:id/toggle', isAuthenticated, isSupervisor, async (req, res) => {
  const employeeId = req.params.id;
  const action = req.body.action; // 'activate' or 'deactivate'
  const newStatus = action === 'activate' ? 1 : 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`UPDATE employees SET is_active=? WHERE id=?`, [newStatus, employeeId]);
    await conn.query(`INSERT INTO employee_status_history (employee_id, status, changed_at) VALUES (?, ?, NOW())`, [employeeId, newStatus]);
    await conn.commit();
    req.flash('success', 'Status updated.');
  } catch (err) {
    await conn.rollback();
    console.error('Error toggling employee:', err);
    req.flash('error', 'Failed to update status.');
  } finally {
    conn.release();
  }
  res.redirect('/supervisor/employees');
});

// GET /supervisor/employee-hours - monthly hours summary
router.get('/supervisor/employee-hours', isAuthenticated, isSupervisor, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.id,
              e.punching_id,
              e.name,
              e.working_hours,
              IFNULL(SUM(h.hours_worked), 0) AS hours_worked,
              IFNULL(SUM(h.hours_worked), 0) - e.working_hours AS overtime
         FROM employees e
         LEFT JOIN employee_daily_hours h ON h.employee_id = e.id
           AND MONTH(h.work_date) = MONTH(CURRENT_DATE())
           AND YEAR(h.work_date) = YEAR(CURRENT_DATE())
        WHERE e.created_by = ?
         GROUP BY e.id
         ORDER BY e.name`,
      [req.session.user.id]
    );
    res.render('supervisorEmployeeHours', {
      user: req.session.user,
      data: rows,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading employee hours:', err);
    req.flash('error', 'Failed to load employee hours.');
    res.redirect('/supervisor/employees');
  }
});

/*******************************************************************
 * Operator Department & Supervisor Management
 *******************************************************************/

// GET /operator/departments - list departments and supervisors
router.get('/operator/departments', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [departments] = await pool.query(
      `SELECT d.*, u.username AS supervisor_name
       FROM departments d
       LEFT JOIN department_supervisors ds ON ds.department_id=d.id AND ds.is_active=1
       LEFT JOIN users u ON ds.supervisor_user_id=u.id
       ORDER BY d.created_at DESC`
    );
    const [supervisors] = await pool.query(
      `SELECT u.id,
              u.username,
              IFNULL(SUM(e.salary_amount), 0) AS total_salary,
              COUNT(e.id) AS employee_count
         FROM users u
         LEFT JOIN employees e ON e.created_by = u.id AND e.is_active = 1
        WHERE u.role_id IN (SELECT id FROM roles WHERE name='supervisor')
          AND u.is_active = 1
        GROUP BY u.id
        ORDER BY u.username`
    );
    const [employees] = await pool.query(
      `SELECT e.id, e.punching_id, e.name, u.username AS supervisor_name
         FROM employees e
         LEFT JOIN users u ON e.created_by = u.id
        ORDER BY e.created_at DESC`
    );
    res.render('operatorDepartments', {
      user: req.session.user,
      departments,
      supervisors,
      employees,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading departments:', err);
    req.flash('error', 'Failed to load departments.');
    res.redirect('/');
  }
});

// POST /operator/departments/create - create new department
router.post('/operator/departments/create', isAuthenticated, isOperator, async (req, res) => {
  const { name, supervisor_id } = req.body;
  if (!name) {
    req.flash('error', 'Department name required.');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      `INSERT INTO departments (name, created_at) VALUES (?, NOW())`,
      [name]
    );
    if (supervisor_id) {
      await conn.query(
        `INSERT INTO department_supervisors (department_id, supervisor_user_id, is_active, assigned_at) VALUES (?, ?, 1, NOW())`,
        [result.insertId, supervisor_id]
      );
    }
    await conn.commit();
    req.flash('success', 'Department created.');
  } catch (err) {
    await conn.rollback();
    console.error('Error creating department:', err);
    req.flash('error', 'Failed to create department.');
  } finally {
    conn.release();
  }
  res.redirect('/operator/departments');
});

// POST /operator/departments/change-supervisor
router.post('/operator/departments/change-supervisor', isAuthenticated, isOperator, async (req, res) => {
  const { department_id, supervisor_id } = req.body;
  if (!department_id || !supervisor_id) {
    req.flash('error', 'Missing parameters.');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // deactivate current
    await conn.query(`UPDATE department_supervisors SET is_active=0, deactivated_at=NOW() WHERE department_id=? AND is_active=1`, [department_id]);
    // assign new
    await conn.query(`INSERT INTO department_supervisors (department_id, supervisor_user_id, is_active, assigned_at) VALUES (?, ?, 1, NOW())`, [department_id, supervisor_id]);
    await conn.commit();
    req.flash('success', 'Supervisor updated.');
  } catch (err) {
    await conn.rollback();
    console.error('Error updating supervisor:', err);
    req.flash('error', 'Failed to update supervisor.');
  } finally {
    conn.release();
  }
  res.redirect('/operator/departments');
});

// POST /operator/supervisor/:id/toggle - activate/inactivate supervisor user
router.post('/operator/supervisor/:id/toggle', isAuthenticated, isOperator, async (req, res) => {
  const supervisorId = req.params.id;
  const action = req.body.action;
  const status = action === 'activate' ? 1 : 0;
  try {
    await pool.query(`UPDATE users SET is_active=? WHERE id=?`, [status, supervisorId]);
    req.flash('success', 'Supervisor status updated.');
  } catch (err) {
    console.error('Error toggling supervisor:', err);
    req.flash('error', 'Failed to update supervisor status.');
  }
  res.redirect('/operator/departments');
});

// POST /operator/employees/:id/change-supervisor - reassign employee creator
router.post('/operator/employees/:id/change-supervisor', isAuthenticated, isOperator, async (req, res) => {
  const employeeId = req.params.id;
  const { supervisor_id } = req.body;
  if (!supervisor_id) {
    req.flash('error', 'Missing supervisor.');
    return res.redirect('/operator/departments');
  }
  try {
    await pool.query('UPDATE employees SET created_by=? WHERE id=?', [supervisor_id, employeeId]);
    req.flash('success', 'Employee supervisor updated.');
  } catch (err) {
    console.error('Error updating employee supervisor:', err);
    req.flash('error', 'Failed to update employee supervisor.');
  }
  res.redirect('/operator/departments');
});

module.exports = router;
