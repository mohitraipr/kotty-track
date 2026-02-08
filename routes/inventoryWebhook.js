// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isMohitOperator } = require('../middlewares/auth');
const { queueHealthRefresh } = require('../utils/healthRefreshQueue');

// Access token used to authenticate incoming EasyEcom webhooks
const EASY_ECOM_TOKEN = global.env.EASYEECOM_ACCESS_TOKEN;

function verifyAccessToken(req, res, next) {
  if (!EASY_ECOM_TOKEN) {
    console.warn('EASYEECOM_ACCESS_TOKEN not set; skipping token check');
    return next();
  }
  const provided = req.get('Access-Token');
  if (provided && provided === EASY_ECOM_TOKEN) {
    return next();
  }
  return res.status(403).send('Invalid Access Token');
}

const MAKING_TIME_CACHE_MS = 5 * 60 * 1000;
let makingTimeSkuCache = { skus: new Set(), fetchedAt: 0 };

async function getMakingTimeSkus() {
  const now = Date.now();
  if (now - makingTimeSkuCache.fetchedAt < MAKING_TIME_CACHE_MS) {
    return makingTimeSkuCache.skus;
  }

  const [rows] = await pool.query(
    'SELECT DISTINCT sku FROM ee_replenishment_rules WHERE making_time_days IS NOT NULL'
  );

  const skus = new Set();
  for (const row of rows) {
    if (row?.sku) {
      skus.add(String(row.sku).toUpperCase());
    }
  }

  makingTimeSkuCache = { skus, fetchedAt: now };
  return skus;
}

async function persistInventorySnapshots(inventoryData = [], allowedSkus = new Set()) {
  if (!Array.isArray(inventoryData) || !inventoryData.length) return [];

  const preparedRows = [];
  const healthUpdates = new Map();

  for (const item of inventoryData) {
    if (!item || !item.sku) continue;
    const payload = {
      sku: item.sku.toUpperCase(),
      warehouse_id: item.warehouse_id || item.warehouseId || null,
      company_product_id: item.company_product_id || null,
      product_id: item.product_id || null,
      inventory: item.inventory != null ? Number(item.inventory) : null,
      sku_status: item.sku_status || null,
      location_key: item.location_key || null,
      raw: JSON.stringify(item),
    };
    // Save ALL inventory data (no SKU filtering for storage)
    preparedRows.push(payload);
    // Only queue health refresh for making-time SKUs (keeps analytics fast)
    if (allowedSkus.has(payload.sku) && payload.inventory !== null && payload.warehouse_id !== null) {
      const key = `${payload.sku}:${payload.warehouse_id}`;
      healthUpdates.set(key, payload);
    }
  }

  if (!preparedRows.length) return [];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const values = preparedRows.map((payload) => [
      payload.sku,
      payload.warehouse_id,
      payload.company_product_id,
      payload.product_id,
      payload.inventory,
      payload.sku_status,
      payload.location_key,
      payload.raw,
    ]);

    // Bulk insert to drastically reduce round trips and lock contention
    await connection.query(
      `INSERT INTO ee_inventory_snapshots
        (sku, warehouse_id, company_product_id, product_id, inventory, sku_status, location_key, raw)
       VALUES ?`,
      [values]
    );
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  // Queue health refresh for background processing (only making-time SKUs)
  for (const payload of healthUpdates.values()) {
    queueHealthRefresh(payload.sku, payload.warehouse_id, payload.inventory);
  }

  return preparedRows;
}

