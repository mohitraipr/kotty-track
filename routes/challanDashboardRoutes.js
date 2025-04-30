// routes/challanDashboardRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

// Fiscal year for DC numbers
const FISCAL_YEAR = '25-26'; // e.g. DC/25-26/1

// Hard-coded user IDs
const washers = [49, 62, 59, 56, 57, 58, 60, 54, 64, 61];
const jeansAssembly = [44, 13];

// Washer short-codes for Challan Number (two words => pick each initial)
const WASHER_SHORT_CODES = {
  49: 'AW', // ADS WASHER
  62: 'MW', // MEENA TRADING
  59: 'MT', // MAA TARA
  56: 'VW', // VAISHNAVI WASHING
  57: 'SB', // SHREE BALA JI WASHING
  58: 'PE', // PRITY ENTERPRISES
  60: 'SG', // SHREE GANESH DYEING
  54: 'RE', // RAJ ENTERPRISES
  64: 'AE', // ANSHIK ENTERPRISES
  61: 'HP', // H.P GARMENTS
};

// ----------------- HELPER FUNCTION: getNextChallanCounter ----------------- //
async function getNextChallanCounter(washerId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query(
      `
      SELECT id, current_counter
        FROM washer_challan_counters
       WHERE washer_id = ? AND year_range = ?
       FOR UPDATE
    `,
      [washerId, FISCAL_YEAR]
    );

    let newCounter = 1;
    if (rows.length === 0) {
      await connection.query(
        `
        INSERT INTO washer_challan_counters (washer_id, year_range, current_counter)
        VALUES (?, ?, 1)
      `,
        [washerId, FISCAL_YEAR]
      );
    } else {
      newCounter = rows[0].current_counter + 1;
      await connection.query(
        `
        UPDATE washer_challan_counters
           SET current_counter = ?
         WHERE id = ?
      `,
        [newCounter, rows[0].id]
      );
    }

    await connection.commit();
    connection.release();
    return newCounter;
  } catch (err) {
    await connection.rollback();
    connection.release();
    throw err;
  }
}

// ---------- HELPER: Exclude used lots in the main listing ---------- //
const EXCLUDE_USED_LOTS_CLAUSE = `
  NOT EXISTS (
    SELECT 1
      FROM challan ch
     WHERE JSON_SEARCH(ch.items, 'one', CAST(wa.id AS CHAR), NULL, '$[*].washing_id') IS NOT NULL
  )
`;

// ================ GET /challandashboard (Main Dashboard) =================== //
router.get('/', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Only jeansAssembly can see this dashboard:
    if (!jeansAssembly.includes(userId)) {
      req.flash('error', 'You are not authorized to view the challan dashboard.');
      return res.redirect('/');
    }

    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;

    // Important: we only show wa.is_approved=1
    const [assignments] = await pool.query(
      `
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
      WHERE ${EXCLUDE_USED_LOTS_CLAUSE}
        AND wa.is_approved = 1
      ORDER BY wa.assigned_on DESC
      LIMIT ? OFFSET ?
    `,
      [limit, offset]
    );

    res.render('challanDashboard', {
      assignments,
      search: '',
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard:', error);
    req.flash('error', 'Could not load dashboard data');
    res.redirect('/');
  }
});

