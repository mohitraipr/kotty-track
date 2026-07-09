/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 *
 * Key Points:
 *  • Denim chain: Cut → Stitching → Assembly → Washing → WashingIn → Finishing
 *  • Non-denim chain: Cut → Stitching → Finishing (no washing, no washing_in, no assembly)
 *  • If a dept is "stuck"/unassigned, all subsequent depts show "In <that dept>"
 *  • assigned_on & approved_on are fetched from each assignment table
 *  • No day-differences
 *  • "lotCount not defined" bug is fixed – we re-added the code in /dashboard route.
 **************************************************/

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { isAuthenticated, isOperator, isMohitOperator } = require("../middlewares/auth");
const ExcelJS = require("exceljs");
const { PRIVILEGED_OPERATOR_ID } = require("../utils/operators");
const { cache } = require("../utils/cache");

/**************************************************
 * Helper: Format a JS Date as DD/MM/YYYY
 **************************************************/
function formatDateDDMMYYYY(dt) {
  if (!dt) return "";
  // dt is a JS Date object or something we can new Date(...) parse
  const d = new Date(dt);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**************************************************
 * 2) Operator Performance & Analytics
 **************************************************/
async function computeOperatorPerformance() {
  return cache.fetchCached('operatorPerformance', async () => {
    const perf = {};

    const [rows] = await pool.query(`
      SELECT u.id AS user_id, u.username,
             SUM(IF(src='stitch', val, 0))  AS totalStitched,
             SUM(IF(src='wash',   val, 0))  AS totalWashed,
             SUM(IF(src='finish', val, 0))  AS totalFinished
        FROM (
              SELECT user_id, SUM(total_pieces) AS val, 'stitch' AS src
                FROM stitching_data
               GROUP BY user_id
              UNION ALL
              SELECT user_id, SUM(total_pieces) AS val, 'wash' AS src
                FROM washing_data
               GROUP BY user_id
              UNION ALL
              SELECT user_id, SUM(total_pieces) AS val, 'finish' AS src
                FROM finishing_data
               GROUP BY user_id
             ) t
        JOIN users u ON u.id = t.user_id
       GROUP BY t.user_id
    `);

    rows.forEach(r => {
      perf[r.user_id] = {
        username: r.username,
        totalStitched: parseFloat(r.totalStitched) || 0,
        totalWashed:   parseFloat(r.totalWashed)   || 0,
        totalFinished: parseFloat(r.totalFinished) || 0
      };
    });

    return perf;
  });
}

async function computeAdvancedAnalytics(startDate, endDate) {
  const cacheKey = `adv-${startDate || ''}-${endDate || ''}`;
  return cache.fetchCached(cacheKey, async () => {
    const analytics = {};

    // Sourced from *_events (truth source) — counts pieces that have been
    // completed in each stage. Pending = lots whose finished total is below
    // their cut total.
    const totalsQ = pool.query(`
    SELECT
      (SELECT COALESCE(SUM(total_pieces),0) FROM cutting_lots) AS totalCut,
      (SELECT COALESCE(SUM(pieces),0)
         FROM stitching_events WHERE event_type='complete')    AS totalStitched,
      (SELECT COALESCE(SUM(pieces),0)
         FROM washing_events   WHERE event_type='complete')    AS totalWashed,
      (SELECT COALESCE(SUM(pieces),0)
         FROM finishing_events WHERE event_type='complete')    AS totalFinished,
      (SELECT COUNT(*) FROM cutting_lots)                      AS totalCount,
      (
        SELECT COUNT(*)
          FROM cutting_lots c
          LEFT JOIN (
            SELECT cutting_lot_id, COALESCE(SUM(pieces),0) AS sumFinish
              FROM finishing_events WHERE event_type='complete'
             GROUP BY cutting_lot_id
          ) fd ON c.id = fd.cutting_lot_id
         WHERE COALESCE(fd.sumFinish,0) < c.total_pieces
      ) AS pendingLots
    `);

    // Build top/bottom SKU queries
    let skuQuery = 'SELECT sku, SUM(total_pieces) AS total FROM cutting_lots ';
    const skuParams = [];
    if (startDate && endDate) {
      skuQuery += 'WHERE created_at BETWEEN ? AND ? ';
      skuParams.push(startDate, endDate);
    } else {
      skuQuery += 'WHERE created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY) ';
    }
    const topQuery = skuQuery + 'GROUP BY sku ORDER BY total DESC LIMIT 10';
    const bottomQuery = skuQuery + 'GROUP BY sku ORDER BY total ASC LIMIT 10';

    // Turnaround: lots whose finishing-complete events sum to >= cut total.
    const turnaroundQ = pool.query(`
      SELECT c.lot_no,
             c.created_at AS cut_date,
             MAX(f.created_at) AS finish_date,
             c.total_pieces,
             COALESCE(SUM(f.pieces),0) AS sumFin
        FROM cutting_lots c
        LEFT JOIN finishing_events f
               ON f.cutting_lot_id = c.id
              AND f.event_type='complete'
       GROUP BY c.id, c.lot_no, c.created_at, c.total_pieces
       HAVING sumFin >= c.total_pieces
    `);
    // Approval rates from events: per stage, approved-events / (approved + rejected events).
    const stitchRateQ = pool.query(`
      SELECT
        SUM(CASE WHEN event_type IN ('approve','reject') THEN 1 ELSE 0 END) AS totalAssigned,
        SUM(CASE WHEN event_type='approve' THEN 1 ELSE 0 END)               AS approvedCount
        FROM stitching_events
    `);
    const washRateQ = pool.query(`
      SELECT
        SUM(CASE WHEN event_type IN ('approve','reject') THEN 1 ELSE 0 END) AS totalAssigned,
        SUM(CASE WHEN event_type='approve' THEN 1 ELSE 0 END)               AS approvedCount
        FROM washing_events
    `);

    const [
      [totalsRow],
      [topSkusRows],
      [bottomSkusRows],
      [turnRows],
      [[stTotals]],
      [[waTotals]]
    ] = await Promise.all([
      totalsQ,
      pool.query(topQuery, skuParams),
      pool.query(bottomQuery, skuParams),
      turnaroundQ,
      stitchRateQ,
      washRateQ
    ]);

    analytics.totalCut = parseFloat(totalsRow.totalCut) || 0;
    analytics.totalStitched = parseFloat(totalsRow.totalStitched) || 0;
    analytics.totalWashed = parseFloat(totalsRow.totalWashed) || 0;
    analytics.totalFinished = parseFloat(totalsRow.totalFinished) || 0;

    // Conversion rates
    analytics.stitchConversion = (analytics.totalCut > 0)
      ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
      : "0.00";
    analytics.washConversion = (analytics.totalStitched > 0)
      ? (((analytics.totalWashed > 0 ? analytics.totalWashed : analytics.totalFinished) / analytics.totalStitched) * 100).toFixed(2)
      : "0.00";
    analytics.finishConversion = (analytics.totalWashed > 0)
      ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
      : (analytics.totalStitched > 0)
        ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
        : "0.00";

    // top10SKUs
    analytics.top10SKUs = topSkusRows;
    analytics.bottom10SKUs = bottomSkusRows;

    analytics.totalLots = totalsRow.totalCount;
    analytics.pendingLots = totalsRow.pendingLots;

    let totalDiff = 0;
    let countComplete = 0;
    for (const row of turnRows) {
      if (row.finish_date && row.cut_date) {
        const diffMs = new Date(row.finish_date).getTime() -
                       new Date(row.cut_date).getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        totalDiff += diffDays;
        countComplete++;
      }
    }
    analytics.avgTurnaroundTime = countComplete > 0
      ? parseFloat((totalDiff / countComplete).toFixed(2))
      : 0;

    analytics.stitchApprovalRate = stTotals.totalAssigned > 0
      ? ((stTotals.approvedCount / stTotals.totalAssigned) * 100).toFixed(2)
      : '0.00';

    analytics.washApprovalRate = waTotals.totalAssigned > 0
      ? ((waTotals.approvedCount / waTotals.totalAssigned) * 100).toFixed(2)
      : '0.00';

    return analytics;
  });
}

router.get("/dashboard/washer-activity", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "startDate and endDate are required" });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: "Invalid date range" });
    }
    if (start > end) {
      return res.status(400).json({ error: "startDate cannot be after endDate" });
    }

    // Events-sourced washer activity. A washer counts as "active" if they
    // have any approve/complete event for washing in the window. Approved
    // lots = distinct lots they took into washing (event_type='approve');
    // completed lots = distinct lots they marked complete in washing.
    const [rows] = await pool.query(
      `SELECT u.id AS washer_id,
              u.username,
              COALESCE(ap.approvedLots,  0) AS approvedLots,
              COALESCE(wc.completedLots, 0) AS completedLots
         FROM (
           SELECT DISTINCT operator_id AS user_id FROM washing_events
            WHERE DATE(created_at) BETWEEN ? AND ?
         ) active_washers
         JOIN users u ON u.id = active_washers.user_id
         LEFT JOIN (
           SELECT operator_id AS user_id, COUNT(DISTINCT cutting_lot_id) AS approvedLots
             FROM washing_events
            WHERE event_type='approve' AND DATE(created_at) BETWEEN ? AND ?
            GROUP BY operator_id
         ) ap ON ap.user_id = u.id
         LEFT JOIN (
           SELECT operator_id AS user_id, COUNT(DISTINCT cutting_lot_id) AS completedLots
             FROM washing_events
            WHERE event_type='complete' AND DATE(created_at) BETWEEN ? AND ?
            GROUP BY operator_id
         ) wc ON wc.user_id = u.id
        ORDER BY u.username ASC`,
      [startDate, endDate, startDate, endDate, startDate, endDate]
    );

    return res.json({ data: rows });
  } catch (err) {
    console.error("Error in /dashboard/washer-activity:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**************************************************
 * Mohit-only: Session usage analytics
 **************************************************/
router.get(
  "/dashboard/api/session-usage",
  isAuthenticated,
  isMohitOperator,
  async (req, res) => {
    try {
      const days = Math.min(
        Math.max(parseInt(req.query.days, 10) || 7, 1),
        90
      );

      const [rows] = await pool.query(
        `
          SELECT
            u.username,
            DATE(usl.login_time) AS loginDate,
            COUNT(*) AS sessionCount,
            SUM(
              TIMESTAMPDIFF(
                SECOND,
                usl.login_time,
                COALESCE(usl.logout_time, usl.last_activity_time, NOW())
              )
            ) AS totalSeconds,
            MAX(usl.login_time) AS lastLoginAt,
            MAX(usl.last_activity_time) AS lastActivityAt
          FROM user_session_logs usl
          JOIN users u ON u.id = usl.user_id
         WHERE usl.login_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
         GROUP BY u.id, loginDate
         ORDER BY loginDate DESC, u.username ASC
        `,
        [days]
      );

      return res.json({ data: rows });
    } catch (err) {
      console.error("Error fetching session usage:", err);
      return res.status(500).json({ error: "Unable to fetch session usage" });
    }
  }
);

/**************************************************
 * 3) /operator/dashboard – must define lotCount etc.
 **************************************************/
// Redesigned mobile-first operator hub ("Kotty Floor") on the actual Stitch design.
// Full rebuild of the operator dashboard — same data/panels, opt-in alongside /dashboard.
router.get("/hub", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate,
      sortField = "lot_no", sortOrder = "asc", category = "all" } = req.query;

    const [[totals]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM cutting_lots)                      AS lotCount,
        (SELECT COALESCE(SUM(total_pieces),0) FROM cutting_lots) AS totalPieces,
        (SELECT COALESCE(SUM(pieces),0) FROM finishing_events
           WHERE event_type='complete')                         AS totalFinished,
        (SELECT COUNT(*) FROM users)                             AS userCount
    `);

    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);

    return res.render("floorHub", {
      user: req.session.user,
      lotCount: totals.lotCount,
      totalPiecesCut: parseFloat(totals.totalPieces) || 0,
      totalFinished: totals.totalFinished,
      userCount: totals.userCount,
      advancedAnalytics,
      query: { search, startDate, endDate, sortField, sortOrder, category },
    });
  } catch (err) {
    console.error("Error loading operator hub:", err);
    return res.status(500).send("Server error");
  }
});

// The classic operator dashboard is retired — the Kotty Floor hub IS the operator
// dashboard now. Every legacy link/bookmark to /operator/dashboard lands on the hub.
// (All /dashboard/* sub-routes — APIs, downloads, reports — remain live below.)
router.get("/dashboard", isAuthenticated, isOperator, (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return res.redirect("/operator/hub" + qs);
});


// Department -> event tables map for the new event-based pendency math.
// Each row aggregates by (cutting_lot_id, operator) and reports:
//   approved  — pieces this operator has APPROVED into this stage
//   completed — pieces this operator has COMPLETED in this stage
//   rejected  — pieces this operator has REJECTED at this stage
//   inline    — approved - completed - rejected  (work in progress here)
//   assigned  — historical compatibility column (= approved)
//   pending   — historical compatibility column (= inline)
const PENDENCY_STAGE_TABLES = {
  stitching:  'stitching_events',
  assembly:   'jeans_assembly_events',
  washing:    'washing_events',
  washing_in: 'washing_in_events',
  finishing:  'finishing_events',
};

async function fetchPendencyRows(dept, searchLike, offset, limit) {
  const cacheKey = `pend-v2-${dept}-${searchLike}-${offset}-${limit}`;
  return cache.fetchCached(cacheKey, async () => {
    const eventsTable = PENDENCY_STAGE_TABLES[dept];
    if (!eventsTable) {
      // Unknown dept -> empty, but don't error so the page still loads.
      return [];
    }

    // Event-based aggregation, joined back to cutting_lots for lot_no.
    // Each (lot, operator) is a row. Operators who only approved (no
    // complete yet) appear with completed = 0 and a positive inline,
    // which is what the operator dashboard needs to see.
    const query = `
      SELECT
        MIN(e.id) AS assignment_id,
        cl.lot_no,
        cl.manual_lot_number,
        u.username,
        SUM(CASE WHEN e.event_type='approve'  THEN e.pieces ELSE 0 END) AS approved,
        SUM(CASE WHEN e.event_type='complete' THEN e.pieces ELSE 0 END) AS completed,
        SUM(CASE WHEN e.event_type='reject'   THEN e.pieces ELSE 0 END) AS rejected,
        SUM(CASE WHEN e.event_type='approve'  THEN e.pieces ELSE 0 END)
          - SUM(CASE WHEN e.event_type='complete' THEN e.pieces ELSE 0 END)
          - SUM(CASE WHEN e.event_type='reject'   THEN e.pieces ELSE 0 END) AS inline,
        SUM(CASE WHEN e.event_type='approve'  THEN e.pieces ELSE 0 END) AS assigned,
        SUM(CASE WHEN e.event_type='approve'  THEN e.pieces ELSE 0 END)
          - SUM(CASE WHEN e.event_type='complete' THEN e.pieces ELSE 0 END)
          - SUM(CASE WHEN e.event_type='reject'   THEN e.pieces ELSE 0 END) AS pending
      FROM ${eventsTable} e
      JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
      JOIN users u ON u.id = e.operator_id
      WHERE cl.lot_no LIKE ?
      GROUP BY e.cutting_lot_id, e.operator_id, cl.lot_no, cl.manual_lot_number, u.username
      ORDER BY MAX(e.created_at) DESC
      LIMIT ?, ?
    `;

    const [rows] = await pool.query(query, [searchLike, offset, limit]);
    return rows;
  });
}

router.get("/dashboard/api/pendency", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { dept = "stitching", page = 1, size = 50, search = "" } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(size);
    const rows = await fetchPendencyRows(dept, `%${search}%`, offset, parseInt(size));
    return res.json({ data: rows });
  } catch (err) {
    console.error("Error in /dashboard/api/pendency:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/dashboard/pendency/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { dept = "stitching", search = "" } = req.query;
    const rows = await fetchPendencyRows(dept, `%${search}%`, 0, 10000);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Pendency");
    sheet.columns = [
      { header: "Lot No", key: "lot_no", width: 15 },
      { header: "Manual Lot No", key: "manual_lot_number", width: 15 },
      { header: "Operator", key: "username", width: 20 },
      { header: "Assigned", key: "assigned", width: 12 },
      { header: "Completed", key: "completed", width: 12 },
      { header: "Pending", key: "pending", width: 12 }
    ];
    rows.forEach(r => sheet.addRow(r));
    res.setHeader("Content-Disposition", `attachment; filename="${dept}_pendency.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error in /dashboard/pendency/download:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/dashboard/api/lot", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lotNo } = req.query;
    if (!lotNo) return res.status(400).json({ error: "lotNo required" });
    const data = await cache.fetchCached(`lot-${lotNo}`, async () => {
      const [[lot]] = await pool.query(
        `SELECT id, lot_no, sku, fabric_type, total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
        [lotNo]
      );
      if (!lot) return null;
      const [sizes] = await pool.query(
        `SELECT size_label, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
        [lot.id]
      );
      return { lot, sizes };
    });
    if (!data) return res.status(404).json({ error: "Lot not found" });
    return res.json(data);
  } catch (err) {
    console.error("Error in /dashboard/api/lot:", err);
  return res.status(500).json({ error: "Server error" });
  }
});

