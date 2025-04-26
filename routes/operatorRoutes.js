/**************************************************************************
 * operatorRoutes.js  –  Kotty-Track (April 2025)
 *
 *  • Denim chain : Cut → Stitching → Assembly → Washing → Washing-In → Finishing
 *  • Hosiery     : Cut → Stitching → Finishing
 *  • PIC Report  : download-only, 10-query bulk strategy
 *  • All legacy dashboards/reports retained
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
 * SECTION 1 · BULK HELPERS (qty + latest-assignment maps, 10 queries)
 * =====================================================================*/
const toQtyMap = (rows) => {
  const m = Object.create(null);
  for (const r of rows) m[r.lot_no] = +r.qty || 0;
  return m;
};
async function fetchQtyMaps(lotNos) {
  const q = async (table) => (
    await pool.query(
      `SELECT lot_no, SUM(total_pieces) qty
         FROM ${table}
        WHERE lot_no IN (?)
        GROUP BY lot_no`, [lotNos]))[0];

  return {
    stitched : toQtyMap(await q("stitching_data")),
    assembled: toQtyMap(await q("jeans_assembly_data")),
    washed   : toQtyMap(await q("washing_data")),
    washIn   : toQtyMap(await q("washing_in_data")),
    finished : toQtyMap(await q("finishing_data"))
  };
}

