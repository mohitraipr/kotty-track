// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();

// 1) For this endpoint only, grab the raw body (all types)
router.post(
  '/inventory',
  express.raw({ type: '*/*' }),
  (req, res) => {
    // 2) Convert the buffer → string and log it
    const raw = req.body.toString('utf8');
    console.log('— RAW PAYLOAD —\n', raw);

    // 3) Try to parse it as JSON
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('❌ Could not JSON.parse incoming payload:', err);
      return res.status(400).send('Bad JSON');
    }

    // 4) Now you’ll see the real object, not just {}
    console.log('📥 Inventory update received:', JSON.stringify(data, null, 2));
    console.log('🔑 Access-Token header:', req.get('Access-Token'));

    // 5) Acknowledge receipt so EasyEcom stops retrying
    res.status(200).send('OK');
  }
);

module.exports = router;
