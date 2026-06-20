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
const skuResolver = require('../utils/skuResolver');
const { aggregateStyleConsumption } = require('../utils/styleConsumption');
const { parseConsumptionSheet } = require('../utils/cadConsumption');
const { planCut } = require('../utils/cutPlanner');
const { buildAssignmentPayload } = require('../utils/cutAssignment');
const stageEvents = require('../utils/stageEvents');
const { orderedStages, deriveStageStatus, dispatchSummary, currentStage } = require('../utils/lotJourney');
const { cutPrioritySummary, fabricNeededByType, wipByStage } = require('../utils/pmAnalytics');
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

// PM approve-and-assign screen: review a style's suggested cut, pick a cutting master, assign.
router.get('/cut-planning', (req, res) => {
  res.render('cutPlanning', { user: req.session.user, prefillStyle: String(req.query.style || '').trim() });
});

// ─── Cutting recommendations ─────────────────────────────────────────

const WIP_STAGES = ['stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing'];

router.get('/analytics', (req, res) => res.render('productionManagerAnalytics', { user: req.session.user }));

// GET /pm/api/analytics — the four analytics sections. Each guarded independently.
router.get('/api/analytics', async (req, res) => {
  const out = {};

  // 1. Demand vs supply — daily demand (DRR) vs stock + on-order, and the most under-supplied styles.
  try {
    const recs = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    let dailyDemand = 0; let soh = 0; let onOrder = 0; let suggested = 0;
    for (const r of recs || []) {
      dailyDemand += Number(r.drr) || 0; soh += Number(r.soh) || 0;
      onOrder += Number(r.open_lot_qty) || 0; suggested += Number(r.suggested_cut_qty) || 0;
    }
    const top = aggregateStyles(recs)
      .filter((s) => s.suggested_cut_qty > 0)
      .slice(0, 15)
      .map((s) => ({ style: s.style, suggested: s.suggested_cut_qty, soh: s.total_soh, drr: s.avg_drr, doh: s.worst_size_doh, on_order: s.open_lot_qty, trigger: s.trigger }));
    out.demand_supply = { dailyDemand, soh, onOrder, suggested, daysCover: dailyDemand > 0 ? soh / dailyDemand : null, top };
  } catch (_) { out.demand_supply = null; }

  // 2. Throughput & TAT — lots cut/week, dispatched/week, current bottleneck stage (most WIP).
  try {
    const [cut] = await pool.query(
      `SELECT YEARWEEK(created_at,3) wk, MIN(DATE(created_at)) week_start, COUNT(*) lots, COALESCE(SUM(total_pieces),0) pieces
         FROM cutting_lots WHERE created_at >= CURDATE() - INTERVAL 84 DAY GROUP BY wk ORDER BY wk`
    );
    let dispatch = [];
    try {
      const [d] = await pool.query(
        `SELECT YEARWEEK(created_at,3) wk, MIN(DATE(created_at)) week_start, COALESCE(SUM(quantity),0) pieces
           FROM finishing_dispatches WHERE created_at >= CURDATE() - INTERVAL 84 DAY GROUP BY wk ORDER BY wk`
      );
      dispatch = d;
    } catch (_) {}
    let bottleneck = null;
    try {
      const wipRows = [];
      for (const stage of WIP_STAGES) {
        const [[r]] = await pool.query(
          `SELECT COALESCE(SUM(CASE WHEN e.event_type='approve' THEN e.pieces END),0) approved,
                  COALESCE(SUM(CASE WHEN e.event_type='complete' THEN e.pieces END),0) completed,
                  COALESCE(SUM(CASE WHEN e.event_type='reject' AND e.parent_event_id IS NOT NULL THEN e.pieces END),0) inline_rejected
             FROM \`${stage}_events\` e JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
            WHERE cl.created_at >= CURDATE() - INTERVAL 120 DAY`
        );
        wipRows.push({ stage, ...r });
      }
      const w = wipByStage(wipRows);
      bottleneck = Object.entries(w.byStage).sort((a, b) => b[1] - a[1])[0] || null;
    } catch (_) {}
    out.throughput = {
      cut_per_week: cut.map((r) => ({ week_start: r.week_start, lots: Number(r.lots), pieces: Number(r.pieces) })),
      dispatch_per_week: dispatch.map((r) => ({ week_start: r.week_start, pieces: Number(r.pieces) })),
      bottleneck: bottleneck ? { stage: bottleneck[0], wip: bottleneck[1] } : null,
    };
  } catch (_) { out.throughput = null; }

  // 3. Fabric usage & variance — real derived consumption vs the CAD standard, per style.
  try {
    const derived = await loadStyleConsumption(pool, 120);
    const [cadRows] = await pool.query('SELECT style, AVG(consumption_per_piece) standard FROM pm_style_consumption GROUP BY style');
    out.fabric_variance = fabricVarianceRows(derived, cadRows.map((c) => ({ style: c.style, standard: Number(c.standard) }))).slice(0, 25);
  } catch (_) { out.fabric_variance = null; }

  // 4. Master / cutter output — pieces cut (30d) + assignment counts per master.
  try {
    const [lots] = await pool.query(
      `SELECT cl.user_id master_id, u.username, COUNT(*) lots, COALESCE(SUM(cl.total_pieces),0) pieces
         FROM cutting_lots cl JOIN users u ON u.id = cl.user_id
        WHERE cl.created_at >= CURDATE() - INTERVAL 30 DAY GROUP BY cl.user_id, u.username`
    );
    let asg = [];
    try {
      const [a] = await pool.query(
        `SELECT assigned_master_id, assigned_master_name username, COUNT(*) assigned,
                COALESCE(SUM(status='cut'),0) cut
           FROM pm_cut_assignment GROUP BY assigned_master_id, assigned_master_name`
      );
      asg = a;
    } catch (_) {}
    out.master_output = masterOutputSummary(lots, asg);
  } catch (_) { out.master_output = null; }

  res.json({ ok: true, ...out });
});

