import * as React from "react"
import type { Task, TaskPriority, AssignableUser } from "@/types"
import type { TaskInput } from "@/lib/api"
import { PRIORITY_META } from "@/lib/taskMeta"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

interface TaskFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: "create" | "edit"
  initial?: Task | null
  /** Show the "Assign to" picker (create, or edit when the user may reassign). */
  allowAssign: boolean
  users: AssignableUser[]
  meId: number
  onSubmit: (input: TaskInput) => Promise<void>
}

const PRIORITIES: TaskPriority[] = ["low", "medium", "high"]

export function TaskForm({
  open,
  onOpenChange,
  mode,
  initial,
  allowAssign,
  users,
  meId,
  onSubmit,
}: TaskFormProps) {
  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [priority, setPriority] = React.useState<TaskPriority>("medium")
  const [dueDate, setDueDate] = React.useState("")
  const [assignedTo, setAssignedTo] = React.useState<number>(meId)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setTitle(initial?.title ?? "")
    setDescription(initial?.description ?? "")
    setPriority(initial?.priority ?? "medium")
    setDueDate(initial?.due_date ?? "")
    setAssignedTo(initial?.assigned_to ?? meId)
    setError(null)
  }, [open, initial, meId])

  // "Myself" + any team members not already listed (covers the current assignee).
  const options = React.useMemo<AssignableUser[]>(() => {
    const map = new Map<number, string>()
    map.set(meId, "Myself")
    for (const u of users) if (u.id !== meId) map.set(u.id, u.username)
    if (initial && !map.has(initial.assigned_to)) {
      map.set(initial.assigned_to, initial.assigned_to_username)
    }
    return Array.from(map, ([id, username]) => ({ id, username }))
  }, [users, meId, initial])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) {
      setError("Title is required.")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        title: trimmed,
        description: description.trim(),
        priority,
        due_date: dueDate || null,
        assigned_to: assignedTo,
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle style={{ fontFamily: "var(--font-serif)" }}>
            {mode === "create" ? "New task" : "Edit task"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Add a to-do for yourself, or assign it to a teammate."
              : "Update the details of this task."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Send the dispatch report"
              maxLength={255}
              autoFocus
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="task-desc">Description</Label>
            <Textarea
              id="task-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details…"
            />
          </div>

          {allowAssign && (
            <div className="grid gap-1.5">
              <Label>Assign to</Label>
              <Select value={String(assignedTo)} onValueChange={(v) => setAssignedTo(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.id === meId ? "Myself" : u.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block size-2 rounded-full"
                          style={{ background: PRIORITY_META[p].color }}
                        />
                        {PRIORITY_META[p].label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="task-due">Due date</Label>
              <Input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : mode === "create" ? "Create" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
