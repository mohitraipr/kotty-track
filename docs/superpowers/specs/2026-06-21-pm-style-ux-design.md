# PM Style-Page UX (Feature A) — sales/inventory trend + reorder + collapse

*Date: 2026-06-21. Status: design approved, ready for implementation plan.*
*Stacked on Features B (`feat/pm-overcut-fix`) and C (`feat/pm-cut-audit`); branch `feat/pm-style-ux`
is on top of `feat/pm-cut-audit`. Rebase onto `main` as B/C merge.*

## Context / Problem

The PM style detail page ([views/productionManagerStyle.ejs](../../../views/productionManagerStyle.ejs))
shows a per-size snapshot (SOH/DRR/DOH) but no view of how the style has **sold or stocked over
time**, and its layout buries the in-flight **lot journey** below a large, always-expanded
**Approve & assign** panel. The owner wants: (1) a sales + inventory trend with a flexible period
picker, (2) the lot journey moved **above** the assign panel, and (3) the assign panel **collapsed**
into a dropdown so it doesn't dominate the page.

There is no per-style time-series endpoint today (only a global 30-day `sales_by_day` on the
dashboard), and the app uses a hand-rolled inline SVG sparkline (no chart library) — both reused here.

## Goal

Add a per-style sales + inventory trend (free day-count 1–90 + daily/weekly/monthly granularity, two
sparklines) and restructure the page: Header → Size breakdown → **Sales & inventory trend (new)** →
**Lot journey (moved up)** → **Approve & assign (collapsed, moved down)**.

## Design

Purely additive UI + one read-only endpoint. No env flag (the endpoint degrades to empty if the
EasyEcom tables are missing; the layout changes are inert without data).

### 1. Export `deriveStyle` / `deriveSize` from `utils/easyecomAnalytics.js`

