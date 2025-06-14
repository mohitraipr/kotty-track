const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const xlsx = require('xlsx');
const { parseAttendance } = require('../helpers/attendanceParser');
const { isAuthenticated } = require('../middlewares/auth');

// Configure multer for uploads
const upload = multer({ dest: path.join(__dirname, '../uploads') });

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getLunchDeduction(rawMinutes) {
  const rawHours = rawMinutes / 60;
  if (rawHours <= 4) return 0;
  if (rawHours <= 8) return 30;
  return 60;
}

function formatTimeFromMinutes(totalMinutes) {
  const isNegative = totalMinutes < 0;
  totalMinutes = Math.abs(totalMinutes);
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return (isNegative ? '-' : '') + hrs + ':' + (mins < 10 ? '0' : '') + mins;
}

function getNextNonEmpty(row, startIndex) {
  for (let i = startIndex; i < row.length; i++) {
    if (row[i] && row[i].toString().trim() !== '') {
      return row[i].toString().trim();
    }
  }
  return '';
}

router.get('/', isAuthenticated, (req, res) => {
  res.render('attendance', { logs: [], error: null });
});

router.post(
  '/upload',
  isAuthenticated,
  upload.fields([
    { name: 'attendanceFile', maxCount: 1 },
    { name: 'salaryFile', maxCount: 1 }
  ]),
  (req, res) => {
    if (!req.files || !req.files.attendanceFile || !req.files.salaryFile) {
      req.flash('error', 'Both attendance and salary files are required.');
      return res.redirect('/attendance');
    }

    try {
      const attendanceFilePath = req.files.attendanceFile[0].path;
      const { employees } = parseAttendance(attendanceFilePath);

      const logs = [];
      const TARGET_MINUTES = 11 * 60;

      for (const emp of employees) {
        const days = [];
        let totalNetMinutes = 0;
        let absentDays = 0;
        let lateDeductionTotal = 0;

        emp.days.forEach((rec, idx) => {
          const day = rec.date ? new Date(rec.date).getDate() : idx + 1;
          const checkIn = rec.checkIn || '';
          const checkOut = rec.checkOut || '';
          if (!checkIn || !checkOut) {
            days.push({ day, checkIn: '', checkOut: '', rawWorkedMinutes: 0, netWorkedMinutes: 0, dailyDiffMinutes: -TARGET_MINUTES, isAbsent: true });
            absentDays++;
          } else {
            const inMins = timeToMinutes(checkIn);
            const outMins = timeToMinutes(checkOut);
            let effectiveIn = inMins;
            let effectiveOut = outMins;
            if (inMins >= 540 && inMins <= 550 && outMins >= 1260 && outMins <= 1270) {
              effectiveIn = 540;
              effectiveOut = 1260;
            }
            const rawMinutes = Math.round(effectiveOut - effectiveIn);
            const lunchDeduction = getLunchDeduction(rawMinutes);
            let latenessDeduction = 0;
            let isLateCheckIn = false;
            if (inMins >= 555) {
              latenessDeduction = 30;
              isLateCheckIn = true;
            } else if (inMins >= 540 && inMins <= 550 && outMins >= 1260 && outMins <= 1270) {
              latenessDeduction = 0;
            }
            const netMinutes = rawMinutes - lunchDeduction - latenessDeduction;
            totalNetMinutes += netMinutes;
            const dailyDiffMinutes = netMinutes - TARGET_MINUTES;
            if (isLateCheckIn) lateDeductionTotal += 30;
            days.push({ day, checkIn, checkOut, rawWorkedMinutes: rawMinutes, netWorkedMinutes: netMinutes, dailyDiffMinutes, isAbsent: false, lateCheckIn: isLateCheckIn });
          }
        });

        let deductionReason = '';
        if (lateDeductionTotal > 0) {
          deductionReason += `Late Check-in Deduction: ${lateDeductionTotal} mins.`;
        }

        let runningBalanceMinutes = 0;
        days.forEach(d => {
          runningBalanceMinutes += d.dailyDiffMinutes;
          d.runningBalance = runningBalanceMinutes / 60;
          d.finalStatus = d.isAbsent ? 'Absent' : runningBalanceMinutes < 0 ? `Overall Undertime by ${(Math.abs(runningBalanceMinutes) / 60).toFixed(2)} hrs` : 'Met target';
        });

        logs.push({
          no: emp.punchingId,
          name: emp.name,
          dept: emp.dept || '',
          days,
          totalNetHours: totalNetMinutes / 60,
          overallAdjustment: days.length > 0 ? days[days.length - 1].runningBalance : 0,
          overallStatus: days.length > 0 && (days[days.length - 1].runningBalance < 0 ? `Overall Undertime by ${Math.abs(days[days.length - 1].runningBalance).toFixed(2)} hrs` : 'Met target overall'),
          absentDays,
          deductionReason
        });
      }

      const salaryFilePath = req.files.salaryFile[0].path;
      const workbookSal = xlsx.readFile(salaryFilePath);
      const salarySheetName = workbookSal.SheetNames[0];
      const salaryWorksheet = workbookSal.Sheets[salarySheetName];
      let salaryData = xlsx.utils.sheet_to_json(salaryWorksheet, { header: 1 });
      salaryData = salaryData.filter(row => row && row.length > 0);

      let salaryHeader = salaryData[0];
      const deptIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('dept'));
      const idIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('punching'));
      const nameIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('name'));
      const dailySalaryIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('daily'));
      const hoursIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('hour'));
      const advanceIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('advance'));
      const debitIdx = salaryHeader.findIndex(h => h.toString().toLowerCase().includes('debit'));

      const salaryMap = {};
      for (let j = 1; j < salaryData.length; j++) {
        const row = salaryData[j];
        const punchingId = row[idIdx] ? row[idIdx].toString().trim() : '';
        const name = row[nameIdx] ? row[nameIdx].toString().trim() : '';
        const dept = row[deptIdx] ? row[deptIdx].toString().trim() : '';
        if (punchingId && name && dept) {
          const key = `${punchingId}_${name.toLowerCase()}_${dept.toLowerCase()}`;
          salaryMap[key] = {
            dept,
            name,
            dailySalary: row[dailySalaryIdx] ? Number(row[dailySalaryIdx]) : 0,
            definedHours: row[hoursIdx] ? Number(row[hoursIdx]) : 12,
            advance: row[advanceIdx] ? Number(row[advanceIdx]) : 0,
            debit: row[debitIdx] ? Number(row[debitIdx]) : 0
          };
        }
      }

      const merged = logs.map(emp => {
        const key = `${emp.no}_${emp.name.trim().toLowerCase()}_${emp.dept.trim().toLowerCase()}`;
        const salRec = salaryMap[key];
        if (salRec) {
          const hourlySalary = salRec.definedHours > 0 ? salRec.dailySalary / salRec.definedHours : 0;
          const grossSalary = hourlySalary * emp.totalNetHours;
          let netSalary = grossSalary - salRec.advance - salRec.debit;
          if (netSalary < 0) netSalary = 0;
          return {
            ...emp,
            hourlySalary,
            dailySalary: salRec.dailySalary,
            grossSalary,
            netSalary,
            totalSalaryMade: netSalary,
            advance: salRec.advance,
            debit: salRec.debit,
            definedHours: salRec.definedHours
          };
        }
        return emp;
      });

      req.session.attendanceLogs = merged;
      res.render('attendance', { logs: merged, error: null });
    } catch (err) {
      console.error('Error processing files:', err);
      req.flash('error', 'Failed to process files. Please check the file formats and try again.');
      res.redirect('/attendance');
    }
  }
);

