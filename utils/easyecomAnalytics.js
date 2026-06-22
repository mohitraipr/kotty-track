const { computeOnOrderBySku } = require('./onOrder');

const PERIOD_PRESETS = {
  '1h': { label: 'Last 1 hour', hours: 1 },
  '12h': { label: 'Last 12 hours', hours: 12 },
  '1d': { label: 'Last 1 day', hours: 24 },
  '3d': { label: 'Last 3 days', hours: 72 },
  '7d': { label: 'Last 7 days', hours: 168 },
};

// Simple in-memory cache to cut down on repeated expensive queries during bursts
// of webhook traffic. The data is short-lived to ensure correctness while
// significantly lowering the database pressure when the same SKU/warehouse data
// arrives repeatedly within a short window.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

function sanitizeWarehouseIds(warehouseIds) {
  return (warehouseIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
}

async function memoize(key, ttlMs, fetcher) {
  const entry = cache.get(key);
  const now = Date.now();
  if (entry && now - entry.time < ttlMs) {
    return entry.value;
  }

  const value = await fetcher();
  cache.set(key, { value, time: now });
  return value;
}

function resolvePeriod(periodKey = '1d') {
  const preset = PERIOD_PRESETS[periodKey] || PERIOD_PRESETS['1d'];
  const end = new Date();
  const start = new Date(end.getTime() - preset.hours * 60 * 60 * 1000);
  return {
    key: periodKey,
    label: preset.label,
    hours: preset.hours,
    days: preset.hours / 24,
    start,
    end,
  };
}

async function getOrderAggregates(pool, { periodKey = '1d', marketplaceId, warehouseId, sku }) {
  const window = resolvePeriod(periodKey);
  // Selling-days denominator excludes OOS days. Snapshot window starts at the
  // floor of window.start so day-level GROUP BY aligns with snapshot_date.
  const snapshotStart = new Date(window.start);
  snapshotStart.setHours(0, 0, 0, 0);

  const params = [snapshotStart, window.start];
  let sql = `
    SELECT
      es.sku,
      eo.warehouse_id,
      eo.marketplace_id,
      COALESCE(SUM(es.quantity), 0) AS order_count,
      MAX(eo.order_date) AS last_order_date,
      COALESCE(MAX(sd.selling_days), 0) AS selling_days
    FROM ee_suborders es
    INNER JOIN ee_orders eo ON es.order_id = eo.order_id
    LEFT JOIN (
      SELECT sku, COUNT(DISTINCT snapshot_date) AS selling_days
      FROM ee_inventory_daily_snapshot
      WHERE snapshot_date >= ? AND qty > 0
      GROUP BY sku
    ) sd ON sd.sku = es.sku
    WHERE eo.order_date >= ?
      AND EXISTS (
        SELECT 1 FROM ee_replenishment_rules r
        WHERE r.sku = es.sku
          AND (r.warehouse_id IS NULL OR r.warehouse_id = eo.warehouse_id)
          AND r.making_time_days IS NOT NULL
      )
  `;

  if (sku) {
    sql += ' AND es.sku = ?';
    params.push(sku);
  }
  if (warehouseId) {
    sql += ' AND eo.warehouse_id = ?';
    params.push(warehouseId);
  }
  if (marketplaceId) {
    sql += ' AND eo.marketplace_id = ?';
    params.push(marketplaceId);
  }

  sql += '\nGROUP BY es.sku, eo.warehouse_id, eo.marketplace_id\nORDER BY order_count DESC';

  const [rows] = await pool.query(sql, params);
  return rows.map((row) => {
    const orderCount = Number(row.order_count) || 0;
    const sellingDays = Number(row.selling_days) || 0;
    const calendarDays = window.days;
    const warmingUp = sellingDays < 7;
    const denomDays = warmingUp ? calendarDays : sellingDays;
    const drrPerDay = denomDays > 0 ? orderCount / denomDays : 0;
    return {
      ...row,
      period: window.key,
      window_start: window.start,
      window_end: window.end,
      calendar_days: calendarDays,
      selling_days: sellingDays,
      drr_orders: orderCount ? calendarDays / orderCount : null,
      drr_per_day: drrPerDay,
      dataQuality: warmingUp ? 'warming_up' : 'ok',
    };
  });
}

async function getDrrForSku(pool, { sku, warehouseId, periodKey = '7d' }) {
  const key = `drr:${sku}:${warehouseId ?? 'any'}:${periodKey}`;
  return memoize(key, CACHE_TTL_MS, async () => {
    const aggregates = await getOrderAggregates(pool, { periodKey, warehouseId, sku });
    return aggregates[0] || null;
  });
}

async function getReplenishmentRule(pool, sku, warehouseId) {
  const key = `rule:${sku}:${warehouseId ?? 'any'}`;
  return memoize(key, CACHE_TTL_MS, async () => {
    const [rows] = await pool.query(
      `SELECT sku, warehouse_id, threshold, making_time_days
       FROM ee_replenishment_rules
       WHERE sku = ? AND (warehouse_id IS NULL OR warehouse_id = ?)
         AND making_time_days IS NOT NULL
       ORDER BY warehouse_id IS NULL DESC
       LIMIT 1`,
      [sku, warehouseId]
    );
    return rows[0] || null;
  });
}

async function refreshInventoryHealth(pool, { sku, warehouseId, inventory, periodKey = '7d' }) {
  const rule = await getReplenishmentRule(pool, sku, warehouseId);
  if (!rule) {
    return null;
  }
  const drrInfo = await getDrrForSku(pool, { sku, warehouseId, periodKey });
  const drrOrders = drrInfo?.drr_orders || 0;
  const drrPerDay = drrInfo?.drr_per_day || 0;

  const reorderPoint = rule?.making_time_days && drrOrders
    ? Number(rule.making_time_days) * drrOrders
    : null;

  const daysUntilProduction = reorderPoint && drrOrders
    ? (inventory - reorderPoint) / drrOrders
    : null;

  const thresholdBreached = rule?.threshold !== undefined && rule?.threshold !== null
    ? inventory < Number(rule.threshold)
    : false;

  const drrBreached = reorderPoint !== null ? inventory <= reorderPoint : false;

  let status = 'green';
  if (thresholdBreached || (daysUntilProduction !== null && daysUntilProduction <= 0)) {
    status = 'red';
  } else if (drrBreached) {
    status = 'orange';
  }

  await pool.query(
    `INSERT INTO ee_inventory_health
      (sku, warehouse_id, inventory, drr_orders, drr_per_day, reorder_point, days_until_production, threshold_breached, drr_breached, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      inventory = VALUES(inventory),
      drr_orders = VALUES(drr_orders),
      drr_per_day = VALUES(drr_per_day),
      reorder_point = VALUES(reorder_point),
      days_until_production = VALUES(days_until_production),
      threshold_breached = VALUES(threshold_breached),
      drr_breached = VALUES(drr_breached),
      status = VALUES(status),
      updated_at = CURRENT_TIMESTAMP`,
    [
      sku,
      warehouseId,
      inventory,
      drrOrders || null,
      drrPerDay || null,
      reorderPoint,
      daysUntilProduction,
      thresholdBreached ? 1 : 0,
      drrBreached ? 1 : 0,
      status,
    ]
  );

  return {
    sku,
    warehouse_id: warehouseId,
    inventory,
    drr_orders: drrOrders,
    drr_per_day: drrPerDay,
    reorder_point: reorderPoint,
    days_until_production: daysUntilProduction,
    threshold_breached: thresholdBreached,
    drr_breached: drrBreached,
    status,
  };
}

async function saveReplenishmentRule(pool, { sku, warehouse_id, threshold, making_time_days }) {
  if (!sku) {
    throw new Error('SKU is required');
  }
  await pool.query(
    `INSERT INTO ee_replenishment_rules (sku, warehouse_id, threshold, making_time_days)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      threshold = VALUES(threshold),
      making_time_days = VALUES(making_time_days),
      updated_at = CURRENT_TIMESTAMP`,
    [sku, warehouse_id ?? null, threshold ?? null, making_time_days ?? null]
  );
}

async function getInventoryAlerts(pool, { warehouseId } = {}) {
  const params = [];
  let sql = `
    SELECT * FROM ee_inventory_health h
    WHERE (threshold_breached = 1 OR drr_breached = 1)
      AND EXISTS (
        SELECT 1 FROM ee_replenishment_rules r
        WHERE r.sku = h.sku
          AND (r.warehouse_id IS NULL OR r.warehouse_id = h.warehouse_id)
          AND r.making_time_days IS NOT NULL
      )
  `;
  if (warehouseId) {
    sql += ' AND h.warehouse_id = ?';
    params.push(warehouseId);
  }
  sql += ' ORDER BY status ASC, updated_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function getInventoryStatuses(pool, { warehouseId, status }) {
  const params = [];
  let sql = `
    SELECT * FROM ee_inventory_health h
    WHERE EXISTS (
      SELECT 1 FROM ee_replenishment_rules r
      WHERE r.sku = h.sku
        AND (r.warehouse_id IS NULL OR r.warehouse_id = h.warehouse_id)
        AND r.making_time_days IS NOT NULL
    )
  `;
  if (warehouseId) {
    sql += ' AND h.warehouse_id = ?';
    params.push(warehouseId);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY status ASC, updated_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

function getYesterdayBounds() {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

function buildRuleMaps(ruleRows = []) {
  const specific = new Map();
  const defaults = new Map();

  for (const rule of ruleRows) {
    if (rule.warehouse_id === null || rule.warehouse_id === undefined) {
      defaults.set(rule.sku, rule);
    } else {
      specific.set(`${rule.sku}:${rule.warehouse_id}`, rule);
    }
  }
  return { specific, defaults };
}

async function getYesterdayOrdersBySku(pool, { warehouseIds } = {}) {
  const allowedWarehouses = sanitizeWarehouseIds(warehouseIds);
  const hasWarehouseFilter = allowedWarehouses.length > 0;
  const { start, end } = getYesterdayBounds();
  const [rows] = await pool.query(
    `SELECT es.sku, eo.warehouse_id, COALESCE(SUM(es.quantity), 0) AS orders
     FROM ee_suborders es
     INNER JOIN ee_orders eo ON es.order_id = eo.order_id
      WHERE eo.order_date >= ? AND eo.order_date < ?
       AND EXISTS (
         SELECT 1 FROM ee_replenishment_rules r
         WHERE r.sku = es.sku
           AND (r.warehouse_id IS NULL OR r.warehouse_id = eo.warehouse_id)
            AND r.making_time_days IS NOT NULL
       )
       ${hasWarehouseFilter ? 'AND eo.warehouse_id IN (?)' : ''}
     GROUP BY es.sku, eo.warehouse_id`,
    hasWarehouseFilter ? [start, end, allowedWarehouses] : [start, end]
  );

  const map = new Map();
  for (const row of rows) {
    const key = `${row.sku}:${row.warehouse_id ?? 'null'}`;
    map.set(key, Number(row.orders) || 0);
  }
  return map;
}

async function getInventoryRunway(pool, { warehouseIds } = {}) {
  const allowedWarehouses = sanitizeWarehouseIds(warehouseIds);
  const hasWarehouseFilter = allowedWarehouses.length > 0;
  const [healthRows, ruleRows] = await Promise.all([
    pool
      .query(
        `SELECT h.sku, h.warehouse_id, h.inventory
         FROM ee_inventory_health h
         WHERE EXISTS (
           SELECT 1 FROM ee_replenishment_rules r
           WHERE r.sku = h.sku
             AND (r.warehouse_id IS NULL OR r.warehouse_id = h.warehouse_id)
             AND r.making_time_days IS NOT NULL
         )
         ${hasWarehouseFilter ? 'AND h.warehouse_id IN (?)' : ''}`
      , hasWarehouseFilter ? [allowedWarehouses] : [])
      .then((r) => r[0]),
    pool
      .query(
        `SELECT sku, warehouse_id, making_time_days
         FROM ee_replenishment_rules
         WHERE making_time_days IS NOT NULL`
      )
      .then((r) => r[0]),
  ]);

  const yesterdayOrders = await getYesterdayOrdersBySku(pool, { warehouseIds: allowedWarehouses });
  const { specific, defaults } = buildRuleMaps(ruleRows);
  const statusOrder = { red: 0, purple: 1, green: 2 };

  const rows = healthRows.map((row) => {
    const key = `${row.sku}:${row.warehouse_id ?? 'null'}`;
    const rule = specific.get(key) || defaults.get(row.sku);
    if (!rule) return null;
    const makingTimeDays = rule?.making_time_days ? Number(rule.making_time_days) : 0;
    const orders = yesterdayOrders.get(key) || 0;

    let daysLeft;
    if (orders <= 0) {
      daysLeft = Number.POSITIVE_INFINITY;
    } else {
      const coverableDays = Number(row.inventory || 0) / orders;
      daysLeft = coverableDays - makingTimeDays;
    }

    let status = 'green';
    if (!Number.isFinite(daysLeft) || daysLeft === null) {
      status = 'green';
    } else if (daysLeft <= 0) {
      status = 'red';
    } else if (daysLeft < 3) {
      status = 'purple';
    }

    return {
      sku: row.sku,
      warehouse_id: row.warehouse_id,
      inventory: Number(row.inventory || 0),
      making_time_days: makingTimeDays,
      yesterday_orders: orders,
      days_left: daysLeft,
      status,
      status_sort: statusOrder[status] ?? 3,
    };
  }).filter(Boolean);

  return rows.sort((a, b) => {
    if (a.status_sort !== b.status_sort) return a.status_sort - b.status_sort;
    return (b.yesterday_orders || 0) - (a.yesterday_orders || 0);
  });
}

async function getAggregateForWindow(pool, start, end, { warehouseIds } = {}) {
  const allowedWarehouses = sanitizeWarehouseIds(warehouseIds);
  const hasWarehouseFilter = allowedWarehouses.length > 0;
  const [rows] = await pool.query(
    `SELECT es.sku, eo.warehouse_id, COALESCE(SUM(es.quantity), 0) AS order_count
     FROM ee_suborders es
     INNER JOIN ee_orders eo ON es.order_id = eo.order_id
     WHERE eo.order_date >= ? AND eo.order_date < ?
       AND EXISTS (
         SELECT 1 FROM ee_replenishment_rules r
         WHERE r.sku = es.sku
           AND (r.warehouse_id IS NULL OR r.warehouse_id = eo.warehouse_id)
           AND r.making_time_days IS NOT NULL
       )
       ${hasWarehouseFilter ? 'AND eo.warehouse_id IN (?)' : ''}
     GROUP BY es.sku, eo.warehouse_id`,
    hasWarehouseFilter ? [start, end, allowedWarehouses] : [start, end]
  );
  return rows;
}

async function getMomentumWithGrowth(pool, { periodKey = '1d', warehouseIds } = {}) {
  const period = resolvePeriod(periodKey);
  const prevEnd = period.start;
  const prevStart = new Date(prevEnd.getTime() - period.hours * 60 * 60 * 1000);

  const [currentRows, prevRows] = await Promise.all([
    getAggregateForWindow(pool, period.start, period.end, { warehouseIds }),
    getAggregateForWindow(pool, prevStart, prevEnd, { warehouseIds }),
  ]);

  const prevMap = new Map();
  for (const row of prevRows) {
    prevMap.set(`${row.sku}:${row.warehouse_id ?? 'null'}`, Number(row.order_count) || 0);
  }

  const combined = currentRows.map((row) => {
    const key = `${row.sku}:${row.warehouse_id ?? 'null'}`;
    const previousCount = prevMap.get(key) || 0;
    const currentCount = Number(row.order_count) || 0;
    const growth = previousCount > 0
      ? ((currentCount - previousCount) / previousCount) * 100
      : currentCount > 0
        ? 100
        : 0;

    return {
      sku: row.sku,
      warehouse_id: row.warehouse_id,
      orders: currentCount,
      previous_orders: previousCount,
      growth,
    };
  });

  combined.sort((a, b) => (b.orders || 0) - (a.orders || 0));
  return combined;
}

async function getSlowMovers(pool, { warehouseIds } = {}) {
  const allowedWarehouses = sanitizeWarehouseIds(warehouseIds);
  const key = `slowMovers:${allowedWarehouses.sort().join(',')}`;
  return memoize(key, CACHE_TTL_MS, async () => {
    const hasWarehouseFilter = allowedWarehouses.length > 0;

    const [healthRows] = await pool.query(
      `SELECT h.sku, h.warehouse_id, h.inventory
       FROM ee_inventory_health h
       WHERE EXISTS (
         SELECT 1 FROM ee_replenishment_rules r
         WHERE r.sku = h.sku
           AND (r.warehouse_id IS NULL OR r.warehouse_id = h.warehouse_id)
           AND r.making_time_days IS NOT NULL
       )
       ${hasWarehouseFilter ? 'AND h.warehouse_id IN (?)' : ''}
       GROUP BY h.sku, h.warehouse_id`,
      hasWarehouseFilter ? [allowedWarehouses] : []
    );

    const end = new Date();
    const start7 = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
    const start30 = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [orders7, orders30] = await Promise.all([
      getAggregateForWindow(pool, start7, end, { warehouseIds: allowedWarehouses }),
      getAggregateForWindow(pool, start30, end, { warehouseIds: allowedWarehouses }),
    ]);

    const map7 = new Map();
    const map30 = new Map();
    for (const row of orders7) {
      map7.set(`${row.sku}:${row.warehouse_id ?? 'null'}`, Number(row.order_count) || 0);
    }
    for (const row of orders30) {
      map30.set(`${row.sku}:${row.warehouse_id ?? 'null'}`, Number(row.order_count) || 0);
    }

    const slowMovers = healthRows
      .map((row) => {
        const key = `${row.sku}:${row.warehouse_id ?? 'null'}`;
        const count7 = map7.get(key) || 0;
        const count30 = map30.get(key) || 0;

        if (count7 <= 10 && count30 <= 10) {
          return {
            sku: row.sku,
            warehouse_id: row.warehouse_id,
            orders_7d: count7,
            orders_30d: count30,
            inventory: Number(row.inventory) || 0,
          };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (a.inventory !== b.inventory) return b.inventory - a.inventory;
        if (a.orders_30d !== b.orders_30d) return a.orders_30d - b.orders_30d;
        if (a.orders_7d !== b.orders_7d) return a.orders_7d - b.orders_7d;
        return a.sku.localeCompare(b.sku);
      });

    return slowMovers;
  });
}

// --- Production Manager helpers (Phase C) -----------------------------------

const DEFAULT_LEAD_TIME = 12;
const DEFAULT_SAFETY_DAYS = 3;

async function getLeadTimeForSku(pool, sku, style) {
  const candidates = [];
  if (sku) candidates.push(['sku', sku]);
  if (style) candidates.push(['style', style]);
  for (const [scope, key] of candidates) {
    const [rows] = await pool.query(
      `SELECT default_lead_time_days, fabric_lead_time_days, safety_days, override_drr
       FROM pm_style_lead_times
       WHERE scope = ? AND key_value = ?
       LIMIT 1`,
      [scope, key]
    );
    if (rows[0]) {
      return {
        lead_time: Number(rows[0].default_lead_time_days ?? DEFAULT_LEAD_TIME),
        fabric_lead_time: Number(rows[0].fabric_lead_time_days ?? 0),
        safety_days: Number(rows[0].safety_days ?? DEFAULT_SAFETY_DAYS),
        override_drr: rows[0].override_drr != null ? Number(rows[0].override_drr) : null,
      };
    }
  }
  return {
    lead_time: DEFAULT_LEAD_TIME,
    fabric_lead_time: 0,
    safety_days: DEFAULT_SAFETY_DAYS,
    override_drr: null,
  };
}

// Company-wide SOH + DRR aggregation across warehouses
async function getDohForSku(pool, { sku }) {
  if (!sku) return null;
  const aggregates = await getOrderAggregates(pool, { periodKey: '7d', sku });
  let orderCount = 0;
  let sellingDays = 0;
  let calendarDays = 7;
  let warming = false;
  for (const row of aggregates) {
    orderCount += Number(row.order_count) || 0;
    sellingDays = Math.max(sellingDays, Number(row.selling_days) || 0);
    calendarDays = row.calendar_days || calendarDays;
    if (row.dataQuality === 'warming_up') warming = true;
  }
  const denom = sellingDays >= 7 ? sellingDays : calendarDays;
  const drr = denom > 0 ? orderCount / denom : 0;

  const [[sohRow]] = await pool.query(
    `SELECT COALESCE(SUM(inventory), 0) AS soh
     FROM ee_inventory_health WHERE sku = ?`,
    [sku]
  );
  const soh = Number(sohRow?.soh) || 0;
  const doh = drr > 0 ? soh / drr : null;

  return {
    sku,
    soh,
    drr,
    doh,
    dataQuality: warming || sellingDays < 7 ? 'warming_up' : 'ok',
  };
}

// Strip the trailing size token from an ecom size-SKU to get the style/base code
// for dashboard grouping: KTTLADIESJEANS823M -> KTTLADIESJEANS823,
// KTTLADIESJEANS1003_3XL -> KTTLADIESJEANS1003, KTTMENSJEANS381_28 -> KTTMENSJEANS381.
function deriveStyle(sku) {
  const s = String(sku || '').toUpperCase();
  // _3XL.._6XL and _<waist> require the underscore (so ...823 + XL isn't read as 3XL);
  // XXL/XL/XS/S/M/L attach directly. Longest alternatives first.
  return s.replace(/(?:_(?:3XL|4XL|5XL|6XL)|_\d{2,3}|XXL|XL|XS|S|M|L)$/, '') || s;
}

// The size label of a size-SKU = the suffix deriveStyle() strips (underscore dropped).
// e.g. KTTWOMENSPANT677XL -> 'XL', KTTLADIESJEANS823_34 -> '34'. null if no size suffix.
function deriveSize(sku) {
  const s = String(sku || '').toUpperCase();
  const m = s.match(/(?:_(3XL|4XL|5XL|6XL)|_(\d{2,3})|(XXL|XL|XS|S|M|L))$/);
  return m ? (m[1] || m[2] || m[3] || null) : null;
}

// Clean-day demand metrics per size-SKU, company-wide. Gap/dup-safe.
// A day counts as a clean in-stock day only if it was in stock the WHOLE day:
// current snapshot qty>0 AND the most-recent-PRIOR present snapshot qty>0
// (prior = previous existing row, so calendar gaps are skipped, not treated as
// stockouts). Numerator (sales) and denominator (day count) both restricted to
// those clean days together. Stockout uplift reads stockout_days (qty=0), never
// the clean-day fraction. Per-size sigma is the std of the clean-day demand series.
async function computeCleanDayMetrics(pool, windowStart) {
  // Company-wide daily stock series (sum warehouses, one row per (sku, date)).
  // Restrict the (expensive) stock series to SKUs that actually sold in the window
  // — SKUs with no sales have DRR 0 regardless, so their series is wasted work.
  const [snapRows] = await pool.query(
    `SELECT s.sku, DATE_FORMAT(s.snapshot_date, '%Y-%m-%d') AS d, SUM(s.qty) AS qty
     FROM ee_inventory_daily_snapshot s
     INNER JOIN (
       SELECT DISTINCT sku
       FROM ee_sales_daily
       WHERE sale_date >= ? AND source = 'mini_sales_report'
     ) sold ON sold.sku = s.sku
     WHERE s.snapshot_date >= ?
     GROUP BY s.sku, d
     ORDER BY s.sku, d`,
    [windowStart, windowStart]
  );
  // Daily sales by SKU on order_date.
  const [saleRows] = await pool.query(
    `SELECT sku, DATE_FORMAT(sale_date, '%Y-%m-%d') AS d, SUM(qty) AS qty
     FROM ee_sales_daily
     WHERE sale_date >= ? AND source = 'mini_sales_report'
     GROUP BY sku, d`,
    [windowStart]
  );
  const salesBySku = new Map();
  for (const r of saleRows) {
    if (!salesBySku.has(r.sku)) salesBySku.set(r.sku, new Map());
    salesBySku.get(r.sku).set(r.d, Number(r.qty) || 0);
  }

  const metrics = new Map();
  let curSku = null;
  let series = [];
  const finalize = () => {
    if (!curSku) return;
    const sales = salesBySku.get(curSku) || new Map();
    const observed = series.length;
    let cleanDays = 0;
    let stockoutDays = 0;
    let cleanSales = 0;
    const dailyDemand = [];
    for (let i = 0; i < series.length; i++) {
      if (series[i].qty === 0) stockoutDays++;
      // clean day: in stock at both bookends (i and the previous PRESENT snapshot i-1)
      if (i >= 1 && series[i].qty > 0 && series[i - 1].qty > 0) {
        cleanDays++;
        const s = sales.get(series[i].d) || 0;
        cleanSales += s;
        dailyDemand.push(s);
      }
    }
    const drr = cleanDays > 0 ? cleanSales / cleanDays : 0;
    const availability = observed > 0 ? 1 - stockoutDays / observed : 1;
    // uplift off stockout_days; the 0.5 floor caps the boost at 2x.
    const buyDrr = drr / Math.max(availability, 0.5);
    let sigma = 0;
    if (dailyDemand.length > 0) {
      const mean = dailyDemand.reduce((a, b) => a + b, 0) / dailyDemand.length;
      sigma = Math.sqrt(dailyDemand.reduce((a, b) => a + (b - mean) * (b - mean), 0) / dailyDemand.length);
    }
    metrics.set(curSku, {
      drr,
      buy_drr: buyDrr,
      clean_days: cleanDays,
      stockout_days: stockoutDays,
      observed_days: observed,
      availability,
      sigma,
      data_quality: cleanDays === 0 ? 'no_clean_days' : (cleanDays < 7 ? 'low_sample' : 'ok'),
    });
  };
  for (const r of snapRows) {
    if (r.sku !== curSku) { finalize(); curSku = r.sku; series = []; }
    series.push({ d: r.d, qty: Number(r.qty) || 0 });
  }
  finalize();
  return metrics;
}

async function getCuttingRecommendations(pool, { periodKey = '30d', shadow = false } = {}) {
  // Resolve window for snapshot-based selling days
  const presetHours = PERIOD_PRESETS[periodKey]?.hours
    || (Number(String(periodKey).replace(/[^0-9]/g, '')) * 24)
    || 720;
  const windowDays = presetHours / 24;
  const snapshotStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  snapshotStart.setHours(0, 0, 0, 0);

  // Company-wide aggregation per SKU
  const [rows] = await pool.query(
    `SELECT
        s.sku,
        COALESCE(SUM(s.qty), 0) AS order_count,
        COALESCE(MAX(sd.selling_days), 0) AS selling_days
     FROM ee_sales_daily s
     LEFT JOIN (
       SELECT sku, COUNT(DISTINCT snapshot_date) AS selling_days
       FROM ee_inventory_daily_snapshot
       WHERE snapshot_date >= ? AND qty > 0
       GROUP BY sku
     ) sd ON sd.sku = s.sku
     WHERE s.sale_date >= ? AND s.source = 'mini_sales_report'
     GROUP BY s.sku`,
    [snapshotStart, snapshotStart]
  );

  // Sellable SOH = only "Available" status from STATUS_WISE_STOCK_REPORT.
  // Falls back to ee_inventory_health.inventory if no stock-status data yet
  // (i.e. before the first nightly pull populates ee_stock_status).
  const [stockStatusRows] = await pool.query(
    `SELECT sku, COALESCE(SUM(qty), 0) AS soh
     FROM ee_stock_status
     WHERE status = 'Available'
     GROUP BY sku`
  );
  const sohMap = new Map(stockStatusRows.map((r) => [r.sku, Number(r.soh) || 0]));
  if (sohMap.size === 0) {
    const [fallback] = await pool.query(
      `SELECT sku, COALESCE(SUM(inventory), 0) AS soh
       FROM ee_inventory_health
       GROUP BY sku`
    );
    for (const r of fallback) sohMap.set(r.sku, Number(r.soh) || 0);
  }
  const sohRows = [...sohMap.entries()].map(([sku, soh]) => ({ sku, soh }));

  // Include SKUs that have stock but no orders in window
  const allSkus = new Set([
    ...rows.map((r) => r.sku),
    ...sohRows.map((r) => r.sku),
  ]);

  // Bulk-load every per-SKU input ONCE. Previously the loop below issued a
  // lead-time + open-lot + PO query per SKU — an N+1 explosion that was cheap at
  // ~2k SKUs but turns into ~100k sequential queries once the snapshot pull
  // populates ee_inventory_health with ~25k SKUs. These four queries replace it.
  const rowMap = new Map(rows.map((r) => [r.sku, r]));
  const [ltRows] = await pool.query(
    `SELECT key_value, default_lead_time_days, fabric_lead_time_days, safety_days, override_drr
     FROM pm_style_lead_times WHERE scope = 'sku'`
  );
  const ltMap = new Map(ltRows.map((r) => [r.key_value, r]));
  const { onOrder: openLotMap, unresolved: onOrderUnresolved } =
    await computeOnOrderBySku(pool);
  const [poRows] = await pool.query(
    `SELECT sku, DATEDIFF(required_by_date, CURDATE()) AS days_out, COALESCE(SUM(qty), 0) AS qty
     FROM pm_marketplace_po_lines WHERE required_by_date >= CURDATE() GROUP BY sku, days_out`
  );
  const poMap = new Map();
  for (const r of poRows) {
    if (!poMap.has(r.sku)) poMap.set(r.sku, []);
    poMap.get(r.sku).push({ daysOut: Number(r.days_out), qty: Number(r.qty) || 0 });
  }
  const resolveLeadTime = (cfg) => cfg ? {
    lead_time: Number(cfg.default_lead_time_days ?? DEFAULT_LEAD_TIME),
    fabric_lead_time: Number(cfg.fabric_lead_time_days ?? 0),
    safety_days: Number(cfg.safety_days ?? DEFAULT_SAFETY_DAYS),
    override_drr: cfg.override_drr != null ? Number(cfg.override_drr) : null,
  } : { lead_time: DEFAULT_LEAD_TIME, fabric_lead_time: 0, safety_days: DEFAULT_SAFETY_DAYS, override_drr: null };

  // Clean-day demand (P1). DRR_MODE: 'shadow' (default — legacy drives output,
  // clean-day computed alongside for diffing), 'cleanday' (clean-day drives), or
  // 'legacy'. At cutover (mode='cleanday') the legacy/warming_up path is removed.
  const DRR_MODE = String(
    process.env.PM_DRR_MODE || (typeof global !== 'undefined' && global.env && global.env.PM_DRR_MODE) || 'shadow'
  ).toLowerCase();
  // Keep the clean-day series OFF the live /pm path. Compute it only when it
  // drives output (cutover mode) or when a shadow diff is explicitly requested.
  const includeCleanDay = DRR_MODE === 'cleanday' || shadow === true;
  // GUARD (shadow diff): clean-day DRR is meaningless if sales don't cover the
  // snapshot window. Refuse the diff below 90% coverage and print it — this is
  // the lesson from the half-backfilled-orders incident, made permanent.
  if (shadow === true) {
    const [[cov]] = await pool.query(
      `SELECT
         (SELECT COUNT(DISTINCT snapshot_date) FROM ee_inventory_daily_snapshot WHERE snapshot_date >= ?) AS snap_days,
         (SELECT COUNT(DISTINCT sale_date) FROM ee_sales_daily WHERE sale_date >= ? AND source = 'mini_sales_report') AS sale_days`,
      [snapshotStart, snapshotStart]
    );
    const snapDays = Number(cov.snap_days) || 0;
    const saleDays = Number(cov.sale_days) || 0;
    const coverage = snapDays > 0 ? saleDays / snapDays : 0;
    if (coverage < 0.9) {
      throw new Error(
        `[shadow-diff guard] sales cover only ${(coverage * 100).toFixed(0)}% of the snapshot window ` +
        `(sales_days=${saleDays}, snapshot_days=${snapDays}; need >=90%). Backfill orders to the snapshot window first.`
      );
    }
  }
  const cleanMetrics = includeCleanDay ? await computeCleanDayMetrics(pool, snapshotStart) : new Map();

  // SKUs actually tracked in inventory (have a snapshot). Sold-but-untracked SKUs
  // — 2-piece sets / bundles / virtual SKUs — have no cuttable lot, so exclude them
  // (they otherwise dominate the recs with 0-stock noise and a bogus '(unknown)' style).
  const [snapPresentRows] = await pool.query(
    `SELECT DISTINCT sku FROM ee_inventory_daily_snapshot WHERE snapshot_date >= ?`,
    [snapshotStart]
  );
  const snapPresent = new Set(snapPresentRows.map((r) => r.sku));

  const results = [];
  for (const sku of allSkus) {
    if (!snapPresent.has(sku)) continue; // untracked/bundle SKU — not a cuttable lot
    const row = rowMap.get(sku) || { order_count: 0, selling_days: 0 };
    const orderCount = Number(row.order_count) || 0;
    const sellingDays = Number(row.selling_days) || 0;
    const warming = sellingDays < 7;
    const denom = warming ? windowDays : sellingDays;
    const legacyDrr = denom > 0 ? orderCount / denom : 0;

    const cd = cleanMetrics.get(sku) || null;
    const cleandayDrr = cd ? cd.buy_drr : 0;

    const lt = resolveLeadTime(ltMap.get(sku));
    let drr = DRR_MODE === 'cleanday' ? cleandayDrr : legacyDrr;
    if (lt.override_drr !== null) drr = lt.override_drr;

    const soh = sohMap.get(sku) || 0;
    const openLotQty = openLotMap.get(String(sku).toUpperCase()) || 0;

    const horizon = lt.lead_time + lt.safety_days;
    const upcomingPoQty = (poMap.get(sku) || [])
      .reduce((s, p) => s + (p.daysOut <= horizon ? p.qty : 0), 0);

    const suggested = Math.max(
      0,
      horizon * drr - soh - openLotQty + upcomingPoQty
    );

    const doh = drr > 0 ? soh / drr : null;
    // Thin-sample SKUs (clean_days < 7) aren't trustworthy cut targets in cleanday mode.
    const lowConfidence = DRR_MODE === 'cleanday' && cd && (cd.data_quality === 'low_sample' || cd.data_quality === 'no_clean_days');
    let trigger = 'green';
    if (doh !== null && doh <= lt.lead_time) trigger = 'red';
    else if (doh !== null && doh <= horizon) trigger = 'orange';
    if (lowConfidence && trigger === 'red') trigger = 'orange'; // demote noisy thin-sample reds

    const drrDiffPct = legacyDrr > 0 ? ((cleandayDrr - legacyDrr) / legacyDrr) * 100 : (cleandayDrr > 0 ? Infinity : 0);
    results.push({
      sku,
      style: deriveStyle(sku),
      size: deriveSize(sku),
      low_confidence: !!lowConfidence,
      soh,
      drr,
      doh,
      lead_time: lt.lead_time,
      safety_days: lt.safety_days,
      fabric_lead_time: lt.fabric_lead_time,
      open_lot_qty: openLotQty,
      upcoming_po_qty: upcomingPoQty,
      selling_days: sellingDays,
      window_days: windowDays,
      suggested_cut_qty: Math.round(suggested),
      trigger,
      dataQuality: warming ? 'warming_up' : 'ok',
      // P1 shadow fields (clean-day demand model):
      drr_mode: DRR_MODE,
      drr_legacy: legacyDrr,
      drr_cleanday: cleandayDrr,
      drr_diff_pct: drrDiffPct,
      clean_days: cd ? cd.clean_days : 0,
      stockout_days: cd ? cd.stockout_days : 0,
      observed_days: cd ? cd.observed_days : 0,
      availability: cd ? cd.availability : null,
      demand_sigma: cd ? cd.sigma : 0,
      cleanday_quality: cd ? cd.data_quality : 'no_snapshot',
    });
  }

  results.sort((a, b) => b.suggested_cut_qty - a.suggested_cut_qty);
  results.onOrderUnresolved = onOrderUnresolved || { lots: 0, pieces: 0 };
  return results;
}

async function getDeadStock(pool, { days = 45 } = {}) {
  // Prefer INVENTORY_AGING_REPORT — true age-based dead stock signal.
  // Falls back to the DRR=0 heuristic if the aging table hasn't been populated yet.
  const [agingRows] = await pool.query(
    `SELECT sku,
            COALESCE(SUM(qty), 0) AS soh,
            MAX(oldest_age_days) AS oldest_age_days,
            MAX(avg_age_days) AS avg_age_days
     FROM ee_inventory_aging
     WHERE oldest_age_days >= ?
     GROUP BY sku
     HAVING soh > 0
     ORDER BY soh DESC`,
    [days]
  );
  if (agingRows.length > 0) {
    return agingRows.map((r) => ({
      sku: r.sku,
      soh: Number(r.soh) || 0,
      orders_in_window: null,
      drr_per_day: 0,
      window_days: days,
      oldest_age_days: r.oldest_age_days != null ? Number(r.oldest_age_days) : null,
      avg_age_days: r.avg_age_days != null ? Number(r.avg_age_days) : null,
      source: 'aging_report',
    }));
  }

  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [rows] = await pool.query(
    `SELECT h.sku,
            COALESCE(SUM(h.inventory), 0) AS soh,
            COALESCE(o.order_count, 0) AS orders_in_window
     FROM ee_inventory_health h
     LEFT JOIN (
       SELECT es.sku, SUM(es.quantity) AS order_count
       FROM ee_suborders es
       INNER JOIN ee_orders eo ON es.order_id = eo.order_id
       WHERE eo.import_date >= ?
       GROUP BY es.sku
     ) o ON o.sku = h.sku
     GROUP BY h.sku, o.order_count
     HAVING soh > 0 AND orders_in_window = 0
     ORDER BY soh DESC`,
    [start]
  );
  return rows.map((r) => ({
    sku: r.sku,
    soh: Number(r.soh) || 0,
    orders_in_window: Number(r.orders_in_window) || 0,
    drr_per_day: 0,
    window_days: days,
    source: 'drr_heuristic',
  }));
}

async function recomputeAllHealth(pool) {
  const [rules] = await pool.query(
    `SELECT DISTINCT sku, warehouse_id
     FROM ee_replenishment_rules
     WHERE making_time_days IS NOT NULL`
  );
  let count = 0;
  let errors = 0;
  for (const rule of rules) {
    try {
      const [[invRow]] = await pool.query(
        `SELECT inventory FROM ee_inventory_health
         WHERE sku = ? AND (? IS NULL OR warehouse_id = ?)
         ORDER BY updated_at DESC LIMIT 1`,
        [rule.sku, rule.warehouse_id, rule.warehouse_id]
      );
      const inventory = Number(invRow?.inventory) || 0;
      await refreshInventoryHealth(pool, {
        sku: rule.sku,
        warehouseId: rule.warehouse_id,
        inventory,
      });
      count++;
    } catch (err) {
      errors++;
      console.error(`[recomputeAllHealth] ${rule.sku}/${rule.warehouse_id}:`, err.message);
    }
  }
  return { count, errors };
}

module.exports = {
  PERIOD_PRESETS,
  resolvePeriod,
  getOrderAggregates,
  getDrrForSku,
  refreshInventoryHealth,
  saveReplenishmentRule,
  getInventoryAlerts,
  getInventoryStatuses,
  getInventoryRunway,
  getMomentumWithGrowth,
  getSlowMovers,
  getDohForSku,
  getCuttingRecommendations,
  getDeadStock,
  recomputeAllHealth,
  deriveStyle,
  deriveSize,
};
