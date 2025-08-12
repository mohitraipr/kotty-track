const moment = require('moment');

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
  const shiftStart = moment('09:00:00', 'HH:mm:ss');
  const grace = moment('09:15:00', 'HH:mm:ss');

  // For monthly salaried workers arriving within the 15 minute grace
  // period, treat the start as 09:00 so that a punch at 09:15 and an
  // exit at 18:00 counts as nine hours.
  let calcStart = start;
  if (salaryType !== 'dihadi' && start.isSameOrBefore(grace)) {
    calcStart = shiftStart;
  }

  let mins = end.diff(calcStart, 'minutes');
  mins -= lunchDeduction(punchIn, punchOut, salaryType, allottedHours);

  // Deduct for late arrival after the 15 minute grace period
  // For dihadi workers the deduction is a flat hour unless
  // they arrive after 40% of their allotted hours, in which
  // case no late deduction applies.
  if (salaryType === 'dihadi') {
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
    'SELECT salary, salary_type, allotted_hours, date_of_joining, pay_sunday FROM employees WHERE id = ?',
    [employeeId]
  );
  if (!emp) return;
  if (emp.salary_type === 'dihadi') {
    await calculateDihadiMonthly(conn, employeeId, month, emp);
  } else {
    await calculateMonthly(conn, employeeId, month, emp);
  }
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

// Monthly salaried workers are paid based on the hours they work in the
// month. The hourly rate is derived from their monthly salary by
// dividing by the number of days in the month and then by the allotted
// hours per day. Worked Sundays use a fixed nine-hour divisor for their
// hourly rate instead of the employee's allotted hours. A non-worked
// Sunday only earns the normal day rate if the sandwich rule applies.
async function calculateMonthly(conn, employeeId, month, emp) {
  const monthStart = moment(month + '-01');
  const join = emp.date_of_joining ? moment(emp.date_of_joining) : null;
  const start =
    join && join.isAfter(monthStart)
      ? join.format('YYYY-MM-DD')
      : monthStart.format('YYYY-MM-DD');
  const daysInMonth = monthStart.daysInMonth();
  const dayRate = parseFloat(emp.salary) / daysInMonth;
  const hourlyRate = emp.allotted_hours
    ? dayRate / parseFloat(emp.allotted_hours)
    : 0;
  const [attendance] = await conn.query(
    'SELECT date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date >= ? AND DATE_FORMAT(date, "%Y-%m") = ?',
    [employeeId, start, month]
  );

  // Build a map of worked days to their effective hours
  const worked = new Map();
  for (const a of attendance) {
    if (!a.punch_in || !a.punch_out) continue;
    const hrs = effectiveHours(a.punch_in, a.punch_out, 'monthly', emp.allotted_hours);
    if (hrs <= 0) continue;
    const dateStr = moment(a.date).format('YYYY-MM-DD');
    worked.set(dateStr, hrs);
  }

  const startDate = moment(start, 'YYYY-MM-DD');
  const monthEnd = monthStart.clone().endOf('month');
  let weekdayHours = 0;
  let sundayHours = 0;
  let sundayPaidDays = 0; // Sundays paid via sandwich rule

  for (let day = startDate.clone(); day.isSameOrBefore(monthEnd); day.add(1, 'day')) {
    const dateStr = day.format('YYYY-MM-DD');
    const hours = worked.get(dateStr) || 0;
    if (day.day() === 0) {
      const sat = day.clone().subtract(1, 'day');
      const mon = day.clone().add(1, 'day');
      const satWorked = sat.isBefore(startDate) || worked.has(sat.format('YYYY-MM-DD'));
      const monWorked = mon.isAfter(monthEnd) || worked.has(mon.format('YYYY-MM-DD'));

      if (hours > 0) {
        sundayHours += hours;
      } else if (satWorked && monWorked) {
        sundayPaidDays++;
      }
    } else if (hours > 0) {
      weekdayHours += hours;
    }
  }
  let gross =
    weekdayHours * hourlyRate +
    sundayHours * hourlyRate * 2 +
    sundayPaidDays * dayRate;
  gross = parseFloat(gross.toFixed(2));
    const [[advRow]] = await conn.query(
    'SELECT COALESCE(SUM(amount),0) AS total FROM advance_deductions WHERE employee_id = ? AND month = ?',
    [employeeId, month]
  );
  const advDeduct = parseFloat(advRow.total) || 0;
  const net = gross - advDeduct;
  await conn.query(
    'INSERT INTO employee_salaries (employee_id, month, gross, deduction, net, created_at) VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE gross=VALUES(gross), deduction=VALUES(deduction), net=VALUES(net)',
    [employeeId, month, gross, advDeduct, net]
  );
}
