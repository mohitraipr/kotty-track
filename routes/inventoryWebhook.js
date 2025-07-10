// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();

router.post('/inventory', (req, res) => {
  let data;

  // 1) If Express gave us a Buffer (raw middleware), turn to string + parse
  if (Buffer.isBuffer(req.body)) {
    const raw = req.body.toString('utf8');
    console.log('— RAW PAYLOAD (buffer) —\n', raw);

    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('❌ Invalid JSON in raw buffer:', err);
      return res.status(400).send('Bad JSON');
    }

  // 2) If it’s already an object (express.json ran), just use it
  } else if (typeof req.body === 'object') {
    console.log('— PAYLOAD (already parsed) —\n', JSON.stringify(req.body, null, 2));
    data = req.body;

  // 3) Otherwise, treat it as a string
  } else {
    console.log('— RAW PAYLOAD (string) —\n', req.body);
    try {
      data = JSON.parse(req.body);
    } catch (err) {
      console.error('❌ Invalid JSON in string body:', err);
      return res.status(400).send('Bad JSON');
    }
  }

  // 4) Now `data` is your real object
  console.log('📥 Inventory update received:', JSON.stringify(data, null, 2));
  console.log('🔑 Access-Token header:', req.get('Access-Token'));

  // 5) Acknowledge so EasyEcom won’t retry
  res.status(200).send('OK');
});

module.exports = router;
