const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const moment = require('moment');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isSupervisor } = require('../middlewares/auth');
const { calculateSalaryForMonth, effectiveHours, lunchDeduction } = require('../helpers/salaryCalculator');
const { SPECIAL_DEPARTMENTS } = require('../utils/departments');

function formatHours(h) {
  let hours = Math.floor(h);
  let mins = Math.round((h - hours) * 60);
  if (mins === 60) { hours += 1; mins = 0; }
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

const { validateAttendanceFilename } = require('../helpers/attendanceFilenameValidator');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');


// Configure upload for JSON files in memory
const upload = multer({ storage: multer.memoryStorage() });

// GET form to upload attendance JSON
router.get('/salary/upload', isAuthenticated, isOperator, (req, res) => {
  res.redirect('/operator/departments');
});

// POST process uploaded attendance JSON
router.post('/salary/upload', isAuthenticated, isOperator, upload.single('attFile'), async (req, res) => {
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
    const recalc = new Map();
    for (const emp of data) {
      const [empRows] = await conn.query(
        'SELECT id, salary, salary_type FROM employees WHERE punching_id = ? AND name = ? AND supervisor_id = ? LIMIT 1',
        [emp.punchingId, emp.name, supervisorId]
      );
      if (!empRows.length) continue;
      const employee = empRows[0];

      const attendanceValues = emp.attendance.map(att => [
        employee.id,
        att.date,
        att.punchIn || null,
        att.punchOut || null,
        att.status || 'present'
      ]);
      if (attendanceValues.length) {
        await conn.query(
          `INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status)
           VALUES ?
           ON DUPLICATE KEY UPDATE punch_in = VALUES(punch_in), punch_out = VALUES(punch_out), status = VALUES(status)`,
          [attendanceValues]
        );
      }

      const month = moment(emp.attendance[0].date).format('YYYY-MM');
      recalc.set(`${employee.id}_${month}`, { id: employee.id, month });
      uploadedCount++;
    }
    for (const { id, month } of recalc.values()) {
      await calculateSalaryForMonth(conn, id, month);
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

// POST night shift Excel upload
router.post('/salary/upload-nights', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
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


  // Night records can be uploaded for any month as long as the employee
  // already has attendance entries recorded for that month.

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let uploadedCount = 0;
    const recalc = new Map();
    for (const r of rows) {
      const month = String(r.month || r.Month || '').trim();
      if (!month) continue;

      const punchingId = String(r.punchingid || r.punchingId || r.punching_id || '').trim();
      const name = String(r.name || r.employee_name || r.EmployeeName || '').trim();
      const supName = String(r.supervisorname || r.supervisor_name || '').trim();
      const nights = parseInt(r.nights || r.Nights || r.night || 0, 10);
      if (!punchingId || !name || !nights) continue;
      let supervisorCondition = '';
      const params = [punchingId, name];
      if (supName) {
        const [[sup]] = await conn.query('SELECT id FROM users WHERE name = ? LIMIT 1', [supName]);
        if (sup) {
          supervisorCondition = ' AND supervisor_id = ?';
          params.push(sup.id);
        }
      }
      const [empRows] = await conn.query(
        `SELECT id, salary FROM employees WHERE punching_id = ? AND name = ?${supervisorCondition} LIMIT 1`,
        params
      );
      if (!empRows.length) continue;
      const empId = empRows[0].id;
      const [[attMonth]] = await conn.query(
        'SELECT 1 FROM employee_attendance WHERE employee_id = ? AND DATE_FORMAT(date, "%Y-%m") = ? LIMIT 1',
        [empId, month]
      );
      if (!attMonth) continue;

      const [existing] = await conn.query(
        'SELECT id FROM employee_nights WHERE employee_id = ? AND month = ? LIMIT 1',
        [empId, month]
      );
      if (existing.length) continue;

      await conn.query(
        'INSERT INTO employee_nights (employee_id, supervisor_name, supervisor_department, punching_id, employee_name, nights, month) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          empId,
          r.supervisorname || r.supervisor_name || '',
          r.supervisordepartment || r.department || '',
          punchingId,
          name,
          nights,
          month
        ]
      );
      recalc.set(`${empId}_${month}`, { id: empId, month });

      uploadedCount++;
    }
    for (const { id, month } of recalc.values()) {
      await calculateSalaryForMonth(conn, id, month);
    }
    await conn.commit();
    req.flash('success', `Night data uploaded for ${uploadedCount} employees`);
  } catch (err) {
    await conn.rollback();
    console.error('Error processing night data:', err);
    req.flash('error', 'Failed to process night data');
  } finally {
    conn.release();
  }

  res.redirect('/operator/departments');
});


// GET night shift Excel template
router.get('/salary/night-template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('NightTemplate');
    sheet.columns = [
      { header: 'supervisorname', key: 'supervisorname', width: 20 },
      { header: 'supervisordepartment', key: 'supervisordepartment', width: 20 },
      { header: 'punchingid', key: 'punchingid', width: 15 },
      { header: 'name', key: 'name', width: 20 },
      { header: 'nights', key: 'nights', width: 10 },
      { header: 'month', key: 'month', width: 12 }
    ];
    res.setHeader('Content-Disposition', 'attachment; filename="NightShiftTemplate.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Error downloading night template:', err);
    req.flash('error', 'Error downloading night template');
    return res.redirect('/operator/departments');
  }
});

