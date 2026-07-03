import { Badge } from "@/components/ui/badge"
import type { QcPassRow } from "@/qc/lib/api"

interface PassesTableProps {
  rows: QcPassRow[]
}

const HEADERS: { key: keyof QcPassRow; label: string; className?: string }[] = [
  { key: "captured_at", label: "Scanned at", className: "tabnum whitespace-nowrap" },
  { key: "username", label: "User" },
  { key: "tracking_number", label: "Tracking", className: "tabnum" },
  { key: "item_barcode", label: "Barcode", className: "tabnum" },
  { key: "product_name", label: "Product", className: "min-w-[220px]" },
  { key: "article_no", label: "Article No" },
  { key: "style_id", label: "Style" },
  { key: "size", label: "Size" },
  { key: "price", label: "Price", className: "tabnum" },
  { key: "return_type", label: "Return Type" },
  { key: "return_mode", label: "Return Mode" },
  { key: "return_status", label: "Return Status" },
  { key: "rms_status", label: "RMS Status" },
  { key: "qc_action", label: "QC Action" },
  { key: "quality", label: "Quality" },
  { key: "created_date", label: "Created", className: "tabnum whitespace-nowrap" },
  { key: "refund_date", label: "Refund", className: "tabnum whitespace-nowrap" },
  { key: "return_received_on", label: "Received", className: "tabnum whitespace-nowrap" },
  { key: "return_restocked_on", label: "Restock", className: "tabnum whitespace-nowrap" },
  { key: "logistics_status", label: "Logistics" },
  { key: "courier_code", label: "Courier" },
  { key: "return_hub", label: "Return Hub" },
  { key: "dispatch_wh", label: "Dispatch WH" },
  { key: "return_destination_wh", label: "Destination WH" },
  { key: "delivery_center", label: "DC" },
  { key: "ship_city", label: "Ship City" },
  { key: "return_id", label: "Return Id", className: "tabnum" },
  { key: "oms_release_id", label: "OMS Release", className: "tabnum" },
  { key: "sku_id", label: "SKU Id", className: "tabnum" },
  { key: "sku_code", label: "SKU Code" },
  { key: "passed_at", label: "Passed at", className: "tabnum whitespace-nowrap" },
]

function cell(v: QcPassRow[keyof QcPassRow]) {
  return v == null || v === "" ? <span className="text-dim">—</span> : String(v)
}

/** Detail table of individual QC passes. Horizontal scroll on narrow viewports. */
export function PassesTable({ rows }: PassesTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No scanned returns match these filters.
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
            <th className="whitespace-nowrap px-3 py-2.5 font-medium">Passed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.item_barcode ?? "row"}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/40">
              {HEADERS.map((h) => (
                <td key={h.key} className={`px-3 py-2 ${h.className ?? ""}`}>{cell(row[h.key])}</td>
              ))}
              <td className="px-3 py-2 whitespace-nowrap">
                {row.pass_success == null ? (
                  <Badge variant="outline" className="text-muted-foreground">not passed</Badge>
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
