const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor } = require('../middlewares/auth');
const moment = require('moment');
const { calculateSalaryForMonth, effectiveHours } = require('../helpers/salaryCalculator');

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

    const totalEmployees = employees.length;
    const avgSalary = totalEmployees
      ? (
          employees.reduce((s, e) => s + parseFloat(e.salary || 0), 0) /
          totalEmployees
        ).toFixed(2)
      : 0;


    const selectedMonth = req.query.month || moment().format('YYYY-MM');
    const monthStart = moment(selectedMonth + '-01');
    const months = [];
    for (let i = 0; i < 6; i++) {
      const m = moment().subtract(i, 'months');
      months.push({ value: m.format('YYYY-MM'), label: m.format('MMM YYYY') });
    }

  let topEmployees = [];
  let presentCount = 0;
  let paidCount = 0;
    if (totalEmployees && monthStart.isValid()) {
      const startDate = monthStart.format('YYYY-MM-DD');
      const endDate = monthStart.endOf('month').format('YYYY-MM-DD');
      const ids = employees.map(e => e.id);
      const [att] = await pool.query(
        `SELECT employee_id, punch_in, punch_out
           FROM employee_attendance
          WHERE employee_id IN (?) AND date BETWEEN ? AND ?`,
        [ids, startDate, endDate]
      );
      const map = new Map();
      employees.forEach(e => {
        map.set(e.id, { name: e.name, diff: 0, emp: e });
      });
      att.forEach(a => {
        const item = map.get(a.employee_id);
        if (!item) return;
        const emp = item.emp;
        if (
          emp.salary_type !== 'monthly' ||
          !a.punch_in ||
          !a.punch_out ||
          !emp.allotted_hours
        )
          return;
        const hrs = effectiveHours(a.punch_in, a.punch_out, 'monthly');
        const diff = hrs - parseFloat(emp.allotted_hours || 0);
        item.diff += diff;
      });
      topEmployees = Array.from(map.values())
        .filter(i => i.diff > 0)
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 3)
        .map(i => i.name);

      const [presentRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT employee_id
             FROM employee_attendance
            WHERE employee_id IN (?)
              AND date BETWEEN ? AND ?
              AND status = 'present'
            GROUP BY employee_id
           HAVING COUNT(*) >= 3
         ) AS t`,
        [ids, startDate, endDate]
      );
      presentCount = presentRows[0]?.cnt || 0;

      const [salaryRows] = await pool.query(
        'SELECT COUNT(*) AS cnt FROM employee_salaries WHERE employee_id IN (?) AND month = ? AND net > 0',
        [ids, selectedMonth]
      );
      paidCount = salaryRows[0]?.cnt || 0;
    }

    res.render('supervisorEmployees', {
      user: req.session.user,
      department,
      employees,
      totalEmployees,
      avgSalary,
      topEmployees,
      presentCount,
      paidCount,
      months,
      selectedMonth
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

    let leaves = [];
    if (employee.salary_type !== 'dihadi') {
      const [leaveRows] = await pool.query(
        'SELECT * FROM employee_leaves WHERE employee_id = ? ORDER BY leave_date DESC',
        [empId]
      );
      leaves = leaveRows;
    }
    const [debits] = await pool.query(
      'SELECT * FROM employee_debits WHERE employee_id = ? ORDER BY added_at DESC',
      [empId]
    );
    const [advances] = await pool.query(
      'SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY added_at DESC',
      [empId]
    );

    let leaveBalance = 'N/A';
    if (employee.salary_type !== 'dihadi') {
      const monthsWorked = moment().diff(moment(employee.date_of_joining), 'months');
      const earned = monthsWorked >= 3 ? (monthsWorked - 2) * 1.5 : 0;
      // Separate Sunday credit days so they increase the balance instead of
      // reducing it. Credits are inserted with remark "Sunday Credit" during
      // salary processing.
      let creditDays = 0;
      let leaveDays = 0;
      leaves.forEach(l => {
        const days = parseFloat(l.days);
        if ((l.remark || '').toLowerCase() === 'sunday credit') {
          creditDays += days;
        } else {
          leaveDays += days;
        }
      });
      leaveBalance = (earned + creditDays - leaveDays).toFixed(2);
    }

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
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT salary_type FROM employees WHERE id = ? AND supervisor_id = ?',
      [empId, req.session.user.id]
    );
    if (!rows.length) {
      await conn.rollback();
      req.flash('error', 'Employee not found');
      return res.redirect('/supervisor/employees');
    }
    if (rows[0].salary_type === 'dihadi') {
      await conn.rollback();
      req.flash('error', 'Dihadi employees cannot record leaves');
      return res.redirect(`/supervisor/employees/${empId}/details`);
    }
    await conn.query(
      'INSERT INTO employee_leaves (employee_id, leave_date, days, remark) VALUES (?, ?, ?, ?)',
      [empId, leave_date, days, remark]
    );
    const month = moment(leave_date).format('YYYY-MM');
    await calculateSalaryForMonth(conn, empId, month);
    await conn.commit();
    req.flash('success', 'Leave recorded');
    res.redirect(`/supervisor/employees/${empId}/details`);
  } catch (err) {
    await conn.rollback();
    console.error('Error recording leave:', err);
    req.flash('error', 'Failed to record leave');
    res.redirect(`/supervisor/employees/${empId}/details`);
  } finally {
    conn.release();
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
