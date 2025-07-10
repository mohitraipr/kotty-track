// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();

// Override global JSON parser: use raw buffer to capture true payload
router.post(
  '/inventory',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    // 1) Inspect all incoming headers
    console.log('— HEADERS —', req.headers);

    // 2) Determine if body is Buffer (when express.json did NOT run)
    let raw;
    if (Buffer.isBuffer(req.body)) {
      raw = req.body.toString('utf8');
    } else {
      // Already parsed to object; reconstruct JSON string for logging
      raw = JSON.stringify(req.body);
    }
    console.log('— RAW BODY —', raw);

    // 3) Parse JSON only when body is still a string
    let data;
    try {
      data = Buffer.isBuffer(req.body) ? JSON.parse(raw) : req.body;
    } catch (err) {
      console.error('❌ JSON.parse failed:', err);
      return res.status(400).send('Invalid JSON');
    }

    // 4) Log structured object
    console.log('📥 Inventory update received:', JSON.stringify(data, null, 2));
    console.log('🔑 Access-Token header:', req.get('Access-Token'));

    // 5) Acknowledge receipt to prevent retries
    res.status(200).send('OK');
  }
);

module.exports = router;
