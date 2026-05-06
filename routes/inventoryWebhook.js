// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isMohitOperator, allowRoles } = require('../middlewares/auth');
const { queueHealthRefresh } = require('../utils/healthRefreshQueue');
const ExcelJS = require('exceljs');

// In-memory storage for live inventory fetch jobs
const liveInventoryJobs = new Map();

// Lock to prevent concurrent downloads per warehouse (EasyEcom rate limits)
// Structure: { startTime, rowCount, cancelled: boolean }
const activeDownloads = new Map();

// Clean up old jobs every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of liveInventoryJobs.entries()) {
    // Remove jobs older than 1 hour
    if (now - job.createdAt > 60 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
      liveInventoryJobs.delete(jobId);
    }
  }
}, 30 * 60 * 1000);

// Warehouse ID to name mapping
const WAREHOUSE_LABELS = {
  173983: 'Faridabad',
  176318: 'Delhi',
};

function getWarehouseLabel(warehouseId) {
  if (warehouseId === null || warehouseId === undefined) return 'N/A';
  return WAREHOUSE_LABELS[warehouseId] || String(warehouseId);
}

// Access token used to authenticate incoming EasyEcom webhooks
const EASY_ECOM_TOKEN = global.env.EASYEECOM_ACCESS_TOKEN;

