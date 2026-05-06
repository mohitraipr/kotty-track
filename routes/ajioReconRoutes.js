// Manual trigger + status endpoint for the Ajio shipment reconciliation cron.
// Useful for testing without waiting 30 min, and for ops visibility.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAdmin } = require('../middlewares/auth');
const { syncAjioShipments, debugFetchOnce } = require('../utils/ajioShipmentSync');

router.post('/run', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const lookbackDays = Math.min(parseInt(req.body?.lookbackDays || '7', 10), 30);
    const result = await syncAjioShipments({ lookbackDays });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Manual Ajio recon failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/stats', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        COUNT(*) AS total_shipments,
        SUM(source = 'webhook')   AS from_webhook,
        SUM(source = 'reconcile') AS from_reconcile,
        SUM(label_printed_at IS NOT NULL) AS label_printed,
        SUM(dispatched_at IS NOT NULL) AS dispatched,
        SUM(delivered_at IS NOT NULL) AS delivered,
        MAX(updated_at) AS last_update
      FROM ee_shipments
      WHERE marketplace LIKE '%ajio%'
    `);
    res.json({ ok: true, stats: counts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug: hit EasyEcom once with several candidate URLs and dump the raw
// response shape. Use this to figure out the right endpoint for the tenant.
router.post('/debug', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const out = await debugFetchOnce(req.body || {});
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
