const xlsx = require('xlsx');
const path = require('path');

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getLunchDeduction(rawMinutes) {
  const hrs = rawMinutes / 60;
  if (hrs <= 4) return 0;
  if (hrs <= 8) return 30;
  return 60;
}

function getNextNonEmpty(row, startIndex) {
  for (let i = startIndex; i < row.length; i++) {
    if (row[i] && row[i].toString().trim() !== '') {
      return row[i].toString().trim();
    }
  }
  return '';
}

function monthIndex(name) {
  const months = [
    'january','february','march','april','may','june',
    'july','august','september','october','november','december'
  ];
  const idx = months.indexOf(name.toLowerCase());
  return idx === -1 ? null : idx + 1;
}

function detectMonthYear(data) {
  const regexes = [
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})/i,
    /(\d{4})[\/-](\d{1,2})/,
    /(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/
  ];
  for (let r = 0; r < Math.min(data.length, 5); r++) {
    for (const cell of data[r]) {
      if (!cell) continue;
      const str = cell.toString();
      for (const reg of regexes) {
        const m = str.match(reg);
        if (m) {
          if (reg === regexes[0]) {
            return { month: monthIndex(m[1]), year: parseInt(m[2], 10) };
          }
          if (reg === regexes[1]) {
            return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
          }
          if (reg === regexes[2]) {
            return { year: parseInt(m[3], 10), month: parseInt(m[2], 10) };
          }
        }
      }
    }
  }
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

function formatDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseAttendance(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  let data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
  data = data.filter(row => row && row.length > 0);

  const { month, year } = detectMonthYear(data);

  const employees = [];
  const altFormat = data[0].some(cell => cell && cell.toString().includes('Employee Attendance Record'));

  const TARGET_MINUTES = 11 * 60;

  if (altFormat) {
    let i = 0;
    while (i < data.length && !data[i].some(cell => typeof cell === 'string' && cell.includes('UserID:'))) {
      i++;
    }
    while (i < data.length) {
      const headerRow = data[i];
      if (!headerRow.some(cell => typeof cell === 'string' && cell.includes('UserID:'))) {
        i++;
        continue;
      }
      const empNo = getNextNonEmpty(headerRow, headerRow.indexOf('UserID:') + 1);
      const empName = getNextNonEmpty(headerRow, headerRow.indexOf('Name:') + 1);
      let dayHeaderRow = data[i + 1] || [];
      let logRow = (i + 2 < data.length && !data[i + 2].some(cell => typeof cell === 'string' && cell.includes('UserID:'))) ? data[i + 2] : null;
      if (logRow && dayHeaderRow.length !== logRow.length) {
        const diff = Math.abs(dayHeaderRow.length - logRow.length);
        if (dayHeaderRow.length > logRow.length) {
          dayHeaderRow = dayHeaderRow.slice(diff);
        } else {
          logRow = logRow.slice(diff);
        }
      }
      i += logRow ? 3 : 2;
      if (dayHeaderRow.length > 0) {
        const firstCell = dayHeaderRow[0];
        if (!firstCell || parseFloat(firstCell) === 0) {
          dayHeaderRow.shift();
          if (logRow) logRow.shift();
        }
      }
      const days = [];
      for (let k = 0; k < dayHeaderRow.length; k++) {
        const dayCell = dayHeaderRow[k];
        const dayNum = parseInt(dayCell);
        const dateStr = dayNum ? formatDate(year, month, dayNum) : null;
        let logCell = logRow && typeof logRow[k] === 'string' ? logRow[k] : '';
        let checkIn = null;
        let checkOut = null;
        let netMinutes = 0;
        if (logCell && logCell.includes(':')) {
          const times = logCell.split(/\r?\n/).map(t => t.trim()).filter(t => t);
          if (times.length >= 2) {
            checkIn = times[0];
            checkOut = times[times.length - 1];
            const inMins = timeToMinutes(checkIn);
            const outMins = timeToMinutes(checkOut);
            let effectiveIn = inMins;
            let effectiveOut = outMins;
            if (inMins >= 540 && inMins <= 550 && outMins >= 1260 && outMins <= 1270) {
              effectiveIn = 540;
              effectiveOut = 1260;
            }
            const rawMinutes = effectiveOut - effectiveIn;
            const lunchDeduction = getLunchDeduction(rawMinutes);
            let latenessDeduction = 0;
            if (inMins >= 555) latenessDeduction = 30;
            netMinutes = rawMinutes - lunchDeduction - latenessDeduction;
          }
        }
        days.push({
          date: dateStr,
          checkIn,
          checkOut,
          netHours: parseFloat((netMinutes / 60).toFixed(2))
        });
      }
      employees.push({ punchingId: empNo, name: empName, days });
    }
  } else {
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      if (row.some(cell => typeof cell === 'string' && cell.replace(/\s/g, '').toLowerCase().startsWith('no:'))) {
        if (i - 1 < 0 || i + 1 >= data.length) continue;
        let dayHeaderRow = data[i - 1];
        const employeeRow = row;
        let logRow = data[i + 1];
        if (logRow && dayHeaderRow.length !== logRow.length) {
          const diff = Math.abs(dayHeaderRow.length - logRow.length);
          if (dayHeaderRow.length > logRow.length) {
            dayHeaderRow = dayHeaderRow.slice(diff);
          } else {
            logRow = logRow.slice(diff);
          }
        }
        let empNo = '', empName = '';
        for (let j = 0; j < employeeRow.length; j++) {
          if (typeof employeeRow[j] === 'string') {
            const norm = employeeRow[j].replace(/\s/g, '').toLowerCase();
            if (norm.startsWith('no:')) empNo = getNextNonEmpty(employeeRow, j + 1);
            if (norm.startsWith('name:')) empName = getNextNonEmpty(employeeRow, j + 1);
          }
        }
        const days = [];
        for (let k = 0; k < dayHeaderRow.length; k++) {
          const day = dayHeaderRow[k];
          const dayNum = parseInt(day);
          const dateStr = dayNum ? formatDate(year, month, dayNum) : null;
          const logCell = logRow[k];
          let checkIn = null;
          let checkOut = null;
          let netMinutes = 0;
          if (logCell && typeof logCell === 'string') {
            const times = logCell.split(/\r?\n/).map(t => t.trim()).filter(t => t);
            if (times.length >= 2) {
              checkIn = times[0];
              checkOut = times[times.length - 1];
              const inMins = timeToMinutes(checkIn);
              const outMins = timeToMinutes(checkOut);
              let effectiveIn = inMins;
              let effectiveOut = outMins;
              if (inMins >= 540 && inMins <= 550 && outMins >= 1260 && outMins <= 1270) {
                effectiveIn = 540;
                effectiveOut = 1260;
              }
              const rawMinutes = effectiveOut - effectiveIn;
              const lunchDeduction = getLunchDeduction(rawMinutes);
              let latenessDeduction = 0;
              if (inMins >= 555) latenessDeduction = 30;
              netMinutes = rawMinutes - lunchDeduction - latenessDeduction;
            }
          }
          days.push({
            date: dateStr,
            checkIn,
            checkOut,
            netHours: parseFloat((netMinutes / 60).toFixed(2))
          });
        }
        employees.push({ punchingId: empNo, name: empName, days });
        i++; // skip logRow next iteration
      }
    }
  }

  return { month, year, employees };
}

module.exports = { parseAttendance };
