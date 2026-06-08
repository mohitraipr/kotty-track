import type { Task, TaskStatus, TaskView } from "@/types"
import type { Caps } from "@/lib/caps"
import { STATUS_META, PRIORITY_META, NEXT_STEP, dueMeta } from "@/lib/taskMeta"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  MoreHorizontal,
  Pencil,
  Trash2,
  XCircle,
  Check,
  Play,
  CalendarDays,
  Clock,
  ArrowRight,
  User,
} from "lucide-react"

interface TaskCardProps {
  task: Task
  caps: Caps
  view: TaskView
  onAdvance: (task: Task, to: TaskStatus) => void
  onCancel: (task: Task) => void
  onEdit: (task: Task) => void
  onDelete: (task: Task) => void
  onHistory: (task: Task) => void
  style?: React.CSSProperties
}

const DUE_TONE: Record<string, string> = {
  muted: "text-muted-foreground",
  warn: "text-[#c4873a]",
  over: "text-destructive",
}

export function TaskCard({
  task,
  caps,
  view,
  onAdvance,
  onCancel,
  onEdit,
  onDelete,
  onHistory,
  style,
}: TaskCardProps) {
  const status = STATUS_META[task.status]
  const priority = PRIORITY_META[task.priority]
  const next = NEXT_STEP[task.status]
  const due = dueMeta(task.due_date, task.status)
  const isClosed = task.status === "done" || task.status === "cancelled"

  // Who the relevant counterpart is, depending on the active view.
  const person =
    view === "assigned_to_me"
      ? { icon: <User className="size-3.5" />, label: `from ${task.created_by_username}` }
      : view === "assigned_by_me"
      ? { icon: <ArrowRight className="size-3.5" />, label: `to ${task.assigned_to_username}` }
      : null

  return (
    <Card
      className="tasks-rise flex items-start gap-4 p-4 transition-shadow hover:shadow-md"
      style={{ borderLeft: `3px solid ${priority.color}`, ...style }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3
            className={
              "truncate text-[0.95rem] font-semibold " +
              (isClosed ? "text-muted-foreground line-through" : "text-foreground")
            }
          >
            {task.title}
          </h3>
          <Badge variant={status.variant}>{status.label}</Badge>
        </div>

        {task.description && (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{task.description}</p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block size-2 rounded-full" style={{ background: priority.color }} />
            {priority.label}
          </span>
          {due && (
            <span className={"inline-flex items-center gap-1 " + DUE_TONE[due.tone]}>
              <CalendarDays className="size-3.5" />
              {due.label}
            </span>
          )}
          {person && (
            <span className="inline-flex items-center gap-1">
              {person.icon}
              {person.label}
            </span>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {next && caps.canAdvance && (
          <Button size="sm" onClick={() => onAdvance(task, next.to)}>
            {task.status === "open" ? <Play /> : <Check />}
            {next.label}
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="Task actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {caps.canEditFields && (
              <DropdownMenuItem onSelect={() => onEdit(task)}>
                <Pencil /> {caps.canReassign ? "Edit / reassign" : "Edit"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onHistory(task)}>
              <Clock /> View history
            </DropdownMenuItem>
            {caps.canCancel && !isClosed && (
              <DropdownMenuItem onSelect={() => onCancel(task)}>
                <XCircle /> Cancel task
              </DropdownMenuItem>
            )}
            {caps.canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onDelete(task)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Card>
  )
}
