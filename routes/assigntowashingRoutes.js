// routes/assignToWashingRoutes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

// Simple in-memory cache with TTL for dropdown data
const cache = {
  assemblyUsers: { data: null, expiry: 0 },
  washers: { data: null, expiry: 0 }
};
const CACHE_TTL_MS = 60 * 1000; // 1 minute

/**
 * GET /assign-to-washing
 * Render the assignment dashboard with a dropdown of jeans assembly operators (excluding those with "hoisery")
 * and a list of washers.
 */
router.get('/', isAuthenticated, isOperator, async (req, res) => {
  try {
    const now = Date.now();
    const fetchAssemblyUsers = async () => {
      if (cache.assemblyUsers.data && cache.assemblyUsers.expiry > now) {
        return cache.assemblyUsers.data;
      }
      const [rows] = await pool.query(`
        SELECT u.id, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'jeans_assembly'
          AND u.username NOT LIKE '%hoisery%'
        ORDER BY u.username ASC
      `);
      cache.assemblyUsers = { data: rows, expiry: now + CACHE_TTL_MS };
      return rows;
    };

    const fetchWashers = async () => {
      if (cache.washers.data && cache.washers.expiry > now) {
        return cache.washers.data;
      }
      const [rows] = await pool.query(`
        SELECT u.id, u.username
        FROM users u
        JOIN roles r ON u.role_id = r.id
        WHERE r.name = 'washing'
          AND u.is_active = 1
        ORDER BY u.username ASC
      `);
      cache.washers = { data: rows, expiry: now + CACHE_TTL_MS };
      return rows;
    };

    const [assemblyUsers, washers] = await Promise.all([
      fetchAssemblyUsers(),
      fetchWashers()
    ]);

    res.render('assignToWashingDashboard', {
      assemblyUsers,
      washers,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading assignment dashboard:', err);
    req.flash('error', 'Cannot load dashboard data.');
    res.redirect('/');
  }
});

/**
 * GET /assign-to-washing/data/:userId
 * Return jeans assembly records (with their sizes) for the given jeans assembly user.
 * Only records that are not already assigned are returned.
 */
router.get('/data/:userId', isAuthenticated, isOperator, async (req, res) => {
  try {
    const userId = req.params.userId;
    const [rows] = await pool.query(`
      SELECT
        DATE(jad.created_at) AS created_date,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', jad.id,
            'lot_no', jad.lot_no,
            'sku', jad.sku,
            'total_pieces', jad.total_pieces,
            'sizes', (
              SELECT JSON_ARRAYAGG(JSON_OBJECT('size_label', jas.size_label, 'pieces', jas.pieces))
              FROM jeans_assembly_data_sizes jas
              WHERE jas.jeans_assembly_data_id = jad.id
            )
          ) ORDER BY jad.id ASC
        ) AS entries
      FROM jeans_assembly_data jad
      LEFT JOIN washing_assignments wa ON wa.jeans_assembly_assignment_id = jad.id
      WHERE jad.user_id = ?
        AND wa.id IS NULL
      GROUP BY DATE(jad.created_at)
      ORDER BY created_date DESC
    `, [userId]);

    const result = rows.map(row => ({
      created_date: row.created_date,
      entries: JSON.parse(row.entries || '[]')
    }));

    res.json(result);
  } catch (err) {
    console.error('Error fetching jeans assembly data:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /assign-to-washing/assign
 * Create a washing assignment for the selected jeans assembly record.
 * The assignment will store a snapshot of the sizes (from jeans_assembly_data_sizes) as sizes_json.
 * We do not store the pieces separately; the latest pieces will be fetched dynamically later.
 * The assignment’s is_approved field is set to NULL (pending approval).
 */
router.post('/assign', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { jeans_assembly_data_id, washer_id } = req.body;
    if (!jeans_assembly_data_id || !washer_id) {
      req.flash('error', 'Invalid parameters.');
      return res.redirect('/assign-to-washing');
    }

    const [ [assemblyRecord], [sizes] ] = await Promise.all([
      pool.query(`SELECT user_id FROM jeans_assembly_data WHERE id = ?`, [jeans_assembly_data_id]).then(r => r[0]),
      pool.query(`SELECT size_label, pieces FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = ?`, [jeans_assembly_data_id]).then(r => r[0])
    ]);

    if (!assemblyRecord) {
      req.flash('error', 'Jeans Assembly record not found.');
      return res.redirect('/assign-to-washing');
    }

    const sizes_json = JSON.stringify(sizes);

    await pool.query(`
      INSERT INTO washing_assignments
        (jeans_assembly_master_id, user_id, jeans_assembly_assignment_id, target_day, assigned_on, sizes_json, is_approved)
      VALUES (?, ?, ?, CURDATE(), NOW(), ?, NULL)
    `, [assemblyRecord.user_id, washer_id, jeans_assembly_data_id, sizes_json]);

    req.flash('success', 'Assignment created successfully and is pending approval.');
    res.redirect('/assign-to-washing');
  } catch (err) {
    console.error('Error creating washing assignment:', err);
    req.flash('error', 'Error creating assignment: ' + err.message);
    res.redirect('/assign-to-washing');
  }
});

module.exports = router;