async function persistOrders(orders = [], allowedSkus = new Set()) {
  if (!Array.isArray(orders) || !orders.length) return [];

  const orderRows = [];
  const subOrderRows = [];

  for (const order of orders) {
    if (!order || !order.order_id) continue;
    const orderPayload = {
      order_id: order.order_id,
      invoice_id: order.invoice_id || null,
      reference_code: order.reference_code || null,
      company_name: order.company_name || null,
      marketplace: order.marketplace || null,
      marketplace_id: order.marketplace_id || null,
      warehouse_id: order.warehouseId || order.import_warehouse_id || null,
      location_key: order.location_key || null,
      order_status: order.order_status || null,
      order_status_id: order.order_status_id || null,
      order_date: order.order_date || null,
      import_date: order.import_date || null,
      tat: order.tat || null,
      last_update_date: order.last_update_date || null,
      total_amount: order.total_amount || null,
      total_tax: order.total_tax || null,
      total_shipping_charge: order.total_shipping_charge || null,
      total_discount: order.total_discount || null,
      collectable_amount: order.collectable_amount || null,
      order_quantity: order.order_quantity || null,
      raw: JSON.stringify(order),
    };

    if (Array.isArray(order.suborders)) {
      // Save ALL suborders (no SKU filtering for storage)
      const mappedSubs = order.suborders
        .filter((sub) => sub && sub.suborder_id)
        .map((sub) => ({
          order_id: orderPayload.order_id,
          suborder_id: sub.suborder_id,
          sku: (sub.sku || '').toUpperCase(),
          marketplace_sku: sub.marketplace_sku || null,
          product_id: sub.product_id || null,
          company_product_id: sub.company_product_id || null,
          quantity: sub.suborder_quantity || sub.item_quantity || null,
          selling_price: sub.selling_price || null,
          tax: sub.tax || null,
          tax_rate: sub.tax_rate || null,
          status: sub.item_status || null,
          shipment_type: sub.shipment_type || null,
          size: sub.size || null,
          brand: sub.brand || null,
          category: sub.category || null,
          product_name: sub.productName || sub.product_name || null,
          warehouse_id: orderPayload.warehouse_id,
          marketplace_id: orderPayload.marketplace_id,
          order_date: orderPayload.order_date,
        }));

      orderRows.push(orderPayload);
      subOrderRows.push(...mappedSubs);
    } else {
      // Save order even without suborders
      orderRows.push(orderPayload);
    }
  }

  if (!orderRows.length) return [];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const orderValues = orderRows.map((row) => [
      row.order_id,
      row.invoice_id,
      row.reference_code,
      row.company_name,
      row.marketplace,
      row.marketplace_id,
      row.warehouse_id,
      row.location_key,
      row.order_status,
      row.order_status_id,
      row.order_date,
      row.import_date,
      row.tat,
      row.last_update_date,
      row.total_amount,
      row.total_tax,
      row.total_shipping_charge,
      row.total_discount,
      row.collectable_amount,
      row.order_quantity,
      row.raw,
    ]);

    await connection.query(
      `INSERT INTO ee_orders
        (order_id, invoice_id, reference_code, company_name, marketplace, marketplace_id, warehouse_id, location_key, order_status, order_status_id, order_date, import_date, tat, last_update_date, total_amount, total_tax, total_shipping_charge, total_discount, collectable_amount, order_quantity, raw)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        invoice_id = VALUES(invoice_id),
        reference_code = VALUES(reference_code),
        company_name = VALUES(company_name),
        marketplace = VALUES(marketplace),
        marketplace_id = VALUES(marketplace_id),
        warehouse_id = VALUES(warehouse_id),
        location_key = VALUES(location_key),
        order_status = VALUES(order_status),
        order_status_id = VALUES(order_status_id),
        order_date = VALUES(order_date),
        import_date = VALUES(import_date),
        tat = VALUES(tat),
        last_update_date = VALUES(last_update_date),
        total_amount = VALUES(total_amount),
        total_tax = VALUES(total_tax),
        total_shipping_charge = VALUES(total_shipping_charge),
        total_discount = VALUES(total_discount),
        collectable_amount = VALUES(collectable_amount),
        order_quantity = VALUES(order_quantity),
        raw = VALUES(raw),
        updated_at = CURRENT_TIMESTAMP`,
      [orderValues]
    );

    if (subOrderRows.length) {
      const subOrderValues = subOrderRows.map((sub) => [
        sub.order_id,
        sub.suborder_id,
        sub.sku,
        sub.marketplace_sku,
        sub.product_id,
        sub.company_product_id,
        sub.quantity,
        sub.selling_price,
        sub.tax,
        sub.tax_rate,
        sub.status,
        sub.shipment_type,
        sub.size,
        sub.brand,
        sub.category,
        sub.product_name,
        sub.warehouse_id,
        sub.marketplace_id,
        sub.order_date,
      ]);

      await connection.query(
        `INSERT INTO ee_suborders
          (order_id, suborder_id, sku, marketplace_sku, product_id, company_product_id, quantity, selling_price, tax, tax_rate, status, shipment_type, size, brand, category, product_name, warehouse_id, marketplace_id, order_date)
         VALUES ?
         ON DUPLICATE KEY UPDATE
          sku = VALUES(sku),
          marketplace_sku = VALUES(marketplace_sku),
          product_id = VALUES(product_id),
          company_product_id = VALUES(company_product_id),
          quantity = VALUES(quantity),
          selling_price = VALUES(selling_price),
          tax = VALUES(tax),
          tax_rate = VALUES(tax_rate),
          status = VALUES(status),
          shipment_type = VALUES(shipment_type),
          size = VALUES(size),
          brand = VALUES(brand),
          category = VALUES(category),
          product_name = VALUES(product_name),
          warehouse_id = VALUES(warehouse_id),
          marketplace_id = VALUES(marketplace_id),
          order_date = VALUES(order_date),
          updated_at = CURRENT_TIMESTAMP`,
        [subOrderValues]
      );
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
  return orderRows;
}

function captureRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body.toString('utf8');
  }
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