router.get("/dashboard/employees/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT e.id AS employee_id, e.punching_id, e.name AS employee_name, e.designation,
             e.aadhar_card_number, e.salary, e.salary_type, e.pay_sunday,
             u.username AS supervisor_name, d.name AS department_name,
             (SELECT COALESCE(SUM(amount),0) FROM employee_advances ea WHERE ea.employee_id = e.id) AS total_adv,
             (SELECT COALESCE(SUM(amount),0) FROM advance_deductions ad WHERE ad.employee_id = e.id) AS total_ded
        FROM employees e
        JOIN users u ON e.supervisor_id = u.id
        LEFT JOIN (
              SELECT user_id, MIN(department_id) AS department_id
                FROM department_supervisors
               GROUP BY user_id
        ) ds ON ds.user_id = u.id
        LEFT JOIN departments d ON ds.department_id = d.id
       WHERE e.is_active = 1
       ORDER BY d.name, u.username, e.name
    `);

    const canViewSalary = req.session.user.id === PRIVILEGED_OPERATOR_ID;

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Employees");
    let columns = [
      { header: "Department", key: "department", width: 20 },
      { header: "Supervisor", key: "supervisor", width: 20 },
      { header: "Employee", key: "employee", width: 20 },
      { header: "Designation", key: "designation", width: 20 },
      { header: "Punching ID", key: "punching_id", width: 15 },
      { header: "Aadhar", key: "aadhar", width: 18 },
      { header: "Employee ID", key: "employee_id", width: 12 },
      { header: "Salary Type", key: "salary_type", width: 12 },
      { header: "Pay Sunday", key: "pay_sunday", width: 12 },
      { header: "Salary", key: "salary", width: 12 },
      { header: "Advance Left", key: "advance_left", width: 15 }
    ];
    if (!canViewSalary) {
      columns = columns.filter(c => c.key !== "salary");
    }
    sheet.columns = columns;

    rows.forEach(r => {
      const advLeft = parseFloat(r.total_adv) - parseFloat(r.total_ded);
      const rowData = {
        department: r.department_name || "",
        supervisor: r.supervisor_name,
        employee: r.employee_name,
        designation: r.designation || "",
        punching_id: r.punching_id,
        aadhar: r.aadhar_card_number || "",
        employee_id: r.employee_id,
        salary_type: r.salary_type,
        pay_sunday: r.pay_sunday ? "Yes" : "No",
        advance_left: advLeft
      };
      if (canViewSalary) rowData.salary = r.salary;
      sheet.addRow(rowData);
    });

    res.setHeader("Content-Disposition", 'attachment; filename="EmployeeSummary.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error in /dashboard/employees/download:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/dashboard/lot-departments/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    // Events-sourced per-stage completion counts. Each "complete" event
    // counts once (so a lot with multiple partial completions per stage
    // shows the higher number, matching prior behaviour).
    const rows = await cache.fetchCached("lotDeptCounts-ev", async () => {
      const [data] = await pool.query(`
        SELECT cl.lot_no,
               cl.sku,
               cl.total_pieces AS pieces,
               1                                                            AS cutting,
               (SELECT COUNT(*) FROM stitching_events e
                 WHERE e.cutting_lot_id = cl.id AND e.event_type='complete') AS stitching,
               (SELECT COUNT(*) FROM washing_events e
                 WHERE e.cutting_lot_id = cl.id AND e.event_type='complete') AS washing,
               (SELECT COUNT(*) FROM washing_in_events e
                 WHERE e.cutting_lot_id = cl.id AND e.event_type='complete') AS washing_in,
               (SELECT COUNT(*) FROM finishing_events e
                 WHERE e.cutting_lot_id = cl.id AND e.event_type='complete') AS finishing,
               (SELECT COUNT(*) FROM jeans_assembly_events e
                 WHERE e.cutting_lot_id = cl.id AND e.event_type='complete') AS assembly
          FROM cutting_lots cl
         ORDER BY cl.lot_no
      `);
      return data;
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("LotDeptCounts");
    sheet.columns = [
      { header: "Lot No", key: "lot_no", width: 15 },
      { header: "SKU", key: "sku", width: 20 },
      { header: "Pieces", key: "pieces", width: 10 },
      { header: "Cutting", key: "cutting", width: 10 },
      { header: "Stitching", key: "stitching", width: 10 },
      { header: "Washing", key: "washing", width: 10 },
      { header: "Washing In", key: "washing_in", width: 10 },
      { header: "Finishing", key: "finishing", width: 10 },
      { header: "Assembly", key: "assembly", width: 10 }
    ];
    rows.forEach(r => sheet.addRow(r));
    res.setHeader("Content-Disposition", 'attachment; filename="LotDepartmentCounts.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await workbook.xlsx.write(res);
  res.end();
  } catch (err) {
    console.error("Error in /dashboard/lot-departments/download:", err);
    return res.status(500).send("Server error");
  }
});

// Debug endpoint: Check lot journey for recent lots (temporarily public for testing)
router.get("/debug/lot-journey", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';

    let query = `
      SELECT
        cl.lot_no,
        cl.sku,
        cl.total_pieces,
        cl.remark,
        DATE_FORMAT(cl.created_at, '%Y-%m-%d') as created_date,
        u.username as cutting_master,
        COALESCE((SELECT SUM(pieces) FROM stitching_events
          WHERE cutting_lot_id = cl.id AND event_type='complete'), 0) as stitched,
        COALESCE((SELECT SUM(pieces) FROM jeans_assembly_events
          WHERE cutting_lot_id = cl.id AND event_type='complete'), 0) as assembled,
        COALESCE((SELECT SUM(pieces) FROM washing_events
          WHERE cutting_lot_id = cl.id AND event_type='complete'), 0) as washed,
        COALESCE((SELECT SUM(pieces) FROM washing_in_events
          WHERE cutting_lot_id = cl.id AND event_type='complete'), 0) as wash_in,
        COALESCE((SELECT SUM(pieces) FROM finishing_events
          WHERE cutting_lot_id = cl.id AND event_type='complete'), 0) as finished
      FROM cutting_lots cl
      LEFT JOIN users u ON cl.user_id = u.id
    `;
    const params = [];

    if (search) {
      query += ` WHERE cl.lot_no LIKE ? OR cl.remark LIKE ?`;
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ` ORDER BY cl.created_at DESC LIMIT ?`;
    params.push(limit);

    const [lots] = await pool.query(query, params);

    // Analyze journey
    const analysis = lots.map(lot => {
      const total = lot.total_pieces;
      const stages = [
        { name: 'Cutting', done: total, pct: 100 },
        { name: 'Stitching', done: lot.stitched, pct: Math.round((lot.stitched / total) * 100) },
        { name: 'Assembly', done: lot.assembled, pct: Math.round((lot.assembled / total) * 100) },
        { name: 'Washing', done: lot.washed, pct: Math.round((lot.washed / total) * 100) },
        { name: 'Wash-In', done: lot.wash_in, pct: Math.round((lot.wash_in / total) * 100) },
        { name: 'Finishing', done: lot.finished, pct: Math.round((lot.finished / total) * 100) }
      ];

      // Find current stage
      let currentStage = 'Unknown';
      if (lot.finished >= total) currentStage = 'Completed';
      else if (lot.wash_in > 0) currentStage = 'Wash-In';
      else if (lot.washed > 0) currentStage = 'Washing';
      else if (lot.assembled > 0) currentStage = 'Assembly';
      else if (lot.stitched > 0) currentStage = 'Stitching';
      else currentStage = 'Cutting';

      // Check for issues
      const issues = [];
      if (lot.stitched > total) issues.push('Stitched > Total');
      if (lot.finished > lot.stitched && lot.stitched > 0) issues.push('Finished > Stitched');
      if (lot.assembled > 0 && lot.stitched === 0) issues.push('Assembly without Stitching');

      return {
        lot_no: lot.lot_no,
        sku: lot.sku,
        total: total,
        remark: lot.remark,
        cutting_master: lot.cutting_master,
        created: lot.created_date,
        currentStage,
        stages,
        issues: issues.length > 0 ? issues : null,
        healthy: issues.length === 0
      };
    });

    const summary = {
      checked: lots.length,
      healthy: analysis.filter(a => a.healthy).length,
      withIssues: analysis.filter(a => !a.healthy).length
    };

    res.json({ summary, lots: analysis });
  } catch (err) {
    console.error("Debug lot journey error:", err);
    res.status(500).json({ error: err.message });
  }
});

async function buildWasherMonthlySummary(prefix) {
  // Sourced from washing_events (truth source). One approve event = an
  // assignment of `pieces` to this washer in that month; one complete event
  // = pieces completed by this washer in that month.
  return cache.fetchCached(`washerSummary-ev-${prefix}`, async () => {
  const [assignRows] = await pool.query(
    `SELECT we.operator_id AS user_id, u.username,
            DATE_FORMAT(we.created_at,'%Y-%m') AS month,
            we.pieces, cl.lot_no,
            cl.total_pieces AS cutting_pieces,
            cl.remark
       FROM washing_events we
       JOIN users u        ON u.id = we.operator_id
       JOIN cutting_lots cl ON cl.id = we.cutting_lot_id
      WHERE we.event_type = 'approve' AND cl.lot_no LIKE ?`,
    [prefix]
  );
  const [compRows] = await pool.query(
    `SELECT we.operator_id AS user_id,
            DATE_FORMAT(we.created_at,'%Y-%m') AS month,
            SUM(we.pieces) AS completed
       FROM washing_events we
       JOIN cutting_lots cl ON cl.id = we.cutting_lot_id
      WHERE we.event_type = 'complete' AND cl.lot_no LIKE ?
      GROUP BY we.operator_id, month`,
    [prefix]
  );

  const map = {};
  function ensure(uid, month, name) {
    const key = `${uid}-${month}`;
    if (!map[key]) {
      map[key] = { washer: name, month, assigned: 0, completed: 0, cutting: 0, _lots: new Set() };
    }
    return map[key];
  }

  assignRows.forEach(r => {
    const entry = ensure(r.user_id, r.month, r.username);
    entry.assigned += parseFloat(r.pieces) || 0;
    if (!entry._lots.has(r.lot_no)) {
      entry._lots.add(r.lot_no);
      if (!r.remark || !r.remark.toLowerCase().includes('date')) {
        entry.cutting += parseFloat(r.cutting_pieces) || 0;
      }
    }
  });

  compRows.forEach(r => {
    const entry = ensure(r.user_id, r.month, '');
    entry.completed += parseFloat(r.completed) || 0;
  });

  return Object.values(map).map(r => ({
    washer: r.washer,
    month: r.month,
    assigned: r.assigned,
    completed: r.completed,
    cutting: r.cutting,
    pending: r.assigned - r.completed,
    completionRate: r.assigned > 0
      ? parseFloat(((r.completed / r.assigned) * 100).toFixed(2))
      : 0
  }));
  }); // End of cache.fetchCached
}

router.get("/dashboard/washing-summary/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheetAk = workbook.addWorksheet("AK Lots");
    const sheetUm = workbook.addWorksheet("UM Lots");
    const columns = [
      { header: "Washer", key: "washer", width: 20 },
      { header: "Month", key: "month", width: 10 },
      { header: "Assigned", key: "assigned", width: 12 },
      { header: "Completed", key: "completed", width: 12 },
      { header: "Pending", key: "pending", width: 12 },
      { header: "Completion %", key: "completionRate", width: 15 },
      { header: "Cutting", key: "cutting", width: 12 }
    ];
    sheetAk.columns = columns;
    sheetUm.columns = columns;

    const [akData, umData] = await Promise.all([
      buildWasherMonthlySummary('AK%'),
      buildWasherMonthlySummary('UM%')
    ]);
    akData.forEach(r => sheetAk.addRow(r));
    umData.forEach(r => sheetUm.addRow(r));

    res.setHeader('Content-Disposition', 'attachment; filename="WasherMonthlySummary.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error in /dashboard/washing-summary/download:", err);
    return res.status(500).send("Server error");
  }
});

/**************************************************
 * Roll-wise Consumption Report
 * consumption = total_pieces / weight_used
 **************************************************/
router.get("/dashboard/consumption/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        l.fabric_type,
        l.lot_no,
        l.manual_lot_number,
        DATE_FORMAT(COALESCE(l.manual_cutting_date, l.created_at), '%d-%m-%Y') AS cutting_date,
        CASE
          WHEN LOWER(l.flow_type) = 'denim'   THEN 'Denim'
          WHEN LOWER(l.flow_type) = 'hosiery' THEN 'Hosiery'
          ELSE COALESCE(l.flow_type, '')
        END AS flow_type,
        l.sku,
        l.remark AS cutting_remark,
        r.roll_no,
        r.layers,
        r.total_pieces AS pieces_in_roll,
        r.weight_used,
        COALESCE(r.remaining_weight, 0) AS remaining_weight,
        ROUND(COALESCE(r.weight_used, 0) + COALESCE(r.remaining_weight, 0), 2) AS total_weight,
        CASE
          WHEN r.weight_used > 0 THEN ROUND(r.total_pieces / r.weight_used, 2)
          ELSE 0
        END AS consumption
      FROM cutting_lot_rolls r
      JOIN cutting_lots l ON r.cutting_lot_id = l.id
      ORDER BY l.created_at DESC, r.roll_no
    `);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Kotty Track - Consumption Report";
    const sheet = workbook.addWorksheet("Consumption Report");

    sheet.columns = [
      { header: "Fabric Type", key: "fabric_type", width: 18 },
      { header: "Lot No", key: "lot_no", width: 15 },
      { header: "Manual Lot No", key: "manual_lot_number", width: 16 },
      { header: "Cutting Date", key: "cutting_date", width: 14 },
      { header: "Type", key: "flow_type", width: 12 },
      { header: "SKU", key: "sku", width: 25 },
      { header: "Cutting Remark", key: "cutting_remark", width: 30 },
      { header: "Roll No", key: "roll_no", width: 12 },
      { header: "Layers", key: "layers", width: 10 },
      { header: "Pieces in Roll", key: "pieces_in_roll", width: 15 },
      { header: "Weight Used (kg)", key: "weight_used", width: 16 },
      { header: "Remaining Weight (kg)", key: "remaining_weight", width: 20 },
      { header: "Total Weight (kg)", key: "total_weight", width: 17 },
      { header: "Consumption (pcs/kg)", key: "consumption", width: 18 }
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E0D8' }
    };

    rows.forEach(r => sheet.addRow(r));

    res.setHeader("Content-Disposition", 'attachment; filename="ConsumptionReport.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("Error in /dashboard/consumption/download:", err);
    return res.status(500).send("Server error");
  }
});