// GET /pm/api/summary — the numbers behind the dashboard summary cards. Each card is
// computed independently and degrades to null on error so one missing table never blanks
// the whole row.
router.get('/api/summary', async (req, res) => {
  const out = {};

  // Cut priority + fabric needed (both off the recommendations).
  try {
    const recs = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    out.cut_priority = cutPrioritySummary(aggregateStyles(recs));
    try {
      const [cons] = await pool.query('SELECT style, size_label, consumption_per_piece, fabric_type FROM pm_style_consumption');
      out.fabric_needed = fabricNeededByType(recs, cons);
    } catch (_) { out.fabric_needed = null; }
  } catch (_) { out.cut_priority = null; out.fabric_needed = null; }

  // WIP currently in hand at each stage (lots from the last 120 days).
  try {
    const rows = [];
    for (const stage of WIP_STAGES) {
      const [[r]] = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN e.event_type='approve' THEN e.pieces END),0) approved,
                COALESCE(SUM(CASE WHEN e.event_type='complete' THEN e.pieces END),0) completed,
                COALESCE(SUM(CASE WHEN e.event_type='reject' AND e.parent_event_id IS NOT NULL THEN e.pieces END),0) inline_rejected
           FROM \`${stage}_events\` e JOIN cutting_lots cl ON cl.id = e.cutting_lot_id
          WHERE cl.created_at >= CURDATE() - INTERVAL 120 DAY`
      );
      rows.push({ stage, ...r });
    }
    out.wip = wipByStage(rows);
  } catch (_) { out.wip = null; }

  // Dead stock (count + units of slow movers).
  try {
    const dead = await safeCall('getDeadStock', pool, { days: 45 });
    out.dead_stock = { count: (dead || []).length, units: (dead || []).reduce((s, d) => s + (Number(d.soh) || 0), 0) };
  } catch (_) { out.dead_stock = null; }

  // Total inventory on hand (latest snapshot).
  try {
    const [[r]] = await pool.query(
      `SELECT COALESCE(SUM(qty),0) units, MAX(snapshot_date) as_of FROM ee_inventory_daily_snapshot
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM ee_inventory_daily_snapshot)`
    );
    out.inventory = { units: Number(r.units) || 0, as_of: r.as_of };
  } catch (_) { out.inventory = null; }

  // Sales day by day (last 30 days).
  try {
    const [rows] = await pool.query(
      `SELECT sale_date, SUM(qty) qty FROM ee_sales_daily
        WHERE sale_date >= CURDATE() - INTERVAL 30 DAY GROUP BY sale_date ORDER BY sale_date`
    );
    out.sales_by_day = rows.map((r) => ({ date: r.sale_date, qty: Number(r.qty) || 0 }));
  } catch (_) { out.sales_by_day = null; }

  res.json({ ok: true, ...out });
});

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

