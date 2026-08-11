/**
 * Lot Viewer — read-only, mobile-first lot flow dashboard for the
 * `lotviewers` role (admins allowed for support). No mutations, no export.
 * Spec: docs/superpowers/specs/2026-08-12-lot-viewer-dashboard-design.md
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const {
  resolveLot, buildJourney, buildSizeMatrix, recentLots,
} = require('../utils/lotJourneyData');

const guard = [isAuthenticated, allowRoles(['lotviewers', 'admin'])];

router.get('/', ...guard, (req, res) => {
  res.render('lotViewer', { user: req.session.user });
});

router.get('/recent', ...guard, async (req, res) => {
  try {
    const lots = await recentLots(pool, req.query.limit);
    res.json({ ok: true, lots });
  } catch (err) {
    console.error('GET /lot-view/recent error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load recent lots' });
  }
});

router.get('/data', ...guard, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, matches: [], journey: null, sizeMatrix: null });
    const matches = await resolveLot(q);
    if (!matches.length) return res.json({ ok: true, matches: [], journey: null, sizeMatrix: null });
    const [journey, sizeMatrix] = await Promise.all([
      buildJourney(matches[0]),
      buildSizeMatrix(pool, matches[0]),
    ]);
    res.json({
      ok: true, journey, sizeMatrix,
      matches: matches.map((m) => ({
        id: m.id, lot_no: m.lot_no, manual_lot_number: m.manual_lot_number || '', sku: m.sku,
      })),
    });
  } catch (err) {
    console.error('GET /lot-view/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
