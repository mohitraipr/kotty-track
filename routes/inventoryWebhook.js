const express = require('express');
const router = express.Router();

// This endpoint will catch EasyEcom's inventory updates
router.post('/inventory', (req, res) => {
  // 1) Log the whole payload so you can see it in your console:
  console.log('📥 Inventory update received:', JSON.stringify(req.body, null, 2));

  // 2) (Optional) Check the Access-Token header that EasyEcom sends you:
  const token = req.header('Access-Token');
  console.log('🔑 Access-Token:', token);

  // 3) Tell EasyEcom “All good!” so it won’t retry.
  res.status(200).send('OK');
});

module.exports = router;
