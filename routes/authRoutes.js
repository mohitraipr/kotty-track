// routes/authRoutes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { closeSessionLog } = require('../middlewares/sessionActivity');

// GET /login
router.get('/login', (req, res) => {
  res.render('login');
});

// POST /login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    req.flash('error', 'Please enter both username and password.');
    return res.redirect('/login');
  }

  try {
    const [users] = await pool.query(`
      SELECT u.*, r.name AS roleName
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.username = ? AND u.is_active = TRUE
    `, [username]);

    if (users.length === 0) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    // Set user session
    req.session.user = {
      id: user.id,
      username: user.username,
      roleName: user.roleName,
      role: user.roleName
    };

    // Create a session log for usage tracking
    try {
      const [sessionLogResult] = await pool.query(
        `
          INSERT INTO user_session_logs
            (user_id, username, session_id, login_time, last_activity_time)
          VALUES (?, ?, ?, NOW(), NOW())
        `,
        [user.id, user.username, req.sessionID]
      );
      req.session.sessionLogId = sessionLogResult.insertId;
      req.session.lastActivityUpdate = Date.now();
    } catch (logErr) {
      console.error('Error creating session log:', logErr);
    }

    // Redirect based on role
    switch (user.roleName) {
      case 'admin':
        res.redirect('/admin');
        break;
      case 'cutting_manager':
        res.redirect('/cutting-manager/dashboard');
        break;
      case 'fabric_manager':
        res.redirect('/fabric-manager/dashboard');
        break;
      case 'stitching_master':
        res.redirect('/stitchingdashboard');
        break;
      case 'operator':
        res.redirect('/operator/dashboard');
        break;
      case 'inventory_operator':
        res.redirect('/easyecom/stock-market');
        break;
      case 'outofstock':
        res.redirect('/easyecom/stock-market');
        break;
      case 'supervisor':
        res.redirect('/supervisor/employees');
        break;
      case 'finishing':
        res.redirect('/finishingdashboard');
        break;
      case 'washing':
          res.redirect('/washingdashboard');
          break;
        case 'catalogUpload':
            res.redirect('/catalogupload');
            break;
      case 'jeans_assembly':
          res.redirect('/jeansassemblydashboard');
          break;
      case 'washing_in':            // New case for washing in
        res.redirect('/washingin');
        break;
      case 'store_admin':
        res.redirect('/store-admin/dashboard');
        break;
      case 'store_employee':
        res.redirect('/inventory/dashboard');
        break;
      case 'indent_filler':
        res.redirect('/indent');
        break;
      case 'store_manager':
        res.redirect('/indent/manage');
        break;
      case 'accounts':
        res.redirect('/purchase');
        break;
      case 'po_creator':
        res.redirect('/po-creator/dashboard');
        break;
      case 'nowipoorganization':
        res.redirect('/nowi-po/dashboard');
        break;
      case 'vendorfiles':
        res.redirect('/vendor-files');
        break;
      case 'checking':
      case 'quality_assurance':
        res.redirect('/department/dashboard');
        break;
      default:
        res.redirect('/');
    }
  } catch (err) {
    console.error('Error during login:', err);
    req.flash('error', 'An error occurred during login.');
    res.redirect('/login');
  }
});

// GET /logout
router.get('/logout', async (req, res) => {
  const sessionLogId = req.session?.sessionLogId;

  if (sessionLogId) {
    await closeSessionLog(sessionLogId);
  }

  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session during logout:', err);
    }
    res.redirect('/login');
  });
});

module.exports = router;
