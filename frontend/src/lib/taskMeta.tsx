import type { TaskStatus, TaskPriority } from "@/types"

export const STATUS_META: Record<TaskStatus, { label: string; colorVar: string }> = {
  in_progress: { label: "In Progress", colorVar: "var(--st-progress)" },
  todo: { label: "Todo", colorVar: "var(--st-todo)" },
  blocked: { label: "Blocked", colorVar: "var(--st-blocked)" },
  done: { label: "Done", colorVar: "var(--st-done)" },
  cancelled: { label: "Cancelled", colorVar: "var(--st-cancelled)" },
}

// Board columns + section order (in_progress first, done last).
export const BOARD_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done"]
export const SECTION_ORDER: TaskStatus[] = ["in_progress", "todo", "blocked", "done", "cancelled"]

export const PRIORITY_META: Record<TaskPriority, { label: string }> = {
  urgent: { label: "Urgent" },
  high: { label: "High" },
  medium: { label: "Medium" },
  low: { label: "Low" },
  none: { label: "No priority" },
}
export const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "medium", "low", "none"]

/** Linear-style status glyph (14px). Color comes from STATUS_META. */
export function StatusIcon({ status, size = 14 }: { status: TaskStatus; size?: number }) {
  const color = STATUS_META[status].colorVar
  const common = { width: size, height: size, viewBox: "0 0 14 14", fill: "none" as const }
  switch (status) {
    case "done":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" fill={color} />
          <path d="M4.3 7.1l1.9 1.9 3.5-3.7" stroke="#08090a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case "in_progress":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
          <path d="M7 7 L7 2 A5 5 0 0 1 11.33 9.5 Z" fill={color} />
        </svg>
      )
    case "blocked":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" fill={color} />
          <rect x="3.6" y="6.2" width="6.8" height="1.6" rx="0.8" fill="#08090a" />
        </svg>
      )
    case "cancelled":
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
          <path d="M4.8 4.8l4.4 4.4M9.2 4.8l-4.4 4.4" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )
    default: // todo
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" strokeDasharray="0.5 2.6" strokeLinecap="round" />
        </svg>
      )
  }
}

/** Priority as signal bars; urgent as a filled glyph. */
export function PriorityIcon({ priority, size = 14 }: { priority: TaskPriority; size?: number }) {
  if (priority === "urgent") {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
        <rect x="1.5" y="1.5" width="11" height="11" rx="2.5" fill="var(--st-blocked)" />
        <rect x="6.3" y="3.6" width="1.4" height="4.4" rx="0.7" fill="#08090a" />
        <rect x="6.3" y="9.2" width="1.4" height="1.4" rx="0.7" fill="#08090a" />
      </svg>
    )
  }
  const lit = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0
  const bars = [
    { x: 1.5, h: 4, y: 9.5 },
    { x: 5.8, h: 7, y: 6.5 },
    { x: 10.1, h: 10, y: 3.5 },
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width="2.4"
          height={b.h}
          rx="0.8"
          fill={i < lit ? "var(--muted-foreground)" : "var(--border-strong)"}
        />
      ))}
    </svg>
  )
}

export function initials(name: string): string {
  const s = (name || "").trim()
  if (!s) return "?"
  const parts = s.split(/[\s_.-]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return s.slice(0, 2).toUpperCase()
}

// Deterministic muted hue for avatars/tags from a string.
export function hueFor(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360
  return h
}

export function formatDate(value: string | null): string {
  if (!value) return ""
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(value)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short" })
}

export type DueTone = "muted" | "warn" | "over"

export function dueMeta(due: string | null, status: TaskStatus): { label: string; tone: DueTone } | null {
  if (!due) return null
  const label = formatDate(due)
  if (status === "done" || status === "cancelled") return { label, tone: "muted" }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(due)
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(due)
  d.setHours(0, 0, 0, 0)
  const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return { label, tone: "over" }
  if (days <= 2) return { label, tone: "warn" }
  return { label, tone: "muted" }
}
