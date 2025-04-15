/**************************************************
 * operatorRoutes.js
 *
 * Advanced Operator Dashboard Backend
 *
 * Corrections:
 *  • Denim chain is now: Cutting → Stitching → Assembly → Washing → Washing In → Finishing
 *  • Non-denim chain is: Cutting → Stitching → Washing In → Finishing
 *  • assigned_on and approved_on are fetched properly from each relevant table
 *  • No day-differences are calculated; we only show assigned_on + approved_on
 **************************************************/

const express = require("express");
const router = express.Router();
const { pool } = require("../config/db");
const { isAuthenticated, isOperator } = require("../middlewares/auth");
const ExcelJS = require("exceljs");

/**************************************************
 * 1) Leftover Calculation Helpers – (unchanged from your code)
 **************************************************/
async function computeAdvancedLeftoversForLot(lot_no, isAkshay) {
  // 1) Check how many pieces were cut
  const [clRows] = await pool.query(
    "SELECT total_pieces FROM cutting_lots WHERE lot_no = ? LIMIT 1",
    [lot_no]
  );
  const totalCut = clRows.length ? parseFloat(clRows[0].total_pieces) || 0 : 0;

  // 2) Sum from stitching, washing, finishing
  let [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumStitched FROM stitching_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalStitched = parseFloat(rows[0].sumStitched) || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumWashed FROM washing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalWashed = parseFloat(rows[0].sumWashed) || 0;

  [rows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumFinished FROM finishing_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalFinished = parseFloat(rows[0].sumFinished) || 0;

  // 3) Check last Stitching Assignment: leftoverStitch
  const [stAssignmentRows] = await pool.query(
    `SELECT isApproved
       FROM stitching_assignments sa
       JOIN cutting_lots c ON sa.cutting_lot_id = c.id
      WHERE c.lot_no = ?
      ORDER BY sa.assigned_on DESC
      LIMIT 1`,
    [lot_no]
  );
  let leftoverStitch;
  if (stAssignmentRows.length) {
    const stAssn = stAssignmentRows[0];
    if (stAssn.isApproved === null) {
      leftoverStitch = "Waiting for approval";
    } else if (stAssn.isApproved == 0) {
      leftoverStitch = "Denied";
    } else {
      leftoverStitch = totalCut - totalStitched;
    }
  } else {
    leftoverStitch = "Not Assigned";
  }

  // 4) leftoverWash, leftoverFinish depends on isAkshay
  let leftoverWash, leftoverFinish;
  if (isAkshay) {
    // if denim (Akshay)
    const [jaRows] = await pool.query(
      "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
      [lot_no]
    );
    const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;

    // leftoverWash depends on washing_assignments
    const [waAssignmentRows] = await pool.query(
      `SELECT is_approved
         FROM washing_assignments wa
         JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
        WHERE jd.lot_no = ?
        ORDER BY wa.assigned_on DESC
        LIMIT 1`,
      [lot_no]
    );
    if (waAssignmentRows.length) {
      const waAssn = waAssignmentRows[0];
      if (waAssn.is_approved === null) {
        leftoverWash = "Waiting for approval";
      } else if (waAssn.is_approved == 0) {
        leftoverWash = "Denied";
      } else {
        leftoverWash = totalJeans - totalWashed;
      }
    } else {
      leftoverWash = "Not Assigned";
    }

    // leftoverFinish depends on finishing_assignments referencing washing_data
    const [faAssignmentRows] = await pool.query(
      `SELECT is_approved
         FROM finishing_assignments fa
         JOIN washing_data wd ON fa.washing_assignment_id = wd.id
        WHERE wd.lot_no = ?
        ORDER BY fa.assigned_on DESC
        LIMIT 1`,
      [lot_no]
    );
    if (faAssignmentRows.length) {
      const faAssn = faAssignmentRows[0];
      if (faAssn.is_approved === null) {
        leftoverFinish = "Waiting for approval";
      } else if (faAssn.is_approved == 0) {
        leftoverFinish = "Denied";
      } else {
        leftoverFinish = totalWashed - totalFinished;
      }
    } else {
      leftoverFinish = "Not Assigned";
    }

  } else {
    // if not denim
    leftoverWash = "N/A";
    const [faAssignmentRows] = await pool.query(
      `SELECT isApproved
         FROM finishing_assignments fa
         JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
        WHERE sd.lot_no = ?
        ORDER BY fa.assigned_on DESC
        LIMIT 1`,
      [lot_no]
    );
    if (faAssignmentRows.length) {
      const faAssn = faAssignmentRows[0];
      if (faAssn.isApproved === null) {
        leftoverFinish = "Waiting for approval";
      } else if (faAssn.isApproved == 0) {
        leftoverFinish = "Denied";
      } else {
        leftoverFinish = totalStitched - totalFinished;
      }
    } else {
      leftoverFinish = "Not Assigned";
    }
  }

  return { leftoverStitch, leftoverWash, leftoverFinish };
}

/**
 * computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay)
 * (for leftover assembly)
 */
async function computeJeansLeftover(lot_no, totalStitchedLocal, isAkshay) {
  if (!isAkshay) return "N/A";
  const [jaAssignRows] = await pool.query(
    `SELECT is_approved
       FROM jeans_assembly_assignments ja
       JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
      WHERE sd.lot_no = ?
      ORDER BY ja.assigned_on DESC
      LIMIT 1`,
    [lot_no]
  );
  if (!jaAssignRows.length) return "Not Assigned";
  const jaAssn = jaAssignRows[0];
  if (jaAssn.is_approved === null) return "Waiting for approval";
  if (jaAssn.is_approved == 0) return "Denied";

  // if approved, leftover = stitchedTotal - assembly
  const [jaRows] = await pool.query(
    "SELECT COALESCE(SUM(total_pieces),0) AS sumJeans FROM jeans_assembly_data WHERE lot_no = ?",
    [lot_no]
  );
  const totalJeans = parseFloat(jaRows[0].sumJeans) || 0;
  return totalStitchedLocal - totalJeans;
}

/**************************************************
 * 2) Operator Performance & Analytics – unchanged
 **************************************************/
async function computeOperatorPerformance() {
  // same code as before
}

async function computeAdvancedAnalytics(startDate, endDate) {
  // same code as before
}

/**************************************************
 * 3) Standard Dashboard Routes & Leftover Exports
 **************************************************/
// e.g. GET /dashboard, GET /dashboard/api/leftovers, etc.
// (unchanged from your existing code)
router.get("/dashboard", isAuthenticated, isOperator, async (req, res) => {
  try {
    // same code as before
    // ...
    return res.render("operatorDashboard", {
      // ...
    });
  } catch (err) {
    console.error("Error loading operator dashboard:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/dashboard/api/leftovers", isAuthenticated, isOperator, async (req, res) => {
  try {
    // same leftover code as you posted
    // ...
  } catch (err) {
    console.error("Error in /dashboard/api/leftovers:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/**************************************************
 * CSV/Excel exports
 **************************************************/
// e.g. GET /dashboard/leftovers/download, /dashboard/lot-tracking/:lot_no/download, etc.
// (unchanged from your code)

/**************************************************
 * 4) Pendency-report routes (stitching, assembly, washing, finishing)
 **************************************************/
// (unchanged from your code – we omit for brevity)
// e.g. /pendency-report/stitching, /pendency-report/assembly, etc.

/**************************************************
 * 5) PIC Report – corrected chain logic
 **************************************************/

/** Quick helper to detect “Denim” by lotNo. */
function isDenimLot(lotNo="") {
  const up = lotNo.toUpperCase();
  return up.startsWith("AK") || up.startsWith("UM");
}

/** Summation helpers – same or reused: getStitchedQty, getAssembledQty, etc. */
async function getStitchedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumStitched
      FROM stitching_data
     WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumStitched) || 0;
}

async function getAssembledQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumAsm
      FROM jeans_assembly_data
     WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumAsm) || 0;
}

async function getWashedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWash
      FROM washing_data
     WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWash) || 0;
}

async function getWashingInQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumWashIn
      FROM washing_in_data
     WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumWashIn) || 0;
}

async function getFinishedQty(lotNo) {
  const [rows] = await pool.query(`
    SELECT COALESCE(SUM(total_pieces),0) AS sumFin
      FROM finishing_data
     WHERE lot_no = ?
  `, [lotNo]);
  return parseFloat(rows[0].sumFin) || 0;
}

/** “Last assignment” fetchers */
async function getLastStitchingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT sa.id, sa.isApproved, sa.assigned_on, sa.approved_on, sa.user_id
      FROM stitching_assignments sa
      JOIN cutting_lots c ON sa.cutting_lot_id = c.id
     WHERE c.lot_no = ?
     ORDER BY sa.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastAssemblyAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT ja.id, ja.is_approved, ja.assigned_on, ja.approved_on, ja.user_id
      FROM jeans_assembly_assignments ja
      JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
     WHERE sd.lot_no = ?
     ORDER BY ja.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastWashingAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT wa.id, wa.is_approved, wa.assigned_on, wa.approved_on, wa.user_id
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
     WHERE jd.lot_no = ?
     ORDER BY wa.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastWashingInAssignment(lotNo) {
  const [rows] = await pool.query(`
    SELECT wia.id, wia.is_approved, wia.assigned_on, wia.approved_on, wia.user_id
      FROM washing_in_assignments wia
      JOIN washing_in_data wid ON wia.washing_data_id = wid.id
     WHERE wid.lot_no = ?
     ORDER BY wia.assigned_on DESC
     LIMIT 1
  `, [lotNo]);
  if (!rows.length) return null;

  const assign = rows[0];
  if (assign.user_id) {
    const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
    assign.opName = u ? u.username : "Unknown";
  }
  return assign;
}

async function getLastFinishingAssignment(lotNo, isDenim) {
  if (isDenim) {
    // finishing assignments joined with washing_data
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
        FROM finishing_assignments fa
        JOIN washing_data wd ON fa.washing_assignment_id = wd.id
       WHERE wd.lot_no = ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;

    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  } else {
    // finishing assignments joined with stitching_data
    const [rows] = await pool.query(`
      SELECT fa.id, fa.is_approved, fa.assigned_on, fa.approved_on, fa.user_id
        FROM finishing_assignments fa
        JOIN stitching_data sd ON fa.stitching_assignment_id = sd.id
       WHERE sd.lot_no = ?
       ORDER BY fa.assigned_on DESC
       LIMIT 1
    `, [lotNo]);
    if (!rows.length) return null;

    const assign = rows[0];
    if (assign.user_id) {
      const [[u]] = await pool.query("SELECT username FROM users WHERE id=?", [assign.user_id]);
      assign.opName = u ? u.username : "Unknown";
    }
    return assign;
  }
}

/**
 * getDepartmentStatuses – The CORRECT chain:
 *   Denim: Cut → Stitching → Assembly → Washing → Washing In → Finishing
 *   Non-denim: Cut → Stitching → Washing In → Finishing
 */
function getDepartmentStatuses({
  isDenim,
  totalCut,
  stitchedQty,
  assembledQty,
  washedQty,
  washingInQty,
  finishedQty,
  stAssign,
  asmAssign,
  washAssign,
  washInAssign,
  finAssign
}) {
  // placeholders
  let stitchingStatus="N/A", stitchingOp="", stitchingAssignedOn="N/A", stitchingApprovedOn="N/A";
  let assemblyStatus= isDenim ? "N/A" : "—", assemblyOp="", assemblyAssignedOn="N/A", assemblyApprovedOn="N/A";
  let washingStatus= isDenim ? "N/A" : "—", washingOp="", washingAssignedOn="N/A", washingApprovedOn="N/A";
  let washingInStatus= "N/A", washingInOp="", washingInAssignedOn="N/A", washingInApprovedOn="N/A";
  let finishingStatus= "N/A", finishingOp="", finishingAssignedOn="N/A", finishingApprovedOn="N/A";

  // 1) STITCHING
  if (!stAssign) {
    stitchingStatus= "In Cutting";
    if (isDenim) {
      assemblyStatus= "In Cutting";
      washingStatus= "In Cutting";
      washingInStatus= "In Cutting";
      finishingStatus= "In Cutting";
    } else {
      washingInStatus= "In Cutting";
      finishingStatus= "In Cutting";
    }
  } else {
    const { isApproved, assigned_on, approved_on, opName } = stAssign;
    stitchingOp = opName || "";
    stitchingAssignedOn = assigned_on ? new Date(assigned_on).toLocaleString() : "N/A";
    stitchingApprovedOn = approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (isApproved === null) {
      stitchingStatus = `Pending Approval by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      }
    } else if (isApproved == 0) {
      stitchingStatus= `Denied by ${stitchingOp}`;
      if (isDenim) {
        assemblyStatus= "In Stitching";
        washingStatus= "In Stitching";
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      } else {
        washingInStatus= "In Stitching";
        finishingStatus= "In Stitching";
      }
    } else {
      // Approved=1
      if (stitchedQty === 0) {
        stitchingStatus= "In-Line";
      } else if (stitchedQty >= totalCut && totalCut>0) {
        stitchingStatus= "Completed";
      } else {
        const pend = totalCut - stitchedQty;
        stitchingStatus= `${pend} Pending`;
      }
    }
  }

  // 2) ASSEMBLY (denim)
  if (isDenim) {
    if (!asmAssign) {
      assemblyStatus= "In Stitching";
      washingStatus= "In Stitching";
      washingInStatus= "In Stitching";
      finishingStatus= "In Stitching";
    } else {
      const { is_approved, assigned_on, approved_on, opName } = asmAssign;
      assemblyOp= opName || "";
      assemblyAssignedOn= assigned_on ? new Date(assigned_on).toLocaleString() : "N/A";
      assemblyApprovedOn= approved_on ? new Date(approved_on).toLocaleString() : "N/A";

      if (is_approved===null) {
        assemblyStatus= `Pending Approval by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
      } else if (is_approved==0) {
        assemblyStatus= `Denied by ${assemblyOp}`;
        washingStatus= "In Assembly";
        washingInStatus= "In Assembly";
        finishingStatus= "In Assembly";
      } else {
        // partial or complete
        if (assembledQty===0) {
          assemblyStatus= "In-Line";
        } else if (assembledQty>=stitchedQty && stitchedQty>0) {
          assemblyStatus= "Completed";
        } else {
          const pend = stitchedQty-assembledQty;
          assemblyStatus= `${pend} Pending`;
        }
      }
    }
  }

  // 3) WASHING (denim)
  if (isDenim) {
    if (!washAssign) {
      washingStatus= "In Assembly";
      washingInStatus= "In Assembly";
      finishingStatus= "In Assembly";
    } else {
      const { is_approved, assigned_on, approved_on, opName } = washAssign;
      washingOp= opName || "";
      washingAssignedOn= assigned_on ? new Date(assigned_on).toLocaleString() : "N/A";
      washingApprovedOn= approved_on ? new Date(approved_on).toLocaleString() : "N/A";

      if (is_approved===null) {
        washingStatus= `Pending Approval by ${washingOp}`;
        washingInStatus= "In Washing";
        finishingStatus= "In Washing";
      } else if (is_approved==0) {
        washingStatus= `Denied by ${washingOp}`;
        washingInStatus= "In Washing";
        finishingStatus= "In Washing";
      } else {
        // partial or complete
        if (washedQty===0) {
          washingStatus= "In-Line";
        } else if (washedQty>=assembledQty && assembledQty>0) {
          washingStatus= "Completed";
        } else {
          const pend = assembledQty-washedQty;
          washingStatus= `${pend} Pending`;
        }
      }
    }
  }

  // 4) WASHING IN (both)
  if (!washInAssign) {
    if (isDenim) {
      washingInStatus= "In Washing";
      finishingStatus= "In Washing";
    } else {
      washingInStatus= "In Stitching";
      finishingStatus= "In Stitching";
    }
  } else {
    const { is_approved, assigned_on, approved_on, opName } = washInAssign;
    washingInOp= opName || "";
    washingInAssignedOn= assigned_on ? new Date(assigned_on).toLocaleString() : "N/A";
    washingInApprovedOn= approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (is_approved===null) {
      washingInStatus= `Pending Approval by ${washingInOp}`;
      finishingStatus= "In WashingIn";
    } else if (is_approved==0) {
      washingInStatus= `Denied by ${washingInOp}`;
      finishingStatus= "In WashingIn";
    } else {
      // partial or complete
      // denim => compare washingInQty vs. washedQty
      // non-denim => compare washingInQty vs. stitchedQty
      const compareQty= isDenim ? washedQty : stitchedQty;
      if (washingInQty===0) {
        washingInStatus= "In-Line";
      } else if (washingInQty>=compareQty && compareQty>0) {
        washingInStatus= "Completed";
      } else {
        const pend = compareQty - washingInQty;
        washingInStatus= `${pend} Pending`;
      }
    }
  }

  // 5) FINISHING
  if (!finAssign) {
    finishingStatus= isDenim ? "In WashingIn" : "In WashingIn";
  } else {
    const { is_approved, assigned_on, approved_on, opName } = finAssign;
    finishingOp= opName || "";
    finishingAssignedOn= assigned_on ? new Date(assigned_on).toLocaleString() : "N/A";
    finishingApprovedOn= approved_on ? new Date(approved_on).toLocaleString() : "N/A";

    if (is_approved===null) {
      finishingStatus= `Pending Approval by ${finishingOp}`;
    } else if (is_approved==0) {
      finishingStatus= `Denied by ${finishingOp}`;
    } else {
      // partial or complete
      // If denim, finishing leftover vs. washingIn
      // If non-denim, finishing leftover vs. washingIn
      const compareQty= washingInQty;
      if (finishedQty===0) {
        finishingStatus= "In-Line";
      } else if (finishedQty>=compareQty && compareQty>0) {
        finishingStatus= "Completed";
      } else {
        const pend = compareQty - finishedQty;
        finishingStatus= `${pend} Pending`;
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

/** filterByDept() – same logic but uses new chain ordering. */
function filterByDept({
  department, isDenim,
  stitchingStatus,
  assemblyStatus,
  washingStatus,
  washingInStatus,
  finishingStatus
}) {
  let showRow = true;
  let actualStatus = "N/A";

  if (department === "all") {
    if (isDenim) {
      // pick finishing if not "N/A", else washingIn, else washing, else assembly, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus= washingInStatus;
      else if (!washingStatus.startsWith("N/A")) actualStatus= washingStatus;
      else if (!assemblyStatus.startsWith("N/A")) actualStatus= assemblyStatus;
      else actualStatus= stitchingStatus;
    } else {
      // non-denim => finishing, else washing_in, else stitching
      if (!finishingStatus.startsWith("N/A")) actualStatus= finishingStatus;
      else if (!washingInStatus.startsWith("N/A")) actualStatus= washingInStatus;
      else actualStatus= stitchingStatus;
    }
    return { showRow, actualStatus };
  }

  if (department==="cutting") {
    // We consider "cutting" always "Completed"
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
    actualStatus= washingInStatus;
    return { showRow, actualStatus };
  }

  if (department==="finishing") {
    actualStatus= finishingStatus;
    return { showRow, actualStatus };
  }

  return { showRow, actualStatus };
}

/** The route for PIC Report, with corrected chain. */
router.get("/dashboard/pic-report", isAuthenticated, isOperator, async (req, res) => {
  try {
    const {
      lotType="all", department="all", status="all",
      dateFilter="createdAt", startDate="", endDate="", download=""
    } = req.query;

    /*************************************
     * Build dateWhere / lotTypeClause
     *************************************/
    let dateWhere = "";
    const dateParams = [];
    if (startDate && endDate) {
      if (dateFilter==="createdAt") {
        dateWhere= " AND DATE(cl.created_at) BETWEEN ? AND ? ";
        dateParams.push(startDate, endDate);
      } else if (dateFilter==="assignedOn") {
        // same logic to filter by assigned_on of the chosen dept
        if (department==="stitching") {
          dateWhere= `
            AND EXISTS (
              SELECT 1
                FROM stitching_assignments sa
                JOIN cutting_lots c2 ON sa.cutting_lot_id = c2.id
               WHERE c2.lot_no= cl.lot_no
                 AND DATE(sa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department==="assembly") {
          dateWhere= `
            AND EXISTS (
              SELECT 1
                FROM jeans_assembly_assignments ja
                JOIN stitching_data sd ON ja.stitching_assignment_id = sd.id
                JOIN cutting_lots c2 ON sd.lot_no = c2.lot_no
               WHERE c2.lot_no= cl.lot_no
                 AND DATE(ja.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department==="washing") {
          dateWhere= `
            AND EXISTS (
              SELECT 1
                FROM washing_assignments wa
                JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
                JOIN cutting_lots c2 ON jd.lot_no = c2.lot_no
               WHERE c2.lot_no= cl.lot_no
                 AND DATE(wa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department==="washing_in") {
          dateWhere= `
            AND EXISTS (
              SELECT 1
                FROM washing_in_assignments wia
                JOIN washing_in_data wid ON wia.washing_data_id = wid.id
                JOIN cutting_lots c2 ON wid.lot_no = c2.lot_no
               WHERE c2.lot_no= cl.lot_no
                 AND DATE(wia.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        } else if (department==="finishing") {
          dateWhere= `
            AND EXISTS (
              SELECT 1
                FROM finishing_assignments fa
                LEFT JOIN washing_data wd ON fa.washing_assignment_id=wd.id
                LEFT JOIN stitching_data sd ON fa.stitching_assignment_id=sd.id
                JOIN cutting_lots c2 ON (wd.lot_no=c2.lot_no OR sd.lot_no=c2.lot_no)
               WHERE c2.lot_no= cl.lot_no
                 AND DATE(fa.assigned_on) BETWEEN ? AND ?
            )
          `;
          dateParams.push(startDate, endDate);
        }
      }
    }

    let lotTypeClause= "";
    if (lotType==="denim") {
      lotTypeClause= `
        AND (
          UPPER(cl.lot_no) LIKE 'AK%'
          OR UPPER(cl.lot_no) LIKE 'UM%'
        )
      `;
    } else if (lotType==="hosiery") {
      lotTypeClause= `
        AND (
          UPPER(cl.lot_no) NOT LIKE 'AK%'
          AND UPPER(cl.lot_no) NOT LIKE 'UM%'
        )
      `;
    }

    /*************************************
     * Query cutting_lots
     *************************************/
    const baseQuery= `
      SELECT cl.lot_no, cl.sku, cl.total_pieces, cl.created_at, cl.remark,
             u.username AS created_by
        FROM cutting_lots cl
        JOIN users u ON cl.user_id= u.id
       WHERE 1=1
         ${lotTypeClause}
         ${dateWhere}
       ORDER BY cl.created_at DESC
    `;
    const [lots] = await pool.query(baseQuery, dateParams);

    /*************************************
     * Build finalData by reading each lot’s chain status
     *************************************/
    const finalData= [];
    for (const lot of lots) {
      const lotNo= lot.lot_no;
      const totalCut= parseFloat(lot.total_pieces)||0;
      const denim= isDenimLot(lotNo);

      // gather sums
      const stitchedQty= await getStitchedQty(lotNo);
      const assembledQty= denim? await getAssembledQty(lotNo): 0;
      const washedQty= denim? await getWashedQty(lotNo): 0;
      const washingInQty= await getWashingInQty(lotNo);
      const finishedQty= await getFinishedQty(lotNo);

      // gather assignment records
      const stAssign= await getLastStitchingAssignment(lotNo);
      const asmAssign= denim? await getLastAssemblyAssignment(lotNo): null;
      const washAssign= denim? await getLastWashingAssignment(lotNo): null;
      const wInAssign= await getLastWashingInAssignment(lotNo);
      const finAssign= await getLastFinishingAssignment(lotNo, denim);

      // compute chain statuses
      const {
        stitchingStatus, stitchingOp, stitchingAssignedOn, stitchingApprovedOn,
        assemblyStatus, assemblyOp, assemblyAssignedOn, assemblyApprovedOn,
        washingStatus, washingOp, washingAssignedOn, washingApprovedOn,
        washingInStatus, washingInOp, washingInAssignedOn, washingInApprovedOn,
        finishingStatus, finishingOp, finishingAssignedOn, finishingApprovedOn
      }= getDepartmentStatuses({
        isDenim: denim,
        totalCut, stitchedQty, assembledQty, washedQty, washingInQty, finishedQty,
        stAssign, asmAssign, washAssign, washInAssign: wInAssign, finAssign
      });

      // filter by dept & status
      const deptResult= filterByDept({
        department, isDenim: denim,
        stitchingStatus, assemblyStatus, washingStatus, washingInStatus, finishingStatus
      });
      if (!deptResult.showRow) continue;

      let actualStatus= deptResult.actualStatus.toLowerCase();
      if (status!=="all") {
        if (status==="not_assigned") {
          if (!actualStatus.startsWith("in ")) continue;
        } else {
          const want= status.toLowerCase();
          if (want==="inline" && actualStatus.includes("in-line")) {
            // pass
          } else if (!actualStatus.includes(want)) {
            continue;
          }
        }
      }

      finalData.push({
        lotNo,
        sku: lot.sku,
        lotType: denim? "Denim": "Hosiery",
        totalCut,
        createdAt: lot.created_at? new Date(lot.created_at).toLocaleDateString(): "",
        remark: lot.remark|| "",

        // STITCH
        stitchAssignedOn: stitchingAssignedOn,
        stitchApprovedOn: stitchingApprovedOn,
        stitchOp: stitchingOp,
        stitchStatus: stitchingStatus,
        stitchedQty,

        // ASSEMBLY
        assemblyAssignedOn,
        assemblyApprovedOn,
        assemblyOp,
        assemblyStatus,
        assembledQty,

        // WASHING
        washingAssignedOn,
        washingApprovedOn,
        washingOp,
        washingStatus,
        washedQty,

        // WASHING IN
        washingInAssignedOn,
        washingInApprovedOn,
        washingInOp,
        washingInStatus,
        washingInQty,

        // FINISHING
        finishingAssignedOn,
        finishingApprovedOn,
        finishingOp,
        finishingStatus,
        finishedQty
      });
    }

    /*************************************
     * If download=1 => export to Excel
     *************************************/
    if (download==="1") {
      const workbook= new ExcelJS.Workbook();
      workbook.creator= "Corrected PIC Report – Denim Chain";
      const sheet= workbook.addWorksheet("PIC-Report");

      sheet.columns= [
        { header: "Lot No", key: "lotNo", width:15 },
        { header: "SKU", key: "sku", width:12 },
        { header: "Lot Type", key: "lotType", width:10 },
        { header: "Total Cut", key: "totalCut", width:10 },
        { header: "Created At", key: "createdAt", width:15 },
        { header: "Remark", key: "remark", width:20 },

        // Stitch
        { header: "Stitch Assigned On", key: "stitchAssignedOn", width:20 },
        { header: "Stitch Approved On", key: "stitchApprovedOn", width:20 },
        { header: "Stitch Operator", key: "stitchOp", width:15 },
        { header: "Stitch Status", key: "stitchStatus", width:25 },
        { header: "Stitched Qty", key: "stitchedQty", width:15 },

        // Assembly
        { header: "Assembly Assigned On", key: "assemblyAssignedOn", width:20 },
        { header: "Assembly Approved On", key: "assemblyApprovedOn", width:20 },
        { header: "Assembly Operator", key: "assemblyOp", width:15 },
        { header: "Assembly Status", key: "assemblyStatus", width:25 },
        { header: "Assembled Qty", key: "assembledQty", width:15 },

        // Washing
        { header: "Washing Assigned On", key: "washingAssignedOn", width:20 },
        { header: "Washing Approved On", key: "washingApprovedOn", width:20 },
        { header: "Washing Operator", key: "washingOp", width:15 },
        { header: "Washing Status", key: "washingStatus", width:25 },
        { header: "Washed Qty", key: "washedQty", width:15 },

        // Washing In
        { header: "WashIn Assigned On", key: "washingInAssignedOn", width:20 },
        { header: "WashIn Approved On", key: "washingInApprovedOn", width:20 },
        { header: "WashIn Operator", key: "washingInOp", width:15 },
        { header: "WashIn Status", key: "washingInStatus", width:25 },
        { header: "WashIn Qty", key: "washingInQty", width:15 },

        // Finishing
        { header: "Finishing Assigned On", key: "finishingAssignedOn", width:20 },
        { header: "Finishing Approved On", key: "finishingApprovedOn", width:20 },
        { header: "Finishing Operator", key: "finishingOp", width:15 },
        { header: "Finishing Status", key: "finishingStatus", width:25 },
        { header: "Finished Qty", key: "finishedQty", width:15 }
      ];

      finalData.forEach(item => {
        sheet.addRow({
          lotNo: item.lotNo,
          sku: item.sku,
          lotType: item.lotType,
          totalCut: item.totalCut,
          createdAt: item.createdAt,
          remark: item.remark,

          stitchAssignedOn: item.stitchAssignedOn,
          stitchApprovedOn: item.stitchApprovedOn,
          stitchOp: item.stitchOp,
          stitchStatus: item.stitchStatus,
          stitchedQty: item.stitchedQty,

          assemblyAssignedOn: item.assemblyAssignedOn,
          assemblyApprovedOn: item.assemblyApprovedOn,
          assemblyOp: item.assemblyOp,
          assemblyStatus: item.assemblyStatus,
          assembledQty: item.assembledQty,

          washingAssignedOn: item.washingAssignedOn,
          washingApprovedOn: item.washingApprovedOn,
          washingOp: item.washingOp,
          washingStatus: item.washingStatus,
          washedQty: item.washedQty,

          washingInAssignedOn: item.washingInAssignedOn,
          washingInApprovedOn: item.washingInApprovedOn,
          washingInOp: item.washingInOp,
          washingInStatus: item.washingInStatus,
          washingInQty: item.washingInQty,

          finishingAssignedOn: item.finishingAssignedOn,
          finishingApprovedOn: item.finishingApprovedOn,
          finishingOp: item.finishingOp,
          finishingStatus: item.finishingStatus,
          finishedQty: item.finishedQty
        });
      });

      res.setHeader("Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition",
        'attachment; filename="PICReportCorrectedChain.xlsx"'
      );
      await workbook.xlsx.write(res);
      res.end();
    } else {
      // Render as HTML
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

module.exports = router;
