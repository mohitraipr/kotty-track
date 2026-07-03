// QC-Capture extension ingestion API (docs/plans/01-qcpass-extension.md).
// Token-based (no session/cookie), mounted BEFORE the session middleware in app.js so any
// Cloud Run instance can serve it. Restricted to users holding the `jitrgp` role.
const express = require('express');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { pool } = require('../config/db');
const { generateToken, hashToken, normalizeCapture, normalizePass } = require('../utils/qcExtAuth');

const router = express.Router();
const REQUIRED_ROLE = 'jitrgp';
const MAX_BATCH = 500;

// Token auth carries no cookie, so there's nothing to CSRF/steal — allow the extension origin.
// Tighten to the fixed chrome-extension://<id> once the extension is published.
router.use(cors({ origin: true, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-qc-token'] }));

// A user "has" the role via their primary role_id OR a user_roles grant.
async function userHasRole(userId, roleName) {
  const [rows] = await pool.query(
    `SELECT 1 FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? AND r.name = ?
      UNION
     SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = ?
      LIMIT 1`,
    [userId, roleName, userId, roleName]
  );
  return rows.length > 0;
}

// POST /ext/qc/login  { username, password, device_label? } -> { ok, token, user }
router.post('/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });

    const [users] = await pool.query(
      'SELECT id, username, password FROM users WHERE username = ? AND is_active = TRUE', [username]);
    const user = users[0];
    const ok = user && (await bcrypt.compare(password, user.password));
    if (!ok) return res.status(401).json({ ok: false, error: 'invalid credentials' });
    if (!(await userHasRole(user.id, REQUIRED_ROLE))) {
      return res.status(403).json({ ok: false, error: `role '${REQUIRED_ROLE}' required` });
    }
    const raw = generateToken();
    await pool.query(
      'INSERT INTO qc_ext_tokens (token_hash, user_id, device_label) VALUES (?, ?, ?)',
      [hashToken(raw), user.id, String(req.body.device_label || '').slice(0, 80) || null]);
    return res.json({ ok: true, token: raw, user: { id: user.id, username: user.username } });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Bearer / x-qc-token -> req.qcUser. 401 (token) is distinct from 403 (role) so the extension
// can tell "re-login" from "not authorized".
async function requireQcToken(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    const raw = auth.startsWith('Bearer ') ? auth.slice(7) : (req.get('x-qc-token') || '');
    if (!raw) return res.status(401).json({ ok: false, error: 'missing token' });
    const [rows] = await pool.query(
      `SELECT t.id, t.user_id, u.username FROM qc_ext_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.is_active = TRUE`,
      [hashToken(raw)]);
    if (!rows.length) return res.status(401).json({ ok: false, error: 'invalid or revoked token' });
    if (!(await userHasRole(rows[0].user_id, REQUIRED_ROLE))) {
      return res.status(403).json({ ok: false, error: `role '${REQUIRED_ROLE}' required` });
    }
    req.qcUser = { id: rows[0].user_id, username: rows[0].username, tokenId: rows[0].id };
    pool.query('UPDATE qc_ext_tokens SET last_used_at = NOW() WHERE id = ?', [rows[0].id]).catch(() => {});
    return next();
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /ext/qc/capture  { records:[{ _type:'capture'|'pass', capture_uid, ... }] } -> { ok, accepted }
// Idempotent (capture_uid PK + no-op upsert) and transactional — responds 200 only after commit,
// which satisfies the extension's "remove from queue only after the backend confirms" contract.
router.post('/capture', requireQcToken, async (req, res) => {
  const records = Array.isArray(req.body.records) ? req.body.records : null;
  if (!records) return res.status(400).json({ ok: false, error: 'records[] required' });
  if (records.length > MAX_BATCH) return res.status(413).json({ ok: false, error: `batch too large (max ${MAX_BATCH})` });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let accepted = 0;
    for (const rec of records) {
      if (rec && rec._type === 'pass') {
        const r = normalizePass(rec, req.qcUser.id);
        await conn.query(
          `INSERT INTO qc_return_passes
             (capture_uid, passed_by, item_barcode, oms_release_id, qc_action, quality, desk_code,
              warehouse_id, pass_success, new_status, pass_error, passed_at, raw_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE ingested_at = ingested_at`,
          [r.capture_uid, r.passed_by, r.item_barcode, r.oms_release_id, r.qc_action, r.quality,
           r.desk_code, r.warehouse_id, r.pass_success, r.new_status, r.pass_error, r.passed_at, r.raw_json]);
      } else {
        const r = normalizeCapture(rec, req.qcUser.id);
        await conn.query(
          `INSERT INTO qc_return_captures
             (capture_uid, captured_by, return_id, item_barcode, tracking_number, oms_release_id,
              sku_id, sku_code, style_id, article_no, product_name, size, price, return_type,
              return_mode, return_status, rms_status, qc_action, quality, logistics_status,
              courier_code, return_hub, dispatch_wh, return_destination_wh, delivery_center,
              ship_city, created_date, refund_date, return_received_on, return_restocked_on,
              raw_json, captured_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE ingested_at = ingested_at`,
          [r.capture_uid, r.captured_by, r.return_id, r.item_barcode, r.tracking_number, r.oms_release_id,
           r.sku_id, r.sku_code, r.style_id, r.article_no, r.product_name, r.size, r.price, r.return_type,
           r.return_mode, r.return_status, r.rms_status, r.qc_action, r.quality, r.logistics_status,
           r.courier_code, r.return_hub, r.dispatch_wh, r.return_destination_wh, r.delivery_center,
           r.ship_city, r.created_date, r.refund_date, r.return_received_on, r.return_restocked_on,
           r.raw_json, r.captured_at]);
      }
      accepted += 1;
    }
    await conn.commit();
    return res.json({ ok: true, accepted });
  } catch (e) {
    await conn.rollback().catch(() => {});
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    conn.release();
  }
});

module.exports = { router, requireQcToken };
