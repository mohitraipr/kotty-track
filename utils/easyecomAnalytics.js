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
  const params = [window.start];
  let sql = `
    SELECT
      es.sku,
      eo.warehouse_id,
      eo.marketplace_id,
      COUNT(*) AS order_count,
      MAX(eo.order_date) AS last_order_date
    FROM ee_suborders es
    INNER JOIN ee_orders eo ON es.order_id = eo.order_id
    WHERE eo.import_date >= ?
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
  return rows.map((row) => ({
    ...row,
    period: window.key,
    window_start: window.start,
    window_end: window.end,
    drr_orders: row.order_count ? window.days / row.order_count : null,
    drr_per_day: window.days ? row.order_count / window.days : 0,
  }));
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
    `SELECT es.sku, eo.warehouse_id, COUNT(*) AS orders
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
    `SELECT es.sku, eo.warehouse_id, COUNT(*) AS order_count
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
      if (a.orders_30d !== b.orders_30d) return a.orders_30d - b.orders_30d;
      if (a.orders_7d !== b.orders_7d) return a.orders_7d - b.orders_7d;
      if (a.inventory !== b.inventory) return b.inventory - a.inventory;
      return a.sku.localeCompare(b.sku);
    });

  return slowMovers;
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
};
