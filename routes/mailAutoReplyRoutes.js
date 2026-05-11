// Manual trigger + visibility for the mail auto-reply cron.
//
// Endpoints (all admin-only):
//   POST /mail-auto-reply/run               — manually trigger a run
//   GET  /mail-auto-reply/stats             — 7-day status counts (legacy)
//   GET  /mail-auto-reply/runs              — list of recent cron runs
//   GET  /mail-auto-reply/runs/last         — single most-recent run (for dashboards)
//   GET  /mail-auto-reply/needs-attention   — emails sitting in 'initial' with a skip_reason

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAdmin } = require('../middlewares/auth');
const { runMailAutoReply } = require('../utils/mailAutoReplyJob');

router.post('/run', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const result = await runMailAutoReply({
      triggeredBy: 'manual',
      userId: req.session?.user?.id || null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/stats', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        SUM(status='initial') AS initial,
        SUM(status='proceeding') AS proceeding,
        SUM(status='replied') AS replied,
        SUM(status='error') AS error_,
        MAX(updated_at) AS last_update
      FROM mail_replies
      WHERE created_at > NOW() - INTERVAL 7 DAY
    `);
    // Skip-reason breakdown for the same window — answers "why are emails
    // sitting in initial?"
    const [reasons] = await pool.query(`
      SELECT skip_reason, COUNT(*) AS n
      FROM mail_replies
      WHERE status = 'initial'
        AND created_at > NOW() - INTERVAL 7 DAY
        AND skip_reason IS NOT NULL
      GROUP BY skip_reason
      ORDER BY n DESC
    `);
    res.json({ ok: true, last_7_days: counts, skip_reasons: reasons });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Recent cron / manual runs — newest first.
router.get('/runs', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
    const [runs] = await pool.query(
      `SELECT id, started_at, finished_at, triggered_by, triggered_user_id,
              fetched, processed, replied, errors,
              skipped_own, skipped_already_replied,
              skipped_no_order_id, skipped_no_awb, skipped_no_video,
              duration_ms, error_message
       FROM mail_reply_runs
       ORDER BY started_at DESC
       LIMIT ?`,
      [limit]
    );
    res.json({ ok: true, runs });
  } catch (err) {
    // table missing? return empty list rather than 500 — dashboards can
    // still render. Migration message tells the caller what to do.
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({
        ok: true, runs: [],
        warning: 'mail_reply_runs table missing — run sql/mail_reply_visibility.sql',
      });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Single most-recent run — handy for a "last run" dashboard card.
router.get('/runs/last', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [[run]] = await pool.query(
      `SELECT id, started_at, finished_at, triggered_by, triggered_user_id,
              fetched, processed, replied, errors,
              skipped_own, skipped_already_replied,
              skipped_no_order_id, skipped_no_awb, skipped_no_video,
              duration_ms, error_message
       FROM mail_reply_runs
       ORDER BY started_at DESC
       LIMIT 1`
    );
    res.json({ ok: true, run: run || null });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: true, run: null, warning: 'mail_reply_runs table missing' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Emails that didn't get auto-replied and need a human to look at them.
// Filter by skip_reason. Newest first. Returns the most actionable info
// per row so the operator can decide what to do (paste in an order #,
// upload an AWB sheet, mark as ignore).
router.get('/needs-attention', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const reason = req.query.reason || null;
    const allowed = new Set([
      'no_order_id', 'no_awb', 'no_video', 'already_replied',
      'not_target_class', 'our_own', 'error',
    ]);
    if (reason && !allowed.has(reason)) {
      return res.status(400).json({ ok: false, error: 'Invalid reason' });
    }

    const params = [];
    let filter = `status = 'initial' AND skip_reason IS NOT NULL`;
    if (reason) { filter += ' AND skip_reason = ?'; params.push(reason); }
    params.push(limit);

    const [rows] = await pool.query(
      `SELECT id, message_id, thread_id, from_address, to_address,
              subject, order_id, awb, status, classification,
              skip_reason, run_id, created_at, updated_at
       FROM mail_replies
       WHERE ${filter}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
