// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const { isAuthenticated, isOperator, isMohitOperator } = require('../middlewares/auth');

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

// Removed Twilio integration. Alerts are now sent to connected clients via SSE.

// In-memory store for recent webhook requests
const logs = [];
let sseClients = [];

function broadcastLog(log) {
  const data = `data: ${JSON.stringify({ log })}\n\n`;
  sseClients.forEach((client) => client.res.write(data));
}

function broadcastAlert(message) {
  const data = `data: ${JSON.stringify({ alert: { message } })}\n\n`;
  sseClients.forEach((client) => client.res.write(data));
}

// Default alert configuration - can be updated at runtime via /webhook/config
// Map SKU -> threshold
let alertConfig = {
  skuThresholds: {
    KTTWOMENSPANT261S: 30,
  },
};

// Override global JSON parser: use raw buffer to capture true payload
router.post(
  '/inventory',
  verifyAccessToken,
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    // 1) Inspect all incoming headers
    const headers = req.headers;

    // 2) Determine if body is Buffer (when express.json did NOT run)
    let raw;
    if (Buffer.isBuffer(req.body)) {
      raw = req.body.toString('utf8');
    } else {
      // Already parsed to object; reconstruct JSON string for logging
      raw = JSON.stringify(req.body);
    }


    // 3) Parse JSON only when body is still a string
    let data;
    try {
      data = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }

    // Store log entry
    const entry = {
      time: new Date().toISOString(),
      headers,
      raw,
      data,
      accessToken: req.get('Access-Token'),
    };
    logs.push(entry);
    // keep only last 50
    if (logs.length > 50) logs.shift();
    broadcastLog(entry);

    // ================= Custom Logic =================
    try {
      if (Array.isArray(data.inventoryData)) {
        for (const item of data.inventoryData) {
          if (!item || typeof item.sku !== 'string') continue;

          const sku = item.sku.toUpperCase();
          const threshold = alertConfig.skuThresholds[sku];

          if (threshold !== undefined && Number(item.inventory) < threshold) {
            const message = `Inventory alert for ${item.sku}: ${item.inventory}`;
            broadcastAlert(message);
          }
        }
      }
    } catch (err) {
      console.error('Inventory webhook processing failed:', err);
    }

    // Acknowledge receipt to prevent retries
    res.status(200).send('OK');
  }
);

// Render a simple page to update alert configuration
router.get('/config', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  const configText = Object.entries(alertConfig.skuThresholds)
    .map(([sku, th]) => `${sku}:${th}`)
    .join('\n');
  res.render('inventoryAlertConfig', {
    configText,
    error: req.flash('error'),
    success: req.flash('success'),
  });
});

// Update alert configuration
router.post('/config', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  if (typeof req.body.rules === 'string') {
    const map = {};
    req.body.rules
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((line) => {
        const [sku, thresh] = line.split(':');
        if (sku && thresh) {
          const t = parseInt(thresh.trim(), 10);
          if (!isNaN(t)) {
            map[sku.trim().toUpperCase()] = t;
          }
        }
      });
    alertConfig.skuThresholds = map;
  }
  req.flash('success', 'Alert configuration updated');
  res.redirect('/webhook/config');
});

// View webhook logs
router.get('/logs', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  res.render('webhookLogs', { logs });
});

// Stream logs via Server-Sent Events
router.get('/logs/stream', isAuthenticated, isOperator, isMohitOperator, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send existing logs on connect
  res.write(`data: ${JSON.stringify({ logs })}\n\n`);

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

module.exports = router;
