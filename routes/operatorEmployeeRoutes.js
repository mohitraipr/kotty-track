const express = require('express');
const router = express.Router();
const moment = require('moment');
const { pool } = require('../config/db');
const { calculateSalaryForMonth } = require('../helpers/salaryCalculator');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// List all supervisors
router.get('/supervisors', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id, u.name, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
       WHERE r.name = 'supervisor'
       ORDER BY u.username`);
    res.render('operatorSupervisors', { user: req.session.user, supervisors: rows });
  } catch (err) {
    console.error('Error loading supervisors:', err);
    req.flash('error', 'Failed to load supervisors');
    res.redirect('/operator/dashboard');
  }
});

// List employees for a supervisor
router.get('/supervisors/:id/employees', isAuthenticated, isOperator, async (req, res) => {
  const supId = req.params.id;
  try {
    const [[supervisor]] = await pool.query('SELECT id, username FROM users WHERE id = ? AND role_id IN (SELECT id FROM roles WHERE name = "supervisor")', [supId]);
    if (!supervisor) {
      req.flash('error', 'Supervisor not found');
      return res.redirect('/operator/supervisors');
    }
    const [employees] = await pool.query('SELECT * FROM employees WHERE supervisor_id = ?', [supId]);
    res.render('operatorSupervisorEmployees', { user: req.session.user, supervisor, employees });
  } catch (err) {
    console.error('Error loading employees:', err);
    req.flash('error', 'Failed to load employees');
    res.redirect('/operator/supervisors');
  }
});

// Form to edit attendance for a specific date
router.get('/employees/:id/edit', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.params.id;
  const date = req.query.date;
  if (!date) {
    req.flash('error', 'Date is required');
    return res.redirect('back');
  }
  try {
    const [[emp]] = await pool.query('SELECT id, name, supervisor_id FROM employees WHERE id = ?', [empId]);
    if (!emp) {
      req.flash('error', 'Employee not found');
      return res.redirect('/operator/supervisors');
    }
    const [[attendance]] = await pool.query('SELECT * FROM employee_attendance WHERE employee_id = ? AND date = ?', [empId, date]);
    const [logRows] = await pool.query('SELECT COUNT(*) AS cnt FROM attendance_edit_logs WHERE employee_id = ?', [empId]);
    const editCount = logRows[0].cnt;
    res.render('operatorEditAttendance', { user: req.session.user, employee: emp, date, attendance, editCount });
  } catch (err) {
    console.error('Error loading attendance:', err);
    req.flash('error', 'Failed to load attendance');
    res.redirect('back');
  }
});

// Update attendance
router.post('/employees/:id/edit', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.params.id;
  const { date, punch_in, punch_out } = req.body;
  if (!date) {
    req.flash('error', 'Date is required');
    return res.redirect('back');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[emp]] = await conn.query('SELECT supervisor_id FROM employees WHERE id = ?', [empId]);
    if (!emp) {
      await conn.rollback();
      req.flash('error', 'Employee not found');
      conn.release();
      return res.redirect('/operator/supervisors');
    }
    const supervisorId = emp.supervisor_id;

    const [logRows] = await conn.query('SELECT COUNT(*) AS cnt FROM attendance_edit_logs WHERE employee_id = ?', [empId]);
    if (logRows[0].cnt >= 3) {
      await conn.rollback();
      req.flash('error', 'Edit limit reached for this employee');
      conn.release();
      return res.redirect(`/operator/supervisors/${supervisorId}/employees`);
    }

    const [[att]] = await conn.query('SELECT id, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date = ?', [empId, date]);
    const newStatus = (punch_in && punch_out) ? 'present' : (punch_in || punch_out) ? 'one punch only' : 'absent';
    if (att) {
      await conn.query('UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = ? WHERE id = ?', [punch_in || null, punch_out || null, newStatus, att.id]);
      await conn.query(
        'INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [empId, date, att.punch_in, att.punch_out, punch_in || null, punch_out || null, req.session.user.id]
      );
    } else {
      await conn.query('INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status) VALUES (?, ?, ?, ?, ?)', [empId, date, punch_in || null, punch_out || null, newStatus]);
      await conn.query(
        'INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [empId, date, null, null, punch_in || null, punch_out || null, req.session.user.id]
      );
    }
    const month = moment(date).format('YYYY-MM');
    await calculateSalaryForMonth(conn, empId, month);
    await conn.commit();
    req.flash('success', 'Attendance updated');
    conn.release();
    res.redirect(`/operator/supervisors/${supervisorId}/employees`);
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error('Error updating attendance:', err);
    req.flash('error', 'Failed to update attendance');
    res.redirect('back');
  }
});

module.exports = router;
