// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();

// In-memory store for recent webhook requests
const logs = [];

// Override global JSON parser: use raw buffer to capture true payload
router.post(
  '/inventory',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
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

    // Acknowledge receipt to prevent retries
    res.status(200).send('OK');
  }
);

// View webhook logs
router.get('/logs', (req, res) => {
  res.render('webhookLogs', { logs });
});

module.exports = router;
