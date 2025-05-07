/**********************************************************************
 * routes/challanDashboardRoutes.js
 * --------------------------------------------------------------------
 *  • Adds Vehicle Number, Purpose and Purpose Price to the challan.
 *  • Requires three new columns in the challan table:
 *      vehicle_number VARCHAR(20),
 *      purpose        VARCHAR(150),
 *      purpose_price  DECIMAL(12,2)
 *********************************************************************/

const express = require('express');
const router  = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated } = require('../middlewares/auth');

// --------------------------------------------------------------------
// CONSTANTS
// --------------------------------------------------------------------
const FISCAL_YEAR = '25-26';                             // DC/25-26/…
const washers       = [49, 62, 59, 56, 57, 58, 60, 54, 64, 61];
const jeansAssembly = [44, 13];
const WASHER_SHORT_CODES = {
  49:'AW', 62:'MW', 59:'MT', 56:'VW', 57:'SB', 58:'PE',
  60:'SG', 54:'RE', 64:'AE', 61:'HP'
};

// --------------------------------------------------------------------
// HELPER: getNextChallanCounter – transaction-safe
// --------------------------------------------------------------------
async function getNextChallanCounter (washerId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id,current_counter
         FROM washer_challan_counters
        WHERE washer_id=? AND year_range=? FOR UPDATE`,
      [washerId, FISCAL_YEAR]
    );

    let counter = 1;
    if (rows.length === 0) {
      await conn.query(
        `INSERT INTO washer_challan_counters
            (washer_id,year_range,current_counter)
         VALUES (?,?,1)`,
        [washerId, FISCAL_YEAR]
      );
    } else {
      counter = rows[0].current_counter + 1;
      await conn.query(
        `UPDATE washer_challan_counters
            SET current_counter=? WHERE id=?`,
        [counter, rows[0].id]
      );
    }
    await conn.commit();
    conn.release();
    return counter;
  } catch (err) {
    await conn.rollback();
    conn.release();
    throw err;
  }
}

// --------------------------------------------------------------------
// HELPER: exclude lots already in a challan
// --------------------------------------------------------------------
const EXCLUDE_USED_LOTS_CLAUSE = `
  NOT EXISTS (
    SELECT 1
      FROM challan ch
     WHERE JSON_SEARCH(
             ch.items,'one',CAST(wa.id AS CHAR),NULL,'$[*].washing_id'
           ) IS NOT NULL
  )
`;

// ====================================================================
// GET /challandashboard  – dashboard
// ====================================================================
router.get('/', isAuthenticated, async (req,res)=>{
  try {
    const userId = req.session.user.id;
    if (!jeansAssembly.includes(userId)) {
      req.flash('error','You are not authorized to view the challan dashboard.');
      return res.redirect('/');
    }

    const offset = parseInt(req.query.offset,10)||0;
    const limit  = 50;

    const [assignments] = await pool.query(`
      SELECT
        wa.id        AS washing_id,
        jd.lot_no, jd.sku, jd.total_pieces,
        jd.remark    AS assembly_remark,
        c.remark     AS cutting_remark,
        wa.target_day, wa.assigned_on,
        wa.is_approved, wa.assignment_remark,
        u.username   AS washer_username,
        m.username   AS master_username
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      JOIN cutting_lots        c  ON jd.lot_no = c.lot_no
      JOIN users               u  ON wa.user_id = u.id
      JOIN users               m  ON wa.jeans_assembly_master_id = m.id
      WHERE ${EXCLUDE_USED_LOTS_CLAUSE}
        AND wa.is_approved = 1
      ORDER BY wa.assigned_on DESC
      LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    res.render('challanDashboard',{
      assignments,
      search  : '',
      user    : req.session.user,
      error   : req.flash('error'),
      success : req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /challandashboard:',err);
    req.flash('error','Could not load dashboard data');
    res.redirect('/');
  }
});

