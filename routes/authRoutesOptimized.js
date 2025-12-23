// Optimized authRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

// simple in-memory cache for users
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function setUserCache(username, user) {
  userCache.set(username, { user, expires: Date.now() + CACHE_TTL });
}

function getUserCache(username) {
  const cached = userCache.get(username);
  if (!cached) return null;
  if (cached.expires < Date.now()) {
    userCache.delete(username);
    return null;
  }
  return cached.user;
}

router.get('/login', (req, res) => {
  res.render('login');
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    req.flash('error', 'Please enter both username and password.');
    return res.redirect('/login');
  }

  try {
    let user = getUserCache(username);
    if (!user) {
      const [rows] = await pool.query(
        `SELECT u.id, u.username, u.password, r.name AS roleName
         FROM users u
         JOIN roles r ON u.role_id = r.id
         WHERE u.username = ? AND u.is_active = TRUE
         LIMIT 1`,
        [username]
      );
      if (rows.length === 0) {
        req.flash('error', 'Invalid username or password.');
        return res.redirect('/login');
      }
      user = rows[0];
      setUserCache(username, user);
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      roleName: user.roleName,
    };

    const roleRedirectMap = {
      admin: '/admin',
      cutting_manager: '/cutting-manager/dashboard',
      fabric_manager: '/fabric-manager/dashboard',
      stitching_master: '/stitchingdashboard',
      operator: '/operator/dashboard',
      inventory_operator: '/easyecom/stock-market',
      supervisor: '/supervisor/employees',
      finishing: '/finishingdashboard',
      washing: '/washingdashboard',
      catalogUpload: '/catalogupload',
      jeans_assembly: '/jeansassemblydashboard',
      washing_in: '/washingin',
      store_admin: '/store-admin/dashboard',
      store_employee: '/inventory/dashboard',
      checking: '/department/dashboard',
      quality_assurance: '/department/dashboard',
      nowipoorganization: '/nowi-po/dashboard',
    };

    const redirectPath = roleRedirectMap[user.roleName] || '/';
    res.redirect(redirectPath);
  } catch (err) {
    console.error('Error during login:', err);
    req.flash('error', 'An error occurred during login.');
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session during logout:', err);
    }
    res.redirect('/login');
  });
});

module.exports = router;