router.get('/download', isAuthenticated, (req, res) => {
  const logs = req.session.attendanceLogs;
  if (!logs) {
    req.flash('error', 'No data available for download.');
    return res.redirect('/attendance');
  }

  const attendanceData = [];
  attendanceData.push(['Employee Name', 'Punching ID', 'Dept', 'Day', 'Check In', 'Check Out', 'Raw Worked', 'Lunch Deduction', 'Net Worked', 'Daily Diff', 'Running Balance', 'Final Status']);
  logs.forEach(emp => {
    emp.days.forEach(day => {
      attendanceData.push([
        emp.name,
        emp.no,
        emp.dept,
        day.day,
        day.checkIn,
        day.checkOut,
        formatTimeFromMinutes(day.rawWorkedMinutes),
        formatTimeFromMinutes(day.rawWorkedMinutes - day.netWorkedMinutes),
        formatTimeFromMinutes(day.netWorkedMinutes),
        formatTimeFromMinutes(day.dailyDiffMinutes),
        formatTimeFromMinutes(Math.round(day.runningBalance * 60)),
        day.finalStatus
      ]);
    });
    attendanceData.push([
      emp.name,
      emp.no,
      emp.dept,
      'Overall',
      '',
      '',
      '',
      '',
      formatTimeFromMinutes(Math.round(emp.totalNetHours * 60)),
      formatTimeFromMinutes(Math.round(emp.overallAdjustment * 60)),
      emp.overallStatus,
      ''
    ]);
    attendanceData.push([]);
  });

  const salaryData = [];
  salaryData.push(['Employee Name', 'Punching ID', 'Per Hour Salary', 'Daily Salary', 'Gross Salary', 'Advance Deduction', 'Debit Deduction', 'Net Salary Made', 'Total Hours Worked', 'Absent Days']);
  logs.forEach(emp => {
    if (emp.hourlySalary !== undefined) {
      salaryData.push([
        emp.name,
        emp.no,
        emp.hourlySalary.toFixed(2),
        emp.dailySalary.toFixed(2),
        emp.grossSalary.toFixed(2),
        emp.advance ? emp.advance.toFixed(2) : '0.00',
        emp.debit ? emp.debit.toFixed(2) : '0.00',
        emp.netSalary.toFixed(2),
        formatTimeFromMinutes(Math.round(emp.totalNetHours * 60)),
        emp.absentDays !== undefined ? emp.absentDays : 0
      ]);
    }
  });

  const wb = xlsx.utils.book_new();
  const wsAttendance = xlsx.utils.aoa_to_sheet(attendanceData);
  const wsSalary = xlsx.utils.aoa_to_sheet(salaryData);
  xlsx.utils.book_append_sheet(wb, wsAttendance, 'Attendance');
  xlsx.utils.book_append_sheet(wb, wsSalary, 'Salary');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename=attendance_salary.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/downloadSalary', isAuthenticated, (req, res) => {
  const logs = req.session.attendanceLogs;
  if (!logs) {
    req.flash('error', 'No data available for download.');
    return res.redirect('/attendance');
  }

  const salaryData = [];
  salaryData.push(['Employee Name', 'Punching ID', 'Per Hour Salary', 'Daily Salary', 'Gross Salary', 'Advance Deduction', 'Debit Deduction', 'Net Salary Made', 'Total Hours Worked', 'Absent Days']);
  logs.forEach(emp => {
    if (emp.hourlySalary !== undefined) {
      salaryData.push([
        emp.name,
        emp.no,
        emp.hourlySalary.toFixed(2),
        emp.dailySalary.toFixed(2),
        emp.grossSalary.toFixed(2),
        emp.advance ? emp.advance.toFixed(2) : '0.00',
        emp.debit ? emp.debit.toFixed(2) : '0.00',
        emp.netSalary.toFixed(2),
        formatTimeFromMinutes(Math.round(emp.totalNetHours * 60)),
        emp.absentDays !== undefined ? emp.absentDays : 0
      ]);
    }
  });

  const wb = xlsx.utils.book_new();
  const wsSalary = xlsx.utils.aoa_to_sheet(salaryData);
  xlsx.utils.book_append_sheet(wb, wsSalary, 'Salary');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Disposition', 'attachment; filename=salary.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