/**************************************************
 * Security: View failed login attempts
 * GET /operator/security-logs
 **************************************************/
router.get("/security-logs", isAuthenticated, isOperator, async (req, res) => {
  try {
    // Ensure table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_audit_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        event_type VARCHAR(50) NOT NULL,
        username VARCHAR(100),
        ip_address VARCHAR(50),
        user_agent TEXT,
        details JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event_type (event_type),
        INDEX idx_ip_address (ip_address),
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const days = parseInt(req.query.days) || 7;

    // Get failed login attempts grouped by IP
    const [suspiciousIPs] = await pool.query(`
      SELECT
        ip_address,
        COUNT(DISTINCT username) as unique_users_tried,
        COUNT(*) as total_attempts,
        GROUP_CONCAT(DISTINCT username ORDER BY username SEPARATOR ', ') as usernames,
        MAX(created_at) as last_attempt
      FROM security_audit_log
      WHERE event_type = 'LOGIN_FAILED'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY ip_address
      HAVING COUNT(*) >= 3
      ORDER BY total_attempts DESC
      LIMIT 50
    `, [days]);

    // Get recent failed logins
    const [recentFailed] = await pool.query(`
      SELECT
        username,
        ip_address,
        user_agent,
        details,
        created_at
      FROM security_audit_log
      WHERE event_type = 'LOGIN_FAILED'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY created_at DESC
      LIMIT 100
    `, [days]);

    // Get login success count by user (last 7 days)
    const [loginStats] = await pool.query(`
      SELECT
        username,
        COUNT(*) as login_count,
        COUNT(DISTINCT ip_address) as unique_ips,
        MAX(created_at) as last_login
      FROM security_audit_log
      WHERE event_type = 'LOGIN_SUCCESS'
        AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY username
      ORDER BY login_count DESC
      LIMIT 50
    `, [days]);

    res.json({
      success: true,
      period: `Last ${days} days`,
      suspiciousIPs,
      recentFailedLogins: recentFailed,
      loginStats,
      summary: {
        totalFailedAttempts: recentFailed.length,
        suspiciousIPCount: suspiciousIPs.length,
        uniqueUsersWithLogins: loginStats.length
      }
    });
  } catch (err) {
    console.error("Error fetching security logs:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**************************************************
 * 4) CSV/Excel leftover exports – same as your code
 **************************************************/
// e.g. /dashboard/leftovers/download, etc. unchanged

/**************************************************
 * 5) Pendency-Reports – unchanged
 **************************************************/
// e.g. /pendency-report/stitching, etc. unchanged

/**************************************************
 * 6) PIC Report – corrected chain
 **************************************************/
// Quick helper: isDenimLot - checks lot type using flow_type, is_denim_cutter, or lot prefix
/**************************************************
 * 6) PIC Report helpers — extracted to utils/picSizeReport.js
 **************************************************/
const {
  isDenimLot,
  buildEnhancedRow,
  PIC_REPORT_V2_COLUMNS,
  fetchLotEventAggregates,
  fetchLotSizeEventSums,
  getDepartmentStatuses,
  filterByDept,
} = require("../utils/picSizeReport");


/** The final PIC Report route */
/*******************************************************************
 * PIC‑Report Route – with updated date‑filter for department "washing_in"
 *******************************************************************/
// ======================== REPLACEMENT CODE ========================

router.get("/dashboard/pic-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    const {
      lotType = "all",
      department = "all",
      status = "all",
      dateFilter = "createdAt",
      startDate = "",
      endDate = "",
      download = ""
    } = req.query;

    // 1) Build filters for main lots query
    let dateWhere = "";
    let dateParams = [];

    // Default to last 90 days if no date range specified (prevents loading all 7000+ lots)
    let effectiveStartDate = startDate;
    let effectiveEndDate = endDate;
    if (!startDate || !endDate) {
      const now = new Date();
      effectiveEndDate = now.toISOString().slice(0, 10);
      const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      effectiveStartDate = past.toISOString().slice(0, 10);
      dateWhere = " AND DATE(cl.created_at) >= ? ";
      dateParams.push(effectiveStartDate);
    }

    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        // Sourced from *_events tables — same approach as the rest of the report.
        const evtTable = {
          stitching:  'stitching_events',
          assembly:   'jeans_assembly_events',
          washing:    'washing_events',
          washing_in: 'washing_in_events',
          finishing:  'finishing_events',
        }[department];
        if (evtTable) {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM ${evtTable} e
               WHERE e.cutting_lot_id = cl.id
                 AND e.event_type = 'approve'
                 AND DATE(e.created_at) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        }
      }
    }

    let lotTypeClause = "";
    if (lotType === "denim") {
      lotTypeClause = `
        AND (
          cl.flow_type = 'denim'
          OR (cl.flow_type IS NULL AND u.is_denim_cutter = 1)
          OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND (cl.lot_no LIKE 'AK%' OR cl.lot_no LIKE 'UM%'))
        )
      `;
    } else if (lotType === "hosiery") {
      lotTypeClause = `
        AND (
          cl.flow_type = 'hosiery'
          OR (cl.flow_type IS NULL AND u.is_denim_cutter = 0)
          OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND cl.lot_no NOT LIKE 'AK%' AND cl.lot_no NOT LIKE 'UM%')
        )
      `;
    }

    // 2) Fetch all lots (ONE QUERY)
    const baseQuery = `
      SELECT cl.lot_no, cl.manual_lot_number, cl.sku, cl.fabric_type, cl.total_pieces, cl.created_at, cl.manual_cutting_date, cl.remark, cl.flow_type,
             u.username AS created_by, u.is_denim_cutter
        FROM cutting_lots cl
        JOIN users u ON cl.user_id = u.id
       WHERE 1=1
         ${lotTypeClause}
         ${dateWhere}
       ORDER BY cl.created_at DESC
    `;
    const [lots] = await pool.query(baseQuery, dateParams);

    // Gather all lot_nos in an array for IN () usage
    const lotNos = lots.map(l => l.lot_no);
    if (!lotNos.length) {
      // No lots found => just return
      if (download === "1") {
        return res.status(200).send("No data to download");
      } else {
        return res.render("operatorPICReport", {
          filters: { lotType, department, status, dateFilter, startDate, endDate },
          rows: []
        });
      }
    }

    // 3) Aggregate per-lot quantities and fetch last assignments in a batched manner
    // Sourced from *_events tables — the legacy *_assignments / *_data tables
    // are only partially kept in sync (see fetchLotEventAggregates).
    const { lotSumsMap, stitchMap, asmMap, washMap, winMap, finMap } = await fetchLotEventAggregates(lotNos);

    // --- Rewash quantities (requested / pending / completed) ---
    const [rewashRows] = await pool.query(
      `SELECT lot_no,
              SUM(total_requested) AS requestedQty,
              SUM(CASE WHEN status='pending'   THEN total_requested ELSE 0 END) AS pendingQty,
              SUM(CASE WHEN status='completed' THEN total_requested ELSE 0 END) AS completedQty
         FROM rewash_requests
        WHERE lot_no IN (?)
        GROUP BY lot_no`,
      [lotNos]
    );
    const rewashMap = {};
    for (const row of rewashRows) {
      rewashMap[row.lot_no] = {
        requested: parseFloat(row.requestedQty)  || 0,
        pending:   parseFloat(row.pendingQty)    || 0,
        completed: parseFloat(row.completedQty)  || 0
      };
    }

    // --- Rejects by lot + stage (with concatenated reasons) ---
    const [rejectRows] = await pool.query(
      `SELECT lot_no, stage,
              COALESCE(SUM(total_pieces),0) AS pieces,
              GROUP_CONCAT(DISTINCT NULLIF(reason,'') ORDER BY reason SEPARATOR '; ') AS reasons
         FROM reject_data
        WHERE lot_no IN (?)
        GROUP BY lot_no, stage`,
      [lotNos]
    );
    const rejectMap = {}; // { lot_no: { stitching:{pieces,reasons}, washing_in:..., finishing:... } }
    for (const r of rejectRows) {
      if (!rejectMap[r.lot_no]) rejectMap[r.lot_no] = {};
      rejectMap[r.lot_no][r.stage] = {
        pieces:  parseFloat(r.pieces) || 0,
        reasons: r.reasons || ''
      };
    }

    // 5) Now build finalData from these maps
    const finalData = [];
    for (const lot of lots) {
      const lotNo = lot.lot_no;
      const totalCut = parseFloat(lot.total_pieces) || 0;
      const denim = isDenimLot(lot);

      // Sums
      const sums = lotSumsMap[lotNo] || {};
      const stitchedQty  = sums.stitchedQty   || 0;
      const assembledQty = sums.assembledQty  || 0;
      const washedQty    = sums.washedQty     || 0;
      const washingInQty = sums.washingInQty  || 0;
      const finishedQty  = sums.finishedQty   || 0;
      // per-stage approved (In) + dispatched (finishing's "next approval")
      const approvedSums = {
        stitchApproved: sums.stitchApproved || 0,
        assemblyApproved: sums.assemblyApproved || 0,
        washingApproved: sums.washingApproved || 0,
        washInApproved: sums.washInApproved || 0,
        finishingApproved: sums.finishingApproved || 0,
      };
      const dispatchedQty = sums.dispatched || 0;
      const rewashInfo   = rewashMap[lotNo]   || { requested:0, pending:0, completed:0 };
      const rejectsInfo  = rejectMap[lotNo]   || {};

      // Last assignments
      const stAssign  = stitchMap[lotNo]  || null;
      const asmAssign = asmMap[lotNo]     || null;
      const washAssign= washMap[lotNo]    || null;
      const wInAssign = winMap[lotNo]     || null;
      const finAssign = finMap[lotNo]     || null;

      // Calculate statuses
      const statuses = getDepartmentStatuses({
        isDenim: denim,
        totalCut,
        stitchedQty,
        assembledQty,
        washedQty,
        washingInQty,
        finishedQty,
        stAssign,
        asmAssign,
        washAssign,
        washInAssign: wInAssign,
        finAssign,
        ...approvedSums,
        dispatched: dispatchedQty
      });

      // Decide if we show row based on department filter
      const deptResult = filterByDept({
        department,
        isDenim: denim,
        stitchingStatus: statuses.stitchingStatus,
        assemblyStatus: statuses.assemblyStatus,
        washingStatus: statuses.washingStatus,
        washingInStatus: statuses.washingInStatus,
        finishingStatus: statuses.finishingStatus
      });
      if (!deptResult.showRow) continue;

      // Check overall status filter
      const actualStatus = deptResult.actualStatus.toLowerCase();
      if (status !== "all") {
        if (status === "not_assigned") {
          // means "In <some dept>"
          if (!actualStatus.startsWith("in ")) continue;
        } else {
          const want = status.toLowerCase();
          if (want === "inline" && actualStatus.includes("in-line")) {
            // pass
          } else if (!actualStatus.includes(want)) {
            continue;
          }
        }
      }

      finalData.push(buildEnhancedRow({
        lot,
        isDenim: denim,
        totalCut,
        sums: { stitchedQty, assembledQty, washedQty, washingInQty, finishedQty },
        assigns: { stAssign, asmAssign, washAssign, washInAssign: wInAssign, finAssign },
        approved: approvedSums,
        dispatched: dispatchedQty,
        rewash: rewashInfo,
        rejects: rejectsInfo
      }));
    }

    // 6) If download => Excel (v2 user-friendly schema)
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Report v2";

      const sheet = workbook.addWorksheet("PIC-Report");
      sheet.columns = PIC_REPORT_V2_COLUMNS;

      for (const r of finalData) sheet.addRow(r);

      // Header styling
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', xSplit: 4, ySplit: 1 }];

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="PICReport.xlsx"'
      );
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // 7) Render HTML
      return res.render("operatorPICReport", {
        user: req.user,
        filters: { lotType, department, status, dateFilter, startDate, endDate },
        rows: finalData
      });
    }
  } catch (err) {
    console.error("Error in /dashboard/pic-report:", err);
    return res.status(500).send("Server error");
  }
});

