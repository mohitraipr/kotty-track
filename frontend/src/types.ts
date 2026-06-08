export type TaskStatus = "todo" | "in_progress" | "done" | "blocked" | "cancelled"
export type TaskPriority = "none" | "low" | "medium" | "high" | "urgent"
export type TaskView = "all" | "mine"

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  due_date: string | null
  created_by: number
  assigned_to: number
  project_id: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
  created_by_username: string
  assigned_to_username: string
  project_name: string | null
  project_key: string | null
  project_color: string | null
  tags: string[]
}

export interface Project {
  id: number
  name: string
  project_key: string
  color: string | null
  task_count: number
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
