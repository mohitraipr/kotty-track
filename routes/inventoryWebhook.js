// routes/inventoryWebhook.js
const express = require('express');
const rawParser = require('body-parser').raw;
const router = express.Router();

// This will capture the raw body (all content types) for /inventory
router.post(
  '/inventory',
  rawParser({ type: '*/*', limit: '1mb' }),
  (req, res) => {
    // 1) Log headers to inspect Content-Type, etc.
    console.log('— HEADERS —', req.headers);

    // 2) Convert raw buffer to string
    const raw = req.body.toString('utf8');
    console.log('— RAW BODY —', raw);

    // 3) Parse JSON manually
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('❌ JSON parse error:', err);
      return res.status(400).send('Invalid JSON');
    }

    // 4) Log the parsed object properly
    console.log('📥 Inventory update received:', JSON.stringify(data, null, 2));
    console.log('🔑 Access-Token:', req.get('Access-Token'));

    // 5) Acknowledge receipt
    res.status(200).send('OK');
  }
);

module.exports = router;
