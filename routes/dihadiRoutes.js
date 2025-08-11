const express = require('express');
const router = express.Router();
const moment = require('moment');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isSupervisor } = require('../middlewares/auth');
const { effectiveHours, lunchDeduction } = require('../helpers/salaryCalculator');

// Supervisor download of dihadi hours sheet
router.get('/supervisor/dihadi/download', isAuthenticated, isSupervisor, async (req, res) => {
  const month = req.query.month || moment().format('YYYY-MM');
  const half = parseInt(req.query.half, 10) === 2 ? 2 : 1;
  const supervisorId = req.session.user.id;
  let start = moment(month + '-01');
  let end = half === 1 ? moment(month + '-15') : moment(month + '-01').endOf('month');
  if (half === 2) start = moment(month + '-16');
  try {
    const [employees] = await pool.query(
      `SELECT e.id, e.punching_id, e.name, e.aadhar_card_number, e.salary, e.allotted_hours,
              (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = e.id) AS advance_taken,
              (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id) AS advance_deducted
         FROM employees e
        WHERE e.supervisor_id = ? AND e.salary_type = 'dihadi' AND e.is_active = 1
     ORDER BY e.name`,
      [supervisorId]
    );
    const empIds = employees.map(e => e.id);
    const rows = [];
    if (empIds.length) {
      const [attAll] = await pool.query(
        'SELECT employee_id, date, punch_in, punch_out FROM employee_attendance WHERE employee_id IN (?) AND date BETWEEN ? AND ? ORDER BY employee_id, date',
        [empIds, start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')]
      );
      const attMap = new Map();
      for (const a of attAll) {
        const key = a.employee_id;
        if (!attMap.has(key)) attMap.set(key, []);
        attMap.get(key).push(a);
      }
      for (const emp of employees) {
        const att = attMap.get(emp.id) || [];
        const byDate = {};
        let totalHrs = 0;
        let totalLunch = 0;
        for (const a of att) {
          const day = moment(a.date).date();
          if (a.punch_in && a.punch_out) {
            const hrs = effectiveHours(
              a.punch_in,
              a.punch_out,
              'dihadi',
              emp.allotted_hours
            );
            const lunch = lunchDeduction(
              a.punch_in,
              a.punch_out,
              'dihadi',
              emp.allotted_hours
            );
            byDate[day] = hrs.toFixed(2);
            totalHrs += hrs;
            totalLunch += lunch;
          } else {
            byDate[day] = '';
          }
        }
        const row = {
          employee: emp.name,
          punching_id: emp.punching_id,
          aadhar: emp.aadhar_card_number || '',
          base_amount: emp.salary
        };
        for (let d = start.date(); d <= end.date(); d++) {
          const key = `d${String(d).padStart(2, '0')}`;
          row[key] = byDate[d] !== undefined ? byDate[d] : '';
        }
        const rate = emp.allotted_hours
          ? parseFloat(emp.salary) / parseFloat(emp.allotted_hours)
          : 0;
        const amount = parseFloat((totalHrs * rate).toFixed(2));
        const net = parseFloat((amount - parseFloat(emp.advance_deducted)).toFixed(2));
        row.total_hours = totalHrs.toFixed(2);
        row.lunch_deduction = (totalLunch / 60).toFixed(2);
        row.total_amount = amount;
        row.advance_deduct = parseFloat(emp.advance_deducted);
        row.net_payment = net;
        rows.push(row);
      }
    }
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dihadi');
    const columns = [
      { header: 'Employee', key: 'employee', width: 20 },
      { header: 'Punching ID', key: 'punching_id', width: 12 },
      { header: 'Aadhar', key: 'aadhar', width: 18 },
      { header: 'Dihadi Base', key: 'base_amount', width: 12 }
    ];
    for (let d = start.date(); d <= end.date(); d++) {
      const key = `d${String(d).padStart(2, '0')}`;
      columns.push({ header: String(d), key, width: 5 });
    }
    columns.push({ header: 'Total Hours', key: 'total_hours', width: 12 });
    columns.push({ header: 'Lunch Deduction', key: 'lunch_deduction', width: 15 });
    columns.push({ header: 'Total Amount', key: 'total_amount', width: 12 });
    columns.push({ header: 'Advance Deducted', key: 'advance_deduct', width: 15 });
    columns.push({ header: 'Net Payment', key: 'net_payment', width: 12 });
    sheet.columns = columns;
    rows.forEach(r => sheet.addRow(r));
    res.setHeader('Content-Disposition', 'attachment; filename="DihadiHours.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading dihadi hours:', err);
    req.flash('error', 'Could not download dihadi hours');
    res.redirect('/supervisor/employees');
  }
});

module.exports = router;
