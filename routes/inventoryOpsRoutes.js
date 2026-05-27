// routes/inventoryOpsRoutes.js
//
// Read-only inventory log views + Vinay's live-download tooling.
// Split out of routes/inventoryWebhook.js when the EasyEcom webhook receivers
// were retired (replaced by utils/easyecomPullWorker.js).
// Mounted at /inventory-ops. Legacy /webhook/logs/* URLs are no longer routed —
// use /inventory-ops/logs/* and /inventory-ops/order/logs.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pool } = require('../config/db');
const { isAuthenticated, isOperator, isMohitOperator, allowRoles } = require('../middlewares/auth');
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
    if (now - job.createdAt > 60 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
      liveInventoryJobs.delete(jobId);
    }
  }
}, 30 * 60 * 1000);

const WAREHOUSE_LABELS = {
  173983: 'Faridabad',
  176318: 'Delhi',
};

function getWarehouseLabel(warehouseId) {
  if (warehouseId === null || warehouseId === undefined) return 'N/A';
  return WAREHOUSE_LABELS[warehouseId] || String(warehouseId);
}

// Roles allowed to access inventory logs
const LOGS_ALLOWED_ROLES = ['operator', 'wishlinkops'];

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

router.get('/logs/download-excel', isAuthenticated, allowRoles(LOGS_ALLOWED_ROLES), async (req, res) => {
  try {
    const username = req.session?.user?.username || '';
    const userRole = req.session?.user?.role || req.session?.user?.roleName || '';
    const isWishlinkOps = userRole === 'wishlinkops' || username.toLowerCase() === 'vinaykumar';
    const warehouseId = req.query.warehouse_id;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    let filename = isWishlinkOps ? 'inventory_adjustment' : 'inventory_snapshots';
    if (warehouseId) {
      const whName = warehouseId === '176318' ? 'delhi' : warehouseId === '173983' ? 'faridabad' : warehouseId;
      filename += '_' + whName;
    }
    res.setHeader('Content-Disposition', `attachment; filename=${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: res,
      useStyles: true,
      useSharedStrings: false,
    });

    const sheet = workbook.addWorksheet('Inventory');

    if (isWishlinkOps) {
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
      sheet.columns = [
        { header: 'Time', key: 'time', width: 22 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: 'Warehouse', key: 'warehouse_name', width: 15 },
        { header: 'Warehouse ID', key: 'warehouse_id', width: 12 },
        { header: 'Inventory', key: 'inventory', width: 10 },
        { header: 'Status', key: 'sku_status', width: 12 },
      ];
    }

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF333333' } };
    headerRow.commit();

    const CHUNK_SIZE = 5000;
    let offset = 0;
    let hasMore = true;

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
          dataRow = sheet.addRow({
            time: row.received_at ? new Date(row.received_at).toISOString() : '',
            sku: row.sku,
            warehouse_name: getWarehouseLabel(row.warehouse_id),
            warehouse_id: row.warehouse_id,
            inventory: row.inventory,
            sku_status: row.sku_status,
          });
        }
        dataRow.commit();
      }

      offset += rows.length;

      if (rows.length < CHUNK_SIZE) {
        hasMore = false;
      }
    }

    sheet.commit();
    await workbook.commit();

  } catch (err) {
    console.error('Failed to generate inventory Excel:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate Excel file' });
    }
  }
});

router.get('/logs/download-live', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), async (req, res) => {
  try {
    const username = req.session?.user?.username || '';
    const userRole = req.session?.user?.role || req.session?.user?.roleName || '';
    const isWishlinkOps = userRole === 'wishlinkops' || username.toLowerCase() === 'vinaykumar';

    if (!isWishlinkOps && username.toLowerCase() !== 'mohit') {
      return res.status(403).json({ error: 'This feature is only available for authorized users' });
    }

    const warehouseName = req.query.warehouse;

    if (!warehouseName) {
      return res.status(400).json({ error: 'warehouse parameter required (delhi or faridabad)' });
    }

    const warehouseKey = warehouseName.toLowerCase();
    if (activeDownloads.has(warehouseKey)) {
      const activeInfo = activeDownloads.get(warehouseKey);
      const elapsed = Math.round((Date.now() - activeInfo.startTime) / 1000);
      return res.status(429).json({
        error: `Download already in progress for ${warehouseName} (${elapsed}s elapsed, ${activeInfo.rowCount} SKUs fetched). Please wait.`
      });
    }

    const { getInventoryFromApi, isConfigured } = require('../utils/easyecomReturnsClient');

    if (!isConfigured(warehouseName)) {
      return res.status(500).json({ error: `EasyEcom API not configured for warehouse: ${warehouseName}` });
    }

    activeDownloads.set(warehouseKey, { startTime: Date.now(), rowCount: 0 });
    console.log(`Starting live CSV inventory fetch for ${warehouseName}...`);

    req.setTimeout(3600000);
    res.setTimeout(3600000);

    const filename = `inventory_live_${warehouseName}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    res.write('Product Code*,Quantity*,Shelf Code*,Adjustment Type*,Inventory Type,Transfer to Shelf Code,Sla,Source Batch Code,Remarks,Force Allocate\n');

    let rowCount = 0;
    const startTime = Date.now();
    const CHUNK_SIZE = 500;
    let chunk = [];

    for await (const item of getInventoryFromApi(warehouseName)) {
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

      if (chunk.length >= CHUNK_SIZE) {
        res.write(chunk.join('\n') + '\n');
        chunk = [];
      }

      if (rowCount % 1000 === 0) {
        activeDownloads.set(warehouseKey, { startTime, rowCount, cancelled: false });
      }

      if (rowCount % 10000 === 0) {
        console.log(`Live CSV: ${rowCount} rows streamed (${Math.round((Date.now() - startTime) / 1000)}s)`);
      }
    }

    if (chunk.length > 0) {
      res.write(chunk.join('\n') + '\n');
    }

    activeDownloads.delete(warehouseKey);

    res.end();
    console.log(`Live CSV complete: ${rowCount} rows in ${Math.round((Date.now() - startTime) / 1000)}s`);

  } catch (err) {
    const warehouseKey = (req.query.warehouse || '').toLowerCase();
    activeDownloads.delete(warehouseKey);

    console.error('Failed to download live inventory:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download live inventory: ' + err.message });
    }
  }
});

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

  activeJob.cancelled = true;
  activeDownloads.set(warehouseKey, activeJob);

  console.log(`Download cancelled for ${warehouseName} at ${activeJob.rowCount} rows`);
  res.json({
    success: true,
    message: `Download stopped for ${warehouseName}`,
    rowsFetched: activeJob.rowCount
  });
});

