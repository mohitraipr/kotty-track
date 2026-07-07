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
const { canChangeFlow } = require('../utils/lotFlowChange');
const { writeLotAudit } = require('../utils/lotAudit');

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

module.exports = router;
