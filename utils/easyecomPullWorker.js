// utils/easyecomPullWorker.js
//
// Nightly pull worker using EasyEcom V2.1 native endpoints:
//   1) Snapshot CSV ingestion         (replaces daily getInventoryDetailsV3 polling)
//   2) Orders                          (getAllOrders, cursor-paged)
//   3) MINI_SALES_REPORT               (sales cross-check vs orders)
//   4) STATUS_WISE_STOCK_REPORT        (sellable vs reserved/hold/damaged)
//   5) INVENTORY_AGING_REPORT          (true dead-stock signal)
//   6) Product Master (Sundays only)   (style/SKU catalog with custom fields)
// Each step is independent — failure of one does not abort the others.

const axios = require('axios');
const {
  authenticateWithCredentials,
  listInventorySnapshots,
  downloadSnapshotCsv,
  parseCsv,
  fetchMiniSalesReport,
  fetchInventoryAgingReport,
  fetchStatusWiseStockReport,
  getProductMaster,
} = require('./easyecomReturnsClient');
const { recomputeAllHealth } = require('./easyecomAnalytics');
const { reconcileDispatchReflection } = require('./dispatchReflection');

const EASYECOM_API_BASE = global.env?.EASYECOM_API_BASE || process.env.EASYECOM_API_BASE || 'https://api.easyecom.io';
const EASYECOM_API_KEY = global.env?.EASYECOM_API_KEY || process.env.EASYECOM_API_KEY || '';

// EasyEcom c_id (warehouse) → credential key in easyecomReturnsClient.
const WAREHOUSE_KEY_BY_ID = {
  173983: 'faridabad',
  176318: 'delhi',
};

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pickField(row, candidates) {
  for (const k of candidates) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
    const lower = Object.keys(row).find(rk => rk.toLowerCase() === k.toLowerCase());
    if (lower && row[lower] !== undefined) return row[lower];
  }
  return null;
}

async function logStep(pool, runStartedAt, step, status, message, durationMs) {
  try {
    await pool.query(
      `INSERT INTO pm_pull_runs (run_started_at, step, status, message, duration_ms)
       VALUES (?, ?, ?, ?, ?)`,
      [runStartedAt, step, status, String(message || '').slice(0, 2000), durationMs]
    );
  } catch (err) {
    console.error('[pullWorker] logStep failed:', err.message);
  }
}

// Overall wall-clock budget for one run. Cloud Run kills the request at 1800s
// (the catch-up self-call awaits runPullWorker synchronously), so we stop starting
// new heavy EasyEcom steps well before that and log what we skipped — never let a
// slow step silently truncate the rest of the pull.
const RUN_DEADLINE_MS = Number(process.env.PM_PULL_RUN_DEADLINE_MS || 1500000); // 25 min

// Bound a single step so one stuck EasyEcom call can't consume the whole run budget.
// Rejects with a labelled timeout; the caller's try/catch logs it like any other failure.
function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s deadline`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function isBootstrap(pool) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS c FROM pm_pull_runs WHERE status = 'ok'`
  );
  return Number(row?.c || 0) === 0;
}

