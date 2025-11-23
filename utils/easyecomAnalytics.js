const PERIOD_PRESETS = {
  '1h': { label: 'Last 1 hour', hours: 1 },
  '12h': { label: 'Last 12 hours', hours: 12 },
  '1d': { label: 'Last 1 day', hours: 24 },
  '3d': { label: 'Last 3 days', hours: 72 },
  '7d': { label: 'Last 7 days', hours: 168 },
};

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
  const aggregates = await getOrderAggregates(pool, { periodKey, warehouseId, sku });
  return aggregates[0] || null;
}

async function getReplenishmentRule(pool, sku, warehouseId) {
  const [rows] = await pool.query(
    `SELECT sku, warehouse_id, threshold, making_time_days
     FROM ee_replenishment_rules
     WHERE sku = ? AND (warehouse_id IS NULL OR warehouse_id = ?)
     ORDER BY warehouse_id IS NULL DESC
     LIMIT 1`,
    [sku, warehouseId]
  );
  return rows[0] || null;
}

async function refreshInventoryHealth(pool, { sku, warehouseId, inventory, periodKey = '7d' }) {
  const rule = await getReplenishmentRule(pool, sku, warehouseId);
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
  let sql = `SELECT * FROM ee_inventory_health WHERE threshold_breached = 1 OR drr_breached = 1`;
  if (warehouseId) {
    sql += ' AND warehouse_id = ?';
    params.push(warehouseId);
  }
  sql += ' ORDER BY status ASC, updated_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function getInventoryStatuses(pool, { warehouseId, status }) {
  const params = [];
  let sql = 'SELECT * FROM ee_inventory_health WHERE 1=1';
  if (warehouseId) {
    sql += ' AND warehouse_id = ?';
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

module.exports = {
  PERIOD_PRESETS,
  resolvePeriod,
  getOrderAggregates,
  getDrrForSku,
  refreshInventoryHealth,
  saveReplenishmentRule,
  getInventoryAlerts,
  getInventoryStatuses,
};
