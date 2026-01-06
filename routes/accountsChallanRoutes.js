const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isAccountsAdmin, allowUsernames } = require('../middlewares/auth');

const FISCAL_YEAR = '25-26';
const RATE = 200;

async function getNextChallanCounter(consigneeId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, current_counter
         FROM dc_challan_counters
        WHERE consignee_id = ? AND year_range = ? FOR UPDATE`,
      [consigneeId, FISCAL_YEAR]
    );

    let counter = 1;
    if (rows.length === 0) {
      await conn.query(
        `INSERT INTO dc_challan_counters
            (consignee_id, year_range, current_counter)
         VALUES (?, ?, 1)`,
        [consigneeId, FISCAL_YEAR]
      );
    } else {
      counter = rows[0].current_counter + 1;
      await conn.query(
        `UPDATE dc_challan_counters
            SET current_counter = ?
          WHERE id = ?`,
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

function buildAssignmentsQuery({ search, limit, offset }) {
  const params = [];
  let whereClause = 'WHERE wa.is_approved = 1';

  if (search) {
    if (search.includes(',')) {
      const terms = search
        .split(',')
        .map((term) => term.trim())
        .filter(Boolean);
      if (terms.length) {
        const conds = [];
        for (const term of terms) {
          const like = `%${term}%`;
          conds.push('(jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)');
          params.push(like, like, like);
        }
        whereClause += ` AND (${conds.join(' OR ')})`;
      }
    } else {
      const like = `%${search}%`;
      whereClause += ' AND (jd.sku LIKE ? OR jd.lot_no LIKE ? OR c.remark LIKE ?)';
      params.push(like, like, like);
    }
  }

  const sql = `
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
      m.username AS master_username,
      IFNULL(SUM(dci.issued_pieces), 0) AS issued_pieces,
      GREATEST(jd.total_pieces - IFNULL(SUM(dci.issued_pieces), 0), 0) AS remaining_pieces
    FROM washing_assignments wa
    JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
    JOIN cutting_lots c ON jd.lot_no = c.lot_no
    JOIN users u ON wa.user_id = u.id
    JOIN users m ON wa.jeans_assembly_master_id = m.id
    LEFT JOIN dc_challan_items dci ON dci.washing_id = wa.id AND COALESCE(dci.item_type, 'normal') = 'normal'
    ${whereClause}
    GROUP BY wa.id
    ORDER BY wa.assigned_on DESC
    LIMIT ? OFFSET ?`;

  params.push(limit, offset);
  return { sql, params };
}

router.get('/', isAuthenticated, isAccountsAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;

    const { sql, params } = buildAssignmentsQuery({ search, limit, offset });
    const [assignments] = await pool.query(sql, params);

    res.render('accountsChallanDashboard', {
      assignments,
      search,
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /accounts-challan:', err);
    req.flash('error', 'Could not load accounts challan dashboard');
    res.redirect('/');
  }
});

router.get('/search', isAuthenticated, isAccountsAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const offset = parseInt(req.query.offset, 10) || 0;
    const limit = 50;

    const { sql, params } = buildAssignmentsQuery({ search, limit, offset });
    const [assignments] = await pool.query(sql, params);

    res.json({ assignments });
  } catch (err) {
    console.error('[ERROR] GET /accounts-challan/search:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', isAuthenticated, isAccountsAdmin, async (req, res) => {
  try {
    const selectedRows = JSON.parse(req.body.selectedRows || '[]');
    if (!selectedRows.length) {
      req.flash('error', 'No items selected for challan generation');
      return res.redirect('/accounts-challan');
    }

    const [senders] = await pool.query(
      `SELECT id, name, gstin, state, pan, address, place_of_supply, short_code
         FROM dc_gst_parties
        WHERE party_type = 'sender' AND is_active = 1
        ORDER BY name`
    );
    const [consignees] = await pool.query(
      `SELECT id, name, gstin, state, pan, address, place_of_supply, short_code
         FROM dc_gst_parties
        WHERE party_type = 'consignee' AND is_active = 1
        ORDER BY name`
    );

    const isSapnaUser =
      (req.session?.user?.username || '').toString().toLowerCase() === 'sapna';

    if (!senders.length || !consignees.length) {
      req.flash(
        'error',
        isSapnaUser
          ? 'Please configure sender and consignee GST details first.'
          : 'GST details are missing. Please ask SAPNA to configure GST Master.'
      );
      return res.redirect(isSapnaUser ? '/accounts-challan/gst' : '/accounts-challan');
    }

    res.render('accountsChallanGeneration', {
      selectedRows,
      senders,
      consignees,
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] POST /accounts-challan/generate:', err);
    req.flash('error', 'Error generating challan form');
    res.redirect('/accounts-challan');
  }
});

router.post('/create', isAuthenticated, isAccountsAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const {
      challanDate,
      senderId,
      consigneeId,
      selectedRows,
      vehicleNumber = '',
      purpose = '',
      purposePrice = ''
    } = req.body;

    const itemsInput = JSON.parse(selectedRows || '[]');
    if (!itemsInput.length) {
      req.flash('error', 'No items selected for challan');
      conn.release();
      return res.redirect('/accounts-challan');
    }

    const normalizedItems = itemsInput.map((item) => {
      const entryType = (item.entryType || item.itemType || 'normal').toString().toLowerCase();
      return { ...item, entryType };
    });

    const senderIDNum = parseInt(senderId, 10);
    const consigneeIDNum = parseInt(consigneeId, 10);

    const [[sender]] = await conn.query(
      `SELECT id, name, gstin, state, pan, address, place_of_supply, short_code
         FROM dc_gst_parties
        WHERE id = ? AND party_type = 'sender' AND is_active = 1`,
      [senderIDNum]
    );
    const [[consignee]] = await conn.query(
      `SELECT id, name, gstin, state, pan, address, place_of_supply, short_code
         FROM dc_gst_parties
        WHERE id = ? AND party_type = 'consignee' AND is_active = 1`,
      [consigneeIDNum]
    );

    if (!sender || !consignee) {
      req.flash('error', 'Invalid sender or consignee selected');
      conn.release();
      return res.redirect('/accounts-challan');
    }

    const washingIds = Array.from(
      new Set(
        normalizedItems
          .filter((item) => item.entryType !== 'mix')
          .map((item) => parseInt(item.washing_id, 10))
          .filter((id) => !Number.isNaN(id))
      )
    );

    const [assignmentRows] = await conn.query(
      `SELECT
         wa.id AS washing_id,
         jd.lot_no,
         jd.sku,
         jd.total_pieces,
         IFNULL(SUM(dci.issued_pieces), 0) AS issued_pieces
       FROM washing_assignments wa
       JOIN jeans_assembly_data jd ON wa.jeans_assembly_assignment_id = jd.id
       LEFT JOIN dc_challan_items dci ON dci.washing_id = wa.id AND COALESCE(dci.item_type, 'normal') = 'normal'
       WHERE wa.id IN (?) AND wa.is_approved = 1
       GROUP BY wa.id`,
      [washingIds.length ? washingIds : [0]]
    );

    if (washingIds.length && assignmentRows.length !== washingIds.length) {
      req.flash('error', 'Some selected lots are not approved or missing');
      conn.release();
      return res.redirect('/accounts-challan');
    }

    const assignmentById = new Map(
      assignmentRows.map((row) => [row.washing_id, row])
    );

    const items = [];
    let totalTaxableValue = 0;

    for (const input of normalizedItems) {
      const entryType = input.entryType || 'normal';

      if (entryType === 'mix') {
        const customLabel = (input.customLabel || input.description || input.lot_no || '').trim();
        const mixSku = (input.sku || input.sku_override || '').trim();
        const requestedPieces = parseInt(input.challan_pieces, 10);

        if (!customLabel) {
          req.flash('error', 'Custom description is required for mix entries');
          conn.release();
          return res.redirect('/accounts-challan');
        }
        if (!requestedPieces || requestedPieces <= 0) {
          req.flash('error', `Invalid quantity for mix entry "${customLabel}"`);
          conn.release();
          return res.redirect('/accounts-challan');
        }

        const taxableValue = requestedPieces * RATE;
        totalTaxableValue += taxableValue;

        items.push({
          entryType: 'mix',
          washing_id: null,
          lot_no: customLabel,
          customLabel,
          sku: mixSku,
          total_pieces: requestedPieces,
          lot_total_pieces: null,
          hsnSac: '62034200',
          rate: RATE,
          discount: 0,
          taxableValue,
          quantityFormatted: `${requestedPieces} PCS`
        });
        continue;
      }

      const washingId = parseInt(input.washing_id, 10);
      const requestedPieces = parseInt(input.challan_pieces, 10);
      const assignment = assignmentById.get(washingId);

      if (!assignment) {
        req.flash('error', 'Invalid lot selection');
        conn.release();
        return res.redirect('/accounts-challan');
      }

      const remaining = assignment.total_pieces - assignment.issued_pieces;

      if (entryType === 'normal') {
        if (!remaining || remaining <= 0 || !requestedPieces || requestedPieces <= 0 || requestedPieces > remaining) {
          req.flash('error', `Invalid challan quantity for lot ${assignment.lot_no}`);
          conn.release();
          return res.redirect('/accounts-challan');
        }
      } else if (entryType === 'rewash') {
        if (!requestedPieces || requestedPieces <= 0 || requestedPieces > assignment.total_pieces) {
          req.flash('error', `Invalid rewash quantity for lot ${assignment.lot_no}`);
          conn.release();
          return res.redirect('/accounts-challan');
        }
      } else {
        req.flash('error', 'Unsupported challan item type');
        conn.release();
        return res.redirect('/accounts-challan');
      }

      const taxableValue = requestedPieces * RATE;
      totalTaxableValue += taxableValue;

      items.push({
        entryType,
        washing_id: washingId,
        lot_no: assignment.lot_no,
        sku: assignment.sku,
        total_pieces: requestedPieces,
        lot_total_pieces: assignment.total_pieces,
        hsnSac: '62034200',
        rate: RATE,
        discount: 0,
        taxableValue,
        quantityFormatted: `${requestedPieces} PCS`
      });
    }

    const totalAmount = totalTaxableValue;
    const next = await getNextChallanCounter(consignee.id);
    const code = consignee.short_code || 'XX';
    const challanNo = `DC/${code}/${FISCAL_YEAR}/${next}`;

    await conn.beginTransaction();

    const insertSql = `
      INSERT INTO challan (
        challan_date, challan_no, reference_no, challan_type,
        sender_name, sender_address, sender_gstin, sender_state, sender_pan,
        consignee_id, consignee_name, consignee_gstin, consignee_address, place_of_supply,
        vehicle_number, purpose, purpose_price,
        items, total_taxable_value, total_amount, total_amount_in_words
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    const [resInsert] = await conn.query(insertSql, [
      challanDate,
      challanNo,
      '',
      'JOB WORK',
      sender.name,
      sender.address,
      sender.gstin,
      sender.state,
      sender.pan,
      consignee.id,
      consignee.name,
      consignee.gstin,
      consignee.address,
      consignee.place_of_supply,
      vehicleNumber.trim(),
      purpose.trim(),
      purposePrice || 0,
      JSON.stringify(items),
      totalTaxableValue,
      totalAmount,
      `${totalAmount.toLocaleString('en-IN')} Rupees Only`
    ]);

    const challanId = resInsert.insertId;
    const insertItemValues = items.map((item) => [
      challanId,
      item.entryType === 'mix' ? null : item.washing_id,
      item.entryType === 'mix' ? item.customLabel : item.lot_no,
      item.sku,
      item.entryType === 'mix' ? item.total_pieces : item.lot_total_pieces,
      item.total_pieces,
      item.entryType || 'normal',
      item.entryType === 'mix' ? item.customLabel : null,
      item.entryType === 'mix' ? item.sku || null : null
    ]);

    await conn.query(
      `INSERT INTO dc_challan_items
        (challan_id, washing_id, lot_no, sku, total_pieces, issued_pieces, item_type, custom_label, sku_override)
       VALUES ?`,
      [insertItemValues]
    );

    await conn.commit();
    conn.release();
    res.redirect(`/accounts-challan/view/${challanId}`);
  } catch (err) {
    await conn.rollback();
    conn.release();
    console.error('[ERROR] POST /accounts-challan/create:', err);
    req.flash('error', 'Error creating challan');
    res.redirect('/accounts-challan');
  }
});

