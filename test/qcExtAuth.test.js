const { test } = require('node:test');
const assert = require('node:assert');
const {
  generateToken, hashToken, deriveCaptureUid, normalizeCapture, normalizePass,
} = require('../utils/qcExtAuth.js');

test('generateToken: 64 hex chars, unique per call', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(a, b);
});

test('hashToken: deterministic sha256 hex, raw != hash', () => {
  assert.strictEqual(hashToken('abc'), hashToken('abc'));
  assert.match(hashToken('abc'), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hashToken('abc'), 'abc');
  assert.notStrictEqual(hashToken('abc'), hashToken('abd'));
});

test('deriveCaptureUid: keyed on the return item, NOT the timestamp (re-search dedups)', () => {
  // Same return item searched at two different times -> SAME uid -> upserts one row.
  const t1 = deriveCaptureUid({ return_id: 'R1', item_barcode: 'B1', captured_at: '2026-07-03T10:00:00Z', _type: 'capture' });
  const t2 = deriveCaptureUid({ return_id: 'R1', item_barcode: 'B1', captured_at: '2026-07-03T15:30:00Z', _type: 'capture' });
  assert.strictEqual(t1, t2);                         // timestamp excluded from the key
  // Different item -> different uid.
  const other = deriveCaptureUid({ return_id: 'R1', item_barcode: 'B2', _type: 'capture' });
  assert.notStrictEqual(t1, other);
  // Pass is a separate namespace, keyed on item_barcode + oms (not passed_at).
  const p1 = deriveCaptureUid({ item_barcode: 'B1', oms_release_id: 'O1', passed_at: 'x', _type: 'pass' });
  const p2 = deriveCaptureUid({ item_barcode: 'B1', oms_release_id: 'O1', passed_at: 'y', _type: 'pass' });
  assert.strictEqual(p1, p2);
  assert.notStrictEqual(t1, p1);
  assert.match(t1, /^[0-9a-f]{64}$/);
});

test('normalizeCapture: maps + truncates fields, derives capture_uid, keeps raw_json', () => {
  const rec = {
    return_id: 'R1', item_barcode: 'B1', price: '499.5', size: 'XL',
    product_name: 'x'.repeat(400), created_date: '2026-07-01T00:00:00Z', captured_at: '2026-07-03T10:00:00Z',
    qc_action: 'QC_PASS', logistics_status: 'DELIVERED_TO_SELLER',
  };
  const r = normalizeCapture(rec, 42);
  assert.strictEqual(r.captured_by, 42);
  assert.match(r.capture_uid, /^[0-9a-f]{64}$/);
  assert.strictEqual(r.price, 499.5);
  assert.strictEqual(r.product_name.length, 255);    // truncated to column width
  assert.strictEqual(r.created_date, '2026-07-01');  // DATE only
  assert.ok(r.captured_at instanceof Date);
  assert.deepStrictEqual(JSON.parse(r.raw_json).return_id, 'R1');
});

test('normalizeCapture: server derives the key (ignores client capture_uid); null-safe', () => {
  const withClientUid = normalizeCapture({ capture_uid: 'attacker-supplied', return_id: 'R1', item_barcode: 'B1' }, 1);
  const derived = deriveCaptureUid({ return_id: 'R1', item_barcode: 'B1', _type: 'capture' });
  assert.strictEqual(withClientUid.capture_uid, derived); // client uid ignored -> deterministic
  const r = normalizeCapture({ return_id: 'R', item_barcode: '' }, 1);
  assert.strictEqual(r.item_barcode, null);          // '' -> null
  assert.strictEqual(r.price, null);                 // missing -> null
  assert.strictEqual(r.captured_at, null);
});

test('normalizePass: pass_success coerced to 1/0, fields mapped', () => {
  const ok = normalizePass({ item_barcode: 'B1', pass_success: true, new_status: 'RESTOCKED', passed_at: '2026-07-03T10:00:00Z' }, 7);
  assert.strictEqual(ok.passed_by, 7);
  assert.strictEqual(ok.pass_success, 1);
  assert.strictEqual(ok.new_status, 'RESTOCKED');
  const bad = normalizePass({ item_barcode: 'B1', pass_success: false }, 7);
  assert.strictEqual(bad.pass_success, 0);
  assert.match(ok.capture_uid, /^[0-9a-f]{64}$/);
});
