const { test } = require('node:test');
const assert = require('node:assert');
const { canChangeFlow } = require('../utils/lotFlowChange');

test('allows flow change with no progress or only cutting/stitching events', () => {
  assert.strictEqual(canChangeFlow({}).ok, true);
  assert.strictEqual(canChangeFlow({ stitching: 5 }).ok, true);
  assert.deepStrictEqual(canChangeFlow({ stitching: 5 }).blockedStages, []);
});

test('blocks flow change once the lot is past stitching', () => {
  assert.strictEqual(canChangeFlow({ stitching: 5, jeans_assembly: 1 }).ok, false);
  assert.strictEqual(canChangeFlow({ washing: 2 }).ok, false);
  assert.strictEqual(canChangeFlow({ washing_in: 1 }).ok, false);
  assert.deepStrictEqual(canChangeFlow({ finishing: 3 }).blockedStages, ['finishing']);
});

test('reports every blocking stage', () => {
  const r = canChangeFlow({ jeans_assembly: 1, washing: 1, finishing: 1 });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.blockedStages, ['jeans_assembly', 'washing', 'finishing']);
  assert.match(r.reason, /reverse the lot back to stitching/i);
});