// GET advance Excel template
router.get('/salary/advance-template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('AdvanceTemplate');
    sheet.columns = [
      { header: 'employeeid', key: 'employeeid', width: 12 },
      { header: 'punchingid', key: 'punchingid', width: 15 },
      { header: 'name', key: 'name', width: 20 },
      { header: 'amount', key: 'amount', width: 10 },
      { header: 'reason', key: 'reason', width: 20 }
    ];
    res.setHeader('Content-Disposition', 'attachment; filename="AdvanceTemplate.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Error downloading advance template:', err);
    req.flash('error', 'Error downloading advance template');
    return res.redirect('/operator/departments');
  }
});

// GET advance deduction Excel template
router.get('/salary/advance-deduction-template', isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('AdvanceDeductionTemplate');
    sheet.columns = [
      { header: 'employeeid', key: 'employeeid', width: 12 },
      { header: 'punchingid', key: 'punchingid', width: 15 },
      { header: 'name', key: 'name', width: 20 },
      { header: 'month', key: 'month', width: 10 },
      { header: 'amount', key: 'amount', width: 10 }
    ];
    res.setHeader('Content-Disposition', 'attachment; filename="AdvanceDeductionTemplate.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err) {
    console.error('Error downloading advance deduction template:', err);
    req.flash('error', 'Error downloading advance deduction template');
    return res.redirect('/operator/departments');
  }
});

// POST advance Excel upload
router.post('/salary/upload-advances', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
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
    let uploadedCount = 0;
    for (const r of rows) {
      const empIdInput = parseInt(r.employeeid || r.employee_id || r.empid || r.id || 0, 10);
      let empId = null;
      if (empIdInput) {
        const [[emp]] = await conn.query('SELECT id FROM employees WHERE id = ? LIMIT 1', [empIdInput]);
        if (emp) empId = emp.id;
      }
      if (!empId) {
        const punchingId = String(r.punchingid || r.punchingId || r.punching_id || '').trim();
        const name = String(r.name || r.employee_name || '').trim();
        if (!punchingId || !name) continue;
        const [[emp]] = await conn.query('SELECT id FROM employees WHERE punching_id = ? AND name = ? LIMIT 1', [punchingId, name]);
        if (!emp) continue;
        empId = emp.id;
      }
      const amount = parseFloat(r.amount || r.advance || 0);
      if (!amount) continue;
      await conn.query('INSERT INTO employee_advances (employee_id, amount, reason) VALUES (?, ?, ?)', [empId, amount, r.reason || null]);
      uploadedCount++;
    }
    await conn.commit();
    req.flash('success', `Advance data uploaded for ${uploadedCount} employees`);
  } catch (err) {
    await conn.rollback();
    console.error('Error processing advance data:', err);
    req.flash('error', 'Failed to process advance data');
  } finally {
    conn.release();
  }

  res.redirect('/operator/departments');
});

