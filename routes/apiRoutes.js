const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');

// Simple in-memory cache for rolls to avoid repeated DB reads
let rollsCache = { data: null, expires: 0 };

// Function to fetch rolls by fabric type from existing tables
async function getRollsByFabricType() {
  if (rollsCache.data && Date.now() < rollsCache.expires) {
    return rollsCache.data;
  }
  try {
    const [rows] = await pool.query(`
      SELECT fi.fabric_type, fir.roll_no, fir.per_roll_weight, fir.unit, v.name AS vendor_name
      FROM fabric_invoice_rolls fir
      JOIN fabric_invoices fi ON fir.invoice_id = fi.id
      JOIN vendors v ON fir.vendor_id = v.id
      WHERE fir.per_roll_weight > 0 AND fi.fabric_type IS NOT NULL
    `);

    const rollsByFabricType = {};
    rows.forEach((row) => {
      if (!rollsByFabricType[row.fabric_type]) {
        rollsByFabricType[row.fabric_type] = [];
      }
      rollsByFabricType[row.fabric_type].push({
        roll_no: row.roll_no,
        unit: row.unit,
        per_roll_weight: row.per_roll_weight,
        vendor_name: row.vendor_name,
      });
    });

    rollsCache = { data: rollsByFabricType, expires: Date.now() + 5 * 60 * 1000 };
    return rollsByFabricType;
  } catch (err) {
    console.error('Error fetching rolls by fabric type:', err);
    return {};
  }
}

// GET /api/fabric-rolls - Fetch fabric types and their rolls
router.get(
  '/fabric-rolls',
  isAuthenticated,
  allowRoles(['cutting_manager', 'cutting_master']),
  async (req, res) => {
    try {
      const rollsByFabricType = await getRollsByFabricType();
      res.json(rollsByFabricType);
    } catch (err) {
      console.error('Error in /api/fabric-rolls:', err);
      res.status(500).json({ error: 'Failed to fetch fabric rolls' });
    }
  }
);

module.exports = router;
