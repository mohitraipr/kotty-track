// routes/authRoutes.js

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { closeSessionLog } = require('../middlewares/sessionActivity');

// Resolves all roles a user has (via user_roles table). Returns array of
// role names. Always includes the primary role (back-compat for accounts
// whose user_roles row hasn't been backfilled yet).
async function loadAvailableRoles(userId, primaryRoleName) {
  try {
    const [rows] = await pool.query(
      `SELECT r.name FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = ?`,
      [userId]
    );
    const names = rows.map(r => r.name).filter(Boolean);
    if (primaryRoleName && !names.includes(primaryRoleName)) names.unshift(primaryRoleName);
    return names.length ? names : (primaryRoleName ? [primaryRoleName] : []);
  } catch (_err) {
    // table missing (migration not run yet) — fall back to single role
    return primaryRoleName ? [primaryRoleName] : [];
  }
}

// Where to send a freshly-authenticated user. If they have >1 role,
// the launcher lets them pick which "hat" to wear; otherwise straight
// to their single dashboard (today's behaviour preserved).
function postLoginRedirect(user) {
  if (Array.isArray(user.availableRoles) && user.availableRoles.length > 1) {
    return '/launcher';
  }
  return getDashboardForRole(user.roleName);
}

// GET /login
router.get('/login', (req, res) => {
  // If user is already logged in, redirect to their dashboard / launcher
  if (req.session && req.session.user) {
    return res.redirect(postLoginRedirect(req.session.user));
  }
  res.render('login');
});

// Helper function to get dashboard URL for a role
function getDashboardForRole(roleName) {
  const dashboards = {
    'admin': '/admin',
    'cutting_manager': '/cutting-manager/dashboard',
    'fabric_manager': '/fabric-manager/dashboard',
    'stitching_master': '/stitchingdashboard',
    'operator': '/operator/dashboard',
    'inventory_operator': '/easyecom/stock-market',
    'outofstock': '/easyecom/stock-market',
    'supervisor': '/supervisor/employees',
    'finishing': '/finishingdashboard',
    'washing': '/washingdashboard',
    'washing_master': '/washingdashboard',
    'catalogUpload': '/catalogupload',
    'jeans_assembly': '/jeansassemblydashboard',
    'washing_in': '/washingin',
    'washing_in_master': '/washingin',
    'store_admin': '/store-admin/dashboard',
    'store_employee': '/inventory/dashboard',
    'indent_filler': '/indent',
    'store_manager': '/indent/manage',
    'accounts': '/accounts-challan',
    'po_creator': '/po-creator/dashboard',
    'nowipoorganization': '/nowi-po/dashboard',
    'vendorfiles': '/vendor-files',
    'poadmin': '/po-admin/dashboard',
    'poadmins': '/po-admin/dashboard',
    'checking': '/department/dashboard',
    'quality_assurance': '/department/dashboard',
    'challan_dashboard': '/challandashboard',
    'productviewer': '/product-links',
    'wishlinkops': '/inventory-ops/logs',
    'videofinder': '/video-finder',
    'videocreator': '/vms',
    'vmsoperator': '/vms-operator',
    'return_grn': '/return-grn/scan',
    'returns_operator': '/return-grn/dashboard',
    'returnchallan': '/return-challan',
    'production_manager': '/pm',
  };

  // If role not found, log it for debugging and return a safe default
  if (!dashboards[roleName]) {
    console.warn(`Unknown role "${roleName}" - redirecting to /operator/dashboard as fallback`);
    return '/operator/dashboard';
  }

  return dashboards[roleName];
}

// Helper to log security events
async function logSecurityEvent(eventType, username, ip, userAgent, details = {}) {
  try {
    await pool.query(`
      INSERT INTO security_audit_log (event_type, username, ip_address, user_agent, details, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())
    `, [eventType, username || 'unknown', ip, userAgent, JSON.stringify(details)]);
  } catch (err) {
    console.error('Security log error:', err.message);
  }
}

// POST /login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const clientIP = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const userAgent = req.headers['user-agent'] || 'unknown';

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
      // Log failed attempt - user not found
      await logSecurityEvent('LOGIN_FAILED', username, clientIP, userAgent, { reason: 'user_not_found' });
      console.warn(`[SECURITY] Failed login - user not found: ${username} from IP: ${clientIP}`);
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      // Log failed attempt - wrong password
      await logSecurityEvent('LOGIN_FAILED', username, clientIP, userAgent, { reason: 'invalid_password', user_id: user.id });
      console.warn(`[SECURITY] Failed login - wrong password: ${username} from IP: ${clientIP}`);
      req.flash('error', 'Invalid username or password.');
      return res.redirect('/login');
    }

    // Log successful login
    await logSecurityEvent('LOGIN_SUCCESS', username, clientIP, userAgent, { user_id: user.id, role: user.roleName });

    // Load every role this user has access to (via user_roles M2M).
    // If a user has >1 role, the post-login redirect sends them to the
    // launcher instead of a fixed dashboard.
    const availableRoles = await loadAvailableRoles(user.id, user.roleName);

    // Set user session. `roleName` is the ACTIVE role (mutable across
    // /switch-role calls); `primaryRoleName` is the default (= users.role_id).
    req.session.user = {
      id: user.id,
      username: user.username,
      roleName: user.roleName,
      role: user.roleName,
      primaryRoleName: user.roleName,
      availableRoles,
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

    // Redirect: launcher if >1 role, else single dashboard
    res.redirect(postLoginRedirect(req.session.user));
  } catch (err) {
    console.error('Error during login:', err);
    req.flash('error', 'An error occurred during login.');
    res.redirect('/login');
  }
});

// GET /dashboard - Generic dashboard redirect for any logged-in user
router.get('/dashboard', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  res.redirect(postLoginRedirect(req.session.user));
});

// GET /logout
router.get('/logout', async (req, res) => {
  const sessionLogId = req.session?.sessionLogId;
  if (sessionLogId) {
    await closeSessionLog(sessionLogId, req.session?.lastActivityUpdate);
  }

  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session during logout:', err);
    }
    res.redirect('/login');
  });
});

router.post('/logout', async (req, res) => {
  const sessionLogId = req.session?.sessionLogId;
  if (sessionLogId) {
    await closeSessionLog(sessionLogId, req.session?.lastActivityUpdate);
  }

  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session during logout:', err);
    }
    res.redirect('/login');
  });
});

// Exported so launcherRoutes can reuse the same role→URL map without
// duplicating it.
router.getDashboardForRole = getDashboardForRole;

module.exports = router;