// Real fabric consumption (meters/piece) per style, derived from cutting history.
// A lot's blended consumption = table_length * SUM(layers) / total_pieces; dirty rows
// are filtered and styles aggregated by median (see utils/styleConsumption.js).
async function loadStyleConsumption(dbPool, windowDays) {
  const days = Number.isFinite(windowDays) ? windowDays : 120;
  const [rows] = await dbPool.query(
    `SELECT cl.sku, cl.table_length, cl.total_pieces, COALESCE(SUM(clr.layers), 0) AS layers
     FROM cutting_lots cl
     LEFT JOIN cutting_lot_rolls clr ON clr.cutting_lot_id = cl.id
     WHERE cl.created_at >= CURDATE() - INTERVAL ? DAY AND cl.sku IS NOT NULL
     GROUP BY cl.id`,
    [days]
  );
  return aggregateStyleConsumption(rows);
}

// GET /pm/api/consumption — per-style real consumption, most-measured styles first.
router.get('/api/consumption', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 120;
    const items = await loadStyleConsumption(pool, days);
    items.sort((a, b) => b.cleanLots - a.cleanLots);
    res.json({ ok: true, windowDays: days, count: items.length, items });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ ok: false, items: [], warning: err.message });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Read a worksheet into row objects keyed by a known column set (some optional). Headers
// are slugified (lowercase, non-alphanumeric -> _); unmatched optional columns are skipped.
function readSheetRows(ws, columns) {
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers.push({ col, k: String(cell.value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') });
  });
  const map = {};
  for (const key of columns) {
    const h = headers.find((x) => x.k === key) || headers.find((x) => x.k.startsWith(key));
    if (h) map[key] = h.col;
  }
  const cellText = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('text' in v) return v.text;
      if ('result' in v) return v.result;
      if ('richText' in v) return v.richText.map((t) => t.text).join('');
    }
    return v;
  };
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const obj = {};
    for (const key of columns) obj[key] = map[key] ? String(cellText(row.getCell(map[key]).value)).trim() : '';
    if (Object.values(obj).some((v) => v !== '')) rows.push(obj);
  }
  return { rows, map };
}

