const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAccountsAdmin, isPurchaseOrAccounts } = require('../middlewares/auth');

// GET /purchase - render dashboard for purchaseGRN and accounts roles
router.get('/', isAuthenticated, isPurchaseOrAccounts, async (req, res) => {
  try {
    const [parties] = await pool.query(
      'SELECT id, name, gst_number, state, pincode, due_payment_days FROM parties ORDER BY name'
    );
    const [factories] = await pool.query(
      'SELECT id, name, gst_number, state FROM factories ORDER BY name'
    );
    res.render('purchaseDashboard', {
      user: req.session.user,
      parties,
      factories
    });
  } catch (err) {
    console.error('Error loading purchase dashboard:', err);
    req.flash('error', 'Failed to load purchase dashboard');
    res.redirect('/');
  }
});

// POST /purchase/parties - create a new party
router.post('/parties', isAuthenticated, isAccountsAdmin, async (req, res) => {
  const { name, gst_number, state, pincode, due_payment_days } = req.body;
  if (!name) {
    req.flash('error', 'Party name is required');
    return res.redirect('/purchase');
  }
  try {
    await pool.query(
      `INSERT INTO parties (name, gst_number, state, pincode, due_payment_days)
       VALUES (?, ?, ?, ?, ?)`,
      [name, gst_number, state, pincode, due_payment_days || 0]
    );
    req.flash('success', 'Party created');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error creating party:', err);
    req.flash('error', 'Failed to create party');
    res.redirect('/purchase');
  }
});

// POST /purchase/parties/:id - update an existing party
router.post('/parties/:id', isAuthenticated, isAccountsAdmin, async (req, res) => {
  const id = req.params.id;
  const { name, gst_number, state, pincode, due_payment_days } = req.body;
  try {
    await pool.query(
      `UPDATE parties
       SET name = ?, gst_number = ?, state = ?, pincode = ?, due_payment_days = ?
       WHERE id = ?`,
      [name, gst_number, state, pincode, due_payment_days || 0, id]
    );
    req.flash('success', 'Party updated');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error updating party:', err);
    req.flash('error', 'Failed to update party');
    res.redirect('/purchase');
  }
});

// POST /purchase/factories - create a new factory
router.post('/factories', isAuthenticated, isAccountsAdmin, async (req, res) => {
  const { name, gst_number, state } = req.body;
  if (!name) {
    req.flash('error', 'Factory name is required');
    return res.redirect('/purchase');
  }
  try {
    await pool.query(
      `INSERT INTO factories (name, gst_number, state) VALUES (?, ?, ?)`,
      [name, gst_number, state]
    );
    req.flash('success', 'Factory created');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error creating factory:', err);
    req.flash('error', 'Failed to create factory');
    res.redirect('/purchase');
  }
});

// POST /purchase/factories/:id - update factory
router.post('/factories/:id', isAuthenticated, isAccountsAdmin, async (req, res) => {
  const id = req.params.id;
  const { name, gst_number, state } = req.body;
  try {
    await pool.query(
      `UPDATE factories SET name = ?, gst_number = ?, state = ? WHERE id = ?`,
      [name, gst_number, state, id]
    );
    req.flash('success', 'Factory updated');
    res.redirect('/purchase');
  } catch (err) {
    console.error('Error updating factory:', err);
    req.flash('error', 'Failed to update factory');
    res.redirect('/purchase');
  }
});

module.exports = router;
