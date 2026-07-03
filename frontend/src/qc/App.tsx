import { useCallback, useEffect, useMemo, useState } from "react"
import { ShieldCheck, AlertCircle } from "lucide-react"
import { FilterBar } from "./components/FilterBar"
import { SummaryBar } from "./components/SummaryBar"
import { PassesTable } from "./components/PassesTable"
import {
  fetchPasses,
  passesUrl,
  istToday,
  type QcFilters,
  type QcPassesResponse,
} from "./lib/api"

interface AppProps {
  meId: number
  role: string
  username: string
}

function defaultFilters(): QcFilters {
  const today = istToday()
  return { from: today, to: today, user: "", quality: "", qc_action: "", warehouse: "", q: "" }
}

export default function App({ username }: AppProps) {
  const defaults = useMemo(defaultFilters, [])
  const [applied, setApplied] = useState<QcFilters>(defaults)
  const [data, setData] = useState<QcPassesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (filters: QcFilters) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetchPasses(filters)
      setData(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load QC passes.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load(applied) }, [applied, load])

  const csvHref = useMemo(() => passesUrl(applied, { download: "csv" }), [applied])
  const total = data?.rows.length ?? 0

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="size-6 text-primary" />
          <div>
            <h1 className="text-lg font-semibold leading-tight">QC Dashboard</h1>
            <p className="text-sm text-muted-foreground">Returns scanned by user — with pass status</p>
          </div>
        </div>
        <span className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{username}</span>
        </span>
      </header>

      <FilterBar
        value={applied}
        defaults={defaults}
        csvHref={csvHref}
        loading={loading}
        onApply={setApplied}
      />

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      <SummaryBar summary={data?.summary ?? []} total={total} />

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {applied.from === applied.to ? applied.from : `${applied.from} → ${applied.to}`}
        </span>
        {loading && <span>Loading…</span>}
      </div>

      <PassesTable rows={data?.rows ?? []} />
    </div>
  )
}
