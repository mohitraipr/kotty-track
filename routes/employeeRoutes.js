const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor } = require('../middlewares/auth');
const moment = require('moment');
const { effectiveHours } = require('../helpers/salaryCalculator');
const { isValidAadhar } = require('../helpers/aadharValidator');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// simple in-memory cache for the dashboard
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const dashboardCache = new Map();

function getCache(key) {
  const entry = dashboardCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    dashboardCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  dashboardCache.set(key, { value, expiry: Date.now() + CACHE_TTL_MS });
}

// Show employee dashboard for a supervisor
router.get('/employees', isAuthenticated, isSupervisor, async (req, res) => {
  const userId = req.session.user.id;
  const selectedMonth = req.query.month || moment().format('YYYY-MM');
  const cacheKey = `emp-${userId}-${selectedMonth}`;

  const cached = getCache(cacheKey);
  if (cached) {
    return res.render('supervisorEmployees', { user: req.session.user, ...cached, selectedMonth });
  }

  try {
    const [deptResult, employeesResult] = await Promise.all([
      pool.query(
        `SELECT d.name FROM departments d
         JOIN department_supervisors ds ON ds.department_id = d.id
         WHERE ds.user_id = ? LIMIT 1`,
        [userId]
      ),
      pool.query('SELECT * FROM employees WHERE supervisor_id = ?', [userId])
    ]);

    const deptRows = deptResult[0];
    const employees = employeesResult[0];
    const department = deptRows.length ? deptRows[0].name : 'N/A';

    const totalEmployees = employees.length;
    const avgSalary = totalEmployees
      ? (
          employees.reduce((s, e) => s + parseFloat(e.salary || 0), 0) /
          totalEmployees
        ).toFixed(2)
      : 0;

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

      const [att, [presentRows], [salaryRows]] = await Promise.all([
        pool.query(
          `SELECT employee_id, punch_in, punch_out
             FROM employee_attendance
            WHERE employee_id IN (?) AND date BETWEEN ? AND ?`,
          [ids, startDate, endDate]
        ).then(r => r[0]),
        pool
          .query(
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
          )
          .then(r => r[0]),
        pool
          .query(
            'SELECT COUNT(*) AS cnt FROM employee_salaries WHERE employee_id IN (?) AND month = ? AND net > 0',
            [ids, selectedMonth]
          )
          .then(r => r[0])
      ]);

      const map = new Map();
      employees.forEach(e => {
        map.set(e.id, { name: e.name, diff: 0, emp: e });
      });
      presentCount = presentRows[0]?.cnt || 0;
      paidCount = salaryRows[0]?.cnt || 0;
    }

    const data = {
      department,
      employees,
      totalEmployees,
      avgSalary,
      topEmployees,
      presentCount,
      paidCount,
      months
    };
    setCache(cacheKey, data);

    res.render('supervisorEmployees', { user: req.session.user, ...data, selectedMonth });
  } catch (err) {
    console.error('Error loading employees:', err);
    req.flash('error', 'Failed to load employees');
    res.redirect('/dashboard');
  }
});

