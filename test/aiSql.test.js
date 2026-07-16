const { test } = require('node:test');
const assert = require('node:assert');
const { guardSql, capRows } = require('../utils/aiSql.js');

test('guardSql: plain SELECT gets a LIMIT appended', () => {
  const { sql, error } = guardSql('SELECT lot_no FROM cutting_lots WHERE sku = "X"');
  assert.strictEqual(error, undefined);
  assert.match(sql, /LIMIT 200$/);
});

test('guardSql: existing sane LIMIT is kept', () => {
  const { sql } = guardSql('select * from users limit 10');
  assert.strictEqual(sql, 'select * from users limit 10');
});

test('guardSql: LIMIT offset,count form is honored and capped by count', () => {
  assert.strictEqual(guardSql('select 1 from t limit 10, 50').error, undefined);
  assert.match(guardSql('select 1 from t limit 10, 9999').error, /LIMIT too large/);
});

test('guardSql: oversized LIMIT rejected', () => {
  assert.match(guardSql('select * from ee_orders limit 100000').error, /LIMIT too large/);
});

test('guardSql: writes and DDL are rejected', () => {
  for (const bad of [
    'UPDATE users SET is_active=0',
    'DELETE FROM cutting_lots',
    'INSERT INTO t VALUES (1)',
    'DROP TABLE users',
    'TRUNCATE stage_payments',
    'CREATE TABLE x (id int)',
    'GRANT ALL ON *.* TO u',
    'SET SESSION transaction_read_only = 0',
  ]) {
    assert.match(guardSql(bad).error || '', /Only SELECT/i, bad);
  }
});

test('guardSql: multi-statement injection rejected', () => {
  const { error } = guardSql('SELECT 1; DELETE FROM users');
  assert.match(error, /single statement/);
});

test('guardSql: trailing semicolon alone is fine', () => {
  const { sql, error } = guardSql('SHOW TABLES;');
  assert.strictEqual(error, undefined);
  assert.strictEqual(sql, 'SHOW TABLES');
});

test('guardSql: SHOW/DESCRIBE/EXPLAIN allowed without LIMIT', () => {
  for (const ok of ['SHOW TABLES', 'DESCRIBE cutting_lots', 'desc users', 'EXPLAIN SELECT 1']) {
    const { error, sql } = guardSql(ok);
    assert.strictEqual(error, undefined, ok);
    assert.doesNotMatch(sql, /LIMIT 200$/);
  }
});

test('guardSql: forbidden constructs rejected even inside SELECT', () => {
  for (const bad of [
    "SELECT * FROM t INTO OUTFILE '/tmp/x'",
    'SELECT load_file("/etc/passwd")',
    'SELECT * FROM t FOR UPDATE',
    'SELECT sleep(10)',
    'SELECT benchmark(100000, sha1("x"))',
  ]) {
    assert.match(guardSql(bad).error, /forbidden/i, bad);
  }
});

test('capRows: caps rows, stringifies dates/objects, truncates long cells', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    n: i, d: new Date('2026-07-16T00:00:00Z'), j: { a: 1 }, s: 'x'.repeat(500),
  }));
  const out = capRows(rows);
  assert.strictEqual(out.length, 200);
  assert.strictEqual(out[0].d, '2026-07-16T00:00:00.000Z');
  assert.strictEqual(out[0].j, '{"a":1}');
  assert.strictEqual(out[0].s.length, 301);
});
