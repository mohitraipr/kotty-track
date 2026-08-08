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

// Audit a user-supplied manual date on a stage event (approve/complete). No-op
// when manual_date is null so callers can invoke it unconditionally. Same
// best-effort contract as writeLotAudit; pass the transaction connection so the
// audit row commits (or rolls back) with the events it describes.
async function auditStageManualDate(db, {
  cutting_lot_id, stage, event_type, manual_date, pieces = null,
  approve_event_id = null, complete_event_id = null, reject_event_id = null,
  performed_by, performed_by_name,
}) {
  if (!manual_date) return;
  let lot_no = null;
  try {
    const [[row]] = await db.query('SELECT lot_no FROM cutting_lots WHERE id = ?', [cutting_lot_id]);
    if (row) lot_no = row.lot_no;
  } catch (_) { /* lot_no is nice-to-have; cutting_lot_id is the real key */ }
  const detail = { stage, event_type, manual_date };
  if (pieces != null) detail.pieces = pieces;
  if (approve_event_id != null) detail.approve_event_id = approve_event_id;
  if (complete_event_id != null) detail.complete_event_id = complete_event_id;
  if (reject_event_id != null) detail.reject_event_id = reject_event_id;
  await writeLotAudit(db, {
    cutting_lot_id, lot_no, action: 'manual_date', detail, performed_by, performed_by_name,
  });
}

module.exports = { writeLotAudit, auditStageManualDate };
