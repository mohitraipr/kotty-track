const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

// GET /challandashboard - Main dashboard with pagination
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
    
    res.render('challanDashboard', {
      assignments,
      search: '',
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (error) {
    console.error('[ERROR] GET /challandashboard:', error);
    req.flash('error', 'Could not load dashboard data');
    res.redirect('/');
  }
});

// GET /challandashboard/search - Search endpoint
router.get('/search', isAuthenticated, async (req, res) => {
  try {
    const searchQuery = req.query.search ? req.query.search.trim() : '';
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;

    if (searchQuery.includes(',')) {
      // Handle comma-separated search terms
      const terms = searchQuery.split(',')
        .map(term => term.trim())
        .filter(term => term !== '');
      
      if (terms.length === 0) {
        return res.json({ assignments: [] });
      }

      const conditions = [];
      const params = [];
      
      terms.forEach(term => {
        const likeTerm = `%${term}%`;
        conditions.push('(jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)');
        params.push(likeTerm, likeTerm, likeTerm);
      });

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
        WHERE ${conditions.join(' OR ')}
        ORDER BY wa.assigned_on DESC
        LIMIT ? OFFSET ?
      `, [...params, limit, offset]);
      
      return res.json({ assignments });
    } else {
      // Single term search
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
      
      return res.json({ assignments });
    }
  } catch (error) {
    console.error('[ERROR] GET /challandashboard/search:', error);
    return res.status(500).json({ error: error.message });
  }
});

// POST /challandashboard/generate - Generate challan form
router.post('/generate', isAuthenticated, async (req, res) => {
  try {
    const selectedRows = JSON.parse(req.body.selectedRows || '[]');
    
    if (selectedRows.length === 0) {
      req.flash('error', 'No items selected for challan generation');
      return res.redirect('/challandashboard');
    }

    // Get list of washers (consignees)
    const washerIds = [49, 62, 59, 56, 57, 58, 60, 54, 64, 61];
    const [washers] = await pool.query(
      `SELECT id, username FROM users WHERE id IN (?) ORDER BY username ASC`,
      [washerIds]
    );
    
    res.render('challanGeneration', { 
      selectedRows, 
      washers,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (error) {
    console.error('[ERROR] POST /challandashboard/generate:', error);
    req.flash('error', 'Error generating challan form');
    res.redirect('/challandashboard');
  }
});

// POST /challandashboard/create - Create and save challan
router.post('/create', isAuthenticated, async (req, res) => {
  try {
    const { challanDate, washerId, selectedRows } = req.body;
    const items = JSON.parse(selectedRows || '[]');
    
    if (items.length === 0) {
      req.flash('error', 'No items selected for challan');
      return res.redirect('/challandashboard');
    }

    // Validate washerId
    const validWasherIds = [49, 62, 59, 56, 57, 58, 60, 54, 64, 61];
    if (!validWasherIds.includes(parseInt(washerId))) {
      req.flash('error', 'Invalid washer selected');
      return res.redirect('/challandashboard');
    }

    // Sender details (hardcoded for this example)
    const sender = {
      name: "KOTTY LIFESTYLE PRIVATE LIMITED",
      address: "GB-65, BHARAT VIHAR, LAKKARPUR, FARIDABAD, HARYANA, Haryana 121009",
      gstin: "06AAGCK0951K1ZH",
      state: "06-Haryana",
      pan: "AAGCK0951K"
    };

    // Consignee mapping
    const consigneeMapping = {
      49: { name: "ADS WASHER", gstin: "07HQOPK1686K1Z2", address: "I-112, JAITPUR EXTENSION, PART-1, BADARPUR, South East Delhi, Delhi, 110044", place: "07-DELHI" },
      62: { name: "MEENA TRADING WASHER", gstin: "09DERPG5827R1ZF", address: "Ground Floor, S 113, Harsha Compound, Loni Road Industrial Area, Mohan Nagar, Ghaziabad, Uttar Pradesh, 201003", place: "09-UTTAR PRADESH" },
      59: { name: "MAA TARA ENTERPRISES", gstin: "07AMLPM6699N1ZX", address: "G/F, B/P R/S, B-200, Main Sindhu Farm Road, Meethapur Extension, New Delhi, South East Delhi, Delhi, 110044", place: "07-DELHI" },
      56: { name: "VAISHNAVI WASHING", gstin: "09BTJPM9580J1ZU", address: "VILL-ASGARPUR, SEC-126, NOIDA, UTTAR PRADESH, Gautambuddha Nagar, Uttar Pradesh, 201301", place: "09-UTTAR PRADESH" },
      57: { name: "SHREE BALA JI WASHING", gstin: "07ARNPP7012K1ZF", address: "KH NO.490/1/2/3, VILLAGE MOLARBAND, NEAR SAPERA BASTI, BADARPUR, South Delhi, Delhi, 110044", place: "07-DELHI" },
      58: { name: "PRITY ENTERPRISES", gstin: "07BBXPS1234F1ZD", address: "G/F, CG-21-A, SHOP PUL PEHLAD PUR, New Delhi, South East Delhi, Delhi, 110044", place: "07-DELHI" },
      60: { name: "SHREE GANESH WASHING", gstin: "06AHPPC4743G1ZE", address: "2/2,6-2, KITA 2, AREA 7, KILLLA NO. 1/2/2, SIDHOLA, TIGAON, Faridabad, Haryana, 121101", place: "06-HARYANA" },
      54: { name: "RAJ ENTERPRISES WASHING", gstin: "07KWWPS3671F1ZL", address: "H No-199J Gali no-6, Block - A, Numbardar Colony Meethapur, Badarpur, New Delhi, South East Delhi, Delhi, 110044", place: "07-DELHI" },
      64: { name: "ANSHIK ENTERPRISES WASHING", gstin: "09BGBPC8487K1ZX", address: "00, Sultanpur, Main Rasta, Near J P Hospital, Noida, Gautambuddha Nagar, Uttar Pradesh, 201304", place: "09-UTTAR PRADESH" },
      61: { name: "H.P GARMENTS", gstin: "06CVKPS2554J1Z4", address: "PLOT NO-5, NANGLA GAJI PUR ROAD, NEAR ANTRAM CHOWK, Nangla Gujran, Faridabad, Haryana, 121005", place: "06-HARYANA" }
    };
    
    const consignee = consigneeMapping[washerId];
    if (!consignee) {
      req.flash('error', 'Invalid consignee details');
      return res.redirect('/challandashboard');
    }

    // Process items
    const ratePerItem = 200;
    items.forEach(item => {
      item.hsnSac = "62034200";
      item.rate = ratePerItem;
      item.discount = 0;
      item.taxableValue = parseInt(item.total_pieces) * ratePerItem;
      item.quantityFormatted = item.total_pieces + " PCS";
    });

    const totalTaxableValue = items.reduce((sum, item) => sum + item.taxableValue, 0);
    const totalAmount = totalTaxableValue;
    
    // Generate challan number
    const challanId = Date.now() % 100000;
    const challanNo = `DC/JOB/25-26/${challanId}`;
    
    // Save to database
    const challanInsertQuery = `
      INSERT INTO challan 
        (challan_date, challan_no, reference_no, challan_type, 
         sender_name, sender_address, sender_gstin, sender_state, sender_pan, 
         consignee_id, consignee_name, consignee_gstin, consignee_address, place_of_supply, 
         items, total_taxable_value, total_amount, total_amount_in_words)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    await pool.query(challanInsertQuery, [
      challanDate, challanNo, "", "JOB WORK",
      sender.name, sender.address, sender.gstin, sender.state, sender.pan,
      washerId, consignee.name, consignee.gstin, consignee.address, consignee.place,
      JSON.stringify(items),
      totalTaxableValue, totalAmount, `${totalAmount.toLocaleString('en-IN')} Rupees Only`
    ]);

    // Render the challan view
    res.render('challanCreation', { 
      challan: {
        sender,
        challanDate,
        challanNo,
        referenceNo: "",
        challanType: "JOB WORK",
        consignee,
        items,
        totalTaxableValue,
        totalAmount,
        totalAmountInWords: `${totalAmount.toLocaleString('en-IN')} Rupees Only`
      }
    });
  } catch (error) {
    console.error('[ERROR] POST /challan/create:', error);
    req.flash('error', 'Error creating challan');
    res.redirect('/challandashboard');
  }
});

module.exports = router;