function verifyAccessToken(req, res, next) {
  if (!EASY_ECOM_TOKEN) {
    console.error('EASYEECOM_ACCESS_TOKEN not configured - rejecting webhook');
    return res.status(503).send('Webhook not configured');
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

    // Upsert: Insert or update existing row for same SKU+warehouse
    // This prevents duplicate rows when inventory value hasn't changed
    await connection.query(
      `INSERT INTO ee_inventory_snapshots
        (sku, warehouse_id, company_product_id, product_id, inventory, sku_status, location_key, raw)
       VALUES ?
       ON DUPLICATE KEY UPDATE
        inventory = VALUES(inventory),
        sku_status = VALUES(sku_status),
        company_product_id = VALUES(company_product_id),
        product_id = VALUES(product_id),
        location_key = VALUES(location_key),
        raw = VALUES(raw),
        received_at = CURRENT_TIMESTAMP`,
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

// Marketplaces we want to track per-AWB shipments for. Ajio only for now.
const SHIPMENT_TRACKED_MARKETPLACES = /ajio/i;

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function extractShipmentRow(order) {
  // EasyEcom places awb_number at order level once a label is printed.
  // Some payloads also surface it on suborder[0]. Accept both.
  const awb =
    pickFirst(order.awb_number, order.awbNumber, order.awb) ||
    (Array.isArray(order.suborders) ? pickFirst(...order.suborders.map((s) => s?.awb_number)) : null);
  if (!awb) return null;

  const marketplace = order.marketplace || '';
  if (!SHIPMENT_TRACKED_MARKETPLACES.test(marketplace)) return null;

  const status = order.order_status || null;
  const labelPrintedAt =
    pickFirst(order.label_printed_at, order.print_date, order.label_print_date) ||
    (status && /print/i.test(status) ? order.last_update_date || order.import_date : null);
  const dispatchedAt =
    pickFirst(order.dispatched_date, order.dispatch_date, order.shipped_date) ||
    (status && /dispatch|shipp|manifest/i.test(status) ? order.last_update_date : null);
  const deliveredAt = status && /delivered/i.test(status) ? order.last_update_date : null;
  const rtoAt = status && /rto|return/i.test(status) ? order.last_update_date : null;

  return {
    awb: String(awb).trim(),
    order_id: order.order_id,
    invoice_id: order.invoice_id || null,
    reference_code: order.reference_code || null,
    marketplace,
    marketplace_id: order.marketplace_id || null,
    warehouse_id: order.warehouseId || order.import_warehouse_id || null,
    courier_name: pickFirst(order.courier_aggregator_name, order.courier_name, order.courier),
    manifest_id: pickFirst(order.manifest_id, order.manifestId),
    tracking_url: pickFirst(order.tracking_url, order.track_url),
    label_status: status && /print/i.test(status) ? status : null,
    current_status: status,
    order_status_id: order.order_status_id || null,
    label_printed_at: labelPrintedAt,
    dispatched_at: dispatchedAt,
    delivered_at: deliveredAt,
    rto_at: rtoAt,
    last_seen_at: order.last_update_date || null,
    raw: JSON.stringify(order),
  };
}

async function persistShipments(shipmentRows) {
  if (!shipmentRows.length) return 0;
  const values = shipmentRows.map((s) => [
    s.awb, s.order_id, s.invoice_id, s.reference_code, s.marketplace, s.marketplace_id,
    s.warehouse_id, s.courier_name, s.manifest_id, s.tracking_url, s.label_status,
    s.current_status, s.order_status_id, s.label_printed_at, s.dispatched_at,
    s.delivered_at, s.rto_at, s.last_seen_at, 'webhook', s.raw,
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
       dispatched_at = COALESCE(ee_shipments.dispatched_at, VALUES(dispatched_at)),
       delivered_at = COALESCE(ee_shipments.delivered_at, VALUES(delivered_at)),
       rto_at = COALESCE(ee_shipments.rto_at, VALUES(rto_at)),
       last_seen_at = VALUES(last_seen_at),
       raw = VALUES(raw)`,
    [values]
  );
  return values.length;
}

async function persistOrders(orders = [], allowedSkus = new Set()) {
  if (!Array.isArray(orders) || !orders.length) return [];

  const orderRows = [];
  const subOrderRows = [];
  const shipmentRows = [];

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

    const shipmentRow = extractShipmentRow(order);
    if (shipmentRow) shipmentRows.push(shipmentRow);
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

  // Outside the orders/suborders transaction so a shipment-table issue
  // can never roll back the primary ee_orders write.
  if (shipmentRows.length) {
    try {
      await persistShipments(shipmentRows);
    } catch (err) {
      console.error('persistShipments failed (orders saved OK):', err);
    }
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

// Roles allowed to access inventory logs
const LOGS_ALLOWED_ROLES = ['operator', 'wishlinkops'];

// View inventory webhook logs from database (last 200 entries)
router.get('/logs', isAuthenticated, allowRoles(LOGS_ALLOWED_ROLES), async (req, res) => {
  try {
    const username = req.session?.user?.username || '';
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
      warehouse_name: getWarehouseLabel(row.warehouse_id),
      inventory: row.inventory,
      sku_status: row.sku_status,
      raw: '',
    }));
    res.render('webhookLogs', { logs, totalCount: rows.length, username });
  } catch (err) {
    console.error('Failed to load inventory logs:', err);
    res.render('webhookLogs', { logs: [], totalCount: 0, username: '' });
  }
});

// Get count of inventory records for download preview
router.get('/logs/download-count', isAuthenticated, allowRoles(LOGS_ALLOWED_ROLES), async (req, res) => {
  try {
    const warehouseId = req.query.warehouse_id;
    let query = 'SELECT COUNT(*) as total FROM ee_inventory_snapshots';
    const params = [];

    if (warehouseId) {
      query += ' WHERE warehouse_id = ?';
      params.push(warehouseId);
    }

    const [[{ total }]] = await pool.query(query, params);
    res.json({ total });
  } catch (err) {
    console.error('Failed to count inventory:', err);
    res.status(500).json({ error: 'Failed to count records' });
  }
});

// Download inventory as Excel (chunked queries, streaming write)
// wishlinkops users get a special format for inventory adjustment upload
router.get('/logs/download-excel', isAuthenticated, allowRoles(LOGS_ALLOWED_ROLES), async (req, res) => {
  try {
    const username = req.session?.user?.username || '';
    const userRole = req.session?.user?.role || req.session?.user?.roleName || '';
    const isWishlinkOps = userRole === 'wishlinkops' || username.toLowerCase() === 'vinaykumar';
    const warehouseId = req.query.warehouse_id;

    // Set headers before streaming
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    let filename = isWishlinkOps ? 'inventory_adjustment' : 'inventory_snapshots';
    if (warehouseId) {
      const whName = warehouseId === '176318' ? 'delhi' : warehouseId === '173983' ? 'faridabad' : warehouseId;
      filename += '_' + whName;
    }
    res.setHeader('Content-Disposition', `attachment; filename=${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`);

    // Create streaming workbook that writes directly to response
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: false,
    });

    const sheet = workbook.addWorksheet('Inventory');

    // Define columns based on user role
    if (isWishlinkOps) {
      // WishlinkOps format for inventory adjustment upload
      sheet.columns = [
        { header: 'Product Code*', key: 'product_code', width: 20 },
        { header: 'Quantity*', key: 'quantity', width: 12 },
        { header: 'Shelf Code*', key: 'shelf_code', width: 15 },
        { header: 'Adjustment Type*', key: 'adjustment_type', width: 18 },
        { header: 'Inventory Type', key: 'inventory_type', width: 15 },
        { header: 'Transfer to Shelf Code', key: 'transfer_shelf', width: 22 },
        { header: 'Sla', key: 'sla', width: 10 },
        { header: 'Source Batch Code', key: 'source_batch', width: 18 },
        { header: 'Remarks', key: 'remarks', width: 15 },
        { header: 'Force Allocate', key: 'force_allocate', width: 15 },
      ];
    } else {
      // Standard format for operators
      sheet.columns = [
        { header: 'Time', key: 'time', width: 22 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: 'Warehouse', key: 'warehouse_name', width: 15 },
        { header: 'Warehouse ID', key: 'warehouse_id', width: 12 },
        { header: 'Inventory', key: 'inventory', width: 10 },
        { header: 'Status', key: 'sku_status', width: 12 },
      ];
    }

    // Style header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    headerRow.commit();

    // Stream data in chunks - fetch and write immediately
    const CHUNK_SIZE = 5000;
    let offset = 0;
    let hasMore = true;

    // Build query with optional warehouse filter
    const whereClause = warehouseId ? 'WHERE warehouse_id = ?' : '';
    const baseParams = warehouseId ? [warehouseId] : [];

    while (hasMore) {
      const [rows] = await pool.query(
        `SELECT sku, warehouse_id, inventory, sku_status, received_at
         FROM ee_inventory_snapshots
         ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...baseParams, CHUNK_SIZE, offset]
      );

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      for (const row of rows) {
        let dataRow;
        if (isWishlinkOps) {
          // WishlinkOps format
          dataRow = sheet.addRow({
            product_code: row.sku,
            quantity: row.inventory,
            shelf_code: 'default',
            adjustment_type: 'replace',
            inventory_type: '',
            transfer_shelf: '',
            sla: '',
            source_batch: '',
            remarks: '',
            force_allocate: '',
          });
        } else {
          // Standard format
          dataRow = sheet.addRow({
            time: row.received_at ? new Date(row.received_at).toISOString() : '',
            sku: row.sku,
            warehouse_name: getWarehouseLabel(row.warehouse_id),
            warehouse_id: row.warehouse_id,
            inventory: row.inventory,
            sku_status: row.sku_status,
          });
        }
        dataRow.commit(); // Commit each row to free memory
      }

      offset += rows.length;

      if (rows.length < CHUNK_SIZE) {
        hasMore = false;
      }
    }

    // Commit the worksheet and workbook
    sheet.commit();
    await workbook.commit();

  } catch (err) {
    console.error('Failed to generate inventory Excel:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate Excel file' });
    }
  }
});

