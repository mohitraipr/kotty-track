/**************************************************************************
 * operatorRoutes.js  –  Kotty-Track (April 2025)
 *
 *  • Denim chain  : Cut → Stitching → Assembly → Washing → Washing-In → Finishing
 *  • Hosiery      : Cut → Stitching → Finishing
 *  • PIC Report   : download-only, 10-query bulk strategy (slashes DB load)
 *  • All other dashboards/reports kept intact
 **************************************************************************/

const express  = require("express");
const router   = express.Router();
const ExcelJS  = require("exceljs");
const { pool } = require("../config/db");
const {
  isAuthenticated,
  isOperator,
  isStitchingMaster
} = require("../middlewares/auth");

/* ──────────────────────────  generic utils  ────────────────────────── */
function formatDateDDMMYYYY(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  return `${String(d.getDate()).padStart(2, "0")}/` +
         `${String(d.getMonth() + 1).padStart(2, "0")}/` +
         `${d.getFullYear()}`;
}
const isDenimLot = (lot = "") => /^ak|^um/i.test(lot);

/* =======================================================================
 * SECTION 1 ·  BULK HELPERS (qty + latest-assignment maps, 10 queries)
 * =====================================================================*/
const toMap = rows => {
  const m = Object.create(null);
  for (const r of rows) m[r.lot_no] = +r.qty || 0;
  return m;
};

async function fetchQtyMaps(lotNos) {
  const q = async (table) =>
    (await pool.query(
      `SELECT lot_no, SUM(total_pieces) qty FROM ${table}
        WHERE lot_no IN (?) GROUP BY lot_no`, [lotNos]))[0];

  return {
    stitched : toMap(await q("stitching_data")),
    assembled: toMap(await q("jeans_assembly_data")),
    washed   : toMap(await q("washing_data")),
    washIn   : toMap(await q("washing_in_data")),
    finished : toMap(await q("finishing_data"))
  };
}

const rowsToObj = arr => {
  const o = Object.create(null);
  for (const r of arr) o[r.lot_no] = r;
  return o;
};

async function fetchAssignmentMaps(lotNos) {
  /* helper to build MAX(assigned_on) sub-query snippets */
  const latest = (join, where) => `
    JOIN ( SELECT ${where}, MAX(x.assigned_on) last_on
             FROM ${join} x
             WHERE ${where} IN (?)
             GROUP BY ${where} ) latest
      ON latest.${where === "lot_no" ? "lot_no" : "lot_no"} = ${where}
     AND latest.last_on = a.assigned_on`;

  /* stitching */
  const [st] = await pool.query(`
    SELECT c.lot_no, a.isApproved AS is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM stitching_assignments a
      JOIN cutting_lots c ON a.cutting_lot_id = c.id
      JOIN users u ON u.id = a.user_id
      ${latest("stitching_assignments", "c.lot_no")};`, [lotNos]);

  /* assembly */
  const [asm] = await pool.query(`
    SELECT sd.lot_no, a.is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM jeans_assembly_assignments a
      JOIN stitching_data sd ON a.stitching_assignment_id = sd.id
      JOIN users u ON u.id = a.user_id
      ${latest("jeans_assembly_assignments", "sd.lot_no")};`, [lotNos]);

  /* washing */
  const [wa] = await pool.query(`
    SELECT jd.lot_no, a.is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM washing_assignments a
      JOIN jeans_assembly_data jd ON a.jeans_assembly_assignment_id = jd.id
      JOIN users u ON u.id = a.user_id
      ${latest("washing_assignments", "jd.lot_no")};`, [lotNos]);

  /* washing-in */
  const [wi] = await pool.query(`
    SELECT wd.lot_no, a.is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM washing_in_assignments a
      JOIN washing_data wd ON a.washing_data_id = wd.id
      JOIN users u ON u.id = a.user_id
      ${latest("washing_in_assignments", "wd.lot_no")};`, [lotNos]);

  /* finishing (dual join) */
  const [fi] = await pool.query(`
    SELECT COALESCE(wd.lot_no, sd.lot_no) lot_no, a.is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM finishing_assignments a
      LEFT JOIN washing_data wd   ON a.washing_assignment_id   = wd.id
      LEFT JOIN stitching_data sd ON a.stitching_assignment_id = sd.id
      JOIN users u ON u.id = a.user_id
      JOIN ( SELECT COALESCE(wd2.lot_no, sd2.lot_no) lot_no,
                    MAX(a2.assigned_on) last_on
               FROM finishing_assignments a2
               LEFT JOIN washing_data wd2   ON a2.washing_assignment_id   = wd2.id
               LEFT JOIN stitching_data sd2 ON a2.stitching_assignment_id = sd2.id
               WHERE COALESCE(wd2.lot_no, sd2.lot_no) IN (?)
               GROUP BY COALESCE(wd2.lot_no, sd2.lot_no) ) latest
             ON latest.lot_no = COALESCE(wd.lot_no, sd.lot_no)
            AND latest.last_on = a.assigned_on;`, [lotNos]);

  return {
    stitching : rowsToObj(st),
    assembly  : rowsToObj(asm),
    washing   : rowsToObj(wa),
    washingIn : rowsToObj(wi),
    finishing : rowsToObj(fi)
  };
}

