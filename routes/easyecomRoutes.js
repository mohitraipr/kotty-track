const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isOnlyMohitOperator } = require('../middlewares/auth');
const ExcelJS = require('exceljs');
const {
  PERIOD_PRESETS,
  resolvePeriod,
  getOrderAggregates,
  getInventoryAlerts,
  getInventoryStatuses,
  getInventoryRunway,
  getMomentumWithGrowth,
  getSlowMovers,
  saveReplenishmentRule,
} = require('../utils/easyecomAnalytics');

const WAREHOUSE_LABELS = {
  173983: 'Faridabad',
  176318: 'Delhi',
};

// Cache for stock-market data to reduce DB load (2-minute TTL)
const stockMarketCache = new Map();
const STOCK_MARKET_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function getCachedStockMarketData(cacheKey) {
  const entry = stockMarketCache.get(cacheKey);
  if (entry && Date.now() - entry.time < STOCK_MARKET_CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCachedStockMarketData(cacheKey, data) {
  stockMarketCache.set(cacheKey, { data, time: Date.now() });
  // Clean old entries periodically
  if (stockMarketCache.size > 50) {
    const now = Date.now();
    for (const [key, val] of stockMarketCache) {
      if (now - val.time > STOCK_MARKET_CACHE_TTL) {
        stockMarketCache.delete(key);
      }
    }
  }
}
const ALLOWED_WAREHOUSES = [
  { id: 176318, label: 'Delhi' },
  { id: 173983, label: 'Faridabad' },
];
const ALLOWED_WAREHOUSE_IDS = ALLOWED_WAREHOUSES.map((w) => w.id);

function getWarehouseLabel(warehouseId) {
  if (warehouseId === null || warehouseId === undefined) return 'N/A';
  return WAREHOUSE_LABELS[warehouseId] || String(warehouseId);
}

function decorateWithWarehouseLabel(rows = []) {
  return rows.map((row) => ({
    ...row,
    warehouse_label: getWarehouseLabel(row.warehouse_id),
  }));
}

const PERIOD_KEYS = new Set(Object.keys(PERIOD_PRESETS));
function normalizePeriod(period) {
  if (PERIOD_KEYS.has(period)) return period;
  return '1d';
}

function allowStockMarketAccess(req, res, next) {
  const username = req.session?.user?.username?.toLowerCase();
  const role = req.session?.user?.roleName;

  if (
    username === 'mohitoperator' ||
    role === 'inventory_operator' ||
    role === 'operator' ||
    role === 'outofstock'
  ) {
    return next();
  }

  req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
}

async function getAssignedWarehouseIds(userId) {
  const [rows] = await pool.query(
    'SELECT warehouse_id FROM ee_user_warehouses WHERE user_id = ? ORDER BY warehouse_id ASC',
    [userId]
  );
  return rows.map((r) => Number(r.warehouse_id)).filter((id) => ALLOWED_WAREHOUSE_IDS.includes(id));
}

async function getAccessibleWarehouses(user) {
  if (!user) return ALLOWED_WAREHOUSES;
  if (user.roleName === 'outofstock') {
    const assigned = await getAssignedWarehouseIds(user.id);
    const wh = ALLOWED_WAREHOUSES.filter((w) => assigned.length === 0 || assigned.includes(w.id));
    return wh.length ? wh : ALLOWED_WAREHOUSES;
  }
  return ALLOWED_WAREHOUSES;
}

async function buildWarehouseContext(user, requestedWarehouseId) {
  const accessibleWarehouses = await getAccessibleWarehouses(user);
  const allowedIds = accessibleWarehouses.map((w) => w.id);
  const hasMultipleWarehouses = allowedIds.length > 1;
  const enforceSingleWarehouse = user?.roleName === 'outofstock' && !hasMultipleWarehouses;

  const wantsAllWarehouses = hasMultipleWarehouses && requestedWarehouseId === 'all';
  const requestedId = requestedWarehouseId ? Number(requestedWarehouseId) : null;
  const hasValidRequestedWarehouse = Number.isFinite(requestedId) && allowedIds.includes(requestedId);

  let selectedWarehouseId = null;
  if (wantsAllWarehouses) {
    selectedWarehouseId = 'all';
  } else if (hasValidRequestedWarehouse) {
    selectedWarehouseId = requestedId;
  } else if (hasMultipleWarehouses && !enforceSingleWarehouse) {
    selectedWarehouseId = 'all';
  } else if (allowedIds.length) {
    selectedWarehouseId = allowedIds[0];
  }

  const warehouseFilter =
    selectedWarehouseId === 'all'
      ? allowedIds
      : Number.isFinite(selectedWarehouseId)
        ? [selectedWarehouseId]
        : undefined;

  return { accessibleWarehouses, selectedWarehouseId, warehouseFilter };
}

async function getOutofstockUsers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.username
     FROM users u
     INNER JOIN roles r ON u.role_id = r.id
     WHERE r.name = 'outofstock' AND u.is_active = TRUE
     ORDER BY u.username ASC`
  );
  return rows;
}

async function getWarehouseAssignmentsForUsers(userIds = []) {
  if (!userIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT user_id, warehouse_id FROM ee_user_warehouses WHERE user_id IN (?)`,
    [userIds]
  );
  const map = new Map();
  rows.forEach((row) => {
    const list = map.get(row.user_id) || [];
    list.push(Number(row.warehouse_id));
    map.set(row.user_id, list);
  });
  return map;
}

