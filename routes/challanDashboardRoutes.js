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
// IDs of users that act as washing vendors (consignees)
const washers       = [49, 62, 59, 56, 57, 58, 60, 54, 64, 61, 115, 116];
const washersSet    = new Set(washers);
const jeansAssembly = [44, 13];
const jeansAssemblySet = new Set(jeansAssembly);
const WASHER_SHORT_CODES = {
  49:'AW', 62:'MW', 59:'MT', 56:'VW', 57:'SB', 58:'PE',
  60:'SG', 54:'RE', 64:'AE', 61:'HP', 115:'RW', 116:'SD'
};

// --------------------------------------------------------------------
// STATIC DATA – defined once to avoid recreation per request
// --------------------------------------------------------------------
const sender = {
  name   : 'KOTTY LIFESTYLE PRIVATE LIMITED',
  address: 'GB-65, BHARAT VIHAR, LAKKARPUR, FARIDABAD, HARYANA, Haryana 121009',
  gstin  : '06AAGCK0951K1ZH',
  state  : '06-Haryana',
  pan    : 'AAGCK0951K'
};

const consigneeMapping = {
  49:{name:'A. D. S. ENTERPRISES',
      gstin:'07OHFPK0221P1Z0',
      address:'I-112, BLOCK I, BLOCK I, JAITPUR EXTN PART 1 BADARPUR, New Delhi, South East Delhi, Delhi, 110044',
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
      placeOfSupply:'06-HARYANA'},
  115:{name:'RADHIKA ENTERPRISES',
       gstin:'07AHFPY6350B1ZB',
       address:'PLOT NO.B-78, SINDHU FARM ROAD, MEETHAPUR, BADARPUR, South Delhi, Delhi, 110044',
       placeOfSupply:'07-DELHI'},
  116:{name:'S S DYEING HOUSE',
       gstin:'07AGFPC9403N1ZA',
       address:'HOUSE NO 65, GALI NO 6 LAKHPAT COLONY, PART 2 MEETHAPUR EXTN.BADARPUR, South Delhi, Delhi, 110044',
       placeOfSupply:'07-DELHI'}
};

const RATE = 200;

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
// Works against any id-bearing alias (legacy washing_assignments.id or
// the offset event_id used by the events-sourced rows).
// --------------------------------------------------------------------
const EXCLUDE_USED_LOTS_CLAUSE_FOR = (idExpr) => `
  NOT EXISTS (
    SELECT 1
      FROM challan ch
     WHERE JSON_SEARCH(
             ch.items,'one',CAST(${idExpr} AS CHAR),NULL,'$[*].washing_id'
           ) IS NOT NULL
  )
`;

// Events-sourced rows surface to the UI with washing_id = EVENT_ID_OFFSET + event_id
// so they cannot collide with legacy washing_assignments.id values (low thousands).
// On create we decode back.
const EVENT_ID_OFFSET = 100000000;

