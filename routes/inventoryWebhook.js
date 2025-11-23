// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isMohitOperator } = require('../middlewares/auth');
const {
  refreshInventoryHealth,
} = require('../utils/easyecomAnalytics');

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

// In-memory store for recent webhook requests
const logs = [];
const orderLogs = [];

async function persistInventorySnapshots(inventoryData = []) {
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
    preparedRows.push(payload);
    if (payload.inventory !== null && payload.warehouse_id !== null) {
      const key = `${payload.sku}:${payload.warehouse_id}`;
      // Keep the most recent snapshot per SKU/warehouse in this batch only
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

  // Refresh health after committing writes; reuse cached analytics to avoid extra load
  for (const payload of healthUpdates.values()) {
    await refreshInventoryHealth(pool, {
      sku: payload.sku,
      warehouseId: payload.warehouse_id,
      inventory: payload.inventory,
    });
  }

  return preparedRows;
}

async function persistOrders(orders = []) {
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

    orderRows.push(orderPayload);

    if (Array.isArray(order.suborders)) {
      for (const sub of order.suborders) {
        subOrderRows.push({
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
          product_name: sub.productName || null,
          warehouse_id: orderPayload.warehouse_id,
          marketplace_id: orderPayload.marketplace_id,
          order_date: orderPayload.order_date,
        });
      }
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

// Override global JSON parser: use raw buffer to capture true payload
router.post(
  '/inventory',
  verifyAccessToken,
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    const headers = req.headers;
    const raw = captureRawBody(req);
    let data;
    try {
      data = parseBody(raw);
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }

    const entry = {
      time: new Date().toISOString(),
      headers,
      raw,
      data,
      accessToken: req.get('Access-Token'),
    };
    logs.push(entry);
    if (logs.length > 50) logs.shift();

    try {
      const snapshots = await persistInventorySnapshots(data.inventoryData);
      res.status(200).json({ ok: true, saved: snapshots.length });
    } catch (err) {
      console.error('Inventory webhook processing failed:', err);
      res.status(500).json({ error: 'Failed to store inventory' });
    }
  }
);

// Endpoint to receive order webhooks
router.post(
  '/order',
  verifyAccessToken,
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    const headers = req.headers;
    const raw = captureRawBody(req);
    let data;
    try {
      data = parseBody(raw);
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }
    const entry = {
      time: new Date().toISOString(),
      headers,
      raw,
      data,
      accessToken: req.get('Access-Token'),
    };
    orderLogs.push(entry);
    if (orderLogs.length > 50) orderLogs.shift();
    try {
      const saved = await persistOrders(data.orders);
      res.status(200).json({ ok: true, saved: saved.length });
    } catch (err) {
      console.error('Order webhook processing failed:', err);
      res.status(500).json({ error: 'Failed to store order payload' });
    }
  }
);

// View webhook logs
router.get('/logs', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  res.render('webhookLogs', { logs });
});
router.get('/order/logs', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  res.render('orderWebhookLogs', { logs: orderLogs });
});

module.exports = router;