// POST advance deduction Excel upload
router.post('/salary/upload-advance-deductions', isAuthenticated, isOperator, upload.single('excelFile'), async (req, res) => {
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
    let uploadedCount = 0;
    for (const r of rows) {
      const empIdInput = parseInt(r.employeeid || r.employee_id || r.empid || r.id || 0, 10);
      let empId = null;
      if (empIdInput) {
        const [[emp]] = await conn.query('SELECT id FROM employees WHERE id = ? LIMIT 1', [empIdInput]);
        if (emp) empId = emp.id;
      }
      let punchingId = '';
      let name = '';
      if (!empId) {
        punchingId = String(r.punchingid || r.punchingId || r.punching_id || '').trim();
        name = String(r.name || r.employee_name || '').trim();
        if (!punchingId || !name) continue;
        const [[emp]] = await conn.query('SELECT id FROM employees WHERE punching_id = ? AND name = ? LIMIT 1', [punchingId, name]);
        if (!emp) continue;
        empId = emp.id;
      }
      const month = String(r.month || '').trim();
      const amount = parseFloat(r.amount || r.deduction || 0);
      if (!month || !amount) continue;
      const [[sal]] = await conn.query('SELECT id, gross, deduction FROM employee_salaries WHERE employee_id = ? AND month = ? LIMIT 1', [empId, month]);
      if (!sal) continue;
      const [[exists]] = await conn.query('SELECT id FROM advance_deductions WHERE employee_id = ? AND month = ? LIMIT 1', [empId, month]);
      if (exists) continue;
      const newDed = parseFloat(sal.deduction) + amount;
      const net = parseFloat(sal.gross) - newDed;
      await conn.query('UPDATE employee_salaries SET deduction = ?, net = ? WHERE id = ?', [newDed, net, sal.id]);
      await conn.query('INSERT INTO advance_deductions (employee_id, month, amount) VALUES (?, ?, ?)', [empId, month, amount]);
      uploadedCount++;
    }
    await conn.commit();
    req.flash('success', `Advance deductions uploaded for ${uploadedCount} employees`);
  } catch (err) {
    await conn.rollback();
    console.error('Error processing advance deductions:', err);
    req.flash('error', 'Failed to process advance deductions');
  } finally {
    conn.release();
  }

  res.redirect('/operator/departments');
});


