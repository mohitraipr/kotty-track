const { test } = require('node:test');
const assert = require('node:assert');
const {
  isValidStatus,
  isValidPriority,
  classifyTask,
  canSetStatus,
  TASK_STATUSES,
} = require('../utils/taskLogic.js');

const personal = { created_by: 7, assigned_to: 7 };
const assignedToMe = { created_by: 9, assigned_to: 7 }; // others created, I'm assignee
const assignedByMe = { created_by: 7, assigned_to: 9 }; // I created, someone else assignee

test('status set is the Linear board set; legacy cancelled still valid', () => {
  assert.deepStrictEqual(TASK_STATUSES, ['todo', 'in_progress', 'done', 'blocked']);
  for (const s of ['todo', 'in_progress', 'done', 'blocked', 'cancelled']) {
    assert.ok(isValidStatus(s), `${s} should be valid`);
  }
  assert.ok(!isValidStatus('open')); // migrated away
  assert.ok(!isValidStatus('archived'));
});

test('priority scale includes none + urgent', () => {
  for (const p of ['none', 'low', 'medium', 'high', 'urgent']) assert.ok(isValidPriority(p));
  assert.ok(!isValidPriority('critical'));
});

test('classifyTask: personal task grants full control', () => {
  const c = classifyTask(personal, 7, false);
  assert.deepStrictEqual(
    [c.isPersonal, c.canEditFields, c.canReassign, c.canSetStatus, c.canDelete],
    [true, true, true, true, true]
  );
});

test('classifyTask: assignee (not creator) can set status only', () => {
  const c = classifyTask(assignedToMe, 7, false);
  assert.strictEqual(c.canSetStatus, true);
  assert.strictEqual(c.canEditFields, false);
  assert.strictEqual(c.canReassign, false);
  assert.strictEqual(c.canDelete, false);
});

test('classifyTask: creator (not assignee) can edit/reassign/delete and set status', () => {
  const c = classifyTask(assignedByMe, 7, false);
  assert.strictEqual(c.canEditFields, true);
  assert.strictEqual(c.canReassign, true);
  assert.strictEqual(c.canDelete, true);
  assert.strictEqual(c.canSetStatus, true); // v2: creators can move their tasks too
});

test('classifyTask: admin gets full control on an unrelated task', () => {
  const c = classifyTask({ created_by: 1, assigned_to: 2 }, 99, true);
  assert.ok(c.canEditFields && c.canReassign && c.canSetStatus && c.canDelete);
});

test('canSetStatus: free-form any->any for a status-setter, rejects no-op/invalid', () => {
  const c = classifyTask(personal, 7, false);
  assert.ok(canSetStatus('todo', 'done', c)); // skipping is allowed now
  assert.ok(canSetStatus('done', 'todo', c)); // backward is allowed now
  assert.ok(canSetStatus('in_progress', 'blocked', c));
  assert.ok(!canSetStatus('todo', 'todo', c)); // no-op
  assert.ok(!canSetStatus('todo', 'archived', c)); // invalid target
});

test('canSetStatus: a pure viewer (neither creator nor assignee) cannot set status', () => {
  const caps = classifyTask({ created_by: 1, assigned_to: 2 }, 7, false);
  assert.ok(!canSetStatus('todo', 'in_progress', caps));
});