// Create a new employee for the logged in supervisor
router.post('/employees', isAuthenticated, isSupervisor, async (req, res) => {
  const { punching_id, name, designation, phone_number, aadhar_card_number, salary, salary_type, allotted_hours, paid_sunday_allowance, pay_sunday, leave_start_months, date_of_joining } = req.body;
  if (aadhar_card_number && !isValidAadhar(aadhar_card_number)) {
    req.flash('error', 'Aadhar number must be 12 digits');
    return res.redirect('/supervisor/employees');
  }
  try {
    await pool.query(
      `INSERT INTO employees
        (supervisor_id, punching_id, name, designation, phone_number, aadhar_card_number, salary, salary_type, allotted_hours, paid_sunday_allowance, pay_sunday, leave_start_months, date_of_joining, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [req.session.user.id, punching_id, name, designation, phone_number, aadhar_card_number, salary, salary_type, allotted_hours, paid_sunday_allowance || 0, pay_sunday ? 1 : 0, leave_start_months || 3, date_of_joining]
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

    let leavesPromise = Promise.resolve([[]]);
    if (employee.salary_type !== 'dihadi') {
      leavesPromise = pool.query(
        'SELECT * FROM employee_leaves WHERE employee_id = ? ORDER BY leave_date DESC',
        [empId]
      );
    }

    const [leavesRes, debitsRes, advancesRes] = await Promise.all([
      leavesPromise,
      pool.query(
        'SELECT * FROM employee_debits WHERE employee_id = ? ORDER BY added_at DESC',
        [empId]
      ),
      pool.query(
        'SELECT * FROM employee_advances WHERE employee_id = ? ORDER BY added_at DESC',
        [empId]
      )
    ]);

    const leaves = leavesRes[0] || [];
    const debits = debitsRes[0];
    const advances = advancesRes[0];

    let leaveBalance = 'N/A';
    if (employee.salary_type !== 'dihadi') {
      const monthsWorked = moment().diff(moment(employee.date_of_joining), 'months');
      const startMonths = parseInt(employee.leave_start_months || 3, 10);
      const earned = monthsWorked >= startMonths ? (monthsWorked - (startMonths - 1)) * 1.5 : 0;
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

// Download monthly salary sheet for salaried employees
router.get('/salary/download', isAuthenticated, isSupervisor, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const supervisorId = req.session.user.id;
  try {
    const [rows] = await pool.query(
      `SELECT e.punching_id, e.name, es.gross, es.deduction, es.net
         FROM employees e
         LEFT JOIN employee_salaries es ON es.employee_id = e.id AND es.month = ?
        WHERE e.supervisor_id = ? AND e.salary_type != 'dihadi' AND e.is_active = 1
        ORDER BY e.name`,
      [month, supervisorId]
    );
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Salary');
    sheet.columns = [
      { header: 'Punch ID', key: 'punching_id', width: 12 },
      { header: 'Name', key: 'name', width: 20 },
      { header: 'Gross', key: 'gross', width: 12 },
      { header: 'Deduction', key: 'deduction', width: 12 },
      { header: 'Net', key: 'net', width: 12 }
    ];
    rows.forEach(r =>
      sheet.addRow({
        punching_id: r.punching_id,
        name: r.name,
        gross: r.gross || 0,
        deduction: r.deduction || 0,
        net: r.net || 0
      })
    );
    res.setHeader('Content-Disposition', `attachment; filename="salary_${month}.xlsx"`);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading salary sheet:', err);
    req.flash('error', 'Could not download salary sheet');
    res.redirect('/supervisor/employees');
  }
});

// View salary details for an employee
router.get('/employees/:id/salary', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  try {
    const [[emp]] = await pool.query(
      'SELECT id, name FROM employees WHERE id = ? AND supervisor_id = ?',
      [empId, req.session.user.id]
    );
    if (!emp) {
      req.flash('error', 'Employee not found');
      return res.redirect('/supervisor/employees');
    }
    const [salaries] = await pool.query(
      'SELECT month, gross, deduction, net FROM employee_salaries WHERE employee_id = ? ORDER BY month DESC',
      [empId]
    );
    res.render('employeeSalary', {
      user: req.session.user,
      employee: emp,
      salaries
    });
  } catch (err) {
    console.error('Error loading employee salary:', err);
    req.flash('error', 'Failed to load salary details');
    res.redirect('/supervisor/employees');
  }
});

// Download salary slip for an employee
router.get('/employees/:id/salary/download', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const month = req.query.month;
  if (!month) {
    req.flash('error', 'Month is required');
    return res.redirect(`/supervisor/employees/${empId}/salary`);
  }
  try {
    const [[emp]] = await pool.query(
      'SELECT name, punching_id FROM employees WHERE id = ? AND supervisor_id = ?',
      [empId, req.session.user.id]
    );
    if (!emp) {
      req.flash('error', 'Employee not found');
      return res.redirect('/supervisor/employees');
    }
    const [[sal]] = await pool.query(
      'SELECT gross, deduction, net FROM employee_salaries WHERE employee_id = ? AND month = ?',
      [empId, month]
    );
    if (!sal) {
      req.flash('error', 'Salary not found');
      return res.redirect(`/supervisor/employees/${empId}/salary`);
    }
    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="salary_${emp.name}_${month}.pdf"`
    );
    doc.pipe(res);
    doc.fontSize(16).text('Salary Slip', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Employee: ${emp.name}`);
    doc.text(`Punch ID: ${emp.punching_id}`);
    doc.text(`Month: ${month}`);
    doc.moveDown();
    doc.text(`Gross Salary: ${sal.gross}`);
    doc.text(`Deductions: ${sal.deduction}`);
    doc.text(`Net Salary: ${sal.net}`);
    doc.end();
  } catch (err) {
    console.error('Error downloading salary slip:', err);
    req.flash('error', 'Failed to download salary slip');
    res.redirect(`/supervisor/employees/${empId}/salary`);
  }
});

module.exports = router;
