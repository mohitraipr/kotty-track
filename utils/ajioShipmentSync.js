// Ajio shipment reconciliation: pulls printed/shipped orders from EasyEcom
// across both warehouses (Faridabad, Delhi) and upserts into ee_shipments.
//
// Why this exists: discovery showed `awb_number` is never present in the
// EasyEcom order webhook payload, so the only way to learn an AWB is to ask
// the orders API after a label has been printed.

const axios = require('axios');
const { pool } = require('../config/db');

const EASYECOM_API_BASE = global.env?.EASYECOM_API_BASE || process.env.EASYECOM_API_BASE || 'https://api.easyecom.io';

// Reuse same warehouse credentials as the returns client.
const WAREHOUSES = [
  {
    key: 'faridabad',
    email: global.env?.EASYECOM_EMAIL || process.env.EASYECOM_EMAIL || '',
    password: global.env?.EASYECOM_PASSWORD || process.env.EASYECOM_PASSWORD || '',
    warehouse_id: 173983,
  },
  {
    key: 'delhi',
    email: global.env?.EASYECOM_DELHI_EMAIL || process.env.EASYECOM_DELHI_EMAIL || '',
    password: global.env?.EASYECOM_DELHI_PASSWORD || process.env.EASYECOM_DELHI_PASSWORD || '',
    warehouse_id: 176318,
  },
];

const STATUS_FILTERS = ['Printed', 'Shipped']; // statuses that can carry an AWB
const LOOKBACK_DAYS = parseInt(process.env.AJIO_RECON_LOOKBACK_DAYS || '7', 10);

// Token cache per warehouse (mirrors easyecomReturnsClient pattern)
const tokenCache = {};

async function getToken(wh) {
  const cached = tokenCache[wh.key];
  if (cached?.token && cached.expiry > Date.now()) return cached.token;
  if (!wh.email || !wh.password) return null;

  try {
    const { data } = await axios.post(
      `${EASYECOM_API_BASE}/getApiToken`,
      { email: wh.email, password: wh.password },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const token = data?.data?.jwt_token || data?.jwt_token || data?.token;
    if (!token) return null;
    tokenCache[wh.key] = { token, expiry: Date.now() + 23 * 60 * 60 * 1000 };
    return token;
  } catch (err) {
    console.error(`[ajioRecon] auth failed for ${wh.key}:`, err.response?.data || err.message);
    return null;
  }
}

function fmtDate(d) {
  // EasyEcom expects YYYY-MM-DD HH:MM:SS
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// EasyEcom V2 list endpoint. EasyEcom enforces a max 7-day window per call
// and returns errors in the body shape { code, message, data }.
async function fetchOrdersPage(token, { status, fromDate, toDate, cursor }) {
  const url = `${EASYECOM_API_BASE}/orders/V2/getAllOrders`;
  const params = {
    order_status: status,
    start_date: fmtDate(fromDate),
    end_date: fmtDate(toDate),
  };
  if (cursor) params.cursor = cursor;

  const { data } = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    timeout: 60000,
  });

  // EasyEcom signals errors via body.code rather than HTTP status.
  if (data && typeof data.code === 'number' && data.code >= 400) {
    throw new Error(`EasyEcom ${data.code}: ${data.message}`);
  }

  const payload = data?.data ?? data ?? {};
  const orders = Array.isArray(payload)
    ? payload
    : (payload.orders || payload.data || payload.results || []);
  const nextCursor = (payload && !Array.isArray(payload))
    ? (payload.next_cursor || payload.cursor || payload.nextCursor || null)
    : null;
  return { orders: Array.isArray(orders) ? orders : [], nextCursor };
}

// Build ≤7-day chunks counting backwards from `to`. Last chunk may be shorter.
function buildDateChunks(lookbackDays, chunkDays = 6) {
  const chunks = [];
  let to = new Date();
  const earliest = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  while (to > earliest) {
    const from = new Date(Math.max(earliest.getTime(), to.getTime() - chunkDays * 24 * 60 * 60 * 1000));
    chunks.push({ from, to });
    to = from;
  }
  return chunks;
}

