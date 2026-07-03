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

// One row = one return item SCANNED by a user (qc_return_captures) — the FULL
// captured record — with the pass outcome (pass_success/passed_at) LEFT-joined
// from qc_return_passes. pass_success/passed_at are null when a scanned item was
// never QC-passed. Keep these keys in sync with ROW_COLUMNS in utils/qcDashboard.js.
export interface QcPassRow {
  captured_at: string | null
  username: string | null
  tracking_number: string | null
  item_barcode: string | null
  product_name: string | null
  article_no: string | null
  style_id: string | null
  size: string | null
  price: string | null
  return_type: string | null
  return_mode: string | null
  return_status: string | null
  rms_status: string | null
  qc_action: string | null
  quality: string | null
  created_date: string | null
  refund_date: string | null
  return_received_on: string | null
  return_restocked_on: string | null
  logistics_status: string | null
  courier_code: string | null
  return_hub: string | null
  dispatch_wh: string | null
  return_destination_wh: string | null
  delivery_center: string | null
  ship_city: string | null
  return_id: string | null
  oms_release_id: string | null
  sku_id: string | null
  sku_code: string | null
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

// One row = one tracking whose RMS search failed (never lost). `resolved` = a
// successful capture for that tracking has since landed.
export interface QcErrorRow {
  searched_at: string | null
  username: string | null
  tracking_number: string | null
  search_status: string | null
  error_reason: string | null
  resolved: number
}

export interface QcErrorsResponse {
  ok: boolean
  from: string
  to: string
  total: number
  unresolved: number
  rows: QcErrorRow[]
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

/** Full URL to the errors endpoint (shares the filter querystring; extra filters are ignored server-side). */
export function errorsUrl(
  filters: Partial<QcFilters>,
  extra: Record<string, string> = {}
): string {
  const qs = passesQueryString(filters, extra)
  return qs ? `/qc/api/errors?${qs}` : `/qc/api/errors`
}

export async function fetchErrors(filters: Partial<QcFilters>): Promise<QcErrorsResponse> {
  const res = await fetch(errorsUrl(filters), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
  if (res.status === 401) {
    window.location.href = "/login"
    throw new Error("Unauthorized")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || (data as QcErrorsResponse).ok === false) {
    throw new Error((data as { error?: string })?.error || `Request failed (${res.status})`)
  }
  return data as QcErrorsResponse
}

/** Today's date in IST as YYYY-MM-DD (matches the backend default range). */
export function istToday(now = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000)
  return ist.toISOString().slice(0, 10)
}
