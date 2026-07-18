// routes/cuttingManagerRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isCuttingManager } = require('../middlewares/auth');
const multer = require('multer');
const path = require('path');
const PDFDocument = require('pdfkit');
const generateLotNumber = require('../utils/generateLotNumber'); // Import the utility function
const { cache } = require('../utils/cache');
const { allowAdhocCuttingEntry, isKnownFabricType } = require('../utils/storeSettings');

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Ensure this directory exists
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // e.g., 1598465759595.jpg
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max for images
});

// Function to fetch rolls by fabric type from existing tables
async function getRollsByFabricType() {
  // Fixed: Use centralized cache instead of local cache
  return cache.fetchCached('rollsByFabricType', async () => {
    try {
      const [rows] = await pool.query(`
        SELECT fi.fabric_type, fir.roll_no, fir.per_roll_weight, fir.unit, v.name AS vendor_name
        FROM fabric_invoice_rolls fir
        JOIN fabric_invoices fi ON fir.invoice_id = fi.id
        JOIN vendors v ON fir.vendor_id = v.id
        WHERE fir.per_roll_weight > 0 AND fi.fabric_type IS NOT NULL
      `);

      // Transform the data into the desired format
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

      return rollsByFabricType;
    } catch (err) {
      console.error('Error fetching rolls by fabric type:', err);
      return {}; // Return an empty object on error to prevent crashing
    }
  });
}