These already exist ([easyecomAnalytics.js:592-605](../../../utils/easyecomAnalytics.js#L592)) but are
private. Add both to `module.exports` so the trend endpoint can resolve a style's size-SKUs exactly
(via `deriveStyle(sku) === style`), avoiding the `KTTTOP37`-vs-`KTTTOP374` prefix-collision bug a bare
`LIKE 'style%'` would introduce. No behavior change to existing callers.

### 2. New endpoint `GET /pm/api/style-trend`

`routes/productionManagerRoutes.js`. Query: `style` (required), `days` (1–90, default 30, clamped),
`granularity` (`daily`|`weekly`|`monthly`, default `daily`).

Returns `{ ok: true, style, days, granularity, sales: [{bucket, qty}], inventory: [{bucket, qty}] }`.

- **Resolve the style's size-SKUs:** select distinct `sku` from `ee_sales_daily` and
  `ee_inventory_daily_snapshot` within the window where `sku LIKE CONCAT(style,'%')`, then keep only
  those with `deriveStyle(sku) === style` (exact). (Prefilter by `LIKE` to bound the scan; `deriveStyle`
  makes it exact.)
- **Sales (a flow → summed):** `SUM(qty)` from `ee_sales_daily` over those SKUs, `source =
  'mini_sales_report'`, `sale_date >= CURDATE() − days`, grouped by the bucket key.
- **Inventory (a level → end-of-bucket value, NOT summed):** for each bucket, the SOH = sum across the
  SKUs of the snapshot `qty` on the bucket's **last available snapshot_date** (≤ bucket end). Primary
  warehouse only (snapshot table is primary-only); SUM across `warehouse_id`.
- **Bucket key by granularity:** daily → `DATE`; weekly → `YEARWEEK(date, 3)` (ISO, Mon-start); monthly
  → `DATE_FORMAT(date,'%Y-%m')`. Buckets returned chronologically; `bucket` is a display label
  (`YYYY-MM-DD` / `YYYY-Www` / `YYYY-MM`).
- Graceful: wrap in try/catch; on `ER_NO_SUCH_TABLE` or any error return `{ ok: true, sales: [],
  inventory: [] }` so the page renders empty rather than erroring.

The sales/inventory queries should be **set-based** (group-by), not per-SKU loops.

### 3. Trend UI on the style page

A new section **"Sales & inventory"** placed **after Size breakdown**:
- Controls: a number input `#trendDays` (min 1, max 90, value 30) + a 3-button segmented toggle
  `#trendGran` (Daily / Weekly / Monthly) styled with the existing `.pm-tab`/segmented pattern.
- Body: two compact cards side by side — **Sales/day** and **Inventory (SOH)** — each rendering an
  inline SVG sparkline (reuse the dashboard's `.spark` polyline markup from
  [productionManagerDashboard.ejs:282](../../../views/productionManagerDashboard.ejs#L282)) plus a
  headline number: sales card shows the window's **total units sold**; inventory card shows the
  **latest SOH** in the window.
- Behaviour: a `loadTrend()` JS fn fetches `/pm/api/style-trend?style=&days=&granularity=` and rebuilds
  the two sparklines; bound to `change`/`input` on the controls (debounced ~250 ms on the number
  input). Empty/degraded response → a `.pm-empty` "No sales/inventory history" message.

### 4. Reorder + collapse

- **Move the Lot journey section above the Approve & assign section.** Lot journey currently sits below
  assign ([productionManagerStyle.ejs:72](../../../views/productionManagerStyle.ejs#L72)); assign is at
  [:66](../../../views/productionManagerStyle.ejs#L66). Swap so journey precedes assign. The supporting
  JS (`loadLotHistory`, `loadAssignPanel`, `loadSizes`) is unchanged — only DOM order moves.
- **Collapse Approve & assign** into a `<details class="pm-collapse">` (collapsed by default). The
  `<summary>` shows "Approve & assign cut" + the existing `#planSummary` hint (in-production/fabric);
  expanding reveals the existing `#assignBody`/assign panel unchanged.
- The header's existing **Approve & assign** button (`#approveTop`,
  [:32](../../../views/productionManagerStyle.ejs#L32)) currently scrolls to `#assignSection`; update its
  handler to also set the `<details open>` before scrolling, so the CTA still works when collapsed.
- Minimal CSS for `.pm-collapse` (summary cursor/marker, padding) added to `public/css/pm-suite.css`,
  following the existing `.usermenu`/`details` styling already in that file.

## Reuse

The dashboard SVG sparkline markup, `pm-suite.css` design system (`.pm-tab`, `.pm-card`, `.pm-empty`,
`.tcard`), `deriveStyle`/`deriveSize`, `ee_sales_daily`, `ee_inventory_daily_snapshot`.

## Out of scope

Per-size trend drill-down (style-level only for v1); any change to the suggested-cut math (B) or the
audit (C); the LINKS.csv Myntra load (next task); a charting library.

## Risks / assumptions

- **SKU→style resolution** relies on `deriveStyle`; styles whose SKUs don't follow the size-suffix
  convention may under-resolve — acceptable for a trend view, and the prefilter+exact filter is the
  same logic the cut engine uses.
- **Inventory granularity:** weekly/monthly inventory shows the **end-of-bucket** SOH (a level), so a
  sparse snapshot history yields a coarser line — acceptable; sales remain summed.
- **Bucket gaps:** days with no sales produce no `ee_sales_daily` row; the endpoint returns only buckets
  that have data — the sparkline connects present points (no zero-filling in v1).

## Verification (manual, dev DB)

1. `/pm/api/style-trend?style=<known>&days=30&granularity=daily` returns chronological `sales` and
   `inventory` arrays; `days=2` narrows the window; `granularity=weekly`/`monthly` re-buckets; `days=999`
   clamps to 90.
2. A style with a longer-prefixed sibling (e.g. `KTTTOP37` vs `KTTTOP374`) does NOT cross-count —
   `deriveStyle` exactness holds.
3. Style page: the "Sales & inventory" section renders two sparklines; changing the day-count/granularity
   updates them; the day input is clamped to 1–90.
4. Section order is Header → Size breakdown → Sales & inventory → Lot journey → Approve & assign; the
   assign panel is collapsed by default and the header "Approve & assign" button opens + scrolls to it.
5. Tables absent / no data → the trend shows the empty state and the rest of the page is unaffected.
6. Inline `<script>` blocks pass `node --check` (no smart-quote/syntax regression); `node --test` stays
   green (no unit tests target the view; this guards require-time errors in the route).
