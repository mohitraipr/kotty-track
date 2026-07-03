// QC dashboard API client + pure querystring helpers (the helpers are unit-tested
// in qs.test.ts so the URL contract stays stable without a live backend).

export interface QcFilters {
  from: string
  to: string
  user: string
  quality: string
  qc_action: string
  warehouse: string
  q: string
}

// One row = one return item SCANNED by a user (qc_return_captures), with the
// pass outcome (pass_success/passed_at) LEFT-joined from qc_return_passes.
// pass_success/passed_at are null when a scanned item was never QC-passed.
export interface QcPassRow {
  captured_at: string | null
  username: string | null
  item_barcode: string | null
  tracking_number: string | null
  sku_code: string | null
  style_id: string | null
  product_name: string | null
  size: string | null
  quality: string | null
  qc_action: string | null
  return_status: string | null
  logistics_status: string | null
  warehouse_id: string | null
  pass_success: number | null
  passed_at: string | null
}

export interface QcSummaryEntry {
  user: string
  passes: number // number of returns this user scanned in range
}

export interface QcPassesResponse {
  ok: boolean
  from: string
  to: string
  summary: QcSummaryEntry[]
  rows: QcPassRow[]
}

// Filter keys sent to the API (order fixed so URLs are deterministic/testable).
const FILTER_KEYS: (keyof QcFilters)[] = [
  "from",
  "to",
  "user",
  "quality",
  "qc_action",
  "warehouse",
  "q",
]

/**
 * Build the querystring for /qc/api/passes from filters. Blank/whitespace-only
 * values are omitted. `extra` (e.g. { download: 'csv' }) is appended last.
 * Pure — no fetch — so it can be unit-tested.
 */
export function passesQueryString(
  filters: Partial<QcFilters>,
  extra: Record<string, string> = {}
): string {
  const qs = new URLSearchParams()
  for (const key of FILTER_KEYS) {
    const raw = filters[key]
    if (raw != null && String(raw).trim() !== "") {
      qs.set(key, String(raw).trim())
    }
  }
  for (const [k, v] of Object.entries(extra)) qs.set(k, v)
  return qs.toString()
}

/** Full URL to the passes endpoint (used for both fetch + the Download CSV link). */
export function passesUrl(
  filters: Partial<QcFilters>,
  extra: Record<string, string> = {}
): string {
  const qs = passesQueryString(filters, extra)
  return qs ? `/qc/api/passes?${qs}` : `/qc/api/passes`
}

export async function fetchPasses(filters: Partial<QcFilters>): Promise<QcPassesResponse> {
  const res = await fetch(passesUrl(filters), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
  if (res.status === 401) {
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || (data as QcPassesResponse).ok === false) {
    throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`)
  }
  return data as QcPassesResponse
}

/** Today's date in IST as YYYY-MM-DD (matches the backend default range). */
export function istToday(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  return ist.toISOString().slice(0, 10)
}
