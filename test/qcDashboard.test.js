const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildPassesQuery,
  summarizeByUser,
  rowsToCsv,
  csvField,
  istToday,
} = require('../utils/qcDashboard.js');

// ---------------------------------------------------------------------------
// buildPassesQuery  (CAPTURES-based: base table qc_return_captures c)
// ---------------------------------------------------------------------------

test('buildPassesQuery defaults to today (IST) when no dates given', () => {
  const today = istToday();
  const { sql, params, from, to } = buildPassesQuery({});
  assert.strictEqual(from, today);
  assert.strictEqual(to, today);
  // date range is on the captured day (captured_at, falling back to ingested_at)
  assert.ok(/DATE\(COALESCE\(c\.captured_at, c\.ingested_at\)\) BETWEEN \? AND \?/.test(sql));
  assert.deepStrictEqual(params, [today, today]);
});

test('buildPassesQuery is captures-based and joins passes on item_barcode (not capture_uid)', () => {
  const { sql } = buildPassesQuery({});
  assert.ok(/FROM qc_return_captures c/.test(sql), 'base table must be captures');
  assert.ok(/LEFT JOIN[\s\S]*qc_return_passes[\s\S]*p ON p\.item_barcode = c\.item_barcode/.test(sql),
    'passes must join on item_barcode');
  assert.ok(!/c\.capture_uid = p\.capture_uid/.test(sql), 'must NOT join on capture_uid (never matches)');
  // product detail comes natively from the capture row
  assert.ok(/c\.sku_code\s+AS sku_code/.test(sql));
  assert.ok(/c\.tracking_number\s+AS tracking_number/.test(sql));
  assert.ok(/p\.pass_success\s+AS pass_success/.test(sql));
});

test('buildPassesQuery honours explicit valid from/to and ignores malformed dates', () => {
  const ok = buildPassesQuery({ from: '2026-06-01', to: '2026-06-30' });
  assert.strictEqual(ok.from, '2026-06-01');
  assert.strictEqual(ok.to, '2026-06-30');
  assert.deepStrictEqual(ok.params, ['2026-06-01', '2026-06-30']);

  // A malformed date falls back to today rather than being interpolated.
  const bad = buildPassesQuery({ from: "2026-06-01'; DROP TABLE x;--", to: 'nope' });
  const today = istToday();
  assert.strictEqual(bad.from, today);
  assert.strictEqual(bad.to, today);
});

test('buildPassesQuery adds a WHERE + param for each scalar filter', () => {
  const cases = [
    ['user', 'u.username = ?'],
    ['quality', 'c.quality = ?'],
    ['qc_action', 'c.qc_action = ?'],
    ['warehouse', 'c.return_destination_wh = ?'],
  ];
  for (const [key, clause] of cases) {
    const { sql, params } = buildPassesQuery({ [key]: 'X' });
    assert.ok(sql.includes(clause), `expected clause "${clause}" for filter "${key}"`);
    // two date params + this one
    assert.strictEqual(params.length, 3, `filter "${key}" should add exactly one param`);
    assert.strictEqual(params[2], 'X');
  }
});

test('buildPassesQuery trims filter values and skips empty/whitespace filters', () => {
  const withVal = buildPassesQuery({ user: '  alice  ', quality: '', warehouse: '   ' });
  // only `user` should survive; quality/warehouse are blank
  assert.strictEqual(withVal.params.length, 3);
  assert.strictEqual(withVal.params[2], 'alice');
  assert.ok(!withVal.sql.includes('c.quality = ?'));
  assert.ok(!withVal.sql.includes('c.return_destination_wh = ?'));
});

test('buildPassesQuery q produces a grouped OR LIKE with five params', () => {
  const { sql, params } = buildPassesQuery({ q: 'abc' });
  assert.ok(
    sql.includes(
      '(c.sku_code LIKE ? OR c.style_id LIKE ? OR c.item_barcode LIKE ? OR c.tracking_number LIKE ? OR c.product_name LIKE ?)'
    ),
    'q should be a single parenthesized OR group across the 5 searchable columns'
  );
  // two date params + five LIKE params, each wrapped with %...%
  assert.strictEqual(params.length, 7);
  assert.deepStrictEqual(params.slice(2), ['%abc%', '%abc%', '%abc%', '%abc%', '%abc%']);
});

