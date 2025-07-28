// routes/inventoryWebhook.js
const express = require('express');
const webPush = require('web-push');
const router = express.Router();
const { pool } = require('../config/db');
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
// Store push subscriptions in a Map keyed by endpoint for O(1) updates
let pushSubscriptions = new Map();
// Aggregate inventory alerts before sending push notifications
const pendingPushAlerts = [];
const PUSH_AGGREGATE_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 hours

async function loadPushSubscriptions() {
  try {
    const [rows] = await pool.query(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions'
    );
    pushSubscriptions = new Map(
      rows.map((r) => [
        r.endpoint,
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
      ])
    );
  } catch (err) {
    console.error('Failed to load push subscriptions', err);
  }
}

// Configure web-push using VAPID keys from env
if (global.env.VAPID_PUBLIC_KEY && global.env.VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(
      'mailto:admin@example.com',
      global.env.VAPID_PUBLIC_KEY,
      global.env.VAPID_PRIVATE_KEY
    );
  } catch (err) {
    console.error('Invalid VAPID keys', err);
  }
}

function broadcastLog(log) {
  const data = `data: ${JSON.stringify({ log })}\n\n`;
  sseClients.forEach((client) => client.res.write(data));
}

async function sendPendingPushNotifications() {
  if (!pendingPushAlerts.length) return;
  const unique = [...new Set(pendingPushAlerts.map((a) => a.sku))];
  const message =
    unique.length === 1
      ? `Low inventory for ${unique[0]}`
      : `Low inventory for ${unique.length} SKUs`;
  const pushData = JSON.stringify({ message, url: `/inventory/alerts` });
  const subs = Array.from(pushSubscriptions.values());
  const results = await Promise.allSettled(
    subs.map((sub) => webPush.sendNotification(sub, pushData))
  );
  const staleEndpoints = [];
  results.forEach((result, idx) => {
    if (result.status === 'rejected') {
      const err = result.reason;
      console.error('Push send failed', err);
      const sub = subs[idx];
      if (err.statusCode === 410 || err.statusCode === 404) {
        pushSubscriptions.delete(sub.endpoint);
        staleEndpoints.push(sub.endpoint);
      }
    }
  });
  if (staleEndpoints.length) {
    try {
      const placeholders = staleEndpoints.map(() => '?').join(',');
      await pool.query(
        `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`,
        staleEndpoints
      );
    } catch (dbErr) {
      console.error('Failed to delete push subscriptions', dbErr);
    }
  }
  pendingPushAlerts.length = 0;
}

setInterval(sendPendingPushNotifications, PUSH_AGGREGATE_INTERVAL_MS);

async function broadcastAlert(message, sku, quantity) {
  const payload = { alert: { message, sku, quantity } };
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach((client) => client.res.write(data));

  // Queue push notifications instead of sending immediately
  pendingPushAlerts.push({ sku, quantity });

  // Persist the alert
  try {
    await pool.query(
      'INSERT INTO inventory_alerts (sku, quantity, created_at) VALUES (?, ?, NOW())',
      [sku, quantity]
    );
  } catch (err) {
    console.error('Failed to insert alert', err);
  }
}

// Default alert configuration - will be replaced with DB values on startup
// Map SKU -> threshold
let alertConfig = {
  skuThresholds: {
    KTTWOMENSPANT261S: 30,
  },
};

async function loadSkuThresholds() {
  try {
    const [rows] = await pool.query('SELECT sku, threshold FROM sku_thresholds');
    const map = {};
    for (const r of rows) {
      map[r.sku.toUpperCase()] = r.threshold;
    }
    alertConfig.skuThresholds = map;
  } catch (err) {
    console.error('Failed to load SKU thresholds', err);
  }
}

// Load configuration from DB on startup
loadSkuThresholds();
loadPushSubscriptions();

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
          const qty = Number(item.inventory);

          if (threshold !== undefined && qty < threshold) {
            const message = `Inventory alert for ${item.sku}: ${qty}`;
            broadcastAlert(message, item.sku, qty).catch((e) =>
              console.error('Broadcast alert failed', e)
            );
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
router.get('/config', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
  await loadSkuThresholds();
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
router.post('/config', isAuthenticated, isOperator, isMohitOperator, async (req, res) => {
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

    try {
      const entries = Object.entries(map);
      if (entries.length) {
        const values = entries.map(() => '(?, ?)').join(',');
        const params = entries.flatMap(([sku, th]) => [sku, th]);
        await pool.query(
          `INSERT INTO sku_thresholds (sku, threshold) VALUES ${values} ON DUPLICATE KEY UPDATE threshold = VALUES(threshold)`,
          params
        );
      }
    } catch (err) {
      console.error('Failed to update SKU thresholds', err);
      req.flash('error', 'Failed to save configuration');
    }

    await loadSkuThresholds();
  }

  req.flash('success', 'Alert configuration updated');
  res.redirect('/webhook/config');
});

// Store push subscription from client
router.post('/subscribe', isAuthenticated, isOperator, async (req, res) => {
  if (req.body && req.body.endpoint) {
    const sub = req.body;
    // Avoid duplicates
    pushSubscriptions.set(sub.endpoint, sub);

    // Persist to database
    try {
      const userId = req.session.user ? req.session.user.id : null;
      const { endpoint, keys = {} } = sub;
      const p256dh = keys.p256dh || '';
      const auth = keys.auth || '';
      await pool.query(
        'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)',
        [userId, endpoint, p256dh, auth]
      );
    } catch (err) {
      console.error('Failed to store push subscription', err);
    }

    res.status(201).json({ ok: true });
  } else {
    res.status(400).json({ error: 'Invalid subscription' });
  }
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
