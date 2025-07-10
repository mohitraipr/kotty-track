// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const twilio = require('twilio');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// Twilio credentials (same as used elsewhere)
// Load Twilio credentials from encrypted environment variables
const TWILIO_ACCOUNT_SID   = global.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = global.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = global.env.TWILIO_WHATSAPP_FROM;

let TWILIO_CLIENT = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  TWILIO_CLIENT = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('Twilio credentials missing; webhook alerts disabled.');
}

// In-memory store for recent webhook requests
const logs = [];
let sseClients = [];

function broadcastLog(log) {
  const data = `data: ${JSON.stringify({ log })}\n\n`;
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
  isAuthenticated,
  isOperator,
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
        const numbers = ['+917979026089', '+918920374028'];
        for (const item of data.inventoryData) {
          if (!item || typeof item.sku !== 'string') continue;

          const sku = item.sku.toUpperCase();
          const threshold = alertConfig.skuThresholds[sku];

          if (threshold !== undefined && Number(item.inventory) < threshold) {
            const body = `Inventory alert for ${item.sku}: ${item.inventory}`;
            for (const phone of numbers) {
              if (!TWILIO_CLIENT) {
                console.warn('Twilio client not configured; alert not sent');
                continue;
              }
              try {
                await TWILIO_CLIENT.messages.create({
                  from: TWILIO_WHATSAPP_FROM,
                  to: 'whatsapp:' + phone,
                  body,
                });
              } catch (err) {
                console.error('Twilio send failed:', err.message);
              }
            }
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
router.get('/config', isAuthenticated, isOperator, (req, res) => {
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
router.post('/config', isAuthenticated, isOperator, (req, res) => {
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
router.get('/logs', isAuthenticated, isOperator, (req, res) => {
  res.render('webhookLogs', { logs });
});

// Stream logs via Server-Sent Events
router.get('/logs/stream', isAuthenticated, isOperator, (req, res) => {
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
