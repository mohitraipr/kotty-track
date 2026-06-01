const { test } = require('node:test');
const assert = require('node:assert');
const { computeRollWeights } = require('../public/js/cuttingWeight.js');

test('denim: used = tableLength * layers, remaining = full - used', () => {
  const r = computeRollWeights('denim', { tableLength: 1.5, layers: 8, full: 50 });
  assert.strictEqual(r.used, 12);
  assert.strictEqual(r.remaining, 38);
  assert.strictEqual(r.over, false);
});

test('denim: over-weight flags and clamps remaining to 0', () => {
  const r = computeRollWeights('denim', { tableLength: 10, layers: 8, full: 50 });
  assert.strictEqual(r.used, 80);
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.over, true);
});

test('denim: missing tableLength or layers yields nulls', () => {
  const r = computeRollWeights('denim', { tableLength: '', layers: 8, full: 50 });
  assert.strictEqual(r.used, null);
  assert.strictEqual(r.remaining, null);
});

test('hosiery: used = full - remaining', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: 4 });
  assert.strictEqual(r.used, 26);
  assert.strictEqual(r.remaining, 4);
  assert.strictEqual(r.over, false);
});

test('hosiery: empty remaining defaults to 0 so used = full', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: '' });
  assert.strictEqual(r.used, 30);
  assert.strictEqual(r.remaining, 0);
});

test('hosiery: remaining > full flags over and clamps used to 0', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: 40 });
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.over, true);
});

test('hosiery: missing full yields null used', () => {
  const r = computeRollWeights('hosiery', { full: '', remaining: 5 });
  assert.strictEqual(r.used, null);
});
