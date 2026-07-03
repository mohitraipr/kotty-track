import { useEffect, useState } from "react"
import { Search, Download, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { QcFilters } from "@/qc/lib/api"

interface FilterBarProps {
  value: QcFilters
  defaults: QcFilters
  csvHref: string
  loading?: boolean
  onApply: (filters: QcFilters) => void
}

// Small labelled field wrapper for consistent spacing.
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

/**
 * Filter bar for the QC dashboard: date range (defaults to today), the enhanced
 * filters (user / quality / qc_action / warehouse), a free-text search, plus
 * Apply / Reset / Download CSV. Holds an editable draft; the parent stays the
 * source of truth for the *applied* filters (and thus the CSV link).
 */
export function FilterBar({ value, defaults, csvHref, loading, onApply }: FilterBarProps) {
  const [draft, setDraft] = useState<QcFilters>(value)

  // Keep the draft in sync when the parent replaces the applied filters (e.g. Reset).
  useEffect(() => { setDraft(value) }, [value])

  function set<K extends keyof QcFilters>(key: K, v: QcFilters[K]) {
    setDraft((d) => ({ ...d, [key]: v }))
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    onApply(draft)
  }

  return (
    <form onSubmit={submit} aria-label="QC pass filters" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Field id="qc-from" label="From">
          <Input id="qc-from" type="date" value={draft.from} onChange={(e) => set("from", e.target.value)} />
        </Field>
        <Field id="qc-to" label="To">
          <Input id="qc-to" type="date" value={draft.to} onChange={(e) => set("to", e.target.value)} />
        </Field>
        <Field id="qc-user" label="User">
          <Input id="qc-user" placeholder="username" value={draft.user} onChange={(e) => set("user", e.target.value)} />
        </Field>
        <Field id="qc-quality" label="Quality">
          <Input id="qc-quality" placeholder="e.g. good" value={draft.quality} onChange={(e) => set("quality", e.target.value)} />
        </Field>
        <Field id="qc-action" label="QC action">
          <Input id="qc-action" placeholder="e.g. restock" value={draft.qc_action} onChange={(e) => set("qc_action", e.target.value)} />
        </Field>
        <Field id="qc-warehouse" label="Warehouse">
          <Input id="qc-warehouse" placeholder="warehouse id" value={draft.warehouse} onChange={(e) => set("warehouse", e.target.value)} />
        </Field>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field id="qc-q" label="Search">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="qc-q"
                className="pl-8"
                placeholder="sku, style, barcode, tracking, product…"
                value={draft.q}
                onChange={(e) => set("q", e.target.value)}
              />
            </div>
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={loading}>
            {loading ? "Loading…" : "Apply"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onApply(defaults)}
            disabled={loading}
          >
            <RotateCcw /> Reset
          </Button>
          <Button asChild variant="secondary">
            <a href={csvHref} download>
              <Download /> Download CSV
            </a>
          </Button>
        </div>
      </div>
    </form>
  )
}
