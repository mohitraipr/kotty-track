const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const moment = require('moment');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const {
  calculateSalaryForMonth,
  calculateSalaryHourly,
  effectiveHours,
  crossedLunch,
} = require('../helpers/salaryCalculator');
const { HOURLY_EXEMPT_EMPLOYEE_IDS } = require('../utils/hourlyExemptEmployees');
const { SPECIAL_TEAM_EMPLOYEE_IDS } = require('../utils/specialTeamEmployees');
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
    let overview = null;
    if (showSalary) {
      const [rows] = await pool.query(`
        SELECT u.username AS supervisor_name, u.id AS supervisor_id,
               COUNT(e.id) AS employee_count,
               SUM(CASE WHEN e.is_active = 1 THEN e.salary ELSE 0 END) AS total_salary,
               SUM(CASE WHEN e.is_active = 1 AND e.salary_type='monthly' THEN e.salary ELSE 0 END) AS monthly_salary,
               SUM(CASE WHEN e.is_active = 1 AND e.salary_type='dihadi' THEN e.salary ELSE 0 END) AS dihadi_salary,
               AVG(CASE WHEN e.is_active = 1 AND e.salary_type='monthly' THEN e.salary ELSE NULL END) AS avg_monthly,
               AVG(CASE WHEN e.is_active = 1 AND e.salary_type='dihadi' THEN e.salary ELSE NULL END) AS avg_dihadi
          FROM users u
          JOIN employees e ON e.supervisor_id = u.id
         GROUP BY u.id
         ORDER BY total_salary DESC`);
      salarySummary = rows;

      const totalSalaryAll = rows.reduce((s, r) => s + Number(r.total_salary || 0), 0);
      const totalSupervisors = rows.length;
      let topEmp = null;
      let topSalary = rows[0] || null;
      let highestMonthly = null;
      let highestDihadi = null;
      rows.forEach(r => {
        const empCount = Number(r.employee_count);
        const avgMonthly = r.avg_monthly != null ? parseFloat(r.avg_monthly) : null;
        const avgDihadi = r.avg_dihadi != null ? parseFloat(r.avg_dihadi) : null;

        if (!topEmp || empCount > Number(topEmp.employee_count)) topEmp = { ...r, employee_count: empCount };

        if (avgMonthly !== null) {
          const currentHighest = highestMonthly ? parseFloat(highestMonthly.avg_monthly) : null;
          if (currentHighest === null || avgMonthly > currentHighest) {
            highestMonthly = { ...r, avg_monthly: avgMonthly };
          }
        }

        if (avgDihadi !== null) {
          const currentHighest = highestDihadi ? parseFloat(highestDihadi.avg_dihadi) : null;
          if (currentHighest === null || avgDihadi > currentHighest) {
            highestDihadi = { ...r, avg_dihadi: avgDihadi };
          }
        }
      });
      const [[advTotal]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM employee_advances');
      const [[advDed]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM advance_deductions');
      const totalAdvances = parseFloat(advTotal.total) - parseFloat(advDed.total);
      const totalActiveEmployees = rows.reduce((s, r) => s + Number(r.employee_count || 0), 0);

      overview = {
        totalSalaryAll,
        totalSupervisors,
        topEmployeeSupervisor: topEmp ? topEmp.supervisor_name : '',
        topEmployeeCount: topEmp ? topEmp.employee_count : 0,
        topSalarySupervisor: topSalary ? topSalary.supervisor_name : '',
        topSalaryAmount: topSalary ? topSalary.total_salary : 0,
        highestMonthlySupervisor: highestMonthly ? highestMonthly.supervisor_name : '',
        highestMonthlyAverage: highestMonthly ? highestMonthly.avg_monthly : 0,
        highestDihadiSupervisor: highestDihadi ? highestDihadi.supervisor_name : '',
        highestDihadiAverage: highestDihadi ? highestDihadi.avg_dihadi : 0,
        totalAdvances,
        totalActiveEmployees
      };
    }

    res.render('operatorDepartments', {
      user: req.session.user,
      departments: deptRows,
      supervisors,
      showSalarySection: showSalary,
      salarySummary,
      overview,
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

  const hourlyMode = req.body.hourly === '1';
  const sundayHours = req.body.sunday_hours ? parseFloat(req.body.sunday_hours) : null;

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
    const unmatched = [];
    for (const emp of data) {
      const [empRows] = await conn.query(
        'SELECT id, salary, salary_type, pay_sunday, allotted_hours FROM employees WHERE punching_id = ? AND name = ? AND supervisor_id = ? LIMIT 1',
        [emp.punchingId, emp.name, supervisorId]
      );
      if (!empRows.length) {
        const hasPresent = Array.isArray(emp.attendance) && emp.attendance.some(a => {
          const status = String(a.status || 'present').toLowerCase();
          return status === 'present';
        });
        if (hasPresent) {
          unmatched.push(`${emp.punchingId} - ${emp.name}`);
        }
        continue;
      }
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
      if (
        hourlyMode &&
        employee.salary_type === 'monthly' &&
        !HOURLY_EXEMPT_EMPLOYEE_IDS.includes(employee.id) &&
        !SPECIAL_TEAM_EMPLOYEE_IDS.includes(employee.id)
      ) {
        await calculateSalaryHourly(conn, employee.id, month, employee, sundayHours);
      } else {
        await calculateSalaryForMonth(conn, employee.id, month);
      }
      uploadedCount++;
    }
    await conn.commit();
    let msg = `Attendance uploaded for ${uploadedCount} employees`;
    if (unmatched.length) {
      msg += `. Unmatched employees with present days: ${unmatched.join(', ')}`;
    }
    req.flash('success', msg);
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
             e.punching_id, e.name AS employee_name, e.salary AS base_salary, e.salary_type,
             e.paid_sunday_allowance, e.pay_sunday, e.allotted_hours,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = es.employee_id) AS advance_taken,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = es.employee_id) AS advance_deducted,
             u.username AS supervisor_name, d.name AS department_name
        FROM employee_salaries es
        JOIN employees e ON es.employee_id = e.id
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE es.month = ? AND e.is_active = 1 AND e.salary_type = 'monthly'
       ORDER BY u.username, e.name
    `, [month]);

    const empIds = rows.map(r => r.employee_id);
    if (empIds.length) {
      const prevDay = moment(month + '-01').subtract(1, 'day').format('YYYY-MM-DD');
      const nextDay = moment(month + '-01').endOf('month').add(1, 'day').format('YYYY-MM-DD');

      const [attRows] = await pool.query(
        'SELECT employee_id, date, status, punch_in, punch_out FROM employee_attendance WHERE employee_id IN (?) AND DATE_FORMAT(date, "%Y-%m") = ? ORDER BY employee_id, date',
        [empIds, month]
      );
      const [adjacent] = await pool.query(
        'SELECT employee_id, date, status FROM employee_attendance WHERE employee_id IN (?) AND date IN (?, ?)',
        [empIds, prevDay, nextDay]
      );

      const attMap = new Map();
      for (const a of attRows) {
        const key = a.employee_id;
        if (!attMap.has(key)) attMap.set(key, []);
        attMap.get(key).push(a);
      }

      const adjMap = new Map();
      for (const a of adjacent) {
        const key = a.employee_id;
        if (!adjMap.has(key)) adjMap.set(key, []);
        adjMap.get(key).push(a);
      }

      for (const r of rows) {
        const empAtt = attMap.get(r.employee_id) || [];
        const adjAtt = adjMap.get(r.employee_id) || [];
        const daily = {};
        empAtt.forEach(a => {
          daily[moment(a.date).format('YYYY-MM-DD')] = a.status;
        });
        adjAtt.forEach(a => {
          daily[moment(a.date).format('YYYY-MM-DD')] = a.status;
        });
      let absent = 0, onePunch = 0, sundayAbs = 0;
      let otHours = 0, utHours = 0, otDays = 0, utDays = 0;
        empAtt.forEach(a => {
        const dateStr = moment(a.date).format('YYYY-MM-DD');
        const status = a.status;
        const isSun = moment(a.date).day() === 0;
        const isSandwich = sandwichDates.includes(dateStr);
        if (isSun) {
          const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
          const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
          const satStatus = daily[satKey] !== undefined ? daily[satKey] : 'present';
          const monStatus = daily[monKey] !== undefined ? daily[monKey] : 'present';
          const adjAbsent = (satStatus === 'absent' || satStatus === 'one punch only') ||
                            (monStatus === 'absent' || monStatus === 'one punch only');
          if (adjAbsent) {
            sundayAbs++;
            return;
          }
        }
        if (isSandwich) {
          const prevStatus = daily[moment(a.date).subtract(1, 'day').format('YYYY-MM-DD')];
          const nextStatus = daily[moment(a.date).add(1, 'day').format('YYYY-MM-DD')];
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
        if (a.punch_in && a.punch_out) {
          const hrs = effectiveHours(a.punch_in, a.punch_out, 'monthly');
          const baseHours = isSun ? 9 : parseFloat(r.allotted_hours || 0);
          const diff = hrs - baseHours;
          if (diff > 0) { otHours += diff; otDays++; }
          else if (diff < 0 && crossedLunch(a.punch_in, a.punch_out)) {
            utHours += Math.abs(diff); utDays++;
          }
        }
      });
      const notes = [];
      if (absent) notes.push(`${absent} day(s) absent`);
      if (onePunch) notes.push(`${onePunch} day(s) with missing punch`);
      if (sundayAbs) notes.push(`${sundayAbs} Sunday absence(s)`);
      r.deduction_reason = notes.length ? notes.join(', ') : 'None';
      r.overtime_hours = otHours.toFixed(2);
      r.overtime_days = otDays;
      r.undertime_hours = utHours.toFixed(2);
      r.undertime_days = utDays;
      r.time_status = otHours > utHours ? 'Overtime' : utHours > otHours ? 'Undertime' : 'Even';

      const netHours = utHours - otHours;
      const allot = parseFloat(r.allotted_hours || 0);
      const daysInMonth = moment(month + '-01').daysInMonth();
      let utDeduct = 0;
      let utDetail = '';
      if (netHours > 0 && allot > 0) {
        const cutDays = Math.floor(netHours / allot);
        if (cutDays > 0) {
          const dailyRate = parseFloat(r.base_salary) / daysInMonth;
          utDeduct = parseFloat((dailyRate * cutDays).toFixed(2));
          r.deduction = parseFloat(r.deduction) + utDeduct;
          r.net = parseFloat(r.net) - utDeduct;
          utDetail = `${cutDays} day salary cut due to undertime`;
        }
      }
      r.ut_deduct = utDeduct.toFixed(2);
      r.ut_detail = utDetail;
    }
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Salary');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary Type', key: 'salary_type', width: 12 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Gross', key: 'gross', width: 10 },
      { header: 'Deduction', key: 'deduction', width: 12 },
      { header: 'Advance Taken', key: 'advance_taken', width: 12 },
      { header: 'Advance Deducted', key: 'advance_deducted', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'UT Deduct', key: 'ut_deduct', width: 12 },
      { header: 'UT Detail', key: 'ut_detail', width: 25 },
      { header: 'OT Hours', key: 'ot_hours', width: 12 },
      { header: 'OT Days', key: 'ot_days', width: 10 },
      { header: 'UT Hours', key: 'ut_hours', width: 12 },
      { header: 'UT Days', key: 'ut_days', width: 10 },
      { header: 'Status', key: 'time_status', width: 12 },
      { header: 'Deduction Reason', key: 'reason', width: 30 }
    ];
    rows.forEach(r => {
      sheet.addRow({
        supervisor: r.supervisor_name,
        department: r.department_name || '',
        punching_id: r.punching_id,
        employee: r.employee_name,
        salary_type: r.salary_type,
        month: r.month,
        gross: r.gross,
        deduction: r.deduction,
        advance_taken: r.advance_taken,
        advance_deducted: r.advance_deducted,
        net: r.net,
        ut_deduct: r.ut_deduct,
        ut_detail: r.ut_detail,
        ot_hours: r.overtime_hours,
        ot_days: r.overtime_days,
        ut_hours: r.undertime_hours,
        ut_days: r.undertime_days,
        time_status: r.time_status,
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

// Download monthly salary applying a rule
router.get('/departments/salary/download-rule', isAuthenticated, isOperator, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const rule = req.query.rule || '';
  try {
    const [sandwichRows] = await pool.query(
      'SELECT date FROM sandwich_dates WHERE DATE_FORMAT(date, "%Y-%m") = ?',
      [month]
    );
    const sandwichDates = sandwichRows.map(r => moment(r.date).format('YYYY-MM-DD'));

    const [rows] = await pool.query(`
      SELECT es.employee_id, es.gross, es.deduction, es.net, es.month,
             e.punching_id, e.name AS employee_name, e.salary AS base_salary, e.salary_type,
             e.paid_sunday_allowance, e.pay_sunday, e.allotted_hours,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = es.employee_id) AS advance_taken,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = es.employee_id) AS advance_deducted,
             u.username AS supervisor_name, d.name AS department_name
        FROM employee_salaries es
        JOIN employees e ON es.employee_id = e.id
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE es.month = ? AND e.is_active = 1 AND e.salary_type = 'monthly'
       ORDER BY u.username, e.name`,
      [month]
    );

    const empIds2 = rows.map(r => r.employee_id);
    if (empIds2.length) {
      const [attRowsAll] = await pool.query(
        'SELECT employee_id, date, status, punch_in, punch_out FROM employee_attendance WHERE employee_id IN (?) AND DATE_FORMAT(date, "%Y-%m") = ? ORDER BY employee_id, date',
        [empIds2, month]
      );

      const attMap2 = new Map();
      for (const a of attRowsAll) {
        const key = a.employee_id;
        if (!attMap2.has(key)) attMap2.set(key, []);
        attMap2.get(key).push(a);
      }

      for (const r of rows) {
        const attRows = attMap2.get(r.employee_id) || [];
        const daily = {};
        attRows.forEach(a => {
          daily[moment(a.date).format('YYYY-MM-DD')] = a.status;
        });
        let absent = 0, onePunch = 0, sundayAbs = 0;
        let otHours = 0, utHours = 0, otDays = 0, utDays = 0;
        let shortDays = 0;
        let halfDays = 0;
        attRows.forEach(a => {
        const dateStr = moment(a.date).format('YYYY-MM-DD');
        const status = a.status;
        const isSun = moment(a.date).day() === 0;
        const isSandwich = sandwichDates.includes(dateStr);
        if (isSun) {
          const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
          const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
          const satStatus = attMap[satKey] !== undefined ? attMap[satKey] : 'present';
          const monStatus = attMap[monKey] !== undefined ? attMap[monKey] : 'present';
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
        if (a.punch_in && a.punch_out) {
          const hrs = effectiveHours(a.punch_in, a.punch_out, 'monthly');
          const baseHours = isSun ? 9 : parseFloat(r.allotted_hours || 0);
          const diff = hrs - baseHours;
          if (diff > 0) { otHours += diff; otDays++; }
          else if (diff < 0 && crossedLunch(a.punch_in, a.punch_out)) {
            utHours += Math.abs(diff); utDays++; }
          const allotted = parseFloat(r.allotted_hours || 0);
          if (hrs >= allotted * 0.4 && hrs < allotted * 0.85) halfDays++;
          if (rule === 'monthly_short' && hrs < allotted) shortDays++;
        }
      });
      const notes = [];
      if (absent) notes.push(`${absent} day(s) absent`);
      if (onePunch) notes.push(`${onePunch} day(s) with missing punch`);
      if (sundayAbs) notes.push(`${sundayAbs} Sunday absence(s)`);
      if (halfDays) notes.push(`${halfDays} half-day(s)`);
      r.deduction_reason = notes.length ? notes.join(', ') : 'None';
      r.overtime_hours = otHours.toFixed(2);
      r.overtime_days = otDays;
      r.undertime_hours = utHours.toFixed(2);
      r.undertime_days = utDays;
      r.time_status = otHours > utHours ? 'Overtime' : utHours > otHours ? 'Undertime' : 'Even';

      const netHours = utHours - otHours;
      const allot = parseFloat(r.allotted_hours || 0);
      const daysInMonth = moment(month + '-01').daysInMonth();
      let utDeduct = 0;
      let utDetail = '';
      if (netHours > 0 && allot > 0) {
        const cutDays = Math.floor(netHours / allot);
        if (cutDays > 0) {
          const dailyRate = parseFloat(r.base_salary) / daysInMonth;
          utDeduct = parseFloat((dailyRate * cutDays).toFixed(2));
          r.deduction = parseFloat(r.deduction) + utDeduct;
          r.net = parseFloat(r.net) - utDeduct;
          utDetail = `${cutDays} day salary cut due to undertime`;
        }
      }
      r.ut_deduct = utDeduct.toFixed(2);
      r.ut_detail = utDetail;

      if (rule === 'monthly_short' && shortDays >= 3) {
        const daysInMonth = moment(month + '-01').daysInMonth();
        const dailyRate = parseFloat(r.base_salary) / daysInMonth;
        r.deduction = parseFloat(r.deduction) + dailyRate;
        r.net = parseFloat(r.net) - dailyRate;
        r.deduction_reason += (r.deduction_reason ? ', ' : '') + 'Rule Deduction';
      }
    }
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Salary');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary Type', key: 'salary_type', width: 12 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Gross', key: 'gross', width: 10 },
      { header: 'Deduction', key: 'deduction', width: 12 },
      { header: 'Advance Taken', key: 'advance_taken', width: 12 },
      { header: 'Advance Deducted', key: 'advance_deducted', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'UT Deduct', key: 'ut_deduct', width: 12 },
      { header: 'UT Detail', key: 'ut_detail', width: 25 },
      { header: 'OT Hours', key: 'ot_hours', width: 12 },
      { header: 'OT Days', key: 'ot_days', width: 10 },
      { header: 'UT Hours', key: 'ut_hours', width: 12 },
      { header: 'UT Days', key: 'ut_days', width: 10 },
      { header: 'Status', key: 'time_status', width: 12 },
      { header: 'Deduction Reason', key: 'reason', width: 30 }
    ];
    rows.forEach(r => {
      sheet.addRow({
        supervisor: r.supervisor_name,
        department: r.department_name || '',
        punching_id: r.punching_id,
        employee: r.employee_name,
        salary_type: r.salary_type,
        month: r.month,
        gross: r.gross,
        deduction: r.deduction,
        advance_taken: r.advance_taken,
        advance_deducted: r.advance_deducted,
        net: r.net,
        ut_deduct: r.ut_deduct,
        ut_detail: r.ut_detail,
        ot_hours: r.overtime_hours,
        ot_days: r.overtime_days,
        ut_hours: r.undertime_hours,
        ut_days: r.undertime_days,
        time_status: r.time_status,
        reason: r.deduction_reason
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="SalarySummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading salary with rule:', err);
    req.flash('error', 'Could not download salary');
    res.redirect('/operator/departments');
  }
});

// Download dihadi salary with a rule
router.get('/departments/dihadi/download-rule', isAuthenticated, isOperator, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const half = parseInt(req.query.half, 10) === 2 ? 2 : 1;
  const rule = req.query.rule || '';
  let start = moment(month + '-01');
  let end = half === 1 ? moment(month + '-15') : moment(month + '-01').endOf('month');
  if (half === 2) start = moment(month + '-16');
  try {
    const [employees] = await pool.query(`
      SELECT e.id, e.punching_id, e.name, e.salary, e.allotted_hours,
             u.username AS supervisor_name, d.name AS department_name,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = e.id) AS advance_taken,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id) AS advance_deducted
        FROM employees e
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE e.salary_type = 'dihadi' AND e.is_active = 1
       ORDER BY u.username, e.name`);
    const rows = [];
    const empIds3 = employees.map(e => e.id);
    if (empIds3.length) {
      const startStr = start.format('YYYY-MM-DD');
      const endStr = end.format('YYYY-MM-DD');
      const [attAll] = await pool.query(
        'SELECT employee_id, punch_in, punch_out, status FROM employee_attendance WHERE employee_id IN (?) AND date BETWEEN ? AND ?',
        [empIds3, startStr, endStr]
      );
      const attMap3 = new Map();
      for (const a of attAll) {
        const key = a.employee_id;
        if (!attMap3.has(key)) attMap3.set(key, []);
        attMap3.get(key).push(a);
      }

      for (const emp of employees) {
        const att = attMap3.get(emp.id) || [];
        let totalHours = 0;
        let absent = 0,
          onePunch = 0,
          late = 0;
        for (const a of att) {
          if (!a.punch_in || !a.punch_out) {
            if (a.status === 'absent') absent++;
            else if (a.status === 'one punch only') onePunch++;
            continue;
          }
          let hrs = effectiveHours(a.punch_in, a.punch_out, 'dihadi');
          if (moment(a.punch_in, 'HH:mm:ss').isAfter(moment('09:15:00', 'HH:mm:ss')))
            late++;
          if (hrs < 0) hrs = 0;
          totalHours += hrs;
        }
        const rate = emp.allotted_hours ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours) : 0;
        const amount = parseFloat((totalHours * rate).toFixed(2));
        const notes = [];
        if (absent) notes.push(`${absent} day(s) absent`);
        if (onePunch) notes.push(`${onePunch} day(s) with missing punch`);
        if (late) notes.push(`${late} late arrival(s)`);
        const net = parseFloat((amount - parseFloat(emp.advance_deducted)).toFixed(2));
        rows.push({
          supervisor: emp.supervisor_name,
          department: emp.department_name || '',
          punching_id: emp.punching_id,
          employee: emp.name,
          salary_type: 'dihadi',
          period: half === 1 ? '1-15' : '16-end',
          hours: totalHours.toFixed(2),
          amount,
          advance_taken: emp.advance_taken,
          advance_deducted: emp.advance_deducted,
          net,
          reason: notes.length ? notes.join(', ') : 'None'
        });
      }
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dihadi');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary Type', key: 'salary_type', width: 12 },
      { header: 'Period', key: 'period', width: 12 },
      { header: 'Hours', key: 'hours', width: 10 },
      { header: 'Amount', key: 'amount', width: 10 },
      { header: 'Advance Taken', key: 'advance_taken', width: 12 },
      { header: 'Advance Deducted', key: 'advance_deducted', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'Deduction Reason', key: 'reason', width: 25 }
    ];
    rows.forEach(r => sheet.addRow(r));
    res.setHeader('Content-Disposition', 'attachment; filename="DihadiSalary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading dihadi salary with rule:', err);
    req.flash('error', 'Could not download dihadi salary');
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
             u.username AS supervisor_name, d.name AS department_name,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = e.id) AS advance_taken,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id) AS advance_deducted
        FROM employees e
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE e.salary_type = 'dihadi' AND e.is_active = 1
       ORDER BY u.username, e.name`);
    const rows = [];
    const empIds4 = employees.map(e => e.id);
    if (empIds4.length) {
      const startStr = start.format('YYYY-MM-DD');
      const endStr = end.format('YYYY-MM-DD');
      const [attAll] = await pool.query(
        'SELECT employee_id, punch_in, punch_out, status FROM employee_attendance WHERE employee_id IN (?) AND date BETWEEN ? AND ?',
        [empIds4, startStr, endStr]
      );
      const attMap4 = new Map();
      for (const a of attAll) {
        const key = a.employee_id;
        if (!attMap4.has(key)) attMap4.set(key, []);
        attMap4.get(key).push(a);
      }

      for (const emp of employees) {
        const att = attMap4.get(emp.id) || [];
        let totalHours = 0;
        let absent = 0,
          onePunch = 0,
          late = 0;
        for (const a of att) {
          if (!a.punch_in || !a.punch_out) {
            if (a.status === 'absent') absent++;
            else if (a.status === 'one punch only') onePunch++;
            continue;
          }
          let hrs = effectiveHours(a.punch_in, a.punch_out, 'dihadi');
          if (moment(a.punch_in, 'HH:mm:ss').isAfter(moment('09:15:00', 'HH:mm:ss')))
            late++;
          if (hrs < 0) hrs = 0;
          totalHours += hrs;
        }
        const rate = emp.allotted_hours ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours) : 0;
        const amount = parseFloat((totalHours * rate).toFixed(2));
        const notes = [];
        if (absent) notes.push(`${absent} day(s) absent`);
        if (onePunch) notes.push(`${onePunch} day(s) with missing punch`);
        if (late) notes.push(`${late} late arrival(s)`);
        const net = parseFloat((amount - parseFloat(emp.advance_deducted)).toFixed(2));
        rows.push({
          supervisor: emp.supervisor_name,
          department: emp.department_name || '',
          punching_id: emp.punching_id,
          employee: emp.name,
          salary_type: 'dihadi',
          period: half === 1 ? '1-15' : '16-end',
          hours: totalHours.toFixed(2),
          amount,
          advance_taken: emp.advance_taken,
          advance_deducted: emp.advance_deducted,
          net,
          reason: notes.length ? notes.join(', ') : 'None'
        });
      }
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dihadi');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary Type', key: 'salary_type', width: 12 },
      { header: 'Period', key: 'period', width: 12 },
      { header: 'Hours', key: 'hours', width: 10 },
      { header: 'Amount', key: 'amount', width: 10 },
      { header: 'Advance Taken', key: 'advance_taken', width: 12 },
      { header: 'Advance Deducted', key: 'advance_deducted', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'Deduction Reason', key: 'reason', width: 25 }
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

