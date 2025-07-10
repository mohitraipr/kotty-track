// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();
const twilio = require('twilio');

// Twilio credentials (same as used elsewhere)
const TWILIO_ACCOUNT_SID   = "AC255689e642be728f80630c179ad7b70d";
const TWILIO_AUTH_TOKEN    = "86b13a472d5d64404d16ffcc444ef471";
const TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";
const TWILIO_CLIENT = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// In-memory store for recent webhook requests
const logs = [];

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
    logs.push({
      time: new Date().toISOString(),
      headers,
      raw,
      data,
      accessToken: req.get('Access-Token'),
    });
    // keep only last 50
    if (logs.length > 50) logs.shift();

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
router.get('/config', (req, res) => {
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
router.post('/config', (req, res) => {
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
router.get('/logs', (req, res) => {
  res.render('webhookLogs', { logs });
});

module.exports = router;