// Download live inventory from EasyEcom API (includes virtual inventory)
// Only for vinaykumar / wishlinkops role
router.get('/logs/download-live', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), async (req, res) => {
  try {
    const username = req.session?.user?.username || '';
    const userRole = req.session?.user?.role || req.session?.user?.roleName || '';
    const isWishlinkOps = userRole === 'wishlinkops' || username.toLowerCase() === 'vinaykumar';

    // Only vinaykumar can use this feature
    if (!isWishlinkOps && username.toLowerCase() !== 'mohit') {
      return res.status(403).json({ error: 'This feature is only available for authorized users' });
    }

    const warehouseName = req.query.warehouse; // 'delhi' or 'faridabad'

    if (!warehouseName) {
      return res.status(400).json({ error: 'warehouse parameter required (delhi or faridabad)' });
    }

    // Prevent concurrent downloads for same warehouse (EasyEcom rate limits)
    const warehouseKey = warehouseName.toLowerCase();
    if (activeDownloads.has(warehouseKey)) {
      const activeInfo = activeDownloads.get(warehouseKey);
      const elapsed = Math.round((Date.now() - activeInfo.startTime) / 1000);
      return res.status(429).json({
        error: `Download already in progress for ${warehouseName} (${elapsed}s elapsed, ${activeInfo.rowCount} SKUs fetched). Please wait.`
      });
    }

    // Import the EasyEcom client
    const { getInventoryFromApi, isConfigured } = require('../utils/easyecomReturnsClient');

    if (!isConfigured(warehouseName)) {
      return res.status(500).json({ error: `EasyEcom API not configured for warehouse: ${warehouseName}` });
    }

    // Set download lock
    activeDownloads.set(warehouseKey, { startTime: Date.now(), rowCount: 0 });
    console.log(`Starting live CSV inventory fetch for ${warehouseName}...`);

    // Set request timeout to prevent Cloud Run from disconnecting (max 60 minutes)
    req.setTimeout(3600000); // 60 minutes
    res.setTimeout(3600000); // 60 minutes

    // Chunked streaming approach - sends data in batches for progress visibility
    const filename = `inventory_live_${warehouseName}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    // Write CSV header
    res.write('Product Code*,Quantity*,Shelf Code*,Adjustment Type*,Inventory Type,Transfer to Shelf Code,Sla,Source Batch Code,Remarks,Force Allocate\n');

    let rowCount = 0;
    const startTime = Date.now();
    const CHUNK_SIZE = 500;
    let chunk = [];

    for await (const item of getInventoryFromApi(warehouseName)) {
      // Check for cancellation
      const currentJob = activeDownloads.get(warehouseKey);
      if (currentJob?.cancelled) {
        console.log(`Download cancelled for ${warehouseName} at ${rowCount} rows`);
        activeDownloads.delete(warehouseKey);
        res.write(`\n# Download cancelled at ${rowCount} rows\n`);
        return res.end();
      }

      const sku = item.sku.includes(',') ? `"${item.sku}"` : item.sku;
      chunk.push(`${sku},${item.total_qty},default,replace,,,,,`);
      rowCount++;

      // Send chunk every CHUNK_SIZE rows
      if (chunk.length >= CHUNK_SIZE) {
        res.write(chunk.join('\n') + '\n');
        chunk = [];
      }

      // Update lock with progress
      if (rowCount % 1000 === 0) {
        activeDownloads.set(warehouseKey, { startTime, rowCount, cancelled: false });
      }

      if (rowCount % 10000 === 0) {
        console.log(`Live CSV: ${rowCount} rows streamed (${Math.round((Date.now() - startTime) / 1000)}s)`);
      }
    }

    // Send remaining rows
    if (chunk.length > 0) {
      res.write(chunk.join('\n') + '\n');
    }

    // Release lock
    activeDownloads.delete(warehouseKey);

    res.end();
    console.log(`Live CSV complete: ${rowCount} rows in ${Math.round((Date.now() - startTime) / 1000)}s`);

  } catch (err) {
    // Release lock on error
    const warehouseKey = (req.query.warehouse || '').toLowerCase();
    activeDownloads.delete(warehouseKey);

    console.error('Failed to download live inventory:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download live inventory: ' + err.message });
    }
  }
});

