/**
 * Operator-driven approval correction.
 *
 * The create→approve flow lost its "assign" step, so anyone can approve a lot
 * onto themselves (e.g. lot UM416 was meant for Salman but Salim approved it).
 * A floor supervisor (role `operator`) uses this tool to reattribute a lot at
 * a stage from the wrong operator to the right one. The fix cascades across
 * the THREE places an operator is recorded so production AND pay both follow:
 *   1. <stage>_events.operator_id   (approve/complete/reject — the ledger)
 *   2. legacy <stage>_data.user_id  (payee source + downstream dashboards)
 *   3. stage_payments.user_id/username (incl. already-PAID rows)
 * Every correction is written to stage_approval_corrections for accountants.
 *
 * Mounted under /operator (isOperator). Masters cannot reach it, so the
 * "approve onto myself" mistake can be undone but not freely re-done.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = multer();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const { STAGE_DEFS, applyCorrection } = require('../utils/approvalCorrection');

// Resolve a lot by its lot_no OR manual_lot_number (case-insensitive).
async function resolveLot(conn, lotStr) {
  const q = String(lotStr || '').trim();
  if (!q) return null;
  const [[row]] = await conn.query(
    `SELECT id, lot_no, manual_lot_number, sku
       FROM cutting_lots
      WHERE lot_no = ? OR manual_lot_number = ?
      ORDER BY (lot_no = ?) DESC
      LIMIT 1`,
    [q, q, q]
  );
  return row || null;
}

// Active users who hold the role for a stage (candidate target operators).
async function operatorsForRole(conn, roleName) {
  const [rows] = await conn.query(
    `SELECT u.id, u.username
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = ? AND u.is_active = 1
      ORDER BY u.username`,
    [roleName]
  );
  return rows;
}

// GET /operator/correct-approval
router.get('/correct-approval', isAuthenticated, isOperator, (req, res) => {
  res.render('correctStageApproval', {
    user: req.session.user,
    stages: Object.entries(STAGE_DEFS).map(([key, d]) => ({ key, label: d.label })),
  });
});

// GET /operator/correct-approval/lookup?stage=&lot=
// Returns the lot, the operator(s) currently attributed at the stage (with
// piece counts), and the list of valid target operators for the stage.
router.get('/correct-approval/lookup', isAuthenticated, isOperator, async (req, res) => {
  const stage = String(req.query.stage || '');
  const def = STAGE_DEFS[stage];
  if (!def) return res.status(400).json({ error: 'Invalid stage' });
  let conn;
  try {
    conn = await pool.getConnection();
    const lot = await resolveLot(conn, req.query.lot);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });

    // Operators attributed via the event ledger (completed pieces).
    const [evOps] = await conn.query(
      `SELECT e.operator_id AS user_id, u.username,
              COALESCE(SUM(CASE WHEN e.event_type='complete' THEN e.pieces END),0) AS completed,
              COALESCE(SUM(CASE WHEN e.event_type='approve'  THEN e.pieces END),0) AS approved
         FROM ${def.ev} e JOIN users u ON u.id = e.operator_id
        WHERE e.cutting_lot_id = ?
        GROUP BY e.operator_id, u.username`,
      [lot.id]
    );
    // Operators attributed via the legacy data rows.
    const [dataOps] = await conn.query(
      `SELECT d.user_id, u.username, COALESCE(SUM(d.total_pieces),0) AS data_pieces, COUNT(*) AS rows_n
         FROM ${def.data} d JOIN users u ON u.id = d.user_id
        WHERE d.lot_no = ?
        GROUP BY d.user_id, u.username`,
      [lot.lot_no]
    );
    // Merge the two views by user.
    const merged = new Map();
    for (const r of evOps) merged.set(r.user_id, { user_id: r.user_id, username: r.username, completed: Number(r.completed), approved: Number(r.approved), data_pieces: 0, data_rows: 0 });
    for (const r of dataOps) {
      const m = merged.get(r.user_id) || { user_id: r.user_id, username: r.username, completed: 0, approved: 0 };
      m.data_pieces = Number(r.data_pieces); m.data_rows = Number(r.rows_n);
      merged.set(r.user_id, m);
    }

    // Payments currently attributed to each of those users for this lot.
    const userIds = [...merged.keys()];
    if (userIds.length) {
      const [pays] = await conn.query(
        `SELECT user_id,
                COUNT(*) AS n,
                SUM(status='paid') AS paid_n,
                COALESCE(SUM(total_amount),0) AS amount
           FROM stage_payments WHERE lot_no = ? AND user_id IN (?)
          GROUP BY user_id`,
        [lot.lot_no, userIds]
      );
      const pmap = new Map(pays.map(p => [p.user_id, p]));
      for (const [uid, m] of merged) {
        const p = pmap.get(uid);
        m.payments = p ? Number(p.n) : 0;
        m.paid_payments = p ? Number(p.paid_n) : 0;
        m.payment_amount = p ? Number(p.amount) : 0;
      }
    }

    const targets = await operatorsForRole(conn, def.role);
    res.json({
      lot: { cutting_lot_id: lot.id, lot_no: lot.lot_no, display_lot: lot.manual_lot_number || lot.lot_no, sku: lot.sku },
      stage, stage_label: def.label, role: def.role,
      current: [...merged.values()],
      targets,
    });
  } catch (err) {
    console.error('[ERROR] GET /operator/correct-approval/lookup =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// POST /operator/correct-approval/update
// Body: { stage, cutting_lot_id, from_user_id, to_user_id }
router.post('/correct-approval/update', isAuthenticated, isOperator, upload.none(), async (req, res) => {
  const stage = String(req.body.stage || '');
  const def = STAGE_DEFS[stage];
  const cuttingLotId = parseInt(req.body.cutting_lot_id, 10);
  const fromUserId = parseInt(req.body.from_user_id, 10);
  const toUserId = parseInt(req.body.to_user_id, 10);
  const correctedBy = req.session.user.id;

  if (!def) return res.status(400).json({ error: 'Invalid stage' });
  if (!Number.isFinite(cuttingLotId) || !Number.isFinite(fromUserId) || !Number.isFinite(toUserId)) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }
  if (fromUserId === toUserId) return res.status(400).json({ error: 'From and To operator are the same' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[lot]] = await conn.query(`SELECT id, lot_no FROM cutting_lots WHERE id = ? FOR UPDATE`, [cuttingLotId]);
    if (!lot) { await conn.rollback(); return res.status(404).json({ error: 'Lot not found' }); }

    // Validate the target operator holds the correct role for this stage.
    const [[toUser]] = await conn.query(
      `SELECT u.id, u.username, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.id = ? AND u.is_active = 1`,
      [toUserId]
    );
    if (!toUser) { await conn.rollback(); return res.status(400).json({ error: 'Target operator not found or inactive' }); }
    if (toUser.role !== def.role) {
      await conn.rollback();
      return res.status(400).json({ error: `Target operator is a '${toUser.role}', not a '${def.role}' — cannot own a ${def.label} lot` });
    }

    const moved = await applyCorrection(conn, {
      stage, cuttingLotId, lotNo: lot.lot_no,
      fromUserId, toUserId, toUsername: toUser.username, correctedBy,
    });

    if (moved.eventsMoved + moved.dataMoved + moved.paymentsMoved === 0) {
      await conn.rollback();
      return res.status(400).json({ error: 'Nothing to correct: that operator has no events, data, or payments for this lot at this stage.' });
    }

    await conn.commit();
    res.json({
      success: true,
      lot_no: lot.lot_no,
      moved: { events: moved.eventsMoved, data_rows: moved.dataMoved, payments: moved.paymentsMoved, paid_payments: moved.paidMoved },
      to_username: toUser.username,
    });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[ERROR] POST /operator/correct-approval/update =>', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

module.exports = router;
