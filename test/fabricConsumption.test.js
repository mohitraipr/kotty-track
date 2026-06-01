const { test } = require('node:test');
const assert = require('node:assert');
const {
  groupConsumptionByFabricType,
  buildRollLedger,
  findAdHocRolls,
  findAdHocFabricTypes,
} = require('../utils/fabricConsumption.js');

const rows = [
  { fabric_type: 'Denim', lot_no: 'L1', sku: 'S1', created_at: '2026-05-01', cutter: 'amy', cutting_lot_id: 1, roll_no: 'R1', full_weight: 50, weight_used: 12, remaining_weight: 38 },
  { fabric_type: 'Denim', lot_no: 'L1', sku: 'S1', created_at: '2026-05-01', cutter: 'amy', cutting_lot_id: 1, roll_no: 'R2', full_weight: 40, weight_used: 10, remaining_weight: 30 },
  { fabric_type: 'Denim', lot_no: 'L2', sku: 'S2', created_at: '2026-05-02', cutter: 'amy', cutting_lot_id: 2, roll_no: 'R1', full_weight: 38, weight_used: 8,  remaining_weight: 30 },
  { fabric_type: 'Cotton', lot_no: 'L3', sku: 'S3', created_at: '2026-05-03', cutter: 'bob', cutting_lot_id: 3, roll_no: 'X9', full_weight: 20, weight_used: 5,  remaining_weight: 15 },
];

test('groupConsumptionByFabricType aggregates per type and lot', () => {
  const g = groupConsumptionByFabricType(rows);
  const denim = g.find(x => x.fabricType === 'Denim');
  assert.strictEqual(denim.totalUsed, 30);
  assert.strictEqual(denim.lotCount, 2);
  assert.strictEqual(denim.rollCount, 3);
  const l1 = denim.lots.find(l => l.lotNo === 'L1');
  assert.strictEqual(l1.totalUsed, 22);
  assert.strictEqual(l1.rolls.length, 2);
});

test('buildRollLedger sums used per roll across lots and resolves master', () => {
  const master = [
    { roll_no: 'R1', fabric_type: 'Denim', vendor_name: 'Acme', per_roll_weight: 30, unit: 'kg' },
    { roll_no: 'R2', fabric_type: 'Denim', vendor_name: 'Acme', per_roll_weight: 30, unit: 'kg' },
  ];
  const ledger = buildRollLedger(rows, master);
  const r1 = ledger.find(r => r.rollNo === 'R1');
  assert.strictEqual(r1.totalUsed, 20);            // 12 + 8
  assert.strictEqual(r1.currentAvailable, 30);
  assert.strictEqual(r1.vendor, 'Acme');
  assert.deepStrictEqual(r1.lots.sort(), ['L1', 'L2']);
  const x9 = ledger.find(r => r.rollNo === 'X9');
  assert.strictEqual(x9.currentAvailable, null);   // ad-hoc, not in master
  assert.strictEqual(x9.vendor, '(ad-hoc)');
});

test('findAdHocRolls returns rolls absent from master', () => {
  const adhoc = findAdHocRolls(rows, ['R1', 'R2']);
  assert.strictEqual(adhoc.length, 1);
  assert.strictEqual(adhoc[0].rollNo, 'X9');
  assert.strictEqual(adhoc[0].lotNo, 'L3');
});

test('findAdHocFabricTypes is case-insensitive and deduped', () => {
  const adhoc = findAdHocFabricTypes(['Denim', 'cotton', 'Linen', 'LINEN'], ['Denim', 'Cotton']);
  assert.deepStrictEqual(adhoc, ['Linen']);
});
