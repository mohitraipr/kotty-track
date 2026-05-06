// Manual trigger + status for the mail auto-reply cron.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAdmin } = require('../middlewares/auth');
const { runMailAutoReply } = require('../utils/mailAutoReplyJob');

router.post('/run', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const result = await runMailAutoReply();
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
    res.json({ ok: true, last_7_days: counts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
