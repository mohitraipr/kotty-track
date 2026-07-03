import { Badge } from "@/components/ui/badge"
import type { QcPassRow } from "@/qc/lib/api"

interface PassesTableProps {
  rows: QcPassRow[]
}

const HEADERS: { key: keyof QcPassRow; label: string; className?: string }[] = [
  { key: "passed_at", label: "Passed at", className: "tabnum whitespace-nowrap" },
  { key: "username", label: "User" },
  { key: "item_barcode", label: "Barcode", className: "tabnum" },
  { key: "tracking_number", label: "Tracking", className: "tabnum" },
  { key: "sku_code", label: "SKU" },
  { key: "style_id", label: "Style" },
  { key: "size", label: "Size" },
  { key: "quality", label: "Quality" },
  { key: "qc_action", label: "QC action" },
  { key: "warehouse_id", label: "WH" },
]

function cell(v: QcPassRow[keyof QcPassRow]) {
  return v == null || v === "" ? <span className="text-dim">—</span> : String(v)
}

/** Detail table of individual QC passes. Horizontal scroll on narrow viewports. */
export function PassesTable({ rows }: PassesTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No QC passes match these filters.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-elevated text-left text-xs uppercase tracking-wide text-muted-foreground">
            {HEADERS.map((h) => (
              <th key={h.key} className="whitespace-nowrap px-3 py-2.5 font-medium">{h.label}</th>
            ))}
            <th className="whitespace-nowrap px-3 py-2.5 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.item_barcode ?? "row"}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
              {HEADERS.map((h) => (
                <td key={h.key} className={`px-3 py-2 ${h.className ?? ""}`}>{cell(row[h.key])}</td>
              ))}
              <td className="px-3 py-2">
                {row.pass_success == null ? (
                  <span className="text-dim">—</span>
                ) : row.pass_success ? (
                  <Badge variant="success">pass</Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive">fail</Badge>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