// View salary summary for operator
router.get('/salaries', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.username AS supervisor_name, u.id AS supervisor_id,
             COUNT(e.id) AS employee_count,
             SUM(CASE WHEN e.is_active = 1 THEN e.salary ELSE 0 END) AS total_salary
        FROM users u
        JOIN employees e ON e.supervisor_id = u.id
       GROUP BY u.id`);
    res.render('operatorSalaries', { user: req.session.user, summary: rows });
  } catch (err) {
    console.error('Error loading salary summary:', err);
    req.flash('error', 'Could not load salary summary');
    res.redirect('/dashboard');
  }

});

// Supervisor view of employee salary
router.get('/employees/:id/salary', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const month = req.query.month || moment().format('YYYY-MM');
  const half = parseInt(req.query.half, 10) === 2 ? 2 : 1;
  try {
    const [[emp]] = await pool.query(
      `SELECT e.*, d.name AS department
         FROM employees e
         LEFT JOIN (
               SELECT user_id, MIN(department_id) AS department_id
                 FROM department_supervisors
                GROUP BY user_id
         ) ds ON ds.user_id = e.supervisor_id
         LEFT JOIN departments d ON ds.department_id = d.id
        WHERE e.id = ? AND e.supervisor_id = ?`,
      [empId, req.session.user.id]
    );
    if (!emp) {
      req.flash('error', 'Employee not found');
      return res.redirect('/supervisor/employees');
    }
    const specialDept = SPECIAL_DEPARTMENTS.includes(
      (emp.department || '').toLowerCase()
    );
    let startDate = moment(month + '-01').format('YYYY-MM-DD');
    let endDate;
    if (emp.salary_type === 'dihadi') {
      if (half === 2) {
        startDate = moment(month + '-16').format('YYYY-MM-DD');
        endDate = moment(month + '-01').endOf('month').format('YYYY-MM-DD');
      } else {
        endDate = moment(month + '-15').format('YYYY-MM-DD');
      }
    } else {
      endDate = moment(month + '-01').endOf('month').format('YYYY-MM-DD');
    }
    const [attendance] = await pool.query('SELECT * FROM employee_attendance WHERE employee_id = ? AND date BETWEEN ? AND ? ORDER BY date', [empId, startDate, endDate]);
    const daysInMonth = moment(month + '-01').daysInMonth();
    const dailyRate = parseFloat(emp.salary) / daysInMonth;
    let totalHours = 0;
    let hourlyRate = 0;
    let overtimeTotal = 0;
    let undertimeTotal = 0;
    if (emp.salary_type === 'dihadi') {
      hourlyRate = emp.allotted_hours
        ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours)
        : 0;
    }
    let paidUsed = 0;
    attendance.forEach(a => {
      if (a.punch_in && a.punch_out) {
        const hrsDec = effectiveHours(a.punch_in, a.punch_out, emp.salary_type);
        a.hours = formatHours(hrsDec);
        a.lunch_deduction = lunchDeduction(a.punch_in, a.punch_out, emp.salary_type);
        if (emp.salary_type === 'monthly') {
          const diff = hrsDec - parseFloat(emp.allotted_hours || 0);
          if (diff > 0) {
            a.overtime = formatHours(diff);
            a.undertime = '00:00';
            overtimeTotal += diff;
          } else if (diff < 0) {
            a.overtime = '00:00';
            a.undertime = formatHours(Math.abs(diff));
            undertimeTotal += Math.abs(diff);
          } else {
            a.overtime = '00:00';
            a.undertime = '00:00';
          }
        }
        if (emp.salary_type === 'dihadi') {
          totalHours += hrsDec;
        }
      } else {
        a.hours = '00:00';
        a.lunch_deduction = 0;
        if (emp.salary_type === 'monthly') {
          a.overtime = '00:00';
          a.undertime = '00:00';
        }
      }
      const isSun = moment(a.date).day() === 0;
      if (isSun && emp.salary_type !== 'dihadi') {
        if (a.status === 'present' && a.punch_in && a.punch_out) {
          const hrsWorked = effectiveHours(a.punch_in, a.punch_out, 'monthly');
          if (hrsWorked > 0) {
            if (specialDept) {
              a.deduction_reason = 'Leave credited';
            } else if (paidUsed < (emp.paid_sunday_allowance || 0)) {
              a.deduction_reason = 'Paid Sunday';
              paidUsed++;
            } else {
              a.deduction_reason = 'Leave credited';
            }
          } else {
            a.deduction_reason = '';
          }
        } else {
          a.deduction_reason = '';
        }

        if (
          emp.salary_type === 'dihadi' &&
          a.punch_in &&
          moment(a.punch_in, 'HH:mm:ss').isAfter(moment('09:15:00', 'HH:mm:ss'))
        ) {
          a.deduction_reason +=
            (a.deduction_reason ? '; ' : '') + 'Late arrival after 09:15';
        }
      } else {
        if (a.status === 'absent') {
          a.deduction_reason = 'Absent from work';
        } else if (a.status === 'one punch only') {
          a.deduction_reason = 'Missing punch in/out';
        } else {
          a.deduction_reason = '';
        }
        if (
          emp.salary_type === 'monthly' &&
          a.punch_in &&
          a.punch_out &&
          emp.allotted_hours &&
          effectiveHours(a.punch_in, a.punch_out, 'monthly') <
            parseFloat(emp.allotted_hours) * 0.55
        ) {
          a.deduction_reason += (a.deduction_reason ? '; ' : '') +
            'Worked less than half day';
        }

        if (
          emp.salary_type === 'dihadi' &&
          a.punch_in &&
          moment(a.punch_in, 'HH:mm:ss').isAfter(moment('09:15:00', 'HH:mm:ss'))
        ) {
          a.deduction_reason += (a.deduction_reason ? '; ' : '') +
            'Late arrival after 09:15';
        }
      }
    });
    let totalHoursFormatted = null;
    if (emp.salary_type === 'dihadi') {
      totalHoursFormatted = formatHours(totalHours);
    }
    let overtimeFormatted = null;
    let undertimeFormatted = null;
    if (emp.salary_type === 'monthly') {
      overtimeFormatted = formatHours(overtimeTotal);
      undertimeFormatted = formatHours(undertimeTotal);
    }
    let partialAmount = null;
    if (emp.salary_type === 'dihadi') {
      partialAmount = parseFloat((totalHours * hourlyRate).toFixed(2));
    }
    const [[salary]] = await pool.query('SELECT * FROM employee_salaries WHERE employee_id = ? AND month = ? LIMIT 1', [empId, month]);
    const [[adv]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM employee_advances WHERE employee_id = ?', [empId]);
    const [[ded]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS total FROM advance_deductions WHERE employee_id = ?', [empId]);
    const outstanding = parseFloat(adv.total) - parseFloat(ded.total);
    res.render('employeeSalary', {
      user: req.session.user,
      employee: emp,
      attendance,
      salary,
      month,
      dailyRate,
      totalHours: totalHoursFormatted,
      hourlyRate,
      half,
      outstanding,
      overtimeFormatted,
      undertimeFormatted,
      partialAmount
    });
  } catch (err) {
    console.error('Error loading salary view:', err);
    req.flash('error', 'Failed to load salary');
    res.redirect('/supervisor/employees');
  }
});

// Supervisor download of employee salary sheet
router.get('/supervisor/salary/download', isAuthenticated, isSupervisor, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const supervisorId = req.session.user.id;
  try {
    const [sandwichRows] = await pool.query(
      'SELECT date FROM sandwich_dates WHERE DATE_FORMAT(date, "%Y-%m") = ?',
      [month]
    );
    const sandwichDates = sandwichRows.map(r => moment(r.date).format('YYYY-MM-DD'));

    const [rows] = await pool.query(`
      SELECT es.employee_id, es.gross, es.deduction, es.net, es.month,
             e.punching_id, e.name AS employee_name, e.salary AS base_salary,
             e.paid_sunday_allowance, e.allotted_hours,
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
       WHERE es.month = ? AND e.is_active = 1 AND e.salary_type = 'monthly' AND e.supervisor_id = ?
       ORDER BY e.name
    `, [month, supervisorId]);

    for (const r of rows) {
      const [attRows] = await pool.query(
        'SELECT date, status, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND DATE_FORMAT(date, "%Y-%m") = ? ORDER BY date',
        [r.employee_id, month]
      );
      const attMap = {};
      attRows.forEach(a => {
        attMap[moment(a.date).format('YYYY-MM-DD')] = a.status;
      });
      let absent = 0, onePunch = 0, sundayAbs = 0;
      let otHours = 0, utHours = 0, otDays = 0, utDays = 0;
      let workingDays = 0;
      const missPunchDates = [];
      const absentDates = [];
      attRows.forEach(a => {
        const dateStr = moment(a.date).format('YYYY-MM-DD');
        const status = a.status;
        const isSun = moment(a.date).day() === 0;
        const isSandwich = sandwichDates.includes(dateStr);
        if (status === 'present' && a.punch_in && a.punch_out) {
          workingDays++;
        } else if (status === 'one punch only') {
          missPunchDates.push(dateStr);
        } else if (status === 'absent') {
          absentDates.push(dateStr);
        }
        if (isSun) {
          const satStatus = attMap[moment(a.date).subtract(1, 'day').format('YYYY-MM-DD')] || 'absent';
          const monStatus = attMap[moment(a.date).add(1, 'day').format('YYYY-MM-DD')] || 'absent';
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
          const diff = hrs - parseFloat(r.allotted_hours || 0);
          if (diff > 0) { otHours += diff; otDays++; }
          else if (diff < 0) { utHours += Math.abs(diff); utDays++; }
        }
      });
      const notes = [];
      if (absent) notes.push(`${absent} day(s) absent`);
      if (onePunch) notes.push(`${onePunch} day(s) with missing punch`);
      if (sundayAbs) notes.push(`${sundayAbs} Sunday absence(s)`);
      r.deduction_reason = notes.join(', ');
      r.overtime_hours = otHours.toFixed(2);
      r.overtime_days = otDays;
      r.undertime_hours = utHours.toFixed(2);
      r.undertime_days = utDays;
      r.time_status = otHours > utHours ? 'overtime' : utHours > otHours ? 'undertime' : 'even';
      r.working_days = workingDays;
      r.miss_punch_dates = missPunchDates;
      r.absent_dates = absentDates;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Salary');
    sheet.columns = [
      { header: 'Supervisor', key: 'supervisor', width: 20 },
      { header: 'Department', key: 'department', width: 15 },
      { header: 'Punching ID', key: 'punching_id', width: 15 },
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Salary', key: 'salary', width: 10 },
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Gross', key: 'gross', width: 10 },
      { header: 'Deduction', key: 'deduction', width: 12 },
      { header: 'Advance Taken', key: 'advance_taken', width: 12 },
      { header: 'Advance Deducted', key: 'advance_deducted', width: 12 },
      { header: 'Net', key: 'net', width: 10 },
      { header: 'Working Days', key: 'working_days', width: 12 },
      { header: 'Miss Punch Dates', key: 'miss_punch_dates', width: 25 },
      { header: 'Absent Dates', key: 'absent_dates', width: 25 }
    ];
    rows.forEach(r => {
      sheet.addRow({
        supervisor: r.supervisor_name,
        department: r.department_name || '',
        punching_id: r.punching_id,
        employee: r.employee_name,
        salary: r.base_salary,
        month: r.month,
        gross: r.gross,
        deduction: r.deduction,
        advance_taken: r.advance_taken,
        advance_deducted: r.advance_deducted,
        net: r.net,
        working_days: r.working_days,
        miss_punch_dates: r.miss_punch_dates.join(', '),
        absent_dates: r.absent_dates.join(', ')
      });
    });
    res.setHeader('Content-Disposition', 'attachment; filename="SalarySummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading salary:', err);
    req.flash('error', 'Could not download salary');
    res.redirect('/supervisor/employees');
  }
});

router.post('/employees/:id/salary/deduct-advance', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const { month, amount } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[latest]] = await conn.query('SELECT month, id, gross, deduction FROM employee_salaries WHERE employee_id = ? ORDER BY month DESC LIMIT 1', [empId]);
    if (!latest || latest.month !== month) {
      req.flash('error', 'Can only deduct from the latest salary record');
      await conn.rollback();
      conn.release();
      return res.redirect(`/employees/${empId}/salary?month=${month}`);
    }
    const [[exists]] = await conn.query('SELECT id FROM advance_deductions WHERE employee_id = ? AND month = ? LIMIT 1', [empId, month]);
    if (exists) {
      req.flash('error', 'Advance already deducted for this salary');
      await conn.rollback();
      conn.release();
      return res.redirect(`/employees/${empId}/salary?month=${month}`);
    }
    const [[adv]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM employee_advances WHERE employee_id = ?', [empId]);
    const [[ded]] = await conn.query('SELECT COALESCE(SUM(amount),0) AS total FROM advance_deductions WHERE employee_id = ?', [empId]);
    const outstanding = parseFloat(adv.total) - parseFloat(ded.total);
    const amt = parseFloat(amount);
    if (amt <= 0 || amt > outstanding) {
      req.flash('error', 'Invalid deduction amount');
      await conn.rollback();
      conn.release();
      return res.redirect(`/employees/${empId}/salary?month=${month}`);
    }
    const newDed = parseFloat(latest.deduction) + amt;
    const net = parseFloat(latest.gross) - newDed;
    await conn.query('UPDATE employee_salaries SET deduction = ?, net = ? WHERE id = ?', [newDed, net, latest.id]);
    await conn.query('INSERT INTO advance_deductions (employee_id, month, amount) VALUES (?, ?, ?)', [empId, month, amt]);
    await conn.commit();
    req.flash('success', 'Advance deducted');
  } catch (err) {
    await conn.rollback();
    console.error('Error deducting advance:', err);
    req.flash('error', 'Failed to deduct advance');
  } finally {
    conn.release();
  }
  res.redirect(`/employees/${empId}/salary?month=${month}`);
});

module.exports = router;