function parseBody(raw) {
  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return raw;
}

// Receive inventory webhooks (no rate limiting - save everything)
router.post(
  '/inventory',
  verifyAccessToken,
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    let data;
    try {
      const raw = captureRawBody(req);
      data = parseBody(raw);
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }

    try {
      const allowedSkus = await getMakingTimeSkus();
      const snapshots = await persistInventorySnapshots(data.inventoryData, allowedSkus);
      res.status(200).json({ ok: true, saved: snapshots.length });
    } catch (err) {
      console.error('Inventory webhook processing failed:', err);
      res.status(500).json({ error: 'Failed to store inventory' });
    }
  }
);

// Receive order webhooks (no rate limiting - save everything)
router.post(
  '/order',
  verifyAccessToken,
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    let data;
    try {
      const raw = captureRawBody(req);
      data = parseBody(raw);
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }
    try {
      const allowedSkus = await getMakingTimeSkus();
      const saved = await persistOrders(data.orders, allowedSkus);
      res.status(200).json({ ok: true, saved: saved.length });
    } catch (err) {
      console.error('Order webhook processing failed:', err);
      res.status(500).json({ error: 'Failed to store order payload' });
    }
  }
);

// View inventory webhook logs from database (last 200 entries)
router.get('/logs', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT sku, warehouse_id, inventory, sku_status, location_key, received_at
       FROM ee_inventory_snapshots
       ORDER BY id DESC
       LIMIT 200`
    );
    const logs = rows.map((row) => ({
      time: row.received_at ? new Date(row.received_at).toISOString() : '',
      sku: row.sku,
      warehouse_id: row.warehouse_id,
      inventory: row.inventory,
      sku_status: row.sku_status,
      raw: '',
    }));
    res.render('webhookLogs', { logs, totalCount: rows.length });
  } catch (err) {
    console.error('Failed to load inventory logs:', err);
    res.render('webhookLogs', { logs: [], totalCount: 0 });
  }
});

// View order webhook logs from database (last 200 entries)
router.get('/order/logs', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT order_id, marketplace, order_status, warehouse_id, order_date, order_quantity, total_amount, created_at
       FROM ee_orders
       ORDER BY id DESC
       LIMIT 200`
    );
    const logs = rows.map((row) => ({
      time: row.created_at ? new Date(row.created_at).toISOString() : '',
      order_id: row.order_id,
      marketplace: row.marketplace,
      order_status: row.order_status,
      warehouse_id: row.warehouse_id,
      order_quantity: row.order_quantity,
      total_amount: row.total_amount,
      raw: '',
    }));
    res.render('orderWebhookLogs', { logs, totalCount: rows.length });
  } catch (err) {
    console.error('Failed to load order logs:', err);
    res.render('orderWebhookLogs', { logs: [], totalCount: 0 });
  }
});

// Get count of rows with raw data (for progress display)
router.get('/clear-raw/inventory/count', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) as total FROM ee_inventory_snapshots WHERE raw IS NOT NULL');
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/clear-raw/orders/count', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) as total FROM ee_orders WHERE raw IS NOT NULL');
    res.json({ total: rows[0].total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clear raw JSON data in batches (returns JSON with progress)
router.post('/clear-raw/inventory', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM ee_inventory_snapshots WHERE raw IS NOT NULL');
    if (total === 0) return res.json({ cleared: 0, total: 0, message: 'Already clean' });
    let cleared = 0;
    while (true) {
      const [result] = await pool.query('UPDATE ee_inventory_snapshots SET raw = NULL WHERE raw IS NOT NULL LIMIT 50000');
      cleared += result.affectedRows;
      if (result.affectedRows === 0) break;
    }
    console.log(`Cleared raw data from ${cleared} inventory snapshots`);
    res.json({ cleared, total, message: `Cleared ${cleared.toLocaleString()} rows` });
  } catch (err) {
    console.error('Failed to clear inventory raw data:', err);
    res.status(500).json({ error: 'Failed to clear raw data' });
  }
});

router.post('/clear-raw/orders', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM ee_orders WHERE raw IS NOT NULL');
    if (total === 0) return res.json({ cleared: 0, total: 0, message: 'Already clean' });
    let cleared = 0;
    while (true) {
      const [result] = await pool.query('UPDATE ee_orders SET raw = NULL WHERE raw IS NOT NULL LIMIT 50000');
      cleared += result.affectedRows;
      if (result.affectedRows === 0) break;
    }
    console.log(`Cleared raw data from ${cleared} orders`);
    res.json({ cleared, total, message: `Cleared ${cleared.toLocaleString()} rows` });
  } catch (err) {
    console.error('Failed to clear order raw data:', err);
    res.status(500).json({ error: 'Failed to clear raw data' });
  }
});

module.exports = router;
