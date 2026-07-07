const { test } = require('node:test');
const assert = require('node:assert');
const { reversibleStage, payStageFor, effectiveFlow } = require('../utils/stageReversal');

test('effectiveFlow infers denim from denim-only stage events even when flow_type is null', () => {
  // The bug: a null-flow lot at washing was treated as hosiery → wrong reversible stage.
  assert.strictEqual(effectiveFlow(null, { stitching: 2, jeans_assembly: 2, washing: 2 }), 'denim');
  assert.strictEqual(effectiveFlow(null, { stitching: 2 }), 'hosiery');
  assert.strictEqual(effectiveFlow('denim', {}), 'denim');
  assert.strictEqual(effectiveFlow('hosiery', { stitching: 1, finishing: 1 }), 'hosiery');
  // and the furthest stage is now correct for that null-flow denim lot:
  assert.strictEqual(reversibleStage(effectiveFlow(null, { stitching: 2, jeans_assembly: 2, washing: 2 }), { stitching: 2, jeans_assembly: 2, washing: 2 }).stage, 'washing');
});

test('reversibleStage = furthest-along stage that has events', () => {
  assert.strictEqual(reversibleStage('denim', { stitching: 2, jeans_assembly: 1 }).stage, 'jeans_assembly');
  assert.strictEqual(reversibleStage('denim', { stitching: 2 }).stage, 'stitching');
  assert.strictEqual(reversibleStage('denim', { stitching: 2, washing: 1 }).stage, 'washing');
  assert.strictEqual(reversibleStage('denim', {}), null);
  // hosiery skips the denim-only stages
  assert.strictEqual(reversibleStage('hosiery', { stitching: 1, finishing: 2 }).stage, 'finishing');
});

test('payStageFor maps a stage to the upstream payee it must void, flow-aware', () => {
  assert.strictEqual(payStageFor('stitching', 'denim'), 'cutting');
  assert.strictEqual(payStageFor('jeans_assembly', 'denim'), 'stitching');
  assert.strictEqual(payStageFor('washing', 'denim'), 'assembly');
  assert.strictEqual(payStageFor('washing_in', 'denim'), 'washing');
  assert.strictEqual(payStageFor('finishing', 'denim'), 'washing_in');
  assert.strictEqual(payStageFor('finishing', 'hosiery'), 'stitching');
});
