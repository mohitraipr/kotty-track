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
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const ExcelJS = require("exceljs");
const { PRIVILEGED_OPERATOR_ID } = require("../utils/operators");

// simple in-memory cache to avoid heavy repetitive queries
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX_ITEMS = 50; // avoid unbounded growth
const _cache = new Map();

function getCache(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.val;
}

function setCache(key, val) {
  const now = Date.now();
  // purge expired keys
  for (const [k, v] of _cache) {
    if (now - v.ts > CACHE_TTL_MS) _cache.delete(k);
  }
  // enforce max cache size (simple LRU-style)
  if (_cache.size >= CACHE_MAX_ITEMS) {
    const oldestKey = _cache.keys().next().value;
    _cache.delete(oldestKey);
  }
  _cache.set(key, { ts: now, val });
}

async function fetchCached(key, fn) {
  const cached = getCache(key);
  if (cached) return cached;
  const result = await fn();
  setCache(key, result);
  return result;
}

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
  return fetchCached('operatorPerformance', async () => {
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
  return fetchCached(cacheKey, async () => {
    const analytics = {};

    const totalsQ = pool.query(`
    SELECT
      (SELECT COALESCE(SUM(total_pieces),0) FROM cutting_lots)     AS totalCut,
      (SELECT COALESCE(SUM(total_pieces),0) FROM stitching_data)   AS totalStitched,
      (SELECT COALESCE(SUM(total_pieces),0) FROM washing_data)     AS totalWashed,
      (SELECT COALESCE(SUM(total_pieces),0) FROM finishing_data)   AS totalFinished,
      (SELECT COUNT(*) FROM cutting_lots)                          AS totalCount,
      (
        SELECT COUNT(*)
          FROM cutting_lots c
          LEFT JOIN (
            SELECT lot_no, COALESCE(SUM(total_pieces),0) AS sumFinish
              FROM finishing_data
             GROUP BY lot_no
          ) fd ON c.lot_no = fd.lot_no
         WHERE fd.sumFinish < c.total_pieces
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

    const turnaroundQ = pool.query(`
      SELECT c.lot_no, c.created_at AS cut_date, MAX(f.created_at) AS finish_date,
             c.total_pieces, COALESCE(SUM(f.total_pieces),0) as sumFin
        FROM cutting_lots c
        LEFT JOIN finishing_data f ON c.lot_no = f.lot_no
       GROUP BY c.lot_no
       HAVING sumFin >= c.total_pieces
    `);
    const stitchRateQ = pool.query(`
      SELECT COUNT(*) AS totalAssigned,
             SUM(CASE WHEN isApproved=1 THEN 1 ELSE 0 END) AS approvedCount
        FROM stitching_assignments
    `);
    const washRateQ = pool.query(`
      SELECT COUNT(*) AS totalAssigned,
             SUM(CASE WHEN is_approved=1 THEN 1 ELSE 0 END) AS approvedCount
        FROM washing_assignments
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

    const [rows] = await pool.query(
      `SELECT
         u.id AS washer_id,
         u.username,
         COALESCE(ap.approvedLots, 0) AS approvedLots,
         COALESCE(wc.completedLots, 0) AS completedLots
       FROM users u
       LEFT JOIN (
         SELECT wa.user_id, COUNT(DISTINCT jd.lot_no) AS approvedLots
           FROM washing_assignments wa
           LEFT JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
          WHERE wa.is_approved = 1
            AND DATE(wa.approved_on) BETWEEN ? AND ?
          GROUP BY wa.user_id
       ) ap ON ap.user_id = u.id
       LEFT JOIN (
         SELECT wd.user_id, COUNT(DISTINCT wd.lot_no) AS completedLots
           FROM washing_data wd
          WHERE DATE(wd.created_at) BETWEEN ? AND ?
          GROUP BY wd.user_id
       ) wc ON wc.user_id = u.id
      WHERE ap.user_id IS NOT NULL OR wc.user_id IS NOT NULL
      ORDER BY u.username ASC`,
      [startDate, endDate, startDate, endDate]
    );

    return res.json({ data: rows });
  } catch (err) {
    console.error("Error in /dashboard/washer-activity:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**************************************************
 * 3) /operator/dashboard – must define lotCount etc.
 **************************************************/
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
  const { search, startDate, endDate,
      sortField="lot_no", sortOrder="asc", category="all", view } = req.query;

    // 1) operatorPerformance
    const operatorPerformance = await computeOperatorPerformance();

    const [[totals]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM cutting_lots)                                  AS lotCount,
        (SELECT COALESCE(SUM(total_pieces),0) FROM cutting_lots)             AS totalPieces,
        (SELECT COALESCE(SUM(total_pieces),0) FROM stitching_data)           AS totalStitched,
        (SELECT COALESCE(SUM(total_pieces),0) FROM washing_data)             AS totalWashed,
        (SELECT COALESCE(SUM(total_pieces),0) FROM finishing_data)           AS totalFinished,
        (SELECT COUNT(*) FROM users)                                        AS userCount
    `);

    const lotCount = totals.lotCount;
    const totalPiecesCut = parseFloat(totals.totalPieces) || 0;

    // 6) advanced analytics
    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);


    // 7) render
    return res.render("operatorDashboard", {
      lotCount,
      totalPiecesCut,
      totalStitched: totals.totalStitched,
      totalWashed: totals.totalWashed,
      totalFinished: totals.totalFinished,
      userCount: totals.userCount,
      advancedAnalytics,
      operatorPerformance,
      query: { search, startDate, endDate, sortField, sortOrder, category },
      lotDetails: {}
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});


async function fetchPendencyRows(dept, searchLike, offset, limit) {
  const cacheKey = `pend-${dept}-${searchLike}-${offset}-${limit}`;
  return fetchCached(cacheKey, async () => {
    let query = "";
    const params = [searchLike, offset, limit];
    if (dept === "assembly") {
      query = `
        SELECT ja.id AS assignment_id, sd.lot_no, u.username,
               ja.assigned_pieces AS assigned,
               COALESCE(jds.completed,0) AS completed,
               ja.assigned_pieces - COALESCE(jds.completed,0) AS pending
          FROM jeans_assembly_assignments ja
          JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
          JOIN users u ON ja.user_id = u.id
          LEFT JOIN (
            SELECT assignment_id, SUM(total_pieces) AS completed
              FROM jeans_assembly_data
             GROUP BY assignment_id
          ) jds ON jds.assignment_id = ja.id
         WHERE sd.lot_no LIKE ?

         ORDER BY ja.assigned_on DESC
         LIMIT ?, ?`;
      } else if (dept === "washing") {
    query = `
      SELECT wa.id AS assignment_id, jd.lot_no, u.username,
             wa.assigned_pieces AS assigned,
             COALESCE(wds.completed,0) AS completed,
             wa.assigned_pieces - COALESCE(wds.completed,0) AS pending
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        JOIN users u ON wa.user_id = u.id
        LEFT JOIN (
          SELECT washing_assignment_id, SUM(total_pieces) AS completed
            FROM washing_data
           GROUP BY washing_assignment_id
        ) wds ON wds.washing_assignment_id = wa.id
       WHERE jd.lot_no LIKE ?

       ORDER BY wa.assigned_on DESC
       LIMIT ?, ?`;
  } else {
    query = `
      SELECT sa.id AS assignment_id, c.lot_no, u.username,
             c.total_pieces AS assigned,
             COALESCE(sds.completed,0) AS completed,
             c.total_pieces - COALESCE(sds.completed,0) AS pending
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        JOIN users u ON sa.user_id = u.id
        LEFT JOIN (
          SELECT user_id, lot_no, SUM(total_pieces) AS completed
            FROM stitching_data
           GROUP BY user_id, lot_no
        ) sds ON sds.user_id = sa.user_id AND sds.lot_no = c.lot_no
       WHERE c.lot_no LIKE ?

       ORDER BY sa.assigned_on DESC
       LIMIT ?, ?`;
    }

    const [rows] = await pool.query(query, params);
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
    const data = await fetchCached(`lot-${lotNo}`, async () => {
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
    const rows = await fetchCached("lotDeptCounts", async () => {
      const [data] = await pool.query(`
        SELECT cl.lot_no,
               cl.sku,
               cl.total_pieces AS pieces,
               counts.cutting,
               counts.stitching,
               counts.washing,
               counts.washing_in,
               counts.finishing,
               counts.assembly
        FROM (
          SELECT lot_no,
                 SUM(stage='cutting')    AS cutting,
                 SUM(stage='stitching')  AS stitching,
                 SUM(stage='washing')    AS washing,
                 SUM(stage='washing_in') AS washing_in,
                 SUM(stage='finishing')  AS finishing,
                 SUM(stage='assembly')   AS assembly
          FROM (
            SELECT lot_no, 'cutting'    AS stage FROM cutting_lots
            UNION ALL
            SELECT lot_no, 'stitching'  AS stage FROM stitching_data
            UNION ALL
            SELECT lot_no, 'washing'    AS stage FROM washing_data
            UNION ALL
            SELECT lot_no, 'washing_in' AS stage FROM washing_in_data
            UNION ALL
            SELECT lot_no, 'finishing'  AS stage FROM finishing_data
            UNION ALL
            SELECT lot_no, 'assembly'   AS stage FROM jeans_assembly_data
          ) AS t1
          GROUP BY lot_no
        ) AS counts
        JOIN cutting_lots cl ON counts.lot_no = cl.lot_no
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

async function buildWasherMonthlySummary(prefix) {
  const [assignRows] = await pool.query(
    `SELECT wa.user_id, u.username,
            DATE_FORMAT(wa.assigned_on,'%Y-%m') AS month,
            wa.sizes_json, jd.lot_no,
            cl.total_pieces AS cutting_pieces,
            cl.remark
       FROM washing_assignments wa
       JOIN users u ON wa.user_id = u.id
       JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       LEFT JOIN cutting_lots cl ON jd.lot_no = cl.lot_no
      WHERE jd.lot_no LIKE ?`,
    [prefix]
  );
  const [compRows] = await pool.query(
    `SELECT user_id,
            DATE_FORMAT(created_at,'%Y-%m') AS month,
            SUM(total_pieces) AS completed
       FROM washing_data
      WHERE lot_no LIKE ?
      GROUP BY user_id, month`,
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
    let pcs = 0;
    try {
      const arr = JSON.parse(r.sizes_json || '[]');
      if (Array.isArray(arr)) for (const s of arr) pcs += parseInt(s.pieces, 10) || 0;
    } catch { pcs = 0; }
    const entry = ensure(r.user_id, r.month, r.username);
    entry.assigned += pcs;
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
// Quick helper: isDenimLot
function isDenimLot(lotNo="") {
  const up= lotNo.toUpperCase();
  return (up.startsWith("AK") || up.startsWith("UM"));
}

// Aggregates and last-assignment data for multiple lots in one go
async function fetchLotAggregates(lotNos = []) {
  if (!lotNos.length) {
    return {
      lotSumsMap: {},
      stitchMap: {},
      asmMap: {},
      washMap: {},
      winMap: {},
      finMap: {}
    };
  }

  const cacheKey = `lotAgg-${lotNos.slice().sort().join(',')}`;
  return fetchCached(cacheKey, async () => {
    const sumsQ = pool.query(`
      SELECT 'stitched' AS sumType, lot_no, COALESCE(SUM(total_pieces),0) AS sumVal
        FROM stitching_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'assembled' AS sumType, lot_no, COALESCE(SUM(total_pieces),0) AS sumVal
        FROM jeans_assembly_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'washed' AS sumType, lot_no, COALESCE(SUM(total_pieces),0) AS sumVal
        FROM washing_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'washing_in' AS sumType, lot_no, COALESCE(SUM(total_pieces),0) AS sumVal
        FROM washing_in_data
       WHERE lot_no IN (?)
       GROUP BY lot_no

      UNION ALL

      SELECT 'finished' AS sumType, lot_no, COALESCE(SUM(total_pieces),0) AS sumVal
        FROM finishing_data
       WHERE lot_no IN (?)
       GROUP BY lot_no
    `, [lotNos, lotNos, lotNos, lotNos, lotNos]);

    const stQ = pool.query(`
      SELECT c.lot_no, sa.id, sa.isApproved AS is_approved,
             sa.assigned_on, sa.approved_on, sa.user_id,
             u.username AS opName
        FROM stitching_assignments sa
        JOIN cutting_lots c ON sa.cutting_lot_id = c.id
        LEFT JOIN users u ON sa.user_id = u.id
        LEFT JOIN stitching_assignments sa2
               ON sa2.cutting_lot_id = sa.cutting_lot_id
              AND sa2.assigned_on > sa.assigned_on
       WHERE sa2.id IS NULL
         AND c.lot_no IN (?)
    `, [lotNos]);

    const asmQ = pool.query(`
      SELECT sd.lot_no, ja.id, ja.is_approved,
             ja.assigned_on, ja.approved_on, ja.user_id,
             u.username AS opName
        FROM jeans_assembly_assignments ja
        JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
        LEFT JOIN users u ON ja.user_id = u.id
        LEFT JOIN jeans_assembly_assignments ja2
               ON ja2.stitching_assignment_id = ja.stitching_assignment_id
              AND ja2.assigned_on > ja.assigned_on
       WHERE ja2.id IS NULL
         AND sd.lot_no IN (?)
    `, [lotNos]);

    const washQ = pool.query(`
      SELECT jd.lot_no, wa.id, wa.is_approved,
             wa.assigned_on, wa.approved_on, wa.user_id,
             u.username AS opName
        FROM washing_assignments wa
        JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        LEFT JOIN users u ON wa.user_id = u.id
        LEFT JOIN washing_assignments wa2
               ON wa2.jeans_assembly_assignment_id = wa.jeans_assembly_assignment_id
              AND wa2.assigned_on > wa.assigned_on
       WHERE wa2.id IS NULL
         AND jd.lot_no IN (?)
    `, [lotNos]);

    const winQ = pool.query(`
      SELECT wd.lot_no, wia.id, wia.is_approved,
             wia.assigned_on, wia.approved_on, wia.user_id,
             u.username AS opName
        FROM washing_in_assignments wia
        JOIN washing_data wd ON wia.washing_data_id = wd.id
        LEFT JOIN users u ON wia.user_id = u.id
        LEFT JOIN washing_in_assignments wia2
               ON wia2.washing_data_id = wia.washing_data_id
              AND wia2.assigned_on > wia.assigned_on
       WHERE wia2.id IS NULL
         AND wd.lot_no IN (?)
    `, [lotNos]);

    const finQ = pool.query(`
      SELECT
        CASE
          WHEN fa.washing_in_data_id IS NOT NULL THEN wid.lot_no
          WHEN fa.stitching_assignment_id IS NOT NULL THEN sd.lot_no
        END AS lot_no,
        fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id,
        u.username AS opName
      FROM finishing_assignments fa
      LEFT JOIN washing_in_data wid ON fa.washing_in_data_id = wid.id
      LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
      LEFT JOIN users u         ON fa.user_id = u.id
      LEFT JOIN finishing_assignments fa2
             ON (
                  fa.washing_in_data_id IS NOT NULL
                  AND fa.washing_in_data_id = fa2.washing_in_data_id
                  AND fa2.assigned_on > fa.assigned_on
                )
                OR (
                  fa.stitching_assignment_id IS NOT NULL
                  AND fa.stitching_assignment_id = fa2.stitching_assignment_id
                  AND fa2.assigned_on > fa.assigned_on
                )
      WHERE fa2.id IS NULL
        AND (
             (wid.lot_no IN (?) AND wid.lot_no IS NOT NULL)
             OR
             (sd.lot_no IN (?) AND sd.lot_no IS NOT NULL)
            )
    `, [lotNos, lotNos]);

    const [
      [sumRows],
      [stRows],
      [asmRows],
      [washRows],
      [winRows],
      [finRows]
    ] = await Promise.all([sumsQ, stQ, asmQ, washQ, winQ, finQ]);

    const lotSumsMap = {};
    lotNos.forEach(ln => {
      lotSumsMap[ln] = { stitchedQty:0, assembledQty:0, washedQty:0, washingInQty:0, finishedQty:0 };
    });
    for (const row of sumRows) {
      const m = lotSumsMap[row.lot_no];
      if (!m) continue;
      switch (row.sumType) {
        case 'stitched':   m.stitchedQty   = parseFloat(row.sumVal) || 0; break;
        case 'assembled':  m.assembledQty  = parseFloat(row.sumVal) || 0; break;
        case 'washed':     m.washedQty     = parseFloat(row.sumVal) || 0; break;
        case 'washing_in': m.washingInQty  = parseFloat(row.sumVal) || 0; break;
        case 'finished':   m.finishedQty   = parseFloat(row.sumVal) || 0; break;
      }
    }

    const stitchMap = {};
    stRows.forEach(r => { stitchMap[r.lot_no] = r; });
    const asmMap = {};
    asmRows.forEach(r => { asmMap[r.lot_no] = r; });
    const washMap = {};
    washRows.forEach(r => { washMap[r.lot_no] = r; });
    const winMap = {};
    winRows.forEach(r => { winMap[r.lot_no] = r; });
    const finMap = {};
    finRows.forEach(r => { if (r.lot_no) finMap[r.lot_no] = r; });

    return { lotSumsMap, stitchMap, asmMap, washMap, winMap, finMap };
  });
}

/**
 * The chain logic you want:
 * DENIM: Cut → Stitching → Assembly → Washing → WashingIn → Finishing
 * NON-DENIM: Cut → Stitching → Finishing
 * 
 * If a step is not assigned or partial, we say all subsequent steps = "In <that step>".
 */
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washedQty,
  washingInQty,
  finishedQty,
  stAssign,     // stitching_assignments
  asmAssign,    // jeans_assembly_assignments
  washAssign,   // washing_assignments
  washInAssign, // washing_in_assignments
  finAssign     // finishing_assignments
}) {
  // placeholders
  let stitchingStatus="N/A", stitchingOp="", stitchingAssignedOn="N/A", stitchingApprovedOn="N/A";
  let assemblyStatus= isDenim? "N/A" : "—", assemblyOp="", assemblyAssignedOn="N/A", assemblyApprovedOn="N/A";
  let washingStatus= isDenim? "N/A" : "—", washingOp="", washingAssignedOn="N/A", washingApprovedOn="N/A";
  // for non-denim, we skip washing & assembly & washing_in entirely
  let washingInStatus= isDenim? "N/A": "—", washingInOp="", washingInAssignedOn="N/A", washingInApprovedOn="N/A";
  let finishingStatus="N/A", finishingOp="", finishingAssignedOn="N/A", finishingApprovedOn="N/A";

  // STITCHING
  if (!stAssign) {
    stitchingStatus= "In Cutting";
    // everything after stitching is "In Cutting"
    if (isDenim) {
      assemblyStatus= "In Cutting";
      washingStatus= "In Cutting";
      washingInStatus= "In Cutting";
      finishingStatus= "In Cutting";
    } else {
      finishingStatus= "In Cutting";
    }
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
      washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
      washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
      finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
    };
  } else {
    // we have a stitching assignment
    const { isApproved, assigned_on, approved_on, opName } = stAssign;
    stitchingOp= opName|| "";
    stitchingAssignedOn = assigned_on
      ? new Date(assigned_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";
    stitchingApprovedOn = approved_on
      ? new Date(approved_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";

    if (isApproved=== null) {
      stitchingStatus= `Pending Approval by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else if (isApproved==0) {
      stitchingStatus= `Denied by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        finishingStatus= "In Stitching";
      }
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else {
      // approved => partial or complete
      if (stitchedQty===0) {
        stitchingStatus= "In-Line";
      } else if (stitchedQty>= totalCut && totalCut>0) {
        stitchingStatus= "Completed";
      } else {
        const pend= totalCut- stitchedQty;
        stitchingStatus= `${pend} Pending`;
      }
    }
  }

  // for non-denim, the next step is finishing
  // for denim: next step is assembly
  if (!isDenim) {
    // NON-DENIM => skip assembly, washing, washingIn
    // finishing next
    // if there's no finishing assignment, or partial finishing => we do that logic below
    // keep going...
  } else {
    // DENIM => assembly next
    if (!asmAssign) {
      assemblyStatus= "In Stitching";
      washingStatus= "In Stitching";
      washingInStatus= "In Stitching";
      finishingStatus= "In Stitching";
      return {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      };
    } else {
      // we have assembly
      const { is_approved, assigned_on, approved_on, opName }= asmAssign;
      assemblyOp= opName|| "";
      assemblyAssignedOn = assigned_on
        ? new Date(assigned_on)
            .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
            .replace(/\//g, '-')
        : "N/A";
      assemblyApprovedOn = approved_on
        ? new Date(approved_on)
            .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
            .replace(/\//g, '-')
        : "N/A";

      if (is_approved=== null) {
        assemblyStatus= `Pending Approval by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else if (is_approved==0) {
        assemblyStatus= `Denied by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else {
        // partial or complete
        if (assembledQty===0) {
          assemblyStatus= "In-Line";
        } else if (assembledQty>= stitchedQty && stitchedQty>0) {
          assemblyStatus= "Completed";
        } else {
          const pend= stitchedQty- assembledQty;
          assemblyStatus= `${pend} Pending`;
        }
      }

      // next => washing
      if (!washAssign) {
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
        return {
          stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
          assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
          washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
          washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
          finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
        };
      } else {
        const { is_approved, assigned_on, approved_on, opName }= washAssign;
        washingOp= opName|| "";
        washingAssignedOn = assigned_on
          ? new Date(assigned_on)
              .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "N/A";
        washingApprovedOn = approved_on
          ? new Date(approved_on)
              .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "N/A";

        if (is_approved=== null) {
          washingStatus= `Pending Approval by ${washingOp}`;
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else if (is_approved==0) {
          washingStatus= `Denied by ${washingOp}`;
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else {
          // partial or complete
          if (washedQty===0) {
            washingStatus= "In-Line";
          } else if (washedQty>= assembledQty && assembledQty>0) {
            washingStatus= "Completed";
          } else {
            const pend= assembledQty- washedQty;
            washingStatus= `${pend} Pending`;
          }
        }

        // next => washingIn
        if (!washInAssign) {
          washingInStatus= "In Washing";
          finishingStatus= "In Washing";
          return {
            stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
            assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
            washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
            washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
            finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
          };
        } else {
          const { is_approved, assigned_on, approved_on, opName }= washInAssign;
          washingInOp= opName|| "";
          washingInAssignedOn = assigned_on
            ? new Date(assigned_on)
                .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
                .replace(/\//g, '-')
            : "N/A";
          washingInApprovedOn = approved_on
            ? new Date(approved_on)
                .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
                .replace(/\//g, '-')
            : "N/A";

          if (is_approved===null) {
            washingInStatus= `Pending Approval by ${washingInOp}`;
            finishingStatus= "In WashingIn";
            return {
              stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
              assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
              washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
              washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
              finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
            };
          } else if (is_approved==0) {
            washingInStatus= `Denied by ${washingInOp}`;
            finishingStatus= "In WashingIn";
            return {
              stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
              assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
              washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
              washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
              finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
            };
          } else {
            // partial or complete
            if (washingInQty===0) {
              washingInStatus= "In-Line";
            } else if (washingInQty>= washedQty && washedQty>0) {
              washingInStatus= "Completed";
            } else {
              const pend= washedQty- washingInQty;
              washingInStatus= `${pend} Pending`;
            }
          }
        }
      }
    }
  }

  // for non-denim, we skip assembly/washing/washingIn entirely
  // next => finishing
  if (!finAssign) {
    if (isDenim) {
      finishingStatus= "In WashingIn";   // if no finishing assignment
    } else {
      finishingStatus= "In Stitching";   // for non-denim
    }
    return {
      stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
      assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
      washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
      washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
      finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
    };
  } else {
    const { is_approved, assigned_on, approved_on, opName }= finAssign;
    finishingOp= opName|| "";
    finishingAssignedOn = assigned_on
      ? new Date(assigned_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";
    finishingApprovedOn = approved_on
      ? new Date(approved_on)
          .toLocaleString('en-GB', { timeZone: 'Asia/Kolkata' })
          .replace(/\//g, '-')
      : "N/A";

    if (is_approved===null) {
      finishingStatus= `Pending Approval by ${finishingOp}`;
    } else if (is_approved==0) {
      finishingStatus= `Denied by ${finishingOp}`;
    } else {
      // partial or complete
      // for denim => finishing leftover vs washingIn
      // for non-denim => finishing leftover vs stitched
      if (isDenim) {
        if (finishedQty===0) {
          finishingStatus= "In-Line";
        } else if (finishedQty>= washingInQty && washingInQty>0) {
          finishingStatus= "Completed";
        } else {
          const pend= washingInQty- finishedQty;
          finishingStatus= `${pend} Pending`;
        }
      } else {
        // non-denim => finishing leftover vs. stitched
        if (finishedQty===0) {
          finishingStatus= "In-Line";
        } else if (finishedQty>= stitchedQty && stitchedQty>0) {
          finishingStatus= "Completed";
        } else {
          const pend= stitchedQty- finishedQty;
          finishingStatus= `${pend} Pending`;
        }
      }
    }
  }

  return {
    stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
    assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
    washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
    washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
    finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
  };
}

/** filterByDept */
function filterByDept({
  department, isDenim,
  stitchingStatus,
  assemblyStatus,
  washingStatus,
  washingInStatus,
  finishingStatus
}) {
  let showRow= true;
  let actualStatus= "N/A";

  if (department==="all") {
    if (isDenim) {
      // finishing if not N/A, else washingIn, else washing, else assembly, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus= washingInStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus= washingStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus= assemblyStatus;
      else actualStatus= stitchingStatus;
    } else {
      // non-denim => finishing, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else actualStatus= stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department==="cutting") {
    // always show "Completed"
    actualStatus= "Completed";
    return { showRow, actualStatus };
  }

  if (department==="stitching") {
    actualStatus= stitchingStatus;
    return { showRow, actualStatus };
  }

  if (department==="assembly") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= assemblyStatus;
    return { showRow, actualStatus };
  }

  if (department==="washing") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= washingStatus;
    return { showRow, actualStatus };
  }

  if (department==="washing_in") {
    if (!isDenim) return { showRow: false, actualStatus: "N/A" };
    actualStatus= washingInStatus;
    return { showRow, actualStatus };
  }

  if (department==="finishing") {
    actualStatus= finishingStatus;
    return { showRow, actualStatus };
  }

  return { showRow, actualStatus };
}

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

    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        if (department === "stitching") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM stitching_assignments sa
                JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(sa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "assembly") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM jeans_assembly_assignments ja
                JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON sd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(ja.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_assignments wa
                JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
                JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing_in") {
          // <-- Updated to join washing_data instead of washing_in_data
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_in_assignments wia
                JOIN washing_data wd
                  ON wia.washing_data_id = wd.id
                JOIN cutting_lots c2
                  ON wd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wia.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "finishing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM finishing_assignments fa
                LEFT JOIN washing_in_data wid ON fa.washing_in_data_id = wid.id
                LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON (wid.lot_no = c2.lot_no OR sd.lot_no = c2.lot_no)
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(fa.assigned_on) BETWEEN ? AND ?
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
          UPPER(cl.lot_no) LIKE 'AK%'
          OR UPPER(cl.lot_no) LIKE 'UM%'
        )
      `;
    } else if (lotType === "hosiery") {
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) NOT LIKE 'AK%'
          AND UPPER(cl.lot_no) NOT LIKE 'UM%'
        )
      `;
    }

    // 2) Fetch all lots (ONE QUERY)
    const baseQuery = `
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.created_at, cl.remark,
             u.username AS created_by
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
    const { lotSumsMap, stitchMap, asmMap, washMap, winMap, finMap } = await fetchLotAggregates(lotNos);

    // --- Rewash Pending Quantities ---
    const [rewashRows] = await pool.query(
      `SELECT lot_no, SUM(total_requested) AS pendingQty
         FROM rewash_requests
        WHERE status = 'pending'
          AND lot_no IN (?)
        GROUP BY lot_no`,
      [lotNos]
    );
    const rewashMap = {};
    for (const row of rewashRows) {
      rewashMap[row.lot_no] = parseFloat(row.pendingQty) || 0;
    }

    // 5) Now build finalData from these maps
    const finalData = [];
    for (const lot of lots) {
      const lotNo = lot.lot_no;
      const totalCut = parseFloat(lot.total_pieces) || 0;
      const denim = isDenimLot(lotNo);

      // Sums
      const sums = lotSumsMap[lotNo] || {};
      const stitchedQty  = sums.stitchedQty   || 0;
      const assembledQty = sums.assembledQty  || 0;
      const washedQty    = sums.washedQty     || 0;
      const washingInQty = sums.washingInQty  || 0;
      const finishedQty  = sums.finishedQty   || 0;
      const rewashQty    = rewashMap[lotNo]   || 0;

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
        finAssign
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

      finalData.push({
        lotNo,
        sku: lot.sku,
        lotType: denim ? "Denim" : "Hosiery",
        totalCut,
        createdAt: lot.created_at
          ? new Date(lot.created_at)
              .toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "",
        remark: lot.remark || "",

        // Stitching
        stitchAssignedOn:   statuses.stitchingAssignedOn,
        stitchApprovedOn:   statuses.stitchingApprovedOn,
        stitchOp:           statuses.stitchingOp,
        stitchStatus:       statuses.stitchingStatus,
        stitchedQty,

        // Assembly
        assemblyAssignedOn: statuses.assemblyAssignedOn,
        assemblyApprovedOn: statuses.assemblyApprovedOn,
        assemblyOp:         statuses.assemblyOp,
        assemblyStatus:     statuses.assemblyStatus,
        assembledQty,

        // Washing
        washingAssignedOn:  statuses.washingAssignedOn,
        washingApprovedOn:  statuses.washingApprovedOn,
        washingOp:          statuses.washingOp,
        washingStatus:      statuses.washingStatus,
        washedQty,

        // WashingIn
        washingInAssignedOn: statuses.washingInAssignedOn,
        washingInApprovedOn: statuses.washingInApprovedOn,
        washingInOp:         statuses.washingInOp,
        washingInStatus:     statuses.washingInStatus,
        washingInQty,
        rewashPendingQty: rewashQty,

        // Finishing
        finishingAssignedOn: statuses.finishingAssignedOn,
        finishingApprovedOn: statuses.finishingApprovedOn,
        finishingOp:         statuses.finishingOp,
        finishingStatus:     statuses.finishingStatus,
        finishedQty
      });
    }

    // 6) If download => Excel
    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Report – Denim Chain with WashingIn";

      const sheet = workbook.addWorksheet("PIC-Report");
      sheet.columns = [
        { header: "Lot No",               key: "lotNo",                width: 15 },
        { header: "SKU",                  key: "sku",                  width: 12 },
        { header: "Lot Type",             key: "lotType",              width: 10 },
        { header: "Total Cut",            key: "totalCut",             width: 10 },
        { header: "Created At",           key: "createdAt",            width: 15 },
        { header: "Remark",               key: "remark",               width: 20 },

        // Stitching
        { header: "Stitch Assigned On",   key: "stitchAssignedOn",     width: 20 },
        { header: "Stitch Approved On",   key: "stitchApprovedOn",     width: 20 },
        { header: "Stitch Operator",      key: "stitchOp",             width: 15 },
        { header: "Stitch Status",        key: "stitchStatus",         width: 25 },
        { header: "Stitched Qty",         key: "stitchedQty",          width: 15 },

        // Assembly
        { header: "Assembly Assigned On", key: "assemblyAssignedOn",   width: 20 },
        { header: "Assembly Approved On", key: "assemblyApprovedOn",   width: 20 },
        { header: "Assembly Operator",    key: "assemblyOp",           width: 15 },
        { header: "Assembly Status",      key: "assemblyStatus",       width: 25 },
        { header: "Assembled Qty",        key: "assembledQty",         width: 15 },

        // Washing
        { header: "Washing Assigned On",  key: "washingAssignedOn",    width: 20 },
        { header: "Washing Approved On",  key: "washingApprovedOn",    width: 20 },
        { header: "Washing Operator",     key: "washingOp",            width: 15 },
        { header: "Washing Status",       key: "washingStatus",        width: 25 },
        { header: "Washed Qty",           key: "washedQty",            width: 15 },

        // Washing‑In
        { header: "WashIn Assigned On",   key: "washingInAssignedOn",  width: 20 },
        { header: "WashIn Approved On",   key: "washingInApprovedOn",  width: 20 },
        { header: "WashIn Operator",      key: "washingInOp",          width: 15 },
        { header: "WashIn Status",        key: "washingInStatus",      width: 25 },
        { header: "WashIn Qty",           key: "washingInQty",         width: 15 },
        { header: "Rewash Pending",       key: "rewashPendingQty",     width: 15 },

        // Finishing
        { header: "Finishing Assigned On",key: "finishingAssignedOn",  width: 20 },
        { header: "Finishing Approved On",key: "finishingApprovedOn",  width: 20 },
        { header: "Finishing Operator",   key: "finishingOp",          width: 15 },
        { header: "Finishing Status",     key: "finishingStatus",      width: 25 },
        { header: "Finished Qty",         key: "finishedQty",          width: 15 }
      ];

      finalData.forEach(r => {
        sheet.addRow({
          lotNo:               r.lotNo,
          sku:                 r.sku,
          lotType:             r.lotType,
          totalCut:            r.totalCut,
          createdAt:           r.createdAt,
          remark:              r.remark,

          // Stitching
          stitchAssignedOn:    r.stitchAssignedOn,
          stitchApprovedOn:    r.stitchApprovedOn,
          stitchOp:            r.stitchOp,
          stitchStatus:        r.stitchStatus,
          stitchedQty:         r.stitchedQty,

          // Assembly
          assemblyAssignedOn:  r.assemblyAssignedOn,
          assemblyApprovedOn:  r.assemblyApprovedOn,
          assemblyOp:          r.assemblyOp,
          assemblyStatus:      r.assemblyStatus,
          assembledQty:        r.assembledQty,

          // Washing
          washingAssignedOn:   r.washingAssignedOn,
          washingApprovedOn:   r.washingApprovedOn,
          washingOp:           r.washingOp,
          washingStatus:       r.washingStatus,
          washedQty:           r.washedQty,

          // WashingIn
          washingInAssignedOn: r.washingInAssignedOn,
          washingInApprovedOn: r.washingInApprovedOn,
          washingInOp:         r.washingInOp,
          washingInStatus:     r.washingInStatus,
          washingInQty:        r.washingInQty,
          rewashPendingQty:    r.rewashPendingQty,

          // Finishing
          finishingAssignedOn: r.finishingAssignedOn,
          finishingApprovedOn: r.finishingApprovedOn,
          finishingOp:         r.finishingOp,
          finishingStatus:     r.finishingStatus,
          finishedQty:         r.finishedQty
        });
      });

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="PICReport-FixedChain.xlsx"'
      );
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // 7) Render HTML
      return res.render("operatorPICReport", {
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
      startDate = "",
      endDate = "",
      download = ""
    } = req.query;

    // 1) Build filters for main lots query (same logic as pic-report)
    let dateWhere = "";
    let dateParams = [];

    if (startDate && endDate) {
      if (dateFilter === "createdAt") {
        dateWhere = " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter === "assignedOn") {
        if (department === "stitching") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM stitching_assignments sa
                JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(sa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "assembly") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM jeans_assembly_assignments ja
                JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON sd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(ja.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_assignments wa
                JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
                JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "washing_in") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM washing_in_assignments wia
                JOIN washing_data wd ON wia.washing_data_id = wd.id
                JOIN cutting_lots c2 ON wd.lot_no = c2.lot_no
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(wia.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department === "finishing") {
          dateWhere = `
            AND EXISTS (
              SELECT 1
                FROM finishing_assignments fa
                LEFT JOIN washing_in_data wid ON fa.washing_in_data_id = wid.id
                LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON (wid.lot_no = c2.lot_no OR sd.lot_no = c2.lot_no)
               WHERE c2.lot_no = cl.lot_no
                 AND DATE(fa.assigned_on) BETWEEN ? AND ?
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
          UPPER(cl.lot_no) LIKE 'AK%'
          OR UPPER(cl.lot_no) LIKE 'UM%'
        )
      `;
    } else if (lotType === "hosiery") {
      lotTypeClause = `
        AND (
          UPPER(cl.lot_no) NOT LIKE 'AK%'
          AND UPPER(cl.lot_no) NOT LIKE 'UM%'
        )
      `;
    }

    // 2) Fetch all lot/size rows
    const baseQuery = `
      SELECT cl.lot_no, cl.sku, cls.size_label, cls.total_pieces, cl.created_at, cl.remark,
             u.username AS created_by
        FROM cutting_lots cl
        JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
        JOIN users u ON cl.user_id = u.id
       WHERE 1=1
         ${lotTypeClause}
         ${dateWhere}
       ORDER BY cl.created_at DESC
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

    // 3) Get sums grouped by lot_no and size_label
    const [sumRows] = await pool.query(`
      SELECT 'stitched' AS sumType, sd.lot_no, sds.size_label, COALESCE(SUM(sds.pieces),0) AS sumVal
        FROM stitching_data_sizes sds
        JOIN stitching_data sd ON sds.stitching_data_id = sd.id
       WHERE sd.lot_no IN (?)
       GROUP BY sd.lot_no, sds.size_label

      UNION ALL

      SELECT 'assembled' AS sumType, jd.lot_no, jds.size_label, COALESCE(SUM(jds.pieces),0) AS sumVal
        FROM jeans_assembly_data_sizes jds
        JOIN jeans_assembly_data jd ON jds.jeans_assembly_data_id = jd.id
       WHERE jd.lot_no IN (?)
       GROUP BY jd.lot_no, jds.size_label

      UNION ALL

      SELECT 'washed' AS sumType, wd.lot_no, wds.size_label, COALESCE(SUM(wds.pieces),0) AS sumVal
        FROM washing_data_sizes wds
        JOIN washing_data wd ON wds.washing_data_id = wd.id
       WHERE wd.lot_no IN (?)
       GROUP BY wd.lot_no, wds.size_label

      UNION ALL

      SELECT 'washing_in' AS sumType, wid.lot_no, wids.size_label, COALESCE(SUM(wids.pieces),0) AS sumVal
        FROM washing_in_data_sizes wids
        JOIN washing_in_data wid ON wids.washing_in_data_id = wid.id
       WHERE wid.lot_no IN (?)
       GROUP BY wid.lot_no, wids.size_label

      UNION ALL

      SELECT 'finished' AS sumType, fd.lot_no, fds.size_label, COALESCE(SUM(fds.pieces),0) AS sumVal
        FROM finishing_data_sizes fds
        JOIN finishing_data fd ON fds.finishing_data_id = fd.id
       WHERE fd.lot_no IN (?)
       GROUP BY fd.lot_no, fds.size_label
    `, [lotNos, lotNos, lotNos, lotNos, lotNos]);

    const sizeSumsMap = {};
    for (const r of rows) {
      const key = `${r.lot_no}|${r.size_label}`;
      sizeSumsMap[key] = { stitchedQty:0, assembledQty:0, washedQty:0, washingInQty:0, finishedQty:0 };
    }
    for (const row of sumRows) {
      const key = `${row.lot_no}|${row.size_label}`;
      if (!sizeSumsMap[key]) continue;
      switch (row.sumType) {
        case 'stitched':   sizeSumsMap[key].stitchedQty   = parseFloat(row.sumVal) || 0; break;
        case 'assembled':  sizeSumsMap[key].assembledQty  = parseFloat(row.sumVal) || 0; break;
        case 'washed':     sizeSumsMap[key].washedQty     = parseFloat(row.sumVal) || 0; break;
        case 'washing_in': sizeSumsMap[key].washingInQty  = parseFloat(row.sumVal) || 0; break;
        case 'finished':   sizeSumsMap[key].finishedQty   = parseFloat(row.sumVal) || 0; break;
      }
    }

    // 4) Last assignments per lot (same as pic-report)
    const { stitchMap, asmMap, washMap, winMap, finMap } = await fetchLotAggregates(lotNos);

    // 5) Build final data
    const finalData = [];
    for (const row of rows) {
      const lotNo = row.lot_no;
      const sizeLabel = row.size_label;
      const totalCut = parseFloat(row.total_pieces) || 0;
      const denim = isDenimLot(lotNo);

      const sums = sizeSumsMap[`${lotNo}|${sizeLabel}`] || {};
      const stitchedQty  = sums.stitchedQty  || 0;
      const assembledQty = sums.assembledQty || 0;
      const washedQty    = sums.washedQty    || 0;
      const washingInQty = sums.washingInQty || 0;
      const finishedQty  = sums.finishedQty  || 0;

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
        finAssign
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

      finalData.push({
        lotNo,
        sku_size: `${row.sku}_${sizeLabel}`,
        sku: row.sku,
        size: sizeLabel,
        lotType: denim ? "Denim" : "Hosiery",
        totalCut,
        createdAt: row.created_at
          ? new Date(row.created_at)
              .toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' })
              .replace(/\//g, '-')
          : "",
        remark: row.remark || "",

        stitchAssignedOn:   statuses.stitchingAssignedOn,
        stitchApprovedOn:   statuses.stitchingApprovedOn,
        stitchOp:           statuses.stitchingOp,
        stitchStatus:       statuses.stitchingStatus,
        stitchedQty,

        assemblyAssignedOn: statuses.assemblyAssignedOn,
        assemblyApprovedOn: statuses.assemblyApprovedOn,
        assemblyOp:         statuses.assemblyOp,
        assemblyStatus:     statuses.assemblyStatus,
        assembledQty,

        washingAssignedOn:  statuses.washingAssignedOn,
        washingApprovedOn:  statuses.washingApprovedOn,
        washingOp:          statuses.washingOp,
        washingStatus:      statuses.washingStatus,
        washedQty,

        washingInAssignedOn: statuses.washingInAssignedOn,
        washingInApprovedOn: statuses.washingInApprovedOn,
        washingInOp:         statuses.washingInOp,
        washingInStatus:     statuses.washingInStatus,
        washingInQty,

        finishingAssignedOn: statuses.finishingAssignedOn,
        finishingApprovedOn: statuses.finishingApprovedOn,
        finishingOp:         statuses.finishingOp,
        finishingStatus:     statuses.finishingStatus,
        finishedQty
      });
    }

    if (download === "1") {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "PIC Report by Size";

      const sheet = workbook.addWorksheet("PIC-Size-Report");
      sheet.columns = [
        { header: "Lot No", key: "lotNo", width: 15 },
        { header: "SKU_Size", key: "sku_size", width: 20 },
        { header: "SKU", key: "sku", width: 12 },
        { header: "Size", key: "size", width: 10 },
        { header: "Lot Type", key: "lotType", width: 10 },
        { header: "Total Cut", key: "totalCut", width: 10 },
        { header: "Created At", key: "createdAt", width: 15 },
        { header: "Remark", key: "remark", width: 20 },

        { header: "Stitch Assigned On", key: "stitchAssignedOn", width: 20 },
        { header: "Stitch Approved On", key: "stitchApprovedOn", width: 20 },
        { header: "Stitch Operator", key: "stitchOp", width: 15 },
        { header: "Stitch Status", key: "stitchStatus", width: 25 },
        { header: "Stitched Qty", key: "stitchedQty", width: 15 },

        { header: "Assembly Assigned On", key: "assemblyAssignedOn", width: 20 },
        { header: "Assembly Approved On", key: "assemblyApprovedOn", width: 20 },
        { header: "Assembly Operator", key: "assemblyOp", width: 15 },
        { header: "Assembly Status", key: "assemblyStatus", width: 25 },
        { header: "Assembled Qty", key: "assembledQty", width: 15 },

        { header: "Washing Assigned On", key: "washingAssignedOn", width: 20 },
        { header: "Washing Approved On", key: "washingApprovedOn", width: 20 },
        { header: "Washing Operator", key: "washingOp", width: 15 },
        { header: "Washing Status", key: "washingStatus", width: 25 },
        { header: "Washed Qty", key: "washedQty", width: 15 },

        { header: "WashIn Assigned On", key: "washingInAssignedOn", width: 20 },
        { header: "WashIn Approved On", key: "washingInApprovedOn", width: 20 },
        { header: "WashIn Operator", key: "washingInOp", width: 15 },
        { header: "WashIn Status", key: "washingInStatus", width: 25 },
        { header: "WashIn Qty", key: "washingInQty", width: 15 },

        { header: "Finishing Assigned On", key: "finishingAssignedOn", width: 20 },
        { header: "Finishing Approved On", key: "finishingApprovedOn", width: 20 },
        { header: "Finishing Operator", key: "finishingOp", width: 15 },
        { header: "Finishing Status", key: "finishingStatus", width: 25 },
        { header: "Finished Qty", key: "finishedQty", width: 15 }
      ];

      finalData.forEach(r => {
        sheet.addRow({
          lotNo: r.lotNo,
          sku_size: r.sku_size,
          sku: r.sku,
          size: r.size,
          lotType: r.lotType,
          totalCut: r.totalCut,
          createdAt: r.createdAt,
          remark: r.remark,

          stitchAssignedOn: r.stitchAssignedOn,
          stitchApprovedOn: r.stitchApprovedOn,
          stitchOp: r.stitchOp,
          stitchStatus: r.stitchStatus,
          stitchedQty: r.stitchedQty,

          assemblyAssignedOn: r.assemblyAssignedOn,
          assemblyApprovedOn: r.assemblyApprovedOn,
          assemblyOp: r.assemblyOp,
          assemblyStatus: r.assemblyStatus,
          assembledQty: r.assembledQty,

          washingAssignedOn: r.washingAssignedOn,
          washingApprovedOn: r.washingApprovedOn,
          washingOp: r.washingOp,
          washingStatus: r.washingStatus,
          washedQty: r.washedQty,

          washingInAssignedOn: r.washingInAssignedOn,
          washingInApprovedOn: r.washingInApprovedOn,
          washingInOp: r.washingInOp,
          washingInStatus: r.washingInStatus,
          washingInQty: r.washingInQty,

          finishingAssignedOn: r.finishingAssignedOn,
          finishingApprovedOn: r.finishingApprovedOn,
          finishingOp: r.finishingOp,
          finishingStatus: r.finishingStatus,
          finishedQty: r.finishedQty
        });
      });

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
    const masterCards = await fetchCached(`tat-summary-${download}`, async () => {
      // 1) Identify all users (Stitching Masters) who have either
      //    pending or in-line lots
      const [masters] = await pool.query(`
        SELECT DISTINCT u.id, u.username
          FROM users u
          JOIN stitching_assignments sa ON sa.user_id = u.id
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE (
                sa.isApproved IS NULL
                OR
                (
                  sa.isApproved = 1
                  AND (
                    (
                      (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                      AND NOT EXISTS (
                        SELECT 1
                          FROM jeans_assembly_assignments ja
                          JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                         WHERE sd.lot_no = cl.lot_no
                           AND ja.is_approved IS NOT NULL
                      )
                    )
                    OR
                    (
                      (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                      AND NOT EXISTS (
                        SELECT 1
                          FROM finishing_assignments fa
                          JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                         WHERE sd.lot_no = cl.lot_no
                           AND fa.is_approved IS NOT NULL
                      )
                    )
                  )
                )
              )
      `);

      const [summary] = await pool.query(`
        SELECT sa.user_id,
               u.username,
               SUM(CASE WHEN sa.isApproved IS NULL THEN cl.total_pieces ELSE 0 END) AS pendingApproval,
               SUM(CASE WHEN sa.isApproved = 1 AND (
                     ((UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%') AND NOT EXISTS (
                          SELECT 1 FROM jeans_assembly_assignments ja
                           JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                          WHERE sd.lot_no = cl.lot_no AND ja.is_approved IS NOT NULL
                     ))
                     OR
                     ((UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%') AND NOT EXISTS (
                          SELECT 1 FROM finishing_assignments fa
                           JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                          WHERE sd.lot_no = cl.lot_no AND fa.is_approved IS NOT NULL
                     ))
                 ) THEN cl.total_pieces ELSE 0 END) AS inLinePieces
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
          JOIN users u ON sa.user_id = u.id
         GROUP BY sa.user_id, u.username
         HAVING pendingApproval > 0 OR inLinePieces > 0
      `);

      const cards = summary.map(r => ({
        masterId: r.user_id,
        username: r.username,
        pendingApproval: parseFloat(r.pendingApproval) || 0,
        inLinePieces: parseFloat(r.inLinePieces) || 0
      }));

      return cards;
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
    const data = await fetchCached(`tat-detail-${masterId}`, async () => {
      const [[masterUser]] = await pool.query(
        `SELECT id, username FROM users WHERE id = ?`,
        [masterId]
      );
      if (!masterUser) return null;

      const [assignments] = await pool.query(`
        SELECT sa.id AS stitching_assignment_id,
               sa.isApproved AS stitchIsApproved,
               sa.assigned_on AS stitchAssignedOn,
               cl.lot_no,
               cl.sku,
               cl.total_pieces,
               cl.remark AS cutting_remark,
               asm.next_on AS asm_next_on,
               fin.next_on AS fin_next_on
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
          LEFT JOIN (
                SELECT sd.lot_no, MIN(ja.assigned_on) AS next_on
                  FROM jeans_assembly_assignments ja
                  JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                 WHERE ja.is_approved IS NOT NULL
                 GROUP BY sd.lot_no
          ) asm ON asm.lot_no = cl.lot_no
          LEFT JOIN (
                SELECT sd.lot_no, MIN(fa.assigned_on) AS next_on
                  FROM finishing_assignments fa
                  JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                 WHERE fa.is_approved IS NOT NULL
                 GROUP BY sd.lot_no
          ) fin ON fin.lot_no = cl.lot_no
         WHERE sa.user_id = ?
           AND (
                sa.isApproved IS NULL
                OR (
                     sa.isApproved = 1
                     AND (
                       ( (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                         AND asm.next_on IS NULL )
                       OR
                       ( (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                         AND fin.next_on IS NULL )
                     )
                   )
              )
         ORDER BY sa.assigned_on DESC
      `, [masterId]);

      const detailRows = [];
      const currentDate = new Date();
      for (const a of assignments) {
        const {
          lot_no,
          sku,
          total_pieces,
          cutting_remark,
          stitchAssignedOn,
          stitchIsApproved,
          asm_next_on,
          fin_next_on
        } = a;

        let nextAssignedOn = null;
        const isDenim = isDenimLot(lot_no);
        if (stitchIsApproved === 1) {
          nextAssignedOn = isDenim ? asm_next_on : fin_next_on;
        }

        let tatDays = 0;
        if (stitchAssignedOn) {
          const startMs = new Date(stitchAssignedOn).getTime();
          const endMs = nextAssignedOn
            ? new Date(nextAssignedOn).getTime()
            : currentDate.getTime();
          tatDays = Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24));
        }

        detailRows.push({
          lotNo: lot_no,
          sku,
          totalPieces: total_pieces,
          cuttingRemark: cutting_remark || "",
          assignedOn: stitchAssignedOn,
          nextDeptAssignedOn: nextAssignedOn,
          tatDays,
          status: stitchIsApproved === null ? "Pending Approval" : "In Line"
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

    const results = await fetchCached(`sku-${sku}`, async () => {
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
function daysSince(dateValue) {
  if (!dateValue) return 0;
  const msDiff = Date.now() - new Date(dateValue).getTime();
  return Math.floor(msDiff / (1000 * 60 * 60 * 24));
}

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

      const [rows] = await fetchCached(`urgent-${userIds.join('-')}`, async () =>
        pool.query(
          `SELECT sa.user_id, u.username,
                  cl.lot_no, cl.remark,
                  sa.assigned_on
             FROM stitching_assignments sa
             JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
             JOIN users u         ON sa.user_id = u.id
            WHERE sa.assigned_on IS NOT NULL
              AND DATEDIFF(NOW(), sa.assigned_on) > 20
              AND sa.user_id IN (?)
            ORDER BY sa.user_id, sa.assigned_on`,
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


module.exports = router;
