// routes/cuttingManagerRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isCuttingManager } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit');
const generateLotNumber = require('../utils/generateLotNumber'); // Import the utility function

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, 'uploads/'); // Ensure this directory exists
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // e.g., 1598465759595.jpg
  }
});
const upload = multer({ storage: storage });

// Function to fetch rolls by fabric type from existing tables
async function getRollsByFabricType() {
  try {
    const [rows] = await pool.query(`
      SELECT fi.fabric_type, fir.roll_no, fir.per_roll_weight,fir.unit, v.name AS vendor_name
      FROM fabric_invoice_rolls fir
      JOIN fabric_invoices fi ON fir.invoice_id = fi.id
      JOIN vendors v ON fir.vendor_id = v.id
      WHERE fir.per_roll_weight > 0 AND fi.fabric_type IS NOT NULL
    `);

    // Transform the data into the desired format
    const rollsByFabricType = {};
    rows.forEach(row => {
      if (!rollsByFabricType[row.fabric_type]) {
        rollsByFabricType[row.fabric_type] = [];
      }
      rollsByFabricType[row.fabric_type].push({
        roll_no: row.roll_no,
        unit: row.unit,
        per_roll_weight: row.per_roll_weight,
        vendor_name: row.vendor_name // Include vendor_name
      });
    });

    return rollsByFabricType;
  } catch (err) {
    console.error('Error fetching rolls by fabric type:', err);
    return {}; // Return an empty object on error to prevent crashing
  }
}