// Stop an active download
router.post('/logs/stop-download', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), (req, res) => {
  const warehouseName = req.query.warehouse || req.body.warehouse;

  if (!warehouseName) {
    return res.status(400).json({ error: 'warehouse parameter required' });
  }

  const warehouseKey = warehouseName.toLowerCase();
  const activeJob = activeDownloads.get(warehouseKey);

  if (!activeJob) {
    return res.json({ success: true, message: `No active download for ${warehouseName}` });
  }

  // Mark as cancelled
  activeJob.cancelled = true;
  activeDownloads.set(warehouseKey, activeJob);

  console.log(`Download cancelled for ${warehouseName} at ${activeJob.rowCount} rows`);
  res.json({
    success: true,
    message: `Download stopped for ${warehouseName}`,
    rowsFetched: activeJob.rowCount
  });
});

// Check download status - returns active job or last completed job
router.get('/logs/download-status', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), (req, res) => {
  const warehouseName = req.query.warehouse;

  if (warehouseName) {
    const warehouseKey = warehouseName.toLowerCase();
    const activeJob = activeDownloads.get(warehouseKey);

    // Check for active download
    if (activeJob && !activeJob.cancelled) {
      const elapsed = Math.round((Date.now() - activeJob.startTime) / 1000);
      return res.json({
        active: true,
        warehouse: warehouseName,
        jobId: activeJob.jobId || null,
        elapsed,
        rowCount: activeJob.rowCount,
        cancelled: false
      });
    }

    // Check for recently completed job for this warehouse
    let lastCompleted = null;
    for (const [jobId, job] of liveInventoryJobs.entries()) {
      if (job.warehouse?.toLowerCase() === warehouseKey) {
        const age = Date.now() - job.createdAt;
        if (age < 30 * 60 * 1000) { // Less than 30 minutes old
          if (!lastCompleted || job.createdAt > lastCompleted.createdAt) {
            lastCompleted = {
              jobId,
              rowCount: job.rowCount,
              createdAt: job.createdAt,
              ageSeconds: Math.round(age / 1000),
              downloadUrl: `/webhook/logs/download-cached/${jobId}`
            };
          }
        }
      }
    }

    return res.json({
      active: false,
      warehouse: warehouseName,
      lastCompleted
    });
  }

  // Return all active downloads
  const active = [];
  for (const [wh, job] of activeDownloads.entries()) {
    if (!job.cancelled) {
      active.push({
        warehouse: wh,
        jobId: job.jobId || null,
        elapsed: Math.round((Date.now() - job.startTime) / 1000),
        rowCount: job.rowCount
      });
    }
  }
  res.json({ downloads: active });
});