test('buildPassesQuery combines all filters in order and never inlines user input', () => {
  const { sql, params } = buildPassesQuery({
    from: '2026-01-01',
    to: '2026-01-31',
    user: 'bob',
    quality: 'Q1',
    qc_action: 'QC_PASS',
    warehouse: 'WH1',
    q: 'jean',
  });
  assert.deepStrictEqual(params, [
    '2026-01-01', '2026-01-31',
    'bob', 'Q1', 'QC_PASS', 'WH1',
    '%jean%', '%jean%', '%jean%', '%jean%', '%jean%',
  ]);
  // No raw user values embedded in the SQL text (only placeholders).
  for (const v of ['bob', 'Q1', 'QC_PASS', 'WH1', 'jean']) {
    assert.ok(!sql.includes(v), `value "${v}" must not be string-concatenated into SQL`);
  }
  // ordered by the captured timestamp, newest first
  assert.ok(sql.trim().endsWith('ORDER BY COALESCE(c.captured_at, c.ingested_at) DESC'));
});

// ---------------------------------------------------------------------------
// summarizeByUser  (per-user scan count)
// ---------------------------------------------------------------------------

test('summarizeByUser groups rows into per-user counts, busiest first', () => {
  const rows = [
    { username: 'alice' },
    { username: 'bob' },
    { username: 'alice' },
    { username: 'alice' },
    { username: 'bob' },
  ];
  assert.deepStrictEqual(summarizeByUser(rows), [
    { user: 'alice', passes: 3 },
    { user: 'bob', passes: 2 },
  ]);
});

test('summarizeByUser labels missing usernames and handles empty input', () => {
  assert.deepStrictEqual(summarizeByUser([]), []);
  assert.deepStrictEqual(summarizeByUser([{ username: null }]), [
    { user: '(unknown)', passes: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// rowsToCsv / csvField
// ---------------------------------------------------------------------------

test('rowsToCsv emits the full header row in the fixed column order', () => {
  const csv = rowsToCsv([]);
  assert.strictEqual(
    csv,
    'captured_at,username,tracking_number,item_barcode,product_name,article_no,style_id,size,price,' +
    'return_type,return_mode,return_status,rms_status,qc_action,quality,created_date,refund_date,' +
    'return_received_on,return_restocked_on,logistics_status,courier_code,return_hub,dispatch_wh,' +
    'return_destination_wh,delivery_center,ship_city,return_id,oms_release_id,sku_id,sku_code,' +
    'pass_success,passed_at'
  );
});

test('rowsToCsv escapes commas, quotes and newlines and includes article_no', () => {
  const csv = rowsToCsv([
    {
      username: 'alice',
      item_barcode: 'BC,1',
      tracking_number: 'TN"x"',
      product_name: 'line1\nline2',
      article_no: 'KTTWOMENSPANT261L',
      pass_success: 1,
    },
  ]);
  // header + one data line (the embedded \n is inside quotes, so still 2 CRLF records)
  const records = csv.split('\r\n');
  assert.strictEqual(records.length, 2);
  const line = records[1];
  assert.ok(line.includes('"BC,1"'), 'comma value quoted');
  assert.ok(line.includes('"TN""x"""'), 'embedded quotes doubled');
  assert.ok(line.includes('"line1\nline2"'), 'newline value quoted');
  assert.ok(line.includes('KTTWOMENSPANT261L'), 'article_no present in output');
});

test('csvField quotes only when needed and doubles embedded quotes', () => {
  assert.strictEqual(csvField('plain'), 'plain');
  assert.strictEqual(csvField('a,b'), '"a,b"');
  assert.strictEqual(csvField('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(csvField(null), '');
  assert.strictEqual(csvField(0), '0');
});
