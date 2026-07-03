// routes/qcDashboardRoutes.js
//
// QC Dashboard. Mounted at /qc, gated to admin + jitrgp (session-authenticated,
// NOT the token auth the qcpass extension uses). GET /qc/dashboard renders an
// EJS shell that mounts a React island; the island talks to GET /qc/api/passes.
//
// A row in qc_return_passes is one QC pass by user `passed_by`. Product detail
// (sku_code, style_id, size, product_name, tracking_number) is joined from
// qc_return_captures on capture_uid. All pure/DB-free logic lives in
// utils/qcDashboard.js (unit-tested in test/qcDashboard.test.js).

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const { qcAssetTags } = require('../utils/viteManifest');
const {
  buildPassesQuery,
  summarizeByUser,
  rowsToCsv,
} = require('../utils/qcDashboard');

const gate = [isAuthenticated, allowRoles(['admin', 'jitrgp'])];

// ---------------------------------------------------------------------------
// Page shell (React island)
// ---------------------------------------------------------------------------
router.get('/dashboard', gate, (req, res) => {
  try {
    const { jsTag, cssTags } = qcAssetTags();
    res.render('qcDashboard', { user: req.session.user, jsTag, cssTags });
  } catch (err) {
    console.error('Error GET /qc/dashboard (island not built?):', err.message);
    res
      .status(500)
      .send('QC dashboard UI is not built yet. Run: cd frontend && npm install && npm run build:qc');
  }
});

// ---------------------------------------------------------------------------
// JSON / CSV API
// ---------------------------------------------------------------------------
// GET /qc/api/passes?from=&to=&user=&quality=&qc_action=&warehouse=&q=&download=csv
router.get('/api/passes', gate, async (req, res) => {
  try {
    const { sql, params, from, to } = buildPassesQuery({
      from: req.query.from,
      to: req.query.to,
      user: req.query.user,
      quality: req.query.quality,
      qc_action: req.query.qc_action,
      warehouse: req.query.warehouse,
      q: req.query.q,
    });

    const [rows] = await pool.query(sql, params);

    if (req.query.download === 'csv') {
      const csv = rowsToCsv(rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="qc-passes-${from}_${to}.csv"`
      );
      // Prepend a BOM so Excel opens UTF-8 correctly.
      return res.send('﻿' + csv);
    }

    res.json({
      ok: true,
      from,
      to,
      summary: summarizeByUser(rows),
      rows,
    });
  } catch (err) {
    console.error('Error GET /qc/api/passes:', err);
    res.status(500).json({ ok: false, error: 'Failed to load QC passes.' });
  }
});

module.exports = router;