// ======================== SIZE PIC REPORT ========================
router.get("/dashboard/pic-size-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    const {
      lotType = "all",
      department = "all",
      status = "all",
      dateFilter = "createdAt",
      download = ""
    } = req.query;

    // Default to last 7 days if no dates specified (for faster initial load)
    let { startDate = "", endDate = "" } = req.query;
    if (!startDate || !endDate) {
      const today = new Date();
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      endDate = today.toISOString().split('T')[0];
      startDate = weekAgo.toISOString().split('T')[0];
    }

    // 1) Build filters for main lots query (same logic as pic-report)
    let dateWhere = "";
    let dateParams = [];

    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        const evtTable = {
          stitching:  'stitching_events',
          assembly:   'jeans_assembly_events',
          washing:    'washing_events',
          washing_in: 'washing_in_events',
          finishing:  'finishing_events',
        }[department];
        if (evtTable) {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM ${evtTable} e
               WHERE e.cutting_lot_id = cl.id
                 AND e.event_type = 'approve'
                 AND DATE(e.created_at) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        }
      }
    }

    let lotTypeClause = "";
    if (lotType === "denim") {
      lotTypeClause = `
        AND (
          cl.flow_type = 'denim'
          OR (cl.flow_type IS NULL AND u.is_denim_cutter = 1)
          OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND (cl.lot_no LIKE 'AK%' OR cl.lot_no LIKE 'UM%'))
        )
      `;
    } else if (lotType === "hosiery") {
      lotTypeClause = `
        AND (
          cl.flow_type = 'hosiery'
          OR (cl.flow_type IS NULL AND u.is_denim_cutter = 0)
          OR (cl.flow_type IS NULL AND u.is_denim_cutter IS NULL AND cl.lot_no NOT LIKE 'AK%' AND cl.lot_no NOT LIKE 'UM%')
        )
      `;
    }

    // 2) Fetch lot/size rows (with LIMIT for performance)
    const baseQuery = `
      SELECT cl.lot_no, cl.manual_lot_number, cl.sku, cl.fabric_type, cls.size_label, cls.total_pieces, cl.created_at, cl.remark, cl.flow_type,
             u.username AS created_by, u.is_denim_cutter
        FROM cutting_lots cl
        JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
        JOIN users u ON cl.user_id = u.id
       WHERE 1=1
         ${lotTypeClause}
         ${dateWhere}
       ORDER BY cl.created_at DESC
       LIMIT 5000
    `;
    const [rows] = await pool.query(baseQuery, dateParams);

    const lotNos = [...new Set(rows.map(r => r.lot_no))];
    if (!lotNos.length) {
      if (download === "1") {
        return res.status(200).send("No data to download");
      } else {
        return res.render("operatorSizeReport", {
          filters: { lotType, department, status, dateFilter, startDate, endDate },
          rows: []
        });
      }
    }

    // 3) Per-(lot, size) completed pieces by stage — sourced from *_event_sizes
    //    (truth source; the legacy *_data_sizes tables are only partial).
    const sizeEventSums = await fetchLotSizeEventSums(lotNos);

    // Query for dispatched quantities and destinations
    const [dispatchRows] = await pool.query(`
      SELECT fdp.lot_no, fdp.size_label,
             COALESCE(SUM(fdp.quantity),0) AS dispatchedQty,
             GROUP_CONCAT(DISTINCT fdp.destination ORDER BY fdp.sent_at DESC SEPARATOR ', ') AS destinations
        FROM finishing_dispatches fdp
       WHERE fdp.lot_no IN (?)
       GROUP BY fdp.lot_no, fdp.size_label
    `, [lotNos]);

    const dispatchMap = {};
    for (const d of dispatchRows) {
      const key = `${d.lot_no}|${d.size_label}`;
      dispatchMap[key] = { dispatchedQty: parseFloat(d.dispatchedQty) || 0, destinations: d.destinations || '' };
    }

    const sizeSumsMap = {};
    for (const r of rows) {
      const key = `${r.lot_no}|${r.size_label}`;
      const fromEvents = sizeEventSums[key];
      sizeSumsMap[key] = fromEvents
        ? { ...fromEvents }
        : { stitchedQty:0, assembledQty:0, washedQty:0, washingInQty:0, finishedQty:0 };
    }

    // 4) Latest approve event per lot+stage (same shape as pic-report).
    const { stitchMap, asmMap, washMap, winMap, finMap } = await fetchLotEventAggregates(lotNos);

    // 4a) Rewash totals per lot (lot-level aggregate; same as pic-report)
    const [rewashRows2] = await pool.query(
      `SELECT lot_no,
              SUM(total_requested) AS requestedQty,
              SUM(CASE WHEN status='pending'   THEN total_requested ELSE 0 END) AS pendingQty,
              SUM(CASE WHEN status='completed' THEN total_requested ELSE 0 END) AS completedQty
         FROM rewash_requests
        WHERE lot_no IN (?)
        GROUP BY lot_no`,
      [lotNos]
    );
    const rewashMap = {};
    for (const r of rewashRows2) {
      rewashMap[r.lot_no] = {
        requested: parseFloat(r.requestedQty)  || 0,
        pending:   parseFloat(r.pendingQty)    || 0,
        completed: parseFloat(r.completedQty)  || 0
      };
    }

    // 4b) Rejects per lot+size+stage
    const [sizeRejectRows] = await pool.query(
      `SELECT rd.lot_no, rd.stage, rds.size_label,
              COALESCE(SUM(rds.pieces),0) AS pieces,
              GROUP_CONCAT(DISTINCT NULLIF(rd.reason,'') ORDER BY rd.reason SEPARATOR '; ') AS reasons
         FROM reject_data rd
         JOIN reject_data_sizes rds ON rds.reject_data_id = rd.id
        WHERE rd.lot_no IN (?)
        GROUP BY rd.lot_no, rd.stage, rds.size_label`,
      [lotNos]
    );
    const rejectSizeMap = {}; // key = lot|size, val = {stitching:{pieces,reasons}, ...}
    for (const r of sizeRejectRows) {
      const key = `${r.lot_no}|${r.size_label}`;
      if (!rejectSizeMap[key]) rejectSizeMap[key] = {};
      rejectSizeMap[key][r.stage] = {
        pieces: parseFloat(r.pieces) || 0,
        reasons: r.reasons || ''
      };
    }

    // 5) Build final data
    const finalData = [];
    for (const row of rows) {
      const lotNo = row.lot_no;
      const sizeLabel = row.size_label;
      const totalCut = parseFloat(row.total_pieces) || 0;
      const denim = isDenimLot(row);

      const sums = sizeSumsMap[`${lotNo}|${sizeLabel}`] || {};
      const stitchedQty  = sums.stitchedQty  || 0;
      const assembledQty = sums.assembledQty || 0;
      const washedQty    = sums.washedQty    || 0;
      const washingInQty = sums.washingInQty || 0;
      const finishedQty  = sums.finishedQty  || 0;
      // per-size approved (In) + dispatched (finishing's "next approval")
      const approvedSums = {
        stitchApproved: sums.stitchApproved || 0,
        assemblyApproved: sums.assemblyApproved || 0,
        washingApproved: sums.washingApproved || 0,
        washInApproved: sums.washInApproved || 0,
        finishingApproved: sums.finishingApproved || 0,
      };
      const dispatch = dispatchMap[`${lotNo}|${sizeLabel}`] || {};
      const dispatchedQty = dispatch.dispatchedQty || 0;

      const stAssign  = stitchMap[lotNo] || null;
      const asmAssign = asmMap[lotNo]    || null;
      const washAssign= washMap[lotNo]   || null;
      const wInAssign = winMap[lotNo]    || null;
      const finAssign = finMap[lotNo]    || null;

      const statuses = getDepartmentStatuses({
        isDenim: denim,
        totalCut,
        stitchedQty,
        assembledQty,
        washedQty,
        washingInQty,
        finishedQty,
        stAssign,
        asmAssign,
        washAssign,
        washInAssign: wInAssign,
        finAssign,
        ...approvedSums,
        dispatched: dispatchedQty
      });

      const deptResult = filterByDept({
        department,
        isDenim: denim,
        stitchingStatus: statuses.stitchingStatus,
        assemblyStatus: statuses.assemblyStatus,
        washingStatus: statuses.washingStatus,
        washingInStatus: statuses.washingInStatus,
        finishingStatus: statuses.finishingStatus
      });
      if (!deptResult.showRow) continue;

      const actualStatus = deptResult.actualStatus.toLowerCase();
      if (status !== "all") {
        if (status === "not_assigned") {
          if (!actualStatus.startsWith("in ")) continue;
        } else {
          const want = status.toLowerCase();
          if (want === "inline" && actualStatus.includes("in-line")) {
          } else if (!actualStatus.includes(want)) {
            continue;
          }
        }
      }

      const lotForBuilder = {
        lot_no: lotNo,
        manual_lot_number: row.manual_lot_number,
        sku: row.sku,
        fabric_type: row.fabric_type,
        remark: row.remark,
        created_at: row.created_at
      };
      const enriched = buildEnhancedRow({
        lot: lotForBuilder,
        isDenim: denim,
        totalCut, // per-size cut from cutting_lot_sizes — correct baseline
        sums: { stitchedQty, assembledQty, washedQty, washingInQty, finishedQty },
        assigns: { stAssign, asmAssign, washAssign, washInAssign: wInAssign, finAssign },
        approved: approvedSums,
        dispatched: dispatchedQty,
        rewash: rewashMap[lotNo] || { requested:0, pending:0, completed:0 },
        rejects: rejectSizeMap[`${lotNo}|${sizeLabel}`] || {}
      });
      // size-specific overrides
      enriched.size = sizeLabel;
      enriched.sku_size = `${row.sku}_${sizeLabel}`;
      enriched.dispatchedQty = dispatchedQty;
      enriched.destinations  = dispatch.destinations  || '';

      finalData.push(enriched);
    }

    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Size Report v2";

      const sheet = workbook.addWorksheet("PIC-Size-Report");

      // Size-aware column set: same shape as PIC v2 + Size + dispatch columns
      const sizeCols = [
        { header: 'Lot No',              key: 'lotNo',             width: 14 },
        { header: 'Manual Lot No',       key: 'externalLotNo',     width: 14 },
        { header: 'Fabric Type',         key: 'fabricType',        width: 14 },
        { header: 'SKU',                 key: 'sku',               width: 22 },
        { header: 'Size',                key: 'size',              width: 8  },
        { header: 'SKU_Size',            key: 'sku_size',          width: 24 },
        { header: 'Lot Type',            key: 'lotType',           width: 9  },
        { header: 'Created At',          key: 'createdAt',         width: 12 },
        { header: 'Days Since Created',  key: 'daysSinceCreated',  width: 10 },
        { header: 'Lot Total Cut',       key: 'totalCut',          width: 10 },
        { header: 'Current Stage',       key: 'currentStage',      width: 14 },
        { header: 'Current Pending Qty', key: 'currentPendingQty', width: 12 },
        { header: 'Days In Stage',       key: 'daysInStage',       width: 10 },
        { header: 'Remark',              key: 'remark',            width: 26 }
      ];
      const stageColKeys = new Set([
        'stitchOp','stitchAssignedOn','stitchApprovedOn','stitchInQty','stitchOutQty','stitchPendingQty','stitchStatus','stitchInline',
        'assemblyOp','assemblyAssignedOn','assemblyApprovedOn','assemblyInQty','assemblyOutQty','assemblyPendingQty','assemblyStatus','assemblyInline',
        'washingOp','washingAssignedOn','washingApprovedOn','washingInQty_in','washingOutQty','washingPendingQty','washingStatus','washingInline',
        'washInOp','washInAssignedOn','washInApprovedOn','washInInQty','washInOutQty','washInPendingQty','washInStatus','washInInline',
        'rewashRequestedQty','rewashPendingQty','rewashCompletedQty',
        'finishingOp','finishingAssignedOn','finishingApprovedOn','finishingInQty','finishingOutQty','finishingPendingQty','finishingStatus',
        'stitchRejectQty','stitchRejectReasons','washInRejectQty','washInRejectReasons','finishingRejectQty','finishingRejectReasons','totalRejectQty'
      ]);
      for (const c of PIC_REPORT_V2_COLUMNS) {
        if (stageColKeys.has(c.key)) sizeCols.push(c);
      }
      sizeCols.push({ header: 'Dispatched Qty',       key: 'dispatchedQty', width: 12 });
      sizeCols.push({ header: 'Dispatch Destination', key: 'destinations',  width: 26 });
      sheet.columns = sizeCols;

      for (const r of finalData) sheet.addRow(r);

      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', xSplit: 6, ySplit: 1 }];

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="PICReport-BySize.xlsx"'
      );
      await workbook.xlsx.write(res);
      res.end();
    } else {
      return res.render("operatorSizeReport", {
        user: req.user,
        filters: { lotType, department, status, dateFilter, startDate, endDate },
        rows: finalData
      });
    }
  } catch (err) {
    console.error("Error in /dashboard/pic-size-report:", err);
    return res.status(500).send("Server error");
  }
});

