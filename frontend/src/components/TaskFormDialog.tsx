import * as React from "react"
import type { Task, TaskStatus, TaskPriority, AssignableUser, Project } from "@/types"
import type { TaskInput } from "@/lib/api"
import type { Caps } from "@/lib/caps"
import {
  STATUS_META,
  BOARD_STATUSES,
  PRIORITY_META,
  PRIORITY_ORDER,
  StatusIcon,
  PriorityIcon,
} from "@/lib/taskMeta"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Trash2, X } from "lucide-react"

interface Props {
  open: boolean
  onOpenChange: (o: boolean) => void
  mode: "create" | "edit"
  task?: Task | null
  caps?: Caps | null
  meId: number
  users: AssignableUser[]
  projects: Project[]
  onSubmit: (input: TaskInput) => Promise<void>
  onDelete?: () => void
}

export function TaskFormDialog({ open, onOpenChange, mode, task, caps, meId, users, projects, onSubmit, onDelete }: Props) {
  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [status, setStatus] = React.useState<TaskStatus>("todo")
  const [priority, setPriority] = React.useState<TaskPriority>("medium")
  const [assignedTo, setAssignedTo] = React.useState<number>(meId)
  const [projectId, setProjectId] = React.useState<string>("none")
  const [dueDate, setDueDate] = React.useState("")
  const [tags, setTags] = React.useState<string[]>([])
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? "")
    setDescription(task?.description ?? "")
    setStatus(task?.status ?? "todo")
    setPriority(task?.priority ?? "medium")
    setAssignedTo(task?.assigned_to ?? meId)
    setProjectId(task?.project_id ? String(task.project_id) : "none")
    setDueDate(task?.due_date ?? "")
    setTags(task?.tags ?? [])
    setError(null)
  }, [open, task, meId])

  const canFields = mode === "create" || !!caps?.canEditFields
  const canStatus = mode === "create" || !!caps?.canSetStatus

  const assigneeOptions = React.useMemo<AssignableUser[]>(() => {
    const map = new Map<number, string>([[meId, "Myself"]])
    for (const u of users) if (u.id !== meId) map.set(u.id, u.username)
    if (task && !map.has(task.assigned_to)) map.set(task.assigned_to, task.assigned_to_username)
    return Array.from(map, ([id, username]) => ({ id, username }))
  }, [users, meId, task])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return setError("Title is required.")
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        title: t,
        description: description.trim(),
        status,
        priority,
        assigned_to: assignedTo,
        project_id: projectId === "none" ? null : Number(projectId),
        due_date: dueDate || null,
        tags,
      })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New task" : "Task details"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-3.5">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            maxLength={255}
            autoFocus
            disabled={!canFields}
            className="h-10 border-0 bg-transparent px-0 text-base font-medium shadow-none focus-visible:ring-0"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description…"
            disabled={!canFields}
            className="min-h-[80px] border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />

          {/* Property grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-elevated/40 p-3">
            <Field label="Status">
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)} disabled={!canStatus}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BOARD_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="inline-flex items-center gap-2"><StatusIcon status={s} /> {STATUS_META[s].label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Priority">
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)} disabled={!canFields}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITY_ORDER.map((p) => (
                    <SelectItem key={p} value={p}>
                      <span className="inline-flex items-center gap-2"><PriorityIcon priority={p} /> {PRIORITY_META[p].label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Assignee">
              <Select value={String(assignedTo)} onValueChange={(v) => setAssignedTo(Number(v))} disabled={!canFields}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {assigneeOptions.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>{u.id === meId ? "Myself" : u.username}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Project">
              <Select value={projectId} onValueChange={setProjectId} disabled={!canFields}>
                <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No project</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="Due date">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={!canFields} className="h-8" />
            </Field>

            <Field label="Tags">
              <TagsField tags={tags} setTags={setTags} disabled={!canFields} />
            </Field>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter className="items-center">
            {mode === "edit" && onDelete && caps?.canDelete && (
              <Button type="button" variant="ghost" className="mr-auto text-destructive hover:bg-destructive/10" onClick={onDelete}>
                <Trash2 /> Delete
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            {(canFields || canStatus) && (
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving…" : mode === "create" ? "Create task" : "Save"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label className="text-[11px] uppercase tracking-wide text-dim">{label}</Label>
      {children}
    </div>
  )
}

function TagsField({ tags, setTags, disabled }: { tags: string[]; setTags: (t: string[]) => void; disabled?: boolean }) {
  const [input, setInput] = React.useState("")
  const add = () => {
    const v = input.trim().slice(0, 50)
    if (v && !tags.some((t) => t.toLowerCase() === v.toLowerCase()) && tags.length < 12) setTags([...tags, v])
    setInput("")
  }
  return (
    <div className="flex h-8 flex-wrap items-center gap-1 overflow-hidden rounded-md border border-input bg-card px-1.5">
      {tags.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded bg-elevated px-1.5 py-0.5 text-[12px] leading-none">
          {t}
          {!disabled && (
            <button type="button" onClick={() => setTags(tags.filter((x) => x !== t))} className="text-dim hover:text-foreground">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add() }
            else if (e.key === "Backspace" && !input && tags.length) setTags(tags.slice(0, -1))
          }}
          onBlur={add}
          placeholder={tags.length ? "" : "Add tags…"}
          className="min-w-[50px] flex-1 bg-transparent text-sm outline-none placeholder:text-dim"
        />
      )}
    </div>
  )
}
