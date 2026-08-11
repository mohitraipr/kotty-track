const { test } = require('node:test');
const assert = require('node:assert');
const { buildSizeMatrix, recentLots } = require('../utils/lotJourneyData.js');

// Stub db: dispatch by SQL shape (pattern from test/stageEvents.test.js).
// getStageSizeAggregates issues one query per stage against ${stage}_event_sizes join.
function stubDb({ cutSizes, sizeAggRows, dispatchRows }) {
  return {
    async query(sql) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/FROM cutting_lot_sizes/.test(flat)) return [cutSizes];
      if (/_event_sizes/.test(flat)) {
        const table = flat.match(/JOIN (\w+_events) e/)[1];
        return [(sizeAggRows[table] || [])];
      }
      if (/FROM finishing_dispatches/.test(flat)) return [dispatchRows || []];
      throw new Error('unexpected query: ' + flat);
    },
  };
}

test('buildSizeMatrix: denim lot merges cut, per-stage and dispatch by normalized size', async () => {
  const db = stubDb({
    cutSizes: [{ size_label: '30', cut: 100 }, { size_label: '32', cut: 50 }],
    sizeAggRows: {
      stitching_events: [
        { size_label: '30', event_type: 'approve', bucket: 'u', pieces: 100 },
        { size_label: '30', event_type: 'complete', bucket: 'i', pieces: 80 },
      ],
      jeans_assembly_events: [], washing_events: [], washing_in_events: [],
      finishing_events: [{ size_label: '30', event_type: 'approve', bucket: 'u', pieces: 10 }],
    },
    dispatchRows: [{ size_label: '30', dispatched: 5 }],
  });
  const m = await buildSizeMatrix(db, { id: 1, lot_no: 'A1', flow_type: 'denim' });
  assert.deepStrictEqual(m.stages, ['stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing']);
  const r30 = m.rows.find(r => r.size === '30');
  assert.strictEqual(r30.cut, 100);
  assert.strictEqual(r30.byStage.stitching.approved, 100);
  assert.strictEqual(r30.byStage.stitching.completed, 80);
  assert.strictEqual(r30.byStage.finishing.approved, 10);
  assert.strictEqual(r30.dispatched, 5);
  const r32 = m.rows.find(r => r.size === '32');
  assert.strictEqual(r32.cut, 50);
  assert.strictEqual(r32.byStage.stitching.approved, 0);
  assert.strictEqual(r32.dispatched, 0);
  assert.strictEqual(m.totals.cut, 150);
  assert.strictEqual(m.totals.byStage.stitching.approved, 100);
  assert.strictEqual(m.totals.dispatched, 5);
});

test('buildSizeMatrix: hosiery chain has only stitching + finishing columns', async () => {
  const db = stubDb({
    cutSizes: [{ size_label: 'M', cut: 10 }],
    sizeAggRows: { stitching_events: [], finishing_events: [] },
    dispatchRows: [],
  });
  const m = await buildSizeMatrix(db, { id: 2, lot_no: 'H1', flow_type: 'hosiery' });
  assert.deepStrictEqual(m.stages, ['stitching', 'finishing']);
});

test('buildSizeMatrix: size labels match case/whitespace-insensitively', async () => {
  const db = stubDb({
    cutSizes: [{ size_label: ' m ', cut: 10 }],
    sizeAggRows: {
      stitching_events: [{ size_label: 'M', event_type: 'approve', bucket: 'u', pieces: 4 }],
      finishing_events: [],
    },
    dispatchRows: [{ size_label: 'm', dispatched: 2 }],
  });
  const m = await buildSizeMatrix(db, { id: 3, lot_no: 'H2', flow_type: 'hosiery' });
  assert.strictEqual(m.rows[0].byStage.stitching.approved, 4);
  assert.strictEqual(m.rows[0].dispatched, 2);
});

// ── recentLots ─────────────────────────────────────────────────────────────

function recentStub({ lots, presence }) {
  return {
    async query(sql) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/FROM cutting_lots/.test(flat)) return [lots];
      const m = flat.match(/FROM (\w+_events)/);
      if (m) {
        return [(presence[m[1]] || []).map((id) => ({ cutting_lot_id: id }))];
      }
      throw new Error('unexpected query: ' + flat);
    },
  };
}

test('recentLots: current_stage is the furthest stage with events, else cutting', async () => {
  const db = recentStub({
    lots: [
      { id: 1, lot_no: 'A1', manual_lot_number: 'M1', sku: 'S1', total_pieces: 10, flow_type: 'denim', created_at: '2026-08-10' },
      { id: 2, lot_no: 'A2', manual_lot_number: null, sku: 'S2', total_pieces: 20, flow_type: 'hosiery', created_at: '2026-08-09' },
      { id: 3, lot_no: 'A3', manual_lot_number: null, sku: 'S3', total_pieces: 5, flow_type: 'denim', created_at: '2026-08-08' },
    ],
    presence: {
      stitching_events: [1, 2],
      washing_events: [1],
      // finishing has none — furthest for lot 1 is washing, for lot 2 stitching; lot 3 untouched
    },
  });
  const lots = await recentLots(db, 10);
  assert.strictEqual(lots.find(l => l.id === 1).current_stage, 'washing');
  assert.strictEqual(lots.find(l => l.id === 2).current_stage, 'stitching');
  assert.strictEqual(lots.find(l => l.id === 3).current_stage, 'cutting');
});

test('recentLots: empty table short-circuits without probing event tables', async () => {
  const db = recentStub({ lots: [], presence: {} });
  assert.deepStrictEqual(await recentLots(db, 10), []);
});