// SSE endpoint: Fetch live inventory with real-time progress
// If job already running for warehouse, sends current status and watches progress
// Returns progress updates and a download link when complete
router.get('/logs/fetch-live', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), async (req, res) => {
  const warehouseName = req.query.warehouse; // 'delhi' or 'faridabad'

  if (!warehouseName || !['delhi', 'faridabad'].includes(warehouseName.toLowerCase())) {
    return res.status(400).json({ error: 'warehouse parameter required (delhi or faridabad)' });
  }

  const warehouseKey = warehouseName.toLowerCase();
  const { getInventoryFromApi, isConfigured } = require('../utils/easyecomReturnsClient');

  if (!isConfigured(warehouseName)) {
    return res.status(500).json({ error: `EasyEcom API not configured for warehouse: ${warehouseName}` });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Check if there's already an active job for this warehouse
  const existingJob = activeDownloads.get(warehouseKey);
  if (existingJob && !existingJob.cancelled) {
    // Attach to existing job - poll for updates
    sendEvent('attached', {
      jobId: existingJob.jobId,
      warehouse: warehouseName,
      rowCount: existingJob.rowCount,
      elapsed: Math.round((Date.now() - existingJob.startTime) / 1000),
      message: `Attached to running job (${existingJob.rowCount.toLocaleString()} SKUs fetched)`
    });

    // Poll for updates until job completes
    const pollInterval = setInterval(() => {
      const job = activeDownloads.get(warehouseKey);
      if (!job) {
        // Job completed - check for completed job in liveInventoryJobs
        clearInterval(pollInterval);
        for (const [jobId, completedJob] of liveInventoryJobs.entries()) {
          if (completedJob.warehouse?.toLowerCase() === warehouseKey) {
            const age = Date.now() - completedJob.createdAt;
            if (age < 60000) { // Completed in last minute
              sendEvent('complete', {
                jobId,
                warehouse: warehouseName,
                totalSkus: completedJob.rowCount,
                downloadUrl: `/webhook/logs/download-cached/${jobId}`,
                message: `Download ready (${completedJob.rowCount.toLocaleString()} SKUs)`
              });
              res.end();
              return;
            }
          }
        }
        sendEvent('error', { message: 'Job completed but result not found' });
        res.end();
      } else if (job.cancelled) {
        clearInterval(pollInterval);
        sendEvent('error', { message: 'Job was cancelled' });
        res.end();
      } else {
        // Send progress update
        sendEvent('progress', {
          fetched: job.rowCount,
          elapsed: Math.round((Date.now() - job.startTime) / 1000),
          message: `Fetched ${job.rowCount.toLocaleString()} SKUs...`
        });
      }
    }, 2000); // Poll every 2 seconds

    // Cleanup on disconnect
    req.on('close', () => clearInterval(pollInterval));
    return;
  }

  // Generate job ID and start new job
  const jobId = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const startTime = Date.now();

  // Register in activeDownloads
  activeDownloads.set(warehouseKey, {
    jobId,
    startTime,
    rowCount: 0,
    cancelled: false
  });

  try {
    sendEvent('start', { jobId, warehouse: warehouseName, message: 'Starting inventory fetch...' });

    // Create temp file for Excel
    const tempDir = os.tmpdir();
    const filePath = path.join(tempDir, `inventory_${jobId}.xlsx`);

    // Create workbook
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inventory');

    // Uniware format columns
    sheet.columns = [
      { header: 'Product Code*', key: 'product_code', width: 20 },
      { header: 'Quantity*', key: 'quantity', width: 12 },
      { header: 'Shelf Code*', key: 'shelf_code', width: 15 },
      { header: 'Adjustment Type*', key: 'adjustment_type', width: 18 },
      { header: 'Inventory Type', key: 'inventory_type', width: 15 },
      { header: 'Transfer to Shelf Code', key: 'transfer_shelf', width: 22 },
      { header: 'Sla', key: 'sla', width: 10 },
      { header: 'Source Batch Code', key: 'source_batch', width: 18 },
      { header: 'Remarks', key: 'remarks', width: 15 },
      { header: 'Force Allocate', key: 'force_allocate', width: 15 },
    ];

    // Style header
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };

    let rowCount = 0;

    // Fetch and write data
    for await (const item of getInventoryFromApi(warehouseName)) {
      // Check for cancellation
      const currentJob = activeDownloads.get(warehouseKey);
      if (currentJob?.cancelled) {
        activeDownloads.delete(warehouseKey);
        sendEvent('error', { message: 'Download cancelled' });
        res.end();
        return;
      }

      sheet.addRow({
        product_code: item.sku,
        quantity: item.total_qty,
        shelf_code: 'default',
        adjustment_type: 'replace',
        inventory_type: '',
        transfer_shelf: '',
        sla: '',
        source_batch: '',
        remarks: '',
        force_allocate: '',
      });
      rowCount++;

      // Update progress in activeDownloads
      if (rowCount % 100 === 0) {
        activeDownloads.set(warehouseKey, { jobId, startTime, rowCount, cancelled: false });
      }

      // Send progress every 500 rows
      if (rowCount % 500 === 0) {
        sendEvent('progress', {
          fetched: rowCount,
          message: `Fetched ${rowCount.toLocaleString()} SKUs...`,
          elapsed: Math.round((Date.now() - startTime) / 1000)
        });
      }
    }

    // Remove from active downloads
    activeDownloads.delete(warehouseKey);

    // Save workbook
    await workbook.xlsx.writeFile(filePath);

    // Store job info
    liveInventoryJobs.set(jobId, {
      filePath,
      warehouse: warehouseName,
      rowCount,
      createdAt: Date.now(),
      username: req.session?.user?.username || 'unknown'
    });

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    sendEvent('complete', {
      jobId,
      warehouse: warehouseName,
      totalSkus: rowCount,
      elapsed,
      downloadUrl: `/webhook/logs/download-cached/${jobId}`,
      message: `Fetched ${rowCount.toLocaleString()} SKUs in ${elapsed}s`
    });

    res.end();

  } catch (err) {
    activeDownloads.delete(warehouseKey);
    console.error('Live fetch failed:', err);
    sendEvent('error', { message: err.message });
    res.end();
  }
});

