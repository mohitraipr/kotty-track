const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStoreAdmin } = require('../middlewares/auth');

// GET dashboard for store admin
router.get('/dashboard', isAuthenticated, isStoreAdmin, async (req, res) => {
  try {
    const [goods] = await pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, size');
    const [dispatched] = await pool.query(`SELECT d.*, g.description_of_goods, g.size, g.unit
                                            FROM dispatched_data d
                                            JOIN goods_inventory g ON d.goods_id = g.id
                                            ORDER BY d.dispatched_at DESC LIMIT 50`);
    res.render('storeAdminDashboard', { user: req.session.user, goods, dispatched });
  } catch (err) {
    console.error('Error loading store admin dashboard:', err);
    req.flash('error', 'Could not load dashboard');
    res.redirect('/');
  }
});

// POST create new goods item
router.post('/create', isAuthenticated, isStoreAdmin, async (req, res) => {
  const { description, size, unit } = req.body;
  if (!description || !size || !unit) {
    req.flash('error', 'All fields are required');
    return res.redirect('/store-admin/dashboard');
  }
  try {
    await pool.query('INSERT INTO goods_inventory (description_of_goods, size, unit) VALUES (?, ?, ?)',
      [description, size, unit]);
    req.flash('success', 'Item created');
    res.redirect('/store-admin/dashboard');
  } catch (err) {
    console.error('Error creating item:', err);
    req.flash('error', 'Could not create item');
    res.redirect('/store-admin/dashboard');
  }
});

module.exports = router;
