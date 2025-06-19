const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStoreAdmin } = require('../middlewares/auth');

// Dashboard for store admin
router.get('/dashboard', isAuthenticated, isStoreAdmin, async (req, res) => {
  try {
    const [goods] = await pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, size');
    const [dispatched] = await pool.query(`SELECT d.*, g.description_of_goods, g.size, g.unit
                                            FROM dispatched_data d
                                            JOIN goods_inventory g ON d.goods_id = g.id
                                            ORDER BY d.dispatched_at DESC LIMIT 200`);
    res.render('storeAdminDashboard', { user: req.session.user, goods, dispatched });
  } catch (err) {
    console.error('Error loading store admin dashboard:', err);
    req.flash('error', 'Could not load dashboard');
    res.redirect('/');
  }
});

// Create new goods item
router.post('/create-item', isAuthenticated, isStoreAdmin, async (req, res) => {
  const { description, size, unit } = req.body;
  if (!description || !size || !unit) {
    req.flash('error', 'All fields are required');
    return res.redirect('/store-admin/dashboard');
  }
  try {
    await pool.query('INSERT INTO goods_inventory (description_of_goods, size, unit, qty) VALUES (?, ?, ?, 0)', [description, size, unit]);
    req.flash('success', 'Item created');
    res.redirect('/store-admin/dashboard');
  } catch (err) {
    console.error('Error creating item:', err);
    req.flash('error', 'Could not create item');
    res.redirect('/store-admin/dashboard');
  }
});

// Add quantity
router.post('/add', isAuthenticated, isStoreAdmin, async (req, res) => {
  const goodsId = req.body.goods_id;
  const qty = parseInt(req.body.quantity, 10);
  if (!goodsId || isNaN(qty) || qty <= 0) {
    req.flash('error', 'Invalid quantity');
    return res.redirect('/store-admin/dashboard');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('INSERT INTO incoming_data (goods_id, quantity, added_by, added_at) VALUES (?, ?, ?, NOW())',
      [goodsId, qty, req.session.user.id]);
    await conn.query('UPDATE goods_inventory SET qty = qty + ? WHERE id = ?', [qty, goodsId]);
    await conn.commit();
    req.flash('success', 'Quantity added');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error adding quantity:', err);
    req.flash('error', 'Could not add quantity');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/store-admin/dashboard');
});

// Dispatch goods
router.post('/dispatch', isAuthenticated, isStoreAdmin, async (req, res) => {
  const goodsId = req.body.goods_id;
  const qty = parseInt(req.body.quantity, 10);
  const remark = req.body.remark || null;
  if (!goodsId || isNaN(qty) || qty <= 0) {
    req.flash('error', 'Invalid quantity');
    return res.redirect('/store-admin/dashboard');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [[row]] = await conn.query('SELECT qty FROM goods_inventory WHERE id = ?', [goodsId]);
    if (!row || row.qty < qty) {
      req.flash('error', 'Quantity exceeds available');
      await conn.rollback();
      return res.redirect('/store-admin/dashboard');
    }
    await conn.query('INSERT INTO dispatched_data (goods_id, quantity, remark, dispatched_by, dispatched_at) VALUES (?, ?, ?, ?, NOW())',
      [goodsId, qty, remark, req.session.user.id]);
    await conn.query('UPDATE goods_inventory SET qty = qty - ? WHERE id = ?', [qty, goodsId]);
    await conn.commit();
    req.flash('success', 'Goods dispatched');
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('Error dispatching goods:', err);
    req.flash('error', 'Could not dispatch goods');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/store-admin/dashboard');
});

module.exports = router;
