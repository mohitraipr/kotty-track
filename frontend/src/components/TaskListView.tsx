import type { Task, TaskStatus } from "@/types"
import { classify } from "@/lib/caps"
import { STATUS_META, StatusIcon } from "@/lib/taskMeta"
import { TaskRow } from "@/components/TaskRow"
import { Skeleton } from "@/components/ui/skeleton"
import { Inbox, Plus } from "lucide-react"

interface Props {
  tasks: Task[] // already filtered + sorted into section order
  loading: boolean
  meId: number
  isAdmin: boolean
  selectedId: number | null
  emptyHint: string
  onOpen: (t: Task) => void
  onSetStatus: (t: Task, s: TaskStatus) => void
  onEdit: (t: Task) => void
  onDelete: (t: Task) => void
  onHover: (id: number) => void
  onCreate: () => void
}

export function TaskListView(props: Props) {
  const { tasks, loading, meId, isAdmin, selectedId } = props

  if (loading) return <ListSkeleton />
  if (!tasks.length) return <EmptyState hint={props.emptyHint} onCreate={props.onCreate} />

  // Group consecutive rows by status (tasks arrive pre-sorted in section order).
  const sections: { status: TaskStatus; items: Task[] }[] = []
  for (const t of tasks) {
    const last = sections[sections.length - 1]
    if (last && last.status === t.status) last.items.push(t)
    else sections.push({ status: t.status, items: [t] })
  }

  let idx = 0
  return (
    <div className="pb-24">
      {sections.map((sec) => (
        <section key={sec.status}>
          <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border/70 bg-background/85 px-3 py-1.5 backdrop-blur">
            <StatusIcon status={sec.status} />
            <span className="text-[13px] font-medium">{STATUS_META[sec.status].label}</span>
            <span className="text-[12px] tabular-nums text-dim">{sec.items.length}</span>
          </div>
          <div className="divide-y divide-border/50">
            {sec.items.map((task) => {
              const i = idx++
              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  caps={classify(task, meId, isAdmin)}
                  selected={selectedId === task.id}
                  index={i}
                  onOpen={() => props.onOpen(task)}
                  onSetStatus={(s) => props.onSetStatus(task, s)}
                  onEdit={() => props.onEdit(task)}
                  onDelete={() => props.onDelete(task)}
                  onHover={() => props.onHover(task.id)}
                />
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

function ListSkeleton() {
  return (
    <div className="px-3 pt-3">
      {[0, 1].map((g) => (
        <div key={g} className="mb-4">
          <Skeleton className="mb-2 h-4 w-28" />
          {Array.from({ length: g === 0 ? 4 : 3 }).map((_, i) => (
            <div key={i} className="flex h-9 items-center gap-3">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className="h-3.5" style={{ width: `${30 + ((i * 17) % 45)}%` }} />
              <Skeleton className="ml-auto size-5 rounded-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ hint, onCreate }: { hint: string; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24 text-center">
      <div className="grid size-12 place-items-center rounded-xl border border-border bg-elevated text-dim">
        <Inbox className="size-6" />
      </div>
      <p className="mt-4 text-[15px] font-medium">No tasks here</p>
      <p className="mt-1 max-w-xs text-[13px] text-muted-foreground">{hint}</p>
      <button
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90"
      >
        <Plus className="size-4" /> New task
        <kbd className="ml-1 rounded bg-black/20 px-1 font-mono text-[11px]">C</kbd>
      </button>
    </div>
  )
}
