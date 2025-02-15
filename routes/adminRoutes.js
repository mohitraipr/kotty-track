const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAdmin } = require('../middlewares/auth');
const { body, validationResult } = require('express-validator');

// Utility: Fetch existing tables (if needed)
async function fetchExistingTables() {
  const sql = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = DATABASE() 
      AND table_name NOT IN ('roles','users','dashboards', 'audit_logs') 
      AND table_name NOT LIKE 'mysql%' 
      AND table_name NOT LIKE 'performance_schema%' 
      AND table_name NOT LIKE 'information_schema%'
  `;
  const [rows] = await pool.query(sql);
  return rows.map(r => r.table_name);
}

// GET /admin – Render admin page
router.get('/', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // 1) Fetch Roles
    const [roles] = await pool.query('SELECT * FROM roles');

    // 2) Fetch Users with role names
    const [users] = await pool.query(`
      SELECT u.*, r.name AS role_name 
      FROM users u 
      LEFT JOIN roles r ON u.role_id = r.id 
      ORDER BY r.name, u.username
    `);

    // 3) Fetch Dashboards
    const [dashboards] = await pool.query(`
      SELECT d.*, r.id AS role_id, r.name AS role_name 
      FROM dashboards d 
      LEFT JOIN roles r ON d.role_id = r.id 
      ORDER BY d.name
    `);

    // (Optional) Existing tables and audit logs:
    const existingTables = await fetchExistingTables();
    const [auditLogs] = await pool.query(`
      SELECT al.id, u.username, al.action, al.details, al.performed_at 
      FROM audit_logs al 
      JOIN users u ON al.user_id = u.id 
      ORDER BY al.performed_at DESC 
      LIMIT 100
    `);

    res.render('admin', { 
      user: req.session.user, 
      roles, 
      users, 
      dashboards, 
      existingTables, 
      auditLogs 
    });
  } catch (err) {
    console.error('Error loading admin page:', err);
    req.flash('error', 'Error loading admin page.');
    return res.redirect('/');
  }
});

// POST /admin/create-dashboard – Create new dashboard/table
router.post(
  '/create-dashboard',
  isAuthenticated,
  isAdmin,
  [
    body('dashboardName').trim().notEmpty().withMessage('Dashboard name is required.'),
    body('tableName')
      .trim()
      .matches(/^[A-Za-z0-9_]+$/)
      .withMessage('Table name can only contain letters, numbers, and underscores.'),
    body('roleId').isInt().withMessage('Valid role is required.'),
    body('columns').notEmpty().withMessage('Columns JSON is required.')
  ],
  async (req, res) => {
    const { dashboardName, tableName, roleId, columns } = req.body;
    let { canUpdate } = req.body;
    canUpdate = canUpdate === 'on' || canUpdate === 'true';

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }

    let parsed;
    try {
      parsed = JSON.parse(columns);
    } catch (err) {
      console.error('Error parsing columns JSON:', err);
      req.flash('error', 'Invalid columns JSON.');
      return res.redirect('/admin');
    }
    if (!Array.isArray(parsed)) {
      req.flash('error', 'Columns must be an array.');
      return res.redirect('/admin');
    }

    let colDefs = parsed.map(col => {
      let def = `\`${col.name}\` ${col.type}`;
      if (col.isNotNull) {
        def += ' NOT NULL';
      }
      return def;
    }).join(', ');
    // Add primary key
    colDefs = `\`id\` INT AUTO_INCREMENT PRIMARY KEY, ${colDefs}`;

    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS \`${tableName}\` (${colDefs});
    `;

    try {
      const conn = await pool.getConnection();
      try {
        await conn.query(createTableSQL);
        await conn.query(
          `INSERT INTO dashboards (name, table_name, role_id, can_update)
           VALUES (?, ?, ?, ?)`,
          [dashboardName, tableName, roleId, canUpdate]
        );
        await conn.query(
          `INSERT INTO audit_logs (user_id, action, details)
           VALUES (?, 'Create Dashboard', 'Created dashboard: ${dashboardName} with table: ${tableName}')`,
          [req.session.user.id]
        );
        conn.release();
      } catch (err2) {
        conn.release();
        console.error('Error creating table or dashboard:', err2);
        req.flash('error', 'Failed to create new table or dashboard.');
        return res.redirect('/admin');
      }
      req.flash('success', 'Dashboard created successfully.');
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error connecting to DB:', err);
      req.flash('error', 'Error creating dashboard.');
      return res.redirect('/admin');
    }
  }
);