async function listDistinctWarehouses(pool) {
  const [rows] = await pool.query(
    `SELECT DISTINCT warehouse_id FROM ee_user_warehouses WHERE warehouse_id IS NOT NULL`
  );
  return rows.map((r) => Number(r.warehouse_id)).filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────
// Step 1 — Inventory snapshot ingestion (PRIMARY-location, account-wide)
// ────────────────────────────────────────────────────────────────────
//
// EasyEcom's Inventory Snapshot is an ACCOUNT-LEVEL report owned by the PRIMARY
// location ("Kotty Lifestyle", c_id 173969). A single daily CSV covers every
// warehouse; each row carries a `Company Token` (= a secondary location_key) that
// we map back to our warehouse_id. Authenticating against a secondary warehouse
// returns an empty snapshot, so this MUST run against the primary location.

const PRIMARY_SNAPSHOT_C_ID = 173969; // bookkeeping marker for ee_snapshot_files
const WAREHOUSE_ID_BY_LOCATION_KEY = {
  ee30270084289: 173983, // Faridabad
  en31088037124: 176318, // Delhi
};

// EasyEcom guards text cells with a leading backtick (Excel-injection guard); some
// values also carry a trailing comma. Strip both before using the SKU.
function cleanCsvSku(v) {
  return String(v == null ? '' : v).replace(/`/g, '').replace(/,+\s*$/, '').trim().toUpperCase();
}

async function pullSnapshotsFromPrimary(pool, runStartedAt, windowDays) {
  const stepStart = Date.now();
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const startStr = `${ymd(start)} 00:00:00`;
  const endStr = `${ymd(end)} 23:59:59`;

  let files;
  try {
    files = await listInventorySnapshots({ startDate: startStr, endDate: endStr }, 'primary');
  } catch (err) {
    console.error('[pullWorker] snapshot list (primary) failed:', err.message);
    await logStep(pool, runStartedAt, 'snapshot', 'error', `list: ${err.message}`, Date.now() - stepStart);
    return;
  }
  if (!files.length) {
    await logStep(pool, runStartedAt, 'snapshot', 'partial',
      `No snapshot files for ${startStr}..${endStr}`, Date.now() - stepStart);
    return;
  }

  // Skip files we've already ingested (tracked under the primary c_id).
  const [existing] = await pool.query(
    `SELECT entry_date FROM ee_snapshot_files WHERE warehouse_id = ?`, [PRIMARY_SNAPSHOT_C_ID]
  );
  const have = new Set(existing.map(r => new Date(r.entry_date).toISOString().slice(0, 19)));

  let newFiles = 0;
  let totalRows = 0;
  let skippedRows = 0;
  let latestDate = null;
  let latestHealth = [];

  for (const f of files) {
    const entryDateStr = String(f.entry_date).slice(0, 19).replace('T', ' ');
    const isoKey = new Date(entryDateStr).toISOString().slice(0, 19);
    if (have.has(isoKey)) continue;
    const snapshotDate = entryDateStr.slice(0, 10);

    let csvText;
    try {
      csvText = await downloadSnapshotCsv(f.file_url);
    } catch (err) {
      console.error(`[pullWorker] snapshot CSV download failed (${entryDateStr}):`, err.message);
      continue;
    }
    const rows = parseCsv(csvText);
    const upsertRows = [];
    const healthRows = [];
    for (const r of rows) {
      const locKey = String(pickField(r, ['Company Token', 'company_token', 'companytoken']) || '').trim();
      const warehouseId = WAREHOUSE_ID_BY_LOCATION_KEY[locKey];
      if (!warehouseId) { skippedRows++; continue; } // not one of our two warehouses
      const sku = cleanCsvSku(pickField(r, ['SKU', 'sku', 'Product Code']));
      if (!sku) continue;
      const qty = Number(pickField(r, ['Available Quantity', 'available', 'Available', 'availableInventory'])) || 0;
      upsertRows.push([sku, warehouseId, snapshotDate, qty]);
      healthRows.push([sku, warehouseId, qty]);
    }

    // Chunk inserts of 1000 to keep packet size sane.
    for (let i = 0; i < upsertRows.length; i += 1000) {
      const chunk = upsertRows.slice(i, i + 1000);
      await pool.query(
        `INSERT INTO ee_inventory_daily_snapshot (sku, warehouse_id, snapshot_date, qty)
         VALUES ?
         ON DUPLICATE KEY UPDATE qty = VALUES(qty)`,
        [chunk]
      );
    }

    await pool.query(
      `INSERT INTO ee_snapshot_files (warehouse_id, entry_date, file_url, row_count)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE row_count = VALUES(row_count), ingested_at = CURRENT_TIMESTAMP`,
      [PRIMARY_SNAPSHOT_C_ID, entryDateStr, f.file_url, upsertRows.length]
    );

    newFiles++;
    totalRows += upsertRows.length;
    if (!latestDate || entryDateStr > latestDate) {
      latestDate = entryDateStr;
      latestHealth = healthRows;
    }
  }

  // Push the latest snapshot into ee_inventory_health.inventory so the dashboard's
  // "current SOH" matches the most recent close-of-business.
  if (latestHealth.length) {
    for (let i = 0; i < latestHealth.length; i += 500) {
      const chunk = latestHealth.slice(i, i + 500);
      const placeholders = chunk.map(() => '(?, ?, ?, ?)').join(',');
      const values = [];
      for (const [sku, wh, qty] of chunk) values.push(sku, wh, qty, 'green');
      await pool.query(
        `INSERT INTO ee_inventory_health (sku, warehouse_id, inventory, status)
         VALUES ${placeholders}
         ON DUPLICATE KEY UPDATE inventory = VALUES(inventory), updated_at = CURRENT_TIMESTAMP`,
        values
      );
    }
  }

  await logStep(pool, runStartedAt, 'snapshot', 'ok',
    `files_new=${newFiles}/${files.length} rows=${totalRows} skipped=${skippedRows} latest=${latestDate || 'n/a'}`,
    Date.now() - stepStart);
}

// ────────────────────────────────────────────────────────────────────
// Step 2 — Orders (getAllOrders)
// ────────────────────────────────────────────────────────────────────

// EasyEcom enforces a max 7-day window per call to /orders/V2/getAllOrders.
// We chunk the requested window into 7-day pieces and concatenate results.
async function pullOrders(pool, runStartedAt, bootstrapMode) {
  const stepStart = Date.now();
  const windowDays = bootstrapMode ? 30 : 3;
  const CHUNK_DAYS = 7;
  const now = new Date();

  // Build a list of [chunkStart, chunkEnd] covering windowDays back from now.
  const chunks = [];
  let cursor = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  while (cursor < now) {
    const chunkEnd = new Date(Math.min(cursor.getTime() + CHUNK_DAYS * 24 * 60 * 60 * 1000, now.getTime()));
    chunks.push([
      `${ymd(cursor)} 00:00:00`,
      `${ymd(new Date(chunkEnd.getTime() - 1))} 23:59:59`,
    ]);
    cursor = new Date(chunkEnd.getTime());
  }

  let totalOrders = 0;
  let totalSubs = 0;

  for (const [warehouseIdStr, warehouseKey] of Object.entries(WAREHOUSE_KEY_BY_ID)) {
    for (const [startStr, endStr] of chunks) {
      try {
        const counts = await pullOrdersForWarehouse(pool, warehouseKey, Number(warehouseIdStr), startStr, endStr);
        totalOrders += counts.orders;
        totalSubs += counts.subs;
      } catch (err) {
        console.error(`[pullWorker] orders pull failed for ${warehouseKey} ${startStr}..${endStr}:`, err.message);
        await logStep(pool, runStartedAt, `orders:${warehouseKey}`, 'error',
          `${startStr}..${endStr}: ${err.message}`, Date.now() - stepStart);
      }
    }
  }
  await logStep(pool, runStartedAt, 'orders', 'ok',
    `mode=${bootstrapMode ? 'bootstrap' : 'steady'} window=${windowDays}d chunks=${chunks.length} orders=${totalOrders} subs=${totalSubs}`,
    Date.now() - stepStart);
}

async function pullOrdersForWarehouse(pool, warehouseKey, warehouseId, startStr, endStr) {
  const token = await authenticateWithCredentials(warehouseKey);
  if (!token) throw new Error(`auth failed for ${warehouseKey}`);

  const api = axios.create({
    baseURL: EASYECOM_API_BASE,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(EASYECOM_API_KEY ? { 'x-api-key': EASYECOM_API_KEY } : {}) },
    timeout: 120000,
  });

  let nextUrl = null;
  let orderCount = 0;
  let subCount = 0;
  const params = { order_status: 'all', start_date: startStr, end_date: endStr };

  do {
    let resp;
    try {
      resp = nextUrl ? await api.get(nextUrl) : await api.get('/orders/V2/getAllOrders', { params });
    } catch (err) {
      if (err.response?.status === 404 && nextUrl) break;
      throw err;
    }
    const data = resp.data?.data || {};
    const orders = data.orders || data.invoices || [];
    nextUrl = data.nextUrl || null;
    if (!orders.length) break;
    const counts = await persistOrderBatch(pool, orders, warehouseId);
    orderCount += counts.orders;
    subCount += counts.subs;
    if (nextUrl) await new Promise((r) => setTimeout(r, 300));
  } while (nextUrl);

  return { orders: orderCount, subs: subCount };
}

async function persistOrderBatch(pool, orders, fallbackWarehouseId) {
  const orderRows = [];
  const subRows = [];

  for (const order of orders) {
    if (!order || !order.order_id) continue;
    const warehouseId = order.warehouseId || order.import_warehouse_id || fallbackWarehouseId || null;
    orderRows.push([
      order.order_id, order.invoice_id || null, order.reference_code || null,
      order.company_name || null, order.marketplace || null, order.marketplace_id || null,
      warehouseId, order.location_key || null, order.order_status || null,
      order.order_status_id || null, order.order_date || null, order.import_date || null,
      order.tat || null, order.last_update_date || null, order.total_amount || null,
      order.total_tax || null, order.total_shipping_charge || null, order.total_discount || null,
      order.collectable_amount || null, order.order_quantity || null,
    ]);
    if (Array.isArray(order.suborders)) {
      for (const sub of order.suborders) {
        if (!sub || !sub.suborder_id) continue;
        subRows.push([
          order.order_id, sub.suborder_id, (sub.sku || '').toUpperCase(),
          sub.marketplace_sku || null, sub.product_id || null, sub.company_product_id || null,
          sub.suborder_quantity || sub.item_quantity || null, sub.selling_price || null,
          sub.tax || null, sub.tax_rate || null, sub.item_status || null,
          sub.shipment_type || null, sub.size || null, sub.brand || null,
          sub.category || null, sub.productName || sub.product_name || null,
          warehouseId, order.marketplace_id || null, order.order_date || null,
        ]);
      }
    }
  }

  if (orderRows.length) {
    await pool.query(
      `INSERT INTO ee_orders
        (order_id, invoice_id, reference_code, company_name, marketplace, marketplace_id, warehouse_id, location_key, order_status, order_status_id, order_date, import_date, tat, last_update_date, total_amount, total_tax, total_shipping_charge, total_discount, collectable_amount, order_quantity)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        invoice_id = VALUES(invoice_id), reference_code = VALUES(reference_code), company_name = VALUES(company_name),
        marketplace = VALUES(marketplace), marketplace_id = VALUES(marketplace_id), warehouse_id = VALUES(warehouse_id),
        location_key = VALUES(location_key), order_status = VALUES(order_status), order_status_id = VALUES(order_status_id),
        order_date = VALUES(order_date), import_date = VALUES(import_date), tat = VALUES(tat),
        last_update_date = VALUES(last_update_date), total_amount = VALUES(total_amount), total_tax = VALUES(total_tax),
        total_shipping_charge = VALUES(total_shipping_charge), total_discount = VALUES(total_discount),
        collectable_amount = VALUES(collectable_amount), order_quantity = VALUES(order_quantity),
        updated_at = CURRENT_TIMESTAMP`,
      [orderRows]
    );
  }
  if (subRows.length) {
    await pool.query(
      `INSERT INTO ee_suborders
        (order_id, suborder_id, sku, marketplace_sku, product_id, company_product_id, quantity, selling_price, tax, tax_rate, status, shipment_type, size, brand, category, product_name, warehouse_id, marketplace_id, order_date)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        sku = VALUES(sku), marketplace_sku = VALUES(marketplace_sku), product_id = VALUES(product_id),
        company_product_id = VALUES(company_product_id), quantity = VALUES(quantity), selling_price = VALUES(selling_price),
        tax = VALUES(tax), tax_rate = VALUES(tax_rate), status = VALUES(status), shipment_type = VALUES(shipment_type),
        size = VALUES(size), brand = VALUES(brand), category = VALUES(category), product_name = VALUES(product_name),
        warehouse_id = VALUES(warehouse_id), marketplace_id = VALUES(marketplace_id), order_date = VALUES(order_date),
        updated_at = CURRENT_TIMESTAMP`,
      [subRows]
    );
  }
  return { orders: orderRows.length, subs: subRows.length };
}

// ────────────────────────────────────────────────────────────────────
// Step 3 — MINI_SALES_REPORT  (per-day per-SKU sales for cross-check)
// ────────────────────────────────────────────────────────────────────

// Aggregate one downloaded mini-sales report (per suborder LINE) to (sku, sale_date)
// rows for ee_sales_daily, dropping cancellations. Kept as a helper so each 7-day
// chunk is parsed, reduced, and released before the next — bounds memory.
function aggregateMiniSales(rows, warehouseId) {
  const agg = new Map();
  for (const r of rows) {
    const status = String(pickField(r, ['Order Status', 'order_status']) || '');
    if (/cancel/i.test(status)) continue;
    const sku = pickField(r, ['SKU', 'sku', 'Product Code']);
    const dateStr = pickField(r, ['Order Date', 'order_date', 'Invoice Date', 'invoice_date', 'date']);
    if (!sku || !dateStr) continue;
    const qty = Number(pickField(r, ['Item Quantity', 'Suborder Quantity', 'quantity', 'qty', 'Quantity'])) || 0;
    const rev = Number(pickField(r, ['Selling Price', 'total_amount', 'amount', 'Revenue'])) || 0;
    const saleDate = String(dateStr).slice(0, 10);
    const key = String(sku).toUpperCase() + '|' + saleDate;
    const cur = agg.get(key) || { sku: String(sku).toUpperCase(), saleDate, qty: 0, rev: 0 };
    cur.qty += qty; cur.rev += rev;
    agg.set(key, cur);
  }
  return [...agg.values()].map((a) => [a.sku, warehouseId, a.saleDate, a.qty, a.rev || null, 'mini_sales_report']);
}

async function pullMiniSalesReport(pool, runStartedAt, windowDays) {
  const stepStart = Date.now();
  const MS_DAY = 24 * 60 * 60 * 1000;
  // EasyEcom allows only ONE pending MINI_SALES_REPORT per company at a time and
  // rejects a 2nd "of the same type ... in the last 2 hours". The old 7-day chunk
  // loop fired multiple reports per warehouse, which tripped that limit the moment
  // the window exceeded 7 days — so it could never catch up past a 7-day gap.
  // We now request the WHOLE window as a SINGLE report per warehouse, and size the
  // window to the actual gap so a multi-day freeze self-heals in one run.
  const MAX_WINDOW_DAYS = 45; // single-report cap (~225k rows; well within 1Gi)
  // Per-report poll cap. EasyEcom caps MINI_SALES at 1 report/company/2h, so a
  // queued report that won't bake just blocks; keep this short (×2 warehouses) so
  // the step fails fast instead of eating the whole run budget.
  const MINI_SALES_MAX_WAIT_MS = Number(process.env.PM_MINI_SALES_MAX_WAIT_MS || 180000); // 3 min
  const now = new Date();
  let totalRows = 0;

  // EasyEcom rejects a 2nd MINI_SALES of the same type within 2h, so attempting it
  // more often than that just wastes the poll budget. Skip if we tried in the last 2h.
  try {
    const [[recent]] = await pool.query(
      `SELECT MAX(run_started_at) AS last_try FROM pm_pull_runs
        WHERE step LIKE 'mini_sales:%' AND run_started_at >= NOW() - INTERVAL 2 HOUR`
    );
    if (recent && recent.last_try) {
      await logStep(pool, runStartedAt, 'mini_sales', 'partial',
        'skipped: attempted within last 2h (EasyEcom 1-report/2h cap)', Date.now() - stepStart);
      return;
    }
  } catch (_) { /* if the check fails, fall through and attempt the pull */ }

  let okCount = 0;
  let failCount = 0;
  for (const [warehouseIdStr, warehouseKey] of Object.entries(WAREHOUSE_KEY_BY_ID)) {
    const warehouseId = Number(warehouseIdStr);
    try {
      // Adaptive lookback: from the last sale we already have for THIS warehouse
      // (minus a 2-day overlap to re-settle late invoices), bounded to a sane max.
      let lookback = Math.max(Number(windowDays) || 3, 3);
      try {
        const [[row]] = await pool.query(
          `SELECT MAX(sale_date) AS latest FROM ee_sales_daily
           WHERE source = 'mini_sales_report' AND warehouse_id = ?`,
          [warehouseId]
        );
        if (row && row.latest) {
          const gapDays = Math.ceil((now - new Date(row.latest)) / MS_DAY) + 2;
          lookback = Math.min(Math.max(lookback, gapDays), MAX_WINDOW_DAYS);
        }
      } catch (_) { /* fall back to windowDays */ }

      const startDate = ymd(new Date(now.getTime() - (lookback - 1) * MS_DAY));
      const endDate = ymd(now);
      let rows = await fetchMiniSalesReport({ startDate, endDate, maxWaitMs: MINI_SALES_MAX_WAIT_MS }, warehouseKey);
      const upsert = aggregateMiniSales(rows, warehouseId);
      rows = null; // release the parsed report before the DB writes
      for (let i = 0; i < upsert.length; i += 1000) {
        await pool.query(
          `INSERT INTO ee_sales_daily (sku, warehouse_id, sale_date, qty, revenue, source)
           VALUES ?
           ON DUPLICATE KEY UPDATE qty = VALUES(qty), revenue = VALUES(revenue), synced_at = CURRENT_TIMESTAMP`,
          [upsert.slice(i, i + 1000)]
        );
      }
      totalRows += upsert.length;
      okCount += 1;
      await logStep(pool, runStartedAt, `mini_sales:${warehouseKey}`, 'ok',
        `window=${lookback}d rows=${upsert.length}`, Date.now() - stepStart);
    } catch (err) {
      failCount += 1;
      // Transient/expected conditions are logged as 'partial' (not 'error') so a
      // blip doesn't read as broken and the adaptive window backfills on the next
      // run that has quota:
      //  - "job pending of same type in last 2h" → another run is already fetching.
      //  - "Limit Exceeded" / 429 / rate limit → EasyEcom account rate cap (resets).
      const msg = String(err.response?.data?.message || err.message || '');
      const status = err.response?.status;
      const transient = status === 429
        || /already queued|job pending|same type|2 hours|limit exceeded|rate limit|too many/i.test(msg);
      console.error(`[pullWorker] mini sales report ${transient ? 'transient' : 'failed'} for ${warehouseKey}:`, msg);
      await logStep(pool, runStartedAt, `mini_sales:${warehouseKey}`, transient ? 'partial' : 'error',
        msg, Date.now() - stepStart);
    }
  }
  // Honest parent status: 'ok' only if a warehouse actually delivered; 'partial' when
  // some succeeded; 'error' when every warehouse failed (e.g. all rate-limited). Never
  // log 'ok rows=0' on a total failure — that masks a frozen feed in the freshness view.
  const parentStatus = okCount > 0 ? (failCount > 0 ? 'partial' : 'ok') : 'error';
  await logStep(pool, runStartedAt, 'mini_sales', parentStatus,
    `single-report rows=${totalRows} ok=${okCount} failed=${failCount}`, Date.now() - stepStart);
}

// ────────────────────────────────────────────────────────────────────
// Step 4 — Sales cross-check  (orders_api vs mini_sales_report, per day)
// ────────────────────────────────────────────────────────────────────

// Aggregate orders_api into ee_sales_daily. This is the FRESH (±5%) DRR source and
// must run right after pullOrders — independent of the rate-limited mini_sales step —
// so a stuck mini_sales report can never starve DRR of fresh sales.
async function aggregateOrdersIntoSales(pool, runStartedAt, windowDays) {
  const stepStart = Date.now();
  try {
    await pool.query(`
      INSERT INTO ee_sales_daily (sku, warehouse_id, sale_date, qty, revenue, source)
      SELECT
        es.sku,
        es.warehouse_id,
        DATE(es.order_date) AS sale_date,
        SUM(es.quantity) AS qty,
        SUM(es.selling_price * es.quantity) AS revenue,
        'orders_api'
      FROM ee_suborders es
      WHERE es.order_date >= (CURRENT_DATE - INTERVAL ? DAY)
        AND es.sku IS NOT NULL AND es.sku <> ''
        AND es.warehouse_id IS NOT NULL
      GROUP BY es.sku, es.warehouse_id, DATE(es.order_date)
      ON DUPLICATE KEY UPDATE qty = VALUES(qty), revenue = VALUES(revenue), synced_at = CURRENT_TIMESTAMP
    `, [windowDays]);
    await logStep(pool, runStartedAt, 'orders_aggregate', 'ok',
      `window=${windowDays}d`, Date.now() - stepStart);
  } catch (err) {
    console.error('[pullWorker] orders aggregate failed:', err.message);
    await logStep(pool, runStartedAt, 'orders_aggregate', 'error', err.message, Date.now() - stepStart);
  }
}

async function crossCheckSales(pool, runStartedAt, windowDays) {
  const stepStart = Date.now();
  try {
    // Compute per-day totals across SKUs, compare both sources, flag >2% delta.
    await pool.query(`
      INSERT INTO ee_sales_cross_check (check_date, warehouse_id, orders_api_qty, mini_sales_qty, delta_pct, flagged)
      SELECT
        d.sale_date,
        d.warehouse_id,
        SUM(CASE WHEN d.source = 'orders_api'        THEN d.qty ELSE 0 END) AS orders_api_qty,
        SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END) AS mini_sales_qty,
        CASE
          WHEN GREATEST(
                SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END),
                SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END)
              ) = 0 THEN 0
          ELSE ROUND(
            ABS(SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END)
              - SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END))
            * 100.0
            / GREATEST(
                SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END),
                SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END)
              ), 2)
        END AS delta_pct,
        CASE
          WHEN GREATEST(
                SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END),
                SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END)
              ) = 0 THEN 0
          WHEN ABS(SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END)
                 - SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END))
               * 100.0
               / GREATEST(
                   SUM(CASE WHEN d.source = 'orders_api' THEN d.qty ELSE 0 END),
                   SUM(CASE WHEN d.source = 'mini_sales_report' THEN d.qty ELSE 0 END)
                 ) > 2 THEN 1
          ELSE 0
        END AS flagged
      FROM ee_sales_daily d
      WHERE d.sale_date >= (CURRENT_DATE - INTERVAL ? DAY)
      GROUP BY d.sale_date, d.warehouse_id
      ON DUPLICATE KEY UPDATE
        orders_api_qty = VALUES(orders_api_qty),
        mini_sales_qty = VALUES(mini_sales_qty),
        delta_pct = VALUES(delta_pct),
        flagged = VALUES(flagged),
        checked_at = CURRENT_TIMESTAMP
    `, [windowDays]);

    const [[flaggedRow]] = await pool.query(
      `SELECT COUNT(*) AS c FROM ee_sales_cross_check
       WHERE check_date >= (CURRENT_DATE - INTERVAL ? DAY) AND flagged = 1`,
      [windowDays]
    );
    const flaggedCount = Number(flaggedRow?.c || 0);
    await logStep(pool, runStartedAt, 'sales_cross_check',
      flaggedCount > 0 ? 'partial' : 'ok',
      `window=${windowDays}d flagged_days=${flaggedCount}`,
      Date.now() - stepStart);
  } catch (err) {
    console.error('[pullWorker] sales cross-check failed:', err.message);
    await logStep(pool, runStartedAt, 'sales_cross_check', 'error', err.message, Date.now() - stepStart);
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 5 — STATUS_WISE_STOCK_REPORT  (Available vs Hold/Damaged/Reserved)
// ────────────────────────────────────────────────────────────────────

async function pullStatusWiseStock(pool, runStartedAt) {
  const stepStart = Date.now();
  let totalRows = 0;
  for (const [warehouseIdStr, warehouseKey] of Object.entries(WAREHOUSE_KEY_BY_ID)) {
    const warehouseId = Number(warehouseIdStr);
    try {
      const rows = await fetchStatusWiseStockReport(warehouseKey);
      const upsert = [];
      for (const r of rows) {
        const sku = pickField(r, ['sku', 'SKU', 'Product Code']);
        const status = pickField(r, ['status', 'Status', 'Inventory Status', 'inventory_status']);
        const qty = Number(pickField(r, ['qty', 'Quantity', 'Available Quantity', 'count'])) || 0;
        if (!sku || !status) continue;
        upsert.push([String(sku).toUpperCase(), warehouseId, String(status).trim(), qty]);
      }
      if (upsert.length) {
        for (let i = 0; i < upsert.length; i += 1000) {
          const chunk = upsert.slice(i, i + 1000);
          await pool.query(
            `INSERT INTO ee_stock_status (sku, warehouse_id, status, qty)
             VALUES ?
             ON DUPLICATE KEY UPDATE qty = VALUES(qty), captured_at = CURRENT_TIMESTAMP`,
            [chunk]
          );
        }
      }
      totalRows += upsert.length;
    } catch (err) {
      console.error(`[pullWorker] stock-status report failed for ${warehouseKey}:`, err.message);
      await logStep(pool, runStartedAt, `stock_status:${warehouseKey}`, 'error', err.message, Date.now() - stepStart);
    }
  }
  await logStep(pool, runStartedAt, 'stock_status', 'ok', `rows=${totalRows}`, Date.now() - stepStart);
}

// ────────────────────────────────────────────────────────────────────
// Step 6 — INVENTORY_AGING_REPORT  (true dead-stock signal)
// ────────────────────────────────────────────────────────────────────

async function pullInventoryAging(pool, runStartedAt) {
  const stepStart = Date.now();
  // EasyEcom takes ~15–20 min to generate INVENTORY_AGING_REPORT for the secondary
  // warehouses. Poll longer than the 900s client default, and fetch the warehouses in
  // PARALLEL so two slow polls overlap instead of summing (sequential polling used to
  // blow the run budget and leave the 'aging' feed — hence the freshness banner — frozen).
  const reportWaitMs = Number(process.env.PM_PULL_AGING_REPORT_WAIT_MS || 1200000); // 20 min

  async function pullOneWarehouse(warehouseId, warehouseKey) {
    const rows = await fetchInventoryAgingReport(warehouseKey, { maxWaitMs: reportWaitMs });
    const upsert = [];
    for (const r of rows) {
      const sku = pickField(r, ['sku', 'SKU', 'Product Code']);
      const bucket = String(pickField(r, ['aging_bucket', 'Aging Bucket', 'bucket', 'Age Bucket', 'Days']) || 'unknown').trim();
      const qty = Number(pickField(r, ['qty', 'Quantity', 'count', 'Available Quantity'])) || 0;
      const avgAge = Number(pickField(r, ['avg_age_days', 'Avg Age Days', 'Average Age (Days)'])) || null;
      const oldest = Number(pickField(r, ['oldest_age_days', 'Oldest Age Days', 'Oldest (Days)'])) || null;
      if (!sku) continue;
      upsert.push([String(sku).toUpperCase(), warehouseId, bucket, qty, avgAge, oldest]);
    }
    for (let i = 0; i < upsert.length; i += 1000) {
      const chunk = upsert.slice(i, i + 1000);
      await pool.query(
        `INSERT INTO ee_inventory_aging (sku, warehouse_id, bucket, qty, avg_age_days, oldest_age_days)
         VALUES ?
         ON DUPLICATE KEY UPDATE qty = VALUES(qty),
           avg_age_days = VALUES(avg_age_days),
           oldest_age_days = VALUES(oldest_age_days),
           captured_at = CURRENT_TIMESTAMP`,
        [chunk]
      );
    }
    return upsert.length;
  }

  const warehouses = Object.entries(WAREHOUSE_KEY_BY_ID);
  const results = await Promise.allSettled(
    warehouses.map(([idStr, key]) => pullOneWarehouse(Number(idStr), key))
  );

  let totalRows = 0;
  let okCount = 0;
  const failed = [];
  for (let i = 0; i < warehouses.length; i += 1) {
    const [, warehouseKey] = warehouses[i];
    const res = results[i];
    if (res.status === 'fulfilled') {
      okCount += 1;
      totalRows += res.value;
    } else {
      const msg = (res.reason && res.reason.message) || String(res.reason);
      failed.push(warehouseKey);
      console.error(`[pullWorker] aging report failed for ${warehouseKey}:`, msg);
      // Per-warehouse failure logs 'partial' for observability; the parent step below
      // still logs 'ok' as long as at least one warehouse returned, so the freshness
      // banner (which reads status='ok') can advance.
      await logStep(pool, runStartedAt, `aging:${warehouseKey}`, 'partial', msg, Date.now() - stepStart);
    }
  }

  // Honest parent status: 'ok' if any warehouse returned data, else 'error' so the banner
  // correctly stays frozen only when we genuinely have no fresh aging data at all.
  const status = okCount > 0 ? 'ok' : 'error';
  const msg = `rows=${totalRows} warehouses_ok=${okCount}/${warehouses.length}` +
    (failed.length ? ` failed=${failed.join(',')}` : '');
  await logStep(pool, runStartedAt, 'aging', status, msg, Date.now() - stepStart);
}

// ────────────────────────────────────────────────────────────────────
// Step 7 — Product Master  (Sundays only; can be forced via opts.includeProducts)
// ────────────────────────────────────────────────────────────────────

async function pullProductMaster(pool, runStartedAt) {
  const stepStart = Date.now();
  let count = 0;
  try {
    // Master is account-wide; either warehouse credential works.
    for await (const p of getProductMaster('faridabad', { customFields: 1 })) {
      const sku = (p.sku || p.SKU || '').toString().toUpperCase();
      if (!sku) continue;
      await pool.query(
        `INSERT INTO ee_product_master
          (sku, product_id, cp_id, product_name, style, description, active, custom_fields, ee_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
          product_id = VALUES(product_id), cp_id = VALUES(cp_id), product_name = VALUES(product_name),
          style = VALUES(style), description = VALUES(description), active = VALUES(active),
          custom_fields = VALUES(custom_fields), ee_updated_at = VALUES(ee_updated_at),
          synced_at = CURRENT_TIMESTAMP`,
        [
          sku,
          p.product_id || null,
          p.cp_id || null,
          p.product_name || null,
          p.style || p.style_code || null,
          p.description || null,
          p.active != null ? Number(p.active) : 1,
          p.custom_fields ? JSON.stringify(p.custom_fields) : null,
          p.updated_at || null,
        ]
      );
      count++;
    }
    await logStep(pool, runStartedAt, 'product_master', 'ok', `synced=${count}`, Date.now() - stepStart);
  } catch (err) {
    console.error('[pullWorker] product master sync failed:', err.message);
    await logStep(pool, runStartedAt, 'product_master', 'error', err.message, Date.now() - stepStart);
  }
}

// ────────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────────

async function runPullWorker(pool, { bootstrap = 'auto', includeProducts } = {}) {
  const runStartedAt = new Date();
  const overallStart = Date.now();
  console.log('[pullWorker] starting run at', runStartedAt.toISOString());

  let bootstrapMode = false;
  try {
    bootstrapMode = bootstrap === true || (bootstrap === 'auto' && await isBootstrap(pool));
  } catch (err) {
    console.error('[pullWorker] bootstrap check failed:', err.message);
  }
  const windowDays = bootstrapMode ? 30 : 3;
  const isSunday = runStartedAt.getDay() === 0;

  // Auth health gate: one upfront /access/token check. If EasyEcom auth is unavailable
  // (rate-block / outage), skip the EasyEcom pulls this run so we don't re-hammer a
  // blocked account — the client's circuit breaker backs off, and the DB-only steps
  // (cross-check, health recompute) still run. 'primary' shares creds with faridabad;
  // if it can't auth, the others won't either.
  let authOk = false;
  try { authOk = !!(await authenticateWithCredentials('primary')); }
  catch (_) { authOk = false; }
  if (!authOk) {
    await logStep(pool, runStartedAt, 'auth', 'error',
      'easyecom auth unavailable — skipping EasyEcom pulls this run', Date.now() - overallStart);
    console.warn('[pullWorker] EasyEcom auth unavailable — skipping pulls, DB-only steps only');
  }

  // Per-step wall-clock cap; combined with the overall RUN_DEADLINE_MS guard this
  // guarantees no single stuck EasyEcom call can blow the 1800s Cloud Run timeout
  // (the catch-up self-call awaits this whole function).
  const STEP_DEADLINE_MS = Number(process.env.PM_PULL_STEP_DEADLINE_MS || 600000); // 10 min
  const elapsed = () => Date.now() - overallStart;
  // Run a self-logging EasyEcom step under a per-step deadline + overall budget guard.
  // The step fns log their own 'ok'/'error' lines; here we only log a 'partial' skip
  // when we're out of budget, or an 'error' if the step blows its deadline / throws.
  const eeStep = async (name, fn, deadlineMs = STEP_DEADLINE_MS) => {
    if (elapsed() > RUN_DEADLINE_MS) {
      await logStep(pool, runStartedAt, name, 'partial',
        `skipped: run deadline (${Math.round(elapsed() / 1000)}s elapsed)`, 0);
      return;
    }
    try { await withDeadline(Promise.resolve().then(fn), deadlineMs, name); }
    catch (err) { await logStep(pool, runStartedAt, name, 'error', err.message, 0); }
  };

  if (authOk) {
    // Inventory snapshots — account-wide, from the PRIMARY location. Bootstrap pulls a
    // deeper window so selling-days DRR has real history immediately (configurable).
    const snapshotWindowDays = bootstrapMode
      ? Number(process.env.EASYECOM_SNAPSHOT_BACKFILL_DAYS || global.env?.EASYECOM_SNAPSHOT_BACKFILL_DAYS || 60)
      : Math.max(windowDays, 3);

    // Order matters: the fast, high-value steps that do NOT depend on the rate-limited
    // mini_sales report run FIRST, so a stuck mini_sales can never starve DRR / stock.
    await eeStep('snapshot', () => pullSnapshotsFromPrimary(pool, runStartedAt, snapshotWindowDays));
    await eeStep('orders', () => pullOrders(pool, runStartedAt, bootstrapMode));
    // Aggregate orders → ee_sales_daily right away: this is the fresh (±5%) DRR source.
    await eeStep('orders_aggregate', () => aggregateOrdersIntoSales(pool, runStartedAt, windowDays));
    await eeStep('stock_status', () => pullStatusWiseStock(pool, runStartedAt));
    // Product Master — Sundays or when explicitly requested or on bootstrap.
    if (includeProducts || isSunday || bootstrapMode) {
      await eeStep('product_master', () => pullProductMaster(pool, runStartedAt));
    }
    // MINI_SALES_REPORT — best-effort cross-check source, rate-limited by EasyEcom
    // (1 report/company/2h). Self-caps its poll wait and is skipped if tried within 2h.
    // Runs BEFORE the slow aging report so aging can no longer starve it of run budget.
    await eeStep('mini_sales', () => pullMiniSalesReport(pool, runStartedAt, windowDays));
    // INVENTORY_AGING LAST — the slowest step (EasyEcom is slow to generate it for the
    // secondary warehouses). Gets a longer dedicated deadline than the generic per-step
    // cap so it can actually complete instead of being killed at 600s and freezing the
    // aging feed. pullInventoryAging fetches the warehouses in parallel.
    const AGING_DEADLINE_MS = Number(process.env.PM_PULL_AGING_DEADLINE_MS || 1500000); // 25 min
    await eeStep('aging', () => pullInventoryAging(pool, runStartedAt), AGING_DEADLINE_MS);
  }

  // Sales cross-check (orders vs mini sales) — DB-only, safe to run regardless of auth.
  try { await crossCheckSales(pool, runStartedAt, windowDays); }
  catch (err) { await logStep(pool, runStartedAt, 'sales_cross_check', 'error', err.message, 0); }

  // Recompute health using fresh data (selling-days DRR + lead-time + open-lots + POs).
  const healthStart = Date.now();
  try {
    const summary = await recomputeAllHealth(pool);
    await logStep(pool, runStartedAt, 'health', 'ok',
      `recomputed ${summary?.count ?? 0} rules`, Date.now() - healthStart);
  } catch (err) {
    console.error('[pullWorker] recomputeAllHealth failed:', err.message);
    await logStep(pool, runStartedAt, 'health', 'error', err.message, Date.now() - healthStart);
  }

  if (String(process.env.PM_CUT_AUDIT || '').toLowerCase() === '1' || String(process.env.PM_CUT_AUDIT || '').toLowerCase() === 'true') {
    const reflStart = Date.now();
    try {
      const s = await reconcileDispatchReflection(pool);
      await logStep(pool, runStartedAt, 'reconcile_reflection',
        s.not_reflected > 0 ? 'partial' : 'ok',
        `processed=${s.processed} reflected=${s.reflected} not_reflected=${s.not_reflected} partial=${s.partial} pending=${s.pending} unresolved=${s.unresolved}`,
        Date.now() - reflStart);
    } catch (err) {
      console.error('[pullWorker] reconcile_reflection failed:', err.message);
      await logStep(pool, runStartedAt, 'reconcile_reflection', 'error', err.message, Date.now() - reflStart);
    }
  }

  await logStep(pool, runStartedAt, 'run', 'ok',
    `bootstrap=${bootstrapMode} sunday=${isSunday}`, Date.now() - overallStart);
  console.log(`[pullWorker] run complete in ${Date.now() - overallStart}ms`);
}

function triggerNow(pool, opts = {}) {
  return Promise.resolve().then(() => runPullWorker(pool, opts));
}

module.exports = { runPullWorker, triggerNow, pullSnapshotsFromPrimary, pullOrders, pullMiniSalesReport };