// ====================================================================
// GET /challandashboard/search
// ====================================================================
router.get('/search', isAuthenticated, async (req,res)=>{
  try {
    const userId = req.session.user.id;
    if (!jeansAssembly.includes(userId))
      return res.status(403).json({error:'Not authorized to search challans'});

    const search  = (req.query.search||'').trim();
    const offset  = parseInt(req.query.offset,10)||0;
    const limit   = 50;

    let sql = `
      SELECT
        wa.id        AS washing_id,
        jd.lot_no, jd.sku, jd.total_pieces,
        jd.remark    AS assembly_remark,
        c.remark     AS cutting_remark,
        wa.target_day, wa.assigned_on,
        wa.is_approved, wa.assignment_remark,
        u.username   AS washer_username,
        m.username   AS master_username
      FROM washing_assignments wa
      JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
      JOIN cutting_lots        c  ON jd.lot_no = c.lot_no
      JOIN users               u  ON wa.user_id = u.id
      JOIN users               m  ON wa.jeans_assembly_master_id = m.id
      WHERE ${EXCLUDE_USED_LOTS_CLAUSE}
        AND wa.is_approved = 1`;
    const params = [];

    if (search.includes(',')) {
      const terms = search.split(',').map(t=>t.trim()).filter(Boolean);
      if (!terms.length) return res.json({assignments:[]});
      const conds = [];
      for (const t of terms) {
        const like = `%${t}%`;
        conds.push('(jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)');
        params.push(like,like,like);
      }
      sql += ` AND (${conds.join(' OR ')})`;
    } else if (search) {
      const like = `%${search}%`;
      sql += ` AND (jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)`;
      params.push(like,like,like);
    }

    sql += ` ORDER BY wa.assigned_on DESC LIMIT ? OFFSET ?`;
    params.push(limit,offset);

    const [assignments] = await pool.query(sql,params);
    res.json({assignments});
  } catch (err) {
    console.error('[ERROR] GET /challandashboard/search:',err);
    res.status(500).json({error:err.message});
  }
});

