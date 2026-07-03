import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import type { QcSummaryEntry } from "@/qc/lib/api"

interface SummaryBarProps {
  summary: QcSummaryEntry[]
  total: number
}

/** Per-user pass counts for the selected range, plus the grand total. */
export function SummaryBar({ summary, total }: SummaryBarProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-muted-foreground">Passes in range</span>
        <span className="tabnum text-2xl font-semibold text-foreground">{total.toLocaleString()}</span>
        <span className="text-sm text-muted-foreground">
          across {summary.length} {summary.length === 1 ? "user" : "users"}
        </span>
      </div>

      {summary.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {summary.map((s) => (
            <Card key={s.user} className="overflow-hidden">
              <CardContent className="flex items-center justify-between gap-2 p-3">
                <span className="truncate text-sm font-medium" title={s.user}>{s.user}</span>
                <Badge variant="default" className="tabnum shrink-0">{s.passes}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