// GET /cutting-manager/dashboard
router.get('/dashboard', isAuthenticated, isCuttingManager, async (req, res) => {
  let conn;
  try {
    console.log('Session User:', req.session.user); // Debugging line

    const userId = req.session.user.id;

    // Ensure userId is available
    if (!userId) {
      req.flash('error', 'User ID is missing in session.');
      return res.redirect('/logout'); // Redirect to logout or login
    }

    // Start a transaction to generate lot_no safely
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Generate a new lot number
    const username = req.session.user.username;
    const generatedLotNumber = await generateLotNumber(username, userId, conn);

    // Commit the transaction
    await conn.commit();
    conn.release();

    // Fetch all cutting lots created by this cutting manager
    const [cuttingLots] = await pool.query(`
      SELECT 
        l.id,
        l.lot_no,
        l.sku,
        l.fabric_type,
        l.remark,
        l.image_url,
        l.total_pieces,
        l.is_confirmed,
        l.created_at,
        u.username AS created_by
      FROM cutting_lots l
      JOIN users u ON l.user_id = u.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
    `, [userId]);

    // For each lot, fetch associated sizes
    for (let lot of cuttingLots) {
      const [sizes] = await pool.query(`
        SELECT 
          cls.size_label,
          cls.pattern_count,
          cls.total_pieces
        FROM cutting_lot_sizes cls
        WHERE cls.cutting_lot_id = ?
      `, [lot.id]);

      lot.sizes = sizes;
    }

    // Fetch all department users (excluding cutting_manager)
    const [departmentUsers] = await pool.query(`
      SELECT u.id, u.username, r.name AS role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name IN ('stitching_master', 'checking', 'washing', 'finishing', 'quality_assurance')
        AND u.is_active = TRUE
      ORDER BY r.name, u.username
    `);

    // Fetch pending assignments for this cutting manager
    const [pendingAssignments] = await pool.query(`
      SELECT 
        la.id AS assignment_id,
        l.lot_no,
        l.sku,
        l.fabric_type,
        la.assigned_pieces,
        la.target_day,
        la.status,
        la.assigned_at,
        u_to.username AS assigned_to,
        IFNULL(dc.confirmed_pieces, 0) AS confirmed_pieces,
        (la.assigned_pieces - IFNULL(dc.confirmed_pieces, 0)) AS pending_pieces,
        DATEDIFF(CURDATE(), la.target_day) AS days_late
      FROM lot_assignments la
      JOIN cutting_lots l ON la.cutting_lot_id = l.id
      JOIN users u_to ON la.assigned_to_user_id = u_to.id
      LEFT JOIN department_confirmations dc 
        ON la.id = dc.lot_assignment_id
      WHERE la.assigned_by_user_id = ?
      ORDER BY la.assigned_at DESC
    `, [userId]);

    // Fetch rolls by fabric type
    const rollsByFabricType = await getRollsByFabricType();

    // Render the dashboard with all necessary data
    res.render('cuttingManagerDashboard', { // Ensure this matches your EJS file name
      user: req.session.user,
      cuttingLots,
      departmentUsers,
      pendingAssignments,
      rollsByFabricType, // Now includes vendor_name
      generatedLotNumber, // Pass the generated lot number
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error('Error loading Cutting Manager Dashboard:', err);
    req.flash('error', 'Failed to load Cutting Manager Dashboard.');
    res.redirect('/'); // Adjust as needed
  }
});

// POST /cutting-manager/create-lot
// Handle creating a new cutting lot
router.post('/create-lot', isAuthenticated, isCuttingManager, upload.single('image'), async (req, res) => {
  const { lot_no, sku, fabric_type, remark, size_label, pattern_count, roll_no, layers, weight_used } = req.body;
  const image = req.file;

  // Input validation
  if (!lot_no || !sku || !fabric_type) {
    req.flash('error', 'Lot No., SKU and Fabric Type are required.');
    return res.redirect('/cutting-manager/dashboard');
  }

  try {
    const userId = req.session.user.id;
    const username = req.session.user.username;

    // Start a transaction
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Insert the new cutting lot with total_pieces = 0
      const [result] = await conn.query(`
        INSERT INTO cutting_lots 
          (lot_no, sku, fabric_type, remark, image_url, user_id, total_pieces)
        VALUES 
          (?, ?, ?, ?, ?, ?, 0)
      `, [
        lot_no,
        sku,
        fabric_type,
        remark || null,
        image ? image.path : null,
        userId
      ]);

      const cuttingLotId = result.insertId;

      // Handle sizes if provided (arrays)
      // Ensure size_label and pattern_count are arrays
      let sizes = [];
      if (Array.isArray(size_label) && Array.isArray(pattern_count)) {
        for (let i = 0; i < size_label.length; i++) {
          if (size_label[i] && pattern_count[i]) {
            sizes.push({
              size_label: size_label[i],
              pattern_count: parseInt(pattern_count[i], 10)
            });
          }
        }
      } else if (size_label && pattern_count) {
        // If only one size is provided
        sizes.push({
          size_label: size_label,
          pattern_count: parseInt(pattern_count, 10)
        });
      }

      // Insert sizes into cutting_lot_sizes
      for (let size of sizes) {
        if (size.size_label && !isNaN(size.pattern_count) && size.pattern_count > 0) {
          await conn.query(`
            INSERT INTO cutting_lot_sizes 
              (cutting_lot_id, size_label, pattern_count, total_pieces, created_at)
            VALUES 
              (?, ?, ?, 0, NOW())
          `, [cuttingLotId, size.size_label, size.pattern_count]);
        }
      }

      // Handle Rolls Used if provided
      // Ensure roll_no, layers, weight_used are arrays
      let rolls = [];
      if (Array.isArray(roll_no) && Array.isArray(layers) && Array.isArray(weight_used)) {
        for (let i = 0; i < roll_no.length; i++) {
          if (roll_no[i] && layers[i] && weight_used[i]) {
            rolls.push({
              roll_no: roll_no[i],
              layers: parseInt(layers[i], 10),
              weight_used: parseFloat(weight_used[i])
            });
          }
        }
      } else if (roll_no && layers && weight_used) {
        // If only one roll is provided
        rolls.push({
          roll_no: roll_no,
          layers: parseInt(layers, 10),
          weight_used: parseFloat(weight_used)
        });
      }

      // Insert rolls into cutting_lot_rolls and update fabric_invoice_rolls
      for (let roll of rolls) {
        // Check if the selected roll has enough weight
        const [rollRows] = await conn.query(`
          SELECT fir.per_roll_weight 
          FROM fabric_invoice_rolls fir 
          JOIN vendors v ON fir.vendor_id = v.id 
          WHERE fir.roll_no = ? AND v.name IS NOT NULL FOR UPDATE
        `, [roll.roll_no]);

        if (rollRows.length === 0) {
          throw new Error(`Roll No. ${roll.roll_no} does not exist.`);
        }

        const availableWeight = parseFloat(rollRows[0].per_roll_weight);
        if (roll.weight_used > availableWeight) {
          throw new Error(`Insufficient weight for Roll No. ${roll.roll_no}. Available: ${availableWeight}, Requested: ${roll.weight_used}`);
        }

        // Insert into cutting_lot_rolls
        await conn.query(`
          INSERT INTO cutting_lot_rolls 
            (cutting_lot_id, roll_no, weight_used, layers, total_pieces, created_at)
          VALUES 
            (?, ?, ?, ?, 0, NOW())
        `, [cuttingLotId, roll.roll_no, roll.weight_used, roll.layers]);

        // Deduct the used weight from fabric_invoice_rolls
        await conn.query(`
          UPDATE fabric_invoice_rolls
          SET per_roll_weight = per_roll_weight - ?
          WHERE roll_no = ?
        `, [roll.weight_used, roll.roll_no]);
      }

      // Calculate total_pieces
      // Sum of pattern_counts across sizes
      const [sizeRows] = await conn.query(`
        SELECT pattern_count FROM cutting_lot_sizes WHERE cutting_lot_id = ?
      `, [cuttingLotId]);

      let sumPatterns = 0;
      for (let size of sizeRows) {
        sumPatterns += size.pattern_count;
      }

      // Sum of layers across rolls
      const [rollRowsSum] = await conn.query(`
        SELECT SUM(layers) AS total_layers FROM cutting_lot_rolls WHERE cutting_lot_id = ?
      `, [cuttingLotId]);

      const sumLayers = parseInt(rollRowsSum[0].total_layers, 10) || 0;

      // Total Pieces = Sum of Patterns * Sum of Layers
      const totalPieces = sumPatterns * sumLayers;

      // Update total_pieces in cutting_lots
      await conn.query(`
        UPDATE cutting_lots
        SET total_pieces = ?
        WHERE id = ?
      `, [totalPieces, cuttingLotId]);

      // Update total_pieces in cutting_lot_sizes
      for (let size of sizes) {
        const totalPiecesPerSize = size.pattern_count * sumLayers;
        await conn.query(`
          UPDATE cutting_lot_sizes
          SET total_pieces = ?
          WHERE cutting_lot_id = ? AND size_label = ?
        `, [totalPiecesPerSize, cuttingLotId, size.size_label]);
      }

      await conn.commit();
      conn.release();

      req.flash('success', `Cutting Lot ${lot_no} created successfully with Total Pieces: ${totalPieces}.`);
      res.redirect('/cutting-manager/dashboard');
    } catch (err2) {
      await conn.rollback();
      conn.release();
      console.error('Error creating Cutting Lot:', err2);
      req.flash('error', err2.message || 'Failed to create Cutting Lot.');
      res.redirect('/cutting-manager/dashboard');
    }
  } catch (err) {
    console.error('Database Connection Error:', err);
    req.flash('error', 'Database connection failed.');
    res.redirect('/cutting-manager/dashboard');
  }
});

// GET /cutting-manager/generate-challan/:lotId
router.get('/generate-challan/:lotId', isAuthenticated, isCuttingManager, async (req, res) => {
  const lotId = req.params.lotId;

  try {
    // Fetch lot details
    const [lotRows] = await pool.query(`
      SELECT 
        l.lot_no,
        l.sku,
        l.fabric_type,
        l.remark,
        l.total_pieces,
        u.username AS created_by,
        l.created_at
      FROM cutting_lots l
      JOIN users u ON l.user_id = u.id
      WHERE l.id = ?
    `, [lotId]);

    if (lotRows.length === 0) {
      req.flash('error', 'Cutting Lot not found.');
      return res.redirect('/cutting-manager/dashboard');
    }

    const lot = lotRows[0];

    // Create a PDF document
    const doc = new PDFDocument();

    // Set response headers
    res.setHeader('Content-disposition', `attachment; filename=Challan_${lot.lot_no}.pdf`);
    res.setHeader('Content-type', 'application/pdf');

    // Pipe the PDF into the response
    doc.pipe(res);

    // Add content to the PDF
    doc.fontSize(20).text('Challan', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).text(`Lot No: ${lot.lot_no}`);
    doc.text(`SKU: ${lot.sku}`);
    doc.text(`Fabric Type: ${lot.fabric_type}`);
    doc.text(`Total Pieces: ${lot.total_pieces}`);
    doc.text(`Created By: ${lot.created_by}`);
    doc.text(`Created At: ${new Date(lot.created_at).toLocaleString()}`);
    doc.moveDown();

    if (lot.remark) {
      doc.text(`Remark: ${lot.remark}`);
      doc.moveDown();
    }

    // Fetch sizes and patterns
    const [sizes] = await pool.query(`
      SELECT size_label, pattern_count, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?
    `, [lotId]);

    if (sizes.length > 0) {
      doc.fontSize(14).text('Sizes and Patterns', { underline: true });
      doc.moveDown();

      sizes.forEach(size => {
        doc.fontSize(12).text(`Size: ${size.size_label}, Patterns: ${size.pattern_count}, Total Pieces: ${size.total_pieces}`);
      });
      doc.moveDown();
    }

    // Fetch rolls used
    const [rolls] = await pool.query(`
      SELECT roll_no, weight_used, layers, total_pieces FROM cutting_lot_rolls WHERE cutting_lot_id = ?
    `, [lotId]);

    if (rolls.length > 0) {
      doc.fontSize(14).text('Rolls Used', { underline: true });
      doc.moveDown();

      rolls.forEach(roll => {
        doc.fontSize(12).text(`Roll No: ${roll.roll_no}, Weight Used: ${roll.weight_used}, Layers: ${roll.layers}, Total Pieces: ${roll.total_pieces}`);
      });
      doc.moveDown();
    }

    doc.end();
  } catch (err) {
    console.error('Error generating challan:', err);
    req.flash('error', 'Failed to generate challan.');
    res.redirect('/cutting-manager/dashboard');
  }
});

// GET /cutting-manager/lot-details/:lotId
router.get('/lot-details/:lotId', isAuthenticated, isCuttingManager, async (req, res) => {
  const lotId = req.params.lotId;

  try {
    // Fetch lot details
    const [lotRows] = await pool.query(`
      SELECT 
        l.id,
        l.lot_no,
        l.sku,
        l.fabric_type,
        l.remark,
        l.image_url,
        l.total_pieces,
        l.is_confirmed,
        l.created_at,
        u.username AS created_by
      FROM cutting_lots l
      JOIN users u ON l.user_id = u.id
      WHERE l.id = ?
    `, [lotId]);

    if (lotRows.length === 0) {
      req.flash('error', 'Cutting Lot not found.');
      return res.redirect('/cutting-manager/dashboard');
    }

    const lot = lotRows[0];

    // Fetch sizes and patterns
    const [sizes] = await pool.query(`
      SELECT size_label, pattern_count, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?
    `, [lotId]);

    // Fetch rolls used
    const [rolls] = await pool.query(`
      SELECT roll_no, weight_used, layers, total_pieces FROM cutting_lot_rolls WHERE cutting_lot_id = ?
    `, [lotId]);

    res.render('lotDetails', {
      user: req.session.user,
      lot,
      sizes,
      rolls
    });
  } catch (err) {
    console.error('Error loading Lot Details:', err);
    req.flash('error', 'Failed to load Lot Details.');
    res.redirect('/cutting-manager/dashboard');
  }
});

module.exports = router;
