const moment = require('moment');
const { SPECIAL_DEPARTMENTS } = require('../utils/departments');

function lunchDeduction(punchIn, punchOut, salaryType = 'dihadi') {
  if (salaryType !== 'dihadi') return 0;
  const out = moment(punchOut, 'HH:mm:ss');
  const firstCut = moment('13:10:00', 'HH:mm:ss');
  const secondCut = moment('18:10:00', 'HH:mm:ss');
  if (out.isSameOrBefore(firstCut)) return 0;
  if (out.isSameOrBefore(secondCut)) return 30;
  return 60;
}
exports.lunchDeduction = lunchDeduction;

function effectiveHours(punchIn, punchOut, salaryType = 'dihadi') {
  const start = moment(punchIn, 'HH:mm:ss');
  const end = moment(punchOut, 'HH:mm:ss');
  let mins = end.diff(start, 'minutes');
  mins -= lunchDeduction(punchIn, punchOut, salaryType);
  if (mins > 11 * 60) mins = 11 * 60;
  if (mins < 0) mins = 0;
  return mins / 60;
}
exports.effectiveHours = effectiveHours;



async function calculateSalaryForMonth(conn, employeeId, month) {
  const [[emp]] = await conn.query(
    `SELECT e.salary, e.salary_type, e.paid_sunday_allowance, e.allotted_hours,
            e.date_of_joining,
            d.name AS department
       FROM employees e
       LEFT JOIN (
             SELECT user_id, MIN(department_id) AS department_id
               FROM department_supervisors
              GROUP BY user_id
       ) ds ON ds.user_id = e.supervisor_id
       LEFT JOIN departments d ON ds.department_id = d.id
      WHERE e.id = ?`,
    [employeeId]
  );
  if (!emp) return;
  const specialDept = SPECIAL_DEPARTMENTS.includes(
    (emp.department || '').toLowerCase()
  );
  if (emp.salary_type === 'dihadi') {
    await calculateDihadiMonthly(conn, employeeId, month, emp);
    return;
  }
  const [attendance] = await conn.query(
    'SELECT date, status FROM employee_attendance WHERE employee_id = ? AND DATE_FORMAT(date, "%Y-%m") = ?',
    [employeeId, month]
  );
  const [sandwichRows] = await conn.query(
    'SELECT date FROM sandwich_dates WHERE DATE_FORMAT(date, "%Y-%m") = ?',
    [month]
  );
  const daysInMonth = moment(month + '-01').daysInMonth();
  const dailyRate = parseFloat(emp.salary) / daysInMonth;
  const sandwichDates = sandwichRows.map(r => moment(r.date).format('YYYY-MM-DD'));
  const attMap = {};
  attendance.forEach(a => {
    attMap[moment(a.date).format('YYYY-MM-DD')] = a.status;
  });

  let absent = 0;
  let extraPay = 0;
  let paidUsed = 0;
  const creditLeaves = [];

  attendance.forEach(a => {
    const dateStr = moment(a.date).format('YYYY-MM-DD');
    const status = a.status;
    const isSun = moment(a.date).day() === 0;
    const isSandwich = sandwichDates.includes(dateStr);

    if (isSun) {
      const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
      const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
      const satStatus = attMap[satKey];
      const monStatus = attMap[monKey];
      const missedSat = satStatus === 'absent' || satStatus === 'one punch only';
      const missedMon = monStatus === 'absent' || monStatus === 'one punch only';
      if ((satStatus && missedSat) || (monStatus && missedMon)) {
        absent++;
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

    if (isSun) {
      if (status === 'present') {
        if (specialDept) {
          creditLeaves.push(dateStr);
        } else if (parseFloat(emp.salary) < 13500) {
          extraPay += dailyRate;
        } else if (paidUsed < (emp.paid_sunday_allowance || 0)) {
          extraPay += dailyRate;
          paidUsed++;
        } else {
          creditLeaves.push(dateStr);
        }
      }
    } else {
      if (status === 'absent' || status === 'one punch only') absent++;
    }
  });

  for (const d of creditLeaves) {
    const [rows] = await conn.query(
      'SELECT id FROM employee_leaves WHERE employee_id = ? AND leave_date = ?',
      [employeeId, d]
    );
    if (!rows.length) {
      await conn.query(
        'INSERT INTO employee_leaves (employee_id, leave_date, days, remark) VALUES (?, ?, 1, ?)',
        [employeeId, d, 'Sunday Credit']
      );
    }
  }

  const [nightRows] = await conn.query(
    'SELECT COALESCE(SUM(nights),0) AS total_nights FROM employee_nights WHERE employee_id = ? AND month = ?',
    [employeeId, month]
  );
  const nightPay = (parseFloat(nightRows[0].total_nights) || 0) * dailyRate;
  extraPay += nightPay;
  const gross = parseFloat(emp.salary) + extraPay;
  const deduction = absent * dailyRate;
  const net = gross - deduction;
  await conn.query(
    `INSERT INTO employee_salaries (employee_id, month, gross, deduction, net, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE gross=VALUES(gross), deduction=VALUES(deduction), net=VALUES(net)`,
    [employeeId, month, gross, deduction, net]
  );
}

async function calculateDihadiMonthly(conn, employeeId, month, emp) {
  const startDate = moment(month + '-01').format('YYYY-MM-DD');
  const endDate = moment(month + '-15').format('YYYY-MM-DD');
  const [attendance] = await conn.query(
    "SELECT date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date BETWEEN ? AND ?",
    [employeeId, startDate, endDate]
  );
  const hourlyRate = emp.allotted_hours ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours) : 0;
  let totalHours = 0;
  for (const a of attendance) {
    if (!a.punch_in || !a.punch_out) continue;
    totalHours += effectiveHours(a.punch_in, a.punch_out);
  }
  const gross = parseFloat((totalHours * hourlyRate).toFixed(2));
  await conn.query(
    "INSERT INTO employee_salaries (employee_id, month, gross, deduction, net, created_at) VALUES (?, ?, ?, 0, ?, NOW()) ON DUPLICATE KEY UPDATE gross=VALUES(gross), deduction=0, net=VALUES(net)",
    [employeeId, month, gross, gross]
  );
}

exports.calculateSalaryForMonth = calculateSalaryForMonth;
