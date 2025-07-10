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

    // 2) Convert buffer → UTF-8 string and log raw JSON
    const raw = req.body.toString('utf8');
    console.log('— RAW BODY —', raw);

    // 3) Parse JSON manually
    let data;
    try {
      data = JSON.parse(raw);
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
