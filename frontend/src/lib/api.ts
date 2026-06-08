import type {
  Task,
  TaskView,
  TaskPriority,
  TaskStatus,
  AssignableUser,
  TaskHistoryEntry,
} from "@/types"

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: {
      // Accept JSON so the server's isAuthenticated returns 401 JSON instead of
      // a 302 redirect to an HTML login page (which fetch would silently follow).
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
  if (!res.ok) {
    throw new Error((data && (data as { error?: string }).error) || `Request failed (${res.status})`)
  }
  return data as T
}

export interface TaskInput {
  title: string
  description?: string
  priority?: TaskPriority
  due_date?: string | null
  assigned_to?: number
}

export const api = {
  list: (view: TaskView) =>
    request<{ tasks: Task[] }>(`/tasks/api/tasks?view=${encodeURIComponent(view)}`),
  create: (input: TaskInput) =>
    request<{ task: Task }>(`/tasks/api/tasks`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: number, input: Partial<TaskInput>) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  setStatus: (id: number, status: TaskStatus) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  assign: (id: number, assigned_to: number) =>
    request<{ task: Task }>(`/tasks/api/tasks/${id}/assign`, {
      method: "PATCH",
      body: JSON.stringify({ assigned_to }),
    }),
  remove: (id: number) =>
    request<{ ok: true }>(`/tasks/api/tasks/${id}`, { method: "DELETE" }),
  users: (search = "") =>
    request<{ users: AssignableUser[] }>(`/tasks/api/users?search=${encodeURIComponent(search)}`),
  history: (id: number) =>
    request<{ history: TaskHistoryEntry[] }>(`/tasks/api/tasks/${id}/history`),
}
