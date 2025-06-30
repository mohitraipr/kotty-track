const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor } = require('../middlewares/auth');
const moment = require('moment');

// Show employee dashboard for a supervisor
router.get('/employees', isAuthenticated, isSupervisor, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const [deptRows] = await pool.query(
      `SELECT d.name FROM departments d
       JOIN department_supervisors ds ON ds.department_id = d.id
       WHERE ds.user_id = ? LIMIT 1`,
      [userId]
    );
    const department = deptRows.length ? deptRows[0].name : 'N/A';

    const [employees] = await pool.query(
      'SELECT * FROM employees WHERE supervisor_id = ?',
      [userId]
    );

    res.render('supervisorEmployees', {
      user: req.session.user,
      department,
      employees
    });
  } catch (err) {
    console.error('Error loading employees:', err);
    req.flash('error', 'Failed to load employees');
    res.redirect('/dashboard');
  }
});

// Create a new employee for the logged in supervisor
router.post('/employees', isAuthenticated, isSupervisor, async (req, res) => {
  const { punching_id, name, designation, phone_number, salary, salary_type, allotted_hours, paid_sunday_allowance, date_of_joining } = req.body;
  try {
    await pool.query(
      `INSERT INTO employees
        (supervisor_id, punching_id, name, designation, phone_number, salary, salary_type, allotted_hours, paid_sunday_allowance, date_of_joining, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.session.user.id, punching_id, name, designation, phone_number, salary, salary_type, allotted_hours, paid_sunday_allowance || 0, date_of_joining]
    );
    req.flash('success', 'Employee created');
    res.redirect('/supervisor/employees');
  } catch (err) {
    console.error('Error creating employee:', err);
    req.flash('error', 'Failed to create employee');
    res.redirect('/supervisor/employees');
  }
});

// Toggle employee active status
router.post('/employees/:id/toggle', isAuthenticated, isSupervisor, async (req, res) => {
  const id = req.params.id;
  try {
    await pool.query(
      `UPDATE employees
          SET is_active = NOT is_active
        WHERE id = ? AND supervisor_id = ?`,
      [id, req.session.user.id]
    );
    req.flash('success', 'Employee status updated');
    res.redirect('/supervisor/employees');
  } catch (err) {
    console.error('Error toggling employee:', err);
    req.flash('error', 'Failed to update employee');
    res.redirect('/supervisor/employees');
  }
});

// View an employee's leaves, debits and advances
router.get('/employees/:id/details', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  try {
    const [empRows] = await pool.query(
      'SELECT * FROM employees WHERE id = ? AND supervisor_id = ?',
      [empId, req.session.user.id]
    );
    if (!empRows.length) {
      req.flash('error', 'Employee not found');
      return res.redirect('/supervisor/employees');
    }
    const employee = empRows[0];

    const [leaves] = await pool.query(
      'SELECT * FROM employee_leaves WHERE employee_id = ? ORDER BY leave_date DESC',
      [empId]
    );
    const [debits] = await pool.query(
      'SELECT * FROM employee_debits WHERE employee_id = ? ORDER BY added_at DESC',
      [empId]
    );
    const [advances] = await pool.query(
      'SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY added_at DESC',
      [empId]
    );

    const monthsWorked = moment().diff(moment(employee.date_of_joining), 'months');
    const earned = monthsWorked >= 3 ? (monthsWorked - 2) * 1.5 : 0;
    const leavesTaken = leaves.reduce((sum, l) => sum + parseFloat(l.days), 0);
    const leaveBalance = (earned - leavesTaken).toFixed(2);

    res.render('employeeDetails', {
      user: req.session.user,
      employee,
      leaves,
      debits,
      advances,
      leaveBalance
    });
  } catch (err) {
    console.error('Error loading employee details:', err);
    req.flash('error', 'Failed to load employee details');
    res.redirect('/supervisor/employees');
  }
});

// Record a leave for an employee
router.post('/employees/:id/leaves', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const { leave_date, days, remark } = req.body;
  try {
    await pool.query(
      'INSERT INTO employee_leaves (employee_id, leave_date, days, remark) VALUES (?, ?, ?, ?)',
      [empId, leave_date, days, remark]
    );
    req.flash('success', 'Leave recorded');
    res.redirect(`/supervisor/employees/${empId}/details`);
  } catch (err) {
    console.error('Error recording leave:', err);
    req.flash('error', 'Failed to record leave');
    res.redirect(`/supervisor/employees/${empId}/details`);
  }
});

// Record a debit for an employee
router.post('/employees/:id/debits', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const { amount, reason } = req.body;
  try {
    await pool.query(
      'INSERT INTO employee_debits (employee_id, amount, reason) VALUES (?, ?, ?)',
      [empId, amount, reason]
    );
    req.flash('success', 'Debit recorded');
    res.redirect(`/supervisor/employees/${empId}/details`);
  } catch (err) {
    console.error('Error recording debit:', err);
    req.flash('error', 'Failed to record debit');
    res.redirect(`/supervisor/employees/${empId}/details`);
  }
});

// Record an advance for an employee
router.post('/employees/:id/advances', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const { amount, reason } = req.body;
  try {
    await pool.query(
      'INSERT INTO employee_advances (employee_id, amount, reason) VALUES (?, ?, ?)',
      [empId, amount, reason]
    );
    req.flash('success', 'Advance recorded');
    res.redirect(`/supervisor/employees/${empId}/details`);
  } catch (err) {
    console.error('Error recording advance:', err);
    req.flash('error', 'Failed to record advance');
    res.redirect(`/supervisor/employees/${empId}/details`);
  }
});

module.exports = router;