// GET /cutting-manager/dashboard
router.get('/dashboard', isAuthenticated, isCuttingManager, async (req, res) => {
  let conn;
  try {
    console.log('Session User:', req.session.user); // Debugging line
    const userId = req.session.user.id;
    if (!userId) {
      req.flash('error', 'User ID is missing in session.');
      return res.redirect('/logout');
    }

    // Start a transaction to generate lot_no safely
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const username = req.session.user.username;
    const generatedLotNumber = await generateLotNumber(username, userId, conn);

    await conn.commit();
    conn.release();

    // Fetch all cutting lots created by this cutting manager
    const [cuttingLots] = await pool.query(
      `
      SELECT
        l.id,
        l.lot_no,
        l.manual_lot_number,
        l.sku,
        l.fabric_type,
        l.remark,
        l.image_url,
        l.total_pieces,
        l.table_length,
        l.is_confirmed,
        l.created_at,
        u.username AS created_by
      FROM cutting_lots l
      JOIN users u ON l.user_id = u.id
      WHERE l.user_id = ?
      ORDER BY l.created_at DESC
      LIMIT 25
      `,
      [userId]
    );

    // Fetch sizes for all lots in a single query to avoid N+1 problem
    const lotIds = cuttingLots.map((lot) => lot.id);
    let sizeMap = {};
    if (lotIds.length) {
      const [sizes] = await pool.query(
        `SELECT cutting_lot_id, size_label, pattern_count, total_pieces
         FROM cutting_lot_sizes
         WHERE cutting_lot_id IN (?)`,
        [lotIds]
      );
      sizes.forEach((s) => {
        if (!sizeMap[s.cutting_lot_id]) sizeMap[s.cutting_lot_id] = [];
        sizeMap[s.cutting_lot_id].push({
          size_label: s.size_label,
          pattern_count: s.pattern_count,
          total_pieces: s.total_pieces,
        });
      });
    }
    cuttingLots.forEach((lot) => {
      lot.sizes = sizeMap[lot.id] || [];
    });

    // Fetch department users (excluding cutting_manager)
    const [departmentUsers] = await pool.query(
      `
      SELECT u.id, u.username, r.name AS role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.name IN ('stitching_master', 'checking', 'washing', 'finishing', 'quality_assurance')
        AND u.is_active = TRUE
      ORDER BY r.name, u.username
    `
    );

    // Fetch pending assignments for this cutting manager
    const [pendingAssignments] = await pool.query(
      `
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
    `,
      [userId]
    );

    // Fetch rolls by fabric type
    const rollsByFabricType = await getRollsByFabricType();

    // Determine the cutter's flow type so the form renders in denim or hosiery mode.
    const [[cutterFlag]] = await pool.query(
      'SELECT is_denim_cutter FROM users WHERE id = ?',
      [userId]
    );
    const isDenim = !!(cutterFlag && cutterFlag.is_denim_cutter);

    const allowAdhoc = await allowAdhocCuttingEntry();

    // Pre-fill from a PM cut-plan assignment ("Start this lot" on Assigned Cuts).
    // Only an 'assigned' row that belongs to THIS master, and only a single ≤1500-piece
    // lot (the planner already caps lots at 1500; a bigger consolidated assignment must be
    // assigned per-lot from the PM screen). prefill stays null for a normal blank form.
    let prefill = null;
    const fromAssignment = parseInt(req.query.from_assignment, 10);
    if (fromAssignment) {
      try {
        const [[a]] = await pool.query(
          `SELECT id, style, fabric_type, total_pieces FROM pm_cut_assignment
            WHERE id = ? AND assigned_master_id = ? AND status = 'assigned'`,
          [fromAssignment, userId]
        );
        if (a) {
          const [sz] = await pool.query(
            `SELECT size_label, qty FROM pm_cut_assignment_sizes WHERE assignment_id = ? ORDER BY qty DESC`,
            [fromAssignment]
          );
          const totalTarget = sz.reduce((s, r) => s + (Number(r.qty) || 0), 0);
          // CAD consumption (per-piece kg — already includes nesting), plus width + GSM.
          // Lets the form predict pattern_count, marker length and fabric before cutting.
          const consumption = {};
          let width = null;
          let gsm = null;
          try {
            const [cons] = await pool.query(
              `SELECT size_label, consumption_per_piece, consumption_unit, width, gsm
                 FROM pm_style_consumption WHERE style = ?`,
              [a.style]
            );
            for (const c of cons) {
              consumption[String(c.size_label).toUpperCase()] = {
                kg: c.consumption_unit === 'KG' ? Number(c.consumption_per_piece) : null,
                unit: c.consumption_unit,
              };
              if (c.width != null) width = Number(c.width);
              if (c.gsm != null) gsm = Number(c.gsm);
            }
          } catch (_) { /* consumption optional; predictor just stays hidden */ }
          prefill = {
            id: a.id,
            style: a.style,
            fabric_type: a.fabric_type || '',
            sizes: sz.map((r) => ({ size_label: r.size_label, qty: Number(r.qty) || 0 })),
            total_target: totalTarget,
            over_cap: totalTarget > 1500, // flag: should have been assigned per-lot
            consumption, // { SIZE: {kg, unit} }
            width,       // inches
            gsm,         // g/m²
          };
        } else {
          req.flash('error', 'That assigned cut is not available to start (already cut, cancelled, or not yours).');
        }
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') console.error('[cutting-manager] prefill load error:', e.message);
      }
    }

    res.render('cuttingManagerDashboard', {
      user: req.session.user,
      cuttingLots,
      departmentUsers,
      pendingAssignments,
      rollsByFabricType, // Now includes vendor_name
      generatedLotNumber, // Pass the generated lot number
      isDenim,
      allowAdhoc,
      prefill,
    });
  } catch (err) {
    if (conn) {
      await conn.rollback();
      conn.release();
    }
    console.error('Error loading Cutting Manager Dashboard:', err);
    req.flash('error', 'Failed to load Cutting Manager Dashboard.');
    res.redirect('/');
  }
});

