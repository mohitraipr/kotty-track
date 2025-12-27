const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { pool } = require('../config/db');

// POST /api/login - authenticate user and return username and role
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.password, r.name AS roleName
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.username = ? AND u.is_active = TRUE
       LIMIT 1`,
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Optionally set session for authenticated user
    req.session.user = {
      id: user.id,
      username: user.username,
      roleName: user.roleName,
      role: user.roleName
    };

    return res.json({ username: user.username, role: user.roleName });
  } catch (err) {
    console.error('Error during API login:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
