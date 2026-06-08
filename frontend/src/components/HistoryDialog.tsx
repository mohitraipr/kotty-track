import * as React from "react"
import type { Task, TaskHistoryEntry } from "@/types"
import { api } from "@/lib/api"
import { STATUS_META } from "@/lib/taskMeta"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Loader2, AlertCircle } from "lucide-react"

interface HistoryDialogProps {
  task: Task | null
  onOpenChange: (open: boolean) => void
}

function describe(entry: TaskHistoryEntry): string {
  if (entry.note) return entry.note
  if (entry.previous_status === null) return "Created"
  return `${STATUS_META[entry.previous_status].label} → ${STATUS_META[entry.new_status].label}`
}

export function HistoryDialog({ task, onOpenChange }: HistoryDialogProps) {
  const [entries, setEntries] = React.useState<TaskHistoryEntry[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!task) return
    let active = true
    setLoading(true)
    setError(null)
    api
      .history(task.id)
      .then((res) => active && setEntries(res.history))
      .catch((err) => active && setError(err instanceof Error ? err.message : "Failed to load history."))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [task])

  return (
    <Dialog open={!!task} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle style={{ fontFamily: "var(--font-serif)" }}>History</DialogTitle>
          <DialogDescription className="truncate">{task?.title}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4" /> {error}
          </div>
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No history yet.</p>
        ) : (
          <ol className="relative ml-1.5 border-l border-border">
            {entries.map((e) => (
              <li key={e.id} className="mb-4 ml-4 last:mb-0">
                <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full bg-primary" />
                <div className="text-sm font-medium text-foreground">{describe(e)}</div>
                <div className="text-xs text-muted-foreground">
                  {e.changed_by_username} · {e.changed_at}
                </div>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}