// POST /cutting-manager/create-lot
router.post(
  '/create-lot',
  isAuthenticated,
  isCuttingManager,
  upload.single('image'),
  async (req, res) => {
    const {
      lot_no,
      manual_lot_number,
      sku,
      fabric_type,
      remark,
      table_length,
      flow_type,
      manual_cutting_date,
      size_label,
      pattern_count,
      roll_no,
      layers,
      weight_used,
      roll_full_weight,
      roll_remaining_weight,
      assignment_id, // set when this lot is started from a PM cut-plan assignment
    } = req.body;
    const image = req.file;

    // AJAX submits (the form's fetch handler) get JSON so a validation error never
    // navigates away and wipes the user's typed data. Plain POSTs keep flash+redirect.
    const isAjax = req.get('X-Requested-With') === 'XMLHttpRequest';
    const fail = (msg) => {
      if (isAjax) return res.json({ ok: false, error: msg });
      req.flash('error', msg);
      return res.redirect('/cutting-manager/dashboard');
    };

    // Input validation
    if (!lot_no || !sku || !fabric_type || !manual_lot_number || !manual_lot_number.trim()) {
      return fail('Lot No., SKU, Fabric Type and Manual Lot Number are required.');
    }

    try {
      const userId = req.session.user.id;
      const username = req.session.user.username;

      // Start a transaction
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Determine flow_type: honour the cutter's explicit selection on the form
        // ('denim' or 'hosiery'), otherwise fall back to the is_denim_cutter default.
        // Safe to set here because no stage events exist yet at lot creation.
        const [[cutter]] = await conn.query(
          'SELECT is_denim_cutter FROM users WHERE id = ?',
          [userId]
        );
        const defaultFlowType = cutter && cutter.is_denim_cutter ? 'denim' : 'hosiery';
        const flowType = (flow_type === 'denim' || flow_type === 'hosiery')
          ? flow_type
          : defaultFlowType;

        // Enforce ad-hoc cutting entry switch
        const allowAdhoc = await allowAdhocCuttingEntry();
        if (!allowAdhoc) {
          const [knownTypeRows] = await conn.query(
            'SELECT DISTINCT fabric_type FROM fabric_invoices WHERE fabric_type IS NOT NULL'
          );
          if (!isKnownFabricType(fabric_type, knownTypeRows.map((r) => r.fabric_type))) {
            throw new Error(`Fabric type "${fabric_type}" is not in the fabric database. Ad-hoc entry is disabled.`);
          }
        }

        // Insert the new cutting lot with total_pieces = 0
        const [result] = await conn.query(
          `
          INSERT INTO cutting_lots
            (lot_no, manual_lot_number, sku, fabric_type, remark, table_length, manual_cutting_date, image_url, user_id, total_pieces, flow_type)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `,
          [
            lot_no,
            manual_lot_number.trim(),
            sku,
            fabric_type,
            remark || null,
            table_length ? parseFloat(table_length) : null,
            (manual_cutting_date && String(manual_cutting_date).trim()) ? String(manual_cutting_date).trim() : null,
            image ? image.path : null,
            userId,
            flowType,
          ]
        );

        const cuttingLotId = result.insertId;

        // Handle sizes if provided (using parseFloat for decimal values)
        let sizes = [];
        if (Array.isArray(size_label) && Array.isArray(pattern_count)) {
          for (let i = 0; i < size_label.length; i++) {
            if (size_label[i] && pattern_count[i]) {
              sizes.push({
                size_label: size_label[i],
                pattern_count: parseFloat(pattern_count[i]),
              });
            }
          }
        } else if (size_label && pattern_count) {
          sizes.push({
            size_label: size_label,
            pattern_count: parseFloat(pattern_count),
          });
        }

        // Insert sizes in bulk to reduce round trips
        const sizeRows = sizes
          .filter((s) => s.size_label && !isNaN(s.pattern_count) && s.pattern_count > 0)
          .map((s) => [cuttingLotId, s.size_label, s.pattern_count]);
        if (sizeRows.length) {
          const placeholders = sizeRows.map(() => '(?, ?, ?, 0, NOW())').join(',');
          await conn.query(
            `INSERT INTO cutting_lot_sizes (cutting_lot_id, size_label, pattern_count, total_pieces, created_at)
             VALUES ${placeholders}`,
            sizeRows.flat()
          );
        }

        // Handle Rolls Used if provided (using parseFloat so decimals are preserved)
        let rolls = [];
        if (
          Array.isArray(roll_no) &&
          Array.isArray(layers) &&
          Array.isArray(roll_full_weight) &&
          Array.isArray(roll_remaining_weight)
        ) {
          for (let i = 0; i < roll_no.length; i++) {
            if (roll_no[i] && layers[i] && roll_full_weight[i] && roll_remaining_weight[i]) {
              rolls.push({
                roll_no: roll_no[i],
                layers: parseFloat(layers[i]),
                weight_used: Array.isArray(weight_used) ? parseFloat(weight_used[i]) : null,
                full_weight: parseFloat(roll_full_weight[i]),
                remaining_weight: parseFloat(roll_remaining_weight[i]),
              });
            }
          }
        } else if (roll_no && layers && roll_full_weight && roll_remaining_weight) {
          rolls.push({
            roll_no: roll_no,
            layers: parseFloat(layers),
            weight_used: weight_used ? parseFloat(weight_used) : null,
            full_weight: parseFloat(roll_full_weight),
            remaining_weight: parseFloat(roll_remaining_weight),
          });
        }

        // Insert rolls and update fabric weights
        const rollRowsClean = rolls.filter(
          (r) =>
            r.roll_no &&
            !isNaN(r.layers) &&
            !isNaN(r.full_weight) &&
            !isNaN(r.remaining_weight)
        );
        if (rollRowsClean.length) {
          const rollNos = rollRowsClean.map((r) => r.roll_no);
          const [fabricRolls] = await conn.query(
            `SELECT roll_no, per_roll_weight
             FROM fabric_invoice_rolls
             WHERE roll_no IN (?) FOR UPDATE`,
            [rollNos]
          );
          const fabricRollMap = new Map(fabricRolls.map((row) => [row.roll_no, row.per_roll_weight]));

          const placeholders = rollRowsClean
            .map(() => '(?, ?, ?, ?, 0, ?, ?, NOW())')
            .join(',');
          const flat = [];

          for (let r of rollRowsClean) {
            if (fabricRollMap.has(r.roll_no)) {
              const availableWeight = parseFloat(fabricRollMap.get(r.roll_no)) || 0;
              if (isNaN(r.remaining_weight)) {
                throw new Error(`Remaining weight is required for roll ${r.roll_no}`);
              }
              if (r.remaining_weight > availableWeight) {
                throw new Error(`Remaining weight cannot exceed full weight for roll ${r.roll_no}`);
              }
              r.full_weight = availableWeight;
              r.weight_used = r.full_weight - r.remaining_weight;
              if (r.weight_used < 0) {
                throw new Error(`Weight used cannot be negative for roll ${r.roll_no}`);
              }
              const [update] = await conn.query(
                `UPDATE fabric_invoice_rolls
                   SET per_roll_weight = per_roll_weight - ?
                 WHERE roll_no = ? AND per_roll_weight >= ?`,
                [r.weight_used, r.roll_no, r.weight_used]
              );
              if (update.affectedRows === 0) {
                throw new Error(`Insufficient weight or invalid roll ${r.roll_no}`);
              }
            } else {
              if (!allowAdhoc) {
                throw new Error(`Roll ${r.roll_no} is not in fabric inventory. Ad-hoc entry is disabled.`);
              }
              if (isNaN(r.full_weight) || isNaN(r.remaining_weight)) {
                throw new Error(`Full and remaining weights are required for roll ${r.roll_no}`);
              }
              if (r.remaining_weight > r.full_weight) {
                throw new Error(`Remaining weight cannot exceed full weight for roll ${r.roll_no}`);
              }
              r.weight_used = r.full_weight - r.remaining_weight;
              if (r.weight_used < 0) {
                throw new Error(`Weight used cannot be negative for roll ${r.roll_no}`);
              }
            }

            flat.push(
              cuttingLotId,
              r.roll_no,
              r.weight_used,
              r.layers,
              r.full_weight,
              r.remaining_weight
            );
          }

          await conn.query(
            `INSERT INTO cutting_lot_rolls (cutting_lot_id, roll_no, weight_used, layers, total_pieces, full_weight, remaining_weight, created_at)
             VALUES ${placeholders}`,
            flat
          );
        }

        // Calculate total pieces using aggregate queries
        const [[{ sumPatterns = 0 }]] = await conn.query(
          'SELECT SUM(pattern_count) AS sumPatterns FROM cutting_lot_sizes WHERE cutting_lot_id = ?',
          [cuttingLotId]
        );
        const [[{ totalLayers = 0 }]] = await conn.query(
          'SELECT SUM(layers) AS totalLayers FROM cutting_lot_rolls WHERE cutting_lot_id = ?',
          [cuttingLotId]
        );

        const totalPieces = (sumPatterns || 0) * (totalLayers || 0);

        await conn.query('UPDATE cutting_lots SET total_pieces = ? WHERE id = ?', [totalPieces, cuttingLotId]);
        await conn.query(
          'UPDATE cutting_lot_sizes SET total_pieces = pattern_count * ? WHERE cutting_lot_id = ?',
          [totalLayers, cuttingLotId]
        );
        // Calculate total_pieces for each roll: roll.layers * sumPatterns
        await conn.query(
          'UPDATE cutting_lot_rolls SET total_pieces = layers * ? WHERE cutting_lot_id = ?',
          [sumPatterns, cuttingLotId]
        );

        // If this lot was started from a PM cut-plan assignment, link it back and close
        // the loop: the assignment now points at the real lot and moves 'assigned' → 'cut',
        // so it stops showing as "to cut" and the PM's suggestion nets it. Guarded to this
        // master + still-'assigned' so a stale/duplicate submit can't relink a done row.
        const assignmentIdNum = parseInt(assignment_id, 10);
        if (assignmentIdNum) {
          await conn.query(
            `UPDATE pm_cut_assignment
                SET cutting_lot_id = ?, status = 'cut', updated_at = NOW()
              WHERE id = ? AND assigned_master_id = ? AND status = 'assigned'`,
            [cuttingLotId, assignmentIdNum, userId]
          );
        }

        await conn.commit();
        conn.release();

        req.flash(
          'success',
          `Cutting Lot ${lot_no} created successfully with Total Pieces: ${totalPieces}.`
        );
        if (isAjax) return res.json({ ok: true, redirect: '/cutting-manager/dashboard' });
        res.redirect('/cutting-manager/dashboard');
      } catch (err2) {
        await conn.rollback();
        conn.release();
        console.error('Error creating Cutting Lot:', err2);
        return fail(err2.message || 'Failed to create Cutting Lot.');
      }
    } catch (err) {
      console.error('Database Connection Error:', err);
      return fail('Database connection failed.');
    }
  }
);

