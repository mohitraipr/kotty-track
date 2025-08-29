const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// Show washing item rates configuration
router.get('/rates', isAuthenticated, isOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT description, rate FROM washing_item_rates ORDER BY description'
    );
    res.render('washingRateConfig', {
      items: rows,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('fetch washing rates', err);
    req.flash('error', 'Failed to load rates');
    res.redirect('/operator');
  }
});

// Create or update an item rate
router.post('/rates/update', isAuthenticated, isOperator, async (req, res) => {
  const { description = '', rate = 0 } = req.body;
  if (!description.trim()) {
    return res.redirect('/washingdashboard/payments/rates');
  }
  try {
    await pool.query(
      'INSERT INTO washing_item_rates (description, rate) VALUES (?, ?) ON DUPLICATE KEY UPDATE rate = VALUES(rate)',
      [description.trim(), parseFloat(rate) || 0]
    );
    req.flash('success', 'Rate saved');
  } catch (err) {
    console.error('save washing rate', err);
    req.flash('error', 'Failed to save rate');
  }
  res.redirect('/washingdashboard/payments/rates');
});

module.exports = router;
