const express = require("express");
const router = express.Router();
const moment = require("moment");
const { pool } = require("../config/db");
const {
  calculateSalaryForMonth,
  calculateSalaryHourly,
} = require("../helpers/salaryCalculator");
const {
  HOURLY_EXEMPT_EMPLOYEE_IDS,
} = require("../utils/hourlyExemptEmployees");
const { SPECIAL_TEAM_EMPLOYEE_IDS } = require("../utils/specialTeamEmployees");
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const { isValidAadhar } = require("../helpers/aadharValidator");

// Simple in-memory cache with TTL for frequently accessed queries
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map();
function getCache(key) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.val;
  }
  return null;
}
function setCache(key, val) {
  _cache.set(key, { ts: Date.now(), val });
}
async function fetchCached(key, fn) {
  const cached = getCache(key);
  if (cached) return cached;
  const result = await fn();
  setCache(key, result);
  return result;
}

// Convert exemption arrays to Sets for faster lookups
const HOURLY_EXEMPT_SET = new Set(HOURLY_EXEMPT_EMPLOYEE_IDS);
const SPECIAL_TEAM_SET = new Set(SPECIAL_TEAM_EMPLOYEE_IDS);

// List all supervisors
router.get("/supervisors", isAuthenticated, isOperator, async (req, res) => {
  try {
    const supervisors = await fetchCached("op-supervisors", async () => {
      const [rows] = await pool.query(`
        SELECT u.id, u.username, u.username
          FROM users u
          JOIN roles r ON u.role_id = r.id
         WHERE r.name = 'supervisor'
         ORDER BY u.username`);
      return rows;
    });
    res.render("operatorSupervisors", { user: req.session.user, supervisors });
  } catch (err) {
    console.error("Error loading supervisors:", err);
    req.flash("error", "Failed to load supervisors");
    res.redirect("/operator/dashboard");
  }
});

// List employees for a supervisor
router.get(
  "/supervisors/:id/employees",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const supId = req.params.id;
    try {
      const [supervisor] = await fetchCached(`op-sup-${supId}`, () =>
        pool
          .query(
            'SELECT id, username FROM users WHERE id = ? AND role_id IN (SELECT id FROM roles WHERE name = "supervisor")',
            [supId],
          )
          .then((r) => r[0]),
      );
      if (!supervisor) {
        req.flash("error", "Supervisor not found");
        return res.redirect("/operator/supervisors");
      }
      const employees = await fetchCached(`op-sup-emps-${supId}`, () =>
        pool
          .query("SELECT * FROM employees WHERE supervisor_id = ?", [supId])
          .then((r) => r[0]),
      );
      res.render("operatorSupervisorEmployees", {
        user: req.session.user,
        supervisor,
        employees,
      });
    } catch (err) {
      console.error("Error loading employees:", err);
      req.flash("error", "Failed to load employees");
      res.redirect("/operator/supervisors");
    }
  },
);

