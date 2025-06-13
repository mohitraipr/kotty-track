const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor, isOperator } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseAttendance } = require('../helpers/attendanceParser');

const upload = multer({ dest: path.join(__dirname, '../uploads') });

function format(date) {
  return date.toISOString().split('T')[0];
}

async function getLastAttendancePeriod(employeeId, salaryType) {
  const [rows] = await pool.query(
    'SELECT MAX(work_date) AS last_date FROM employee_daily_hours WHERE employee_id=?',
    [employeeId]
  );
  let last = rows[0].last_date ? new Date(rows[0].last_date) : new Date();
  const year = last.getFullYear();
  const month = last.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  let start, end;
  if (salaryType === 'dihadi') {
    if (last.getDate() <= 15) {
      start = new Date(year, month, 1);
      end = new Date(year, month, 15);
    } else {
      start = new Date(year, month, 16);
      end = new Date(year, month, daysInMonth);
    }
  } else {
    start = new Date(year, month, 1);
    end = new Date(year, month, daysInMonth);
  }
  const diffDays = Math.round((end - start) / (24 * 60 * 60 * 1000)) + 1;
  return { start, end, days: diffDays, daysInMonth };
}

async function getAttendanceHistory(employee) {
  if (!employee) return [];
  if (employee.salary_type === 'monthly') {
    const [periods] = await pool.query(
      `SELECT YEAR(work_date) AS yr, MONTH(work_date) AS mon
         FROM employee_daily_hours
        WHERE employee_id=?
        GROUP BY yr, mon
        ORDER BY yr DESC, mon DESC`,
      [employee.id]
    );
    const result = [];
    for (const p of periods) {
      const year = p.yr;
      const month = p.mon;
      const daysInMonth = new Date(year, month, 0).getDate();
      const start = new Date(year, month - 1, 1);
      const end = new Date(year, month - 1, daysInMonth);
      const [att] = await pool.query(
        'SELECT work_date, hours_worked FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date',
        [employee.id, format(start), format(end)]
      );
      const totalHours = att.reduce((s, r) => s + Number(r.hours_worked), 0);
      const hourly = employee.salary_amount / (employee.working_hours * daysInMonth);
      const salary = hourly * totalHours;
      const expected = employee.working_hours * daysInMonth;
      result.push({
        startDate: format(start),
        endDate: format(end),
        attendance: att,
        totalHours,
        salary,
        diff: totalHours - expected
      });
    }
    return result;
  }

  const [periods] = await pool.query(
    `SELECT YEAR(work_date) AS yr, MONTH(work_date) AS mon,
            CASE WHEN DAY(work_date)<=15 THEN 1 ELSE 16 END AS start_day
       FROM employee_daily_hours
      WHERE employee_id=?
      GROUP BY yr, mon, start_day
      ORDER BY yr DESC, mon DESC, start_day DESC`,
    [employee.id]
  );
  const result = [];
  for (const p of periods) {
    const year = p.yr;
    const month = p.mon;
    const startDay = p.start_day;
    const daysInMonth = new Date(year, month, 0).getDate();
    const endDay = startDay === 1 ? 15 : daysInMonth;
    const start = new Date(year, month - 1, startDay);
    const end = new Date(year, month - 1, endDay);
    const [att] = await pool.query(
      'SELECT work_date, hours_worked FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date',
      [employee.id, format(start), format(end)]
    );
    const totalHours = att.reduce((s, r) => s + Number(r.hours_worked), 0);
    const hourly = employee.salary_amount / employee.working_hours;
    const salary = hourly * totalHours;
    const days = endDay - startDay + 1;
    const expected = employee.working_hours * days;
    result.push({
      startDate: format(start),
      endDate: format(end),
      attendance: att,
      totalHours,
      salary,
      diff: totalHours - expected
    });
  }
  return result;
}

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
    for (const emp of employees) {
      const period = await getLastAttendancePeriod(emp.id, emp.salary_type);
      const [hrs] = await pool.query(
        'SELECT SUM(hours_worked) AS total FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ?',
        [emp.id, format(period.start), format(period.end)]
      );
      const total = hrs[0].total ? Number(hrs[0].total) : 0;
      const hourly = emp.salary_type === 'dihadi'
        ? emp.salary_amount / emp.working_hours
        : emp.salary_amount / (emp.working_hours * period.daysInMonth);
      emp.lastSalary = hourly * total;
    }
    res.render('supervisorEmployees', {
      user: req.session.user,
      employees
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

  try {
    const [dup] = await pool.query(
      'SELECT id FROM employees WHERE punching_id = ? AND created_by = ?',
      [punching_id, req.session.user.id]
    );
    if (dup.length > 0) {
      req.flash('error', 'Punching ID already exists for this supervisor.');
      return res.redirect('/supervisor/employees');
    }
  } catch (err) {
    console.error('Error checking duplicate punching ID:', err);
    req.flash('error', 'Failed to create employee.');
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
    if (err.code === 'ER_DUP_ENTRY') {
      req.flash('error', 'Punching ID already exists.');
    } else {
      req.flash('error', 'Failed to create employee.');
    }
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
      data: rows
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
    const selectedSupervisor = req.query.supervisor_id || '';
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
        ${selectedSupervisor ? 'WHERE e.created_by = ?' : ''}
        ORDER BY e.created_at DESC`,
      selectedSupervisor ? [selectedSupervisor] : []
    );
    res.render('operatorDepartments', {
      user: req.session.user,
      departments,
      supervisors,
      employees,
      selectedSupervisor
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

// POST /operator/upload-attendance - upload attendance sheet for a supervisor
router.post('/operator/upload-attendance', isAuthenticated, isOperator, upload.single('attendanceFile'), async (req, res) => {
  if (!req.file) {
    req.flash('error', 'Attendance file required.');
    return res.redirect('/operator/departments');
  }

  const base = path.parse(req.file.originalname).name;
  const parts = base.split(/[^a-zA-Z0-9]+/);
  if (parts.length < 3) {
    fs.unlink(req.file.path, () => {});
    req.flash('error', 'Filename must be department_username_userid.xlsx');
    return res.redirect('/operator/departments');
  }

  const deptName = parts[0];
  const supervisorUsername = parts[1];
  const supervisorId = parseInt(parts[2], 10);

  if (Number.isNaN(supervisorId)) {
    fs.unlink(req.file.path, () => {});
    req.flash('error', 'Invalid supervisor ID in file name.');
    return res.redirect('/operator/departments');
  }

  const conn = await pool.getConnection();
  try {
    const [sup] = await conn.query(
      `SELECT u.id, d.id AS dept_id
         FROM users u
         JOIN department_supervisors ds ON ds.supervisor_user_id=u.id AND ds.is_active=1
         JOIN departments d ON ds.department_id=d.id
        WHERE u.id=? AND u.username=? AND d.name=?`,
      [supervisorId, supervisorUsername, deptName]
    );

    if (!sup.length) {
      req.flash('error', 'Supervisor or department not found.');
      return res.redirect('/operator/departments');
    }

    const { employees, month, year } = parseAttendance(req.file.path);

    for (const emp of employees) {
      const [empRows] = await conn.query(
        'SELECT id FROM employees WHERE punching_id=? AND name=? AND created_by=?',
        [emp.punchingId, emp.name, supervisorId]
      );
      if (!empRows.length) continue;
      const employeeId = empRows[0].id;
      for (const day of emp.days) {
        if (!day.date) continue;
        await conn.query(
          `INSERT INTO employee_daily_hours (employee_id, work_date, hours_worked)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE hours_worked=VALUES(hours_worked)`,
          [employeeId, day.date, day.netHours]
        );
      }
    }
    req.flash('success', 'Attendance uploaded successfully.');
  } catch (err) {
    console.error('Error processing attendance:', err);
    req.flash('error', 'Failed to process attendance.');
  } finally {
    conn.release();
    fs.unlink(req.file.path, () => {});
  }

  res.redirect('/operator/departments');
});

// GET supervisor view of employee attendance
router.get('/supervisor/employees/:id/attendance', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const [rows] = await pool.query('SELECT * FROM employees WHERE id=? AND created_by=?', [empId, req.session.user.id]);
  if (!rows.length) {
    req.flash('error', 'Employee not found');
    return res.redirect('/supervisor/employees');
  }
  const employee = rows[0];
  const period = await getLastAttendancePeriod(empId, employee.salary_type);
  const [attendance] = await pool.query(
    'SELECT work_date, hours_worked FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date',
    [empId, format(period.start), format(period.end)]
  );
  const totalHours = attendance.reduce((sum, r) => sum + Number(r.hours_worked), 0);
  const expected = employee.working_hours * period.days;
  const diff = totalHours - expected;
  res.render('employeeAttendance', {
    user: req.session.user,
    employee,
    attendance,
    startDate: format(period.start),
    endDate: format(period.end),
    totalHours,
    diff,
    canEdit: false
  });
});

// GET supervisor salary according to attendance
router.get('/supervisor/employees/:id/salary', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const [rows] = await pool.query('SELECT * FROM employees WHERE id=? AND created_by=?', [empId, req.session.user.id]);
  if (!rows.length) {
    req.flash('error', 'Employee not found');
    return res.redirect('/supervisor/employees');
  }
  const employee = rows[0];
  const period = await getLastAttendancePeriod(empId, employee.salary_type);
  const [attendance] = await pool.query(
    'SELECT hours_worked FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ?',
    [empId, format(period.start), format(period.end)]
  );
  const totalHours = attendance.reduce((sum, r) => sum + Number(r.hours_worked), 0);
  const hourlyRate = employee.salary_type === 'dihadi'
    ? employee.salary_amount / employee.working_hours
    : employee.salary_amount / (employee.working_hours * period.daysInMonth);
  const salary = hourlyRate * totalHours;
  res.render('employeeSalary', {
    user: req.session.user,
    employee,
    startDate: format(period.start),
    endDate: format(period.end),
    totalHours,
    hourlyRate,
    salary
  });
});

// GET supervisor view of all attendance periods
router.get('/supervisor/employees/:id/history', isAuthenticated, isSupervisor, async (req, res) => {
  const empId = req.params.id;
  const [rows] = await pool.query('SELECT * FROM employees WHERE id=? AND created_by=?', [empId, req.session.user.id]);
  if (!rows.length) {
    req.flash('error', 'Employee not found');
    return res.redirect('/supervisor/employees');
  }
  const employee = rows[0];
  const periods = await getAttendanceHistory(employee);
  res.render('employeeHistory', {
    user: req.session.user,
    employee,
    periods
  });
});

// GET operator view/edit attendance
router.get('/operator/employees/:id/attendance', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.params.id;
  const [rows] = await pool.query('SELECT * FROM employees WHERE id=?', [empId]);
  if (!rows.length) {
    req.flash('error', 'Employee not found');
    return res.redirect('/operator/departments');
  }
  const employee = rows[0];
  const period = await getLastAttendancePeriod(empId, employee.salary_type);
  const [attendance] = await pool.query(
    'SELECT work_date, hours_worked FROM employee_daily_hours WHERE employee_id=? AND work_date BETWEEN ? AND ? ORDER BY work_date',
    [empId, format(period.start), format(period.end)]
  );
  const totalHours = attendance.reduce((sum, r) => sum + Number(r.hours_worked), 0);
  const expected = employee.working_hours * period.days;
  const diff = totalHours - expected;
  res.render('employeeAttendance', {
    user: req.session.user,
    employee,
    attendance,
    startDate: format(period.start),
    endDate: format(period.end),
    totalHours,
    diff,
    canEdit: true
  });
});

// POST operator add/update attendance
router.post('/operator/employees/:id/attendance', isAuthenticated, isOperator, async (req, res) => {
  const empId = req.params.id;
  const { date, hours } = req.body;
  if (!date || !hours) {
    req.flash('error', 'Date and hours required');
    return res.redirect(`/operator/employees/${empId}/attendance`);
  }
  try {
    await pool.query(
      'INSERT INTO employee_daily_hours (employee_id, work_date, hours_worked) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE hours_worked=VALUES(hours_worked)',
      [empId, date, hours]
    );
    req.flash('success', 'Attendance updated');
  } catch (err) {
    console.error('Error saving attendance:', err);
    req.flash('error', 'Failed to save attendance');
  }
  res.redirect(`/operator/employees/${empId}/attendance`);
});


module.exports = router;
