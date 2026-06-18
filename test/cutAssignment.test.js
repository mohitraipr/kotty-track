const { test } = require('node:test');
const assert = require('node:assert');
const { buildAssignmentPayload } = require('../utils/cutAssignment.js');

const plan = {
  lotCount: 2,
  totalPieces: 1920,
  totalFabricMeters: 1691.28,
  fabricComplete: false,
  missingSizes: ['XS'],
};

test('buildAssignmentPayload assembles header + size lines from demand and plan', () => {
  const out = buildAssignmentPayload({
    style: 'KTTWOMENSPANT261', fabricType: 'Valentino',
    masterId: 42, masterName: 'Ramesh',
    demand: { M: 1304, L: 344, XS: 272 }, plan, createdBy: 7,
  });
  assert.strictEqual(out.header.style, 'KTTWOMENSPANT261');
  assert.strictEqual(out.header.assigned_master_id, 42);
  assert.strictEqual(out.header.assigned_master_name, 'Ramesh');
  assert.strictEqual(out.header.total_pieces, 1920);
  assert.strictEqual(out.header.lot_count, 2);
  assert.ok(Math.abs(out.header.total_fabric_meters - 1691.28) < 1e-6);
  assert.strictEqual(out.header.fabric_complete, false);
  assert.strictEqual(out.header.status, 'assigned');
  assert.strictEqual(out.header.created_by, 7);
  // size lines, largest first, summing to total_pieces
  assert.deepStrictEqual(out.sizes, [
    { size_label: 'M', qty: 1304 },
    { size_label: 'L', qty: 344 },
    { size_label: 'XS', qty: 272 },
  ]);
  assert.strictEqual(out.sizes.reduce((s, x) => s + x.qty, 0), out.header.total_pieces);
});

test('buildAssignmentPayload keeps fabric null when the plan could not price it', () => {
  const out = buildAssignmentPayload({
    style: 'X', fabricType: null, masterId: 1, masterName: 'A',
    demand: { M: 100 }, plan: { lotCount: 1, totalPieces: 100, totalFabricMeters: null }, createdBy: 1,
  });
  assert.strictEqual(out.header.total_fabric_meters, null);
});

test('buildAssignmentPayload rejects a missing master', () => {
  assert.throws(() => buildAssignmentPayload({
    style: 'X', demand: { M: 10 }, plan, createdBy: 1,
  }), /master/i);
});

test('buildAssignmentPayload rejects empty demand', () => {
  assert.throws(() => buildAssignmentPayload({
    style: 'X', masterId: 1, masterName: 'A', demand: {}, plan, createdBy: 1,
  }), /demand|nothing/i);
});
