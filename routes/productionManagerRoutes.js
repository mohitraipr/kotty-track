// routes/productionManagerRoutes.js
//
// Production Manager dashboard — cutting recommendations, dead stock,
// open WIP lots, marketplace PO uploads, and per-style config.
// See ~/.claude/plans/if-i-wanted-you-fuzzy-galaxy.md.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const analytics = require('../utils/easyecomAnalytics');
let pullWorker = null;
try { pullWorker = require('../utils/easyecomPullWorker'); } catch (_) { pullWorker = null; }

router.use(isAuthenticated, allowRoles(['admin', 'production_manager']));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ─── Helpers ──────────────────────────────────────────────────────────

function safeCall(fnName, ...args) {
  const fn = analytics && analytics[fnName];
  if (typeof fn !== 'function') {
    const err = new Error(`analytics.${fnName} not available yet`);
    err.code = 'ANALYTICS_MISSING';
    throw err;
  }
  return fn(...args);
}

function aggregateStyles(rows) {
  const byStyle = new Map();
  for (const r of rows || []) {
    const key = r.style || '(unknown)';
    let agg = byStyle.get(key);
    if (!agg) {
      agg = {
        style: key,
        total_soh: 0,
        drr_sum: 0,
        size_count: 0,
        worst_size_doh: null,
        sizes_below_lt: 0,
        open_lot_qty: 0,
        upcoming_po_qty: 0,
        suggested_cut_qty: 0,
        any_red: false,
        any_amber: false,
        warming_up: false,
      };
      byStyle.set(key, agg);
    }
    agg.total_soh       += Number(r.soh || 0);
    agg.drr_sum         += Number(r.drr || 0);
    agg.size_count      += 1;
    agg.open_lot_qty    += Number(r.open_lot_qty || 0);
    agg.upcoming_po_qty += Number(r.upcoming_po_qty || 0);
    agg.suggested_cut_qty += Number(r.suggested_cut_qty || 0);
    const doh = Number(r.doh);
    if (Number.isFinite(doh)) {
      if (agg.worst_size_doh === null || doh < agg.worst_size_doh) agg.worst_size_doh = doh;
    }
    const lt = Number(r.lead_time || 0);
    if (Number.isFinite(doh) && doh <= lt) agg.sizes_below_lt += 1;
    if (r.trigger === 'red') agg.any_red = true;
    if (r.trigger === 'amber') agg.any_amber = true;
    if (r.dataQuality === 'warming_up') agg.warming_up = true;
  }
  const out = [];
  for (const agg of byStyle.values()) {
    const avg_drr = agg.size_count ? agg.drr_sum / agg.size_count : 0;
    const suggested_action = agg.any_red ? 'cut_now'
                           : agg.any_amber ? 'cut_soon'
                           : agg.suggested_cut_qty > 0 ? 'monitor'
                           : 'ok';
    const trigger = agg.any_red ? 'red' : agg.any_amber ? 'amber' : 'green';
    out.push({
      style: agg.style,
      total_soh: agg.total_soh,
      avg_drr: Number(avg_drr.toFixed(3)),
      worst_size_doh: agg.worst_size_doh,
      sizes_below_lt: agg.sizes_below_lt,
      open_lot_qty: agg.open_lot_qty,
      upcoming_po_qty: agg.upcoming_po_qty,
      suggested_cut_qty: agg.suggested_cut_qty,
      suggested_action,
      trigger,
      warming_up: agg.warming_up,
    });
  }
  out.sort((a, b) => b.suggested_cut_qty - a.suggested_cut_qty);
  return out;
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ─── Pages ───────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  let warehouses = [];
  let warming = false;
  try {
    const [wh] = await pool.query(
      `SELECT DISTINCT warehouse_id FROM ee_user_warehouses ORDER BY warehouse_id`
    );
    warehouses = wh;
  } catch (_) {}
  try {
    if (analytics.getCuttingRecommendations) {
      const rows = await analytics.getCuttingRecommendations(pool, { periodKey: '30d' });
      warming = (rows || []).some(r => r.dataQuality === 'warming_up');
    }
  } catch (_) {}
  res.render('productionManagerDashboard', {
    user: req.session.user,
    userRole: req.session.user.roleName,
    warehouses,
    warming,
  });
});

router.get('/style/:style', async (req, res) => {
  res.render('productionManagerStyle', {
    user: req.session.user,
    userRole: req.session.user.roleName,
    style: req.params.style,
  });
});

// ─── Cutting recommendations ─────────────────────────────────────────

