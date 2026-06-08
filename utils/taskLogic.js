// utils/taskLogic.js
//
// Pure domain logic for the tasks feature (v2, Linear-like): status set,
// priority scale, and the permission matrix. Side-effect free so it can be
// unit-tested directly and shared by routes/taskRoutes.js.
//
// v2 uses a FREE-FORM status model (any -> any) to support a kanban board,
// gated only by who may change a task's status. The strict forward-only
// lifecycle from v1 is intentionally gone.

// Canonical board statuses (these are the board columns).
const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
// 'cancelled' is retained only so legacy v1 rows remain readable/settable.
const STORED_STATUSES = [...TASK_STATUSES, 'cancelled'];
const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];

function isValidStatus(status) {
  return STORED_STATUSES.includes(status);
}

function isValidPriority(priority) {
  return TASK_PRIORITIES.includes(priority);
}

/**
 * Classify a task relative to a user and return their capabilities.
 *
 * - Creator/admin: edit fields, reassign, set status, delete.
 * - Assignee: set status (move it across the board) — no edit/reassign/delete.
 * - Admin: everything.
 *
 * @param {{created_by:number, assigned_to:number}} task
 * @param {number} userId
 * @param {boolean} isAdmin
 */
function classifyTask(task, userId, isAdmin = false) {
  const isCreator = Number(task.created_by) === Number(userId);
  const isAssignee = task.assigned_to != null && Number(task.assigned_to) === Number(userId);
  const isPersonal = isCreator && isAssignee;

  return {
    isCreator,
    isAssignee,
    isPersonal,
    isAdmin: !!isAdmin,
    canEditFields: isCreator || isAdmin,
    canReassign: isCreator || isAdmin,
    canSetStatus: isCreator || isAssignee || isAdmin,
    canDelete: isCreator || isAdmin,
  };
}

/**
 * Free-form status change: any valid target (not a no-op), allowed for anyone
 * who may set this task's status.
 */
function canSetStatus(from, to, caps) {
  if (!isValidStatus(to)) return false;
  if (from === to) return false;
  return !!caps.canSetStatus;
}

module.exports = {
  TASK_STATUSES,
  STORED_STATUSES,
  TASK_PRIORITIES,
  isValidStatus,
  isValidPriority,
  classifyTask,
  canSetStatus,
};