router.get('/logs/download-status', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), (req, res) => {
  const warehouseName = req.query.warehouse;

  if (warehouseName) {
    const warehouseKey = warehouseName.toLowerCase();
    const activeJob = activeDownloads.get(warehouseKey);

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

    let lastCompleted = null;
    for (const [jobId, job] of liveInventoryJobs.entries()) {
      if (job.warehouse?.toLowerCase() === warehouseKey) {
        const age = Date.now() - job.createdAt;
        if (age < 30 * 60 * 1000) {
          if (!lastCompleted || job.createdAt > lastCompleted.createdAt) {
            lastCompleted = {
              jobId,
              rowCount: job.rowCount,
              createdAt: job.createdAt,
              ageSeconds: Math.round(age / 1000),
              downloadUrl: `/inventory-ops/logs/download-cached/${jobId}`
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

router.get('/logs/fetch-live', isAuthenticated, allowRoles(['wishlinkops', 'mohit', 'operator']), async (req, res) => {
  const warehouseName = req.query.warehouse;

  if (!warehouseName || !['delhi', 'faridabad'].includes(warehouseName.toLowerCase())) {
    return res.status(400).json({ error: 'warehouse parameter required (delhi or faridabad)' });
  }

  const warehouseKey = warehouseName.toLowerCase();
  const { fetchFullInventoryReport, isConfigured } = require('../utils/easyecomReturnsClient');

  if (!isConfigured(warehouseName)) {
    return res.status(500).json({ error: `EasyEcom API not configured for warehouse: ${warehouseName}` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const existingJob = activeDownloads.get(warehouseKey);
  if (existingJob && !existingJob.cancelled) {
    sendEvent('attached', {
      jobId: existingJob.jobId,
      warehouse: warehouseName,
      rowCount: existingJob.rowCount,
      elapsed: Math.round((Date.now() - existingJob.startTime) / 1000),
      message: `Attached to running job (${existingJob.rowCount.toLocaleString()} SKUs fetched)`
    });

    const pollInterval = setInterval(() => {
      const job = activeDownloads.get(warehouseKey);
      if (!job) {
        clearInterval(pollInterval);
        for (const [jobId, completedJob] of liveInventoryJobs.entries()) {
          if (completedJob.warehouse?.toLowerCase() === warehouseKey) {
            const age = Date.now() - completedJob.createdAt;
            if (age < 60000) {
              sendEvent('complete', {
                jobId,
                warehouse: warehouseName,
                totalSkus: completedJob.rowCount,
                downloadUrl: `/inventory-ops/logs/download-cached/${jobId}`,
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
        sendEvent('progress', {
          fetched: job.rowCount,
          elapsed: Math.round((Date.now() - job.startTime) / 1000),
          message: `Fetched ${job.rowCount.toLocaleString()} SKUs...`
        });
      }
    }, 2000);

    req.on('close', () => clearInterval(pollInterval));
    return;
  }

  const jobId = `inv_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const startTime = Date.now();

  activeDownloads.set(warehouseKey, {
    jobId,
    startTime,
    rowCount: 0,
    cancelled: false
  });

  try {
    sendEvent('start', { jobId, warehouse: warehouseName, message: 'Queueing inventory report at EasyEcom...' });

    const tempDir = os.tmpdir();
    const filePath = path.join(tempDir, `inventory_${jobId}.csv`);
    const csvStream = fs.createWriteStream(filePath, { encoding: 'utf8' });

    const csvCell = (val) => {
      if (val === null || val === undefined) return '';
      const s = String(val);
      if (s.indexOf(',') === -1 && s.indexOf('"') === -1 && s.indexOf('\n') === -1) return s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const writeRow = (cols) => {
      const line = cols.map(csvCell).join(',') + '\n';
      if (!csvStream.write(line)) {
        return new Promise((resolve) => csvStream.once('drain', resolve));
      }
      return null;
    };

    writeRow([
      'Product Code*', 'Quantity*', 'Shelf Code*', 'Adjustment Type*',
      'Inventory Type', 'Transfer to Shelf Code', 'Sla',
      'Source Batch Code', 'Remarks', 'Force Allocate',
    ]);

    // Adaptive header pickup — FULL_INVENTORY_REPORT column names are not
    // contract-stable, so we try common variants.
    const pickField = (row, candidates) => {
      for (const k of candidates) {
        if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') return row[k];
      }
      return undefined;
    };
    const SKU_KEYS  = ['sku', 'SKU', 'Sku', 'Product Code', 'Product Code*', 'productCode', 'product_code'];
    const QTY_KEYS  = ['available', 'Available', 'availableInventory', 'Available Quantity', 'Available Qty', 'Qty Available', 'qty', 'Quantity', 'Quantity*', 'Inventory', 'inventoryCount', 'inventory_count', 'Stock'];
    const BIN_KEYS  = ['Shelf Code', 'Shelf Code*', 'Shelf', 'shelf', 'shelf_code', 'Bin', 'Bin Code', 'bin', 'bin_code', 'Location', 'Location Key', 'location_key', 'Sub Location', 'sub_location'];

    const onProgress = (info) => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const job = activeDownloads.get(warehouseKey);
      const rowCount = job?.rowCount || 0;
      let message;
      switch (info.phase) {
        case 'queueing':       message = 'Queueing report at EasyEcom...'; break;
        case 'queued':         message = `Report queued (id ${info.reportId}). Waiting for generation...`; break;
        case 'polling':        message = `Report status: ${info.status || 'pending'} (${info.elapsed || elapsed}s)`; break;
        case 'downloading':    message = 'Report ready. Downloading CSV...'; break;
        case 'downloading_s3': message = 'Downloading CSV from S3...'; break;
        case 'parsing':        message = 'Parsing CSV...'; break;
        case 'parsed':         message = `Parsed ${(info.rowCount || 0).toLocaleString()} rows. Writing output...`; break;
        default:               message = info.phase;
      }
      sendEvent('progress', { fetched: rowCount, message, elapsed });
    };

    const reportRows = await fetchFullInventoryReport(
      warehouseName,
      { statuses: 'Available' },
      onProgress
    );

    // Cancellation check between phases (we cannot interrupt EasyEcom's
    // server-side report generation, but we can abandon the write).
    if (activeDownloads.get(warehouseKey)?.cancelled) {
      activeDownloads.delete(warehouseKey);
      csvStream.end();
      try { fs.unlinkSync(filePath); } catch (_) {}
      sendEvent('error', { message: 'Download cancelled' });
      res.end();
      return;
    }

    let rowCount = 0;
    let skipped = 0;
    for (const r of reportRows) {
      const sku = pickField(r, SKU_KEYS);
      if (!sku) { skipped++; continue; }
      const qtyRaw = pickField(r, QTY_KEYS);
      const qty = qtyRaw === undefined ? 0 : (Number(qtyRaw) || 0);
      const shelf = pickField(r, BIN_KEYS) || 'default';

      const drainPromise = writeRow([
        sku, qty, shelf, 'replace',
        '', '', '', '', '', '',
      ]);
      if (drainPromise) await drainPromise;
      rowCount++;

      if (rowCount % 500 === 0) {
        activeDownloads.set(warehouseKey, { jobId, startTime, rowCount, cancelled: false });
        sendEvent('progress', {
          fetched: rowCount,
          message: `Wrote ${rowCount.toLocaleString()} rows...`,
          elapsed: Math.round((Date.now() - startTime) / 1000)
        });
      }
    }
    activeDownloads.set(warehouseKey, { jobId, startTime, rowCount, cancelled: false });
    if (skipped) console.log(`[fetch-live/report] skipped ${skipped} rows missing SKU for ${warehouseName}`);

    await new Promise((resolve, reject) => {
      csvStream.end((err) => (err ? reject(err) : resolve()));
    });

    activeDownloads.delete(warehouseKey);

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
      downloadUrl: `/inventory-ops/logs/download-cached/${jobId}`,
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

  const isCsv = job.filePath.toLowerCase().endsWith('.csv');
  const ext = isCsv ? 'csv' : 'xlsx';
  const filename = `inventory_live_${job.warehouse}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  res.setHeader(
    'Content-Type',
    isCsv ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);

  stream.on('end', () => {
    setTimeout(() => {
      if (fs.existsSync(job.filePath)) {
        fs.unlinkSync(job.filePath);
      }
      liveInventoryJobs.delete(jobId);
    }, 5000);
  });
});

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

const CLEAR_BATCH_SIZE = 50000;
const MAX_BATCHES_PER_REQUEST = 5;

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
