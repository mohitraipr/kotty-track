// Finishing dispatch → EasyEcom Purchase Order pipeline.
// Model (docs/EASYECOM_DISPATCH_GRN_DESIGN.md, revised 2026-07-10 after live Phase-0):
//   kotty-track creates ONLY the PO (the challan) in EasyEcom. The Faridabad warehouse
//   receives the physical goods and makes the GRN manually in the EasyEcom UI against
//   that PO. confirmGrns() then detects their GRN (getGrnDetails.po_id) and marks the
//   batch confirmed. NO code path here ever writes inventory directly.
//
// Live-test-verified API quirks (do not "fix" these):
//   - CreatePurchaseOrder wants vendorId = the vendor CODE ('V002');
//     QueueGrnApi (unused here) wants the numeric vendor_c_id instead.
//   - expDeliveryDate must be strictly AFTER today.
//   - EasyEcom refuses to inward more than the PO quantity → the PO itself is a
//     second layer of double-push protection.
//   - Auth: account-level X-API-Key on every call; location scoping via the JWT
//     minted with the Faridabad location_key (EASYECOM_LOCATION_KEY).

const { pool } = require('../config/db');

const EE_BASE = process.env.EASYECOM_API_BASE || 'https://api.easyecom.io';
const EE_API_KEY = process.env.EASYECOM_API_KEY || '';
const EE_VENDOR_CODE = process.env.EE_PO_VENDOR_CODE || 'V002'; // "Kotty Production" (vendor_c_id 289541)
const FARIDABAD_WAREHOUSE_ID = 173983;

// HARD CUTOFF: only dispatches created on/after this date are ever swept. Everything
// before it was physically received long ago — pushing history would double-count
// live marketplace stock. Overridable via env for testing, never set it backwards.
const EE_PO_SINCE = process.env.EE_PO_SINCE || global.env?.EE_PO_SINCE || '2026-07-11';

// Push is dangerous-by-default: creating POs in the live OMS stays off until the
// flag is set on the service (--update-env-vars EE_GRN_PUSH=1).
function pushEnabled() {
  return String(process.env.EE_GRN_PUSH || global.env?.EE_GRN_PUSH || '') === '1';
}

