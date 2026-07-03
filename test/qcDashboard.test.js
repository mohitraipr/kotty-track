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
// buildPassesQuery
// ---------------------------------------------------------------------------

test('buildPassesQuery defaults to today (IST) when no dates given', () => {
  const today = istToday();
  const { sql, params, from, to } = buildPassesQuery({});
  assert.strictEqual(from, today);
  assert.strictEqual(to, today);
  // date range is the first WHERE predicate, first two params
  assert.ok(/DATE\(p\.passed_at\) BETWEEN \? AND \?/.test(sql));
  assert.deepStrictEqual(params, [today, today]);
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
    ['quality', 'p.quality = ?'],
    ['qc_action', 'p.qc_action = ?'],
    ['warehouse', 'p.warehouse_id = ?'],
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
  assert.ok(!withVal.sql.includes('p.quality = ?'));
  assert.ok(!withVal.sql.includes('p.warehouse_id = ?'));
});

test('buildPassesQuery q produces a grouped OR LIKE with five params', () => {
  const { sql, params } = buildPassesQuery({ q: 'abc' });
  assert.ok(
    sql.includes(
      '(c.sku_code LIKE ? OR c.style_id LIKE ? OR p.item_barcode LIKE ? OR c.tracking_number LIKE ? OR c.product_name LIKE ?)'
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
    quality: 'good',
    qc_action: 'restock',
    warehouse: 'WH1',
    q: 'jean',
  });
  assert.deepStrictEqual(params, [
    '2026-01-01', '2026-01-31',
    'bob', 'good', 'restock', 'WH1',
    '%jean%', '%jean%', '%jean%', '%jean%', '%jean%',
  ]);
  // No raw user values embedded in the SQL text (only placeholders).
  for (const v of ['bob', 'good', 'restock', 'WH1', 'jean']) {
    assert.ok(!sql.includes(v), `value "${v}" must not be string-concatenated into SQL`);
  }
  assert.ok(sql.trim().endsWith('ORDER BY p.passed_at DESC'));
});

// ---------------------------------------------------------------------------
// summarizeByUser
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

test('rowsToCsv emits the header row in the fixed column order', () => {
  const csv = rowsToCsv([]);
  assert.strictEqual(
    csv,
    'passed_at,username,item_barcode,tracking_number,sku_code,style_id,size,quality,qc_action,warehouse_id,pass_success'
  );
});

test('rowsToCsv escapes commas, quotes and newlines; blanks null fields', () => {
  const csv = rowsToCsv([
    {
      passed_at: '2026-07-01 10:00:00',
      username: 'alice',
      item_barcode: 'BC,1',
      tracking_number: 'TN"x"',
      sku_code: 'line1\nline2',
      style_id: null,
      size: 'M',
      quality: 'good',
      qc_action: 'restock',
      warehouse_id: 'WH1',
      pass_success: 1,
    },
  ]);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(
    lines[1],
    '2026-07-01 10:00:00,alice,"BC,1","TN""x""","line1\nline2",,M,good,restock,WH1,1'
  );
});

test('csvField quotes only when needed and doubles embedded quotes', () => {
  assert.strictEqual(csvField('plain'), 'plain');
  assert.strictEqual(csvField('a,b'), '"a,b"');
  assert.strictEqual(csvField('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(csvField(null), '');
  assert.strictEqual(csvField(0), '0');
});
