// Pure helpers for the QC-Capture extension ingestion (docs/plans/01-qcpass-extension.md).
// No DB here — token hashing, dedupe-id derivation, and record normalization are all pure
// and unit-tested (test/qcExtAuth.test.js).
const crypto = require('crypto');

// Raw bearer token given to the extension once at login (64 hex chars).
function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
// Only the hash is stored server-side; the raw token is never persisted.
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Stable idempotency key per record. The extension should send `capture_uid`; if absent we
// derive a deterministic one from the record's identifying fields so retries never double-insert.
function deriveCaptureUid(rec) {
  const type = rec._type === 'pass' ? 'pass' : 'capture';
  const key = type === 'pass'
    ? [rec.item_barcode, rec.oms_release_id, rec.passed_at].join('|')
    : [rec.return_id, rec.item_barcode, rec.captured_at].join('|');
  return crypto.createHash('sha256').update(type + '|' + key).digest('hex');
}

const S = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const NUM = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const DAY = (v) => { if (!v) return null; const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const DT = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

function normalizeCapture(rec, capturedBy) {
  const r = rec || {};
  return {
    capture_uid: r.capture_uid || deriveCaptureUid({ ...r, _type: 'capture' }),
    captured_by: capturedBy,
    return_id: S(r.return_id, 40), item_barcode: S(r.item_barcode, 60),
    tracking_number: S(r.tracking_number, 80), oms_release_id: S(r.oms_release_id, 40),
    sku_id: S(r.sku_id, 40), sku_code: S(r.sku_code, 80), style_id: S(r.style_id, 40),
    article_no: S(r.article_no, 80), product_name: S(r.product_name, 255),
    size: S(r.size, 20), price: NUM(r.price),
    return_type: S(r.return_type, 40), return_mode: S(r.return_mode, 40),
    return_status: S(r.return_status, 40), rms_status: S(r.rms_status, 40),
    qc_action: S(r.qc_action, 40), quality: S(r.quality, 20),
    logistics_status: S(r.logistics_status, 60), courier_code: S(r.courier_code, 40),
    return_hub: S(r.return_hub, 40), dispatch_wh: S(r.dispatch_wh, 40),
    return_destination_wh: S(r.return_destination_wh, 40), delivery_center: S(r.delivery_center, 40),
    ship_city: S(r.ship_city, 80),
    created_date: DAY(r.created_date), refund_date: DAY(r.refund_date),
    return_received_on: DAY(r.return_received_on), return_restocked_on: DAY(r.return_restocked_on),
    raw_json: JSON.stringify(r), captured_at: DT(r.captured_at),
  };
}

function normalizePass(rec, passedBy) {
  const r = rec || {};
  return {
    capture_uid: r.capture_uid || deriveCaptureUid({ ...r, _type: 'pass' }),
    passed_by: passedBy,
    item_barcode: S(r.item_barcode, 60), oms_release_id: S(r.oms_release_id, 40),
    qc_action: S(r.qc_action, 40), quality: S(r.quality, 20), desk_code: S(r.desk_code, 20),
    warehouse_id: S(r.warehouse_id, 40),
    pass_success: r.pass_success ? 1 : 0, new_status: S(r.new_status, 40),
    pass_error: S(r.pass_error, 255), passed_at: DT(r.passed_at), raw_json: JSON.stringify(r),
  };
}

module.exports = { generateToken, hashToken, deriveCaptureUid, normalizeCapture, normalizePass };