// Download advance summary for all employees
router.get('/departments/advances/download', isAuthenticated, isOperator, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const half = parseInt(req.query.half, 10);
  const period = half === 2 ? '16-end' : half === 1 ? '1-15' : 'full';
  try {
    const [rows] = await pool.query(`
      SELECT e.id, e.punching_id, e.name, e.salary_type,
             u.username AS supervisor_name, d.name AS department_name,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = e.id) AS total_adv,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id) AS total_ded,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id AND ad.month = ?) AS month_ded
        FROM employees e
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE e.is_active = 1
       ORDER BY u.username, e.name`,
      [month]
    );

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Advances');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary Type', key: 'salary_type', width: 12 },
      { header: 'Period', key: 'period', width: 12 },
      { header: 'Advance', key: 'advance', width: 12 },
      { header: 'Advance Deduction', key: 'deduction', width: 15 }
    ];

    rows.forEach(r => {
      const outstanding = parseFloat(r.total_adv) - parseFloat(r.total_ded);
      sheet.addRow({
        supervisor: r.supervisor_name,
        department: r.department_name || '',
        punching_id: r.punching_id,
        employee: r.name,
        salary_type: r.salary_type,
        period,
        advance: outstanding,
        deduction: r.month_ded
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="AdvanceSummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading advance summary:', err);
    req.flash('error', 'Could not download advances');
    res.redirect('/operator/departments');
  }
});

// Return employees for a supervisor as JSON
router.get('/departments/:supId/employees-json', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM employees WHERE supervisor_id = ? ORDER BY name',
      [req.params.supId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to load employees' });
  }
});