router.get('/view/:challanId', isAuthenticated, isAccountsAdmin, async (req, res) => {
  try {
    const challanId = parseInt(req.params.challanId, 10);

    const [rows] = await pool.query('SELECT * FROM challan WHERE id = ?', [challanId]);
    if (!rows.length) {
      req.flash('error', 'Challan not found');
      return res.redirect('/accounts-challan');
    }

    const ch = rows[0];
    let items = [];
    try {
      items = typeof ch.items === 'string' ? JSON.parse(ch.items) : ch.items;
    } catch (err) {
      console.error('Invalid JSON in challan items:', ch.items);
      req.flash('error', 'Invalid challan data');
      return res.redirect('/accounts-challan');
    }

    const challan = {
      sender: {
        name: ch.sender_name,
        address: ch.sender_address,
        gstin: ch.sender_gstin,
        state: ch.sender_state,
        pan: ch.sender_pan
      },
      challanDate: ch.challan_date,
      challanNo: ch.challan_no,
      referenceNo: ch.reference_no || '',
      challanType: ch.challan_type,
      consignee: {
        name: ch.consignee_name,
        gstin: ch.consignee_gstin,
        address: ch.consignee_address,
        placeOfSupply: ch.place_of_supply
      },
      vehicleNumber: ch.vehicle_number,
      purpose: ch.purpose,
      purposePrice: ch.purpose_price,
      items,
      totalTaxableValue: ch.total_taxable_value,
      totalAmount: ch.total_amount,
      totalAmountInWords: ch.total_amount_in_words
    };

    res.render('challanCreation', { challan });
  } catch (err) {
    console.error('[ERROR] GET /accounts-challan/view:', err);
    req.flash('error', 'Error loading challan');
    res.redirect('/accounts-challan');
  }
});

