/**
 * Operator "Lot Admin" — search a lot and perform guarded interventions:
 *   #2 change denim/hosiery flow_type  (only while the lot hasn't progressed past stitching)
 *   #3 reverse a lot to its previous stage  (added later)
 *   #4 edit per-size quantities            (added later)
 * Every intervention is written to pm_lot_audit_log (utils/lotAudit) so the full history is
 * reconstructable. Operator-gated.
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const { EVENT_TABLE } = require('../utils/lotStageUsers');
const stageEvents = require('../utils/stageEvents');
const { canChangeFlow } = require('../utils/lotFlowChange');
const { reversibleStage, payStageFor, effectiveFlow } = require('../utils/stageReversal');
const { writeLotAudit } = require('../utils/lotAudit');

// Whether the lot's furthest stage can be reversed, and why not. Blocks on: nothing to
// reverse, finishing already dispatched, or a hand-off payment already PAID.
async function reversalInfo(db, lot) {
  const counts = await eventCounts(db, lot.id);
  // Use the EFFECTIVE flow: a null-flow lot with denim-only stage events is denim, so the
  // furthest stage (and the payment to void) is identified correctly.
  const flow = effectiveFlow(lot.flow_type, counts);
  const rev = reversibleStage(flow, counts);
  if (!rev) return { reversible: false, reason: 'This lot is only cut — nothing to reverse.' };
  if (rev.stage === 'finishing') {
    const [[d]] = await db.query('SELECT COUNT(*) AS c FROM finishing_dispatches WHERE lot_no = ?', [lot.lot_no]);
    if (Number(d.c) > 0) return { reversible: false, stage: rev.stage, label: rev.label, reason: 'Finishing has already been dispatched — the goods have shipped, so it can\'t be reversed.' };
  }
  const payStage = payStageFor(rev.stage, flow);
  if (payStage) {
    const [[p]] = await db.query(`SELECT COUNT(*) AS c FROM stage_payments WHERE lot_no = ? AND stage = ? AND status = 'paid'`, [lot.lot_no, payStage]);
    if (Number(p.c) > 0) return { reversible: false, stage: rev.stage, label: rev.label, reason: `A ${payStage} worker was already PAID for this hand-off — get that payment un-paid before reversing.` };
  }
  return { reversible: true, stage: rev.stage, label: rev.label, pay_stage: payStage };
}

async function resolveLot(q) {
  const exact = q.trim();
  const like = `%${exact}%`;
  const [rows] = await pool.query(
    `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.sku, cl.total_pieces, cl.flow_type,
            cl.created_at, u.username AS cutter_name
       FROM cutting_lots cl LEFT JOIN users u ON u.id = cl.user_id
      WHERE cl.lot_no = ? OR cl.manual_lot_number = ?
            OR cl.lot_no LIKE ? OR cl.manual_lot_number LIKE ? OR cl.sku LIKE ?
   ORDER BY (cl.lot_no = ?) DESC, (cl.manual_lot_number = ?) DESC, cl.created_at DESC
      LIMIT 25`,
    [exact, exact, like, like, like, exact, exact]
  );
  return rows;
}

// Per-size cut quantities + the floor each can't be reduced below (what stitching already
// approved from that size — reducing below it would corrupt the downstream pool).
async function cutSizesWithFloor(db, lotId) {
  const [cutSizes] = await db.query(
    'SELECT id, size_label, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ? ORDER BY id',
    [lotId]
  );
  let stitch = {};
  try { stitch = await stageEvents.getStageSizeAggregates(db, 'stitching', lotId); } catch (_) { stitch = {}; }
  return cutSizes.map((s) => {
    const key = stageEvents.normalizeSizeLabel(s.size_label);
    return {
      id: s.id,
      size_label: s.size_label,
      total_pieces: Number(s.total_pieces) || 0,
      floor: (stitch[key] && stitch[key].approved) || 0,
    };
  });
}

async function eventCounts(db, lotId) {
  const counts = {};
  for (const [stage, table] of Object.entries(EVENT_TABLE)) {
    try {
      const [[r]] = await db.query(`SELECT COUNT(*) AS c FROM \`${table}\` WHERE cutting_lot_id = ?`, [lotId]);
      counts[stage] = Number(r.c) || 0;
    } catch (_) { counts[stage] = 0; }
  }
  return counts;
}

router.get('/', isAuthenticated, isOperator, (req, res) => res.render('lotAdmin', { user: req.session.user }));

// GET /operator/lot-admin/lot?q=... -> best-match lot + its per-stage event counts + eligibility.
router.get('/lot', isAuthenticated, isOperator, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: false, error: 'Enter a lot number or SKU.' });
    const rows = await resolveLot(q);
    if (!rows.length) return res.json({ ok: false, error: 'No matching lot found.' });
    const lot = rows[0];
    const counts = await eventCounts(pool, lot.id);
    res.json({
      ok: true,
      lot: {
        id: lot.id, lot_no: lot.lot_no, manual_lot_number: lot.manual_lot_number,
        sku: lot.sku, total_pieces: lot.total_pieces, flow_type: lot.flow_type || null,
        cutter_name: lot.cutter_name || null,
      },
      event_counts: counts,
      flow_change: canChangeFlow(counts),
      reversal: await reversalInfo(pool, lot),
      sizes: await cutSizesWithFloor(pool, lot.id),
      matches: rows.length,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /operator/lot-admin/flow-change  { cutting_lot_id, flow_type }
router.post('/flow-change', isAuthenticated, isOperator, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const lotId = parseInt(req.body.cutting_lot_id, 10);
    const target = String(req.body.flow_type || '').toLowerCase();
    if (!lotId || (target !== 'denim' && target !== 'hosiery')) {
      return res.status(400).json({ ok: false, error: 'A lot and flow_type (denim|hosiery) are required.' });
    }
    const [[lot]] = await conn.query('SELECT id, lot_no, flow_type FROM cutting_lots WHERE id = ?', [lotId]);
    if (!lot) return res.status(404).json({ ok: false, error: 'Lot not found.' });
    if ((lot.flow_type || '').toLowerCase() === target) {
      return res.json({ ok: true, unchanged: true, message: `Lot is already ${target}.` });
    }
    // Guard: only safe while the lot hasn't diverged (no events past stitching).
    const counts = await eventCounts(conn, lotId);
    const guard = canChangeFlow(counts);
    if (!guard.ok) return res.status(409).json({ ok: false, error: guard.reason, blockedStages: guard.blockedStages });

    await conn.beginTransaction();
    await conn.query('UPDATE cutting_lots SET flow_type = ? WHERE id = ?', [target, lotId]);
    await writeLotAudit(conn, {
      cutting_lot_id: lotId, lot_no: lot.lot_no, action: 'flow_change',
      detail: { from: lot.flow_type || null, to: target, event_counts: counts },
      performed_by: req.session?.user?.id || null,
      performed_by_name: req.session?.user?.username || null,
    });
    await conn.commit();
    res.json({ ok: true, from: lot.flow_type || null, to: target });
  } catch (err) {
    await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// POST /operator/lot-admin/reverse-stage  { cutting_lot_id }
// Reverses the lot's furthest-along stage: deletes that stage's events (children first, due to
// the parent_event_id FK), voids the pending hand-off payment, and snapshots everything to the
// audit log. The upstream "available" pool re-opens automatically (it's derived). Blocks if the
// stage is dispatched or its hand-off payment was already paid.
router.post('/reverse-stage', isAuthenticated, isOperator, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const lotId = parseInt(req.body.cutting_lot_id, 10);
    if (!lotId) return res.status(400).json({ ok: false, error: 'A lot is required.' });
    const [[lot]] = await conn.query('SELECT id, lot_no, flow_type FROM cutting_lots WHERE id = ?', [lotId]);
    if (!lot) return res.status(404).json({ ok: false, error: 'Lot not found.' });

    const info = await reversalInfo(conn, lot);
    if (!info.reversible) return res.status(409).json({ ok: false, error: info.reason });
    const stage = info.stage;
    const table = EVENT_TABLE[stage];
    const payStage = info.pay_stage;

    // Snapshot BEFORE deleting, for the audit trail.
    const [events] = await conn.query(
      `SELECT id, event_type, pieces, operator_id, parent_event_id, created_at FROM \`${table}\` WHERE cutting_lot_id = ? ORDER BY id`,
      [lotId]
    );
    let pendingPayments = [];
    if (payStage) {
      const [pp] = await conn.query(
        `SELECT id, username, stage, qty, total_amount FROM stage_payments WHERE lot_no = ? AND stage = ? AND status = 'pending'`,
        [lot.lot_no, payStage]
      );
      pendingPayments = pp;
    }

    await conn.beginTransaction();
    // Children (complete/inline-reject, parent_event_id NOT NULL) first — the FK forbids
    // deleting a parent approve while a child references it. *_event_sizes cascade on delete.
    await conn.query(`DELETE FROM \`${table}\` WHERE cutting_lot_id = ? AND parent_event_id IS NOT NULL`, [lotId]);
    await conn.query(`DELETE FROM \`${table}\` WHERE cutting_lot_id = ? AND parent_event_id IS NULL`, [lotId]);
    let voided = 0;
    if (payStage) {
      const [r] = await conn.query(
        `UPDATE stage_payments SET status = 'cancelled', updated_at = NOW() WHERE lot_no = ? AND stage = ? AND status = 'pending'`,
        [lot.lot_no, payStage]
      );
      voided = r.affectedRows || 0;
    }
    await writeLotAudit(conn, {
      cutting_lot_id: lotId, lot_no: lot.lot_no, action: 'stage_reversal',
      detail: { reversed_stage: stage, flow: lot.flow_type || null, pay_stage: payStage,
        deleted_events: events, voided_payments: pendingPayments },
      performed_by: req.session?.user?.id || null,
      performed_by_name: req.session?.user?.username || null,
    });
    await conn.commit();
    res.json({ ok: true, reversed_stage: stage, deleted_events: events.length, voided_payments: voided });
  } catch (err) {
    await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

// POST /operator/lot-admin/qty-edit  { cutting_lot_id, sizes: [{ size_label, total_pieces }] }
// Edit the lot's per-size CUT quantities. Guarded so a size can't drop below what stitching
// already approved (which would corrupt the downstream pool). Recomputes the lot total and
// writes a before/after audit row.
router.post('/qty-edit', isAuthenticated, isOperator, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const lotId = parseInt(req.body.cutting_lot_id, 10);
    const edits = Array.isArray(req.body.sizes) ? req.body.sizes : [];
    if (!lotId || !edits.length) return res.status(400).json({ ok: false, error: 'A lot and sizes are required.' });
    const [[lot]] = await conn.query('SELECT id, lot_no FROM cutting_lots WHERE id = ?', [lotId]);
    if (!lot) return res.status(404).json({ ok: false, error: 'Lot not found.' });

    const rows = await cutSizesWithFloor(conn, lotId);
    const byLabel = new Map(rows.map((r) => [String(r.size_label).toUpperCase(), r]));
    const applied = [];
    for (const e of edits) {
      const row = byLabel.get(String(e.size_label || '').toUpperCase());
      if (!row) return res.status(400).json({ ok: false, error: `Unknown size ${e.size_label}.` });
      const to = Math.round(Number(e.total_pieces));
      if (!Number.isFinite(to) || to < 0) return res.status(400).json({ ok: false, error: `Invalid quantity for ${row.size_label}.` });
      if (to < row.floor) return res.status(409).json({ ok: false, error: `${row.size_label}: can't go below ${row.floor} — stitching already took that many pieces.` });
      applied.push({ id: row.id, size_label: row.size_label, from: row.total_pieces, to });
    }
    const changed = applied.filter((a) => a.from !== a.to);
    if (!changed.length) return res.json({ ok: true, changes: 0, message: 'No changes.' });

    await conn.beginTransaction();
    for (const a of changed) {
      await conn.query('UPDATE cutting_lot_sizes SET total_pieces = ? WHERE id = ? AND cutting_lot_id = ?', [a.to, a.id, lotId]);
    }
    const [[sum]] = await conn.query('SELECT COALESCE(SUM(total_pieces),0) AS t FROM cutting_lot_sizes WHERE cutting_lot_id = ?', [lotId]);
    await conn.query('UPDATE cutting_lots SET total_pieces = ? WHERE id = ?', [sum.t, lotId]);
    await writeLotAudit(conn, {
      cutting_lot_id: lotId, lot_no: lot.lot_no, action: 'qty_edit',
      detail: { scope: 'cutting_lot_sizes', changes: changed, new_total: Number(sum.t) },
      performed_by: req.session?.user?.id || null,
      performed_by_name: req.session?.user?.username || null,
    });
    await conn.commit();
    res.json({ ok: true, changes: changed.length, new_total: Number(sum.t) });
  } catch (err) {
    await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    conn.release();
  }
});

module.exports = router;