// Download cached inventory file
router.get('/logs/download-cached/:jobId', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), (req, res) => {
  const { jobId } = req.params;
  const job = liveInventoryJobs.get(jobId);

  if (!job || !job.filePath) {
    return res.status(404).json({ error: 'Download not found or expired. Please fetch again.' });
  }

  if (!fs.existsSync(job.filePath)) {
    liveInventoryJobs.delete(jobId);
    return res.status(404).json({ error: 'File expired. Please fetch again.' });
  }

  const filename = `inventory_live_${job.warehouse}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);

  stream.on('end', () => {
    // Clean up file after download
    setTimeout(() => {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
      liveInventoryJobs.delete(jobId);
    }, 5000);
  });
});

// View order webhook logs from database (last 200 entries)
router.get('/order/logs', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT eo.order_id, eo.marketplace, eo.order_status, eo.warehouse_id, eo.order_date, eo.order_quantity, eo.total_amount, eo.created_at,
              GROUP_CONCAT(DISTINCT es.sku ORDER BY es.sku SEPARATOR ', ') AS skus
       FROM ee_orders eo
       LEFT JOIN ee_suborders es ON eo.order_id = es.order_id
       GROUP BY eo.id, eo.order_id, eo.marketplace, eo.order_status, eo.warehouse_id, eo.order_date, eo.order_quantity, eo.total_amount, eo.created_at
       ORDER BY eo.id DESC
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
      skus: row.skus || '',
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

// Clear raw JSON data in batches (limit per request to avoid timeout)
const CLEAR_BATCH_SIZE = 50000;
const MAX_BATCHES_PER_REQUEST = 5; // 250K rows max per request to avoid 504 timeout

router.post('/clear-raw/inventory', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM ee_inventory_snapshots WHERE raw IS NOT NULL');
    if (total === 0) return res.json({ cleared: 0, remaining: 0, total: 0, done: true, message: 'Already clean' });

    let cleared = 0;
    for (let i = 0; i < MAX_BATCHES_PER_REQUEST; i++) {
      const [result] = await pool.query('UPDATE ee_inventory_snapshots SET raw = NULL WHERE raw IS NOT NULL LIMIT ?', [CLEAR_BATCH_SIZE]);
      cleared += result.affectedRows;
      if (result.affectedRows === 0) break;
    }

    const [[{ remaining }]] = await pool.query('SELECT COUNT(*) as remaining FROM ee_inventory_snapshots WHERE raw IS NOT NULL');
    const done = remaining === 0;
    console.log(`Cleared raw data from ${cleared} inventory snapshots, ${remaining} remaining`);
    res.json({ cleared, remaining, total, done, message: done ? `Done! Cleared ${cleared.toLocaleString()} rows` : `Cleared ${cleared.toLocaleString()}, ${remaining.toLocaleString()} remaining...` });
  } catch (err) {
    console.error('Failed to clear inventory raw data:', err);
    res.status(500).json({ error: 'Failed to clear raw data' });
  }
});

router.post('/clear-raw/orders', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  try {
    const [[{ total }]] = await pool.query('SELECT COUNT(*) as total FROM ee_orders WHERE raw IS NOT NULL');
    if (total === 0) return res.json({ cleared: 0, remaining: 0, total: 0, done: true, message: 'Already clean' });

    let cleared = 0;
    for (let i = 0; i < MAX_BATCHES_PER_REQUEST; i++) {
      const [result] = await pool.query('UPDATE ee_orders SET raw = NULL WHERE raw IS NOT NULL LIMIT ?', [CLEAR_BATCH_SIZE]);
      cleared += result.affectedRows;
      if (result.affectedRows === 0) break;
    }

    const [[{ remaining }]] = await pool.query('SELECT COUNT(*) as remaining FROM ee_orders WHERE raw IS NOT NULL');
    const done = remaining === 0;
    console.log(`Cleared raw data from ${cleared} orders, ${remaining} remaining`);
    res.json({ cleared, remaining, total, done, message: done ? `Done! Cleared ${cleared.toLocaleString()} rows` : `Cleared ${cleared.toLocaleString()}, ${remaining.toLocaleString()} remaining...` });
  } catch (err) {
    console.error('Failed to clear order raw data:', err);
    res.status(500).json({ error: 'Failed to clear raw data' });
  }
});

module.exports = router;
