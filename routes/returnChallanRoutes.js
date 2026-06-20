// routes/returnChallanRoutes.js
//
// Return Challan dashboard — paper-challan logging surface for the
// returnchallan role. See sql/return_challan_tables.sql for the schema
// and ~/.claude/plans/prancy-mixing-hopcroft.md for design rationale.
//
// Image upload uses a presigned-PUT round-trip so the server never sees
// the bytes (utils/s3Client.generatePresignedPutUrl / generatePresignedUrl).
// Custom fields are shared across all returnchallan users via the
// return_challan_field_defs table; values live in JSON on each entry row.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isReturnChallan } = require('../middlewares/auth');
const {
  generatePresignedPutUrl,
  generatePresignedUrl,
} = require('../utils/s3Client');

router.use(isAuthenticated, isReturnChallan);

const PAGE_SIZE = 100;
const EDIT_WINDOW_HOURS = 7 * 24; // 7 days
const MAX_IMAGES_PER_CHALLAN = 15;

// ─── Helpers ──────────────────────────────────────────────────────────

// Indian fiscal year string: Apr 1 → Mar 31. Today (May 2026) → '2026-27'.
function currentFiscalYearRange(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  const start = m >= 3 ? y : y - 1; // Apr (idx 3) is the start
  const end = (start + 1) % 100;
  return `${start}-${String(end).padStart(2, '0')}`;
}