router.get('/api/styles', async (req, res) => {
  try {
    const rows = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    let styles = aggregateStyles(rows);
    const search = String(req.query.search || '').trim().toLowerCase();
    const trigger = String(req.query.trigger || 'all').toLowerCase();
    if (search) styles = styles.filter(s => (s.style || '').toLowerCase().includes(search));
    if (trigger && trigger !== 'all') styles = styles.filter(s => s.trigger === trigger);
    const dataQuality = (rows || []).some(r => r.dataQuality === 'warming_up') ? 'warming_up' : 'real';
    res.json({ ok: true, items: styles, dataQuality });
  } catch (err) {
    if (err.code === 'ANALYTICS_MISSING') {
      return res.json({ ok: false, items: [], warning: err.message });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/sizes', async (req, res) => {
  try {
    const style = String(req.query.style || '').trim();
    const rows = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    const filtered = style ? (rows || []).filter(r => r.style === style) : (rows || []);
    res.json({ ok: true, items: filtered });
  } catch (err) {
    if (err.code === 'ANALYTICS_MISSING') {
      return res.json({ ok: false, items: [], warning: err.message });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/dead-stock', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 45;
    const rows = await safeCall('getDeadStock', pool, { days });
    res.json({ ok: true, items: rows || [] });
  } catch (err) {
    if (err.code === 'ANALYTICS_MISSING') {
      return res.json({ ok: false, items: [], warning: err.message });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/recommendations.csv', async (req, res) => {
  try {
    const style = String(req.query.style || '').trim();
    const rows = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    const filtered = style ? (rows || []).filter(r => r.style === style) : (rows || []);
    const cols = [
      'style', 'sku', 'size', 'soh', 'drr', 'selling_days', 'calendar_days',
      'doh', 'lead_time', 'safety_days', 'open_lot_qty', 'upcoming_po_qty',
      'suggested_cut_qty', 'trigger', 'dataQuality',
    ];
    const lines = [cols.join(',')];
    for (const r of filtered) lines.push(cols.map(c => csvEscape(r[c])).join(','));
    const fname = `cutting_recommendations_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(lines.join('\n'));
  } catch (err) {
    if (err.code === 'ANALYTICS_MISSING') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send('error\n' + csvEscape(err.message));
    }
    res.status(500).send('Export failed: ' + err.message);
  }
});

// ─── Open cutting lots ───────────────────────────────────────────────

router.get('/open-lots', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM pm_open_cutting_lots WHERE closed_at IS NULL ORDER BY created_at DESC`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: false, items: [], warning: 'Run the production-manager migration first.' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/open-lots', async (req, res) => {
  try {
    const sku = String(req.body.sku || '').trim();
    const style = String(req.body.style || '').trim();
    const size = String(req.body.size || '').trim();
    const qty = Number(req.body.qty);
    const expRaw = String(req.body.expected_completion_date || '').trim();
    if (!sku) return res.status(400).json({ ok: false, error: 'sku required.' });
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ ok: false, error: 'qty must be > 0.' });
    const expDate = expRaw ? new Date(expRaw) : null;
    if (!expDate || Number.isNaN(expDate.getTime())) {
      return res.status(400).json({ ok: false, error: 'expected_completion_date required.' });
    }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (expDate < today) {
      return res.status(400).json({ ok: false, error: 'expected_completion_date must be today or in the future.' });
    }
    const [result] = await pool.query(
      `INSERT INTO pm_open_cutting_lots
         (sku, style, size, qty, expected_completion_date, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [sku, style || null, size || null, qty, expDate.toISOString().slice(0, 10), req.session.user.id || null]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/open-lots/:id/close', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid id.' });
    await pool.query(`UPDATE pm_open_cutting_lots SET closed_at = NOW() WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Marketplace POs ─────────────────────────────────────────────────

router.get('/marketplace-pos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, COUNT(l.id) AS lines_count, COALESCE(SUM(l.qty), 0) AS total_qty
         FROM pm_marketplace_pos p
         LEFT JOIN pm_marketplace_po_lines l ON l.po_id = p.id
        GROUP BY p.id
        ORDER BY p.uploaded_at DESC`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: false, items: [], warning: 'Run the production-manager migration first.' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/marketplace-pos/upload', upload.single('file'), async (req, res) => {
  let conn;
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ ok: false, error: 'Workbook has no sheets.' });

    // Find header row
    const required = ['marketplace', 'po_number', 'sku', 'size', 'qty', 'required_by_date'];
    const headerRow = ws.getRow(1);
    const headerMap = {};
    headerRow.eachCell((cell, col) => {
      const k = String(cell.value || '').trim().toLowerCase().replace(/\s+/g, '_');
      headerMap[k] = col;
    });
    for (const r of required) {
      if (!headerMap[r]) {
        return res.status(400).json({ ok: false, error: `Missing required column: ${r}` });
      }
    }

    const dataRows = [];
    for (let i = 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const get = (k) => {
        const cell = row.getCell(headerMap[k]);
        const v = cell ? cell.value : null;
        if (v && typeof v === 'object' && 'text' in v) return v.text;
        if (v && typeof v === 'object' && 'result' in v) return v.result;
        return v;
      };
      const marketplace = get('marketplace');
      const po_number = get('po_number');
      const sku = get('sku');
      const size = get('size');
      const qty = get('qty');
      const required_by_date = get('required_by_date');
      if (!marketplace && !po_number && !sku) continue;
      dataRows.push({
        marketplace: marketplace == null ? '' : String(marketplace).trim(),
        po_number: po_number == null ? '' : String(po_number).trim(),
        sku: sku == null ? '' : String(sku).trim(),
        size: size == null ? '' : String(size).trim(),
        qty: Number(qty) || 0,
        required_by_date: required_by_date instanceof Date
          ? required_by_date.toISOString().slice(0, 10)
          : (required_by_date ? String(required_by_date).slice(0, 10) : null),
      });
    }
    if (!dataRows.length) return res.status(400).json({ ok: false, error: 'No data rows found.' });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const headerKey = (r) => `${r.marketplace}||${r.po_number}`;
    const poIds = new Map();
    for (const r of dataRows) {
      const k = headerKey(r);
      if (poIds.has(k)) continue;
      const [ins] = await conn.query(
        `INSERT INTO pm_marketplace_pos
           (marketplace, po_number, uploaded_by, uploaded_at, status)
         VALUES (?, ?, ?, NOW(), 'open')`,
        [r.marketplace, r.po_number, req.session.user.id || null]
      );
      poIds.set(k, ins.insertId);
    }

    const lineRows = dataRows.map(r => [
      poIds.get(headerKey(r)),
      r.sku, r.size, r.qty, r.required_by_date,
    ]);
    if (lineRows.length) {
      await conn.query(
        `INSERT INTO pm_marketplace_po_lines
           (po_id, sku, size, qty, required_by_date)
         VALUES ?`,
        [lineRows]
      );
    }
    await conn.commit();

    const ids = [...poIds.values()];
    res.json({
      ok: true,
      po_ids: ids,
      po_id: ids[0] || null,
      pos_created: ids.length,
      lines_count: lineRows.length,
    });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[pm] marketplace-pos upload error', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ─── Config: lead times ──────────────────────────────────────────────

router.get('/config/lead-times', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM pm_style_lead_times ORDER BY scope, key_value`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: false, items: [], warning: 'Run the production-manager migration first.' });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/config/lead-times', async (req, res) => {
  try {
    const scope = String(req.body.scope || '').toLowerCase();
    if (!['style', 'sku'].includes(scope)) {
      return res.status(400).json({ ok: false, error: 'scope must be style or sku.' });
    }
    const key_value = String(req.body.key_value || '').trim();
    if (!key_value) return res.status(400).json({ ok: false, error: 'key_value required.' });
    const defaultLT  = parseInt(req.body.default_lead_time_days, 10);
    const fabricLT   = parseInt(req.body.fabric_lead_time_days, 10);
    const safetyDays = parseInt(req.body.safety_days, 10);
    const overrideDrrRaw = req.body.override_drr;
    const overrideDrr = (overrideDrrRaw === '' || overrideDrrRaw == null) ? null : Number(overrideDrrRaw);

    await pool.query(
      `INSERT INTO pm_style_lead_times
         (scope, key_value, default_lead_time_days, fabric_lead_time_days, safety_days, override_drr)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         default_lead_time_days = VALUES(default_lead_time_days),
         fabric_lead_time_days  = VALUES(fabric_lead_time_days),
         safety_days            = VALUES(safety_days),
         override_drr           = VALUES(override_drr)`,
      [
        scope,
        key_value,
        Number.isFinite(defaultLT)  ? defaultLT  : null,
        Number.isFinite(fabricLT)   ? fabricLT   : null,
        Number.isFinite(safetyDays) ? safetyDays : null,
        Number.isFinite(overrideDrr) ? overrideDrr : null,
      ]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Admin: manual pull trigger ──────────────────────────────────────

router.post('/pull-now', async (req, res) => {
  if (req.session.user.roleName !== 'admin') {
    return res.status(403).json({ ok: false, error: 'admin role required.' });
  }
  try {
    if (pullWorker && typeof pullWorker.triggerNow === 'function') {
      // Fire-and-forget; reply immediately.
      Promise.resolve()
        .then(() => pullWorker.triggerNow(pool))
        .catch(err => console.error('[pm] triggerNow error', err));
      return res.json({ ok: true, queued: true });
    }
    return res.status(503).json({ ok: false, error: 'Pull worker not available.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