// GET /cutting-manager/generate-challan/:lotId
router.get('/generate-challan/:lotId', isAuthenticated, isCuttingManager, async (req, res) => {
  const lotId = req.params.lotId;

  try {
    // Fetch lot details, sizes, and rolls concurrently
    const [[lotRows], [sizes], [rolls]] = await Promise.all([
      pool.query(
        `SELECT l.lot_no, l.sku, l.fabric_type, l.remark, l.table_length, l.total_pieces, u.username AS created_by, l.created_at
         FROM cutting_lots l
         JOIN users u ON l.user_id = u.id
         WHERE l.id = ?`,
        [lotId]
      ),
      pool.query(
        `SELECT size_label, pattern_count, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?`,
        [lotId]
      ),
      pool.query(
        `SELECT roll_no, weight_used, layers, total_pieces FROM cutting_lot_rolls WHERE cutting_lot_id = ?`,
        [lotId]
      ),
    ]);

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
    doc.text(`Table Length: ${lot.table_length ?? 'N/A'}`);
    doc.text(`Total Pieces: ${lot.total_pieces}`);
    doc.text(`Created By: ${lot.created_by}`);
    doc.text(`Created At: ${new Date(lot.created_at).toLocaleString()}`);
    doc.moveDown();

    if (lot.remark) {
      doc.text(`Remark: ${lot.remark}`);
      doc.moveDown();
    }

    if (sizes.length > 0) {
      doc.fontSize(14).text('Sizes and Patterns', { underline: true });
      doc.moveDown();

      sizes.forEach((size) => {
        doc.fontSize(12).text(`Size: ${size.size_label}, Patterns: ${size.pattern_count}, Total Pieces: ${size.total_pieces}`);
      });
      doc.moveDown();
    }

    if (rolls.length > 0) {
      doc.fontSize(14).text('Rolls Used', { underline: true });
      doc.moveDown();

      rolls.forEach((roll) => {
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
    // Fetch lot, sizes and rolls concurrently
    const [[lotRows], [sizes], [rolls]] = await Promise.all([
      pool.query(
        `SELECT l.id, l.lot_no, l.manual_lot_number, l.sku, l.fabric_type, l.remark, l.table_length, l.image_url, l.total_pieces, l.is_confirmed, l.created_at, u.username AS created_by
         FROM cutting_lots l
         JOIN users u ON l.user_id = u.id
         WHERE l.id = ?`,
        [lotId]
      ),
      pool.query(
        'SELECT size_label, pattern_count, total_pieces FROM cutting_lot_sizes WHERE cutting_lot_id = ?',
        [lotId]
      ),
      pool.query(
        'SELECT roll_no, weight_used, layers, total_pieces FROM cutting_lot_rolls WHERE cutting_lot_id = ?',
        [lotId]
      ),
    ]);

    if (lotRows.length === 0) {
      req.flash('error', 'Cutting Lot not found.');
      return res.redirect('/cutting-manager/dashboard');
    }

    const lot = lotRows[0];

    res.render('lotDetails', {
      user: req.session.user,
      lot,
      sizes,
      rolls,
    });
  } catch (err) {
    console.error('Error loading Lot Details:', err);
    req.flash('error', 'Failed to load Lot Details.');
    res.redirect('/cutting-manager/dashboard');
  }
});

/* ------------------------------------------------------------------
   NEW CODE for "Assign to Stitching" BELOW
   ------------------------------------------------------------------ */

/**
 * GET /cutting-manager/assign-stitching
 * Render the new page that shows lots not yet assigned to stitching.
 */
router.get('/assign-stitching', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    return res.render('assignStitching', {
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    console.error('Error rendering assign-stitching page:', err);
    req.flash('error', 'Failed to load Assign to Stitching page.');
    return res.redirect('/cutting-manager/dashboard');
  }
});

/**
 * GET /cutting-manager/assign-stitching/lots
 * Returns JSON of unassigned lots (for the cutting master).
 */
router.get('/assign-stitching/lots', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const cuttingMasterId = req.session.user.id;
    const [rows] = await pool.query(
      `
      SELECT 
        c.id AS cutting_lot_id,
        c.lot_no,
        c.sku,
        c.remark,
        c.created_at
      FROM cutting_lots c
      WHERE c.user_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM stitching_assignments s WHERE s.cutting_lot_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM stitching_events se
           WHERE se.cutting_lot_id = c.id AND se.event_type='approve'
        )
      ORDER BY c.created_at DESC
    `,
      [cuttingMasterId]
    );

    return res.json({ lots: rows });
  } catch (error) {
    console.error('Error fetching unassigned lots:', error);
    return res.status(500).json({ error: 'Server error fetching lots.' });
  }
});

/**
 * GET /cutting-manager/assign-stitching/users
 * Returns JSON of all stitching users
 */
router.get('/assign-stitching/users', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const [users] = await pool.query(
      `
      SELECT id, username
      FROM users
      WHERE is_active = 1
        AND role_id IN (SELECT id FROM roles WHERE name = 'stitching_master')
      ORDER BY username
    `
    );
    return res.json({ users });
  } catch (error) {
    console.error('Error fetching stitching users:', error);
    return res.status(500).json({ error: 'Server error fetching users.' });
  }
});

