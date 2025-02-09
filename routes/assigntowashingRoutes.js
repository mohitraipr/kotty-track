// routes/assignToWashingRoutes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * GET /assign-to-washing
 * Render the assignment dashboard with a dropdown of jeans assembly operators (excluding those with "hoisery")
 * and a list of washers.
 */
router.get('/', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Fetch jeans assembly users (exclude usernames that contain "hoisery")
    const [assemblyUsers] = await pool.query(`
      SELECT u.id, u.username 
      FROM users u 
      JOIN roles r ON u.role_id = r.id 
      WHERE r.name = 'jeans_assembly' 
        AND u.username NOT LIKE '%hoisery%'
      ORDER BY u.username ASC
    `);

    // Fetch washers (active users with role "washing")
    const [washers] = await pool.query(`
      SELECT u.id, u.username 
      FROM users u 
      JOIN roles r ON u.role_id = r.id 
      WHERE r.name = 'washing' 
        AND u.is_active = 1 
      ORDER BY u.username ASC
    `);

    res.render('assignToWashingDashboard', {
      assemblyUsers,  // updated variable name for jeans assembly users
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
      SELECT jad.id, jad.lot_no, jad.sku, jad.total_pieces,
             DATE(jad.created_at) AS created_date,
             jads.size_label, jads.pieces
      FROM jeans_assembly_data jad
      LEFT JOIN jeans_assembly_data_sizes jads ON jad.id = jads.jeans_assembly_data_id
      WHERE jad.user_id = ?
        AND jad.id NOT IN (SELECT jeans_assembly_assignment_id FROM washing_assignments)
      ORDER BY jad.created_at DESC, jad.id ASC
    `, [userId]);

    // Group the results by created_date and by record id
    const grouped = {};
    rows.forEach(row => {
      const date = row.created_date;
      if (!grouped[date]) grouped[date] = {};
      if (!grouped[date][row.id]) {
        grouped[date][row.id] = {
          id: row.id,
          lot_no: row.lot_no,
          sku: row.sku,
          total_pieces: row.total_pieces,
          sizes: []
        };
      }
      if (row.size_label) {
        grouped[date][row.id].sizes.push({
          size_label: row.size_label,
          pieces: row.pieces
        });
      }
    });

    const result = [];
    for (const date in grouped) {
      result.push({
        created_date: date,
        entries: Object.values(grouped[date])
      });
    }
    // Sort groups by date descending
    result.sort((a, b) => new Date(b.created_date) - new Date(a.created_date));
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
    // Notice the parameter name has changed from stitching_data_id to jeans_assembly_data_id
    const { jeans_assembly_data_id, washer_id } = req.body;
    if (!jeans_assembly_data_id || !washer_id) {
      req.flash('error', 'Invalid parameters.');
      return res.redirect('/assign-to-washing');
    }

    // Get the jeans assembly data record using the provided id
    const [[assemblyRecord]] = await pool.query(
      `SELECT * FROM jeans_assembly_data WHERE id = ?`,
      [jeans_assembly_data_id]
    );
    if (!assemblyRecord) {
      req.flash('error', 'Jeans Assembly record not found.');
      return res.redirect('/assign-to-washing');
    }

    // Get the sizes from jeans_assembly_data_sizes for this record.
    const [sizes] = await pool.query(
      `SELECT size_label, pieces FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = ?`,
      [jeans_assembly_data_id]
    );
    const sizes_json = JSON.stringify(sizes);

    // Insert a new washing assignment.
    // Note: We now record the jeans assembly assignment details
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