async function saveWarehouseAssignments(userId, warehouseIds = []) {
  const allowed = warehouseIds.filter((id) => ALLOWED_WAREHOUSE_IDS.includes(Number(id)));
  await pool.query('DELETE FROM ee_user_warehouses WHERE user_id = ?', [userId]);
  if (!allowed.length) return;
  const values = allowed.map((id) => [userId, Number(id)]);
  await pool.query('INSERT INTO ee_user_warehouses (user_id, warehouse_id) VALUES ?', [values]);
}

router.get('/ops', isAuthenticated, isOperator, async (req, res) => {
  try {
    const periodKey = normalizePeriod(req.query.period);
    const filters = {
      marketplaceId: req.query.marketplaceId || '',
      warehouseId: req.query.warehouseId || '',
      sku: (req.query.sku || '').toUpperCase(),
      status: req.query.status || '',
    };

    const [orders, alerts, statuses] = await Promise.all([
      getOrderAggregates(pool, { periodKey, ...filters, sku: filters.sku || undefined }),
      getInventoryAlerts(pool, { warehouseId: filters.warehouseId || undefined }),
      getInventoryStatuses(pool, {
        warehouseId: filters.warehouseId || undefined,
        status: filters.status || undefined,
      }),
    ]);

    res.render('easyecomOps', {
      user: req.session?.user || null,
      periodKey,
      period: resolvePeriod(periodKey),
      periodPresets: PERIOD_PRESETS,
      orders,
      alerts,
      statuses,
      filters,
    });
  } catch (err) {
    console.error('Failed to render EasyEcom Ops UI:', err);
    req.flash('error', 'Could not load EasyEcom operations');
    res.redirect('/');
  }
});

async function fetchStockMarketData(warehouseFilter, periodKey) {
  const cacheKey = `stock-market:${[...warehouseFilter].sort().join(',')}:${periodKey}`;
  const cached = getCachedStockMarketData(cacheKey);
  if (cached) return cached;

  const [inventoryRaw, ordersRaw, slowMoversRaw] = await Promise.all([
    getInventoryRunway(pool, { warehouseIds: warehouseFilter }),
    getMomentumWithGrowth(pool, { periodKey, warehouseIds: warehouseFilter }),
    getSlowMovers(pool, { warehouseIds: warehouseFilter }),
  ]);

  const result = {
    inventory: decorateWithWarehouseLabel(inventoryRaw),
    orders: decorateWithWarehouseLabel(ordersRaw),
    slowMovers: decorateWithWarehouseLabel(slowMoversRaw),
    period: resolvePeriod(periodKey),
  };

  setCachedStockMarketData(cacheKey, result);
  return result;
}

