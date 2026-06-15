/**
 * Approval-correction cascade.
 *
 * Reattributes a lot at a stage from the wrong operator to the right one
 * across the three places an operator is recorded, then writes an audit row.
 * Pure data logic (takes a mysql2 connection) so it can be unit-tested with a
 * stubbed connection and reused by routes/correctStageApproval.js.
 */

// production stage -> tables + the role allowed to operate it
const STAGE_DEFS = {
  stitching:  { label: 'Stitching',      data: 'stitching_data',      ev: 'stitching_events',      evsz: 'stitching_event_sizes',      fk: 'stitching_data_id',      role: 'stitching_master' },
  assembly:   { label: 'Jeans Assembly', data: 'jeans_assembly_data', ev: 'jeans_assembly_events', evsz: 'jeans_assembly_event_sizes', fk: 'jeans_assembly_data_id', role: 'jeans_assembly' },
  washing:    { label: 'Washing',        data: 'washing_data',        ev: 'washing_events',        evsz: 'washing_event_sizes',        fk: 'washing_data_id',        role: 'washing' },
  washing_in: { label: 'Washing In',     data: 'washing_in_data',     ev: 'washing_in_events',     evsz: 'washing_in_event_sizes',     fk: 'washing_in_data_id',     role: 'washing_in' },
  finishing:  { label: 'Finishing',      data: 'finishing_data',      ev: 'finishing_events',      evsz: 'finishing_event_sizes',      fk: 'finishing_data_id',      role: 'finishing' },
};

/**
 * Apply the cascade inside an already-open transaction.
 * @returns {Promise<{eventsMoved:number,dataMoved:number,paymentsMoved:number,paidMoved:number}>}
 */
async function applyCorrection(conn, { stage, cuttingLotId, lotNo, fromUserId, toUserId, toUsername, correctedBy }) {
  const def = STAGE_DEFS[stage];
  if (!def) throw new Error('Invalid stage');

  // 1) event ledger (approve / complete / reject for this lot at this stage)
  const [evRes] = await conn.query(
    `UPDATE ${def.ev} SET operator_id = ? WHERE cutting_lot_id = ? AND operator_id = ?`,
    [toUserId, cuttingLotId, fromUserId]
  );
  // 2) legacy data rows (payee source + downstream dashboards)
  const [dataRes] = await conn.query(
    `UPDATE ${def.data} SET user_id = ? WHERE lot_no = ? AND user_id = ?`,
    [toUserId, lotNo, fromUserId]
  );
  // 3) payments — count the already-paid subset first, then move everything
  const [[payCount]] = await conn.query(
    `SELECT COUNT(*) AS n, SUM(status='paid') AS paid_n
       FROM stage_payments WHERE lot_no = ? AND user_id = ?`,
    [lotNo, fromUserId]
  );
  const [payRes] = await conn.query(
    `UPDATE stage_payments SET user_id = ?, username = ?, updated_at = NOW()
      WHERE lot_no = ? AND user_id = ?`,
    [toUserId, toUsername, lotNo, fromUserId]
  );

  const eventsMoved = evRes.affectedRows || 0;
  const dataMoved = dataRes.affectedRows || 0;
  const paymentsMoved = payRes.affectedRows || 0;
  const paidMoved = Number(payCount && payCount.paid_n) || 0;

  // 4) audit — only when something actually moved
  if (eventsMoved + dataMoved + paymentsMoved > 0) {
    await conn.query(
      `INSERT INTO stage_approval_corrections
         (stage, cutting_lot_id, lot_no, from_user_id, to_user_id, corrected_by,
          events_moved, data_rows_moved, payments_moved, paid_payments_moved, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [stage, cuttingLotId, lotNo, fromUserId, toUserId, correctedBy,
       eventsMoved, dataMoved, paymentsMoved, paidMoved]
    );
  }

  return { eventsMoved, dataMoved, paymentsMoved, paidMoved };
}

module.exports = { STAGE_DEFS, applyCorrection };
