const { test } = require('node:test');
const assert = require('node:assert');
const {
  isValidStatus,
  isValidPriority,
  classifyTask,
  canTransition,
} = require('../utils/taskLogic.js');

const personal = { created_by: 7, assigned_to: 7 };
const assignedToMe = { created_by: 9, assigned_to: 7 };   // someone else created, I'm assignee
const assignedByMe = { created_by: 7, assigned_to: 9 };   // I created, someone else is assignee

test('isValidStatus / isValidPriority guard the enums', () => {
  assert.ok(isValidStatus('open'));
  assert.ok(isValidStatus('cancelled'));
  assert.ok(!isValidStatus('archived'));
  assert.ok(!isValidStatus(''));
  assert.ok(isValidPriority('high'));
  assert.ok(!isValidPriority('urgent'));
});

test('classifyTask: personal todo grants full control', () => {
  const caps = classifyTask(personal, 7, false);
  assert.deepStrictEqual(
    {
      isPersonal: caps.isPersonal,
      canEditFields: caps.canEditFields,
      canReassign: caps.canReassign,
      canAdvance: caps.canAdvance,
      canCancel: caps.canCancel,
      canDelete: caps.canDelete,
    },
    { isPersonal: true, canEditFields: true, canReassign: true, canAdvance: true, canCancel: true, canDelete: true }
  );
});

test('classifyTask: assignee (not creator) can only advance status', () => {
  const caps = classifyTask(assignedToMe, 7, false);
  assert.strictEqual(caps.isAssignee, true);
  assert.strictEqual(caps.isCreator, false);
  assert.strictEqual(caps.canAdvance, true);
  assert.strictEqual(caps.canEditFields, false);
  assert.strictEqual(caps.canReassign, false);
  assert.strictEqual(caps.canCancel, false);
  assert.strictEqual(caps.canDelete, false);
});

test('classifyTask: creator (not assignee) can edit/reassign/cancel/delete but not advance', () => {
  const caps = classifyTask(assignedByMe, 7, false);
  assert.strictEqual(caps.isCreator, true);
  assert.strictEqual(caps.isAssignee, false);
  assert.strictEqual(caps.canEditFields, true);
  assert.strictEqual(caps.canReassign, true);
  assert.strictEqual(caps.canCancel, true);
  assert.strictEqual(caps.canDelete, true);
  assert.strictEqual(caps.canAdvance, false);
});

test('classifyTask: admin gets full control on a task they have no relation to', () => {
  const caps = classifyTask({ created_by: 1, assigned_to: 2 }, 99, true);
  assert.strictEqual(caps.canEditFields, true);
  assert.strictEqual(caps.canAdvance, true);
  assert.strictEqual(caps.canCancel, true);
  assert.strictEqual(caps.canDelete, true);
});

test('classifyTask compares numerically (string ids from the DB still match)', () => {
  const caps = classifyTask({ created_by: '7', assigned_to: '7' }, 7, false);
  assert.strictEqual(caps.isPersonal, true);
});

test('canTransition: legal forward path for an advancer', () => {
  const caps = classifyTask(personal, 7, false);
  assert.ok(canTransition('open', 'in_progress', caps));
  assert.ok(canTransition('in_progress', 'done', caps));
});

test('canTransition: cancel allowed for canceller from non-terminal states only', () => {
  const caps = classifyTask(assignedByMe, 7, false); // creator can cancel, cannot advance
  assert.ok(canTransition('open', 'cancelled', caps));
  assert.ok(canTransition('in_progress', 'cancelled', caps));
  assert.ok(!canTransition('done', 'cancelled', caps));
  assert.ok(!canTransition('cancelled', 'cancelled', caps));
});

test('canTransition: rejects skip, backward, reopen, and no-op', () => {
  const caps = classifyTask(personal, 7, false);
  assert.ok(!canTransition('open', 'done', caps));        // skip
  assert.ok(!canTransition('in_progress', 'open', caps)); // backward
  assert.ok(!canTransition('done', 'in_progress', caps)); // reopen
  assert.ok(!canTransition('open', 'open', caps));        // no-op
  assert.ok(!canTransition('open', 'archived', caps));    // invalid target
});

test('canTransition: assignee can advance but cannot cancel; creator the reverse', () => {
  const assigneeCaps = classifyTask(assignedToMe, 7, false);
  assert.ok(canTransition('open', 'in_progress', assigneeCaps));
  assert.ok(!canTransition('open', 'cancelled', assigneeCaps)); // assignee can't cancel

  const creatorCaps = classifyTask(assignedByMe, 7, false);
  assert.ok(!canTransition('open', 'in_progress', creatorCaps)); // creator can't advance
  assert.ok(canTransition('open', 'cancelled', creatorCaps));
});
