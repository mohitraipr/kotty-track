const { test } = require('node:test');
const assert = require('node:assert');
const { STAGE_DEFS, applyCorrection } = require('../utils/approvalCorrection.js');

// Stub a mysql2 connection that records every query and dispatches by SQL
// shape. Models the UM416 scenario: Salim (id 51) wrongly owns the lot at
// stitching; we move it to Salman (id 50). 2 events, 1 data row, and 2
// payments (one already PAID) are attributed to Salim.
function stubConn() {
  const queries = [];
  return {
    queries,
    async query(sql, params) {
      queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^UPDATE stitching_events SET operator_id/.test(sql.trim())) return [{ affectedRows: 2 }];
      if (/^UPDATE stitching_data SET user_id/.test(sql.trim())) return [{ affectedRows: 1 }];
      if (/SELECT COUNT\(\*\) AS n, SUM\(status='paid'\) AS paid_n/.test(sql)) return [[{ n: 2, paid_n: 1 }]];
      if (/^UPDATE stage_payments SET user_id/.test(sql.trim())) return [{ affectedRows: 2 }];
      if (/INSERT INTO stage_approval_corrections/.test(sql)) return [{ insertId: 99 }];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('applyCorrection (UM416): moves events, data, and payments incl. paid, and audits', async () => {
  const conn = stubConn();
  const moved = await applyCorrection(conn, {
    stage: 'stitching', cuttingLotId: 4921, lotNo: 'um416',
    fromUserId: 51, toUserId: 50, toUsername: 'salman', correctedBy: 7,
  });

  assert.deepStrictEqual(moved, { eventsMoved: 2, dataMoved: 1, paymentsMoved: 2, paidMoved: 1 });

  // event ledger reattributed to Salman, scoped to the lot + wrong operator
  const ev = conn.queries.find(q => /UPDATE stitching_events SET operator_id/.test(q.sql));
  assert.deepStrictEqual(ev.params, [50, 4921, 51]);

  // legacy data row reattributed by lot_no + wrong operator
  const data = conn.queries.find(q => /UPDATE stitching_data SET user_id/.test(q.sql));
  assert.deepStrictEqual(data.params, [50, 'um416', 51]);

  // payments moved with BOTH user_id and username (so payee follows)
  const pay = conn.queries.find(q => /UPDATE stage_payments SET user_id/.test(q.sql));
  assert.deepStrictEqual(pay.params, [50, 'salman', 'um416', 51]);

  // audit row carries the move counts incl. the paid subset
  const audit = conn.queries.find(q => /INSERT INTO stage_approval_corrections/.test(q.sql));
  assert.ok(audit, 'audit row inserted');
  assert.deepStrictEqual(audit.params,
    ['stitching', 4921, 'um416', 51, 50, 7, /*events*/2, /*data*/1, /*payments*/2, /*paid*/1]);
});

test('applyCorrection: no audit row when nothing matched', async () => {
  const conn = {
    queries: [],
    async query(sql) {
      this.queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/^UPDATE \w+ SET (operator_id|user_id)/.test(sql.trim())) return [{ affectedRows: 0 }];
      if (/SELECT COUNT/.test(sql)) return [[{ n: 0, paid_n: null }]];
      if (/^UPDATE stage_payments/.test(sql.trim())) return [{ affectedRows: 0 }];
      if (/INSERT INTO stage_approval_corrections/.test(sql)) throw new Error('should not audit a no-op');
      throw new Error('unexpected query: ' + sql);
    },
  };
  const moved = await applyCorrection(conn, {
    stage: 'washing', cuttingLotId: 1, lotNo: 'zzz', fromUserId: 1, toUserId: 2, toUsername: 'x', correctedBy: 9,
  });
  assert.deepStrictEqual(moved, { eventsMoved: 0, dataMoved: 0, paymentsMoved: 0, paidMoved: 0 });
  assert.ok(!conn.queries.some(s => /INSERT INTO stage_approval_corrections/.test(s)));
});

test('STAGE_DEFS maps every stage to its tables + role', () => {
  assert.deepStrictEqual(Object.keys(STAGE_DEFS).sort(),
    ['assembly', 'finishing', 'stitching', 'washing', 'washing_in']);
  assert.strictEqual(STAGE_DEFS.stitching.role, 'stitching_master');
  assert.strictEqual(STAGE_DEFS.assembly.role, 'jeans_assembly');
  assert.strictEqual(STAGE_DEFS.finishing.ev, 'finishing_events');
});

test('applyCorrection: rejects an unknown stage', async () => {
  await assert.rejects(
    () => applyCorrection({ async query() { return [{}]; } }, { stage: 'nope', cuttingLotId: 1, lotNo: 'a', fromUserId: 1, toUserId: 2, toUsername: 'x', correctedBy: 1 }),
    /Invalid stage/
  );
});
