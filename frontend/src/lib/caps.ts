import type { Task } from "@/types"

// Client mirror of utils/taskLogic.js classifyTask(). Server re-checks every
// mutation; this only decides which actions to surface.
export interface Caps {
  isCreator: boolean
  isAssignee: boolean
  isPersonal: boolean
  canEditFields: boolean
  canReassign: boolean
  canSetStatus: boolean
  canDelete: boolean
}

export function classify(task: Task, meId: number, isAdmin: boolean): Caps {
  const isCreator = task.created_by === meId
  const isAssignee = task.assigned_to === meId
  return {
    isCreator,
    isAssignee,
    isPersonal: isCreator && isAssignee,
    canEditFields: isCreator || isAdmin,
    canReassign: isCreator || isAdmin,
    canSetStatus: isCreator || isAssignee || isAdmin,
    canDelete: isCreator || isAdmin,
  }
}

