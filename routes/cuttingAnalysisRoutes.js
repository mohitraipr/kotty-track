/**
 * Cutting Analysis Dashboard Routes
 * Smart analysis: What to cut, How much, Wrong cuts, DOH
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');
const fs = require('fs');
const path = require('path');

// Middleware: Admin/Operator access
const isAnalyst = (req, res, next) => {
  const role = req.session.user?.role?.toLowerCase() || '';
  if (['admin', 'operator', 'accounts'].includes(role)) {
    return next();
  }
  req.flash('error', 'Access denied');
  return res.redirect('/');
};

// Main dashboard - loads with pre-analyzed data
router.get('/', isAuthenticated, isAnalyst, async (req, res) => {
  try {
    // Load pre-processed analysis data
    const analysisPath = path.join(__dirname, '..', 'ReportsForCLAUDE', 'analysis_data.json');

    let analysisData = [];
    let summary = null;

    if (fs.existsSync(analysisPath)) {
      const jsonData = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
      analysisData = jsonData.analysis || [];
      summary = jsonData.summary || null;
    }

    // Get last 30 days cutting data (denim only)
    const [cuttingData] = await pool.query(`
      SELECT
        cl.sku,
        cl.lot_no,
        cl.total_pieces,
        cl.remark,
        cl.created_at,
        u.username AS cutting_master
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      WHERE cl.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        AND (u.is_denim_cutter = 1 OR cl.lot_no REGEXP '^(AK|UM)')
      ORDER BY cl.created_at DESC
      LIMIT 500
    `);

    // Get cutting totals by SKU
    const [cuttingTotals] = await pool.query(`
      SELECT UPPER(cl.sku) as sku, SUM(cl.total_pieces) as total_cut
      FROM cutting_lots cl
      JOIN users u ON cl.user_id = u.id
      WHERE cl.created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
        AND (u.is_denim_cutter = 1 OR cl.lot_no REGEXP '^(AK|UM)')
      GROUP BY UPPER(cl.sku)
    `);

    const cuttingMap = {};
    cuttingTotals.forEach(c => { cuttingMap[c.sku] = c.total_cut; });

    // Merge cutting data into analysis
    analysisData.forEach(item => {
      const cut = cuttingMap[item.sku] || 0;
      item.cut = cut;

      // Update cut status
      if (cut > 0) {
        if (item.orders === 0 || (item.orders < 50 && cut > 500)) {
          item.cutStatus = 'WRONG CUT';
        } else if (cut >= item.needToCut * 0.8) {
          item.cutStatus = 'ADEQUATE';
        } else {
          item.cutStatus = 'UNDER CUT';
        }
      } else if (item.needToCut > 0) {
        item.cutStatus = 'NEEDS CUTTING';
      } else {
        item.cutStatus = 'NOT NEEDED';
      }
    });

    // Update summary with cut stats
    if (summary) {
      summary.wrongCut = analysisData.filter(a => a.cutStatus === 'WRONG CUT').length;
      summary.needsCutting = analysisData.filter(a => a.cutStatus === 'NEEDS CUTTING').length;
    }

    res.render('cuttingAnalysisDashboard', {
      user: req.session.user,
      cuttingData,
      analysisData,
      summary,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('Error loading cutting analysis:', err);
    req.flash('error', 'Failed to load data: ' + err.message);
    res.redirect('/');
  }
});

// API: Get analysis JSON
router.get('/api/data', isAuthenticated, isAnalyst, async (req, res) => {
  try {
    const analysisPath = path.join(__dirname, '..', 'ReportsForCLAUDE', 'analysis_data.json');

    if (!fs.existsSync(analysisPath)) {
      return res.status(404).json({ error: 'Analysis data not found' });
    }

    const jsonData = JSON.parse(fs.readFileSync(analysisPath, 'utf-8'));
    res.json(jsonData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
