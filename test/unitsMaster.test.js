const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeUnit, ensureUnit, getUnits } = require('../utils/unitsMaster.js');

test('normalizeUnit trims and uppercases', () => {
  assert.strictEqual(normalizeUnit('  pcs '), 'PCS');
  assert.strictEqual(normalizeUnit('Box'), 'BOX');
  assert.strictEqual(normalizeUnit('GROSS'), 'GROSS');
});

test('normalizeUnit handles null/undefined/blank', () => {
  assert.strictEqual(normalizeUnit(''), '');
  assert.strictEqual(normalizeUnit(null), '');
  assert.strictEqual(normalizeUnit(undefined), '');
  assert.strictEqual(normalizeUnit('   '), '');
});

function stubPool() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/^SELECT name FROM units/i.test(sql)) return [[{ name: 'CONE' }, { name: 'PCS' }]];
      return [{ affectedRows: 1 }];
    },
  };
}

test('ensureUnit normalizes, INSERT IGNOREs, and returns canonical name', async () => {
  const pool = stubPool();
  const out = await ensureUnit(pool, ' box ');
  assert.strictEqual(out, 'BOX');
  assert.strictEqual(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /INSERT IGNORE INTO units/i);
  assert.deepStrictEqual(pool.calls[0].params, ['BOX']);
});

test('ensureUnit skips the DB write for blank input', async () => {
  const pool = stubPool();
  const out = await ensureUnit(pool, '   ');
  assert.strictEqual(out, '');
  assert.strictEqual(pool.calls.length, 0);
});

test('getUnits returns the names array', async () => {
  const pool = stubPool();
  const units = await getUnits(pool);
  assert.deepStrictEqual(units, ['CONE', 'PCS']);
});