const rowsToObj = (arr) => {
  const o = Object.create(null);
  for (const r of arr) o[r.lot_no] = r;
  return o;
};
async function fetchAssignmentMaps(lotNos) {
  /* helper for MAX(assigned_on) */
  const latest = (alias, field) => `
      JOIN ( SELECT ${field} lot_no, MAX(a2.assigned_on) last_on
               FROM ${alias} a2
               ${alias.includes("finishing") ? `
                 LEFT JOIN washing_data wd2   ON a2.washing_assignment_id = wd2.id
                 LEFT JOIN stitching_data sd2 ON a2.stitching_assignment_id = sd2.id` : ""}
               ${alias.includes("stitching")  ? "JOIN cutting_lots  c2 ON a2.cutting_lot_id = c2.id" : ""}
              WHERE ${field} IN (?)
              GROUP BY ${field} ) latest
        ON latest.lot_no = ${field}
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

  /* finishing */
  const [fi] = await pool.query(`
    SELECT COALESCE(wd.lot_no, sd.lot_no) lot_no, a.is_approved,
           a.assigned_on, a.approved_on, u.username opName
      FROM finishing_assignments a
      LEFT JOIN washing_data wd   ON a.washing_assignment_id   = wd.id
      LEFT JOIN stitching_data sd ON a.stitching_assignment_id = sd.id
      JOIN users u ON u.id = a.user_id
      ${latest("finishing_assignments", "COALESCE(wd.lot_no, sd.lot_no)")};`, [lotNos]);

  return {
    stitching : rowsToObj(st),
    assembly  : rowsToObj(asm),
    washing   : rowsToObj(wa),
    washingIn : rowsToObj(wi),
    finishing : rowsToObj(fi)
  };
}

/* =======================================================================
 * SECTION 2 · DATE-filter builder for ?dateFilter=assignedOn
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
 * SECTION 3 · getDepartmentStatuses() + filterByDept()
 * =====================================================================*/
function getDepartmentStatuses(o) {
  const {
    isDenim, totalCut,
    stitchedQty, assembledQty, washedQty, washingInQty, finishedQty,

    stIsApproved, stOpName,
    asmIsApproved, asmOpName,
    waIsApproved,  waOpName,
    wiIsApproved,  wiOpName,
    finIsApproved, finOpName
  } = o;

  let stitchingStatus = "N/A",
      assemblyStatus  = isDenim ? "N/A" : "—",
      washingStatus   = isDenim ? "N/A" : "—",
      washingInStatus = isDenim ? "N/A" : "—",
      finishingStatus = "N/A";

  /* ───── Stitching ───── */
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
    stitchingStatus = stitchedQty === 0
      ? "In-Line"
      : stitchedQty >= totalCut
        ? "Completed"
        : `${totalCut - stitchedQty} Pending`;
  }

  /* ───── Hosiery branch ───── */
  if (!isDenim) {
    if (finIsApproved === undefined) {
      finishingStatus = "In Stitching";
    } else if (finIsApproved === null) {
      finishingStatus = `Pending Approval by ${finOpName || "???"}`;
    } else if (finIsApproved === 0) {
      finishingStatus = `Denied by ${finOpName || "???"}`;
    } else {
      finishingStatus = finishedQty === 0
        ? "In-Line"
        : finishedQty >= stitchedQty
          ? "Completed"
          : `${stitchedQty - finishedQty} Pending`;
    }
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }

  /* ───── Denim branch ───── */
  /* Assembly */
  if (asmIsApproved === undefined) {
    assemblyStatus = washingStatus = washingInStatus = finishingStatus = "In Stitching";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (asmIsApproved === null) {
    assemblyStatus = `Pending Approval by ${asmOpName || "???"}`;
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (asmIsApproved === 0) {
    assemblyStatus = `Denied by ${asmOpName || "???"}`;
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  assemblyStatus = assembledQty === 0
    ? "In-Line"
    : assembledQty >= stitchedQty
      ? "Completed"
      : `${stitchedQty - assembledQty} Pending`;

  /* Washing */
  if (waIsApproved === undefined) {
    washingStatus = washingInStatus = finishingStatus = "In Assembly";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (waIsApproved === null) {
    washingStatus = `Pending Approval by ${waOpName || "???"}`;
    washingInStatus = finishingStatus = "In Washing";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (waIsApproved === 0) {
    washingStatus = `Denied by ${waOpName || "???"}`;
    washingInStatus = finishingStatus = "In Washing";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  washingStatus = washedQty === 0
    ? "In-Line"
    : washedQty >= assembledQty
      ? "Completed"
      : `${assembledQty - washedQty} Pending`;

  /* Washing-In */
  if (wiIsApproved === undefined) {
    washingInStatus = finishingStatus = "In Washing";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (wiIsApproved === null) {
    washingInStatus = `Pending Approval by ${wiOpName || "???"}`;
    finishingStatus = "In WashingIn";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  if (wiIsApproved === 0) {
    washingInStatus = `Denied by ${wiOpName || "???"}`;
    finishingStatus = "In WashingIn";
    return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
  }
  washingInStatus = washingInQty === 0
    ? "In-Line"
    : washingInQty >= washedQty
      ? "Completed"
      : `${washedQty - washingInQty} Pending`;

  /* Finishing */
  if (finIsApproved === undefined) {
    finishingStatus = "In WashingIn";
  } else if (finIsApproved === null) {
    finishingStatus = `Pending Approval by ${finOpName || "???"}`;
  } else if (finIsApproved === 0) {
    finishingStatus = `Denied by ${finOpName || "???"}`;
  } else {
    finishingStatus = finishedQty === 0
      ? "In-Line"
      : finishedQty >= washingInQty
        ? "Completed"
        : `${washingInQty - finishedQty} Pending`;
  }

  return { stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus };
}

function filterByDept({
  department, isDenim,
  stitchingStatus, assemblyStatus, washingStatus,
  washingInStatus, finishingStatus
}) {
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

  const map = {
    cutting   : { showRow: true,         actualStatus: "Completed" },
    stitching : { showRow: true,         actualStatus: stitchingStatus },
    assembly  : { showRow: isDenim,      actualStatus: assemblyStatus },
    washing   : { showRow: isDenim,      actualStatus: washingStatus },
    washing_in: { showRow: isDenim,      actualStatus: washingInStatus },
    finishing : { showRow: true,         actualStatus: finishingStatus }
  };
  return map[department] || { showRow: true, actualStatus: "N/A" };
}

/* =======================================================================
 * SECTION 4 · PIC-REPORT (download-only, 10 query strategy)
 * =====================================================================*/
router.get("/dashboard/pic-report",
  isAuthenticated, isOperator,
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

      /* build rows */
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
          stitchedQty, assembledQty, washedQty, washingInQty: washInQty, finishedQty,

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
 * SECTION 5 · REST OF ORIGINAL ROUTES (dashboard, leftovers, TAT, SKU)
 * =====================================================================*/

/* ---------- computeAdvancedAnalytics (unchanged from your code) ------ */
async function computeAdvancedAnalytics(start, end) {
  const analytics = {};

  const [[{ totalCut }]] =
    await pool.query(`SELECT SUM(total_pieces) totalCut FROM cutting_lots`);
  analytics.totalCut = +totalCut || 0;

  const [[{ totalStitched }]] =
    await pool.query(`SELECT SUM(total_pieces) totalStitched FROM stitching_data`);
  analytics.totalStitched = +totalStitched || 0;

  const [[{ totalWashed }]] =
    await pool.query(`SELECT SUM(total_pieces) totalWashed FROM washing_data`);
  analytics.totalWashed = +totalWashed || 0;

  const [[{ totalFinished }]] =
    await pool.query(`SELECT SUM(total_pieces) totalFinished FROM finishing_data`);
  analytics.totalFinished = +totalFinished || 0;

  analytics.stitchConversion = analytics.totalCut
    ? ((analytics.totalStitched / analytics.totalCut) * 100).toFixed(2)
    : "0.00";
  analytics.washConversion = analytics.totalStitched
    ? (((analytics.totalWashed || analytics.totalFinished) / analytics.totalStitched) * 100).toFixed(2)
    : "0.00";
  analytics.finishConversion = analytics.totalWashed
    ? ((analytics.totalFinished / analytics.totalWashed) * 100).toFixed(2)
    : (analytics.totalStitched
        ? ((analytics.totalFinished / analytics.totalStitched) * 100).toFixed(2)
        : "0.00");

  /* top/bottom SKUs */
  const topQ = `
    SELECT sku, SUM(total_pieces) total
      FROM cutting_lots
     WHERE ${start && end ? "created_at BETWEEN ? AND ?" : "created_at >= DATE_SUB(NOW(), INTERVAL 10 DAY)"}
     GROUP BY sku ORDER BY total DESC LIMIT 10`;
  const bottomQ = topQ.replace("DESC", "ASC");
  analytics.top10SKUs    = (await pool.query(topQ, start && end ? [start, end] : []))[0];
  analytics.bottom10SKUs = (await pool.query(bottomQ, start && end ? [start, end] : []))[0];

  /* lot counts */
  const [[{ totalCount }]]   = await pool.query(`SELECT COUNT(*) totalCount FROM cutting_lots`);
  const [[{ pending }]     ] = await pool.query(`
      SELECT COUNT(*) pending
        FROM cutting_lots c
        LEFT JOIN ( SELECT lot_no, SUM(total_pieces) fin FROM finishing_data GROUP BY lot_no ) f
          ON c.lot_no = f.lot_no
       WHERE COALESCE(f.fin,0) < c.total_pieces`);
  analytics.totalLots   = totalCount;
  analytics.pendingLots = pending;

  /* avg turnaround */
  const [turnRows] = await pool.query(`
      SELECT c.created_at cut_date, MAX(f.created_at) fin_date, c.total_pieces,
             SUM(f.total_pieces) fin_tot
        FROM cutting_lots c
        JOIN finishing_data f ON c.lot_no = f.lot_no
       GROUP BY c.lot_no
      HAVING fin_tot >= c.total_pieces`);
  let diffSum = 0, n = 0;
  turnRows.forEach(r => {
    diffSum += (new Date(r.fin_date) - new Date(r.cut_date)) / (1000*60*60*24);
    n++;
  });
  analytics.avgTurnaroundTime = n ? +(diffSum / n).toFixed(2) : 0;

  /* approval rates */
  const [[st]] = await pool.query(`
      SELECT COUNT(*) tot,
             SUM(CASE WHEN isApproved=1 THEN 1 END) ok
        FROM stitching_assignments`);
  analytics.stitchApprovalRate = st.tot ? ((st.ok/st.tot)*100).toFixed(2) : "0.00";

  const [[wa]] = await pool.query(`
      SELECT COUNT(*) tot,
             SUM(CASE WHEN is_approved=1 THEN 1 END) ok
        FROM washing_assignments`);
  analytics.washApprovalRate   = wa.tot ? ((wa.ok/wa.tot)*100).toFixed(2) : "0.00";

  return analytics;
}

/* ---------- dashboard route (includes analytics) -------------------- */
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    /* mini stats */
    const [[{ lotCount }]]     = await pool.query(`SELECT COUNT(*) lotCount FROM cutting_lots`);
    const [[{ piecesCut }]]    = await pool.query(`SELECT SUM(total_pieces) piecesCut FROM cutting_lots`);
    const [[{ stitched }]]     = await pool.query(`SELECT SUM(total_pieces) stitched FROM stitching_data`);
    const [[{ washed }]]       = await pool.query(`SELECT SUM(total_pieces) washed FROM washing_data`);
    const [[{ finished }]]     = await pool.query(`SELECT SUM(total_pieces) finished FROM finishing_data`);
    const [[{ userCount }]]    = await pool.query(`SELECT COUNT(*) userCount FROM users`);

    /* simple operator perf (stitched / washed / finished) */
    const perf = {};
    const perfFill = async (tbl, key) => {
      const [rows] = await pool.query(`SELECT user_id, SUM(total_pieces) qty FROM ${tbl} GROUP BY user_id`);
      rows.forEach(r => {
        if (!perf[r.user_id]) perf[r.user_id] = { totalStitched:0,totalWashed:0,totalFinished:0 };
        perf[r.user_id][key] = +r.qty || 0;
      });
    };
    await perfFill("stitching_data", "totalStitched");
    await perfFill("washing_data",   "totalWashed");
    await perfFill("finishing_data", "totalFinished");
    if (Object.keys(perf).length) {
      const [users] = await pool.query(`SELECT id, username FROM users WHERE id IN (?)`, [Object.keys(perf)]);
      users.forEach(u => perf[u.id].username = u.username);
    }

    const advancedAnalytics = await computeAdvancedAnalytics(startDate, endDate);

    res.render("operatorDashboard", {
      lotCount,
      totalPiecesCut: +piecesCut || 0,
      totalStitched:  +stitched  || 0,
      totalWashed:    +washed    || 0,
      totalFinished:  +finished  || 0,
      userCount,
      advancedAnalytics,
      operatorPerformance: perf,
      query: req.query,
      lotDetails: {}
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- leftovers API ------------------------------------------- */
router.get("/dashboard/api/leftovers", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { lot_no } = req.query;
    if (!lot_no) return res.status(400).json({ error: "lot_no required" });

    const denim = isDenimLot(lot_no);
    const adv   = await computeAdvancedLeftoversForLot(lot_no, denim);
    const jeansLeft = await computeJeansLeftover(
      lot_no,
      (await pool.query(`SELECT SUM(total_pieces) s FROM stitching_data WHERE lot_no=?`, [lot_no]))[0][0].s || 0,
      denim
    );

    res.json({ lot_no, ...adv, jeansLeft });
  } catch (err) {
    console.error("Error in /dashboard/api/leftovers:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ---------- Stitching TAT  (summary) -------------------------------- */
router.get("/stitching-tat", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { download = "0" } = req.query;

    const [masters] = await pool.query(`
      SELECT DISTINCT u.id, u.username
        FROM users u
        JOIN stitching_assignments sa ON sa.user_id = u.id
        JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
       WHERE sa.isApproved IS NULL
          OR (
            sa.isApproved = 1
            AND (
              (
                (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                AND NOT EXISTS (
                   SELECT 1 FROM jeans_assembly_assignments ja
                   JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                  WHERE sd.lot_no = cl.lot_no AND ja.is_approved IS NOT NULL)
              )
              OR (
                (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                AND NOT EXISTS (
                   SELECT 1 FROM finishing_assignments fa
                   JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                  WHERE sd.lot_no = cl.lot_no AND fa.is_approved IS NOT NULL)
              )
            )
          )`);

    const cards = [];
    for (const m of masters) {
      const [[{ pend }]] = await pool.query(`
        SELECT SUM(cl.total_pieces) pend
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id=? AND sa.isApproved IS NULL`, [m.id]);
      const [[{ inline }]] = await pool.query(`
        SELECT SUM(cl.total_pieces) inlineQty
          FROM stitching_assignments sa
          JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
         WHERE sa.user_id=? AND sa.isApproved=1
           AND (
             (
               (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
               AND NOT EXISTS (
                 SELECT 1 FROM jeans_assembly_assignments ja
                 JOIN stitching_data sd ON ja.stitching_assignment_id=sd.id
                WHERE sd.lot_no=cl.lot_no AND ja.is_approved IS NOT NULL)
             )
             OR
             (
               (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
               AND NOT EXISTS (
                 SELECT 1 FROM finishing_assignments fa
                 JOIN stitching_data sd ON fa.stitching_assignment_id=sd.id
                WHERE sd.lot_no=cl.lot_no AND fa.is_approved IS NOT NULL)
             )
           )`, [m.id]);

      cards.push({
        masterId: m.id,
        username: m.username,
        pendingApproval: +pend || 0,
        inLinePieces: +inline || 0
      });
    }

    if (download === "1") {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("StitchingTAT-Summary");
      ws.columns = [
        { header: "Master ID",       key: "masterId",       width: 12 },
        { header: "Username",        key: "username",       width: 22 },
        { header: "Pending Pieces",  key: "pending",        width: 18 },
        { header: "In-Line Pieces",  key: "inline",         width: 18 }
      ];
      cards.forEach(c => ws.addRow({
        masterId: c.masterId,
        username: c.username,
        pending : c.pendingApproval,
        inline  : c.inLinePieces
      }));
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="StitchingTAT-Summary.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    res.render("operatorStitchingTat", { masterCards: cards });
  } catch (err) {
    console.error("Error in /stitching-tat:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- Stitching TAT (detail) ---------------------------------- */
router.get("/stitching-tat/:masterId", isAuthenticated, isOperator, async (req, res) => {
  try {
    const masterId = +req.params.masterId;
    if (!masterId) return res.status(400).send("Invalid masterId");
    const { download="0" } = req.query;

    const [[master]] = await pool.query(`SELECT id, username FROM users WHERE id=?`, [masterId]);
    if (!master) return res.status(404).send("Stitching master not found");

    const [assignments] = await pool.query(`
      SELECT sa.isApproved, sa.assigned_on,
             cl.lot_no, cl.sku, cl.total_pieces, cl.remark
        FROM stitching_assignments sa
        JOIN cutting_lots cl ON sa.cutting_lot_id = cl.id
       WHERE sa.user_id=?
         AND (
           sa.isApproved IS NULL
           OR (
             sa.isApproved=1 AND (
               (
                 (UPPER(cl.lot_no) LIKE 'AK%' OR UPPER(cl.lot_no) LIKE 'UM%')
                 AND NOT EXISTS (
                   SELECT 1 FROM jeans_assembly_assignments ja
                   JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                  WHERE sd.lot_no=cl.lot_no AND ja.is_approved IS NOT NULL)
               )
               OR
               (
                 (UPPER(cl.lot_no) NOT LIKE 'AK%' AND UPPER(cl.lot_no) NOT LIKE 'UM%')
                 AND NOT EXISTS (
                   SELECT 1 FROM finishing_assignments fa
                   JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
                  WHERE sd.lot_no=cl.lot_no AND fa.is_approved IS NOT NULL)
               )
             )
           )
         )
       ORDER BY sa.assigned_on DESC`, [masterId]);

    const rows = [];
    const today = Date.now();
    for (const a of assignments) {
      const isDenim = isDenimLot(a.lot_no);
      let nextOn = null;
      if (a.isApproved === 1) {
        if (isDenim) {
          const [[n]] = await pool.query(`
            SELECT assigned_on FROM jeans_assembly_assignments ja
            JOIN stitching_data sd ON ja.stitching_assignment_id=sd.id
           WHERE sd.lot_no=? AND ja.is_approved IS NOT NULL
           ORDER BY assigned_on ASC LIMIT 1`, [a.lot_no]);
          nextOn = n && n.assigned_on;
        } else {
          const [[n]] = await pool.query(`
            SELECT assigned_on FROM finishing_assignments fa
            JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
           WHERE sd.lot_no=? AND fa.is_approved IS NOT NULL
           ORDER BY assigned_on ASC LIMIT 1`, [a.lot_no]);
          nextOn = n && n.assigned_on;
        }
      }
      const tat = a.assigned_on
        ? Math.floor(((nextOn ? new Date(nextOn) : today) - new Date(a.assigned_on)) / 86400000)
        : 0;
      rows.push({
        lotNo: a.lot_no,
        sku: a.sku,
        totalPieces: +a.total_pieces,
        cuttingRemark: a.remark || "",
        assignedOn: a.assigned_on,
        nextOn,
        status: a.isApproved === null ? "Pending Approval" : "In Line",
        tatDays: tat
      });
    }

    if (download === "1") {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("StitchingTAT-Detail");
      ws.columns = [
        { header: "Master",        key: "master",       width: 20 },
        { header: "Lot No",        key: "lot",          width: 14 },
        { header: "SKU",           key: "sku",          width: 14 },
        { header: "Status",        key: "status",       width: 18 },
        { header: "Pieces",        key: "pcs",          width: 10 },
        { header: "Remark",        key: "remark",       width: 22 },
        { header: "Assigned On",   key: "assign",       width: 15 },
        { header: "Next Dept On",  key: "next",         width: 15 },
        { header: "TAT (days)",    key: "tat",          width: 12 }
      ];
      rows.forEach(r => ws.addRow({
        master: master.username,
        lot   : r.lotNo,
        sku   : r.sku,
        status: r.status,
        pcs   : r.totalPieces,
        remark: r.cuttingRemark,
        assign: r.assignedOn ? formatDateDDMMYYYY(r.assignedOn) : "",
        next  : r.nextOn     ? formatDateDDMMYYYY(r.nextOn)     : "",
        tat   : r.tatDays
      }));
      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition",
        `attachment; filename="StitchingTAT-${master.username}.xlsx"`);
      await wb.xlsx.write(res);
      return res.end();
    }

    res.render("operatorStitchingTatDetail", {
      masterUser: master,
      detailRows: rows.map(r => ({
        ...r,
        assignedOnStr: r.assignedOn ? formatDateDDMMYYYY(r.assignedOn) : "",
        nextOnStr    : r.nextOn     ? formatDateDDMMYYYY(r.nextOn)     : ""
      })),
      currentDate: formatDateDDMMYYYY(new Date())
    });
  } catch (err) {
    console.error("Error in /stitching-tat/:masterId:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- SKU-Management (GET) ------------------------------------ */
router.get("/sku-management", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { sku } = req.query;
    if (!sku) return res.render("skuManagement", { sku:"", results:[], message:"", error:"" });

    const tables = [
      { table:"cutting_lots",        label:"Cutting Lots" },
      { table:"stitching_data",      label:"Stitching Data" },
      { table:"jeans_assembly_data", label:"Jeans Assembly Data" },
      { table:"washing_data",        label:"Washing Data" },
      { table:"washing_in_data",     label:"Washing In Data" },
      { table:"finishing_data",      label:"Finishing Data" },
      { table:"rewash_requests",     label:"Rewash Requests" }
    ];

    const results = [];
    for (const t of tables) {
      const [rows] = await pool.query(`SELECT lot_no FROM ${t.table} WHERE sku=?`, [sku]);
      if (rows.length) results.push({ label:t.label, table:t.table, rows });
    }

    res.render("skuManagement", { sku, results, message:"", error:"" });
  } catch (err) {
    console.error("GET /sku-management:", err);
    res.status(500).send("Server error");
  }
});

/* ---------- SKU-Management (POST) ----------------------------------- */
router.post("/sku-management/update", isAuthenticated, isOperator, async (req, res) => {
  try {
    const { oldSku, newSku } = req.body;
    if (!oldSku || !newSku) return res.status(400).json({ error:"Both oldSku and newSku are required." });
    if (oldSku.trim() === newSku.trim()) return res.status(400).json({ error:"Old and new SKU cannot be same." });

    const tables = [
      "cutting_lots","stitching_data","jeans_assembly_data",
      "washing_data","washing_in_data","finishing_data","rewash_requests"
    ];
    let total = 0;
    for (const t of tables) {
      const [r] = await pool.query(`UPDATE ${t} SET sku=? WHERE sku=?`, [newSku.trim(), oldSku.trim()]);
      total += r.affectedRows;
    }
    res.json({ message:`SKU changed from "${oldSku}" to "${newSku}" (${total} rows updated)` });
  } catch (err) {
    console.error("POST /sku-management/update:", err);
    res.status(500).json({ error:"Server error" });
  }
});

/* =====================================================================*/
module.exports = router;
