import * as React from "react"
import type { Task, TaskStatus, TaskView, AssignableUser } from "@/types"
import { api, type TaskInput } from "@/lib/api"
import { classify, toast } from "@/lib/caps"
import { TaskCard } from "@/components/TaskCard"
import { TaskForm } from "@/components/TaskForm"
import { HistoryDialog } from "@/components/HistoryDialog"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Plus, ListTodo, Inbox, Send, Loader2, AlertCircle } from "lucide-react"

interface AppProps {
  meId: number
  isAdmin: boolean
}

type FormState =
  | { open: false }
  | { open: true; mode: "create" }
  | { open: true; mode: "edit"; task: Task }

const VIEWS: { value: TaskView; label: string; icon: React.ReactNode }[] = [
  { value: "mine", label: "My To-Dos", icon: <ListTodo /> },
  { value: "assigned_to_me", label: "Assigned to Me", icon: <Inbox /> },
  { value: "assigned_by_me", label: "Assigned by Me", icon: <Send /> },
]

const EMPTY: Record<TaskView, { icon: React.ReactNode; title: string; body: string }> = {
  mine: {
    icon: <ListTodo className="size-7" />,
    title: "Your desk is clear",
    body: "No to-dos yet. Add your first task and it’ll show up right here.",
  },
  assigned_to_me: {
    icon: <Inbox className="size-7" />,
    title: "Nothing assigned to you",
    body: "When a teammate assigns you a task, you’ll find it here.",
  },
  assigned_by_me: {
    icon: <Send className="size-7" />,
    title: "You haven’t assigned anything",
    body: "Tasks you assign to teammates will appear here.",
  },
}

export default function App({ meId, isAdmin }: AppProps) {
  const [view, setView] = React.useState<TaskView>("mine")
  const [tasks, setTasks] = React.useState<Task[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [users, setUsers] = React.useState<AssignableUser[]>([])
  const [form, setForm] = React.useState<FormState>({ open: false })
  const [historyTask, setHistoryTask] = React.useState<Task | null>(null)

  const reload = React.useCallback(async (v: TaskView) => {
    setLoading(true)
    try {
      const { tasks } = await api.list(v)
      setTasks(tasks)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks.")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void reload(view)
  }, [view, reload])

  React.useEffect(() => {
    api.users().then((r) => setUsers(r.users)).catch(() => {})
  }, [])

  async function handleCreate(input: TaskInput) {
    await api.create(input)
    toast(input.assigned_to && input.assigned_to !== meId ? "Task assigned." : "Task created.", "success")
    await reload(view)
  }

  async function handleEdit(input: TaskInput) {
    if (!form.open || form.mode !== "edit") return
    const task = form.task
    await api.update(task.id, input)
    if (input.assigned_to !== undefined && input.assigned_to !== task.assigned_to) {
      await api.assign(task.id, input.assigned_to)
    }
    toast("Task updated.", "success")
    await reload(view)
  }

  async function handleAdvance(task: Task, to: TaskStatus) {
    try {
      await api.setStatus(task.id, to)
      toast(to === "done" ? "Nice — marked done." : "Task started.", "success")
      await reload(view)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update status.", "danger")
    }
  }

  async function handleCancel(task: Task) {
    if (!window.confirm(`Cancel "${task.title}"?`)) return
    try {
      await api.setStatus(task.id, "cancelled")
      toast("Task cancelled.", "info")
      await reload(view)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not cancel task.", "danger")
    }
  }

  async function handleDelete(task: Task) {
    if (!window.confirm(`Delete "${task.title}"? This cannot be undone.`)) return
    try {
      await api.remove(task.id)
      toast("Task deleted.", "info")
      await reload(view)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete task.", "danger")
    }
  }

  const editCaps = form.open && form.mode === "edit" ? classify(form.task, meId, isAdmin) : null

  return (
    <div className="mx-auto max-w-3xl px-1 py-2">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-normal text-foreground" style={{ fontFamily: "var(--font-serif)" }}>
            Tasks
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Personal to-dos and work you share with the team.
          </p>
        </div>
        <Button onClick={() => setForm({ open: true, mode: "create" })}>
          <Plus /> New task
        </Button>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as TaskView)}>
        <TabsList>
          {VIEWS.map((v) => (
            <TabsTrigger key={v.value} value={v.value}>
              {v.icon}
              <span className="hidden sm:inline">{v.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>

        {VIEWS.map((v) => (
          <TabsContent key={v.value} value={v.value}>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-20 text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : error ? (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <AlertCircle className="size-4" /> {error}
              </div>
            ) : tasks.length === 0 ? (
              <EmptyState view={v.value} onAdd={() => setForm({ open: true, mode: "create" })} />
            ) : (
              <div className="grid gap-3">
                {tasks.map((task, i) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    view={v.value}
                    caps={classify(task, meId, isAdmin)}
                    style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
                    onAdvance={handleAdvance}
                    onCancel={handleCancel}
                    onEdit={(t) => setForm({ open: true, mode: "edit", task: t })}
                    onDelete={handleDelete}
                    onHistory={setHistoryTask}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <TaskForm
        open={form.open}
        mode={form.open ? form.mode : "create"}
        initial={form.open && form.mode === "edit" ? form.task : null}
        allowAssign={form.open && form.mode === "edit" ? !!editCaps?.canReassign : true}
        users={users}
        meId={meId}
        onOpenChange={(open) => !open && setForm({ open: false })}
        onSubmit={form.open && form.mode === "edit" ? handleEdit : handleCreate}
      />

      <HistoryDialog task={historyTask} onOpenChange={(open) => !open && setHistoryTask(null)} />
    </div>
  )
}

function EmptyState({ view, onAdd }: { view: TaskView; onAdd: () => void }) {
  const e = EMPTY[view]
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        {e.icon}
      </div>
      <h2 className="mt-4 text-lg font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
        {e.title}
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{e.body}</p>
      {view !== "assigned_to_me" && (
        <Button className="mt-5" onClick={onAdd}>
          <Plus /> New task
        </Button>
      )}
    </div>
  )
}
