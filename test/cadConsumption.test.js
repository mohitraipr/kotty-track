const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeSize, parseConsumptionSheet } = require('../utils/cadConsumption.js');

test('normalizeSize extracts the letter size from a combined "S / 26" label', () => {
  assert.strictEqual(normalizeSize('S / 26'), 'S');
  assert.strictEqual(normalizeSize('XL / 32'), 'XL');
  assert.strictEqual(normalizeSize(' xxl '), 'XXL');
  assert.strictEqual(normalizeSize('3XL'), '3XL');
});

test('normalizeSize falls back to the raw token when no letter size present', () => {
  assert.strictEqual(normalizeSize('26'), '26');
  assert.strictEqual(normalizeSize(''), '');
});

test('parseConsumptionSheet normalizes valid CAD rows', () => {
  const rows = [
    { style: 'KTTWOMENSPANT261', fabric_type: 'Valentino', size: 'S / 26', consumption: '0.9' },
    { style: 'KTTWOMENSPANT261', fabric_type: 'Valentino', size: 'M / 28', consumption: 1.02 },
  ];
  const { rows: out, errors } = parseConsumptionSheet(rows);
  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(out[0], {
    style: 'KTTWOMENSPANT261', fabric_type: 'Valentino', size_label: 'S',
    consumption_per_piece: 0.9, consumption_unit: 'METER',
  });
  assert.strictEqual(out[1].size_label, 'M');
  assert.strictEqual(out[1].consumption_per_piece, 1.02);
});

test('parseConsumptionSheet rejects rows missing style/size or with bad consumption', () => {
  const rows = [
    { style: '', size: 'S', consumption: '0.9' },
    { style: 'X', size: '', consumption: '0.9' },
    { style: 'X', size: 'S', consumption: 'abc' },
    { style: 'X', size: 'M', consumption: '0' },
  ];
  const { rows: out, errors } = parseConsumptionSheet(rows);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(errors.length, 4);
});

test('parseConsumptionSheet honours an explicit KG unit', () => {
  const rows = [{ style: 'X', size: 'S', consumption: '0.4', unit: 'kg' }];
  const { rows: out } = parseConsumptionSheet(rows);
  assert.strictEqual(out[0].consumption_unit, 'KG');
});
