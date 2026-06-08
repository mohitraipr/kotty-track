import type { Task, TaskStatus } from "@/types"
import type { Caps } from "@/lib/caps"
import { cn } from "@/lib/utils"
import { STATUS_META, BOARD_STATUSES, StatusIcon, PriorityIcon } from "@/lib/taskMeta"
import { UserAvatar, TagChip, ProjectChip, DueChip } from "@/components/TaskBits"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Pencil, Trash2, Maximize2 } from "lucide-react"

interface Props {
  task: Task
  caps: Caps
  selected: boolean
  index: number
  onOpen: () => void
  onSetStatus: (s: TaskStatus) => void
  onEdit: () => void
  onDelete: () => void
  onHover: () => void
}

export function TaskRow({ task, caps, selected, index, onOpen, onSetStatus, onEdit, onDelete, onHover }: Props) {
  const blocked = task.status === "blocked"
  const muted = task.status === "done" || task.status === "cancelled"
  const idLabel = `${task.project_key || "T"}-${task.id}`

  return (
    <div
      role="button"
      tabIndex={-1}
      data-task-row={task.id}
      onMouseEnter={onHover}
      onClick={onOpen}
      className={cn(
        "group row-in relative flex h-9 cursor-default select-none items-center gap-2.5 border-l-2 pl-2.5 pr-2 text-sm outline-none",
        blocked ? "row-blocked" : "hover:bg-elevated",
        selected && "bg-elevated"
      )}
      style={{
        borderLeftColor: selected ? "var(--primary)" : blocked ? "var(--st-blocked)" : "transparent",
        animationDelay: `${Math.min(index, 16) * 11}ms`,
      }}
    >
      <span className="shrink-0">
        <PriorityIcon priority={task.priority} />
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!caps.canSetStatus}>
          <button
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 rounded p-0.5 hover:bg-accent disabled:pointer-events-none"
            aria-label="Set status"
          >
            <StatusIcon status={task.status} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
          {BOARD_STATUSES.map((s) => (
            <DropdownMenuItem key={s} onSelect={() => onSetStatus(s)}>
              <StatusIcon status={s} />
              {STATUS_META[s].label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <span className={cn("min-w-0 flex-1 truncate", muted && "text-muted-foreground line-through")}>
        {task.title}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="hidden items-center gap-1.5 md:flex">
          {task.tags.slice(0, 2).map((t) => (
            <TagChip key={t} tag={t} />
          ))}
          {task.tags.length > 2 && <span className="text-[11px] text-dim">+{task.tags.length - 2}</span>}
        </div>
        <ProjectChip task={task} />
        <DueChip due={task.due_date} status={task.status} />
        <span className="hidden w-14 text-right text-[11px] tabular-nums text-dim lg:inline">{idLabel}</span>
        <UserAvatar username={task.assigned_to_username} />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(e) => e.stopPropagation()}
              className="rounded p-1 text-muted-foreground opacity-0 outline-none hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              aria-label="Task actions"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onSelect={onOpen}>
              <Maximize2 /> Open
            </DropdownMenuItem>
            {caps.canEditFields && (
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil /> Edit
              </DropdownMenuItem>
            )}
            {caps.canDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
