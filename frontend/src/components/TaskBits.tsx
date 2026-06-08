import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { initials, hueFor, dueMeta } from "@/lib/taskMeta"
import type { Task, TaskStatus } from "@/types"
import { CalendarDays } from "lucide-react"

export function UserAvatar({ username, size = 20 }: { username: string; size?: number }) {
  const h = hueFor(username || "?")
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Avatar style={{ width: size, height: size }}>
          <AvatarFallback
            style={{ background: `hsl(${h} 26% 22%)`, color: `hsl(${h} 55% 78%)`, fontSize: size * 0.42 }}
          >
            {initials(username)}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent>{username}</TooltipContent>
    </Tooltip>
  )
}

export function TagChip({ tag }: { tag: string }) {
  const h = hueFor(tag)
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-elevated px-1.5 py-[2px] text-[11px] leading-none text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: `hsl(${h} 50% 58%)` }} />
      {tag}
    </span>
  )
}

export function ProjectChip({ task }: { task: Pick<Task, "project_name" | "project_key" | "project_color"> }) {
  if (!task.project_key) return null
  const color = task.project_color || `hsl(${hueFor(task.project_key)} 50% 60%)`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5 rounded border border-border bg-elevated px-1.5 py-[2px] text-[11px] font-medium leading-none text-muted-foreground">
          <span className="size-2 rounded-[3px]" style={{ background: color }} />
          {task.project_key}
        </span>
      </TooltipTrigger>
      <TooltipContent>{task.project_name}</TooltipContent>
    </Tooltip>
  )
}

const DUE_COLOR: Record<string, string> = {
  muted: "var(--muted-foreground)",
  warn: "var(--warning)",
  over: "var(--st-blocked)",
}

export function DueChip({ due, status }: { due: string | null; status: TaskStatus }) {
  const meta = dueMeta(due, status)
  if (!meta) return null
  return (
    <span className="inline-flex items-center gap-1 text-[11px] tabular-nums" style={{ color: DUE_COLOR[meta.tone] }}>
      <CalendarDays className="size-3" />
      {meta.label}
    </span>
  )
}