// Create a new employee for the given supervisor
router.post(
  "/supervisors/:id/employees",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const supId = req.params.id;
    const {
      punching_id,
      name,
      designation,
      phone_number,
      aadhar_card_number,
      salary,
      salary_type,
      allotted_hours,
      paid_sunday_allowance,
      pay_sunday,
      leave_start_months,
      date_of_joining,
    } = req.body;
    if (aadhar_card_number && !isValidAadhar(aadhar_card_number)) {
      req.flash("error", "Aadhar number must be 12 digits");
      return res.redirect(`/operator/supervisors/${supId}/employees`);
    }
    try {
      await pool.query(
        `INSERT INTO employees
          (supervisor_id, punching_id, name, designation, phone_number, aadhar_card_number, salary, salary_type, allotted_hours, paid_sunday_allowance, pay_sunday, leave_start_months, date_of_joining, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          supId,
          punching_id,
          name,
          designation,
          phone_number,
          aadhar_card_number,
          salary,
          salary_type,
          allotted_hours,
          paid_sunday_allowance || 0,
          pay_sunday ? 1 : 0,
          leave_start_months || 3,
          date_of_joining,
        ],
      );
      req.flash("success", "Employee created");
      res.redirect(`/operator/supervisors/${supId}/employees`);
    } catch (err) {
      console.error("Error creating employee:", err);
      req.flash("error", "Failed to create employee");
      res.redirect(`/operator/supervisors/${supId}/employees`);
    }
  },
);

// Form to edit attendance for a specific date
router.get(
  "/employees/:id/edit",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const empId = req.params.id;
    const date = req.query.date;
    if (!date) {
      req.flash("error", "Date is required");
      return res.redirect("back");
    }
    try {
      const [[emp]] = await pool.query(
        "SELECT id, name, supervisor_id FROM employees WHERE id = ?",
        [empId],
      );
      if (!emp) {
        req.flash("error", "Employee not found");
        return res.redirect("/operator/supervisors");
      }
      const [[attendance]] = await pool.query(
        "SELECT * FROM employee_attendance WHERE employee_id = ? AND date = ?",
        [empId, date],
      );
      const [logRows] = await pool.query(
        "SELECT COUNT(*) AS cnt FROM attendance_edit_logs WHERE employee_id = ?",
        [empId],
      );
      const editCount = logRows[0].cnt;
      res.render("operatorEditAttendance", {
        user: req.session.user,
        employee: emp,
        date,
        attendance,
        editCount,
      });
    } catch (err) {
      console.error("Error loading attendance:", err);
      req.flash("error", "Failed to load attendance");
      res.redirect("back");
    }
  },
);

// Update attendance
router.post(
  "/employees/:id/edit",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const empId = req.params.id;
    const { date, punch_in, punch_out } = req.body;
    if (!date) {
      req.flash("error", "Date is required");
      return res.redirect("back");
    }
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[emp]] = await conn.query(
        "SELECT supervisor_id, salary_type, salary, pay_sunday, allotted_hours FROM employees WHERE id = ?",
        [empId],
      );
      if (!emp) {
        await conn.rollback();
        req.flash("error", "Employee not found");
        conn.release();
        return res.redirect("/operator/supervisors");
      }
      const supervisorId = emp.supervisor_id;

      const [logRows] = await conn.query(
        "SELECT COUNT(*) AS cnt FROM attendance_edit_logs WHERE employee_id = ?",
        [empId],
      );
      if (logRows[0].cnt >= 35) {
        await conn.rollback();
        req.flash("error", "Edit limit reached for this employee");
        conn.release();
        return res.redirect(`/operator/supervisors/${supervisorId}/employees`);
      }

      const [[att]] = await conn.query(
        "SELECT id, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date = ?",
        [empId, date],
      );
      const newStatus =
        punch_in && punch_out
          ? "present"
          : punch_in || punch_out
            ? "one punch only"
            : "absent";
      if (att) {
        await conn.query(
          "UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = ? WHERE id = ?",
          [punch_in || null, punch_out || null, newStatus, att.id],
        );
        await conn.query(
          "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            empId,
            date,
            att.punch_in,
            att.punch_out,
            punch_in || null,
            punch_out || null,
            req.session.user.id,
          ],
        );
      } else {
        await conn.query(
          "INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status) VALUES (?, ?, ?, ?, ?)",
          [empId, date, punch_in || null, punch_out || null, newStatus],
        );
        await conn.query(
          "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            empId,
            date,
            null,
            null,
            punch_in || null,
            punch_out || null,
            req.session.user.id,
          ],
        );
      }
      const month = moment(date).format("YYYY-MM");
      if (
        emp.salary_type === "monthly" &&
        !HOURLY_EXEMPT_SET.has(empId) &&
        !SPECIAL_TEAM_SET.has(empId)
      ) {
        await calculateSalaryHourly(conn, empId, month, emp);
      } else {
        await calculateSalaryForMonth(conn, empId, month);
      }
      await conn.commit();
      req.flash("success", "Attendance updated");
      conn.release();
      res.redirect(`/operator/supervisors/${supervisorId}/employees`);
    } catch (err) {
      await conn.rollback();
      conn.release();
      console.error("Error updating attendance:", err);
      req.flash("error", "Failed to update attendance");
      res.redirect("back");
    }
  },
);

// Bulk edit attendance for all employees under a supervisor
router.get(
  "/supervisors/:id/bulk-attendance",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const supId = req.params.id;
    const date = req.query.date || moment().format("YYYY-MM-DD");
    try {
      const [supervisor] = await fetchCached(`op-sup-${supId}`, () =>
        pool
          .query(
            'SELECT id, username FROM users WHERE id = ? AND role_id IN (SELECT id FROM roles WHERE name = "supervisor")',
            [supId],
          )
          .then((r) => r[0]),
      );
      if (!supervisor) {
        req.flash("error", "Supervisor not found");
        return res.redirect("/operator/supervisors");
      }
      const [employees] = await pool.query(
        `SELECT e.id, e.punching_id, e.name, a.punch_in, a.punch_out
         FROM employees e
         LEFT JOIN employee_attendance a ON a.employee_id = e.id AND a.date = ?
        WHERE e.supervisor_id = ?
        ORDER BY e.name`,
        [date, supId],
      );
      res.render("operatorBulkAttendance", {
        user: req.session.user,
        supervisor,
        employees,
        date,
      });
    } catch (err) {
      console.error("Error loading bulk attendance:", err);
      req.flash("error", "Failed to load attendance");
      res.redirect("/operator/supervisors");
    }
  },
);

router.post(
  "/supervisors/:id/bulk-attendance",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const supId = req.params.id;
    const date = req.body.date;
    if (!date) {
      req.flash("error", "Date is required");
      return res.redirect("back");
    }
    let empIds = req.body.employee_id || [];
    let punchIns = req.body.punch_in || [];
    let punchOuts = req.body.punch_out || [];
    if (!Array.isArray(empIds)) empIds = [empIds];
    if (!Array.isArray(punchIns)) punchIns = [punchIns];
    if (!Array.isArray(punchOuts)) punchOuts = [punchOuts];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [employees] = await conn.query(
        "SELECT id, supervisor_id, salary_type, salary, pay_sunday, allotted_hours FROM employees WHERE id IN (?)",
        [empIds],
      );
      const empMap = new Map();
      employees.forEach((e) => {
        if (e.supervisor_id == supId) empMap.set(e.id.toString(), e);
      });
      const [attRows] = await conn.query(
        "SELECT id, employee_id, punch_in, punch_out FROM employee_attendance WHERE date = ? AND employee_id IN (?)",
        [date, empIds],
      );
      const attMap = new Map();
      attRows.forEach((a) => attMap.set(a.employee_id.toString(), a));
      const month = moment(date).format("YYYY-MM");
      for (let i = 0; i < empIds.length; i++) {
        const empId = empIds[i];
        const emp = empMap.get(empId.toString());
        if (!emp) continue;
        const punch_in = punchIns[i] || null;
        const punch_out = punchOuts[i] || null;
        const att = attMap.get(empId.toString());
        const newStatus =
          punch_in && punch_out
            ? "present"
            : punch_in || punch_out
              ? "one punch only"
              : "absent";
        if (att) {
          await conn.query(
            "UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = ? WHERE id = ?",
            [punch_in, punch_out, newStatus, att.id],
          );
          await conn.query(
            "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              empId,
              date,
              att.punch_in,
              att.punch_out,
              punch_in,
              punch_out,
              req.session.user.id,
            ],
          );
        } else {
          await conn.query(
            "INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status) VALUES (?, ?, ?, ?, ?)",
            [empId, date, punch_in, punch_out, newStatus],
          );
          await conn.query(
            "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [empId, date, null, null, punch_in, punch_out, req.session.user.id],
          );
        }

        if (
          emp.salary_type === "monthly" &&
          !HOURLY_EXEMPT_SET.has(parseInt(empId)) &&
          !SPECIAL_TEAM_SET.has(parseInt(empId))
        ) {
          await calculateSalaryHourly(conn, empId, month, emp);
        } else {
          await calculateSalaryForMonth(conn, empId, month);
        }
      }
      await conn.commit();
      conn.release();
      req.flash("success", "Attendance updated");
      res.redirect(`/operator/supervisors/${supId}/employees`);
    } catch (err) {
      await conn.rollback();
      conn.release();
      console.error("Error updating bulk attendance:", err);
      req.flash("error", "Failed to update attendance");
      res.redirect("back");
    }
  },
);

// Bulk edit attendance for a single employee over a month
router.get(
  "/employees/:id/bulk-attendance",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const empId = req.params.id;
    const month = req.query.month || moment().format("YYYY-MM");
    try {
      const [[employee]] = await pool.query(
        "SELECT id, name, supervisor_id FROM employees WHERE id = ?",
        [empId],
      );
      if (!employee) {
        req.flash("error", "Employee not found");
        return res.redirect("/operator/supervisors");
      }
      const [rows] = await pool.query(
        'SELECT date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND DATE_FORMAT(date, "%Y-%m") = ? ORDER BY date',
        [empId, month],
      );
      const daysInMonth = moment(month, "YYYY-MM").daysInMonth();
      const attMap = new Map();
      rows.forEach((r) => {
        attMap.set(moment(r.date).format("YYYY-MM-DD"), r);
      });
      const days = [];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = moment(`${month}-${d}`, "YYYY-MM-D").format(
          "YYYY-MM-DD",
        );
        const att = attMap.get(dateStr);
        days.push({
          date: dateStr,
          punch_in: att ? att.punch_in : "",
          punch_out: att ? att.punch_out : "",
        });
      }
      res.render("operatorEmployeeBulkAttendance", {
        user: req.session.user,
        employee,
        month,
        days,
      });
    } catch (err) {
      console.error("Error loading attendance:", err);
      req.flash("error", "Failed to load attendance");
      res.redirect("back");
    }
  },
);

router.post(
  "/employees/:id/bulk-attendance",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    const empId = req.params.id;
    const month = req.body.month;
    let dates = req.body.date || [];
    let punchIns = req.body.punch_in || [];
    let punchOuts = req.body.punch_out || [];
    if (!Array.isArray(dates)) dates = [dates];
    if (!Array.isArray(punchIns)) punchIns = [punchIns];
    if (!Array.isArray(punchOuts)) punchOuts = [punchOuts];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[emp]] = await conn.query(
        "SELECT supervisor_id, salary_type, salary, pay_sunday, allotted_hours FROM employees WHERE id = ?",
        [empId],
      );
      if (!emp) {
        await conn.rollback();
        req.flash("error", "Employee not found");
        conn.release();
        return res.redirect("/operator/supervisors");
      }
      const [attRows] = await conn.query(
        "SELECT id, date, punch_in, punch_out FROM employee_attendance WHERE employee_id = ? AND date IN (?)",
        [empId, dates],
      );
      const attMap = new Map();
      attRows.forEach((r) =>
        attMap.set(moment(r.date).format("YYYY-MM-DD"), r),
      );
      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        const punch_in = punchIns[i] || null;
        const punch_out = punchOuts[i] || null;
        const att = attMap.get(moment(date).format("YYYY-MM-DD"));
        const newStatus =
          punch_in && punch_out
            ? "present"
            : punch_in || punch_out
              ? "one punch only"
              : "absent";
        if (att) {
          await conn.query(
            "UPDATE employee_attendance SET punch_in = ?, punch_out = ?, status = ? WHERE id = ?",
            [punch_in, punch_out, newStatus, att.id],
          );
          await conn.query(
            "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [
              empId,
              date,
              att.punch_in,
              att.punch_out,
              punch_in,
              punch_out,
              req.session.user.id,
            ],
          );
        } else {
          await conn.query(
            "INSERT INTO employee_attendance (employee_id, date, punch_in, punch_out, status) VALUES (?, ?, ?, ?, ?)",
            [empId, date, punch_in, punch_out, newStatus],
          );
          await conn.query(
            "INSERT INTO attendance_edit_logs (employee_id, attendance_date, old_punch_in, old_punch_out, new_punch_in, new_punch_out, operator_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [empId, date, null, null, punch_in, punch_out, req.session.user.id],
          );
        }
      }
      if (
        emp.salary_type === "monthly" &&
        !HOURLY_EXEMPT_SET.has(empId) &&
        !SPECIAL_TEAM_SET.has(empId)
      ) {
        await calculateSalaryHourly(conn, empId, month, emp);
      } else {
        await calculateSalaryForMonth(conn, empId, month);
      }
      await conn.commit();
      conn.release();
      req.flash("success", "Attendance updated");
      res.redirect(
        `/operator/employees/${empId}/bulk-attendance?month=${month}`,
      );
    } catch (err) {
      await conn.rollback();
      conn.release();
      console.error("Error updating attendance:", err);
      req.flash("error", "Failed to update attendance");
      res.redirect("back");
    }
  },
);

module.exports = router;