/**
 * getDepartmentStatuses() and filterByDept() remain the same as in your original code
 * (no changes needed, just reuse them).
 * ...
 */


/**************************************************
 * Stitching TAT Dashboard
 **************************************************/
/**************************************************
 * 1) OPERATOR STITCHING TAT (SUMMARY)
 *    => GET /stitching-tat
 * 
 *    - Lists all Stitching Masters who have at least
 *      one "pending" or "in-line" lot
 *    - Each card shows:
 *        masterName
 *        # pending approval
 *        # in line
 *        [Download TAT Excel] button
 *        [View TAT Details] link
 *    - If ?download=1, returns an Excel summary
 **************************************************/
router.get("/stitching-tat", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { download = "0" } = req.query;
    const masterCards = await cache.fetchCached(`tat-summary-ev-${download}`, async () => {
      // Sourced from stitching_events (truth source).
      //
      //   inLinePieces    = approved - completed - rejected
      //                     (currently being stitched by this master)
      //   pendingApproval = completed by master, but downstream (assembly for
      //                     denim / finishing for hosiery) hasn't taken
      //                     delivery yet
      //
      // For hosiery-era / pre-events lots, downstream may live only in the
      // legacy *_data tables — those are treated as "handed off" so a lot
      // that's been long-since cleared doesn't sit forever in pendingApproval.
      const [summary] = await pool.query(`
        SELECT t.user_id, u.username,
               SUM(t.inLinePcs)      AS inLinePieces,
               SUM(t.unhandedOffPcs) AS pendingApproval
          FROM (
            SELECT se.operator_id AS user_id,
                   cl.id          AS cutting_lot_id,
                   GREATEST(0,
                     SUM(CASE WHEN se.event_type='approve'  THEN se.pieces ELSE 0 END)
                     - SUM(CASE WHEN se.event_type='complete' THEN se.pieces ELSE 0 END)
                     - SUM(CASE WHEN se.event_type='reject'   THEN se.pieces ELSE 0 END)
                   ) AS inLinePcs,
                   CASE
                     WHEN SUM(CASE WHEN se.event_type='complete' THEN se.pieces ELSE 0 END) > 0
                      AND NOT EXISTS (SELECT 1 FROM jeans_assembly_events ae WHERE ae.cutting_lot_id=cl.id AND ae.event_type='approve')
                      AND NOT EXISTS (SELECT 1 FROM finishing_events fe      WHERE fe.cutting_lot_id=cl.id AND fe.event_type='approve')
                      AND NOT EXISTS (SELECT 1 FROM jeans_assembly_data jd   WHERE jd.lot_no=cl.lot_no)
                      AND NOT EXISTS (SELECT 1 FROM finishing_data fd        WHERE fd.lot_no=cl.lot_no)
                     THEN SUM(CASE WHEN se.event_type='complete' THEN se.pieces ELSE 0 END)
                     ELSE 0
                   END AS unhandedOffPcs
              FROM stitching_events se
              JOIN cutting_lots cl ON cl.id = se.cutting_lot_id
             GROUP BY se.operator_id, cl.id
          ) t
          JOIN users u ON u.id = t.user_id
         GROUP BY t.user_id, u.username
         HAVING inLinePieces > 0 OR pendingApproval > 0
      `);

      return summary.map(r => ({
        masterId: r.user_id,
        username: r.username,
        pendingApproval: parseFloat(r.pendingApproval) || 0,
        inLinePieces:    parseFloat(r.inLinePieces) || 0
      }));
    });

    // 3) If ?download=1 => produce Excel summary
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("StitchingTAT-Summary");

      sheet.columns = [
        { header: "Master ID",        key: "masterId",       width: 12 },
        { header: "Master Username",  key: "username",        width: 25 },
        { header: "Pending Pieces",   key: "pendingApproval", width: 18 },
        { header: "In-Line Pieces",   key: "inLinePieces",    width: 18 }
      ];

      masterCards.forEach((mc) => {
        sheet.addRow({
          masterId: mc.masterId,
          username: mc.username,
          pendingApproval: mc.pendingApproval,
          inLinePieces: mc.inLinePieces
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader("Content-Disposition", 'attachment; filename="StitchingTAT-Summary.xlsx"');
      await workbook.xlsx.write(res);
      return res.end();
    }

    // 4) Otherwise render the summary page in HTML
    return res.render("operatorStitchingTat", { masterCards });
  } catch (err) {
    console.error("Error in /stitching-tat:", err);
    return res.status(500).send("Server error in /stitching-tat");
  }
});

/**************************************************
 * 2) OPERATOR TAT DETAIL for a MASTER
 *    => GET /stitching-tat/:masterId
 * 
 *    - Shows only lots that are pending or in line
 *    - If ?download=1 => Excel
 *    - Otherwise => HTML table
 *    - TAT in days = (nextAssignedOn - assignedOn) or (today - assignedOn)
 *    - Date fields in DD/MM/YYYY
 **************************************************/
router.get("/stitching-tat/:masterId", isAuthenticated, isOperator, async (req, res) => {
  try {
    const masterId = parseInt(req.params.masterId, 10);
    if (isNaN(masterId)) {
      return res.status(400).send("Invalid Master ID");
    }
    const { download = "0" } = req.query;
    const data = await cache.fetchCached(`tat-detail-ev-${masterId}`, async () => {
      const [[masterUser]] = await pool.query(
        `SELECT id, username FROM users WHERE id = ?`,
        [masterId]
      );
      if (!masterUser) return null;

      // Events-sourced: per (master, lot) get totals + timestamps. Surface
      // only lots still in line or completed but not handed off downstream.
      const [rows] = await pool.query(`
        SELECT cl.lot_no,
               cl.sku,
               cl.total_pieces,
               cl.remark AS cutting_remark,
               MIN(CASE WHEN se.event_type='approve'  THEN se.created_at END) AS firstApproveAt,
               MAX(CASE WHEN se.event_type='complete' THEN se.created_at END) AS lastCompleteAt,
               SUM(CASE WHEN se.event_type='approve'  THEN se.pieces ELSE 0 END) AS approvedPcs,
               SUM(CASE WHEN se.event_type='complete' THEN se.pieces ELSE 0 END) AS completedPcs,
               SUM(CASE WHEN se.event_type='reject'   THEN se.pieces ELSE 0 END) AS rejectedPcs,
               (SELECT MIN(ae.created_at) FROM jeans_assembly_events ae
                 WHERE ae.cutting_lot_id = cl.id AND ae.event_type='approve') AS asmFirstApproveAt,
               (SELECT MIN(fe.created_at) FROM finishing_events fe
                 WHERE fe.cutting_lot_id = cl.id AND fe.event_type='approve') AS finFirstApproveAt,
               -- legacy downstream presence (older lots may have no events)
               (SELECT 1 FROM jeans_assembly_data jd WHERE jd.lot_no = cl.lot_no LIMIT 1) AS asmLegacyExists,
               (SELECT 1 FROM finishing_data fd      WHERE fd.lot_no = cl.lot_no LIMIT 1) AS finLegacyExists
          FROM stitching_events se
          JOIN cutting_lots cl ON cl.id = se.cutting_lot_id
         WHERE se.operator_id = ?
         GROUP BY cl.id, cl.lot_no, cl.sku, cl.total_pieces, cl.remark
         ORDER BY firstApproveAt DESC
      `, [masterId]);

      const detailRows = [];
      const now = new Date();
      for (const r of rows) {
        const inLinePcs = Math.max(0,
          (Number(r.approvedPcs) || 0) - (Number(r.completedPcs) || 0) - (Number(r.rejectedPcs) || 0)
        );
        const nextOn = r.asmFirstApproveAt || r.finFirstApproveAt || null;
        const handedOff = !!nextOn || !!r.asmLegacyExists || !!r.finLegacyExists;

        let status = null;
        if (inLinePcs > 0) status = "In Line";
        else if ((Number(r.completedPcs) || 0) > 0 && !handedOff) status = "Awaiting Handoff";
        if (!status) continue; // already handed off

        const startMs = r.firstApproveAt ? new Date(r.firstApproveAt).getTime() : null;
        const endMs   = nextOn ? new Date(nextOn).getTime() : now.getTime();
        const tatDays = startMs ? Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24)) : 0;

        detailRows.push({
          lotNo: r.lot_no,
          sku: r.sku,
          totalPieces: r.total_pieces,
          cuttingRemark: r.cutting_remark || "",
          assignedOn: r.firstApproveAt,
          nextDeptAssignedOn: nextOn,
          tatDays,
          status
        });
      }
      return { masterUser, detailRows };
    });
    if (!data) {
      return res.status(404).send("Stitching Master not found");
    }
    const { masterUser, detailRows } = data;

    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("StitchingTAT-Detail");

      sheet.columns = [
        { header: "Stitching Master", key: "masterName",        width: 20 },
        { header: "Lot No",          key: "lotNo",             width: 15 },
        { header: "SKU",             key: "sku",               width: 15 },
        { header: "Status",          key: "status",            width: 18 },
        { header: "Total Pieces",    key: "totalPieces",       width: 15 },
        { header: "Cutting Remark",  key: "cuttingRemark",     width: 25 },
        { header: "Assigned On",     key: "assignedOn",        width: 15 },
        { header: "Next Dept On",    key: "nextDeptAssignedOn",width: 15 },
        { header: "TAT (days)",      key: "tatDays",           width: 12 }
      ];

      detailRows.forEach((row) => {
        sheet.addRow({
          masterName: masterUser.username,
          lotNo: row.lotNo,
          sku: row.sku,
          status: row.status,
          totalPieces: row.totalPieces,
          cuttingRemark: row.cuttingRemark,
          assignedOn: row.assignedOn ? formatDateDDMMYYYY(row.assignedOn) : "",
          nextDeptAssignedOn: row.nextDeptAssignedOn
            ? formatDateDDMMYYYY(row.nextDeptAssignedOn)
            : "",
          tatDays: row.tatDays
        });
      });

      res.setHeader("Content-Type", "application/vnd.openxmlformats");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="StitchingTAT-Detail-${masterUser.username}.xlsx"`
      );
      await workbook.xlsx.write(res);
      return res.end();
    }

    // 5) Otherwise render HTML with formatted dates
    const renderedRows = detailRows.map((r) => ({
      ...r,
      assignedOnStr: r.assignedOn ? formatDateDDMMYYYY(r.assignedOn) : "",
      nextDeptAssignedOnStr: r.nextDeptAssignedOn ? formatDateDDMMYYYY(r.nextDeptAssignedOn) : ""
    }));

    return res.render("operatorStitchingTatDetail", {
      masterUser,
      detailRows: renderedRows,
      currentDate: formatDateDDMMYYYY(new Date())
    });
  } catch (err) {
    console.error("Error in /stitching-tat/:masterId:", err);
    return res.status(500).send("Server error in /stitching-tat/:masterId");
  }
});

// GET /operator/sku-management
// Renders an EJS page with optional ?sku= query param
router.get("/sku-management", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { sku } = req.query; // We can still read message/error if you want from req.query

    // If no sku specified, just render the page with empty results
    if (!sku) {
      return res.render("skuManagement", {
        sku: "",
        results: [],
        message: "",
        error: ""
      });
    }

    const results = await cache.fetchCached(`sku-${sku}`, async () => {
      const tables = [
        { tableName: "cutting_lots", label: "Cutting Lots" },
        { tableName: "stitching_data", label: "Stitching Data" },
        { tableName: "jeans_assembly_data", label: "Jeans Assembly Data" },
        { tableName: "washing_data", label: "Washing Data" },
        { tableName: "washing_in_data", label: "Washing In Data" },
        { tableName: "finishing_data", label: "Finishing Data" },
        { tableName: "rewash_requests", label: "Rewash Requests" }
      ];

      const out = [];
      for (const t of tables) {
        const [rows] = await pool.query(
          `SELECT lot_no, sku FROM ${t.tableName} WHERE sku = ?`,
          [sku.trim()]
        );
        if (rows.length > 0) {
          out.push({ label: t.label, tableName: t.tableName, rows });
        }
      }
      return out;
    });

    // Render the EJS template with the found results
    return res.render("skuManagement", {
      sku,
      results,
      message: "",
      error: ""
    });
  } catch (err) {
    console.error("Error in GET /operator/sku-management:", err);
    return res.status(500).send("Server Error");
  }
});

// POST /operator/sku-management/update (AJAX endpoint)
router.post("/sku-management/update", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { oldSku, newSku } = req.body;

    // Basic validations
    if (!oldSku || !newSku) {
      return res.status(400).json({ error: "Both oldSku and newSku are required." });
    }
    if (oldSku.trim() === newSku.trim()) {
      return res.status(400).json({ error: "Old and New SKU cannot be the same." });
    }

    // List all tables that have `sku` columns
    const tablesWithSku = [
      "cutting_lots",
      "stitching_data",
      "jeans_assembly_data",
      "washing_data",
      "washing_in_data",
      "finishing_data",
      "rewash_requests"
    ];

    let totalUpdated = 0;
    for (const table of tablesWithSku) {
      const [result] = await pool.query(
        `UPDATE ${table} SET sku = ? WHERE sku = ?`,
        [newSku.trim(), oldSku.trim()]
      );
      // result.affectedRows => how many rows got updated in that table
      totalUpdated += result.affectedRows;
    }

    // Return JSON success message instead of a redirect
    return res.json({
      message: `SKU updated from "${oldSku}" to "${newSku}" (total ${totalUpdated} row(s) changed).`
    });
  } catch (err) {
    console.error("Error in POST /operator/sku-management/update:", err);
    return res.status(500).json({ error: "Server Error" });
  }
});

// ====================== Single Route: /urgent-tat ======================
// ====================== Single Route: /urgent-tat ======================
// Twilio integration removed. Urgent TAT messages are no longer sent via SMS/WhatsApp.

// Hard-coded user → phone map
const USER_PHONE_MAP = {
  6:  "+919058893850",
  35: "+918368357980",
  8:  "+919582782336"
};

// Tiny helper: chunk text if >1600 chars. Splits by lines
function chunkMessage(text, limit=1600) {
  if (text.length <= limit) return [text];
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const ln of lines) {
    if ((current + ln + "\n").length > limit) {
      chunks.push(current.trimEnd());
      current = "";
    }
    current += ln + "\n";
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

// Dummy sender since Twilio integration was removed
async function sendChunk() {
  return { ok: false, via: null, error: 'Twilio removed' };
}

/** Returns how many days since the dateValue. */

/**
 * GET  /urgent-tat   => Show a page with previews + single "Send" button
 * POST /urgent-tat   => Actually send
 */
router.route("/urgent-tat")
  .all(isAuthenticated, isOperator, async (req, res) => {
    try {
      // 1) Find all stitching_assignments older than 20 days
      //    but only for users that are in USER_PHONE_MAP
      const userIds = Object.keys(USER_PHONE_MAP).map(Number); // e.g. [6,35,8]
      if (!userIds.length) {
        // If we have no phone mappings, there's no reason to proceed
        const noMapHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Urgent TAT</title>
</head>
<body style="font-family:sans-serif; margin:40px;">
  <h2>No user phone mappings found.</h2>
</body>
</html>`;
        return res.end(noMapHtml);
      }

      // Earliest stitching-approve event per (operator, lot). A lot still
      // 'urgent' for the operator when it isn't yet completed, isn't handed
      // off downstream, and was approved more than 20 days ago.
      const [rows] = await cache.fetchCached(`urgent-ev-${userIds.join('-')}`, async () =>
        pool.query(
          `SELECT t.user_id, u.username, cl.lot_no, cl.remark, t.assigned_on
             FROM (
               SELECT se.operator_id AS user_id, se.cutting_lot_id,
                      MIN(se.created_at) AS assigned_on,
                      SUM(CASE WHEN se.event_type='approve'  THEN se.pieces ELSE 0 END) AS approvedPcs,
                      SUM(CASE WHEN se.event_type='complete' THEN se.pieces ELSE 0 END) AS completedPcs
                 FROM stitching_events se
                WHERE se.operator_id IN (?)
                GROUP BY se.operator_id, se.cutting_lot_id
             ) t
             JOIN cutting_lots cl ON cl.id = t.cutting_lot_id
             JOIN users u         ON u.id = t.user_id
            WHERE t.assigned_on IS NOT NULL
              AND DATEDIFF(NOW(), t.assigned_on) > 20
              AND t.approvedPcs > t.completedPcs
              AND NOT EXISTS (
                SELECT 1 FROM jeans_assembly_events ae
                 WHERE ae.cutting_lot_id = cl.id AND ae.event_type='approve'
              )
              AND NOT EXISTS (
                SELECT 1 FROM finishing_events fe
                 WHERE fe.cutting_lot_id = cl.id AND fe.event_type='approve'
              )
            ORDER BY t.user_id, t.assigned_on`,
          [userIds]
        )
      );

      // 2) Group them by user_id => { userId: { username, lines: [] } }
      const overdueMap = {};
      for (const r of rows) {
        const userId = r.user_id;
        if (!overdueMap[userId]) {
          overdueMap[userId] = {
            username: r.username,
            lines: []
          };
        }
        // e.g. "Lot 2594 sort no 618"
        const line = `Lot ${r.lot_no}${r.remark ? " " + r.remark.trim() : ""}`;
        overdueMap[userId].lines.push(line);
      }

      // If no results => show a "nothing to send" preview
      if (!Object.keys(overdueMap).length) {
        const emptyHtml = `
<!DOCTYPE html>
<html><head><title>Urgent TAT</title></head>
<body style="font-family:sans-serif; margin: 40px;">
  <h2>Urgent TAT (Over 20 days)</h2>
  <p>No lots are older than 20 days <strong>for mapped users</strong>. Nothing to send.</p>
</body></html>`;
        return res.end(emptyHtml);
      }

      // 3) Build a big text area preview
      let previewText = "";
      for (const [uid, val] of Object.entries(overdueMap)) {
        const header = `Master #${uid} - ${val.username}`;
        const body   = val.lines.join("\n");
        previewText += header + "\n" + body + "\n\n";
      }
      previewText = previewText.trimEnd();

      // 4) If POST => attempt to send
      let statusMessage = "";
      let errorMessage  = "";
      if (req.method === "POST") {
        const sendResults = [];
        for (const [uid, val] of Object.entries(overdueMap)) {
          const phone = USER_PHONE_MAP[uid];
          // create full text
          const fullText = val.lines.join("\n");
          const chunks   = chunkMessage(fullText);

          // send each chunk
          const outcomes = [];
          for (const c of chunks) {
            /* eslint-disable no-await-in-loop */
            const result = await sendChunk(phone, c);
            outcomes.push(result);
            if (!result.ok) break; // if 1 chunk fails, skip the rest
          }

          // analyze
          if (outcomes.every(o => o.ok)) {
            sendResults.push({
              userId: uid,
              username: val.username,
              success: `Sent ${outcomes.length} chunk(s) to ${phone} via ` +
                       outcomes.map(o => o.via).join(", ")
            });
          } else {
            const errChunk = outcomes.find(o => !o.ok);
            sendResults.push({
              userId: uid,
              username: val.username,
              error: `Failed chunk => ${errChunk?.error || "Unknown"}`
            });
          }
        }

        // build final status
        const successes = sendResults.filter(r => r.success);
        const fails     = sendResults.filter(r => r.error);

        if (successes.length) {
          statusMessage = "Successfully sent to:<br/>" + 
            successes.map(s => `• [${s.userId}] ${s.username}: ${s.success}`).join("<br/>");
        }
        if (fails.length) {
          errorMessage = "Some errors occurred:<br/>" +
            fails.map(f => `• [${f.userId}] ${f.username}: ${f.error}`).join("<br/>");
        }
      }

      // 5) Render a more professional HTML
      const htmlPage = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Urgent TAT - All Masters</title>
  <style>
    body {
      font-family: "Segoe UI", Tahoma, sans-serif;
      max-width: 800px;
      margin: 40px auto;
      background: #f9f9f9;
      padding: 20px;
      border-radius: 6px;
      color: #333;
    }
    h1, h2 {
      margin-bottom: 0.5em;
      line-height: 1.2;
    }
    .subtitle {
      color: #666;
      font-size: 0.9em;
      margin-bottom: 1em;
    }
    textarea {
      width: 100%;
      height: 220px;
      font-family: monospace;
      font-size: 14px;
      padding: 10px;
      border-radius: 4px;
      border: 1px solid #ccc;
      background: #fff;
    }
    .btn-submit {
      padding: 10px 24px;
      font-size: 15px;
      cursor: pointer;
      color: #fff;
      background: #007BFF;
      border: none;
      border-radius: 4px;
      margin-top: 8px;
    }
    .btn-submit:hover {
      background: #0056b3;
    }
    .alert {
      margin-top: 20px;
      padding: 15px;
      border-radius: 4px;
    }
    .alert.success {
      background: #d4edda;
      border: 1px solid #c3e6cb;
      color: #155724;
    }
    .alert.error {
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
    }
    .alert p {
      margin: 0;
      white-space: pre-line;
    }
  </style>
</head>
<body>
  <h1>Urgent TAT (Over 20 days)</h1>
  <div class="subtitle">Only sending to mapped Masters in USER_PHONE_MAP</div>

  <form method="POST">
    <textarea readonly>${previewText}</textarea>
    <br/>
    <button type="submit" class="btn-submit">Send TAT to All</button>
  </form>
  
  ${
    statusMessage
      ? `<div class="alert success"><p>${statusMessage}</p></div>`
      : ""
  }
  ${
    errorMessage
      ? `<div class="alert error"><p>${errorMessage}</p></div>`
      : ""
  }
</body>
</html>`;
      res.setHeader("Content-Type", "text/html");
      return res.end(htmlPage);

    } catch (err) {
      console.error("Error in /urgent-tat route:", err);
      return res.status(500).send("Server Error in /urgent-tat");
    }
  });


/**************************************************
 * SYSTEM HEALTH DASHBOARD
 **************************************************/

const SYSTEM_FEATURES = [
  { name: 'Cutting', path: '/cutting-manager/dashboard', table: 'cutting_lots', role: 'cutting_manager' },
  { name: 'Stitching', path: '/stitchingdashboard', table: 'stitching_data', role: 'stitching_master' },
  { name: 'Jeans Assembly', path: '/jeansassemblydashboard', table: 'jeans_assembly_data', role: 'jeans_assembly' },
  { name: 'Washing', path: '/washingdashboard', table: 'washing_data', role: 'washing' },
  { name: 'Washing In', path: '/washingin', table: 'washing_in_data', role: 'washing_in' },
  { name: 'Finishing', path: '/finishingdashboard', table: 'finishing_data', role: 'finishing' },
  { name: 'Fabric Manager', path: '/fabric-manager/dashboard', table: 'fabric_invoices', role: 'fabric_manager' },
  { name: 'Inventory', path: '/easyecom/stock-market', table: 'ee_inventory_snapshots', role: 'operator' },
  { name: 'Returns', path: '/returns/dashboard', table: 'returns', role: 'operator' },
  { name: 'PO Creator', path: '/po-creator/dashboard', table: 'po_lot_entries', role: 'po_creator' },
  { name: 'Challan', path: '/challandashboard', table: 'challans', role: 'operator' },
  { name: 'Employees', path: '/operator/supervisors', table: 'employees', role: 'operator' },
  { name: 'Product Links', path: '/product-links', table: 'product_links', role: 'operator' },
  { name: 'Mail Manager', path: '/mail-manager', table: 'mail_replies', role: 'operator' },
];

router.get("/system-health", isAuthenticated, isOperator, async (req, res) => {
  try {
    // Run ALL queries in parallel for speed
    const [
      dbCheck,
      userCountResult,
      roleCountResult,
      sessionCountResult,
      inventoryRawResult,
      ordersRawResult,
      ...featureResults
    ] = await Promise.all([
      pool.query('SELECT 1 as ok').catch(() => [[{ ok: 0 }]]),
      pool.query('SELECT COUNT(*) as cnt FROM users WHERE is_active = 1').catch(() => [[{ cnt: 0 }]]),
      pool.query('SELECT COUNT(*) as cnt FROM roles').catch(() => [[{ cnt: 0 }]]),
      pool.query('SELECT COUNT(DISTINCT user_id) as cnt FROM user_session_logs WHERE login_time >= DATE_SUB(NOW(), INTERVAL 24 HOUR)').catch(() => [[{ cnt: 0 }]]),
      pool.query('SELECT COUNT(*) as cnt FROM ee_inventory_snapshots WHERE raw IS NOT NULL').catch(() => [[{ cnt: 0 }]]),
      pool.query('SELECT COUNT(*) as cnt FROM ee_orders WHERE raw IS NOT NULL').catch(() => [[{ cnt: 0 }]]),
      // Feature table counts - all in parallel
      ...SYSTEM_FEATURES.map(f =>
        pool.query(`SELECT COUNT(*) as cnt FROM ${f.table}`).catch(() => [[{ cnt: 0, error: true }]])
      )
    ]);

    const dbHealthy = dbCheck[0]?.[0]?.ok === 1;
    const featureStats = SYSTEM_FEATURES.map((feature, i) => ({
      ...feature,
      rowCount: featureResults[i]?.[0]?.[0]?.cnt || 0,
      status: featureResults[i]?.[0]?.[0]?.error ? 'error' : 'ok'
    }));

    res.render('systemHealth', {
      user: req.session.user,
      dbHealthy,
      features: featureStats,
      stats: {
        activeUsers: userCountResult[0]?.[0]?.cnt || 0,
        totalRoles: roleCountResult[0]?.[0]?.cnt || 0,
        activeSessions24h: sessionCountResult[0]?.[0]?.cnt || 0,
        inventoryRawRows: inventoryRawResult[0]?.[0]?.cnt || 0,
        ordersRawRows: ordersRawResult[0]?.[0]?.cnt || 0
      },
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('System health error:', err);
    req.flash('error', 'Failed to load system health');
    res.redirect('/operator/hub');
  }
});

router.get("/system-health/api/check", isAuthenticated, isOperator, async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ database: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ database: 'error', error: err.message });
  }
});

/**************************************************
 * DOCUMENTATION PAGE
 **************************************************/

const DOCUMENTATION = {
  production: [
    { name: 'Cutting', desc: 'Create cutting lots, assign to stitching', path: '/cutting-manager/dashboard', role: 'cutting_manager' },
    { name: 'Stitching', desc: 'Track stitching, assign to assembly/washing', path: '/stitchingdashboard', role: 'stitching_master' },
    { name: 'Jeans Assembly', desc: 'Assemble jeans components', path: '/jeansassemblydashboard', role: 'jeans_assembly' },
    { name: 'Washing', desc: 'Manage washing process', path: '/washingdashboard', role: 'washing' },
    { name: 'Washing In', desc: 'Handle washed items, assign to finishing', path: '/washingin', role: 'washing_in' },
    { name: 'Finishing', desc: 'Final finishing, QC, dispatch', path: '/finishingdashboard', role: 'finishing' },
  ],
  features: [
    { name: 'System Health', desc: 'Monitor database, features, and system status', path: '/operator/system-health', role: 'operator' },
    { name: 'Usage Analytics', desc: 'Track page views by feature, daily trends, top routes. Auto-cleans data older than 7 days.', path: '/operator/usage-analytics', role: 'operator' },
    { name: 'Fabric Manager', desc: 'Manage fabric invoices and rolls', path: '/fabric-manager/dashboard', role: 'fabric_manager' },
    { name: 'Inventory', desc: 'Track inventory, out-of-stock alerts', path: '/easyecom/stock-market', role: 'operator' },
    { name: 'Returns', desc: 'Process customer returns, refunds', path: '/returns/dashboard', role: 'operator' },
    { name: 'PO Creator', desc: 'Create purchase orders', path: '/po-creator/dashboard', role: 'po_creator' },
    { name: 'Challan', desc: 'Generate and manage challans', path: '/challandashboard', role: 'any' },
    { name: 'Employees', desc: 'Manage employees, attendance, salaries', path: '/operator/supervisors', role: 'operator' },
    { name: 'Product Links', desc: 'E-commerce platform links', path: '/product-links', role: 'operator/productviewer' },
    { name: 'Mail Manager', desc: 'Zoho mail, bulk replies', path: '/mail-manager', role: 'mohitoperator' },
    { name: 'Vendor Files', desc: 'Share files with vendors', path: '/vendor-files', role: 'vendorfiles' },
    { name: 'Video Finder', desc: 'Search order videos', path: '/video-finder', role: 'any' },
    { name: 'Catalog Upload', desc: 'Upload product catalogs', path: '/catalogupload', role: 'catalogUpload' },
  ],
  integrations: [
    { name: 'EasyEcom', desc: 'Inventory and order sync via webhooks' },
    { name: 'Shopify', desc: 'Order lookup, returns processing' },
    { name: 'Zoho Mail', desc: 'Email management, bulk replies' },
    { name: 'Google Cloud Storage', desc: 'File storage for catalogs' },
  ],
  roles: [
    { name: 'admin', desc: 'Full system access' },
    { name: 'operator', desc: 'Production oversight, reports' },
    { name: 'cutting_manager', desc: 'Create cutting lots' },
    { name: 'stitching_master', desc: 'Stitching operations' },
    { name: 'jeans_assembly', desc: 'Assembly operations' },
    { name: 'washing', desc: 'Washing operations' },
    { name: 'washing_in', desc: 'Washing-in operations' },
    { name: 'finishing', desc: 'Finishing operations' },
    { name: 'fabric_manager', desc: 'Fabric inventory' },
    { name: 'supervisor', desc: 'Employee management' },
    { name: 'po_creator', desc: 'Purchase orders' },
    { name: 'productviewer', desc: 'View product links' },
  ]
};

router.get("/documentation", isAuthenticated, isOperator, async (req, res) => {
  res.render('documentation', {
    user: req.session.user,
    docs: DOCUMENTATION,
    error: req.flash('error'),
    success: req.flash('success')
  });
});

/**************************************************
 * USAGE ANALYTICS
 **************************************************/

const { getUsageStats } = require('../middlewares/usageTracker');

router.get("/usage-analytics", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await getUsageStats(startDate, endDate);

    res.render('usageAnalytics', {
      user: req.session.user,
      stats,
      startDate: startDate || '',
      endDate: endDate || '',
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Usage analytics error:', err);
    req.flash('error', 'Failed to load usage analytics');
    res.redirect('/operator/hub');
  }
});

router.get("/usage-analytics/api", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const stats = await getUsageStats(startDate, endDate);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**************************************************
 * Lot Completion Percentage Dashboard
 * Shows stage-wise completion % for each lot
 **************************************************/
router.get("/lot-completion", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchLike = `%${search}%`;

    // Get lot completion data with stage-wise pieces
    const [lots] = await pool.query(`
      SELECT
        c.id,
        c.lot_no,
        c.manual_lot_number,
        c.sku,
        c.fabric_type,
        c.total_pieces,
        c.created_at,
        COALESCE(sd.stitched_pieces, 0) AS stitched_pieces,
        COALESCE(jd.assembly_pieces, 0) AS assembly_pieces,
        COALESCE(wd.washed_pieces, 0) AS washed_pieces,
        COALESCE(fd.finished_pieces, 0) AS finished_pieces
      FROM cutting_lots c
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS stitched_pieces
        FROM stitching_data
        GROUP BY lot_no
      ) sd ON c.lot_no = sd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS assembly_pieces
        FROM jeans_assembly_data
        GROUP BY lot_no
      ) jd ON c.lot_no = jd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS washed_pieces
        FROM washing_data
        GROUP BY lot_no
      ) wd ON c.lot_no = wd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS finished_pieces
        FROM finishing_data
        GROUP BY lot_no
      ) fd ON c.lot_no = fd.lot_no
      WHERE c.lot_no LIKE ? OR c.sku LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [searchLike, searchLike, parseInt(limit), offset]);

    // Get total count for pagination
    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount FROM cutting_lots
      WHERE lot_no LIKE ? OR sku LIKE ?
    `, [searchLike, searchLike]);

    // Calculate percentages and averages
    let totalStitchPct = 0, totalAssemblyPct = 0, totalWashPct = 0, totalFinishPct = 0;
    let validLotCount = 0;

    const lotsWithPct = lots.map(lot => {
      const total = parseFloat(lot.total_pieces) || 0;
      if (total === 0) {
        return {
          ...lot,
          stitch_pct: 0,
          assembly_pct: 0,
          wash_pct: 0,
          finish_pct: 0,
          overall_pct: 0
        };
      }

      const stitchPct = Math.min(100, (lot.stitched_pieces / total) * 100);
      const assemblyPct = Math.min(100, (lot.assembly_pieces / total) * 100);
      const washPct = Math.min(100, (lot.washed_pieces / total) * 100);
      const finishPct = Math.min(100, (lot.finished_pieces / total) * 100);

      // Overall completion is based on finishing (final stage)
      const overallPct = finishPct;

      totalStitchPct += stitchPct;
      totalAssemblyPct += assemblyPct;
      totalWashPct += washPct;
      totalFinishPct += finishPct;
      validLotCount++;

      return {
        ...lot,
        stitch_pct: stitchPct.toFixed(1),
        assembly_pct: assemblyPct.toFixed(1),
        wash_pct: washPct.toFixed(1),
        finish_pct: finishPct.toFixed(1),
        overall_pct: overallPct.toFixed(1)
      };
    });

    // Calculate averages
    const avgStitchPct = validLotCount > 0 ? (totalStitchPct / validLotCount).toFixed(1) : '0.0';
    const avgAssemblyPct = validLotCount > 0 ? (totalAssemblyPct / validLotCount).toFixed(1) : '0.0';
    const avgWashPct = validLotCount > 0 ? (totalWashPct / validLotCount).toFixed(1) : '0.0';
    const avgFinishPct = validLotCount > 0 ? (totalFinishPct / validLotCount).toFixed(1) : '0.0';

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    res.render('lotCompletionDashboard', {
      user: req.session.user,
      lots: lotsWithPct,
      averages: {
        stitch: avgStitchPct,
        assembly: avgAssemblyPct,
        wash: avgWashPct,
        finish: avgFinishPct
      },
      search,
      currentPage: parseInt(page),
      totalPages,
      totalCount,
      limit: parseInt(limit)
    });
  } catch (err) {
    console.error('Error in lot-completion:', err);
    req.flash('error', 'Failed to load lot completion data');
    res.redirect('/operator/hub');
  }
});

router.get("/lot-completion/api", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search = '', page = 1, limit = 50 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const searchLike = `%${search}%`;

    const [lots] = await pool.query(`
      SELECT
        c.id,
        c.lot_no,
        c.manual_lot_number,
        c.sku,
        c.fabric_type,
        c.total_pieces,
        c.created_at,
        COALESCE(sd.stitched_pieces, 0) AS stitched_pieces,
        COALESCE(jd.assembly_pieces, 0) AS assembly_pieces,
        COALESCE(wd.washed_pieces, 0) AS washed_pieces,
        COALESCE(fd.finished_pieces, 0) AS finished_pieces
      FROM cutting_lots c
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS stitched_pieces
        FROM stitching_data
        GROUP BY lot_no
      ) sd ON c.lot_no = sd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS assembly_pieces
        FROM jeans_assembly_data
        GROUP BY lot_no
      ) jd ON c.lot_no = jd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS washed_pieces
        FROM washing_data
        GROUP BY lot_no
      ) wd ON c.lot_no = wd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS finished_pieces
        FROM finishing_data
        GROUP BY lot_no
      ) fd ON c.lot_no = fd.lot_no
      WHERE c.lot_no LIKE ? OR c.sku LIKE ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `, [searchLike, searchLike, parseInt(limit), offset]);

    const [[{ totalCount }]] = await pool.query(`
      SELECT COUNT(*) AS totalCount FROM cutting_lots
      WHERE lot_no LIKE ? OR sku LIKE ?
    `, [searchLike, searchLike]);

    let totalStitchPct = 0, totalAssemblyPct = 0, totalWashPct = 0, totalFinishPct = 0;
    let validLotCount = 0;

    const lotsWithPct = lots.map(lot => {
      const total = parseFloat(lot.total_pieces) || 0;
      if (total === 0) {
        return { ...lot, stitch_pct: 0, assembly_pct: 0, wash_pct: 0, finish_pct: 0, overall_pct: 0 };
      }

      const stitchPct = Math.min(100, (lot.stitched_pieces / total) * 100);
      const assemblyPct = Math.min(100, (lot.assembly_pieces / total) * 100);
      const washPct = Math.min(100, (lot.washed_pieces / total) * 100);
      const finishPct = Math.min(100, (lot.finished_pieces / total) * 100);

      totalStitchPct += stitchPct;
      totalAssemblyPct += assemblyPct;
      totalWashPct += washPct;
      totalFinishPct += finishPct;
      validLotCount++;

      return {
        ...lot,
        stitch_pct: stitchPct.toFixed(1),
        assembly_pct: assemblyPct.toFixed(1),
        wash_pct: washPct.toFixed(1),
        finish_pct: finishPct.toFixed(1),
        overall_pct: finishPct.toFixed(1)
      };
    });

    res.json({
      lots: lotsWithPct,
      averages: {
        stitch: validLotCount > 0 ? (totalStitchPct / validLotCount).toFixed(1) : '0.0',
        assembly: validLotCount > 0 ? (totalAssemblyPct / validLotCount).toFixed(1) : '0.0',
        wash: validLotCount > 0 ? (totalWashPct / validLotCount).toFixed(1) : '0.0',
        finish: validLotCount > 0 ? (totalFinishPct / validLotCount).toFixed(1) : '0.0'
      },
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / parseInt(limit)),
        totalCount
      }
    });
  } catch (err) {
    console.error('Error in lot-completion API:', err);
    res.status(500).json({ error: 'Failed to fetch lot completion data' });
  }
});

router.get("/lot-completion/download", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search = '' } = req.query;
    const searchLike = `%${search}%`;

    const [lots] = await pool.query(`
      SELECT
        c.lot_no,
        c.manual_lot_number,
        c.sku,
        c.fabric_type,
        c.total_pieces,
        DATE_FORMAT(c.created_at, '%Y-%m-%d') AS created_date,
        COALESCE(sd.stitched_pieces, 0) AS stitched_pieces,
        COALESCE(jd.assembly_pieces, 0) AS assembly_pieces,
        COALESCE(wd.washed_pieces, 0) AS washed_pieces,
        COALESCE(fd.finished_pieces, 0) AS finished_pieces
      FROM cutting_lots c
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS stitched_pieces
        FROM stitching_data GROUP BY lot_no
      ) sd ON c.lot_no = sd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS assembly_pieces
        FROM jeans_assembly_data GROUP BY lot_no
      ) jd ON c.lot_no = jd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS washed_pieces
        FROM washing_data GROUP BY lot_no
      ) wd ON c.lot_no = wd.lot_no
      LEFT JOIN (
        SELECT lot_no, SUM(total_pieces) AS finished_pieces
        FROM finishing_data GROUP BY lot_no
      ) fd ON c.lot_no = fd.lot_no
      WHERE c.lot_no LIKE ? OR c.sku LIKE ?
      ORDER BY c.created_at DESC
    `, [searchLike, searchLike]);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Lot Completion');

    sheet.columns = [
      { header: 'Lot No', key: 'lot_no', width: 15 },
      { header: 'Manual Lot No', key: 'manual_lot_number', width: 15 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Fabric', key: 'fabric_type', width: 12 },
      { header: 'Total Pieces', key: 'total_pieces', width: 12 },
      { header: 'Stitched', key: 'stitched_pieces', width: 12 },
      { header: 'Stitch %', key: 'stitch_pct', width: 10 },
      { header: 'Assembly', key: 'assembly_pieces', width: 12 },
      { header: 'Assembly %', key: 'assembly_pct', width: 10 },
      { header: 'Washed', key: 'washed_pieces', width: 12 },
      { header: 'Wash %', key: 'wash_pct', width: 10 },
      { header: 'Finished', key: 'finished_pieces', width: 12 },
      { header: 'Finish %', key: 'finish_pct', width: 10 },
      { header: 'Created', key: 'created_date', width: 12 }
    ];

    lots.forEach(lot => {
      const total = parseFloat(lot.total_pieces) || 1;
      sheet.addRow({
        ...lot,
        stitch_pct: ((lot.stitched_pieces / total) * 100).toFixed(1) + '%',
        assembly_pct: ((lot.assembly_pieces / total) * 100).toFixed(1) + '%',
        wash_pct: ((lot.washed_pieces / total) * 100).toFixed(1) + '%',
        finish_pct: ((lot.finished_pieces / total) * 100).toFixed(1) + '%'
      });
    });

    res.setHeader('Content-Disposition', 'attachment; filename="lot_completion_report.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading lot completion:', err);
    req.flash('error', 'Failed to download report');
    res.redirect('/operator/lot-completion');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SKU CATEGORIES MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

// GET /operator/sku-categories - Render management page
router.get('/sku-categories', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [categories] = await pool.query(`
      SELECT sc.*, u.username AS created_by_name
      FROM sku_categories sc
      LEFT JOIN users u ON sc.created_by = u.id
      ORDER BY sc.name
    `);
    res.render('operator-sku-categories', {
      user: req.session.user,
      categories
    });
  } catch (error) {
    console.error('Error loading SKU categories:', error);
    req.flash('error', 'Failed to load categories');
    res.redirect('/operator/hub');
  }
});

// GET /operator/api/sku-categories - JSON list
router.get('/api/sku-categories', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT id, name FROM sku_categories ORDER BY name');
    return res.json({ success: true, categories });
  } catch (error) {
    console.error('Error loading SKU categories:', error);
    return res.status(500).json({ error: 'Failed to load categories' });
  }
});

// POST /operator/api/sku-categories - Add category
router.post('/api/sku-categories', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    const catName = name.trim().toUpperCase();
    await pool.query('INSERT INTO sku_categories (name) VALUES (?)', [catName]);
    return res.json({ success: true, message: 'Category added' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Category already exists' });
    }
    console.error('Error adding SKU category:', error);
    return res.status(500).json({ error: 'Failed to add category' });
  }
});

// DELETE /operator/api/sku-categories/:id - Delete category
router.delete('/api/sku-categories/:id', isAuthenticated, isOperator, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM sku_categories WHERE id = ?', [id]);
    return res.json({ success: true, message: 'Category deleted' });
  } catch (error) {
    console.error('Error deleting SKU category:', error);
    return res.status(500).json({ error: 'Failed to delete category' });
  }
});

/**
 * GET /operator/api/lot-sizes?lot_no=<lotNo>
 * Shared endpoint used by the "expand-on-click" pattern in every dashboard
 * that lists lots. Returns per-size pieces for every stage of the lot,
 * sourced from the *_event_sizes tables (truth source) plus
 * finishing_dispatches for dispatched qty.
 */
router.get('/api/lot-sizes', isAuthenticated, async (req, res) => {
  try {
    const lotNoRaw = (req.query.lot_no || '').trim();
    if (!lotNoRaw) {
      return res.status(400).json({ error: 'lot_no query param required' });
    }
    // Look up cutting_lot by lot_no (case-insensitive — DB collation usually
    // handles this, but trim and pass as-is).
    const [lotRows] = await pool.query(
      `SELECT id, lot_no, sku FROM cutting_lots WHERE lot_no = ? LIMIT 1`,
      [lotNoRaw]
    );
    if (!lotRows.length) {
      return res.json({ lot_no: lotNoRaw, sku: null, totalCut: 0, sizes: [] });
    }
    const lot = lotRows[0];

    // Per-size cut baseline from cutting_lot_sizes.
    const [cutRows] = await pool.query(
      `SELECT size_label, COALESCE(total_pieces,0) AS pieces
         FROM cutting_lot_sizes
        WHERE cutting_lot_id = ?`,
      [lot.id]
    );

    // Per-size event sums (stitched / assembled / washed / washing_in / finished).
    const sizeEventSums = await fetchLotSizeEventSums([lot.lot_no]);

    // Per-size dispatched from finishing_dispatches.
    const [dispRows] = await pool.query(
      `SELECT size_label, COALESCE(SUM(quantity),0) AS dispatched
         FROM finishing_dispatches
        WHERE lot_no = ?
        GROUP BY size_label`,
      [lot.lot_no]
    );
    const dispMap = {};
    for (const r of dispRows) dispMap[r.size_label] = parseFloat(r.dispatched) || 0;

    // Build the union of size labels found anywhere (cut / events / dispatch).
    const labelSet = new Set();
    cutRows.forEach(r => labelSet.add(r.size_label));
    Object.keys(sizeEventSums).forEach(k => {
      const [ln, sz] = k.split('|');
      if (ln === lot.lot_no) labelSet.add(sz);
    });
    Object.keys(dispMap).forEach(sz => labelSet.add(sz));

    const cutMap = {};
    cutRows.forEach(r => { cutMap[r.size_label] = parseFloat(r.pieces) || 0; });

    // Numeric-aware sort: pure numbers first (ascending), then strings A→Z.
    const labels = Array.from(labelSet).sort((a, b) => {
      const na = parseFloat(a);
      const nb = parseFloat(b);
      const aNum = !isNaN(na) && /^\d+(\.\d+)?$/.test(String(a).trim());
      const bNum = !isNaN(nb) && /^\d+(\.\d+)?$/.test(String(b).trim());
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return String(a).localeCompare(String(b));
    });

    const sizes = labels.map(sz => {
      const ev = sizeEventSums[`${lot.lot_no}|${sz}`] || {};
      return {
        size_label: sz,
        cut:        cutMap[sz] || 0,
        stitched:   ev.stitchedQty   || 0,
        assembled:  ev.assembledQty  || 0,
        washed:     ev.washedQty     || 0,
        washing_in: ev.washingInQty  || 0,
        finished:   ev.finishedQty   || 0,
        dispatched: dispMap[sz]      || 0,
      };
    });

    const totalCut = sizes.reduce((s, r) => s + (r.cut || 0), 0);

    return res.json({
      lot_no: lot.lot_no,
      sku: lot.sku,
      totalCut,
      sizes,
    });
  } catch (err) {
    console.error('GET /operator/api/lot-sizes error:', err);
    return res.status(500).json({ error: 'Failed to fetch lot sizes' });
  }
});

/**************************************************
 * Day Activity — which master did what on a given day,
 * across cutting → finishing. Day boundary is IST
 * (pool sets session tz +05:30; process.env.TZ=Asia/Kolkata).
 **************************************************/
router.get('/day-activity', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [[row]] = await pool.query("SELECT CURDATE() AS today, NOW() AS server_now");
    const today = formatYMD(row.today);
    return res.render('operatorDayActivity', { today, serverNow: row.server_now });
  } catch (err) {
    console.error('GET /operator/day-activity error:', err);
    return res.status(500).send('Failed to load Day Activity');
  }
});

function formatYMD(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

router.get('/day-activity/data', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [[srv]] = await pool.query("SELECT CURDATE() AS today, NOW() AS server_now");
    const todayStr = formatYMD(srv.today);
    const dayParam = (req.query.day || '').trim();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : todayStr;
    if (day > todayStr) {
      return res.status(400).json({ error: 'Cannot query future dates', today: todayStr });
    }

    // 1) Cutting — lots created per cutting master
    const [cuttingCreated] = await pool.query(
      `SELECT cl.user_id AS master_id,
              u.username AS master,
              cl.flow_type AS dept,
              COUNT(*) AS lots,
              COALESCE(SUM(cl.total_pieces),0) AS pieces
         FROM cutting_lots cl
    LEFT JOIN users u ON u.id = cl.user_id
        WHERE DATE(cl.created_at) = ?
     GROUP BY cl.user_id, cl.flow_type
     ORDER BY lots DESC, pieces DESC`,
      [day]
    );

    // 1b) Cutting — lots assigned out to stitching master
    const [cuttingAssigned] = await pool.query(
      `SELECT cu.id   AS cutting_master_id,
              cu.username AS cutting_master,
              su.id   AS stitching_master_id,
              su.username AS stitching_master,
              cl.flow_type AS dept,
              COUNT(*) AS lots
         FROM stitching_assignments sa
         JOIN cutting_lots cl ON cl.id = sa.cutting_lot_id
    LEFT JOIN users cu ON cu.id = cl.user_id
    LEFT JOIN users su ON su.id = sa.user_id
        WHERE DATE(sa.assigned_on) = ?
     GROUP BY cu.id, su.id, cl.flow_type
     ORDER BY lots DESC`,
      [day]
    );

    // 2..6) Stage approvals — same shape across event tables
    const stageTables = [
      { key: 'stitching',       table: 'stitching_events' },
      { key: 'jeans_assembly',  table: 'jeans_assembly_events' },
      { key: 'washing',         table: 'washing_events' },
      { key: 'washing_in',      table: 'washing_in_events' },
      { key: 'finishing',       table: 'finishing_events' },
    ];

    const stages = {};
    for (const { key, table } of stageTables) {
      const [rows] = await pool.query(
        `SELECT e.operator_id      AS master_id,
                u.username         AS master,
                cl.flow_type       AS dept,
                COUNT(DISTINCT e.cutting_lot_id) AS lots,
                COALESCE(SUM(e.pieces),0)        AS pieces
           FROM \`${table}\` e
           JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
      LEFT JOIN users u ON u.id = e.operator_id
          WHERE e.event_type = 'approve'
            AND DATE(e.created_at) = ?
       GROUP BY e.operator_id, cl.flow_type
       ORDER BY lots DESC, pieces DESC`,
        [day]
      );
      stages[key] = rows;
    }

    // Department roll-up per stage
    const rollup = {};
    const allBuckets = {
      cutting_created: cuttingCreated,
      ...stages,
    };
    for (const [k, rows] of Object.entries(allBuckets)) {
      const agg = { denim: { lots: 0, pieces: 0 }, hosiery: { lots: 0, pieces: 0 } };
      for (const r of rows) {
        const d = (r.dept === 'denim' || r.dept === 'hosiery') ? r.dept : null;
        if (!d) continue;
        agg[d].lots   += Number(r.lots)   || 0;
        agg[d].pieces += Number(r.pieces) || 0;
      }
      rollup[k] = agg;
    }

    return res.json({
      day,
      today: todayStr,
      isToday: day === todayStr,
      serverNow: srv.server_now,
      cuttingCreated,
      cuttingAssigned,
      stages,
      rollup,
    });
  } catch (err) {
    console.error('GET /operator/day-activity/data error:', err);
    return res.status(500).json({ error: 'Failed to load day activity' });
  }
});

/**
 * GET /operator/rewash-download
 * ALL rewash requests — operator has system-wide visibility.
 */
router.get('/rewash-download', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { exportRewashExcel } = require('../utils/rewashExport');
    await exportRewashExcel(res); // no scope → all
  } catch (err) {
    console.error('GET /operator/rewash-download error:', err);
    return res.status(500).send('Failed to export rewash list');
  }
});

module.exports = router;