// ====================================================================
// POST /challandashboard/generate  – render the form
// ====================================================================
router.post('/generate', isAuthenticated, async (req,res)=>{
  try {
    const userId = req.session.user.id;
    if (!jeansAssembly.includes(userId)) {
      req.flash('error','You are not authorized to generate challans.');
      return res.redirect('/');
    }

    const selectedRows = JSON.parse(req.body.selectedRows||'[]');
    if (!selectedRows.length) {
      req.flash('error','No items selected for challan generation');
      return res.redirect('/challandashboard');
    }

    const [washerRows] = await pool.query(
      `SELECT id,username FROM users WHERE id IN (?) ORDER BY username`,
      [washers]
    );

    res.render('challanGeneration',{
      selectedRows,
      washers : washerRows,
      error   : req.flash('error'),
      success : req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] POST /challandashboard/generate:',err);
    req.flash('error','Error generating challan form');
    res.redirect('/challandashboard');
  }
});

// ====================================================================
// POST /challandashboard/create  – insert new challan
// ====================================================================
router.post('/create', isAuthenticated, async (req,res)=>{
  const conn = await pool.getConnection();
  try {
    const userId = req.session.user.id;
    if (!jeansAssembly.includes(userId)) {
      req.flash('error','You are not authorized to create challans.');
      conn.release(); return res.redirect('/');
    }

    const {
      challanDate, washerId, selectedRows,
      vehicleNumber = '', purpose = '', purposePrice = ''
    } = req.body;

    const items = JSON.parse(selectedRows||'[]');
    if (!items.length) {
      req.flash('error','No items selected for challan');
      conn.release(); return res.redirect('/challandashboard');
    }

    const washerIDNum = parseInt(washerId,10);
    if (!washers.includes(washerIDNum)) {
      req.flash('error','Invalid or unknown washer selected');
      conn.release(); return res.redirect('/challandashboard');
    }

    const washingIds = items.map(i=>parseInt(i.washing_id,10));
    if (!washingIds.length) {
      req.flash('error','No valid washing items found');
      conn.release(); return res.redirect('/challandashboard');
    }

    const [[{total:approvedCnt}]] = await conn.query(
      `SELECT COUNT(*) AS total FROM washing_assignments
        WHERE id IN (?) AND is_approved=1`,
      [washingIds]
    );
    if (approvedCnt !== washingIds.length) {
      req.flash('error','Some selected lots are not approved or missing');
      conn.release(); return res.redirect('/challandashboard');
    }

    // avoid duplicates
    for (const id of washingIds) {
      const [[exists]] = await conn.query(
        `SELECT id FROM challan
          WHERE JSON_SEARCH(items,'one',CAST(? AS CHAR),
                            NULL,'$[*].washing_id') IS NOT NULL LIMIT 1`,
        [id]
      );
      if (exists) {
        req.flash('error',`Lot with washing_id=${id} already in challan #${exists.id}`);
        conn.release(); return res.redirect('/challandashboard');
      }
    }

    // ----------------------------------------------------------------
    //  STATIC DATA
    // ----------------------------------------------------------------
    const sender = {
      name   : 'KOTTY LIFESTYLE PRIVATE LIMITED',
      address: 'GB-65, BHARAT VIHAR, LAKKARPUR, FARIDABAD, HARYANA, Haryana 121009',
      gstin  : '06AAGCK0951K1ZH',
      state  : '06-Haryana',
      pan    : 'AAGCK0951K'
    };

    const consigneeMapping = {
      49:{name:'ADS WASHER',
          gstin:'07HQOPK1686K1Z2',
          address:'I-112, JAITPUR EXTENSION, PART-1, BADARPUR, South East Delhi, Delhi, 110044',
          placeOfSupply:'07-DELHI'},
      62:{name:'MEENA TRADING WASHER',
          gstin:'09DERPG5827R1ZF',
          address:'Ground Floor, S 113, Harsha Compound, Loni Road Industrial Area, Mohan Nagar, Ghaziabad, Uttar Pradesh, 201003',
          placeOfSupply:'09-UTTAR PRADESH'},
      59:{name:'MAA TARA ENTERPRISES',
          gstin:'07AMLPM6699N1ZX',
          address:'G/F, B/P R/S, B-200, Main Sindhu Farm Road, Meethapur Extension, New Delhi, South East Delhi, Delhi, 110044',
          placeOfSupply:'07-DELHI'},
      56:{name:'VAISHNAVI WASHING',
          gstin:'09BTJPM9580J1ZU',
          address:'VILL-ASGARPUR, SEC-126, NOIDA, UTTAR PRADESH, Gautambuddha Nagar, Uttar Pradesh, 201301',
          placeOfSupply:'09-UTTAR PRADESH'},
      57:{name:'SHREE BALA JI WASHING',
          gstin:'07ARNPP7012K1ZF',
          address:'KH NO.490/1/2/3, VILLAGE MOLARBAND, NEAR SAPERA BASTI, BADARPUR, South Delhi, Delhi, 110044',
          placeOfSupply:'07-DELHI'},
      58:{name:'PRITY ENTERPRISES',
          gstin:'07BBXPS1234F1ZD',
          address:'G/F, CG-21-A, SHOP PUL PEHLAD PUR, New Delhi, South East Delhi, Delhi, 110044',
          placeOfSupply:'07-DELHI'},
      60:{name:'SHREE GANESH WASHING',
          gstin:'06AHPPC4743G1ZE',
          address:'2/2,6-2, KITA 2, AREA 7, KILLLA NO. 1/2/2, SIDHOLA, TIGAON, Faridabad, Haryana, 121101',
          placeOfSupply:'06-HARYANA'},
      54:{name:'RAJ ENTERPRISES WASHING',
          gstin:'07KWWPS3671F1ZL',
          address:'H No-199J Gali no-6, Block - A, Numbardar Colony Meethapur, Badarpur, New Delhi, South East Delhi, Delhi, 110044',
          placeOfSupply:'07-DELHI'},
      64:{name:'ANSHIK ENTERPRISES WASHING',
          gstin:'09BGBPC8487K1ZX',
          address:'00, Sultanpur, Main Rasta, Near J P Hospital, Noida, Gautambuddha Nagar, Uttar Pradesh, 201304',
          placeOfSupply:'09-UTTAR PRADESH'},
      61:{name:'H.P GARMENTS',
          gstin:'06CVKPS2554J1Z4',
          address:'PLOT NO-5, NANGLA GAJI PUR ROAD, NEAR ANTRAM CHOWK, Nangla Gujran, Faridabad, Haryana, 121005',
          placeOfSupply:'06-HARYANA'}
    };

    const consignee = consigneeMapping[washerIDNum];
    if (!consignee) {
      req.flash('error','Invalid consignee details');
      conn.release(); return res.redirect('/challandashboard');
    }

    // ----------------------------------------------------------------
    //  Item meta
    // ----------------------------------------------------------------
    const RATE = 200;
    items.forEach(it=>{
      it.hsnSac           = '62034200';
      it.rate             = RATE;
      it.discount         = 0;
      it.taxableValue     = parseInt(it.total_pieces,10)*RATE;
      it.quantityFormatted= `${it.total_pieces} PCS`;
    });
    const totalTaxableValue = items.reduce((s,i)=>s+i.taxableValue,0);
    const totalAmount       = totalTaxableValue;

    // ----------------------------------------------------------------
    //  Challan number
    // ----------------------------------------------------------------
    const next  = await getNextChallanCounter(washerIDNum);
    const code  = WASHER_SHORT_CODES[washerIDNum]||'XX';
    const challanNo = `DC/${code}/${FISCAL_YEAR}/${next}`;

    // ----------------------------------------------------------------
    //  INSERT
    // ----------------------------------------------------------------
    const insertSql = `
      INSERT INTO challan (
        challan_date, challan_no, reference_no, challan_type,
        sender_name, sender_address, sender_gstin, sender_state, sender_pan,
        consignee_id, consignee_name, consignee_gstin, consignee_address, place_of_supply,
        vehicle_number, purpose, purpose_price,
        items, total_taxable_value, total_amount, total_amount_in_words
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    const [resInsert] = await conn.query(insertSql,[
      challanDate,
      challanNo,
      '',                    // reference_no
      'JOB WORK',
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
      vehicleNumber.trim(),
      purpose.trim(),
      purposePrice || 0,
      JSON.stringify(items),
      totalTaxableValue,
      totalAmount,
      `${totalAmount.toLocaleString('en-IN')} Rupees Only`
    ]);

    conn.release();
    res.redirect(`/challandashboard/view/${resInsert.insertId}`);
  } catch (err) {
    console.error('[ERROR] POST /challandashboard/create:',err);
    conn.release();
    req.flash('error','Error creating challan');
    res.redirect('/challandashboard');
  }
});

// ====================================================================
// GET /challandashboard/view/:challanId
// ====================================================================
router.get('/view/:challanId', isAuthenticated, async (req,res)=>{
  try {
    const userId   = req.session.user.id;
    const challanId= parseInt(req.params.challanId,10);

    const [rows] = await pool.query(`SELECT * FROM challan WHERE id=?`,[challanId]);
    if (!rows.length) {
      req.flash('error','Challan not found'); return res.redirect('/challandashboard');
    }
    const ch = rows[0];

    if (jeansAssembly.includes(userId)) {
      /* ok */ } else if (washers.includes(userId)) {
      if (ch.consignee_id !== userId) {
        req.flash('error','Not authorized to view this challan.'); return res.redirect('/');
      }
    } else {
      req.flash('error','Not authorized to view this challan.'); return res.redirect('/');
    }

    let items = [];
    try {
      items = typeof ch.items==='string' ? JSON.parse(ch.items) : ch.items;
    } catch (e) {
      console.error('Invalid JSON in challan items:',ch.items);
      req.flash('error','Invalid JSON in challan items'); return res.redirect('/challandashboard');
    }

    const challan = {
      sender : {
        name   : ch.sender_name,
        address: ch.sender_address,
        gstin  : ch.sender_gstin,
        state  : ch.sender_state,
        pan    : ch.sender_pan
      },
      challanDate      : ch.challan_date,
      challanNo        : ch.challan_no,
      referenceNo      : ch.reference_no || '',
      challanType      : ch.challan_type,
      consignee : {
        name         : ch.consignee_name,
        gstin        : ch.consignee_gstin,
        address      : ch.consignee_address,
        placeOfSupply: ch.place_of_supply
      },
      vehicleNumber    : ch.vehicle_number,
      purpose          : ch.purpose,
      purposePrice     : ch.purpose_price,
      items,
      totalTaxableValue: ch.total_taxable_value,
      totalAmount      : ch.total_amount,
      totalAmountInWords: ch.total_amount_in_words
    };

    res.render('challanCreation',{challan});
  } catch (err) {
    console.error('[ERROR] GET /challandashboard/view:',err);
    req.flash('error','Error loading challan');
    res.redirect('/challandashboard');
  }
});

// ====================================================================
// GET /challanlist  – washer or assembly
// ====================================================================
router.get('/challanlist', isAuthenticated, async (req,res)=>{
  try {
    const userId = req.session.user.id;
    const search = (req.query.search||'').trim();

    let sql = 'SELECT * FROM challan ';
    const params = [];

    if (washers.includes(userId)) {
      sql += 'WHERE consignee_id=? '; params.push(userId);
    } else if (jeansAssembly.includes(userId)) {
      sql += 'WHERE 1 ';
    } else {
      req.flash('error','Not authorized to view challan list'); return res.redirect('/');
    }

    if (search) {
      sql += `
        AND (
          challan_no LIKE ?
          OR JSON_SEARCH(items,'one',?,NULL,'$[*].lot_no') IS NOT NULL
        )`;
      params.push(`%${search}%`,search);
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.query(sql,params);

    res.render('challanList',{
      challans: rows,
      search,
      error   : req.flash('error'),
      success : req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /challanlist:',err);
    req.flash('error','Could not load challan list');
    res.redirect('/');
  }
});

module.exports = router;
