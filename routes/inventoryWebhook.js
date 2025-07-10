// routes/inventoryWebhook.js
const express = require('express');
const router = express.Router();

// Handles the EasyEcom UpdateInventory webhook
router.post('/inventory', (req, res) => {
  // 1) Log all incoming headers to verify what's being sent
  console.log('— HEADERS —', req.headers);

  // 2) Log the parsed JSON body directly
  console.log('— Parsed body —');
  console.dir(req.body, { depth: null });

  // 3) Use the body object for further processing
  const data = req.body;

  // 4) Pretty-print the inventoryData array
  console.log('📥 Inventory update received:', JSON.stringify(data, null, 2));
  console.log('🔑 Access-Token header:', req.get('Access-Token'));

  // 5) Acknowledge so EasyEcom stops retrying
  res.status(200).send('OK');
});

module.exports = router;