// ================ GET /challandashboard/search (Comma-Separated) =========== //
router.get('/search', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Only jeansAssembly can search
    if (!jeansAssembly.includes(userId)) {
      return res.status(403).json({ error: 'Not authorized to search challans' });
    }

    const searchQuery = (req.query.search || '').trim();
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;

    let baseQuery = `
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
      WHERE ${EXCLUDE_USED_LOTS_CLAUSE}
        AND wa.is_approved = 1
    `;
    const params = [];

    // If there's a comma-separated list of terms
    if (searchQuery.includes(',')) {
      const terms = searchQuery
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (!terms.length) {
        return res.json({ assignments: [] });
      }
      const conditions = [];
      for (const term of terms) {
        const likeTerm = `%${term}%`;
        conditions.push('(jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)');
        params.push(likeTerm, likeTerm, likeTerm);
      }
      baseQuery += ` AND (${conditions.join(' OR ')}) `;
    } else if (searchQuery) {
      const likeStr = `%${searchQuery}%`;
      baseQuery += ` AND (jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?) `;
      params.push(likeStr, likeStr, likeStr);
    }

    baseQuery += `
      ORDER BY wa.assigned_on DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const [assignments] = await pool.query(baseQuery, params);
    return res.json({ assignments });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard/search:', error);
    return res.status(500).json({ error: error.message });
  }
});

// =========== POST /challandashboard/generate (Render Form) ================ //
router.post('/generate', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;

    // Only jeansAssembly can generate challans
    if (!jeansAssembly.includes(userId)) {
      req.flash('error', 'You are not authorized to generate challans.');
      return res.redirect('/');
    }

    const selectedRows = JSON.parse(req.body.selectedRows || '[]');
    if (!selectedRows.length) {
      req.flash('error', 'No items selected for challan generation');
      return res.redirect('/challandashboard');
    }

    // Retrieve washers from DB or your array
    const [washerRows] = await pool.query(
      `
      SELECT id, username 
        FROM users
       WHERE id IN (?)
       ORDER BY username ASC
    `,
      [washers]
    );

    res.render('challanGeneration', {
      selectedRows,
      washers: washerRows,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (error) {
    console.error('[ERROR] POST /challandashboard/generate:', error);
    req.flash('error', 'Error generating challan form');
    res.redirect('/challandashboard');
  }
});

// ========== POST /challandashboard/create (Insert a New Challan) ========== //
router.post('/create', isAuthenticated, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const userId = req.session.user.id;

    // Only jeansAssembly can create challans
    if (!jeansAssembly.includes(userId)) {
      req.flash('error', 'You are not authorized to create challans.');
      connection.release();
      return res.redirect('/');
    }

    const { challanDate, washerId, selectedRows } = req.body;
    const items = JSON.parse(selectedRows || '[]');

    if (!items.length) {
      req.flash('error', 'No items selected for challan');
      connection.release();
      return res.redirect('/challandashboard');
    }

    // 1) Validate the chosen washer is from washers array
    const washerIDNum = parseInt(washerId, 10);
    if (!washers.includes(washerIDNum)) {
      req.flash('error', 'Invalid or unknown washer selected');
      connection.release();
      return res.redirect('/challandashboard');
    }

    // 2) Ensure each washing_id is "approved" (wa.is_approved=1)
    // Gather the washing_ids
    const washingIds = items.map((i) => parseInt(i.washing_id, 10));
    if (!washingIds.length) {
      req.flash('error', 'No valid washing items found');
      connection.release();
      return res.redirect('/challandashboard');
    }

    // Check if any is not is_approved=1
    const [checkApproved] = await connection.query(
      `
      SELECT COUNT(*) AS total
        FROM washing_assignments
       WHERE id IN (?)
         AND is_approved = 1
    `,
      [washingIds]
    );

    // Compare the count
    if (checkApproved.length && checkApproved[0].total !== washingIds.length) {
      req.flash(
        'error',
        'Cannot create challan; some selected lots are not approved or don’t exist.'
      );
      connection.release();
      return res.redirect('/challandashboard');
    }

    // 3) Check if any items are already used
    for (const item of items) {
      const washingId = parseInt(item.washing_id, 10);
      const [used] = await connection.query(
        `
        SELECT id
          FROM challan
         WHERE JSON_SEARCH(items, 'one', CAST(? AS CHAR), NULL, '$[*].washing_id') IS NOT NULL
         LIMIT 1
      `,
        [washingId]
      );
      if (used.length > 0) {
        req.flash('error', `Lot with washing_id=${washingId} is already in challan #${used[0].id}`);
        connection.release();
        return res.redirect('/challandashboard');
      }
    }

    // Hardcoded sender details
    const sender = {
      name: "KOTTY LIFESTYLE PRIVATE LIMITED",
      address: "GB-65, BHARAT VIHAR, LAKKARPUR, FARIDABAD, HARYANA, Haryana 121009",
      gstin: "06AAGCK0951K1ZH",
      state: "06-Haryana",
      pan: "AAGCK0951K"
    };

    // Hardcoded washers -> placeOfSupply references
    const consigneeMapping = {
      49: {
        name: "SHREE SAI DYE CHEM",
        gstin: "07ABYPC7271N1ZV",
        address: "115/B, MAIN SINDHU FARM ROAD, MEETHAPUR EXTN. BADARPUR, NEAR DURGA BUILDER GATE, South Delhi, Delhi, 110044",
        placeOfSupply: "07-DELHI"
      },
      62: {
        name: "MEENA TRADING WASHER",
        gstin: "09DERPG5827R1ZF",
        address: "Ground Floor, S 113, Harsha Compound, Loni Road Industrial Area, Mohan Nagar, Ghaziabad, Uttar Pradesh, 201003",
        placeOfSupply: "09-UTTAR PRADESH"
      },
      59: {
        name: "MAA TARA ENTERPRISES",
        gstin: "07AMLPM6699N1ZX",
        address: "G/F, B/P R/S, B-200, Main Sindhu Farm Road, Meethapur Extension, New Delhi, South East Delhi, Delhi, 110044",
        placeOfSupply: "07-DELHI"
      },
      56: {
        name: "VAISHNAVI WASHING",
        gstin: "09BTJPM9580J1ZU",
        address: "VILL-ASGARPUR, SEC-126, NOIDA, UTTAR PRADESH, Gautambuddha Nagar, Uttar Pradesh, 201301",
        placeOfSupply: "09-UTTAR PRADESH"
      },
      57: {
        name: "SHREE BALA JI WASHING",
        gstin: "07ARNPP7012K1ZF",
        address: "KH NO.490/1/2/3, VILLAGE MOLARBAND, NEAR SAPERA BASTI, BADARPUR, South Delhi, Delhi, 110044",
        placeOfSupply: "07-DELHI"
      },
      58: {
        name: "PREETI ENTERPRISES",
        gstin: "07BTMPC8553Q1ZW",
        address: "E-7 KH.285, PL-407 T.NO. A0841, GALI-1, New Delhi, South East Delhi, Delhi, 110076",
        placeOfSupply: "07-DELHI"
      },
      60: {
        name: "SHREE GANESH DYEING",
        gstin: "06AHPPC4743G1ZE",
        address: "2/2,6-2, KITA 2, AREA 7, KILLLA NO. 1/2/2, SIDHOLA, TIGAON, Faridabad, Haryana, 121101",
        placeOfSupply: "06-HARYANA"
      },
      54: {
        name: "RAJ ENTERPRISES",
        gstin: "07KWWPS3671F1ZL",
        address: "H No-199J Gali no-6, Block - A, Numbardar Colony Meethapur, Badarpur, New Delhi, South East Delhi, Delhi, 110044",
        placeOfSupply: "07-DELHI"
      },
      64: {
        name: "ANSHIK ENTERPRISES",
        gstin: "09BGBPC8487K1ZX",
        address: "00, Sultanpur, Main Rasta, Near J P Hospital, Noida, Gautambuddha Nagar, Uttar Pradesh, 201304",
        placeOfSupply: "09-UTTAR PRADESH"
      },
      61: {
        name: "H.P GARMENTS",
        gstin: "06CVKPS2554J1Z4",
        address: "PLOT NO-5, NANGLA GAJI PUR ROAD, NEAR ANTRAM CHOWK, Nangla Gujran, Faridabad, Haryana, 121005",
        placeOfSupply: "06-HARYANA"
      },
    };

    const consignee = consigneeMapping[washerIDNum];
    if (!consignee || !consignee.placeOfSupply) {
      req.flash('error', 'Invalid consignee details or missing Place of Supply');
      connection.release();
      return res.redirect('/challandashboard');
    }

    // Basic rate logic (dummy, can adjust)
    const ratePerItem = 200;
    items.forEach((item) => {
      item.hsnSac = "62034200";
      item.rate = ratePerItem;
      item.discount = 0;
      item.taxableValue = parseInt(item.total_pieces, 10) * ratePerItem;
      item.quantityFormatted = item.total_pieces + " PCS";
    });
    const totalTaxableValue = items.reduce((sum, it) => sum + it.taxableValue, 0);
    const totalAmount = totalTaxableValue;

    // Next challan counter for that washer
    const nextCounter = await getNextChallanCounter(washerIDNum);

    // Use short code for the new DC number
    const shortCode = WASHER_SHORT_CODES[washerIDNum] || 'XX';
    const challanNo = `DC/${shortCode}/${FISCAL_YEAR}/${nextCounter}`;

    // Insert the new Challan
    const insertQuery = `
      INSERT INTO challan
        (challan_date, challan_no, reference_no, challan_type,
         sender_name, sender_address, sender_gstin, sender_state, sender_pan,
         consignee_id, consignee_name, consignee_gstin, consignee_address, place_of_supply,
         items, total_taxable_value, total_amount, total_amount_in_words)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [result] = await connection.query(insertQuery, [
      challanDate,
      challanNo,
      "", // reference_no
      "JOB WORK",
      sender.name,
      sender.address,
      sender.gstin,
      sender.state,
      sender.pan,
      washerIDNum,
      consignee.name,
      consignee.gstin,
      consignee.address,
      consignee.placeOfSupply,
      JSON.stringify(items),
      totalTaxableValue,
      totalAmount,
      `${totalAmount.toLocaleString('en-IN')} Rupees Only`
    ]);

    const newChallanId = result.insertId;
    connection.release();
    return res.redirect(`/challandashboard/view/${newChallanId}`);
  } catch (error) {
    console.error('[ERROR] POST /challandashboard/create:', error);
    connection.release();
    req.flash('error', 'Error creating challan');
    res.redirect('/challandashboard');
  }
});

// ========== GET /challandashboard/view/:challanId (View a saved Challan) === //
router.get('/view/:challanId', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const challanId = parseInt(req.params.challanId, 10);

    const [rows] = await pool.query(
      `
      SELECT *
        FROM challan
       WHERE id = ?
    `,
      [challanId]
    );

    if (!rows.length) {
      req.flash('error', 'Challan not found');
      return res.redirect('/challandashboard');
    }

    const challanRow = rows[0];

    // Access logic:
    // - jeansAssembly => can view any challan
    // - washers => can view only if challanRow.consignee_id = userId
    // - others => block
    if (jeansAssembly.includes(userId)) {
      // Allowed
    } else if (washers.includes(userId)) {
      if (challanRow.consignee_id !== userId) {
        req.flash('error', 'Not authorized to view this challan.');
        return res.redirect('/');
      }
    } else {
      req.flash('error', 'Not authorized to view this challan.');
      return res.redirect('/');
    }

    let parsedItems;
    try {
      if (typeof challanRow.items === 'string') {
        parsedItems = JSON.parse(challanRow.items);
      } else {
        parsedItems = challanRow.items;
      }
    } catch (err) {
      console.error('Invalid JSON in challan items:', challanRow.items);
      req.flash('error', 'Invalid JSON in challan items');
      return res.redirect('/challandashboard');
    }

    const challanData = {
      sender: {
        name: challanRow.sender_name,
        address: challanRow.sender_address,
        gstin: challanRow.sender_gstin,
        state: challanRow.sender_state,
        pan: challanRow.sender_pan
      },
      challanDate: challanRow.challan_date,
      challanNo: challanRow.challan_no,
      referenceNo: challanRow.reference_no || '',
      challanType: challanRow.challan_type,
      consignee: {
        name: challanRow.consignee_name,
        gstin: challanRow.consignee_gstin,
        address: challanRow.consignee_address,
        placeOfSupply: challanRow.place_of_supply
      },
      items: parsedItems,
      totalTaxableValue: challanRow.total_taxable_value,
      totalAmount: challanRow.total_amount,
      totalAmountInWords: challanRow.total_amount_in_words
    };

    // Reuse the same EJS for washers or jeansAssembly
    res.render('challanCreation', { challan: challanData });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard/view:', error);
    req.flash('error', 'Error loading challan');
    res.redirect('/challandashboard');
  }
});

// ================ GET /challanlist (Washer vs. JeansAssembly) ============= //
router.get('/challanlist', isAuthenticated, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const search = (req.query.search || '').trim();

    let sql = 'SELECT * FROM challan ';
    const params = [];

    // washers => only see challans with consignee_id = userId
    // jeansAssembly => see all
    // others => block
    if (washers.includes(userId)) {
      sql += 'WHERE consignee_id = ? ';
      params.push(userId);
    } else if (jeansAssembly.includes(userId)) {
      sql += 'WHERE 1=1 ';
    } else {
      req.flash('error', 'Not authorized to view challan list');
      return res.redirect('/');
    }

    // optional search
    if (search) {
      sql += `
        AND (
          challan_no LIKE ?
          OR JSON_SEARCH(items, 'one', ?, NULL, '$[*].lot_no') IS NOT NULL
        )
      `;
      const like = `%${search}%`;
      params.push(like, search);
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);

    res.render('challanList', {
      challans: rows,
      search,
      error: req.flash('error'),
      success: req.flash('success'),
    });
  } catch (err) {
    console.error('[ERROR] GET /challanlist:', err);
    req.flash('error', 'Could not load challan list');
    res.redirect('/');
  }
});

module.exports = router;