router.get('/list', isAuthenticated, isAccountsAdmin, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    let sql = 'SELECT * FROM challan WHERE 1 ';
    const params = [];

    if (search) {
      sql += `
        AND (
          challan_no LIKE ?
          OR JSON_SEARCH(items,'one',?,NULL,'$[*].lot_no') IS NOT NULL
        )`;
      params.push(`%${search}%`, search);
    }

    sql += ' ORDER BY created_at DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);

    res.render('accountsChallanList', {
      challans: rows,
      search,
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /accounts-challan/list:', err);
    req.flash('error', 'Could not load challan list');
    res.redirect('/accounts-challan');
  }
});

router.get(
  '/gst',
  isAuthenticated,
  isAccountsAdmin,
  allowUsernames(['sapna']),
  async (req, res) => {
  try {
    const [parties] = await pool.query(
      `SELECT * FROM dc_gst_parties ORDER BY party_type, name`
    );

    res.render('accountsChallanGst', {
      parties,
      user: req.session.user,
      error: req.flash('error'),
      success: req.flash('success')
    });
  } catch (err) {
    console.error('[ERROR] GET /accounts-challan/gst:', err);
    req.flash('error', 'Could not load GST configuration');
    res.redirect('/accounts-challan');
  }
  }
);

router.post('/gst', isAuthenticated, isAccountsAdmin, allowUsernames(['sapna']), async (req, res) => {
  try {
    const {
      party_type,
      name,
      gstin,
      address,
      state,
      pan,
      place_of_supply,
      short_code,
      is_active
    } = req.body;

    if (!party_type || !name) {
      req.flash('error', 'Party type and name are required');
      return res.redirect('/accounts-challan/gst');
    }

    await pool.query(
      `INSERT INTO dc_gst_parties
        (party_type, name, gstin, address, state, pan, place_of_supply, short_code, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        party_type,
        name.trim(),
        gstin || null,
        address || null,
        state || null,
        pan || null,
        place_of_supply || null,
        short_code || null,
        is_active ? 1 : 0
      ]
    );

    req.flash('success', 'GST party created');
    res.redirect('/accounts-challan/gst');
  } catch (err) {
    console.error('[ERROR] POST /accounts-challan/gst:', err);
    req.flash('error', 'Failed to create GST party');
    res.redirect('/accounts-challan/gst');
  }
});

router.post(
  '/gst/:id(\\d+)',
  isAuthenticated,
  isAccountsAdmin,
  allowUsernames(['sapna']),
  async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const {
      party_type,
      name,
      gstin,
      address,
      state,
      pan,
      place_of_supply,
      short_code,
      is_active
    } = req.body;

    await pool.query(
      `UPDATE dc_gst_parties
         SET party_type = ?, name = ?, gstin = ?, address = ?, state = ?,
             pan = ?, place_of_supply = ?, short_code = ?, is_active = ?
       WHERE id = ?`,
      [
        party_type,
        name.trim(),
        gstin || null,
        address || null,
        state || null,
        pan || null,
        place_of_supply || null,
        short_code || null,
        is_active ? 1 : 0,
        id
      ]
    );

    req.flash('success', 'GST party updated');
    res.redirect('/accounts-challan/gst');
  } catch (err) {
    console.error('[ERROR] POST /accounts-challan/gst/:id:', err);
    req.flash('error', 'Failed to update GST party');
    res.redirect('/accounts-challan/gst');
  }
  }
);

module.exports = router;