// POST /admin/create-role – Create new role
router.post(
  '/create-role',
  isAuthenticated,
  isAdmin,
  [body('roleName').trim().notEmpty().withMessage('Role name is required.')],
  async (req, res) => {
    const { roleName } = req.body;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }
    try {
      const [existingRole] = await pool.query('SELECT id FROM roles WHERE name = ?', [roleName]);
      if (existingRole.length > 0) {
        req.flash('error', 'Role already exists.');
        return res.redirect('/admin');
      }
      await pool.query('INSERT INTO roles (name) VALUES (?)', [roleName]);
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details)
         VALUES (?, 'Create Role', 'Created role: ${roleName}')`,
        [req.session.user.id]
      );
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error creating role:', err);
      req.flash('error', 'Error creating role.');
      return res.redirect('/admin');
    }
  }
);

// POST /admin/create-user – Create new user
router.post(
  '/create-user',
  isAuthenticated,
  isAdmin,
  [
    body('username')
      .trim()
      .notEmpty().withMessage('Username is required.')
      .isAlphanumeric().withMessage('Username must be alphanumeric.')
      .custom(async (value) => {
        const [user] = await pool.query('SELECT id FROM users WHERE username = ?', [value]);
        if (user.length > 0) {
          return Promise.reject('Username already in use.');
        }
      }),
    body('password')
      .notEmpty().withMessage('Password is required.')
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long.'),
    body('role_id').isInt().withMessage('Valid role is required.')
  ],
  async (req, res) => {
    const { username, password, role_id } = req.body;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      await pool.query(
        'INSERT INTO users (username, password, role_id) VALUES (?, ?, ?)',
        [username, hashedPassword, role_id]
      );
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details)
         VALUES (?, 'Create User', 'Created user: ${username}')`,
        [req.session.user.id]
      );
      req.flash('success', `User "${username}" created successfully.`);
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error creating user:', err);
      req.flash('error', 'Error creating user.');
      return res.redirect('/admin');
    }
  }
);

// POST /admin/update-user – Edit user (username and/or password)
router.post(
  '/update-user',
  isAuthenticated,
  isAdmin,
  [
    body('user_id').isInt().withMessage('Valid user ID is required.'),
    body('username')
      .trim()
      .notEmpty().withMessage('Username is required.')
      .isAlphanumeric().withMessage('Username must be alphanumeric.'),
    body('password')
      .optional()
      .isLength({ min: 6 }).withMessage('Password must be at least 6 characters long if provided.')
  ],
  async (req, res) => {
    const { user_id, username, password } = req.body;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }
    try {
      let query, params;
      if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);
        query = 'UPDATE users SET username = ?, password = ? WHERE id = ?';
        params = [username, hashedPassword, user_id];
      } else {
        query = 'UPDATE users SET username = ? WHERE id = ?';
        params = [username, user_id];
      }
      await pool.query(query, params);
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details)
         VALUES (?, 'Update User', 'Updated user ID ${user_id} with new username and/or password')`,
        [req.session.user.id]
      );
      req.flash('success', 'User updated successfully.');
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error updating user:', err);
      req.flash('error', 'Error updating user.');
      return res.redirect('/admin');
    }
  }
);

// POST /admin/update-dashboard-role – Update dashboard role assignment
router.post(
  '/update-dashboard-role',
  isAuthenticated,
  isAdmin,
  [
    body('dashboardId').isInt().withMessage('Valid dashboard ID is required.'),
    body('roleId').isInt().withMessage('Valid role ID is required.')
  ],
  async (req, res) => {
    const { dashboardId, roleId } = req.body;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }
    try {
      await pool.query(`UPDATE dashboards SET role_id = ? WHERE id = ?`, [roleId, dashboardId]);
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details)
         VALUES (?, 'Update Dashboard Role', 'Updated dashboard ID ${dashboardId} to role ID ${roleId}')`,
        [req.session.user.id]
      );
      req.flash('success', 'Dashboard role updated successfully.');
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error updating dashboard role:', err);
      req.flash('error', 'Error updating dashboard role.');
      return res.redirect('/admin');
    }
  }
);

// POST /admin/delete-user – Delete a user (if needed)
router.post(
  '/delete-user',
  isAuthenticated,
  isAdmin,
  [body('user_id').isInt().withMessage('Valid user ID is required.')],
  async (req, res) => {
    const { user_id } = req.body;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array().map(err => err.msg).join(' '));
      return res.redirect('/admin');
    }
    try {
      const [userRows] = await pool.query('SELECT username FROM users WHERE id = ?', [user_id]);
      if (userRows.length === 0) {
        req.flash('error', 'User not found.');
        return res.redirect('/admin');
      }
      const username = userRows[0].username;
      await pool.query('DELETE FROM users WHERE id = ?', [user_id]);
      await pool.query(
        `INSERT INTO audit_logs (user_id, action, details)
         VALUES (?, 'Delete User', 'Deleted user: ${username}')`,
        [req.session.user.id]
      );
      req.flash('success', `User "${username}" deleted successfully.`);
      return res.redirect('/admin');
    } catch (err) {
      console.error('Error deleting user:', err);
      req.flash('error', 'Error deleting user.');
      return res.redirect('/admin');
    }
  }
);

module.exports = router;