router.get('/stock-market', isAuthenticated, allowStockMarketAccess, async (req, res) => {
  try {
    const user = req.session?.user || null;
    const { accessibleWarehouses, selectedWarehouseId, warehouseFilter } = await buildWarehouseContext(
      user,
      req.query.warehouseId
    );

    const periodKey = normalizePeriod(req.query.period);
    const { inventory, orders, slowMovers } = await fetchStockMarketData(warehouseFilter, periodKey);

    res.render('stockMarket', {
      user,
      accessibleWarehouses,
      selectedWarehouseId,
      inventory,
      orders,
      slowMovers,
      periodKey,
      period: resolvePeriod(periodKey),
      periodPresets: PERIOD_PRESETS,
    });
  } catch (err) {
    console.error('Failed to render out-of-stock view:', err);
    req.flash('error', 'Could not load out-of-stock view');
    res.redirect('/');
  }
});

router.get('/stock-market/data', isAuthenticated, allowStockMarketAccess, async (req, res) => {
  try {
    const user = req.session?.user || null;
    const { warehouseFilter } = await buildWarehouseContext(user, req.query.warehouseId);
    const periodKey = normalizePeriod(req.query.period);
    const result = await fetchStockMarketData(warehouseFilter, periodKey);
    res.json(result);
  } catch (err) {
    console.error('Failed to fetch out-of-stock data:', err);
    res.status(500).json({ error: 'Unable to refresh data' });
  }
});