/**
 * POST /cutting-manager/assign-stitching
 * AJAX request to assign a lot to a specific stitching user.
 */
router.post('/assign-stitching', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const { cutting_lot_id, user_id } = req.body;
    if (!cutting_lot_id || !user_id) {
      return res.status(400).json({ error: 'Missing cutting_lot_id or user_id' });
    }

    // Double-check that this lot belongs to the current cutting manager
    const [checkRows] = await pool.query(
      `
      SELECT id FROM cutting_lots 
      WHERE id = ? AND user_id = ?
      LIMIT 1
    `,
      [cutting_lot_id, req.session.user.id]
    );
    if (checkRows.length === 0) {
      return res.status(403).json({ error: 'You do not own this lot or it does not exist.' });
    }

    // Insert into stitching_assignments
    await pool.query(
      `
      INSERT INTO stitching_assignments
        (assigner_cutting_master, user_id, cutting_lot_id, assigned_on)
      VALUES
        (?, ?, ?, NOW())
    `,
      [req.session.user.id, user_id, cutting_lot_id]
    );

    return res.json({ success: true, message: 'Lot successfully assigned to stitching user.' });
  } catch (error) {
    console.error('Error assigning lot to stitching:', error);
    return res.status(500).json({ error: 'Server error assigning lot.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SKU CATEGORIES API
// ═══════════════════════════════════════════════════════════════════════════

// GET /cutting-manager/api/sku-categories - List all categories
router.get('/api/sku-categories', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT id, name FROM sku_categories ORDER BY name');
    return res.json({ success: true, categories });
  } catch (error) {
    console.error('Error loading SKU categories:', error);
    return res.status(500).json({ error: 'Failed to load categories' });
  }
});

// POST /cutting-manager/api/sku-categories - Add new category
router.post('/api/sku-categories', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    const catName = name.trim().toUpperCase();
    await pool.query('INSERT INTO sku_categories (name) VALUES (?)', [catName]);
    return res.json({ success: true, message: 'Category added' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Category already exists' });
    }
    console.error('Error adding SKU category:', error);
    return res.status(500).json({ error: 'Failed to add category' });
  }
});