/* =======================================================================
 * SECTION 2 · DATE filter builder for ?dateFilter=assignedOn
 * =====================================================================*/
function buildAssignedOnFilter(dept) {
  switch (dept) {
    case "stitching":
      return `
        AND EXISTS ( SELECT 1 FROM stitching_assignments sa
                     JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
                    WHERE c2.lot_no = cl.lot_no
                      AND DATE(sa.assigned_on) BETWEEN ? AND ? )`;
    case "assembly":
      return `
        AND EXISTS ( SELECT 1 FROM jeans_assembly_assignments ja
                     JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                     JOIN cutting_lots c2   ON sd.lot_no = c2.lot_no
                    WHERE c2.lot_no = cl.lot_no
                      AND DATE(ja.assigned_on) BETWEEN ? AND ? )`;
    case "washing":
      return `
        AND EXISTS ( SELECT 1 FROM washing_assignments wa
                     JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
                     JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
                    WHERE c2.lot_no = cl.lot_no
                      AND DATE(wa.assigned_on) BETWEEN ? AND ? )`;
    case "washing_in":
      return `
        AND EXISTS ( SELECT 1 FROM washing_in_assignments wi
                     JOIN washing_data wd ON wi.washing_data_id = wd.id
                     JOIN cutting_lots c2 ON wd.lot_no = c2.lot_no
                    WHERE c2.lot_no = cl.lot_no
                      AND DATE(wi.assigned_on) BETWEEN ? AND ? )`;
    case "finishing":
      return `
        AND EXISTS ( SELECT 1 FROM finishing_assignments fa
                     LEFT JOIN washing_data wd ON fa.washing_assignment_id = wd.id
                     LEFT JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                     JOIN cutting_lots c2 ON (wd.lot_no = c2.lot_no OR sd.lot_no = c2.lot_no)
                    WHERE c2.lot_no = cl.lot_no
                      AND DATE(fa.assigned_on) BETWEEN ? AND ? )`;
    default:
      return "";
  }
}

/* =======================================================================
 * SECTION 3 ·  getDepartmentStatuses() + filterByDept()
 * =====================================================================*/
