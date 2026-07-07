// Append a row to pm_lot_audit_log (the generic operator-intervention trail). Best-effort:
// a logging failure must never abort the operation it's recording, but callers that need the
// audit to be part of the same transaction can pass the transaction connection as `db`.
async function writeLotAudit(db, { cutting_lot_id, lot_no, action, detail, performed_by, performed_by_name }) {
  try {
    await db.query(
      `INSERT INTO pm_lot_audit_log
         (cutting_lot_id, lot_no, action, detail, performed_by, performed_by_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        cutting_lot_id || null,
        lot_no || null,
        String(action),
        detail == null ? null : JSON.stringify(detail),
        performed_by || null,
        performed_by_name || null,
      ]
    );
  } catch (err) {
    console.error('[lotAudit] write failed:', err.message);
  }
}

module.exports = { writeLotAudit };
