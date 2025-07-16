const moment = require('moment');
const { SPECIAL_DEPARTMENTS } = require('../utils/departments');
const { SPECIAL_SUNDAY_SUPERVISORS } = require('../utils/supervisors');
const { effectiveHours } = require('./salaryCalculator');

function applyDetailedStatus(attendance, emp, sandwichDates) {
  const attMap = {};
  attendance.forEach(a => {
    attMap[moment(a.date).format('YYYY-MM-DD')] = a.status;
  });
  const specialDept = SPECIAL_DEPARTMENTS.includes((emp.department || '').toLowerCase());
  const specialSup = SPECIAL_SUNDAY_SUPERVISORS.map(s => s.toLowerCase()).includes((emp.supervisor_name || '').toLowerCase());
  const skipAbsent = new Set();
  if (!specialSup) {
    attendance.forEach(a => {
      if (moment(a.date).day() !== 0) return;
      if (a.status !== 'present') return;
      const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
      const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
      const satStatus = attMap[satKey];
      const monStatus = attMap[monKey];
      if (satStatus && (satStatus === 'absent' || satStatus === 'one punch only')) skipAbsent.add(satKey);
      if (monStatus && (monStatus === 'absent' || monStatus === 'one punch only')) skipAbsent.add(monKey);
    });
  }
  let mandatoryUsed = 0;
  attendance.forEach(a => {
    const dateStr = moment(a.date).format('YYYY-MM-DD');
    if (skipAbsent.has(dateStr)) {
      a.detailed_status = 'Paid due to Sunday work';
      return;
    }
    const status = a.status;
    const isSun = moment(a.date).day() === 0;
    const isSandwich = !specialSup && sandwichDates.includes(dateStr);
    if (!specialSup && isSun) {
      const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
      const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
      const satStatus = attMap[satKey];
      const monStatus = attMap[monKey];
      const missedSat = satStatus === 'absent' || satStatus === 'one punch only';
      const missedMon = monStatus === 'absent' || monStatus === 'one punch only';

      if (status !== 'present' && (missedSat || missedMon)) {
        a.detailed_status = 'Absent (Sandwich)';
      } else if (!specialDept && status !== 'present' && mandatoryUsed < (emp.paid_sunday_allowance || 0)) {
        mandatoryUsed++;
        a.detailed_status = 'Absent (Mandatory)';
      } else if (status === 'present' && a.punch_in && a.punch_out && effectiveHours(a.punch_in, a.punch_out, 'monthly') > 0) {
        if (specialDept) {
          if (!skipAbsent.has(satKey) && !skipAbsent.has(monKey)) a.detailed_status = 'Leave credited';
          else a.detailed_status = 'Worked Sunday';
        } else if (mandatoryUsed < (emp.paid_sunday_allowance || 0)) {
          mandatoryUsed++;
          a.detailed_status = 'Worked Sunday';
        } else if (emp.pay_sunday) {
          a.detailed_status = 'Paid Sunday';
          skipAbsent.delete(monKey);
        } else if (!skipAbsent.has(satKey) && !skipAbsent.has(monKey)) {
          a.detailed_status = 'Leave credited';
        } else {
          a.detailed_status = 'Worked Sunday';
        }
      } else {
        a.detailed_status = status.charAt(0).toUpperCase() + status.slice(1);
      }
    } else if (specialSup && isSun) {
      const satKey = moment(a.date).subtract(1, 'day').format('YYYY-MM-DD');
      const monKey = moment(a.date).add(1, 'day').format('YYYY-MM-DD');
      const satStatus = attMap[satKey];
      const monStatus = attMap[monKey];
      const missedSat = satStatus === 'absent' || satStatus === 'one punch only';
      const missedMon = monStatus === 'absent' || monStatus === 'one punch only';
      if (status !== 'present' && missedSat && missedMon) {
        a.detailed_status = 'Absent (Sandwich)';
      } else if (status === 'present' && a.punch_in && a.punch_out && effectiveHours(a.punch_in, a.punch_out, 'monthly') > 0) {
        a.detailed_status = 'Paid Sunday';
      } else {
        a.detailed_status = status.charAt(0).toUpperCase() + status.slice(1);
      }
    } else {
      if (isSandwich) {
        const prevStatus = attMap[moment(a.date).subtract(1, 'day').format('YYYY-MM-DD')];
        const nextStatus = attMap[moment(a.date).add(1, 'day').format('YYYY-MM-DD')];
        const adjAbsent = (prevStatus === 'absent' || prevStatus === 'one punch only') ||
                          (nextStatus === 'absent' || nextStatus === 'one punch only');
        if (adjAbsent) {
          a.detailed_status = 'Absent (Sandwich)';
          return;
        }
      }
      if (status === 'present' && a.punch_in && a.punch_out && emp.allotted_hours) {
        const hrs = effectiveHours(a.punch_in, a.punch_out, 'monthly');
        const allotted = parseFloat(emp.allotted_hours);
        if (hrs < allotted * 0.4) {
          a.detailed_status = 'Absent (Short hours)';
        } else if (hrs < allotted * 0.85) {
          a.detailed_status = 'Half Day';
        } else {
          a.detailed_status = 'Present';
        }
      } else if (status === 'absent') {
        a.detailed_status = 'Absent';
      } else if (status === 'one punch only') {
        a.detailed_status = 'Missing punch';
      } else {
        a.detailed_status = status.charAt(0).toUpperCase() + status.slice(1);
      }
    }
  });
}

module.exports = { applyDetailedStatus };