// Reserve the next counter under transaction lock — matches accountsChallanRoutes.
async function reserveNextCounter(yearRange) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, current_counter FROM return_challan_counters
        WHERE year_range = ? FOR UPDATE`,
      [yearRange]
    );
    let counter = 1;
    if (rows.length === 0) {
      await conn.query(
        `INSERT INTO return_challan_counters (year_range, current_counter)
         VALUES (?, 1)`,
        [yearRange]
      );
    } else {
      counter = rows[0].current_counter + 1;
      await conn.query(
        `UPDATE return_challan_counters SET current_counter = ? WHERE id = ?`,
        [counter, rows[0].id]
      );
    }
    await conn.commit();
    return counter;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function nextChallanNumber() {
  const year = currentFiscalYearRange();
  const n = await reserveNextCounter(year);
  return `RC/${year}/${String(n).padStart(5, '0')}`;
}

// Derive snake_case key from a human label.
function toFieldKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || `field_${Date.now().toString(36)}`;
}

async function getActiveFieldDefs() {
  const [rows] = await pool.query(
    `SELECT id, field_key, label, field_type, options_json, sort_order
       FROM return_challan_field_defs
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC`
  );
  return rows.map((r) => ({
    id: r.id,
    field_key: r.field_key,
    label: r.label,
    field_type: r.field_type,
    options: r.options_json ? safeJsonParse(r.options_json) : null,
    sort_order: r.sort_order,
  }));
}

function safeJsonParse(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function presignThumb(key) {
  if (!key) return Promise.resolve(null);
  return generatePresignedUrl(key, 3 * 24 * 3600).catch(() => null);
}

// Returns whether `created_at` is within the editable window.
function isEditable(createdAt) {
  if (!createdAt) return false;
  const ts = new Date(createdAt).getTime();
  return Date.now() - ts < EDIT_WINDOW_HOURS * 3600 * 1000;
}

// Coerce a value to the field type (best-effort, no throwing).
function coerceFieldValue(value, type) {
  if (value === undefined || value === null || value === '') return null;
  switch (type) {
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const s = String(value).toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    }
    case 'date': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    case 'select':
    case 'text':
    default:
      return String(value);
  }
}

// Trim/validate the base-field payload from a POST/PATCH body.
function cleanBaseFields(body) {
  const out = {};
  if ('description' in body) out.description = body.description == null ? null : String(body.description).slice(0, 5000);
  if ('qty' in body) out.qty = Number(body.qty) || 0;
  if ('category' in body) out.category = body.category == null ? null : String(body.category).slice(0, 120);
  if ('brand_name' in body) out.brand_name = body.brand_name == null ? null : String(body.brand_name).slice(0, 120);
  if ('is_branded' in body) out.is_branded = body.is_branded ? 1 : 0;
  if ('price' in body) out.price = Number(body.price) || 0;
  if ('image_s3_key' in body) out.image_s3_key = body.image_s3_key == null ? null : String(body.image_s3_key).slice(0, 500);
  if ('name' in body) out.name = body.name == null ? null : String(body.name).slice(0, 180);
  if ('challan_date' in body) {
    const d = body.challan_date ? new Date(body.challan_date) : null;
    out.challan_date = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
  }
  if ('punching_no' in body) out.punching_no = body.punching_no == null ? null : String(body.punching_no).slice(0, 80);
  if ('department' in body) out.department = body.department == null ? null : String(body.department).slice(0, 120);
  return out;
}

// Build the custom_data JSON from a body, restricted to active fields.
async function cleanCustomData(rawCustom) {
  const incoming = rawCustom && typeof rawCustom === 'object' ? rawCustom : {};
  const defs = await getActiveFieldDefs();
  const out = {};
  for (const def of defs) {
    if (def.field_key in incoming) {
      out[def.field_key] = coerceFieldValue(incoming[def.field_key], def.field_type);
    }
  }
  return out;
}

// ─── Page ─────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  res.render('returnChallanDashboard', { user: req.session.user });
});

// ─── Field definitions ────────────────────────────────────────────────

router.get('/api/fields', async (_req, res) => {
  try {
    const fields = await getActiveFieldDefs();
    res.json({ ok: true, fields });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({ ok: false, error: 'Run sql/return_challan_tables.sql first.', fields: [] });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/api/fields/all', async (_req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, field_key, label, field_type, options_json, is_active, sort_order, created_at
         FROM return_challan_field_defs
        ORDER BY sort_order ASC, id ASC`
    );
    const fields = rows.map((r) => ({
      id: r.id,
      field_key: r.field_key,
      label: r.label,
      field_type: r.field_type,
      options: r.options_json ? safeJsonParse(r.options_json) : null,
      is_active: !!r.is_active,
      sort_order: r.sort_order,
      created_at: r.created_at,
    }));
    res.json({ ok: true, fields });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/fields', async (req, res) => {
  try {
    const label = String(req.body.label || '').trim();
    const fieldType = String(req.body.field_type || 'text');
    const options = Array.isArray(req.body.options)
      ? req.body.options.map((s) => String(s).trim()).filter(Boolean)
      : null;
    if (!label) return res.status(400).json({ ok: false, error: 'Label is required.' });
    if (!['text', 'number', 'date', 'boolean', 'select'].includes(fieldType)) {
      return res.status(400).json({ ok: false, error: 'Invalid field_type.' });
    }
    if (fieldType === 'select' && (!options || !options.length)) {
      return res.status(400).json({ ok: false, error: 'Select fields need at least one option.' });
    }
    const fieldKey = toFieldKey(label);

    const [exists] = await pool.query(
      'SELECT id FROM return_challan_field_defs WHERE field_key = ?',
      [fieldKey]
    );
    if (exists.length) {
      return res.status(400).json({ ok: false, error: 'A field with this label already exists.' });
    }

    const [result] = await pool.query(
      `INSERT INTO return_challan_field_defs
         (field_key, label, field_type, options_json, is_active, sort_order, created_by)
       VALUES (?, ?, ?, ?, 1, 100, ?)`,
      [fieldKey, label, fieldType, options ? JSON.stringify(options) : null, req.session.user.id || null]
    );
    res.json({ ok: true, id: result.insertId, field_key: fieldKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/api/fields/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid id.' });

    const sets = [];
    const params = [];
    if ('label' in req.body && req.body.label != null) {
      sets.push('label = ?'); params.push(String(req.body.label).slice(0, 120));
    }
    if ('is_active' in req.body) {
      sets.push('is_active = ?'); params.push(req.body.is_active ? 1 : 0);
    }
    if ('sort_order' in req.body) {
      sets.push('sort_order = ?'); params.push(parseInt(req.body.sort_order, 10) || 100);
    }
    if ('options' in req.body && Array.isArray(req.body.options)) {
      sets.push('options_json = ?');
      params.push(JSON.stringify(req.body.options.map((s) => String(s).trim()).filter(Boolean)));
    }
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Nothing to update.' });
    params.push(id);
    await pool.query(`UPDATE return_challan_field_defs SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Departments ─────────────────────────────────────────────────────

// GET /return-challan/api/departments — names from the master departments table
// so the dashboard's Department field offers the standard, admin-managed list.
router.get('/api/departments', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name FROM departments ORDER BY name');
    res.json({ ok: true, departments: rows.map(r => r.name) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Image presigned upload ──────────────────────────────────────────

router.post('/api/image/sign', async (req, res) => {
  try {
    const contentType = String(req.body.content_type || 'image/jpeg');
    if (!/^image\/[a-z0-9+.-]+$/i.test(contentType)) {
      return res.status(400).json({ ok: false, error: 'Invalid content_type.' });
    }
    const ext = (req.body.ext && String(req.body.ext).replace(/[^a-z0-9]/gi, '').slice(0, 5)) ||
                contentType.split('/').pop().replace(/[^a-z0-9]/gi, '').slice(0, 5) ||
                'jpg';
    const today = new Date().toISOString().slice(0, 10);
    const uuid = crypto.randomUUID();
    const key = `return-challans/${today}/${uuid}.${ext}`;
    const url = await generatePresignedPutUrl(key, contentType, 900);
    if (!url) return res.status(500).json({ ok: false, error: 'Could not sign URL.' });
    res.json({ ok: true, url, key });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Returns a fresh presigned GET URL for the entry's image (3-day TTL).
router.get('/api/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid id.' });
    const [[row]] = await pool.query(
      'SELECT image_s3_key FROM return_challans WHERE id = ?', [id]
    );
    if (!row || !row.image_s3_key) return res.status(404).json({ ok: false, error: 'No image.' });
    const url = await generatePresignedUrl(row.image_s3_key, 3 * 24 * 3600);
    if (!url) return res.status(500).json({ ok: false, error: 'Could not sign.' });
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Entries ─────────────────────────────────────────────────────────

router.get('/api/entries', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const search = String(req.query.search || '').trim();
    const offset = (page - 1) * PAGE_SIZE;

    const whereParams = [];
    let where = 'WHERE 1=1';
    if (search) {
      where += ` AND (
        c.challan_no LIKE ? OR c.description LIKE ? OR c.category LIKE ? OR
        c.brand_name LIKE ? OR c.name LIKE ? OR c.punching_no LIKE ? OR
        c.department LIKE ?
      )`;
      const like = `%${search}%`;
      for (let i = 0; i < 7; i++) whereParams.push(like);
    }

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM return_challans c ${where}`,
      whereParams
    );

    const [rows] = await pool.query(
      `SELECT c.*, u.username AS created_by_username
         FROM return_challans c
         LEFT JOIN users u ON u.id = c.created_by
         ${where}
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      [...whereParams, PAGE_SIZE, offset]
    );

    // Fetch v2 child images for this page in one query.
    const ids = rows.map(r => r.id);
    let imagesByChallan = {};
    if (ids.length) {
      const [imgRows] = await pool.query(
        `SELECT id, challan_id, s3_key, sort_order
           FROM return_challan_images
          WHERE challan_id IN (?)
          ORDER BY challan_id, sort_order ASC, id ASC`,
        [ids]
      );
      // Presign in parallel
      const signed = await Promise.all(imgRows.map(async (ir) => ({
        ...ir,
        url: await generatePresignedUrl(ir.s3_key, 3 * 24 * 3600).catch(() => null),
      })));
      for (const ir of signed) {
        (imagesByChallan[ir.challan_id] = imagesByChallan[ir.challan_id] || []).push({
          id: ir.id,
          key: ir.s3_key,
          url: ir.url,
        });
      }
    }

    // Build items. Back-compat: if row has no v2 images but a legacy
    // image_s3_key, surface it as a single-element images[] so v1 entries
    // still render.
    const items = await Promise.all(rows.map(async (r) => {
      let images = imagesByChallan[r.id] || [];
      if (!images.length && r.image_s3_key) {
        const url = await presignThumb(r.image_s3_key);
        images = [{ id: null, key: r.image_s3_key, url }];
      }
      const first = images[0] || null;
      return {
        id: r.id,
        challan_no: r.challan_no,
        description: r.description,
        qty: Number(r.qty),
        category: r.category,
        brand_name: r.brand_name,
        is_branded: !!r.is_branded,
        price: Number(r.price),
        image_s3_key: r.image_s3_key, // legacy single-image column (back-compat)
        thumbnail_url: first ? first.url : null, // back-compat alias
        images, // v2: [{id, key, url}]
        image_count: images.length,
        name: r.name,
        challan_date: r.challan_date,
        punching_no: r.punching_no,
        department: r.department,
        custom_data: r.custom_data ? safeJsonParse(r.custom_data) : {},
        created_by: r.created_by,
        created_by_username: r.created_by_username,
        created_at: r.created_at,
        updated_at: r.updated_at,
        editable: isEditable(r.created_at),
      };
    }));

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    res.json({
      ok: true,
      items,
      page,
      total_pages: totalPages,
      total,
      page_size: PAGE_SIZE,
    });
  } catch (err) {
    if (/doesn'?t exist|Unknown table/i.test(err.message)) {
      return res.json({
        ok: false, items: [], total: 0, total_pages: 0, page: 1,
        warning: 'Run sql/return_challan_tables.sql first.',
      });
    }
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/api/entries', async (req, res) => {
  let conn;
  try {
    const base = cleanBaseFields(req.body);
    const customData = await cleanCustomData(req.body.custom_data);

    // v2: array of S3 keys for the entry's images, max 15.
    const imageKeys = Array.isArray(req.body.image_s3_keys)
      ? req.body.image_s3_keys
          .map(k => (k == null ? '' : String(k).trim()))
          .filter(Boolean)
      : [];
    if (imageKeys.length > MAX_IMAGES_PER_CHALLAN) {
      return res.status(400).json({
        ok: false,
        error: `Maximum ${MAX_IMAGES_PER_CHALLAN} images per challan.`,
      });
    }

    const challanNo = await nextChallanNumber();

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Back-compat: if no v2 array provided but legacy single key is, keep it
    // in the legacy column. Otherwise leave NULL (v2 entries live in the
    // child table only).
    const legacyKey = imageKeys.length === 0 ? (base.image_s3_key || null) : null;

    const [result] = await conn.query(
      `INSERT INTO return_challans
         (challan_no, description, qty, category, brand_name, is_branded,
          price, image_s3_key, name, challan_date, punching_no, department,
          custom_data, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        challanNo,
        base.description || null,
        base.qty || 0,
        base.category || null,
        base.brand_name || null,
        base.is_branded || 0,
        base.price || 0,
        legacyKey,
        base.name || null,
        base.challan_date || null,
        base.punching_no || null,
        base.department || null,
        Object.keys(customData).length ? JSON.stringify(customData) : null,
        req.session.user.id,
      ]
    );
    const challanId = result.insertId;

    if (imageKeys.length) {
      const rows = imageKeys.map((key, idx) => [
        challanId, key, (idx + 1) * 10, req.session.user.id,
      ]);
      await conn.query(
        `INSERT INTO return_challan_images
           (challan_id, s3_key, sort_order, uploaded_by)
         VALUES ?`,
        [rows]
      );
    }

    await conn.commit();
    res.json({ ok: true, id: challanId, challan_no: challanNo, image_count: imageKeys.length });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[return-challan] create error', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

router.patch('/api/entries/:id', async (req, res) => {
  let conn;
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid id.' });

    const base = cleanBaseFields(req.body);
    const customData = await cleanCustomData(req.body.custom_data);

    // v2: image add/remove arrays
    const imagesToAdd = Array.isArray(req.body.images_to_add)
      ? req.body.images_to_add.map(k => (k == null ? '' : String(k).trim())).filter(Boolean)
      : [];
    const imagesToRemove = Array.isArray(req.body.images_to_remove)
      ? req.body.images_to_remove.map(n => parseInt(n, 10)).filter(n => Number.isFinite(n) && n > 0)
      : [];

    const hasImageChanges = imagesToAdd.length > 0 || imagesToRemove.length > 0;
    const hasBaseChanges = Object.keys(base).length > 0 || req.body.custom_data !== undefined;
    if (!hasImageChanges && !hasBaseChanges) {
      return res.status(400).json({ ok: false, error: 'Nothing to update.' });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Edit-window guard: lock the row and verify created_at is within the window.
    const [[entry]] = await conn.query(
      `SELECT id, created_at FROM return_challans
        WHERE id = ?
          AND created_at > (NOW() - INTERVAL ? HOUR)
        FOR UPDATE`,
      [id, EDIT_WINDOW_HOURS]
    );
    if (!entry) {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        error: `Edit window passed (entries can only be edited within ${EDIT_WINDOW_HOURS / 24} days).`,
      });
    }

    // Base + custom field UPDATE (only if requested)
    if (hasBaseChanges) {
      const sets = [];
      const params = [];
      for (const [col, val] of Object.entries(base)) {
        sets.push(`${col} = ?`);
        params.push(val === undefined ? null : val);
      }
      if (req.body.custom_data !== undefined) {
        sets.push('custom_data = ?');
        params.push(Object.keys(customData).length ? JSON.stringify(customData) : null);
      }
      if (sets.length) {
        params.push(id);
        await conn.query(
          `UPDATE return_challans SET ${sets.join(', ')} WHERE id = ?`,
          params
        );
      }
    }

    // Image removals — scoped to this challan to prevent cross-challan tampering.
    if (imagesToRemove.length) {
      await conn.query(
        `DELETE FROM return_challan_images
          WHERE challan_id = ? AND id IN (?)`,
        [id, imagesToRemove]
      );
    }

    // Image additions — append after current max sort_order.
    if (imagesToAdd.length) {
      const [[maxRow]] = await conn.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS m
           FROM return_challan_images WHERE challan_id = ?`,
        [id]
      );
      const baseSort = Number(maxRow.m) || 0;
      const rows = imagesToAdd.map((key, idx) => [
        id, key, baseSort + (idx + 1) * 10, req.session.user.id,
      ]);
      await conn.query(
        `INSERT INTO return_challan_images
           (challan_id, s3_key, sort_order, uploaded_by)
         VALUES ?`,
        [rows]
      );
    }

    // Enforce 15-image cap after applying all changes.
    if (hasImageChanges) {
      const [[cntRow]] = await conn.query(
        `SELECT COUNT(*) AS n FROM return_challan_images WHERE challan_id = ?`,
        [id]
      );
      if (Number(cntRow.n) > MAX_IMAGES_PER_CHALLAN) {
        await conn.rollback();
        return res.status(400).json({
          ok: false,
          error: `Maximum ${MAX_IMAGES_PER_CHALLAN} images per challan (have ${cntRow.n}).`,
        });
      }
    }

    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) try { await conn.rollback(); } catch (_) {}
    console.error('[return-challan] edit error', err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ─── Excel export ────────────────────────────────────────────────────

router.get('/export.xlsx', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const fromRaw = String(req.query.from || '').trim();
    const toRaw   = String(req.query.to   || '').trim();
    // date_field: 'challan_date' (paper date) or 'created_at' (system entry).
    // Bad values fall back to challan_date silently so the download still works.
    const allowedDateFields = new Set(['challan_date', 'created_at']);
    const dateField = allowedDateFields.has(String(req.query.date_field || ''))
      ? String(req.query.date_field)
      : 'challan_date';
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = isoRe.test(fromRaw) ? fromRaw : null;
    const to   = isoRe.test(toRaw)   ? toRaw   : null;

    const params = [];
    let where = 'WHERE 1=1';
    if (search) {
      where += ` AND (
        c.challan_no LIKE ? OR c.description LIKE ? OR c.category LIKE ? OR
        c.brand_name LIKE ? OR c.name LIKE ? OR c.punching_no LIKE ? OR
        c.department LIKE ?
      )`;
      const like = `%${search}%`;
      for (let i = 0; i < 7; i++) params.push(like);
    }
    if (from) {
      where += ` AND c.${dateField} >= ?`;
      params.push(from);
    }
    if (to) {
      // DATE_ADD makes `to` inclusive even when dateField is a DATETIME.
      where += ` AND c.${dateField} < DATE_ADD(?, INTERVAL 1 DAY)`;
      params.push(to);
    }

    const [rows] = await pool.query(
      `SELECT c.*, u.username AS created_by_username
         FROM return_challans c
         LEFT JOIN users u ON u.id = c.created_by
         ${where}
        ORDER BY c.created_at DESC, c.id DESC`,
      params
    );

    // Fan out child images for image count + key list columns.
    const ids = rows.map(r => r.id);
    let imagesByChallan = {};
    if (ids.length) {
      const [imgRows] = await pool.query(
        `SELECT challan_id, s3_key, sort_order
           FROM return_challan_images
          WHERE challan_id IN (?)
          ORDER BY challan_id, sort_order ASC, id ASC`,
        [ids]
      );
      for (const ir of imgRows) {
        (imagesByChallan[ir.challan_id] = imagesByChallan[ir.challan_id] || []).push(ir.s3_key);
      }
    }

    const fields = await getActiveFieldDefs();

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kotty Track';
    wb.created = new Date();
    const ws = wb.addWorksheet('Return Challans');

    const baseCols = [
      { header: 'Challan No', key: 'challan_no', width: 22 },
      { header: 'Date',       key: 'challan_date', width: 12 },
      { header: 'Name',       key: 'name', width: 22 },
      { header: 'Description',key: 'description', width: 36 },
      { header: 'Category',   key: 'category', width: 18 },
      { header: 'Brand',      key: 'brand_name', width: 18 },
      { header: 'Branded?',   key: 'is_branded', width: 10 },
      { header: 'Qty',        key: 'qty', width: 10 },
      { header: 'Price',      key: 'price', width: 12 },
      { header: 'Punching No',key: 'punching_no', width: 14 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Image Count',key: 'image_count', width: 12 },
      { header: 'Image Keys', key: 'image_keys', width: 60 },
    ];
    const customCols = fields.map((f) => ({
      header: f.label, key: `custom__${f.field_key}`, width: 18,
    }));
    const auditCols = [
      { header: 'Created By', key: 'created_by_username', width: 16 },
      { header: 'Created At', key: 'created_at_str', width: 20 },
    ];
    ws.columns = [...baseCols, ...customCols, ...auditCols];
    ws.getRow(1).font = { bold: true };

    rows.forEach((r) => {
      const custom = r.custom_data ? safeJsonParse(r.custom_data) || {} : {};
      const customCells = {};
      fields.forEach((f) => {
        customCells[`custom__${f.field_key}`] = custom[f.field_key] == null ? '' : custom[f.field_key];
      });
      // Aggregate image keys: child rows (v2) + legacy single column (back-compat)
      const childKeys = imagesByChallan[r.id] || [];
      const allKeys = childKeys.length ? childKeys : (r.image_s3_key ? [r.image_s3_key] : []);
      ws.addRow({
        challan_no:   r.challan_no,
        challan_date: r.challan_date ? new Date(r.challan_date).toISOString().slice(0, 10) : '',
        name:         r.name || '',
        description:  r.description || '',
        category:     r.category || '',
        brand_name:   r.brand_name || '',
        is_branded:   r.is_branded ? 'Yes' : 'No',
        qty:          Number(r.qty) || 0,
        price:        Number(r.price) || 0,
        punching_no:  r.punching_no || '',
        department:   r.department || '',
        image_count:  allKeys.length,
        image_keys:   allKeys.join(', '),
        ...customCells,
        created_by_username: r.created_by_username || '',
        created_at_str: r.created_at ? new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19) : '',
      });
    });

    const fname = `return_challans_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('[return-challan] export error', err);
    res.status(500).send('Export failed: ' + err.message);
  }
});

module.exports = router;
