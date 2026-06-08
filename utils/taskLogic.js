// utils/taskLogic.js
//
// Pure domain logic for the user-tasks feature: status enum, legal transitions,
// and the permission matrix. Kept side-effect free (no DB, no req) so it can be
// unit-tested directly and reused by routes/taskRoutes.js. The HTTP layer loads
// the task row, calls classifyTask() to get capabilities, then enforces them.

const TASK_STATUSES = ['open', 'in_progress', 'done', 'cancelled'];
const TASK_PRIORITIES = ['low', 'medium', 'high'];

// Strictly-forward lifecycle: open -> in_progress -> done.
const FORWARD_TRANSITIONS = { open: 'in_progress', in_progress: 'done' };

function isValidStatus(status) {
  return TASK_STATUSES.includes(status);
}

function isValidPriority(priority) {
  return TASK_PRIORITIES.includes(priority);
}

/**
 * Classify a task relative to a user and return their capabilities.
 *
 * Permission matrix (v1):
 *  - Personal (creator == assignee): full control.
 *  - Creator only (someone else is the assignee): edit fields, reassign, cancel,
 *    delete — but NOT advance status.
 *  - Assignee only (someone else created it): advance status (forward) only.
 *  - Admin: full control regardless of relationship.
 *
 * @param {{created_by:number, assigned_to:number}} task
 * @param {number} userId
 * @param {boolean} isAdmin
 */
function classifyTask(task, userId, isAdmin = false) {
  const isCreator = Number(task.created_by) === Number(userId);
  const isAssignee = Number(task.assigned_to) === Number(userId);
  const isPersonal = isCreator && isAssignee;

  return {
    isCreator,
    isAssignee,
    isPersonal,
    isAdmin: !!isAdmin,
    canEditFields: isCreator || isAdmin,
    canReassign: isCreator || isAdmin,
    canAdvance: isAssignee || isAdmin,
    canCancel: isCreator || isAdmin,
    canDelete: isCreator || isAdmin,
  };
}

/**
 * Is a status change from `from` to `to` legal for a user with `caps`?
 * - Forward only: open -> in_progress -> done (requires caps.canAdvance).
 * - Cancel: any non-terminal state -> cancelled (requires caps.canCancel).
 * - No backward moves, no skipping, no reopen, no no-op.
 *
 * @param {string} from current status
 * @param {string} to requested status
 * @param {ReturnType<typeof classifyTask>} caps
 */
function canTransition(from, to, caps) {
  if (!isValidStatus(from) || !isValidStatus(to)) return false;
  if (from === to) return false;

  if (to === 'cancelled') {
    return !!caps.canCancel && from !== 'done' && from !== 'cancelled';
  }
  if (FORWARD_TRANSITIONS[from] === to) {
    return !!caps.canAdvance;
  }
  return false;
}

module.exports = {
  TASK_STATUSES,
  TASK_PRIORITIES,
  FORWARD_TRANSITIONS,
  isValidStatus,
  isValidPriority,
  classifyTask,
  canTransition,
};
