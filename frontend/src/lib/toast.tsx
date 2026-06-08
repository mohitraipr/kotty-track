import * as React from "react"
import { Check, AlertCircle, Info } from "lucide-react"

type ToastType = "success" | "error" | "info"
interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const listeners = new Set<(t: ToastItem) => void>()
let counter = 1

export function toast(message: string, type: ToastType = "info") {
  const item = { id: counter++, message, type }
  listeners.forEach((l) => l(item))
}

const ICON = { success: Check, error: AlertCircle, info: Info }

export function Toaster() {
  const [items, setItems] = React.useState<ToastItem[]>([])

  React.useEffect(() => {
    const l = (t: ToastItem) => {
      setItems((prev) => [...prev, t])
      window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), 2800)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex flex-col gap-2">
      {items.map((t) => {
        const Icon = ICON[t.type]
        return (
          <div
            key={t.id}
            className="row-in pointer-events-auto flex items-center gap-2 rounded-lg border border-border-strong bg-popover px-3 py-2 text-sm shadow-2xl"
          >
            <Icon
              className="size-4"
              style={{ color: t.type === "error" ? "var(--st-blocked)" : t.type === "success" ? "var(--st-done)" : "var(--muted-foreground)" }}
            />
            <span className="text-foreground">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}
