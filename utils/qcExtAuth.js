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

// Deterministic idempotency key derived from the RETURN ITEM ITSELF (not the search moment),
// so re-searching the same return upserts one row instead of creating duplicates, and the same
// record arriving via API batch or CSV re-upload always dedupes to the same key.
//   capture -> return_id + item_barcode   (one row per return item; latest state wins)
//   pass    -> item_barcode + oms_release  (one pass event per item)
// NOTE: timestamps are intentionally excluded from the key (that was the pre-#486-fix bug where
// searching a return twice made two rows). The server always derives this — client-sent
// capture_uid is ignored for dedup so a stale/mismatched client formula can't reintroduce dupes.
function deriveCaptureUid(rec) {
  const type = rec._type === 'pass' ? 'pass' : 'capture';
  const key = type === 'pass'
    ? [rec.item_barcode, rec.oms_release_id].join('|')
    : [rec.return_id, rec.item_barcode].join('|');
  return crypto.createHash('sha256').update(type + '|' + key).digest('hex');
}

const S = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
const NUM = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const DAY = (v) => { if (!v) return null; const s = String(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const DT = (v) => { if (!v) return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

function normalizeCapture(rec, capturedBy) {
  const r = rec || {};
  return {
    capture_uid: deriveCaptureUid({ ...r, _type: 'capture' }), // server-derived (client uid ignored)
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
    capture_uid: deriveCaptureUid({ ...r, _type: 'pass' }), // server-derived (client uid ignored)
    passed_by: passedBy,
    item_barcode: S(r.item_barcode, 60), oms_release_id: S(r.oms_release_id, 40),
    qc_action: S(r.qc_action, 40), quality: S(r.quality, 20), desk_code: S(r.desk_code, 20),
    warehouse_id: S(r.warehouse_id, 40),
    pass_success: r.pass_success ? 1 : 0, new_status: S(r.new_status, 40),
    pass_error: S(r.pass_error, 255), passed_at: DT(r.passed_at), raw_json: JSON.stringify(r),
  };
}

// An errored search (RMS "No Data Found" etc.). Keyed on the tracking number the operator
// scanned (server-trusted `searchedBy`), so re-scanning the same bad tracking upserts one row.
function normalizeSearchError(rec, searchedBy) {
  const r = rec || {};
  return {
    tracking_number: S(r.tracking_number, 120),
    searched_by: searchedBy,
    search_status: S(r.search_status, 60),
    error_reason: S(r.error_reason, 255),
    raw_json: JSON.stringify(r),
    searched_at: DT(r.searched_at),
  };
}

module.exports = { generateToken, hashToken, deriveCaptureUid, normalizeCapture, normalizePass, normalizeSearchError };
