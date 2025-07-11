const express = require('express');
const router = express.Router();
const { isAuthenticated, isOperator } = require('../middlewares/auth');

router.get('/sku/:sku', isAuthenticated, isOperator, (req, res) => {
  const sku = req.params.sku;
  res.render('skuDetail', { sku });
});

module.exports = router;