function isAjio(order) {
  const m = (order.marketplace || order.channel || '').toLowerCase();
  return m.includes('ajio');
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function extractAwb(order) {
  const direct = pickFirst(order.awb_number, order.awbNumber, order.awb);
  if (direct) return String(direct).trim();
  if (Array.isArray(order.suborders)) {
    const sub = pickFirst(...order.suborders.map((s) => s?.awb_number));
    if (sub) return String(sub).trim();
  }
  return null;
}

function buildShipmentRow(order, warehouseFallback) {
  const awb = extractAwb(order);
  if (!awb) return null;
  const status = order.order_status || null;
  return {
    awb,
    order_id: order.order_id,
    invoice_id: order.invoice_id || null,
    reference_code: order.reference_code || null,
    marketplace: order.marketplace || 'Ajio',
    marketplace_id: order.marketplace_id || null,
    warehouse_id: order.warehouseId || order.import_warehouse_id || warehouseFallback,
    courier_name: pickFirst(order.courier_aggregator_name, order.courier_name, order.courier),
    manifest_id: pickFirst(order.manifest_id, order.manifestId),
    tracking_url: pickFirst(order.tracking_url, order.track_url),
    label_status: status && /print/i.test(status) ? status : null,
    current_status: status,
    order_status_id: order.order_status_id || null,
    label_printed_at: pickFirst(order.label_printed_at, order.print_date, order.label_print_date)
      || (status && /print/i.test(status) ? order.last_update_date : null),
    dispatched_at: pickFirst(order.dispatched_date, order.dispatch_date, order.shipped_date)
      || (status && /shipp|dispatch|manifest/i.test(status) ? order.last_update_date : null),
    delivered_at: status && /delivered/i.test(status) ? order.last_update_date : null,
    rto_at: status && /rto|return/i.test(status) ? order.last_update_date : null,
    last_seen_at: order.last_update_date || null,
    raw: JSON.stringify(order),
  };
}

async function upsertShipments(rows) {
  if (!rows.length) return 0;
  const values = rows.map((s) => [
    s.awb, s.order_id, s.invoice_id, s.reference_code, s.marketplace, s.marketplace_id,
    s.warehouse_id, s.courier_name, s.manifest_id, s.tracking_url, s.label_status,
    s.current_status, s.order_status_id, s.label_printed_at, s.dispatched_at,
    s.delivered_at, s.rto_at, s.last_seen_at, 'reconcile', s.raw,
  ]);
  await pool.query(
    `INSERT INTO ee_shipments
       (awb, order_id, invoice_id, reference_code, marketplace, marketplace_id,
        warehouse_id, courier_name, manifest_id, tracking_url, label_status,
        current_status, order_status_id, label_printed_at, dispatched_at,
        delivered_at, rto_at, last_seen_at, source, raw)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       order_id = VALUES(order_id),
       invoice_id = COALESCE(VALUES(invoice_id), invoice_id),
       reference_code = COALESCE(VALUES(reference_code), reference_code),
       marketplace = COALESCE(VALUES(marketplace), marketplace),
       marketplace_id = COALESCE(VALUES(marketplace_id), marketplace_id),
       warehouse_id = COALESCE(VALUES(warehouse_id), warehouse_id),
       courier_name = COALESCE(VALUES(courier_name), courier_name),
       manifest_id = COALESCE(VALUES(manifest_id), manifest_id),
       tracking_url = COALESCE(VALUES(tracking_url), tracking_url),
       label_status = COALESCE(VALUES(label_status), label_status),
       current_status = VALUES(current_status),
       order_status_id = COALESCE(VALUES(order_status_id), order_status_id),
       label_printed_at = COALESCE(ee_shipments.label_printed_at, VALUES(label_printed_at)),
       dispatched_at   = COALESCE(ee_shipments.dispatched_at,   VALUES(dispatched_at)),
       delivered_at    = COALESCE(ee_shipments.delivered_at,    VALUES(delivered_at)),
       rto_at          = COALESCE(ee_shipments.rto_at,          VALUES(rto_at)),
       last_seen_at = VALUES(last_seen_at),
       raw = VALUES(raw)`,
    [values]
  );
  return values.length;
}

async function syncWarehouse(wh, { lookbackDays = LOOKBACK_DAYS } = {}) {
  const token = await getToken(wh);
  if (!token) return { warehouse: wh.key, fetched: 0, ajio: 0, withAwb: 0, upserted: 0, skipped: 'no_token' };

  const chunks = buildDateChunks(lookbackDays, 6);

  let fetched = 0;
  let ajioCount = 0;
  let withAwb = 0;
  const rowsToUpsert = [];

  for (const status of STATUS_FILTERS) {
    for (const { from, to } of chunks) {
      let cursor = null;
      let pages = 0;
      do {
        let page;
        try {
          page = await fetchOrdersPage(token, { status, fromDate: from, toDate: to, cursor });
        } catch (err) {
          console.error(`[ajioRecon] ${wh.key} ${status} ${fmtDate(from)}..${fmtDate(to)} error:`, err.response?.data || err.message);
          break;
        }
        fetched += page.orders.length;
        for (const o of page.orders) {
          if (!isAjio(o)) continue;
          ajioCount++;
          const row = buildShipmentRow(o, wh.warehouse_id);
          if (row) {
            withAwb++;
            rowsToUpsert.push(row);
          }
        }
        cursor = page.nextCursor;
        pages++;
        if (pages > 200) break; // safety cap
      } while (cursor);
    }
  }

  // Dedup within a single run on awb
  const dedup = Array.from(new Map(rowsToUpsert.map((r) => [r.awb, r])).values());
  const upserted = await upsertShipments(dedup);
  return { warehouse: wh.key, fetched, ajio: ajioCount, withAwb, upserted, chunks: chunks.length };
}

async function syncAjioShipments(opts = {}) {
  const startedAt = Date.now();
  const results = [];
  for (const wh of WAREHOUSES) {
    try {
      const r = await syncWarehouse(wh, opts);
      results.push(r);
    } catch (err) {
      console.error(`[ajioRecon] ${wh.key} sync failed:`, err.message);
      results.push({ warehouse: wh.key, error: err.message });
    }
  }
  const tookMs = Date.now() - startedAt;
  console.log(`[ajioRecon] done in ${tookMs}ms`, results);
  return { tookMs, results };
}

// Debug helper: hit EasyEcom once for one warehouse + status, return the
// raw response so we can see the actual response shape.
async function debugFetchOnce({ warehouse = 'faridabad', status = 'Printed', lookbackDays = 30, urlOverride, method = 'GET' } = {}) {
  const wh = WAREHOUSES.find((w) => w.key === warehouse);
  if (!wh) throw new Error(`unknown warehouse: ${warehouse}`);
  const token = await getToken(wh);
  if (!token) return { error: 'no_token', warehouse };

  const toDate = new Date();
  const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const candidates = urlOverride
    ? [urlOverride]
    : [
        `${EASYECOM_API_BASE}/orders/V2/getAllOrders`,
        `${EASYECOM_API_BASE}/Orders/V2/getAllOrders`,
        `${EASYECOM_API_BASE}/orders/getAllOrders`,
        `${EASYECOM_API_BASE}/orders`,
      ];

  const params = {
    order_status: status,
    status,
    start_date: fmtDate(fromDate),
    end_date: fmtDate(toDate),
    from_date: fmtDate(fromDate),
    to_date: fmtDate(toDate),
  };

  const attempts = [];
  for (const url of candidates) {
    try {
      const config = {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      };
      const resp = method === 'POST'
        ? await axios.post(url, params, config)
        : await axios.get(url, { ...config, params });
      attempts.push({
        url,
        method,
        status: resp.status,
        sentParams: method === 'POST' ? params : params,
        responseKeys: Object.keys(resp.data || {}),
        sample: JSON.stringify(resp.data).slice(0, 4000),
      });
    } catch (err) {
      attempts.push({
        url,
        method,
        error: err.message,
        responseStatus: err.response?.status,
        responseData: err.response?.data ? JSON.stringify(err.response.data).slice(0, 1500) : null,
      });
    }
  }
  return { warehouse, status, fromDate: fmtDate(fromDate), toDate: fmtDate(toDate), attempts };
}

module.exports = { syncAjioShipments, syncWarehouse, debugFetchOnce };
