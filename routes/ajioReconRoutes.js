// Ajio shipment reconciliation: dashboard + manual trigger + status.
// Access: any operator (was admin).

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');
const { syncAjioShipments, debugFetchOnce } = require('../utils/ajioShipmentSync');

// Single in-memory job state. The cron is module-scope and Cloud Run
// scales to multiple instances, so a manual run only blocks the instance
// it was started on — that's intentional. We keep it simple.
let job = {
  state: 'idle', // idle | running | done | error | cancelled
  startedAt: null,
  finishedAt: null,
  startedBy: null,
  lookbackDays: null,
  events: [],     // last N progress events
  result: null,   // { tookMs, results }
  error: null,
  cancelRequested: false,
};

const MAX_EVENTS = 500;
function pushEvent(e) {
  job.events.push({ ...e, t: Date.now() });
  if (job.events.length > MAX_EVENTS) job.events = job.events.slice(-MAX_EVENTS);
}

async function runJob({ lookbackDays, startedBy }) {
  if (job.state === 'running') return { ok: false, error: 'already_running' };
  job = {
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    startedBy,
    lookbackDays,
    events: [],
    result: null,
    error: null,
    cancelRequested: false,
  };
  pushEvent({ kind: 'job_start', lookbackDays, startedBy });
  // fire-and-forget
  syncAjioShipments({
    lookbackDays,
    onProgress: pushEvent,
    shouldCancel: () => job.cancelRequested,
  })
    .then((result) => {
      job.state = result.cancelled ? 'cancelled' : 'done';
      job.finishedAt = Date.now();
      job.result = result;
    })
    .catch((err) => {
      job.state = 'error';
      job.finishedAt = Date.now();
      job.error = err.message;
      pushEvent({ kind: 'job_error', error: err.message });
    });
  return { ok: true };
}

// ---------- UI ----------
router.get('/', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [[summary]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(source = 'webhook')   AS from_webhook,
        SUM(source = 'reconcile') AS from_reconcile,
        SUM(label_printed_at IS NOT NULL) AS label_printed,
        SUM(dispatched_at IS NOT NULL)    AS dispatched,
        SUM(delivered_at IS NOT NULL)     AS delivered,
        SUM(rto_at IS NOT NULL)           AS rto,
        MAX(updated_at) AS last_update
      FROM ee_shipments
      WHERE marketplace LIKE '%ajio%'
    `);
    const [recent] = await pool.query(`
      SELECT awb, order_id, reference_code, current_status, courier_name,
             warehouse_id, label_printed_at, source, updated_at
      FROM ee_shipments
      WHERE marketplace LIKE '%ajio%'
      ORDER BY updated_at DESC
      LIMIT 20
    `);
    res.render('ajioRecon', { user: req.session.user, summary, recent });
  } catch (err) {
    console.error('Ajio recon dashboard error:', err);
    res.status(500).send('Failed: ' + err.message);
  }
});

// ---------- API ----------
router.post('/run', isAuthenticated, isOperator, async (req, res) => {
  try {
    const lookbackDays = Math.min(parseInt(req.body?.lookbackDays || '7', 10), 90);
    const r = await runJob({ lookbackDays, startedBy: req.session.user?.username || null });
    res.json(r);
  } catch (err) {
    console.error('Manual Ajio recon failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/cancel', isAuthenticated, isOperator, (req, res) => {
  if (job.state !== 'running') {
    return res.json({ ok: false, error: `not_running (state=${job.state})` });
  }
  job.cancelRequested = true;
  pushEvent({ kind: 'cancel_requested', by: req.session.user?.username || null });
  res.json({ ok: true });
});

router.get('/status', isAuthenticated, isOperator, (req, res) => {
  res.json({
    ok: true,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    startedBy: job.startedBy,
    lookbackDays: job.lookbackDays,
    eventsCount: job.events.length,
    events: job.events.slice(-100),
    result: job.result,
    error: job.error,
  });
});

router.get('/stats', isAuthenticated, isOperator, async (req, res) => {
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

router.get('/recent', isAuthenticated, isOperator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const [rows] = await pool.query(`
      SELECT awb, order_id, reference_code, current_status, courier_name,
             warehouse_id, label_printed_at, dispatched_at, delivered_at,
             source, updated_at
      FROM ee_shipments
      WHERE marketplace LIKE '%ajio%'
      ORDER BY updated_at DESC
      LIMIT ?`, [limit]);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/debug', isAuthenticated, isOperator, async (req, res) => {
  try {
    const out = await debugFetchOnce(req.body || {});
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