// ── Auth: Faridabad-context JWT, cached ~20h ─────────────────────────────
let _tok = null;
let _tokAt = 0;
async function faridabadToken() {
  if (_tok && Date.now() - _tokAt < 20 * 3600 * 1000) return _tok;
  const r = await fetch(`${EE_BASE}/access/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': EE_API_KEY },
    body: JSON.stringify({
      email: process.env.EASYECOM_EMAIL,
      password: process.env.EASYECOM_PASSWORD,
      location_key: process.env.EASYECOM_LOCATION_KEY, // ee30270084289 = Faridabad
    }),
  });
  const j = await r.json().catch(() => ({}));
  const tok = j?.data?.token?.jwt_token || j?.data?.jwt_token;
  if (!tok) throw new Error('EasyEcom auth failed: ' + JSON.stringify(j).slice(0, 160));
  _tok = tok; _tokAt = Date.now();
  return tok;
}

async function eeCall(method, path, body) {
  const tok = await faridabadToken();
  const headers = { Authorization: `Bearer ${tok}`, 'x-api-key': EE_API_KEY };
  if (body) headers['Content-Type'] = 'application/json';
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${EE_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 4000 * (attempt + 1))); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { _tok = null; lastErr = new Error('401'); continue; } // re-mint once
    return j;
  }
  throw lastErr || new Error('EasyEcom call kept failing: ' + path);
}

// ── SKU resolution ────────────────────────────────────────────────────────
// Chain: (1) pm_sku_resolution map; (2) CONCAT(lot_sku, size) verified to EXIST in
// the ee_product_master mirror (EasyEcom's own convention, e.g. KTTBLUETOP768 + M).
// Anything else stays NULL → the line blocks the batch. Never guessed.
async function resolveLine(db, lotSku, sizeLabel) {
  const sku = String(lotSku || '').trim().toUpperCase();
  const size = String(sizeLabel || '').trim().toUpperCase();
  if (!sku || !size) return { ee_sku: null, source: null, cost: null, mrp: null };

  const [map] = await db.query(
    `SELECT size_sku FROM pm_sku_resolution
      WHERE UPPER(cl_sku)=? AND UPPER(size_label)=? AND size_sku IS NOT NULL LIMIT 1`,
    [sku, size]
  );
  let eeSku = map.length ? String(map[0].size_sku).toUpperCase() : null;
  let source = eeSku ? 'map' : null;

  if (!eeSku) {
    const candidate = sku + size; // EE convention observed across the live catalog
    const [hit] = await db.query(
      `SELECT sku, cost, mrp FROM ee_product_master WHERE sku=? AND active=1 LIMIT 1`,
      [candidate]
    );
    if (hit.length) return { ee_sku: hit[0].sku, source: 'concat-verified', cost: hit[0].cost, mrp: hit[0].mrp };
    return { ee_sku: null, source: null, cost: null, mrp: null };
  }

  const [pm] = await db.query(`SELECT cost, mrp FROM ee_product_master WHERE sku=? LIMIT 1`, [eeSku]);
  return { ee_sku: eeSku, source, cost: pm.length ? pm[0].cost : null, mrp: pm.length ? pm[0].mrp : null };
}

// ── Batch building ────────────────────────────────────────────────────────
// Sweep every Warehouse-destination finishing_dispatches row not yet in any batch
// into ONE new batch (draft if fully resolved, blocked otherwise).
async function buildBatch(user) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT fd.id AS dispatch_id, fd.lot_no, fd.size_label, fd.quantity, cl.sku AS lot_sku
         FROM finishing_dispatches fd
         LEFT JOIN ee_dispatch_po_lines l ON l.dispatch_id = fd.id
         LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
        WHERE l.id IS NULL AND LOWER(fd.destination) = 'warehouse'
          AND fd.created_at >= ?
        ORDER BY fd.id
        LIMIT 500`,
      [EE_PO_SINCE]
    );
    if (!rows.length) { await conn.rollback(); return { created: false, reason: 'No new Warehouse dispatches to sweep.' }; }

    const [ins] = await conn.query(
      `INSERT INTO ee_dispatch_po (batch_ref, status, warehouse_id, created_by, created_by_name)
       VALUES ('PENDING', 'draft', ?, ?, ?)`,
      [FARIDABAD_WAREHOUSE_ID, user?.id || null, user?.username || null]
    );
    const batchId = ins.insertId;
    const batchRef = `KT-DISP-${batchId}`;

    let blocked = 0, totalQty = 0;
    for (const r of rows) {
      const res = await resolveLine(conn, r.lot_sku, r.size_label);
      if (!res.ee_sku) blocked++;
      totalQty += Number(r.quantity) || 0;
      await conn.query(
        `INSERT INTO ee_dispatch_po_lines
           (batch_id, dispatch_id, lot_no, size_label, quantity, lot_sku, ee_sku, resolve_source, unit_cost, mrp)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [batchId, r.dispatch_id, r.lot_no, r.size_label, r.quantity, r.lot_sku || null,
         res.ee_sku, res.source, res.cost, res.mrp]
      );
    }
    await conn.query(
      `UPDATE ee_dispatch_po
          SET batch_ref=?, status=?, total_qty=?, line_count=?, blocked_count=?
        WHERE id=?`,
      [batchRef, blocked > 0 ? 'blocked' : 'draft', totalQty, rows.length, blocked, batchId]
    );
    await conn.commit();
    return { created: true, batchId, batchRef, lines: rows.length, blocked };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Re-resolve a blocked batch's lines (after the resolver map / master sync improves).
async function reResolveBatch(batchId) {
  const [lines] = await pool.query(
    `SELECT id, lot_sku, size_label FROM ee_dispatch_po_lines WHERE batch_id=? AND ee_sku IS NULL`, [batchId]);
  let fixed = 0;
  for (const l of lines) {
    const res = await resolveLine(pool, l.lot_sku, l.size_label);
    if (res.ee_sku) {
      await pool.query(
        `UPDATE ee_dispatch_po_lines SET ee_sku=?, resolve_source=?, unit_cost=?, mrp=? WHERE id=?`,
        [res.ee_sku, res.source, res.cost, res.mrp, l.id]);
      fixed++;
    }
  }
  const [[b]] = await pool.query(
    `SELECT COUNT(*) AS blocked FROM ee_dispatch_po_lines WHERE batch_id=? AND ee_sku IS NULL`, [batchId]);
  await pool.query(
    `UPDATE ee_dispatch_po SET blocked_count=?, status=IF(?=0 AND status='blocked','draft',status) WHERE id=?`,
    [b.blocked, b.blocked, batchId]);
  return { fixed, stillBlocked: b.blocked };
}

// ── Push: create the PO in EasyEcom (draft batches only) ─────────────────
async function pushBatch(batchId) {
  if (!pushEnabled()) throw new Error('EE_GRN_PUSH is not enabled on this environment.');
  const [[batch]] = await pool.query(`SELECT * FROM ee_dispatch_po WHERE id=?`, [batchId]);
  if (!batch) throw new Error('Batch not found');
  if (batch.status !== 'draft') throw new Error(`Batch is ${batch.status}, only draft batches can be pushed.`);

  const [lines] = await pool.query(
    `SELECT ee_sku, SUM(quantity) AS qty, MAX(unit_cost) AS cost
       FROM ee_dispatch_po_lines WHERE batch_id=? GROUP BY ee_sku`, [batchId]);
  if (lines.some(l => !l.ee_sku)) throw new Error('Batch has unresolved lines.');

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const body = {
    vendorId: EE_VENDOR_CODE,
    referenceCode: batch.batch_ref,
    docNumber: batch.batch_ref,
    address: 'Faridabad',
    expDeliveryDate: tomorrow,
    shippingCost: 0, createOrUpdate: 'I', isCancel: 0, updateTaxRate: 1,
    items: lines.map((l, i) => ({
      lineItemNumber: String(i + 1),
      sku: l.ee_sku,
      quantity: String(l.qty),
      unitPrice: Number(l.cost) || 0,
      taxRate: '0', taxValue: 0, taxType: 1,
    })),
  };
  const resp = await eeCall('POST', '/WMS/Cart/CreatePurchaseOrder', body);
  const poId = resp?.data?.poId || resp?.data?.po_id;
  if (resp?.code !== 200 || !poId) {
    const msg = (resp?.message || '') + ' ' + (typeof resp?.data === 'string' ? resp.data : '');
    await pool.query(`UPDATE ee_dispatch_po SET status='failed', error=? WHERE id=?`, [msg.slice(0, 500), batchId]);
    throw new Error('PO creation failed: ' + msg.slice(0, 200));
  }
  await pool.query(
    `UPDATE ee_dispatch_po SET status='pushed', po_id=?, error=NULL, pushed_at=NOW() WHERE id=?`,
    [poId, batchId]);
  return { poId, batchRef: batch.batch_ref, lines: lines.length };
}

// ── Confirmation: detect the warehouse's manual GRN against our POs ──────
async function confirmGrns() {
  const [pushed] = await pool.query(
    `SELECT id, po_id FROM ee_dispatch_po WHERE status='pushed' AND po_id IS NOT NULL`);
  if (!pushed.length) return { checked: 0, confirmed: 0 };
  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const resp = await eeCall('GET', `/Grn/V2/getGrnDetails?created_after=${since}`);
  const grns = Array.isArray(resp?.data) ? resp.data : [];
  const byPo = new Map();
  for (const g of grns) if (g.po_id) byPo.set(String(g.po_id), g);
  let confirmed = 0;
  for (const b of pushed) {
    const g = byPo.get(String(b.po_id));
    if (g) {
      const done = String(g.grn_status || '').toLowerCase() === 'completed';
      await pool.query(
        `UPDATE ee_dispatch_po
            SET grn_id=?, grn_status=?, status=IF(?, 'confirmed', status),
                confirmed_at=IF(?, NOW(), confirmed_at)
          WHERE id=?`,
        [g.grn_id || null, g.grn_status || null, done, done, b.id]);
      if (done) confirmed++;
    }
  }
  return { checked: pushed.length, confirmed };
}

module.exports = { buildBatch, reResolveBatch, pushBatch, confirmGrns, pushEnabled, FARIDABAD_WAREHOUSE_ID, EE_PO_SINCE };
