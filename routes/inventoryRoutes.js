const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isStoreEmployee } = require('../middlewares/auth');
const ExcelJS = require('exceljs');

// GET dashboard
router.get('/dashboard', isAuthenticated, isStoreEmployee, async (req, res) => {
  try {
    const [goods] = await pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, size');
    const [incoming] = await pool.query(`SELECT i.*, g.description_of_goods, g.size, g.unit
                                         FROM incoming_data i
                                         JOIN goods_inventory g ON i.goods_id = g.id
                                         ORDER BY i.added_at DESC LIMIT 50`);
    const [dispatched] = await pool.query(`SELECT d.*, g.description_of_goods, g.size, g.unit
                                            FROM dispatched_data d
                                            JOIN goods_inventory g ON d.goods_id = g.id
                                            ORDER BY d.dispatched_at DESC LIMIT 50`);
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
    const [[row]] = await conn.query('SELECT qty FROM goods_inventory WHERE id = ?', [goodsId]);
    if (!row || row.qty < qty) {
      req.flash('error', 'Quantity exceeds available');
      await conn.rollback();
      return res.redirect('/inventory/dashboard');
    }
    await conn.query('INSERT INTO dispatched_data (goods_id, quantity, remark, dispatched_by, dispatched_at) VALUES (?, ?, ?, ?, NOW())',
      [goodsId, qty, remark, req.session.user.id]);
    await conn.query('UPDATE goods_inventory SET qty = qty - ? WHERE id = ?', [qty, goodsId]);
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
    const [goods] = await pool.query('SELECT * FROM goods_inventory ORDER BY description_of_goods, size');
    const [incoming] = await pool.query(`SELECT i.*, g.description_of_goods, g.size, g.unit
                                         FROM incoming_data i
                                         JOIN goods_inventory g ON i.goods_id = g.id
                                         ORDER BY i.added_at`);
    const workbook = new ExcelJS.Workbook();
    const inventorySheet = workbook.addWorksheet('CurrentInventory');
    inventorySheet.columns = [
      { header: 'Description', key: 'desc', width: 30 },
      { header: 'Size', key: 'size', width: 10 },
      { header: 'Unit', key: 'unit', width: 10 },
      { header: 'Qty', key: 'qty', width: 10 },
    ];
    goods.forEach(g => inventorySheet.addRow({ desc: g.description_of_goods, size: g.size, unit: g.unit, qty: g.qty }));

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
    incoming.forEach(r => historySheet.addRow({
      desc: r.description_of_goods,
      size: r.size,
      unit: r.unit,
      quantity: r.quantity,
      user: r.added_by,
      dt: r.added_at,
      remark: r.remark || ''
    }));
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
                                      ORDER BY d.dispatched_at`);
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
    rows.forEach(r => sheet.addRow({
      desc: r.description_of_goods,
      size: r.size,
      unit: r.unit,
      qty: r.quantity,
      remark: r.remark || '',
      user: r.dispatched_by,
      dt: r.dispatched_at
    }));
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
