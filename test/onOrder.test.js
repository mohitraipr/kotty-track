// test/onOrder.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSizeSku } = require('../utils/onOrder.js');

test('resolveSizeSku: prefers pm_sku_resolution map', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+LABEL against canon set', () => {
  const canon = new Set(['KTTTOP374L']);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', new Map(), canon), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+_+LABEL for numeric sizes', () => {
  const canon = new Set(['KTTMENSJEANS381_28']);
  assert.strictEqual(resolveSizeSku('KTTMENSJEANS381', '28', new Map(), canon), 'KTTMENSJEANS381_28');
});

test('resolveSizeSku: case-insensitive on inputs', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('ktttop374', 'l', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: returns null when nothing matches', () => {
  assert.strictEqual(resolveSizeSku('NOPE', 'XL', new Map(), new Set()), null);
});
