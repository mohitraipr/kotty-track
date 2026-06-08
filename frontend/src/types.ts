export type TaskStatus = "open" | "in_progress" | "done" | "cancelled"
export type TaskPriority = "low" | "medium" | "high"
export type TaskView = "mine" | "assigned_to_me" | "assigned_by_me"

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  due_date: string | null
  created_by: number
  assigned_to: number
  created_at: string
  updated_at: string
  completed_at: string | null
  created_by_username: string
  assigned_to_username: string
}

export interface AssignableUser {
  id: number
  username: string
}

export interface TaskHistoryEntry {
  id: number
  previous_status: TaskStatus | null
  new_status: TaskStatus
  note: string | null
  changed_at: string
  changed_by_username: string
}
