// routes/assignToWashingRoutes.js
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isOperator } = require('../middlewares/auth');

/**
 * GET /assign-to-washing
 * Render the assignment dashboard with a dropdown of stitching operators (excluding those with "hoisery")
 * and a list of washers.
 */
router.get('/', isAuthenticated, isOperator, async (req, res) => {
  try {
    // Fetch stitching users (excluding usernames that contain "hoisery")
    const [stitchingUsers] = await pool.query(`
      SELECT u.id, u.username 
      FROM users u 
      JOIN roles r ON u.role_id = r.id 
      WHERE r.name = 'stitching_master' 
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
      stitchingUsers,
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
 * Return stitching records (with their sizes) for the given stitching user.
 * Only records that are not already assigned are returned.
 */
router.get('/data/:userId', isAuthenticated, isOperator, async (req, res) => {
  try {
    const userId = req.params.userId;
    const [rows] = await pool.query(`
      SELECT sd.id, sd.lot_no, sd.sku, sd.total_pieces,
             DATE(sd.created_at) AS created_date,
             sds.size_label, sds.pieces
      FROM stitching_data sd
      LEFT JOIN stitching_data_sizes sds ON sd.id = sds.stitching_data_id
      WHERE sd.user_id = ?
        AND sd.id NOT IN (SELECT stitching_assignment_id FROM washing_assignments)
      ORDER BY sd.created_at DESC, sd.id ASC
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
    console.error('Error fetching stitching data:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /assign-to-washing/assign
 * Create a washing assignment for the selected stitching record.
 * The assignment will store a snapshot of the sizes (from stitching_data_sizes) as sizes_json.
 * We do not store the pieces separately; the latest pieces will be fetched dynamically later.
 * The assignment’s is_approved field is set to NULL (pending approval).
 */
router.post('/assign', isAuthenticated, isOperator, async (req, res) => {
  try {
    const { stitching_data_id, washer_id } = req.body;
    if (!stitching_data_id || !washer_id) {
      req.flash('error', 'Invalid parameters.');
      return res.redirect('/assign-to-washing');
    }

    // Get the stitching data record using the provided stitching_data_id
    const [[stitchRecord]] = await pool.query(
      `SELECT * FROM stitching_data WHERE id = ?`,
      [stitching_data_id]
    );
    if (!stitchRecord) {
      req.flash('error', 'Stitching record not found.');
      return res.redirect('/assign-to-washing');
    }

    // Get the sizes from stitching_data_sizes for this stitching record.
    // This returns an array of objects like: [{ size_label: "25", pieces: 40 }, { size_label: "7XL", pieces: 40 }, ...]
    const [sizes] = await pool.query(
      `SELECT size_label, pieces FROM stitching_data_sizes WHERE stitching_data_id = ?`,
      [stitching_data_id]
    );
    const sizes_json = JSON.stringify(sizes);

    // Insert a new washing assignment.
    // Note: We store the stitching assignment id (which is the same as the stitching data id here)
    // and set is_approved to NULL so that it will require manual approval.
    await pool.query(`
      INSERT INTO washing_assignments
        (stitching_master_id, user_id, stitching_assignment_id, target_day, assigned_on, sizes_json, is_approved)
      VALUES (?, ?, ?, CURDATE(), NOW(), ?, NULL)
    `, [stitchRecord.user_id, washer_id, stitching_data_id, sizes_json]);

    req.flash('success', 'Assignment created successfully and is pending approval.');
    res.redirect('/assign-to-washing');
  } catch (err) {
    console.error('Error creating washing assignment:', err);
    req.flash('error', 'Error creating assignment: ' + err.message);
    res.redirect('/assign-to-washing');
  }
});

module.exports = router;
