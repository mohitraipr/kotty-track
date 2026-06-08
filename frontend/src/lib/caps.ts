import type { Task } from "@/types"

// Client mirror of utils/taskLogic.js classifyTask(). The server remains the
// source of truth and re-checks every mutation; this only decides which actions
// to show so users aren't offered buttons that would 403.
export interface Caps {
  isCreator: boolean
  isAssignee: boolean
  isPersonal: boolean
  canEditFields: boolean
  canReassign: boolean
  canAdvance: boolean
  canCancel: boolean
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
    canAdvance: isAssignee || isAdmin,
    canCancel: isCreator || isAdmin,
    canDelete: isCreator || isAdmin,
  }
}

export function toast(message: string, type: "success" | "danger" | "info" | "warning" = "info") {
  window.KottyTrack?.showToast?.(message, type)
}
