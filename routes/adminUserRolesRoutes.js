// routes/adminUserRolesRoutes.js
//
// MohitOperator-only admin UI for managing the new user_roles M2M table.
//
//   GET  /admin/user-roles                    page (list + manage)
//   GET  /admin/user-roles/api/users          ?search=…    paginated user list w/ roles
//   GET  /admin/user-roles/api/roles                       all roles (for the dropdown)
//   POST /admin/user-roles/grant              { user_id, role_id }
//   POST /admin/user-roles/revoke             { user_id, role_id }
//   POST /admin/user-roles/set-primary        { user_id, role_id }
//
// All POSTs audited via security_audit_log.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOnlyMohitOperator } = require('../middlewares/auth');

// All admin endpoints gated by mohitOperator. isOnlyMohitOperator already
// case-insensitively checks username.
router.use(isAuthenticated, isOnlyMohitOperator);

// ─── PAGE ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  res.render('adminUserRoles', { user: req.session.user });
});

// ─── API: list users with their roles + search ────────────────────────
router.get('/api/users', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const limit  = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));

    const params = [];
    let where = 'WHERE 1=1';
    if (search) {
      where += ' AND (u.username LIKE ? OR u.id = ?)';
      params.push(`%${search}%`, /^\d+$/.test(search) ? parseInt(search, 10) : -1);
    }
    params.push(limit);

    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.is_active, u.role_id AS primary_role_id,
              pr.name AS primary_role_name,
              GROUP_CONCAT(DISTINCT r.name ORDER BY r.name SEPARATOR ',') AS roles_csv,
              GROUP_CONCAT(DISTINCT r.id   ORDER BY r.name SEPARATOR ',') AS role_ids_csv
       FROM users u
       LEFT JOIN roles pr ON pr.id = u.role_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id
       LEFT JOIN roles r       ON r.id = ur.role_id
       ${where}
       GROUP BY u.id, u.username, u.is_active, u.role_id, pr.name
       ORDER BY u.username ASC
       LIMIT ?`,
      params
    );

    const users = rows.map(r => ({
      id: r.id,
      username: r.username,
      is_active: !!r.is_active,
      primary_role_id: r.primary_role_id,
      primary_role_name: r.primary_role_name,
      roles: r.roles_csv ? r.roles_csv.split(',') : [],
      role_ids: r.role_ids_csv ? r.role_ids_csv.split(',').map(Number) : [],
    }));
    res.json({ ok: true, users });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: false, error: 'Run sql/multi_role_user.sql first.', users: [] });
    }
    console.error('[admin-user-roles] users list error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: all roles ───────────────────────────────────────────────────
router.get('/api/roles', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name FROM roles ORDER BY name ASC');
    res.json({ ok: true, roles: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

async function audit(eventType, actorUsername, details) {
  try {
    await pool.query(
      `INSERT INTO security_audit_log (event_type, username, details, created_at)
       VALUES (?, ?, ?, NOW())`,
      [eventType, actorUsername || 'unknown', JSON.stringify(details || {})]
    );
  } catch (_) { /* best-effort */ }
}

// ─── POST: grant a role ───────────────────────────────────────────────
router.post('/grant', async (req, res) => {
  try {
    const userId = parseInt(req.body.user_id, 10);
    const roleId = parseInt(req.body.role_id, 10);
    if (!userId || !roleId) return res.status(400).json({ ok: false, error: 'user_id and role_id required' });

    const [[user]] = await pool.query('SELECT id, username FROM users WHERE id = ?', [userId]);
    const [[role]] = await pool.query('SELECT id, name FROM roles WHERE id = ?', [roleId]);
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    if (!role) return res.status(404).json({ ok: false, error: 'Role not found' });

    await pool.query(
      `INSERT IGNORE INTO user_roles (user_id, role_id, granted_by, granted_at)
       VALUES (?, ?, ?, NOW())`,
      [userId, roleId, req.session.user.id || null]
    );
    await audit('USER_ROLE_GRANTED', req.session.user.username, {
      target_user_id: userId, target_username: user.username,
      role_id: roleId, role_name: role.name,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST: revoke a role ──────────────────────────────────────────────
router.post('/revoke', async (req, res) => {
  try {
    const userId = parseInt(req.body.user_id, 10);
    const roleId = parseInt(req.body.role_id, 10);
    if (!userId || !roleId) return res.status(400).json({ ok: false, error: 'user_id and role_id required' });

    // Don't allow revoking the user's primary role — they'd be locked out.
    const [[u]] = await pool.query('SELECT username, role_id FROM users WHERE id = ?', [userId]);
    if (!u) return res.status(404).json({ ok: false, error: 'User not found' });
    if (Number(u.role_id) === roleId) {
      return res.status(400).json({
        ok: false,
        error: 'Cannot revoke the user\'s primary role. Change the primary role first.',
      });
    }

    const [[role]] = await pool.query('SELECT name FROM roles WHERE id = ?', [roleId]);
    await pool.query('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?', [userId, roleId]);
    await audit('USER_ROLE_REVOKED', req.session.user.username, {
      target_user_id: userId, target_username: u.username,
      role_id: roleId, role_name: role && role.name,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── POST: change the user's primary role ─────────────────────────────
// Required: the target role must already be granted via user_roles.
router.post('/set-primary', async (req, res) => {
  try {
    const userId = parseInt(req.body.user_id, 10);
    const roleId = parseInt(req.body.role_id, 10);
    if (!userId || !roleId) return res.status(400).json({ ok: false, error: 'user_id and role_id required' });

    const [[has]] = await pool.query(
      'SELECT 1 AS ok FROM user_roles WHERE user_id = ? AND role_id = ?',
      [userId, roleId]
    );
    if (!has) {
      return res.status(400).json({
        ok: false,
        error: 'User does not have this role yet. Grant it first, then set primary.',
      });
    }

    const [[user]] = await pool.query('SELECT id, username, role_id FROM users WHERE id = ?', [userId]);
    const [[role]] = await pool.query('SELECT name FROM roles WHERE id = ?', [roleId]);

    await pool.query('UPDATE users SET role_id = ? WHERE id = ?', [roleId, userId]);

    await audit('USER_PRIMARY_ROLE_CHANGED', req.session.user.username, {
      target_user_id: userId, target_username: user.username,
      from_role_id: user.role_id, to_role_id: roleId, to_role_name: role && role.name,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
