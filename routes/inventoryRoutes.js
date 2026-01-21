const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStoreEmployee } = require('../middlewares/auth');
const ExcelJS = require('exceljs');

// Simple in-memory cache for goods list
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let goodsCache = { data: null, expiry: 0 };
async function getGoodsCached() {
  const now = Date.now();
  if (goodsCache.data && goodsCache.expiry > now) {
    return goodsCache.data;
  }
  const [rows] = await pool.query(
    'SELECT * FROM goods_inventory ORDER BY description_of_goods, size'
  );
  goodsCache = { data: rows, expiry: now + CACHE_TTL_MS };
  return rows;
}

// GET dashboard
router.get('/dashboard', isAuthenticated, isStoreEmployee, async (req, res) => {
  try {
    const [goods, incoming, dispatched] = await Promise.all([
      getGoodsCached(),
      pool
        .query(
          `SELECT i.*, g.description_of_goods, g.size, g.unit
             FROM incoming_data i
             JOIN goods_inventory g ON i.goods_id = g.id
            ORDER BY i.added_at DESC LIMIT 50`
        )
        .then(r => r[0]),
      pool
        .query(
          `SELECT d.*, g.description_of_goods, g.size, g.unit
             FROM dispatched_data d
             JOIN goods_inventory g ON d.goods_id = g.id
            ORDER BY d.dispatched_at DESC LIMIT 50`
        )
        .then(r => r[0])
    ]);
    res.render('inventoryDashboard', { user: req.session.user, goods, incoming, dispatched });
  } catch (err) {
    console.error('Error loading inventory dashboard:', err);
    req.flash('error', 'Could not load inventory dashboard');
    res.redirect('/');
  }
});

// POST add quantity
router.post('/add', isAuthenticated, isStoreEmployee, async (req, res) => {
  const goodsId = req.body.goods_id;
  const qty = parseInt(req.body.quantity, 10);
  if (!goodsId || isNaN(qty) || qty <= 0) {
    req.flash('error', 'Invalid quantity');
    return res.redirect('/inventory/dashboard');
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
    if (conn) { await conn.rollback(); }
    console.error('Error adding quantity:', err);
    req.flash('error', 'Could not add quantity');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/inventory/dashboard');
});

// POST dispatch quantity
router.post('/dispatch', isAuthenticated, isStoreEmployee, async (req, res) => {
  const goodsId = req.body.goods_id;
  const qty = parseInt(req.body.quantity, 10);
  const remark = req.body.remark || null;
  if (!goodsId || isNaN(qty) || qty <= 0) {
    req.flash('error', 'Invalid quantity');
    return res.redirect('/inventory/dashboard');
  }
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Atomically reduce quantity if enough stock is available
    const [updateRes] = await conn.query(
      'UPDATE goods_inventory SET qty = qty - ? WHERE id = ? AND qty >= ?',[qty, goodsId, qty]
    );
    if (!updateRes.affectedRows) {
      req.flash('error', 'Quantity exceeds available');
      await conn.rollback();
      return res.redirect('/inventory/dashboard');
    }

    await conn.query(
      'INSERT INTO dispatched_data (goods_id, quantity, remark, dispatched_by, dispatched_at) VALUES (?, ?, ?, ?, NOW())',
      [goodsId, qty, remark, req.session.user.id]
    );

    await conn.commit();
    req.flash('success', 'Goods dispatched');
  } catch (err) {
    if (conn) { await conn.rollback(); }
    console.error('Error dispatching goods:', err);
    req.flash('error', 'Could not dispatch goods');
  } finally {
    if (conn) conn.release();
  }
  res.redirect('/inventory/dashboard');
});

// Excel download for incoming and inventory history
router.get('/download/incoming', isAuthenticated, isStoreEmployee, async (req, res) => {
  try {
    const [goods, incoming] = await Promise.all([
      getGoodsCached(),
      pool
        .query(
          `SELECT i.*, g.description_of_goods, g.size, g.unit
             FROM incoming_data i
             JOIN goods_inventory g ON i.goods_id = g.id
            ORDER BY i.added_at DESC
            LIMIT 100000`
        )
        .then(r => r[0])
    ]);

    const workbook = new ExcelJS.Workbook();
    const inventorySheet = workbook.addWorksheet('CurrentInventory');
    inventorySheet.columns = [
      { header: 'Description', key: 'desc', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Qty', key: 'qty', width: 10 },
    ];
    inventorySheet.addRows(
      goods.map(g => ({ desc: g.description_of_goods, size: g.size, unit: g.unit, qty: g.qty }))
    );

    const historySheet = workbook.addWorksheet('IncomingHistory');
    historySheet.columns = [
      { header: 'Description', key: 'desc', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Added By', key: 'user', width: 10 },
      { header: 'Datetime', key: 'dt', width: 20 },
      { header: 'Remark', key: 'remark', width: 30 }
    ];
    historySheet.addRows(
      incoming.map(r => ({
        desc: r.description_of_goods,
        size: r.size,
        unit: r.unit,
        quantity: r.quantity,
        user: r.added_by,
        dt: r.added_at,
        remark: r.remark || ''
      }))
    );
    res.setHeader('Content-Disposition', 'attachment; filename="incoming.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading incoming excel:', err);
    req.flash('error', 'Could not download excel');
    res.redirect('/inventory/dashboard');
  }
});

// Excel download for dispatched data
router.get('/download/dispatched', isAuthenticated, isStoreEmployee, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT d.*, g.description_of_goods, g.size, g.unit
                                      FROM dispatched_data d
                                      JOIN goods_inventory g ON d.goods_id = g.id
                                      ORDER BY d.dispatched_at DESC
                                      LIMIT 100000`);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dispatched');
    sheet.columns = [
      { header: 'Description', key: 'desc', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Quantity', key: 'qty', width: 10 },
      { header: 'Remark', key: 'remark', width: 20 },
      { header: 'User', key: 'user', width: 10 },
      { header: 'Datetime', key: 'dt', width: 20 }
    ];
    sheet.addRows(
      rows.map(r => ({
        desc: r.description_of_goods,
        size: r.size,
        unit: r.unit,
        qty: r.quantity,
        remark: r.remark || '',
        user: r.dispatched_by,
        dt: r.dispatched_at
      }))
    );
    res.setHeader('Content-Disposition', 'attachment; filename="dispatched.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error downloading dispatched excel:', err);
    req.flash('error', 'Could not download excel');
    res.redirect('/inventory/dashboard');
  }
});

module.exports = router;
