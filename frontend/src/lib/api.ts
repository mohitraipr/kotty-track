import type {
  Task,
  TaskView,
  TaskStatus,
  TaskPriority,
  AssignableUser,
  TaskHistoryEntry,
  Project,
} from "@/types"

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })
  if (res.status === 401) {
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`)
  return data as T
}

export interface TaskInput {
  title: string
  description?: string
  status?: TaskStatus
  priority?: TaskPriority
  due_date?: string | null
  assigned_to?: number
  project_id?: number | null
  tags?: string[]
}

export const api = {
  list: (view: TaskView, projectId?: number | null) => {
    const qs = new URLSearchParams({ view })
    if (projectId) qs.set("project_id", String(projectId))
    return request<{ tasks: Task[] }>(`/tasks/api/tasks?${qs.toString()}`)
  },
  create: (input: TaskInput) =>
    request<{ task: Task }>(`/tasks/api/tasks`, { method: "POST", body: JSON.stringify(input) }),
  update: (id: number, input: Partial<TaskInput>) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  setStatus: (id: number, status: TaskStatus) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  assign: (id: number, assigned_to: number) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}/assign`, { method: "PATCH", body: JSON.stringify({ assigned_to }) }),
  remove: (id: number) => request<{ ok: true }>(`/tasks/api/tasks/${id}`, { method: "DELETE" }),
  users: (search = "") =>
    request<{ users: AssignableUser[] }>(`/tasks/api/users?search=${encodeURIComponent(search)}`),
  projects: () => request<{ projects: Project[] }>(`/tasks/api/projects`),
  createProject: (name: string, project_key?: string, color?: string) =>
    request<{ project: Project }>(`/tasks/api/projects`, {
      method: "POST",
      body: JSON.stringify({ name, project_key, color }),
    }),
  tags: () => request<{ tags: string[] }>(`/tasks/api/tags`),
  history: (id: number) => request<{ history: TaskHistoryEntry[] }>(`/tasks/api/tasks/${id}/history`),
}

export type { TaskStatus, TaskPriority }
