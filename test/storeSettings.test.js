const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAllowAdhoc, isKnownFabricType } = require('../utils/storeSettings.js');

test('resolveAllowAdhoc: only literal true (any case) is true', () => {
  assert.strictEqual(resolveAllowAdhoc('true'), true);
  assert.strictEqual(resolveAllowAdhoc('TRUE'), true);
  assert.strictEqual(resolveAllowAdhoc(' True '), true);
  assert.strictEqual(resolveAllowAdhoc('false'), false);
  assert.strictEqual(resolveAllowAdhoc(''), false);
  assert.strictEqual(resolveAllowAdhoc('yes'), false);
  assert.strictEqual(resolveAllowAdhoc('1'), false);
  assert.strictEqual(resolveAllowAdhoc(undefined), false);
  assert.strictEqual(resolveAllowAdhoc(null), false);
});

test('isKnownFabricType: case-insensitive, trimmed membership', () => {
  const known = ['Denim', 'Cotton Lycra', 'Hosiery'];
  assert.strictEqual(isKnownFabricType('Denim', known), true);
  assert.strictEqual(isKnownFabricType('  denim ', known), true);
  assert.strictEqual(isKnownFabricType('COTTON LYCRA', known), true);
  assert.strictEqual(isKnownFabricType('Linen', known), false);
  assert.strictEqual(isKnownFabricType('', known), false);
  assert.strictEqual(isKnownFabricType('Denim', []), false);
  assert.strictEqual(isKnownFabricType(null, known), false);
});
