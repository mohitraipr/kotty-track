const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

// GET /challandashboard
// Renders the main Challan Dashboard with initial records.
// This route accepts an optional "offset" query parameter.
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;
    const [assignments] = await pool.query(`
      SELECT 
        wa.id AS washing_id,
        jd.lot_no,
        jd.sku,
        jd.total_pieces,
        jd.remark AS assembly_remark,
        c.remark AS cutting_remark,
        wa.target_day,
        wa.assigned_on,
        wa.is_approved,
        wa.assignment_remark,
        u.username AS washer_username,
        m.username AS master_username
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      JOIN cutting_lots c ON jd.lot_no = c.lot_no
      JOIN users u ON wa.user_id = u.id
      JOIN users m ON wa.jeans_assembly_master_id = m.id
      ORDER BY wa.assigned_on DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);
    
    // On initial load render the EJS view.
    res.render('challanDashboard', {
      assignments,
      search: '',
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard =>', error);
    req.flash('error', 'Could not load challan dashboard data: ' + error.message);
    return res.redirect('/');
  }
});

// GET /challandashboard/search
// API endpoint for real‑time search requests with pagination support.
router.get('/search', isAuthenticated, async (req, res) => {
  try {
    const searchQuery = req.query.search ? req.query.search.trim() : '';
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;
    const likeStr = `%${searchQuery}%`;
    const [assignments] = await pool.query(`
      SELECT 
        wa.id AS washing_id,
        jd.lot_no,
        jd.sku,
        jd.total_pieces,
        jd.remark AS assembly_remark,
        c.remark AS cutting_remark,
        wa.target_day,
        wa.assigned_on,
        wa.is_approved,
        wa.assignment_remark,
        u.username AS washer_username,
        m.username AS master_username
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      JOIN cutting_lots c ON jd.lot_no = c.lot_no
      JOIN users u ON wa.user_id = u.id
      JOIN users m ON wa.jeans_assembly_master_id = m.id
      WHERE jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?
      ORDER BY wa.assigned_on DESC
      LIMIT ? OFFSET ?
    `, [likeStr, likeStr, likeStr, limit, offset]);
    
    res.json({ assignments });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard/search =>', error);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