// GET /cutting-manager/api/sku-brands - List active brand codes (feeds the SKU builder,
// same sku_brand_codes list the PO Creator uses).
router.get('/api/sku-brands', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const [brands] = await pool.query(
      'SELECT id, code FROM sku_brand_codes WHERE is_active = 1 ORDER BY code');
    return res.json({ success: true, brands });
  } catch (error) {
    console.error('Error loading SKU brands:', error);
    return res.status(500).json({ error: 'Failed to load brands' });
  }
});

// POST /cutting-manager/api/sku-brands - Add a new brand code.
router.post('/api/sku-brands', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Brand code is required' });
    }
    const brandCode = code.trim().toUpperCase();
    await pool.query('INSERT INTO sku_brand_codes (code) VALUES (?)', [brandCode]);
    return res.json({ success: true, message: 'Brand added' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Brand already exists' });
    }
    console.error('Error adding SKU brand:', error);
    return res.status(500).json({ error: 'Failed to add brand' });
  }
});

// GET /cutting-manager/assigned-cuts — cuts the PM has approved and assigned to THIS master.
// Shows what to cut (per size) + suggested lots + fabric; links to the lot once cut.
router.get('/assigned-cuts', isAuthenticated, isCuttingManager, async (req, res) => {
  try {
    const masterId = req.session.user.id;
    let assignments = [];
    try {
      const [rows] = await pool.query(
        `SELECT a.id, a.style, a.fabric_type, a.total_pieces, a.lot_count, a.total_fabric_meters,
                a.fabric_complete, a.status, a.cutting_lot_id, a.note, a.created_at,
                cl.lot_no,
                (SELECT c.consumption_unit FROM pm_style_consumption c WHERE c.style = a.style LIMIT 1) AS fabric_unit
           FROM pm_cut_assignment a
      LEFT JOIN cutting_lots cl ON cl.id = a.cutting_lot_id
          WHERE a.assigned_master_id = ? AND a.status <> 'cancelled'
       ORDER BY (a.status = 'assigned') DESC, a.created_at DESC
          LIMIT 100`,
        [masterId]
      );
      assignments = rows;
      if (assignments.length) {
        const ids = assignments.map((a) => a.id);
        const [sizeRows] = await pool.query(
          `SELECT assignment_id, size_label, qty FROM pm_cut_assignment_sizes
            WHERE assignment_id IN (?) ORDER BY qty DESC`,
          [ids]
        );
        const byId = {};
        for (const s of sizeRows) (byId[s.assignment_id] = byId[s.assignment_id] || []).push(s);
        assignments.forEach((a) => { a.sizes = byId[a.id] || []; });
      }
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e; // table not migrated yet -> empty list
    }
    res.render('assignedCuts', { user: req.session.user, assignments });
  } catch (err) {
    console.error('GET /cutting-manager/assigned-cuts error:', err);
    res.status(500).send('Failed to load assigned cuts');
  }
});

module.exports = router;
