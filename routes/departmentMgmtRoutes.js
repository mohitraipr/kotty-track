const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const moment = require('moment');
const ExcelJS = require('exceljs');
const { calculateSalaryForMonth } = require('../helpers/salaryCalculator');
const { validateAttendanceFilename } = require('../helpers/attendanceFilenameValidator');

const upload = multer({ storage: multer.memoryStorage() });

// GET /operator/departments - list departments and supervisors
router.get('/departments', isAuthenticated, isOperator, async (req, res) => {
  try {
    const showSalary = true;
    const currentMonth = moment().format('YYYY-MM');
    const [deptRows] = await pool.query(
      `SELECT d.id, d.name,
              GROUP_CONCAT(u.username ORDER BY u.username SEPARATOR ', ') AS supervisors
         FROM departments d
         LEFT JOIN department_supervisors ds ON d.id = ds.department_id
         LEFT JOIN users u ON ds.user_id = u.id
         GROUP BY d.id
         ORDER BY d.name`
    );

    const [supervisors] = await pool.query(
      `SELECT u.id, u.username
         FROM users u
         JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'supervisor' AND u.is_active = 1
        ORDER BY u.username`
    );

    let salarySummary = [];
    if (showSalary) {
      const [rows] = await pool.query(`
        SELECT u.name AS supervisor_name, u.id AS supervisor_id,
               COUNT(e.id) AS employee_count,
               SUM(CASE WHEN e.is_active = 1 THEN e.salary ELSE 0 END) AS total_salary
          FROM users u
          JOIN employees e ON e.supervisor_id = u.id
         GROUP BY u.id`);
      salarySummary = rows;
    }

    res.render('operatorDepartments', {
      user: req.session.user,
      departments: deptRows,
      supervisors,
      showSalarySection: showSalary,
      salarySummary,
      currentMonth
    });
  } catch (err) {
    console.error('Error loading departments:', err);
    req.flash('error', 'Failed to load departments');
    res.redirect('/operator/dashboard');
  }
});

// POST /operator/departments - create a department
router.post('/departments', isAuthenticated, isOperator, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    req.flash('error', 'Department name required');
    return res.redirect('/operator/departments');
  }
  try {
    await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
    req.flash('success', 'Department created');
    res.redirect('/operator/departments');
  } catch (err) {
    console.error('Error creating department:', err);
    req.flash('error', 'Error creating department');
    res.redirect('/operator/departments');
  }
});

// POST /operator/departments/:id/assign - assign supervisor to department
router.post('/departments/:id/assign', isAuthenticated, isOperator, async (req, res) => {
  const deptId = req.params.id;
  const { user_id } = req.body;
  if (!deptId || !user_id) {
    req.flash('error', 'Invalid supervisor assignment');
    return res.redirect('/operator/departments');
  }
  try {
    await pool.query(
      `INSERT INTO department_supervisors (department_id, user_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE department_id = department_id`,
      [deptId, user_id]
    );
    req.flash('success', 'Supervisor assigned');
    res.redirect('/operator/departments');
  } catch (err) {
    console.error('Error assigning supervisor:', err);
    req.flash('error', 'Error assigning supervisor');
    res.redirect('/operator/departments');
  }
});

// POST attendance JSON upload for salary processing
router.post('/departments/salary/upload', isAuthenticated, isOperator, upload.single('attFile'), async (req, res) => {
  const file = req.file;
  if (!file) {
    req.flash('error', 'No file uploaded');
    return res.redirect('/operator/departments');
  }

  const validation = await validateAttendanceFilename(file.originalname);
  if (!validation.valid) {
    req.flash('error', validation.message);
    return res.redirect('/operator/departments');
  }
  const supervisorId = validation.supervisorId;

  let data;
  try {
    const jsonStr = file.buffer.toString('utf8');
    data = JSON.parse(jsonStr);
  } catch (err) {
    console.error('Failed to parse JSON:', err);
    req.flash('error', 'Invalid JSON');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let uploadedCount = 0;
    for (const emp of data) {
      const [empRows] = await conn.query(
        'SELECT id, salary, salary_type FROM employees WHERE punching_id = ? AND name = ? AND supervisor_id = ? LIMIT 1',
        [emp.punchingId, emp.name, supervisorId]
      );
      if (!empRows.length) continue;
      const employee = empRows[0];
      for (const att of emp.attendance) {
        await conn.query(
          `INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE punch_in = VALUES(punch_in), punch_out = VALUES(punch_out), status = VALUES(status)`,
          [employee.id, att.date, att.punchIn || null, att.punchOut || null, att.status || 'present']
        );
      }
      const month = moment(data[0].attendance[0].date).format('YYYY-MM');
      await calculateSalaryForMonth(conn, employee.id, month);
      uploadedCount++;
    }
    await conn.commit();
    req.flash('success', `Attendance uploaded for ${uploadedCount} employees`);
  } catch (err) {
    await conn.rollback();
    console.error('Error processing attendance:', err);
    req.flash('error', 'Failed to process attendance');
  } finally {
    conn.release();
  }

  res.redirect('/operator/departments');
});

