import { AlertTriangle, Download } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { QcErrorRow } from "@/qc/lib/api"

interface ErrorsTableProps {
  rows: QcErrorRow[]
  unresolved: number
  csvHref: string
}

const HEADERS: { key: keyof QcErrorRow; label: string; className?: string }[] = [
  { key: "searched_at", label: "Searched at", className: "tabnum whitespace-nowrap" },
  { key: "username", label: "User" },
  { key: "tracking_number", label: "Tracking", className: "tabnum" },
  { key: "search_status", label: "Status" },
  { key: "error_reason", label: "Reason", className: "min-w-[240px]" },
]

function cell(v: QcErrorRow[keyof QcErrorRow]) {
  return v == null || v === "" ? <span className="text-dim">—</span> : String(v)
}

/**
 * Errored scans — trackings whose RMS search failed (so they were never lost).
 * A row auto-resolves once a successful capture for that tracking later lands.
 */
export function ErrorsTable({ rows, unresolved, csvHref }: ErrorsTableProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-amber-500" />
          <h2 className="text-sm font-semibold">Errored scans</h2>
          {rows.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {unresolved} unresolved · {rows.length} total
            </span>
          )}
        </div>
        {rows.length > 0 && (
          <Button asChild variant="secondary" size="sm">
            <a href={csvHref} download>
              <Download /> CSV
            </a>
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No errored scans in this range.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-elevated text-left text-xs uppercase tracking-wide text-muted-foreground">
                {HEADERS.map((h) => (
                  <th key={h.key} className="whitespace-nowrap px-3 py-2.5 font-medium">{h.label}</th>
                ))}
                <th className="whitespace-nowrap px-3 py-2.5 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={`${row.tracking_number ?? "row"}-${i}`}
                  className={`border-b border-border/60 last:border-0 hover:bg-accent/40 ${row.resolved ? "opacity-60" : ""}`}
                >
                  {HEADERS.map((h) => (
                    <td key={h.key} className={`px-3 py-2 ${h.className ?? ""}`}>{cell(row[h.key])}</td>
                  ))}
                  <td className="px-3 py-2 whitespace-nowrap">
                    {row.resolved ? (
                      <Badge variant="success">resolved</Badge>
                    ) : (
                      <Badge variant="outline" className="text-amber-500">unresolved</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
