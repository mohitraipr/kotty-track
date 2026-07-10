// Finishing → EasyEcom PO review screen (the approval gate).
// Audience: the FINISHING role (user decision 2026-07-10) — they dispatch, they push.
// The pipeline never writes inventory: it creates a PO; the warehouse GRNs manually.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');
const { buildBatch, reResolveBatch, pushBatch, confirmGrns, pushEnabled, EE_PO_SINCE } = require('../utils/eeDispatchPo');

// GET / — review screen: batches + how many dispatch rows await sweeping.
router.get('/', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const [batches] = await pool.query(
      `SELECT * FROM ee_dispatch_po ORDER BY id DESC LIMIT 40`);
    const ids = batches.map(b => b.id);
    let linesByBatch = {};
    if (ids.length) {
      const [lines] = await pool.query(
        `SELECT * FROM ee_dispatch_po_lines WHERE batch_id IN (?) ORDER BY id`, [ids]);
      for (const l of lines) (linesByBatch[l.batch_id] = linesByBatch[l.batch_id] || []).push(l);
    }
    const [[pending]] = await pool.query(
      `SELECT COUNT(*) AS c, COALESCE(SUM(fd.quantity),0) AS qty
         FROM finishing_dispatches fd
         LEFT JOIN ee_dispatch_po_lines l ON l.dispatch_id = fd.id
        WHERE l.id IS NULL AND LOWER(fd.destination)='warehouse'
          AND fd.created_at >= ?`, [EE_PO_SINCE]);
    res.render('eeDispatchPo', {
      user: req.session.user,
      batches, linesByBatch,
      pendingRows: pending.c, pendingQty: Number(pending.qty),
      pushEnabled: pushEnabled(),
    });
  } catch (err) {
    console.error('ee-po review error:', err);
    res.status(500).send('Could not load the EasyEcom PO screen: ' + err.message);
  }
});

// POST /build — sweep unswept Warehouse dispatches into a new batch.
router.post('/build', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await buildBatch(req.session.user);
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('ee-po build error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /reresolve/:id — retry SKU resolution on a blocked batch.
router.post('/reresolve/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await reResolveBatch(Number(req.params.id));
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /push/:id — create the PO in EasyEcom (flag-gated, draft only).
router.post('/push/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await pushBatch(Number(req.params.id));
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('ee-po push error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /refresh — poll EasyEcom for warehouse GRNs against our pushed POs.
router.post('/refresh', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await confirmGrns();
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