// GET /operator/departments/salary/download?month=YYYY-MM - export salary sheet
router.get('/departments/salary/download', isAuthenticated, isOperator, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  try {
    const [sandwichRows] = await pool.query(
      'SELECT date FROM sandwich_dates WHERE DATE_FORMAT(date, "%Y-%m") = ?',
      [month]
    );
    const sandwichDates = sandwichRows.map(r => moment(r.date).format('YYYY-MM-DD'));

    const [rows] = await pool.query(`
      SELECT es.employee_id, es.gross, es.deduction, es.net, es.month,
             e.punching_id, e.name AS employee_name, e.salary AS base_salary,
             e.paid_sunday_allowance,
             u.name AS supervisor_name, d.name AS department_name
        FROM employee_salaries es
        JOIN employees e ON es.employee_id = e.id
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE es.month = ? AND e.is_active = 0 AND e.salary_type = 'monthly'
       ORDER BY u.name, e.name
    `, [month]);

    for (const r of rows) {
      const [attRows] = await pool.query(
        'SELECT date, status FROM employee_attendance WHERE employee_id = ? AND DATE_FORMAT(date, "%Y-%m") = ? ORDER BY date',
        [r.employee_id, month]
      );
      const attMap = {};
      attRows.forEach(a => {
        attMap[moment(a.date).format('YYYY-MM-DD')] = a.status;
      });
      let absent = 0, onePunch = 0, sundayAbs = 0;
      attRows.forEach(a => {
        const dateStr = moment(a.date).format('YYYY-MM-DD');
        const status = a.status;
        const isSun = moment(a.date).day() === 0;
        const isSandwich = sandwichDates.includes(dateStr);
        if (isSun) {
          const satStatus = attMap[moment(a.date).subtract(1, 'day').format('YYYY-MM-DD')];
          const monStatus = attMap[moment(a.date).add(1, 'day').format('YYYY-MM-DD')];
          const adjAbsent = (satStatus === 'absent' || satStatus === 'one punch only') ||
                            (monStatus === 'absent' || monStatus === 'one punch only');
          if (adjAbsent) {
            sundayAbs++;
            return;
          }
        }
        if (isSandwich) {
          const prevStatus = attMap[moment(a.date).subtract(1, 'day').format('YYYY-MM-DD')];
          const nextStatus = attMap[moment(a.date).add(1, 'day').format('YYYY-MM-DD')];
          const adjAbsent = (prevStatus === 'absent' || prevStatus === 'one punch only') ||
                            (nextStatus === 'absent' || nextStatus === 'one punch only');
          if (adjAbsent) {
            absent++;
            return;
          }
        }
        if (!isSun) {
          if (status === 'absent') absent++;
          else if (status === 'one punch only') onePunch++;
        }
      });
      const notes = [];
      if (absent) notes.push(`${absent} Absent`);
      if (onePunch) notes.push(`${onePunch} One Punch`);
      if (sundayAbs) notes.push(`${sundayAbs} Sun Absent`);
      r.deduction_reason = notes.join(', ');
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Salary');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Gross', key: 'gross', width: 10 },
      { header: 'Deduction', key: 'deduction', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'Deduction Reason', key: 'reason', width: 30 }
    ];
    rows.forEach(r => {
      sheet.addRow({
        supervisor: r.supervisor_name,
        department: r.department_name || '',
        punching_id: r.punching_id,
        employee: r.employee_name,
        month: r.month,
        gross: r.gross,
        deduction: r.deduction,
        net: r.net,
        reason: r.deduction_reason
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="SalarySummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading salary:', err);
    req.flash('error', 'Could not download salary');
    res.redirect('/operator/departments');
  }
});

// GET dihadi salary download
router.get('/departments/dihadi/download', isAuthenticated, isOperator, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const half = parseInt(req.query.half, 10) === 2 ? 2 : 1;
  let start = moment(month + '-01');
  let end = half === 1 ? moment(month + '-15') : moment(month + '-01').endOf('month');
  if (half === 2) start = moment(month + '-16');
  try {
    const [employees] = await pool.query(`
      SELECT e.id, e.punching_id, e.name, e.salary, e.allotted_hours,
             u.name AS supervisor_name, d.name AS department_name
        FROM employees e
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE e.salary_type = 'dihadi' AND e.is_active = 0
       ORDER BY u.name, e.name`);
    const rows = [];
    for (const emp of employees) {
      const [att] = await pool.query(
        'SELECT punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date BETWEEN ? AND ?',
        [emp.id, start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')]
      );
      let totalHours = 0;
      for (const a of att) {
        if (!a.punch_in || !a.punch_out) continue;
        const st = moment(a.punch_in, 'HH:mm:ss');
        const et = moment(a.punch_out, 'HH:mm:ss');
        let hrs = et.diff(st, 'minutes') / 60;
        const mins = hrs * 60;
        if (mins >= 11 * 60 + 50) {
          hrs -= 50 / 60;
        } else if (mins > 5 * 60 + 10) {
          hrs -= 0.5;
        }
        if (hrs < 0) hrs = 0;
        totalHours += hrs;
      }
      const rate = emp.allotted_hours ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours) : 0;
      const amount = parseFloat((totalHours * rate).toFixed(2));
      rows.push({
        supervisor: emp.supervisor_name,
        department: emp.department_name || '',
        punching_id: emp.punching_id,
        employee: emp.name,
        period: half === 1 ? '1-15' : '16-end',
        hours: totalHours.toFixed(2),
        amount
      });
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dihadi');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Period', key: 'period', width: 12 },
      { header: 'Hours', key: 'hours', width: 10 },
      { header: 'Amount', key: 'amount', width: 10 }
    ];
    rows.forEach(r => sheet.addRow(r));
    res.setHeader('Content-Disposition', 'attachment; filename="DihadiSalary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading dihadi salary:', err);
    req.flash('error', 'Could not download dihadi salary');
    res.redirect('/operator/departments');
  }
});

module.exports = router;
