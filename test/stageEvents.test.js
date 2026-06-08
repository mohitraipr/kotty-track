const { test } = require('node:test');
const assert = require('node:assert');
const { getOpenApprovals } = require('../utils/stageEvents.js');

// Stub a mysql2 connection: dispatch each of getOpenApprovals' queries by its
// SQL shape and return canned rows. mysql2 returns [rows], so each returns [arr].
function stubConn(data) {
  const seen = [];
  return {
    seen,
    async query(sql) {
      seen.push(sql);
      if (/event_type = 'approve'/.test(sql)) return [data.approves];
      if (/SELECT parent_event_id, event_type, SUM/.test(sql)) return [data.childTotals];
      if (/WHERE s\.event_id IN/.test(sql)) return [data.approveSizes];
      if (/event_type IN \('complete','reject'\)/.test(sql)) return [data.childSizes];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('getOpenApprovals: remaining_sizes = approved - completed - rejected per size, drops zero', async () => {
  // Approve 5: size 26=176, size 28=50. Completed: 26=100, 28=50 (28 fully done).
  const conn = stubConn({
    approves: [{ id: 5, approved: 226, created_at: '2026-06-01', remark: null, operator: 'alice', operator_id: 9 }],
    childTotals: [{ parent_event_id: 5, event_type: 'complete', pieces: 150 }],
    approveSizes: [
      { event_id: 5, size_label: '26', pieces: 176 },
      { event_id: 5, size_label: '28', pieces: 50 },
    ],
    childSizes: [
      { parent_event_id: 5, size_label: '26', pieces: 100 },
      { parent_event_id: 5, size_label: '28', pieces: 50 },
    ],
  });

  const [approval] = await getOpenApprovals(conn, 'stitching', 1);

  assert.strictEqual(approval.inline, 76); // 226 - 150
  assert.strictEqual(approval.completed, 150);
  // size 26 has 76 left; size 28 is fully done so it's dropped
  assert.deepStrictEqual(approval.remaining_sizes, { '26': 76 });
  // approved breakdown is still exposed for back-compat
  assert.deepStrictEqual(approval.sizes, { '26': 176, '28': 50 });
});

test('getOpenApprovals: with no completions yet, remaining_sizes equals approved sizes', async () => {
  const conn = stubConn({
    approves: [{ id: 7, approved: 100, created_at: '2026-06-02', remark: null, operator: 'bob', operator_id: 3 }],
    childTotals: [],
    approveSizes: [
      { event_id: 7, size_label: 'M', pieces: 60 },
      { event_id: 7, size_label: 'L', pieces: 40 },
    ],
    childSizes: [],
  });

  const [approval] = await getOpenApprovals(conn, 'finishing', 2);

  assert.strictEqual(approval.inline, 100);
  assert.deepStrictEqual(approval.remaining_sizes, { M: 60, L: 40 });
});

test('getOpenApprovals: reject also consumes the approved pool', async () => {
  // Approve 9: M=20. 5 completed + 15 rejected => nothing remaining.
  const conn = stubConn({
    approves: [{ id: 9, approved: 20, created_at: '2026-06-03', remark: null, operator: 'cara', operator_id: 4 }],
    childTotals: [
      { parent_event_id: 9, event_type: 'complete', pieces: 5 },
      { parent_event_id: 9, event_type: 'reject', pieces: 15 },
    ],
    approveSizes: [{ event_id: 9, size_label: 'M', pieces: 20 }],
    childSizes: [{ parent_event_id: 9, size_label: 'M', pieces: 20 }],
  });

  // inline = 20 - 5 - 15 = 0, so the approval is filtered out entirely.
  const result = await getOpenApprovals(conn, 'washing', 3);
  assert.strictEqual(result.length, 0);
});
