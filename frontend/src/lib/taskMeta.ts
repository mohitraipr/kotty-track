import type { TaskStatus, TaskPriority } from "@/types"

type BadgeVariant = "default" | "success" | "muted" | "secondary"

export const STATUS_META: Record<TaskStatus, { label: string; variant: BadgeVariant }> = {
  open: { label: "Open", variant: "secondary" },
  in_progress: { label: "In progress", variant: "default" },
  done: { label: "Done", variant: "success" },
  cancelled: { label: "Cancelled", variant: "muted" },
}

export const PRIORITY_META: Record<TaskPriority, { label: string; color: string }> = {
  high: { label: "High", color: "#c23b22" },
  medium: { label: "Medium", color: "#c4873a" },
  low: { label: "Low", color: "#3a7ec4" },
}

// The single legal forward step the assignee/owner can take from a given status.
export const NEXT_STEP: Partial<Record<TaskStatus, { to: TaskStatus; label: string }>> = {
  open: { to: "in_progress", label: "Start" },
  in_progress: { to: "done", label: "Mark done" },
}

export function formatDate(value: string | null): string {
  if (!value) return ""
  // Plain 'YYYY-MM-DD' from the API; parse as local to avoid a tz shift.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

export type DueTone = "muted" | "warn" | "over"

export function dueMeta(due: string | null, status: TaskStatus): { label: string; tone: DueTone } | null {
  if (!due) return null
  const label = formatDate(due)
  if (status === "done" || status === "cancelled") return { label, tone: "muted" }

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due)
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(due)
  d.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)

  if (days < 0) return { label: `${label} · overdue`, tone: "over" }
  if (days <= 2) return { label, tone: "warn" }
  return { label, tone: "muted" }
}