router.get('/stock-market/download', isAuthenticated, allowStockMarketAccess, async (req, res) => {
  try {
    const user = req.session?.user || null;
    const { warehouseFilter } = await buildWarehouseContext(user, req.query.warehouseId);

    const periodKey = normalizePeriod(req.query.period);
    const { inventory, orders } = await fetchStockMarketData(warehouseFilter, periodKey);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kotty Track';
    const inventorySheet = workbook.addWorksheet('Inventory Runway');
    inventorySheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Warehouse', key: 'warehouse_label', width: 16 },
      { header: 'Inventory', key: 'inventory', width: 14 },
      { header: 'Making time (days)', key: 'making_time_days', width: 18 },
      { header: 'Yesterday orders', key: 'yesterday_orders', width: 18 },
      { header: 'Days left', key: 'days_left', width: 12 },
      { header: 'Status', key: 'status', width: 12 },
    ];
    inventory.forEach((row) => {
      const daysLeft = Number.isFinite(row.days_left) ? Number(row.days_left).toFixed(1) : '∞';
      inventorySheet.addRow({ ...row, days_left: daysLeft });
    });

    const ordersSheet = workbook.addWorksheet('Order Momentum');
    const periodLabel = resolvePeriod(periodKey).label;
    ordersSheet.columns = [
      { header: 'SKU', key: 'sku', width: 20 },
      { header: 'Warehouse', key: 'warehouse_label', width: 16 },
      { header: `Orders (${periodLabel})`, key: 'orders', width: 18 },
      { header: 'Previous window', key: 'previous_orders', width: 18 },
      { header: 'Growth %', key: 'growth', width: 12 },
    ];
    orders.forEach((row) => {
      ordersSheet.addRow({ ...row, growth: Number(row.growth || 0).toFixed(1) });
    });

    const fileName = `out-of-stock-${periodKey}.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();
    const outputBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=\"${fileName}\"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.setHeader('Content-Length', outputBuffer.length);
    res.send(outputBuffer);
  } catch (err) {
    console.error('Failed to download out-of-stock Excel:', err);
    res.status(500).json({ error: 'Unable to download Excel' });
  }
});

function parseBulkLines(input = '') {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(',').map((cell) => cell.trim()));
}

router.get('/stock-market/making-time', isAuthenticated, isOnlyMohitOperator, (req, res) => {
  res.render('stockMarketBulkMakingTime', {
    user: req.session?.user || null,
    result: null,
    bulkInput: '',
  });
});

router.post('/stock-market/making-time', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  const bulkInput = req.body?.bulkInput || '';
  const lines = parseBulkLines(bulkInput);
  const errors = [];
  const success = [];

  for (let idx = 0; idx < lines.length; idx += 1) {
    const [skuRaw, warehouseRaw, daysRaw] = lines[idx];
    const sku = skuRaw?.toUpperCase();
    const warehouse = warehouseRaw || null;
    const makingTime = Number(daysRaw);

    if (!sku || Number.isNaN(makingTime)) {
      errors.push(`Row ${idx + 1}: Invalid data`);
      continue;
    }

    try {
      await saveReplenishmentRule(pool, {
        sku,
        warehouse_id: warehouse || null,
        making_time_days: makingTime,
      });
      success.push(sku);
    } catch (err) {
      console.error('Failed to save making time', err);
      errors.push(`Row ${idx + 1}: Could not save ${sku}`);
    }
  }

  res.render('stockMarketBulkMakingTime', {
    user: req.session?.user || null,
    bulkInput,
    result: { errors, success },
  });
});

router.get(
  '/warehouse-access',
  isAuthenticated,
  isOnlyMohitOperator,
  async (req, res) => {
    try {
      const users = await getOutofstockUsers();
      const assignmentsMap = await getWarehouseAssignmentsForUsers(users.map((u) => u.id));

      res.render('warehouseAccess', {
        user: req.session?.user || null,
        users,
        warehouses: ALLOWED_WAREHOUSES,
        assignments: Object.fromEntries(assignmentsMap),
      });
    } catch (err) {
      console.error('Failed to load warehouse access page:', err);
      req.flash('error', 'Could not load warehouse access page');
      res.redirect('/easyecom/stock-market');
    }
  }
);

router.post(
  '/warehouse-access',
  isAuthenticated,
  isOnlyMohitOperator,
  async (req, res) => {
    const { userId } = req.body;
    let { warehouses } = req.body;
    try {
      const [validUser] = await pool.query(
        `SELECT u.id FROM users u INNER JOIN roles r ON u.role_id = r.id WHERE u.id = ? AND r.name = 'outofstock'`,
        [userId]
      );
      if (!validUser.length) {
        req.flash('error', 'Select a valid Out of Stock user');
        return res.redirect('/easyecom/warehouse-access');
      }

      if (!Array.isArray(warehouses)) {
        warehouses = warehouses ? [warehouses] : [];
      }
      await saveWarehouseAssignments(userId, warehouses.map((w) => Number(w)));

      req.flash('success', 'Warehouse access updated');
      return res.redirect('/easyecom/warehouse-access');
    } catch (err) {
      console.error('Failed to save warehouse access:', err);
      req.flash('error', 'Could not save warehouse access');
      return res.redirect('/easyecom/warehouse-access');
    }
  }
);

// Get count of stale health records (for cleanup preview)
router.get('/health-cleanup/count', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const [[{ stale }]] = await pool.query(
      `SELECT COUNT(*) as stale FROM ee_inventory_health
       WHERE updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND drr_per_day IS NULL`
    );
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM ee_inventory_health');
    res.json({ stale, total });
  } catch (err) {
    console.error('Failed to count stale health records:', err);
    res.status(500).json({ error: err.message });
  }
});

// Clean up stale health records (>30 days old with NULL DRR)
router.post('/health-cleanup', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const [result] = await pool.query(
      `DELETE FROM ee_inventory_health
       WHERE updated_at < DATE_SUB(NOW(), INTERVAL 30 DAY) AND drr_per_day IS NULL`
    );
    console.log(`Cleaned up ${result.affectedRows} stale health records`);
    res.json({ deleted: result.affectedRows, message: `Deleted ${result.affectedRows} stale records` });
  } catch (err) {
    console.error('Failed to cleanup health records:', err);
    res.status(500).json({ error: 'Failed to cleanup health records' });
  }
});

module.exports = router;