// Update an employee record
router.post('/departments/employees/:id/update', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.params.id;
  const { punching_id, name, designation, phone_number, salary, salary_type, allotted_hours, paid_sunday_allowance, pay_sunday, leave_start_months, date_of_joining, is_active } = req.body;

  // Convert boolean like fields to proper numbers. Strings like "0" should be
  // treated as false which JavaScript truthiness would not do by default.
  const paySunday = pay_sunday === '1' || pay_sunday === 1 || pay_sunday === true;
  const isActive = is_active === '1' || is_active === 1 || is_active === true;
  try {
    await pool.query(
      `UPDATE employees SET punching_id=?, name=?, designation=?, phone_number=?, salary=?, salary_type=?, allotted_hours=?, paid_sunday_allowance=?, pay_sunday=?, leave_start_months=?, date_of_joining=?, is_active=? WHERE id=?`,
      [
        punching_id,
        name,
        designation,
        phone_number,
        salary,
        salary_type,
        allotted_hours,
        paid_sunday_allowance || 0,
        paySunday ? 1 : 0,
        leave_start_months || 3,
        date_of_joining,
        isActive ? 1 : 0,
        empId
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating employee:', err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// Delete all attendance and salary data for a supervisor
router.post('/departments/reset-supervisor', isAuthenticated, isOperator, async (req, res) => {
  const supId = req.body.supervisor_id;
  if (!supId) {
    req.flash('error', 'Supervisor is required');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let empRows;
    if (supId === 'all') {
      [empRows] = await conn.query('SELECT id FROM employees');
    } else {
      [empRows] = await conn.query('SELECT id FROM employees WHERE supervisor_id = ?', [supId]);
    }
    const empIds = empRows.map(e => e.id);
    if (empIds.length) {
      await conn.query('DELETE FROM attendance_edit_logs WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_attendance WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_salaries WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_nights WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_leaves WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_debits WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_advances WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM advance_deductions WHERE employee_id IN (?)', [empIds]);
    }
    await conn.commit();
    if (supId === 'all') {
      req.flash('success', 'All supervisors data cleared');
    } else {
      req.flash('success', 'Supervisor data cleared');
    }
  } catch (err) {
    await conn.rollback();
    console.error('Error clearing supervisor data:', err);
    req.flash('error', 'Failed to clear data');
  } finally {
    conn.release();
  }
  res.redirect('/operator/departments');
});

// Delete all employees and associated data for a supervisor
router.post('/departments/delete-supervisor-employees', isAuthenticated, isOperator, async (req, res) => {
  const supId = req.body.supervisor_id;
  if (!supId) {
    req.flash('error', 'Supervisor is required');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [empRows] = await conn.query('SELECT id FROM employees WHERE supervisor_id = ?', [supId]);
    const empIds = empRows.map(e => e.id);
    if (empIds.length) {
      await conn.query('DELETE FROM attendance_edit_logs WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_attendance WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_salaries WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_nights WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_leaves WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_debits WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employee_advances WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM advance_deductions WHERE employee_id IN (?)', [empIds]);
      await conn.query('DELETE FROM employees WHERE supervisor_id = ?', [supId]);
    }
    await conn.commit();
    req.flash('success', 'Employees deleted');
  } catch (err) {
    await conn.rollback();
    console.error('Error deleting employees:', err);
    req.flash('error', 'Failed to delete employees');
  } finally {
    conn.release();
  }
  res.redirect('/operator/departments');
});

// Bulk fix miss punches for an employee
router.post('/departments/fix-miss-punch', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.body.employee_id;
  if (!empId) {
    req.flash('error', 'Employee ID is required');
    return res.redirect('/operator/departments');
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[emp]] = await conn.query('SELECT id, allotted_hours FROM employees WHERE id = ?', [empId]);
    if (!emp) {
      await conn.rollback();
      conn.release();
      req.flash('error', 'Employee not found');
      return res.redirect('/operator/departments');
    }
    const allot = parseFloat(emp.allotted_hours || 0);
    const outTime = moment('09:00:00', 'HH:mm:ss').add(allot, 'hours').format('HH:mm:ss');

    const [rows] = await conn.query(
      "SELECT id, date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND status = 'one punch only'",
      [empId]
    );

    const months = new Set();
    for (const r of rows) {
      await conn.query(
        'UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = \"present\" WHERE id = ?',
        ['09:00:00', outTime, r.id]
      );
      await conn.query(
        'INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [empId, r.date, r.punch_in, r.punch_out, '09:00:00', outTime, req.session.user.id]
      );
      months.add(moment(r.date).format('YYYY-MM'));
    }

    for (const m of months) {
      await calculateSalaryForMonth(conn, empId, m);
    }

    await conn.commit();
    req.flash('success', `Fixed ${rows.length} entries`);
  } catch (err) {
    await conn.rollback();
    console.error('Error fixing miss punch:', err);
    req.flash('error', 'Failed to fix miss punches');
  } finally {
    conn.release();
  }
  res.redirect('/operator/departments');
});

// Bulk fix miss punches using an Excel file of employee IDs
router.post(
  '/departments/bulk-fix-miss-punch',
  isAuthenticated,
  isOperator,
  upload.single('excelFile'),
  async (req, res) => {
    const file = req.file;
    if (!file) {
      req.flash('error', 'No file uploaded');
      return res.redirect('/operator/departments');
    }

    let rows;
    try {
      const wb = XLSX.read(file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch (err) {
      console.error('Failed to parse Excel:', err);
      req.flash('error', 'Invalid Excel file');
      return res.redirect('/operator/departments');
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      let totalFixed = 0;

      for (const r of rows) {
        const empId = parseInt(
          r.employeeid || r.employee_id || r.id || r.empid || 0,
          10
        );
        if (!empId) continue;

        const [[emp]] = await conn.query(
          'SELECT id, allotted_hours FROM employees WHERE id = ?',
          [empId]
        );
        if (!emp) continue;

        const allot = parseFloat(emp.allotted_hours || 0);
        const outTime = moment('09:00:00', 'HH:mm:ss')
          .add(allot, 'hours')
          .format('HH:mm:ss');

        const [attRows] = await conn.query(
          "SELECT id, date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND status = 'one punch only'",
          [empId]
        );

        const months = new Set();
        for (const a of attRows) {
          await conn.query(
            'UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = "present" WHERE id = ?',
            ['09:00:00', outTime, a.id]
          );
          await conn.query(
            'INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
              empId,
              a.date,
              a.punch_in,
              a.punch_out,
              '09:00:00',
              outTime,
              req.session.user.id
            ]
          );
          months.add(moment(a.date).format('YYYY-MM'));
        }

        for (const m of months) {
          await calculateSalaryForMonth(conn, empId, m);
        }

        totalFixed += attRows.length;
      }

      await conn.commit();
      req.flash('success', `Fixed ${totalFixed} entries`);
    } catch (err) {
      await conn.rollback();
      console.error('Error bulk fixing miss punches:', err);
      req.flash('error', 'Failed to bulk fix miss punches');
    } finally {
      conn.release();
    }

    res.redirect('/operator/departments');
  }
);

module.exports = router;
