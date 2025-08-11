const moment = require('moment');
// Removed monthly salary utilities; only moment is required for dihadi calculations.

function lunchDeduction(
  punchIn,
  punchOut,
  salaryType = 'dihadi',
  allottedHours = null
) {
  if (salaryType !== 'dihadi') return 0;
  const out = moment(punchOut, 'HH:mm:ss');
  const firstCut = moment('13:10:00', 'HH:mm:ss');
  const secondCut = moment('18:10:00', 'HH:mm:ss');
  const start = moment(punchIn, 'HH:mm:ss');

  const baseHours = allottedHours ? parseFloat(allottedHours) : 9;
  const shiftStart = moment('09:00:00', 'HH:mm:ss');
  const threshold = baseHours * 60 * 0.4;
  const after40 = start.diff(shiftStart, 'minutes') >= threshold;

  if (after40) {
    if (out.isSameOrBefore(firstCut)) return 0;
    return 30;
  }

  if (out.isSameOrBefore(firstCut)) return 0;
  if (out.isSameOrBefore(secondCut)) return 30;
  return 60;
}
exports.lunchDeduction = lunchDeduction;

function crossedLunch(punchIn, punchOut) {
  const start = moment(punchIn, 'HH:mm:ss');
  const end = moment(punchOut, 'HH:mm:ss');
  const lunch = moment('13:10:00', 'HH:mm:ss');
  return start.isSameOrBefore(lunch) && end.isAfter(lunch);
}
exports.crossedLunch = crossedLunch;

function effectiveHours(punchIn, punchOut, salaryType = 'dihadi', allottedHours = null) {
  const start = moment(punchIn, 'HH:mm:ss');
  const end = moment(punchOut, 'HH:mm:ss');
  let mins = end.diff(start, 'minutes');
  mins -= lunchDeduction(punchIn, punchOut, salaryType, allottedHours);

  // Deduct for late arrival after the 15 minute grace period
  // For dihadi workers the deduction is a flat hour unless
  // they arrive after 40% of their allotted hours, in which
  // case no late deduction applies.
  if (salaryType === 'dihadi') {
    const grace = moment('09:15:00', 'HH:mm:ss');
    const shiftStart = moment('09:00:00', 'HH:mm:ss');
    const baseHours = allottedHours ? parseFloat(allottedHours) : 9;
    const threshold = baseHours * 60 * 0.4; // 40% of the shift
    const after40 = start.diff(shiftStart, 'minutes') >= threshold;
    if (start.isAfter(grace) && !after40) {
      mins -= 60;
    }
  }

  // Cap daily hours at 11 only for dihadi workers
  if (salaryType === 'dihadi' && mins > 11 * 60) mins = 11 * 60;
  if (mins < 0) mins = 0;
  return mins / 60;
}
exports.effectiveHours = effectiveHours;



async function calculateSalaryForMonth(conn, employeeId, month) {
  const [[emp]] = await conn.query(
    'SELECT salary, salary_type, allotted_hours, date_of_joining FROM employees WHERE id = ?',
    [employeeId]
  );
  if (!emp || emp.salary_type !== 'dihadi') return;
  await calculateDihadiMonthly(conn, employeeId, month, emp);
}

// Dihadi workers are paid purely on hours worked. Grab all attendance
// for the month and multiply the total hours by the hourly rate.
async function calculateDihadiMonthly(conn, employeeId, month, emp) {
  const monthStart = moment(month + '-01');
  const join = emp.date_of_joining ? moment(emp.date_of_joining) : null;
  const start = join && join.isAfter(monthStart) ? join.format('YYYY-MM-DD') : monthStart.format('YYYY-MM-DD');
  const [attendance] = await conn.query(
    'SELECT punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date >= ? AND DATE_FORMAT(date, "%Y-%m") = ?',
    [employeeId, start, month]
  );
  const hourlyRate = emp.allotted_hours ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours) : 0;
  let totalHours = 0;
  for (const a of attendance) {
    if (!a.punch_in || !a.punch_out) continue;
    totalHours += effectiveHours(a.punch_in, a.punch_out, 'dihadi', emp.allotted_hours);
  }
  const gross = parseFloat((totalHours * hourlyRate).toFixed(2));
  const [[advRow]] = await conn.query(
    'SELECT COALESCE(SUM(amount),0) AS total FROM advance_deductions WHERE employee_id = ? AND month = ?',
    [employeeId, month]
  );
  const advDeduct = parseFloat(advRow.total) || 0;
  const net = gross - advDeduct;
  await conn.query(
    "INSERT INTO employee_salaries (employee_id, month, gross, deduction, net, created_at) VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE gross=VALUES(gross), deduction=VALUES(deduction), net=VALUES(net)",
    [employeeId, month, gross, advDeduct, net]
  );
}

exports.calculateSalaryForMonth = calculateSalaryForMonth;