// POST /pm/consumption/upload — load CAD per-size consumption (style, fabric_type, size,
// consumption, [unit]) into pm_style_consumption. CAD is the fabric truth (owner ruling).
router.post('/consumption/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ ok: false, error: 'Workbook has no sheets.' });
    const { rows: rawRows, map } = readSheetRows(ws, ['style', 'fabric_type', 'size', 'consumption', 'unit']);
    if (!map.style || !map.size || !map.consumption) {
      return res.status(400).json({ ok: false, error: 'Need columns: style, size, consumption (fabric_type, unit optional).' });
    }
    const { rows, errors } = parseConsumptionSheet(rawRows);
    let saved = 0;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO pm_style_consumption (style, size_label, fabric_type, consumption_per_piece, consumption_unit, source, loaded_by)
         VALUES (?, ?, ?, ?, ?, 'cad', ?)
         ON DUPLICATE KEY UPDATE fabric_type=VALUES(fabric_type), consumption_per_piece=VALUES(consumption_per_piece),
           consumption_unit=VALUES(consumption_unit), loaded_by=VALUES(loaded_by)`,
        [r.style, r.size_label, r.fabric_type, r.consumption_per_piece, r.consumption_unit, req.session?.user?.id || null]
      );
      saved += 1;
    }
    res.json({ ok: true, saved, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error('[pm] consumption upload error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// A style's suggested cut -> capped lots + fabric to issue from CAD. Shared by the
// cut-plan view and the approve-and-assign action.
async function computeStyleCutPlan(style) {
  const recs = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
  const demand = {};
  for (const r of (recs || [])) {
    if (r.style !== style) continue;
    const qty = Number(r.suggested_cut_qty) || 0;
    if (qty > 0 && r.size) demand[r.size] = (demand[r.size] || 0) + qty;
  }
  const [consRows] = await pool.query(
    'SELECT size_label, consumption_per_piece, consumption_unit, fabric_type FROM pm_style_consumption WHERE style = ?',
    [style]
  );
  const consumptionBySize = {};
  let fabricType = null;
  let unit = 'METER';
  for (const c of consRows) {
    consumptionBySize[c.size_label] = Number(c.consumption_per_piece);
    fabricType = fabricType || c.fabric_type;
    unit = c.consumption_unit || unit;
  }
  const plan = planCut(demand, { consumptionBySize });
  return { demand, plan, fabricType, unit, hasCad: consRows.length > 0 };
}

// GET /pm/api/cut-plan?style=... — turn a style's suggested cut into capped lots with the
// fabric to issue per lot from CAD consumption. CAD makes the marker; we plan quantities+lots.
router.get('/api/cut-plan', async (req, res) => {
  try {
    const style = String(req.query.style || '').trim();
    if (!style) return res.status(400).json({ ok: false, error: 'style is required' });
    const { demand, plan, fabricType, unit, hasCad } = await computeStyleCutPlan(style);
    res.json({ ok: true, style, fabric_type: fabricType, fabric_unit: unit, demand, has_cad: hasCad, ...plan });
  } catch (err) {
    if (err.code === 'ANALYTICS_MISSING' || err.code === 'ER_NO_SUCH_TABLE') {
      return res.json({ ok: false, warning: err.message });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pm/api/cut-masters — the cutting masters a cut can be assigned to.
router.get('/api/cut-masters', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username FROM users u JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'cutting_manager' AND u.is_active = TRUE ORDER BY u.username`
    );
    res.json({ ok: true, masters: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /pm/api/cut-plan/assign — PM approves a style's suggested cut and assigns it to
// cutting master(s). Two shapes (both supported, back-compatible):
//   { style, master_id }                  -> whole style to ONE master (single consolidated row)
//   { style, lots: [{ master_id }, ...] }  -> one assignment PER LOT, each to its own master
// Per-lot uses the lot's own size split (plan.lots[i].sizes) and tags note "Lot i/N".
router.post('/api/cut-plan/assign', async (req, res) => {
  try {
    const style = String(req.body.style || '').trim();
    if (!style) return res.status(400).json({ ok: false, error: 'style is required' });

    const { plan, fabricType } = await computeStyleCutPlan(style);
    const lots = (plan && plan.lots) || [];
    if (!lots.length) return res.status(400).json({ ok: false, error: 'No cut plan to assign.' });

    // Resolve which master each lot goes to.
    const perLot = Array.isArray(req.body.lots) && req.body.lots.length;
    let lotMasterIds;
    if (perLot) {
      if (req.body.lots.length !== lots.length) {
        return res.status(400).json({ ok: false, error: `Expected ${lots.length} lot assignment(s), got ${req.body.lots.length}.` });
      }
      lotMasterIds = req.body.lots.map((l) => parseInt(l.master_id, 10));
    } else {
      const m = parseInt(req.body.master_id, 10);
      if (!m) return res.status(400).json({ ok: false, error: 'master_id (or per-lot lots[]) is required' });
      lotMasterIds = lots.map(() => m);
    }
    if (lotMasterIds.some((m) => !m)) return res.status(400).json({ ok: false, error: 'Every lot needs a cutting master.' });

    // Validate all chosen masters in one query.
    const uniqueIds = [...new Set(lotMasterIds)];
    const [mrows] = await pool.query(
      `SELECT u.id, u.username FROM users u JOIN roles r ON u.role_id = r.id
        WHERE u.id IN (?) AND r.name = 'cutting_manager' AND u.is_active = TRUE`,
      [uniqueIds]
    );
    const nameById = new Map(mrows.map((m) => [m.id, m.username]));
    if (uniqueIds.some((id) => !nameById.has(id))) {
      return res.status(400).json({ ok: false, error: 'One or more selected masters are not valid cutting masters.' });
    }
    const createdBy = req.session?.user?.id || null;

    async function insertAssignment(header, sizes, note) {
      const [result] = await pool.query(
        `INSERT INTO pm_cut_assignment
           (style, fabric_type, total_pieces, lot_count, total_fabric_meters, fabric_complete,
            assigned_master_id, assigned_master_name, status, created_by, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, ?)`,
        [header.style, header.fabric_type, header.total_pieces, header.lot_count,
         header.total_fabric_meters, header.fabric_complete ? 1 : 0,
         header.assigned_master_id, header.assigned_master_name, header.created_by, note]
      );
      const assignmentId = result.insertId;
      if (sizes.length) {
        await pool.query(
          `INSERT INTO pm_cut_assignment_sizes (assignment_id, size_label, qty) VALUES ?`,
          [sizes.map((s) => [assignmentId, s.size_label, s.qty])]
        );
      }
      return assignmentId;
    }

    // Single-master (all lots same OR legacy master_id): one consolidated row — unchanged behaviour.
    if (!perLot || uniqueIds.length === 1) {
      const masterId = lotMasterIds[0];
      const { demand, plan: fullPlan, fabricType: ft } = await computeStyleCutPlan(style);
      const { header, sizes } = buildAssignmentPayload({
        style, fabricType: ft, masterId, masterName: nameById.get(masterId),
        demand, plan: fullPlan, createdBy,
      });
      const id = await insertAssignment(header, sizes, null);
      return res.json({ ok: true, assignment_id: id, count: 1, assigned_to: nameById.get(masterId) });
    }

    // Per-lot: one row per lot, each to its own master, using the lot's own size split.
    const n = lots.length;
    const created = [];
    for (let i = 0; i < n; i++) {
      const lot = lots[i];
      const masterId = lotMasterIds[i];
      const { header, sizes } = buildAssignmentPayload({
        style, fabricType, masterId, masterName: nameById.get(masterId),
        demand: lot.sizes,
        plan: { lotCount: 1, totalFabricMeters: lot.fabricMeters, fabricComplete: lot.fabricComplete },
        createdBy,
      });
      const id = await insertAssignment(header, sizes, `Lot ${i + 1}/${n}`);
      created.push({ assignment_id: id, lot: i + 1, pieces: header.total_pieces, master: nameById.get(masterId) });
    }
    res.json({ ok: true, count: created.length, assignments: created, assigned_to: [...new Set(created.map((c) => c.master))].join(', ') });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.status(400).json({ ok: false, error: 'Run the cut-assignment migration first.' });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Compact stage journey for one cut lot, reusing the tested lotJourney helpers + stageEvents.
const STAGE_EVENT_TABLE = {
  stitching: 'stitching_events', jeans_assembly: 'jeans_assembly_events',
  washing: 'washing_events', washing_in: 'washing_in_events', finishing: 'finishing_events',
};
const STAGE_LABEL = {
  cutting: 'Cut', stitching: 'Stitch', jeans_assembly: 'Assembly',
  washing: 'Wash', washing_in: 'Wash-In', finishing: 'Finish',
};

async function lotJourneyCompact(lot) {
  const stages = orderedStages(lot.flow_type);
  const now = Date.now();
  const raw = {};
  for (const stage of stages) {
    if (stage === 'cutting') continue;
    const [rows] = await pool.query(
      `SELECT e.event_type, e.created_at, u.username FROM \`${STAGE_EVENT_TABLE[stage]}\` e
         LEFT JOIN users u ON u.id = e.operator_id WHERE e.cutting_lot_id = ? ORDER BY e.created_at`,
      [lot.id]
    );
    let entered = null; let completedAt = null; let master = null;
    for (const r of rows) {
      if (!entered) entered = r.created_at;
      if (r.event_type === 'complete') completedAt = r.created_at;
      if (r.event_type === 'approve' && !master) master = r.username;
    }
    raw[stage] = { entered, completedAt, master, agg: await stageEvents.getStageAggregates(pool, stage, lot.id) };
  }
  const timeline = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]; const next = stages[i + 1];
    const entered = stage === 'cutting' ? lot.created_at : raw[stage].entered;
    const exit = next ? (raw[next] && raw[next].entered) : (stage === 'cutting' ? null : raw[stage].completedAt);
    let { status, days } = deriveStageStatus({ entered, exited: exit }, now);
    if (stage === 'cutting') status = 'done';
    timeline.push({
      stage, label: STAGE_LABEL[stage] || stage, status, days,
      completed: stage === 'cutting' ? lot.total_pieces : (raw[stage].agg.completed || 0),
      master: stage === 'cutting' ? lot.cutter_name : (raw[stage].master || null),
    });
  }
  const finished = {};
  if (stages.includes('finishing')) {
    const sz = await stageEvents.getStageSizeAggregates(pool, 'finishing', lot.id);
    for (const [s, v] of Object.entries(sz)) finished[s] = v.completed || 0;
  }
  const [dr] = await pool.query(
    'SELECT size_label, SUM(quantity) qty FROM finishing_dispatches WHERE lot_no = ? GROUP BY size_label', [lot.lot_no]
  );
  const dispatchedBySize = {};
  for (const r of dr) dispatchedBySize[String(r.size_label || '').trim().toUpperCase()] = Number(r.qty) || 0;
  const dispatch = dispatchSummary(finished, dispatchedBySize);
  return {
    lot_no: lot.lot_no, manual_lot_number: lot.manual_lot_number || '', total_pieces: lot.total_pieces,
    created_at: lot.created_at, flow_type: lot.flow_type || 'unknown',
    current_stage: dispatch.complete ? 'Dispatched' : currentStage(timeline),
    timeline, dispatch: { finished: dispatch.totalFinished, dispatched: dispatch.totalDispatched, in_stock: dispatch.remaining },
  };
}

// GET /pm/api/style-lots?style=... — the lots cut for this style and where each one is now,
// so the PM sees the cut history on the same screen (after assign -> cut).
router.get('/api/style-lots', async (req, res) => {
  try {
    const style = String(req.query.style || '').trim();
    if (!style) return res.status(400).json({ ok: false, error: 'style is required' });
    const [lots] = await pool.query(
      `SELECT cl.id, cl.lot_no, cl.manual_lot_number, cl.total_pieces, cl.flow_type, cl.created_at,
              u.username AS cutter_name
         FROM cutting_lots cl LEFT JOIN users u ON u.id = cl.user_id
        WHERE cl.sku = ? ORDER BY cl.created_at DESC LIMIT 8`,
      [style]
    );
    const journeys = [];
    for (const lot of lots) journeys.push(await lotJourneyCompact(lot));
    res.json({ ok: true, style, lots: journeys });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pm/api/cut-assignments — recent assignments (PM visibility into what's been routed).
router.get('/api/cut-assignments', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, style, fabric_type, total_pieces, lot_count, total_fabric_meters,
              assigned_master_name, status, cutting_lot_id, created_at
         FROM pm_cut_assignment ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true, items: [] });
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

// ─── Temp debug: run a single EasyEcom call and return the raw response ──
// Admin-only. Lets us see what EasyEcom actually returns without trawling
// through Cloud Run logs. Examples:
//   GET /pm/debug-ee?what=snapshot&warehouse=faridabad&days=30
//   GET /pm/debug-ee?what=mini-sales&warehouse=faridabad&days=7
//   GET /pm/debug-ee?what=orders&warehouse=faridabad&days=7
// Remove after debugging.
router.get('/debug-ee', async (req, res) => {
  if (req.session.user.roleName !== 'admin') {
    return res.status(403).json({ ok: false, error: 'admin role required.' });
  }
  const { what = 'snapshot', warehouse = 'faridabad', days = '7' } = req.query;
  const client = require('../utils/easyecomReturnsClient');
  const axios = require('axios');
  const days_n = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const end = new Date();
  const start = new Date(end.getTime() - days_n * 24 * 60 * 60 * 1000);
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const fmtDay = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

  try {
    if (what === 'snapshot') {
      const files = await client.listInventorySnapshots(
        { startDate: fmt(start), endDate: fmt(end) }, warehouse
      );
      return res.json({ ok: true, what, warehouse, params: { startDate: fmt(start), endDate: fmt(end) }, count: files.length, sample: files.slice(0, 3), files });
    }
    if (what === 'mini-sales') {
      // Queue + poll inline so we see the exact error if 400.
      const token = await client.authenticateWithCredentials(warehouse);
      const api = axios.create({
        baseURL: process.env.EASYECOM_API_BASE || 'https://api.easyecom.io',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        timeout: 60000, validateStatus: () => true,
      });
      const body = {
        reportType: 'MINI_SALES_REPORT',
        params: { invoiceType: 'ALL', dateType: 'ORDER_DATE', startDate: fmtDay(start), endDate: fmtDay(end) },
      };
      const resp = await api.post('/reports/queue', body);
      return res.json({ ok: resp.status < 300, what, status: resp.status, requestBody: body, response: resp.data });
    }
    if (what === 'orders') {
      const token = await client.authenticateWithCredentials(warehouse);
      const api = axios.create({
        baseURL: process.env.EASYECOM_API_BASE || 'https://api.easyecom.io',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        timeout: 60000, validateStatus: () => true,
      });
      const params = { start_date: fmt(start), end_date: fmt(end) };
      const resp = await api.get('/orders/V2/getAllOrders', { params });
      const data = resp.data?.data || {};
      const ordersArr = data.orders || data.invoices || [];
      return res.json({
        ok: resp.status < 300, what, status: resp.status, params,
        responseShape: { code: resp.data?.code, message: resp.data?.message, hasOrdersField: !!data.orders, hasInvoicesField: !!data.invoices, count: ordersArr.length, nextUrl: data.nextUrl || null },
        sampleFirst: ordersArr[0] || null,
      });
    }
    if (what === 'locations') {
      const token = await client.authenticateWithCredentials(warehouse);
      const api = axios.create({
        baseURL: process.env.EASYECOM_API_BASE || 'https://api.easyecom.io',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        timeout: 60000, validateStatus: () => true,
      });
      const resp = await api.get('/getAllLocation');
      return res.json({ ok: resp.status < 300, what, status: resp.status, response: resp.data });
    }
    return res.status(400).json({ ok: false, error: `unknown what=${what}. Try snapshot|mini-sales|orders|locations` });
  } catch (err) {
    return res.status(500).json({
      ok: false, error: err.message,
      eeStatus: err.response?.status, eeBody: err.response?.data,
    });
  }
});

// ─── Resolver: cutting-style -> ecom size-SKU map (pm_sku_resolution) ──
// Validates filled templates and loads pm_sku_resolution. Per-row validation
// against distinct ee_suborders; rejects with reasons; partial uploads fine.

function parseResolverSheet(ws, required) {
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => {
    headers.push({ col, k: String(cell.value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') });
  });
  const headerMap = {};
  for (const key of required) {
    const h = headers.find((x) => x.k === key) || headers.find((x) => x.k.startsWith(key));
    if (h) headerMap[key] = h.col;
  }
  for (const r of required) if (!headerMap[r]) return { error: `Missing required column: ${r}` };
  const cellText = (v) => {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('text' in v) return v.text;
      if ('result' in v) return v.result;
      if ('richText' in v) return v.richText.map((t) => t.text).join('');
    }
    return v;
  };
  const rows = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    const obj = {};
    for (const k of required) obj[k] = String(cellText(row.getCell(headerMap[k]).value)).trim();
    rows.push(obj);
  }
  return { rows };
}

// POST /pm/resolver/upload-sizes — filled size template (cl_sku, size_label, size_sku)
router.post('/resolver/upload-sizes', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ ok: false, error: 'Workbook has no sheets.' });
    const parsed = parseResolverSheet(ws, ['cl_sku', 'size_label', 'size_sku']);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const result = await skuResolver.loadSizeRows(pool, parsed.rows, req.session?.user?.id || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[pm] resolver upload-sizes error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /pm/resolver/upload-styles — filled style sheet (style, ruling = waist|letter|skip)
router.post('/resolver/upload-styles', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) return res.status(400).json({ ok: false, error: 'Workbook has no sheets.' });
    const parsed = parseResolverSheet(ws, ['style', 'ruling']);
    if (parsed.error) return res.status(400).json({ ok: false, error: parsed.error });
    const summary = await skuResolver.loadStyleRulings(pool, parsed.rows, req.session?.user?.id || null);
    res.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[pm] resolver upload-styles error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pm/resolver/status — counts of resolved/excluded mappings
router.get('/resolver/status', async (req, res) => {
  try { res.json({ ok: true, ...(await skuResolver.getResolutionStatus(pool)) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
