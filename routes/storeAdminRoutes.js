const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStoreAdmin } = require('../middlewares/auth');

// Simple in-memory cache for goods list
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let goodsCache = { data: null, expiry: 0 };

async function getGoodsCached() {
  const now = Date.now();
  if (goodsCache.data && goodsCache.expiry > now) {
    return goodsCache.data;
  }
  const [rows] = await pool.query(
    'SELECT * FROM goods_inventory ORDER BY description_of_goods, shade, size'
  );
  goodsCache = { data: rows, expiry: now + CACHE_TTL_MS };
  return rows;
}

// GET dashboard for store admin
router.get('/dashboard', isAuthenticated, isStoreAdmin, async (req, res) => {
  try {
    const [goods, dispatched] = await Promise.all([
      getGoodsCached(),
      pool
        .query(`SELECT d.*, g.description_of_goods, g.size, g.unit
                   FROM dispatched_data d
              LEFT JOIN goods_inventory g ON d.goods_id = g.id
                  ORDER BY d.dispatched_at DESC LIMIT 50`)
        .then(r => r[0])
    ]);
    res.render('storeAdminDashboard', { user: req.session.user, goods, dispatched });
  } catch (err) {
    console.error('Error loading store admin dashboard:', err);
    req.flash('error', 'Could not load dashboard');
    res.redirect('/');
  }
});

// POST create new goods item
router.post('/create', isAuthenticated, isStoreAdmin, async (req, res) => {
  const { description, size, unit, shade } = req.body;
  if (!description || !unit) {
    req.flash('error', 'Name and Unit are required');
    return res.redirect('/store-admin/dashboard');
  }
  try {
    await pool.query(
      'INSERT INTO goods_inventory (description_of_goods, size, unit, shade, qty) VALUES (?, ?, ?, ?, 0)',
      [description, size || null, unit, shade || null]
    );
    goodsCache = { data: null, expiry: 0 };
    req.flash('success', 'Item created');
    res.redirect('/store-admin/dashboard');
  } catch (err) {
    console.error('Error creating item:', err);
    req.flash('error', 'Could not create item');
    res.redirect('/store-admin/dashboard');
  }
});

module.exports = router;