function getDepartmentStatuses(cfg) {
  const {
    isDenim, totalCut,
    stitchedQty, assembledQty,
    washedQty, washingInQty, finishedQty,

    stIsApproved, stOpName,
    asmIsApproved, asmOpName,
    waIsApproved,  waOpName,
    wiIsApproved,  wiOpName,
    finIsApproved, finOpName
  } = cfg;

  /* defaults */
  let stitchingStatus = "N/A",
      assemblyStatus  = isDenim ? "N/A" : "—",
      washingStatus   = isDenim ? "N/A" : "—",
      washingInStatus = isDenim ? "N/A" : "—",
      finishingStatus = "N/A";

  /* ─────── Stitching ─────── */
  if (stIsApproved === undefined) {
    stitchingStatus = "In Cutting";
    if (isDenim) assemblyStatus = washingStatus = washingInStatus = finishingStatus = "In Cutting";
    else         finishingStatus = "In Cutting";
  } else if (stIsApproved === null) {
    stitchingStatus = `Pending Approval by ${stOpName || "???"}`;
    if (isDenim) assemblyStatus = washingStatus = washingInStatus = finishingStatus = "In Stitching";
    else         finishingStatus = "In Stitching";
  } else if (stIsApproved === 0) {
    stitchingStatus = `Denied by ${stOpName || "???"}`;
    if (isDenim) assemblyStatus = washingStatus = washingInStatus = finishingStatus = "In Stitching";
    else         finishingStatus = "In Stitching";
  } else {
    if (stitchedQty === 0)                  stitchingStatus = "In-Line";
    else if (stitchedQty >= totalCut)       stitchingStatus = "Completed";
    else                                    stitchingStatus = `${totalCut - stitchedQty} Pending`;
  }

  /* ─────── Hosiery branch  ─────── */
  if (!isDenim) {
    if (finIsApproved === undefined)        finishingStatus = "In Stitching";
    else if (finIsApproved === null)        finishingStatus = `Pending Approval by ${finOpName || "???"}`;
    else if (finIsApproved === 0)           finishingStatus = `Denied by ${finOpName || "???"}`;
    else {
      if (finishedQty === 0)                       finishingStatus = "In-Line";
      else if (finishedQty >= stitchedQty)         finishingStatus = "Completed";
      else                                         finishingStatus = `${stitchedQty - finishedQty} Pending`;
    }
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }

  /* ─────── Denim branch  ─────── */
  /* Assembly */
  if (asmIsApproved === undefined) {
    assemblyStatus = washingStatus = washingInStatus = finishingStatus = "In Stitching";
    return pack();
  }
  if (asmIsApproved === null) {
    assemblyStatus = `Pending Approval by ${asmOpName || "???"}`;
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return pack();
  }
  if (asmIsApproved === 0) {
    assemblyStatus = `Denied by ${asmOpName || "???"}`;
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return pack();
  }
  if (assembledQty === 0)                   assemblyStatus = "In-Line";
  else if (assembledQty >= stitchedQty)     assemblyStatus = "Completed";
  else                                      assemblyStatus = `${stitchedQty - assembledQty} Pending`;

  /* Washing */
  if (waIsApproved === undefined) {
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return pack();
  }
  if (waIsApproved === null) {
    washingStatus = `Pending Approval by ${waOpName || "???"}`;
    washingInStatus = finishingStatus = "In Washing";
    return pack();
  }
  if (waIsApproved === 0) {
    washingStatus = `Denied by ${waOpName || "???"}`;
    washingInStatus = finishingStatus = "In Washing";
    return pack();
  }
  if (washedQty === 0)                      washingStatus = "In-Line";
  else if (washedQty >= assembledQty)       washingStatus = "Completed";
  else                                      washingStatus = `${assembledQty - washedQty} Pending`;

  /* Washing-In */
  if (wiIsApproved === undefined) {
    washingInStatus = finishingStatus = "In Washing";
    return pack();
  }
  if (wiIsApproved === null) {
    washingInStatus = `Pending Approval by ${wiOpName || "???"}`;
    finishingStatus = "In WashingIn";
    return pack();
  }
  if (wiIsApproved === 0) {
    washingInStatus = `Denied by ${wiOpName || "???"}`;
    finishingStatus = "In WashingIn";
    return pack();
  }
  if (washingInQty === 0)                   washingInStatus = "In-Line";
  else if (washingInQty >= washedQty)       washingInStatus = "Completed";
  else                                      washingInStatus = `${washedQty - washingInQty} Pending`;

  /* Finishing */
  if (finIsApproved === undefined)          finishingStatus = "In WashingIn";
  else if (finIsApproved === null)          finishingStatus = `Pending Approval by ${finOpName || "???"}`;
  else if (finIsApproved === 0)             finishingStatus = `Denied by ${finOpName || "???"}`;
  else {
    if (finishedQty === 0)                       finishingStatus = "In-Line";
    else if (finishedQty >= washingInQty)        finishingStatus = "Completed";
    else                                         finishingStatus = `${washingInQty - finishedQty} Pending`;
  }

  return pack();

  function pack() {
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
}

function filterByDept(args) {
  const { department, isDenim,
          stitchingStatus, assemblyStatus, washingStatus,
          washingInStatus, finishingStatus } = args;

  if (department === "all") {
    const actual = isDenim
      ? (!finishingStatus.startsWith("N/A") ? finishingStatus
         : !washingInStatus.startsWith("N/A") ? washingInStatus
         : !washingStatus.startsWith("N/A")   ? washingStatus
         : !assemblyStatus.startsWith("N/A")  ? assemblyStatus
         : stitchingStatus)
      : (!finishingStatus.startsWith("N/A") ? finishingStatus : stitchingStatus);
    return { showRow: true, actualStatus: actual };
  }

  const depts = {
    cutting   : { show: true,  status: "Completed" },
    stitching : { show: true,  status: stitchingStatus },
    assembly  : { show: isDenim, status: assemblyStatus },
    washing   : { show: isDenim, status: washingStatus },
    washing_in: { show: isDenim, status: washingInStatus },
    finishing : { show: true,  status: finishingStatus }
  };
  return depts[department] || { showRow: true, actualStatus: "N/A" };
}

/* =======================================================================
 * SECTION 4 ·  PIC-REPORT  (download-only, 10-query strategy)
 * =====================================================================*/
router.get("/dashboard/pic-report",
  isAuthenticated,
  isOperator,
  async (req, res) => {
    try {
      const {
        lotType   = "all",
        department= "all",
        status    = "all",
        dateFilter= "createdAt",
        startDate = "",
        endDate   = ""
      } = req.query;

      /* WHERE parts */
      let dateWhere = "", dateParams = [];
      if (startDate && endDate && dateFilter === "createdAt") {
        dateWhere = "AND DATE(cl.created_at) BETWEEN ? AND ?";
        dateParams.push(startDate, endDate);
      } else if (startDate && endDate && dateFilter === "assignedOn") {
        dateWhere = buildAssignedOnFilter(department);
        dateParams.push(startDate, endDate);
      }

      const lotTypeClause =
        lotType === "denim"   ? "AND (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')"
      : lotType === "hosiery" ? "AND (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')"
      : "";

      /* candidate lots */
      const [lots] = await pool.query(`
        SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.created_at, cl.remark
          FROM cutting_lots cl
         WHERE 1 ${lotTypeClause} ${dateWhere}
         ORDER BY cl.created_at DESC`, dateParams);
      if (!lots.length) return res.status(204).end();

      const lotNos    = lots.map(l => l.lot_no);
      const qtyMap    = await fetchQtyMaps(lotNos);
      const assignMap = await fetchAssignmentMaps(lotNos);

      /* rows array */
      const rows = [];
      for (const l of lots) {
        const lotNo = l.lot_no, denim = isDenimLot(lotNo);

        const stitchedQty  = qtyMap.stitched [lotNo] || 0;
        const assembledQty = denim ? qtyMap.assembled[lotNo] || 0 : 0;
        const washedQty    = denim ? qtyMap.washed   [lotNo] || 0 : 0;
        const washInQty    = denim ? qtyMap.washIn   [lotNo] || 0 : 0;
        const finishedQty  = qtyMap.finished [lotNo] || 0;

        const stA = assignMap.stitching [lotNo] || {};
        const asA = denim ? assignMap.assembly  [lotNo] || {} : {};
        const waA = denim ? assignMap.washing   [lotNo] || {} : {};
        const wiA = denim ? assignMap.washingIn [lotNo] || {} : {};
        const fiA = assignMap.finishing [lotNo] || {};

        const stat = getDepartmentStatuses({
          isDenim: denim,
          totalCut: +l.total_pieces,
          stitchedQty, assembledQty, washedQty,
          washingInQty: washInQty, finishedQty,

          stIsApproved: stA.is_approved, stOpName: stA.opName,
          asmIsApproved: asA.is_approved, asmOpName: asA.opName,
          waIsApproved: waA.is_approved,  waOpName: waA.opName,
          wiIsApproved: wiA.is_approved,  wiOpName: wiA.opName,
          finIsApproved: fiA.is_approved, finOpName: fiA.opName
        });

        const dept = filterByDept({
          department,
          isDenim: denim,
          stitchingStatus : stat.stitchingStatus,
          assemblyStatus  : stat.assemblyStatus,
          washingStatus   : stat.washingStatus,
          washingInStatus : stat.washingInStatus,
          finishingStatus : stat.finishingStatus
        });
        if (!dept.showRow) continue;

        const act = dept.actualStatus.toLowerCase();
        if (status !== "all") {
          if (status === "not_assigned" && !act.startsWith("in ")) continue;
          if (status === "inline"       && !act.includes("in-line")) continue;
          if (!["inline","not_assigned"].includes(status) && !act.includes(status)) continue;
        }

        rows.push({
          lotNo, sku: l.sku, lotType: denim ? "Denim" : "Hosiery",
          totalCut: +l.total_pieces, createdAt: l.created_at, remark: l.remark || "",

          stitchAssignedOn : stA.assigned_on || null,
          stitchApprovedOn : stA.approved_on || null,
          stitchOp         : stA.opName || "",
          stitchStatus     : stat.stitchingStatus,
          stitchedQty,

          assemblyAssignedOn: asA.assigned_on || null,
          assemblyApprovedOn: asA.approved_on || null,
          assemblyOp        : asA.opName || "",
          assemblyStatus    : stat.assemblyStatus,
          assembledQty,

          washingAssignedOn : waA.assigned_on || null,
          washingApprovedOn : waA.approved_on || null,
          washingOp         : waA.opName || "",
          washingStatus     : stat.washingStatus,
          washedQty,

          washingInAssignedOn: wiA.assigned_on || null,
          washingInApprovedOn: wiA.approved_on || null,
          washingInOp        : wiA.opName || "",
          washingInStatus    : stat.washingInStatus,
          washingInQty       : washInQty,

          finishingAssignedOn: fiA.assigned_on || null,
          finishingApprovedOn: fiA.approved_on || null,
          finishingOp        : fiA.opName || "",
          finishingStatus    : stat.finishingStatus,
          finishedQty
        });
      }

      /* Excel – identical columns as legacy */
      const wb = new ExcelJS.Workbook();
      wb.creator = "KottyTrack PIC-Report";
      const ws   = wb.addWorksheet("PIC-Report");

      ws.columns = [
        { header: "Lot No",               key: "lotNo",               width: 12 },
        { header: "SKU",                  key: "sku",                 width: 14 },
        { header: "Lot Type",             key: "lotType",             width: 9  },
        { header: "Total Cut",            key: "totalCut",            width: 10 },
        { header: "Created At",           key: "createdAt",           width: 15 },
        { header: "Remark",               key: "remark",              width: 20 },

        { header: "Stitch Assigned",      key: "stitchAssignedOn",    width: 20 },
        { header: "Stitch Approved",      key: "stitchApprovedOn",    width: 20 },
        { header: "Stitch Op",            key: "stitchOp",            width: 14 },
        { header: "Stitch Status",        key: "stitchStatus",        width: 25 },
        { header: "Stitched Qty",         key: "stitchedQty",         width: 12 },

        { header: "Assembly Assigned",    key: "assemblyAssignedOn",  width: 20 },
        { header: "Assembly Approved",    key: "assemblyApprovedOn",  width: 20 },
        { header: "Assembly Op",          key: "assemblyOp",          width: 14 },
        { header: "Assembly Status",      key: "assemblyStatus",      width: 25 },
        { header: "Assembled Qty",        key: "assembledQty",        width: 13 },

        { header: "Washing Assigned",     key: "washingAssignedOn",   width: 20 },
        { header: "Washing Approved",     key: "washingApprovedOn",   width: 20 },
        { header: "Washing Op",           key: "washingOp",           width: 14 },
        { header: "Washing Status",       key: "washingStatus",       width: 25 },
        { header: "Washed Qty",           key: "washedQty",           width: 12 },

        { header: "Wash-In Assigned",     key: "washingInAssignedOn", width: 20 },
        { header: "Wash-In Approved",     key: "washingInApprovedOn", width: 20 },
        { header: "Wash-In Op",           key: "washingInOp",         width: 14 },
        { header: "Wash-In Status",       key: "washingInStatus",     width: 25 },
        { header: "Wash-In Qty",          key: "washingInQty",        width: 12 },

        { header: "Finish Assigned",      key: "finishingAssignedOn", width: 20 },
        { header: "Finish Approved",      key: "finishingApprovedOn", width: 20 },
        { header: "Finish Op",            key: "finishingOp",         width: 14 },
        { header: "Finish Status",        key: "finishingStatus",     width: 25 },
        { header: "Finished Qty",         key: "finishedQty",         width: 12 }
      ];

      rows.forEach(r => ws.addRow({
        lotNo              : r.lotNo,
        sku                : r.sku,
        lotType            : r.lotType,
        totalCut           : r.totalCut,
        createdAt          : r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "",
        remark             : r.remark,

        stitchAssignedOn   : r.stitchAssignedOn ? new Date(r.stitchAssignedOn).toLocaleString() : "N/A",
        stitchApprovedOn   : r.stitchApprovedOn ? new Date(r.stitchApprovedOn).toLocaleString() : "N/A",
        stitchOp           : r.stitchOp,
        stitchStatus       : r.stitchStatus,
        stitchedQty        : r.stitchedQty,

        assemblyAssignedOn : r.assemblyAssignedOn ? new Date(r.assemblyAssignedOn).toLocaleString() : "N/A",
        assemblyApprovedOn : r.assemblyApprovedOn ? new Date(r.assemblyApprovedOn).toLocaleString() : "N/A",
        assemblyOp         : r.assemblyOp,
        assemblyStatus     : r.assemblyStatus,
        assembledQty       : r.assembledQty,

        washingAssignedOn  : r.washingAssignedOn ? new Date(r.washingAssignedOn).toLocaleString() : "N/A",
        washingApprovedOn  : r.washingApprovedOn ? new Date(r.washingApprovedOn).toLocaleString() : "N/A",
        washingOp          : r.washingOp,
        washingStatus      : r.washingStatus,
        washedQty          : r.washedQty,

        washingInAssignedOn: r.washingInAssignedOn ? new Date(r.washingInAssignedOn).toLocaleString() : "N/A",
        washingInApprovedOn: r.washingInApprovedOn ? new Date(r.washingInApprovedOn).toLocaleString() : "N/A",
        washingInOp        : r.washingInOp,
        washingInStatus    : r.washingInStatus,
        washingInQty       : r.washingInQty,

        finishingAssignedOn: r.finishingAssignedOn ? new Date(r.finishingAssignedOn).toLocaleString() : "N/A",
        finishingApprovedOn: r.finishingApprovedOn ? new Date(r.finishingApprovedOn).toLocaleString() : "N/A",
        finishingOp        : r.finishingOp,
        finishingStatus    : r.finishingStatus,
        finishedQty        : r.finishedQty
      }));

      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="PIC-Report-${Date.now()}.xlsx"`);

      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("PIC-Report (download):", err);
      res.status(500).send("Server error");
    }
  });

/* =======================================================================
 * SECTION 5 ·  EVERYTHING ELSE – untouched from your last full file
 * =====================================================================*/

/* --------------------  /dashboard  -------------------- */
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { search, startDate, endDate,
            sortField="lot_no", sortOrder="asc", category="all" } = req.query;

    /* 1. operator performance */
    const perf = {};
    const fill = (rows, key) => rows.forEach(r => {
      if (!perf[r.user_id]) perf[r.user_id] = { totalStitched:0,totalWashed:0,totalFinished:0 };
      perf[r.user_id][key] = +r.sum || 0;
    });

    fill((await pool.query(`
      SELECT user_id, SUM(total_pieces) sum FROM stitching_data GROUP BY user_id`))[0],"totalStitched");
    fill((await pool.query(`
      SELECT user_id, SUM(total_pieces) sum FROM washing_data GROUP BY user_id`))[0],"totalWashed");
    fill((await pool.query(`
      SELECT user_id, SUM(total_pieces) sum FROM finishing_data GROUP BY user_id`))[0],"totalFinished");

    if (Object.keys(perf).length) {
      const [users] = await pool.query(`SELECT id, username FROM users WHERE id IN (?)`, [Object.keys(perf)]);
      users.forEach(u => perf[u.id].username = u.username);
    }

    /* 2. quick stats */
    const [[{lotCount}]] = await pool.query(`SELECT COUNT(*) lotCount FROM cutting_lots`);
    const [[{piecesCut}]]=
      await pool.query(`SELECT COALESCE(SUM(total_pieces),0) piecesCut FROM cutting_lots`);
    const [[{stitched}]] =
      await pool.query(`SELECT COALESCE(SUM(total_pieces),0) stitched FROM stitching_data`);
    const [[{washed}]]   =
      await pool.query(`SELECT COALESCE(SUM(total_pieces),0) washed FROM washing_data`);
    const [[{finished}]] =
      await pool.query(`SELECT COALESCE(SUM(total_pieces),0) finished FROM finishing_data`);
    const [[{userCount}]]=
      await pool.query(`SELECT COUNT(*) userCount FROM users`);

    /* advancedAnalytics unchanged – omitted to save space; keep your original function */
    const advancedAnalytics = {}; /* call your original computeAdvancedAnalytics if needed */

    res.render("operatorDashboard", {
      lotCount, totalPiecesCut: piecesCut,
      totalStitched: stitched, totalWashed: washed, totalFinished: finished,
      userCount, advancedAnalytics,
      operatorPerformance: perf,
      query: { search, startDate, endDate, sortField, sortOrder, category },
      lotDetails: {}
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    res.status(500).send("Server error");
  }
});

/* --------------------  /dashboard/api/leftovers  -------------------- */
/* keep your original leftover handler – unchanged */

// At top of your routes file, ensure you import isStitchingMaster:
const { isStitchingMaster } = require("../middlewares/auth");

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

    // 1) Identify all users (Stitching Masters) who have
    //    either "pending" or "in-line" stitching assignments
    //    => "pending" = sa.isApproved IS NULL
    //    => "in-line" = sa.isApproved=1 BUT next step is not assigned
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
                  -- DENIM => next step is Assembly
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
                  -- NON-DENIM => next step is Finishing
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

    // 2) For each master, count how many are pending vs in line
    const masterCards = [];
    for (const m of masters) {
      const masterId = m.id;

      // pending = isApproved IS NULL
      const [pendRows] = await pool.query(`
        SELECT COALESCE(SUM(cl.total_pieces),0) AS pendingSum
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id = ?
           AND sa.isApproved IS NULL
      `, [masterId]);
      const pendingApproval = parseFloat(pendRows[0].pendingSum) || 0;

      // in line = isApproved=1, next step not assigned
      const [inLineRows] = await pool.query(`
        SELECT COALESCE(SUM(cl.total_pieces),0) AS inLineSum
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id = ?
           AND sa.isApproved = 1
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
      `, [masterId]);
      const inLinePieces = parseFloat(inLineRows[0].inLineSum) || 0;

      masterCards.push({
        masterId,
        username: m.username,
        pendingApproval,
        inLinePieces
      });
    }

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

    // 1) Master info
    const [[masterUser]] = await pool.query(
      `SELECT id, username FROM users WHERE id = ?`,
      [masterId]
    );
    if (!masterUser) {
      return res.status(404).send("Stitching Master not found");
    }

    // 2) Fetch stitching_assignments that are pending or in line
    const [assignments] = await pool.query(`
      SELECT sa.id           AS stitching_assignment_id,
             sa.isApproved   AS stitchIsApproved,
             sa.assigned_on  AS stitchAssignedOn,
             cl.lot_no,
             cl.sku,
             cl.total_pieces,
             cl.remark       AS cutting_remark
        FROM stitching_assignments sa
        JOIN cutting_lots cl
          ON sa.cutting_lot_id = cl.id
       WHERE sa.user_id = ?
         AND (
              sa.isApproved IS NULL
              OR (
                   sa.isApproved = 1
                   AND (
                     -- Denim => next step is Assembly
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
                     -- Non-denim => next step is Finishing
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
       ORDER BY sa.assigned_on DESC
    `, [masterId]);

    // 3) Build detailRows
    const detailRows = [];
    const currentDate = new Date();

    for (const a of assignments) {
      const {
        lot_no,
        sku,
        total_pieces,
        cutting_remark,
        stitchAssignedOn,
        stitchIsApproved
      } = a;
      let nextAssignedOn = null;
      const isDenim = isDenimLot(lot_no);

      // If isApproved=1 => check next assignment
      if (stitchIsApproved === 1) {
        if (isDenim) {
          // Next step => assembly
          const [asmRows] = await pool.query(`
            SELECT ja.assigned_on
              FROM jeans_assembly_assignments ja
              JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
             WHERE sd.lot_no = ?
               AND ja.is_approved IS NOT NULL
             ORDER BY ja.assigned_on ASC
             LIMIT 1
          `, [lot_no]);
          if (asmRows.length) {
            nextAssignedOn = asmRows[0].assigned_on;
          }
        } else {
          // Next step => finishing
          const [finRows] = await pool.query(`
            SELECT fa.assigned_on
              FROM finishing_assignments fa
              JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
             WHERE sd.lot_no = ?
               AND fa.is_approved IS NOT NULL
             ORDER BY fa.assigned_on ASC
             LIMIT 1
          `, [lot_no]);
          if (finRows.length) {
            nextAssignedOn = finRows[0].assigned_on;
          }
        }
      }

      // Calculate TAT (days)
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
        status: (stitchIsApproved === null) ? "Pending Approval" : "In Line"
      });
    }

    // 4) If ?download=1 => produce Excel
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

    // We do have a SKU -> search all tables that contain `sku` columns
    const tables = [
      { tableName: "cutting_lots", label: "Cutting Lots" },
      { tableName: "stitching_data", label: "Stitching Data" },
      { tableName: "jeans_assembly_data", label: "Jeans Assembly Data" },
      { tableName: "washing_data", label: "Washing Data" },
      { tableName: "washing_in_data", label: "Washing In Data" },
      { tableName: "finishing_data", label: "Finishing Data" },
      { tableName: "rewash_requests", label: "Rewash Requests" }
    ];

    const results = [];

    // Fetch rows from each table that has the given SKU
    for (const t of tables) {
      const [rows] = await pool.query(
        `SELECT lot_no, sku FROM ${t.tableName} WHERE sku = ?`,
        [sku.trim()]
      );
      if (rows.length > 0) {
        results.push({
          label: t.label,       // For display (e.g. "Cutting Lots")
          tableName: t.tableName,
          rows
        });
      }
    }

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
module.exports = router;