// ====================================================================
// GET /challandashboard  – dashboard
// ====================================================================
router.get('/', isAuthenticated, async (req,res)=>{
  try {
    const userId = req.session.user.id;
    if (!jeansAssemblySet.has(userId)) {
      req.flash('error','You are not authorized to view the challan dashboard.');
      return res.redirect('/');
    }

    const offset = parseInt(req.query.offset,10)||0;
    const limit  = 50;

    const [assignments] = await pool.query(`
      ( SELECT
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
        WHERE ${EXCLUDE_USED_LOTS_CLAUSE_FOR('wa.id')}
          AND wa.is_approved = 1 )
      UNION ALL
      ( SELECT
          we.id + ${EVENT_ID_OFFSET}  AS washing_id,
          c.lot_no, c.sku, c.total_pieces,
          NULL          AS assembly_remark,
          c.remark      AS cutting_remark,
          NULL          AS target_day,
          we.created_at AS assigned_on,
          1             AS is_approved,
          we.remark     AS assignment_remark,
          u.username    AS washer_username,
          COALESCE((SELECT u2.username
                      FROM jeans_assembly_events je
                      JOIN users u2 ON u2.id = je.operator_id
                     WHERE je.cutting_lot_id = c.id AND je.event_type='complete'
                     ORDER BY je.created_at DESC LIMIT 1), '') AS master_username
        FROM washing_events we
        JOIN cutting_lots c ON c.id = we.cutting_lot_id
        JOIN users u        ON u.id = we.operator_id
        WHERE we.event_type = 'approve'
          -- Avoid double-listing if a legacy washing_assignments row exists for this lot.
          AND NOT EXISTS (
            SELECT 1 FROM washing_assignments wa
              JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
             WHERE jd.lot_no = c.lot_no AND wa.is_approved = 1
          )
          AND ${EXCLUDE_USED_LOTS_CLAUSE_FOR(`we.id + ${EVENT_ID_OFFSET}`)} )
      ORDER BY assigned_on DESC
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
    if (!jeansAssemblySet.has(userId))
      return res.status(403).json({error:'Not authorized to search challans'});

    const search  = (req.query.search||'').trim();
    const offset  = parseInt(req.query.offset,10)||0;
    const limit   = 50;

    // Build the search predicate once; applied to both halves of the UNION.
    let searchClauseLegacy = '';
    let searchClauseEvent  = '';
    const searchParams = [];

    if (search.includes(',')) {
      const terms = search.split(',').map(t=>t.trim()).filter(Boolean);
      if (!terms.length) return res.json({assignments:[]});
      const condsLegacy = [], condsEvent = [];
      for (const t of terms) {
        const like = `%${t}%`;
        condsLegacy.push('(jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)');
        condsEvent .push('(c.sku  LIKE ? OR c.lot_no  LIKE ? OR c.remark LIKE ?)');
        searchParams.push(like,like,like);
      }
      searchClauseLegacy = ` AND (${condsLegacy.join(' OR ')})`;
      searchClauseEvent  = ` AND (${condsEvent .join(' OR ')})`;
    } else if (search) {
      const like = `%${search}%`;
      searchClauseLegacy = ` AND (jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)`;
      searchClauseEvent  = ` AND (c.sku  LIKE ? OR c.lot_no  LIKE ? OR c.remark LIKE ?)`;
      searchParams.push(like,like,like);
    }

    const sql = `
      ( SELECT
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
        WHERE ${EXCLUDE_USED_LOTS_CLAUSE_FOR('wa.id')}
          AND wa.is_approved = 1
          ${searchClauseLegacy} )
      UNION ALL
      ( SELECT
          we.id + ${EVENT_ID_OFFSET}  AS washing_id,
          c.lot_no, c.sku, c.total_pieces,
          NULL          AS assembly_remark,
          c.remark      AS cutting_remark,
          NULL          AS target_day,
          we.created_at AS assigned_on,
          1             AS is_approved,
          we.remark     AS assignment_remark,
          u.username    AS washer_username,
          COALESCE((SELECT u2.username
                      FROM jeans_assembly_events je
                      JOIN users u2 ON u2.id = je.operator_id
                     WHERE je.cutting_lot_id = c.id AND je.event_type='complete'
                     ORDER BY je.created_at DESC LIMIT 1), '') AS master_username
        FROM washing_events we
        JOIN cutting_lots c ON c.id = we.cutting_lot_id
        JOIN users u        ON u.id = we.operator_id
        WHERE we.event_type = 'approve'
          AND NOT EXISTS (
            SELECT 1 FROM washing_assignments wa
              JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
             WHERE jd.lot_no = c.lot_no AND wa.is_approved = 1
          )
          AND ${EXCLUDE_USED_LOTS_CLAUSE_FOR(`we.id + ${EVENT_ID_OFFSET}`)}
          ${searchClauseEvent} )
      ORDER BY assigned_on DESC
      LIMIT ? OFFSET ?
    `;
    const params = [...searchParams, ...searchParams, limit, offset];

    const [assignments] = await pool.query(sql, params);
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
    if (!jeansAssemblySet.has(userId)) {
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
    if (!jeansAssemblySet.has(userId)) {
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
    if (!washersSet.has(washerIDNum)) {
      req.flash('error','Invalid or unknown washer selected');
      conn.release(); return res.redirect('/challandashboard');
    }

    const washingIds = items.map(i=>parseInt(i.washing_id,10));
    if (!washingIds.length) {
      req.flash('error','No valid washing items found');
      conn.release(); return res.redirect('/challandashboard');
    }

    // Split into legacy washing_assignments ids vs offset-encoded
    // washing_events.id (decoded via EVENT_ID_OFFSET).
    const legacyIds = washingIds.filter(id => id < EVENT_ID_OFFSET);
    const eventIds  = washingIds.filter(id => id >= EVENT_ID_OFFSET)
                                .map(id => id - EVENT_ID_OFFSET);

    let approvedCnt = 0;
    if (legacyIds.length) {
      const [[{total}]] = await conn.query(
        `SELECT COUNT(*) AS total FROM washing_assignments
          WHERE id IN (?) AND is_approved=1`,
        [legacyIds]
      );
      approvedCnt += total;
    }
    if (eventIds.length) {
      const [[{total}]] = await conn.query(
        `SELECT COUNT(*) AS total FROM washing_events
          WHERE id IN (?) AND event_type='approve'`,
        [eventIds]
      );
      approvedCnt += total;
    }
    if (approvedCnt !== washingIds.length) {
      req.flash('error','Some selected lots are not approved or missing');
      conn.release(); return res.redirect('/challandashboard');
    }

    // avoid duplicates with a single query
    const [dup] = await conn.query(
      `SELECT ch.id AS challan_id, jt.washing_id
         FROM challan ch
         JOIN JSON_TABLE(ch.items, '$[*]' COLUMNS(washing_id INT PATH '$.washing_id')) jt
        WHERE jt.washing_id IN (?)
        LIMIT 1`,
      [washingIds]
    );
    if (dup.length) {
      req.flash('error',`Lot with washing_id=${dup[0].washing_id} already in challan #${dup[0].challan_id}`);
      conn.release(); return res.redirect('/challandashboard');
    }

    const consignee = consigneeMapping[washerIDNum];
    if (!consignee) {
      req.flash('error','Invalid consignee details');
      conn.release(); return res.redirect('/challandashboard');
    }

    // ----------------------------------------------------------------
    //  Item meta
    // ----------------------------------------------------------------
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

    if (jeansAssemblySet.has(userId)) {
      /* ok */ } else if (washersSet.has(userId)) {
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

    if (washersSet.has(userId)) {
      sql += 'WHERE consignee_id=? '; params.push(userId);
    } else if (jeansAssemblySet.has(userId)) {
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
