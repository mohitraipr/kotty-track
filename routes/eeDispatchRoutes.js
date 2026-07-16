// Warehouse transfers — status screen for the lot-wise challan pipeline
// (2026-07-16 redesign: one lot = one batch = one PO/challan, created at dispatch).
// Audience: the FINISHING role. This screen is for status, reprints, and fixing
// blocked SKUs — the routine path never needs a button here.
// The pipeline never writes inventory: it creates a PO; the warehouse GRNs manually.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isFinishingMaster } = require('../middlewares/auth');
const { sweepLotBatches, reResolveBatch, resolveLineManually, pushBatch, confirmGrns, pushEnabled, EE_PO_SINCE } = require('../utils/eeDispatchPo');

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
    // For blocked lines: that style's REAL EasyEcom variants, so the finishing user
    // can resolve inline from a dropdown (never free text).
    const blockedStyles = [...new Set(
      Object.values(linesByBatch).flat().filter(l => !l.ee_sku && l.lot_sku).map(l => String(l.lot_sku).toUpperCase())
    )];
    const variantsByStyle = {};
    for (const st of blockedStyles) {
      const [v] = await pool.query(
        `SELECT sku FROM ee_product_master WHERE active=1 AND sku LIKE CONCAT(?, '%') ORDER BY sku LIMIT 40`, [st]);
      variantsByStyle[st] = v.map(r => r.sku);
    }

    res.render('eeDispatchPo', {
      user: req.session.user,
      batches, linesByBatch, variantsByStyle,
      pendingRows: pending.c, pendingQty: Number(pending.qty),
      pushEnabled: pushEnabled(),
    });
  } catch (err) {
    console.error('ee-po review error:', err);
    res.status(500).send('Could not load the EasyEcom PO screen: ' + err.message);
  }
});

// POST /build — sweep any unswept Warehouse dispatches into per-lot batches.
// Fallback only: the dispatch action creates its lot's batch inline, and the
// background job sweeps strays; this button just forces it now.
router.post('/build', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await sweepLotBatches(req.session.user);
    res.json({ success: true, ...out });
  } catch (err) {
    console.error('ee-po sweep error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /challan/:id — the printable lot challan that travels with the goods.
router.get('/challan/:id', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [[batch]] = await pool.query(`SELECT * FROM ee_dispatch_po WHERE id=?`, [id]);
    if (!batch) return res.status(404).send('Challan not found');
    const [lines] = await pool.query(
      `SELECT lot_no, size_label, quantity, lot_sku, ee_sku FROM ee_dispatch_po_lines
        WHERE batch_id=? ORDER BY id`, [id]);
    const lotNo = batch.lot_no || (lines[0] && lines[0].lot_no) || '';
    const [[lot]] = await pool.query(
      `SELECT lot_no, manual_lot_number, sku FROM cutting_lots WHERE lot_no=? LIMIT 1`, [lotNo]);
    res.render('eeChallan', {
      user: req.session.user,
      batch, lines, lot: lot || { lot_no: lotNo, manual_lot_number: '', sku: '' },
      autoPrint: String(req.query.print || '') === '1',
    });
  } catch (err) {
    console.error('ee-po challan error:', err);
    res.status(500).send('Could not load the challan: ' + err.message);
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

// POST /resolve-line — map ONE blocked line to an existing EasyEcom SKU (dropdown-picked).
// Writes only our own tables; nothing is created in EasyEcom.
router.post('/resolve-line', isAuthenticated, isFinishingMaster, async (req, res) => {
  try {
    const out = await resolveLineManually(Number(req.body.line_id), req.body.size_sku, req.session.user);
    res.json({ success: true, ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
