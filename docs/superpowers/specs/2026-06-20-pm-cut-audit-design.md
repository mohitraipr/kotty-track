# PM Cut Audit (Feature C) — decision snapshot + dispatch→reflection reconciliation

*Date: 2026-06-20. Status: design approved, ready for implementation plan.*
*Depends on Feature B (`utils/onOrder.js` `resolveSizeSku`). Branch `feat/pm-cut-audit` is stacked
on `feat/pm-overcut-fix`; rebase onto `main` once B merges.*

## Context / Problem

Today the cut loop is auditable only in pieces. Nothing records **why** a lot was cut (the DRR /
suggested at the decision moment — `pm_cut_assignment` keeps the assignment but not those numbers).
And nothing reconciles **what happened after**: finishing dispatches goods (often in several
batches), and EasyEcom SOH *should* rise within a day or two — but if it doesn't (goods not actually
sent to the warehouse, or a sync gap), there is no signal. The owner wants to be able to audit:

> "a lot cut 70 pcs for one size, 80 for another; dispatched in batches (20, then 30, then 20); the
> next day EasyEcom stock should start reflecting — if it can't, we can do the audit."

## Goal

Persist the cut **decision** (DRR/suggested), then **nightly reconcile** each lot/size's finishing
dispatches against EasyEcom snapshot deltas — sales-adjusted — and surface a **cut-audit page** plus
a dashboard flag for "dispatched but not reflecting."

## Key data reality (shapes the design)

`pm_cut_assignment` (the cut decision) is **not** FK-linked to the physical `cutting_lots`
(`cutting_lot_id` is left null at assign time; the cutter lot-writeback / forward-binding is a
separate unbuilt roadmap item). So the only bridge decision → lot → dispatch is **style + size**.
Therefore C is **two loosely-coupled records**:

- a **decision snapshot** keyed by `style + size + decided_at` (captured at assign time), and
- a **reflection ledger** anchored on the **physical lot** (`finishing_dispatches.lot_no + size`),
  which is exact and works today.

The audit page correlates the two by style+size (best-effort); the correlation becomes exact once
forward-binding lands (out of scope here).

## Design

Everything new is gated behind env flag **`PM_CUT_AUDIT`** (default OFF). No existing behavior
changes when off.

### 1. Decision snapshot — `pm_cut_decision_snapshot`

Captured inside `POST /pm/api/cut-plan/assign` ([routes/productionManagerRoutes.js:528](../../../routes/productionManagerRoutes.js#L528)),
once per assign action: call `getCuttingRecommendations` once, and for each assigned size write one row.

```sql
CREATE TABLE IF NOT EXISTS pm_cut_decision_snapshot (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  assignment_id   INT NULL,                 -- pm_cut_assignment.id that produced this row
  style           VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,        -- resolveSizeSku(style,size_label); NULL if unresolved
  assigned_qty    INT NOT NULL,             -- pieces assigned to cut for this size
  drr             DECIMAL(10,4) NULL,       -- DRR at decision time
  suggested_cut_qty INT NULL,               -- suggested at decision time
  soh             INT NULL,
  doh             DECIMAL(10,2) NULL,
  decided_by      INT NULL,
  decided_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_style_size (style, size_label),
  INDEX idx_decided_at (decided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

This is immutable lineage — "what we knew when we decided to cut." Per-assignment only (not a daily
snapshot of all SKUs — that would be the big-data forecasting history the owner has explicitly
declined, and would re-bloat the DB).

### 2. Reflection ledger — `pm_dispatch_reflection`

Grain = one row per `(lot_no, size_label)`. Written/updated by the nightly job.

```sql
CREATE TABLE IF NOT EXISTS pm_dispatch_reflection (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lot_no          VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,        -- resolveSizeSku(style,size_label)
  style           VARCHAR(100) NULL,        -- cutting_lots.sku for lot_no, for display/correlation
  dispatched_qty  INT NOT NULL,             -- SUM(finishing_dispatches.quantity)
  first_dispatch_date DATE NULL,
  last_dispatch_date  DATE NULL,
  batch_count     INT NOT NULL DEFAULT 0,   -- number of dispatch rows
  soh_before      INT NULL,                 -- snapshot qty the day before first_dispatch_date
  reflected_qty   INT NULL,                 -- best-estimate pieces that showed up (sales-adjusted)
  reflected_date  DATE NULL,                -- first day actual caught up to expected (within tol)
  lag_days        INT NULL,                 -- reflected_date − last_dispatch_date
  gap_qty         INT NULL,                 -- dispatched − reflected (>0 = missing)
  status          ENUM('pending','reflected','partial','not_reflected') NOT NULL DEFAULT 'pending',
  reconciled_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_lot_size (lot_no, size_label),
  INDEX idx_status (status),
  INDEX idx_size_sku (size_sku),
  INDEX idx_last_dispatch (last_dispatch_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3. Sales-adjusted reflection detection (the heart — a pure function)

A pure, unit-tested function `assessReflection(input) -> verdict` (new `utils/dispatchReflection.js`),
so the algorithm is testable on synthetic series with no DB.

**Input:** `{ sohBefore, dispatches:[{date,qty}], sales:[{date,qty}], snapshots:[{date,qty}],
graceDays, deadlineDays, tolerancePct, today }` (all dates `YYYY-MM-DD`).

**Logic.** Let `totalDispatched = Σ dispatches.qty`, `tol = max(1, round(tolerancePct/100 ·
totalDispatched))`. Walk snapshot days `d` from `firstDispatchDate` forward:
```
expected(d) = sohBefore + cumDispatched(≤d) − cumSales(≤d)     // sales pull SOH down
actual(d)   = snapshot qty on d
reflected when:  cumDispatched(≤d) == totalDispatched  AND  actual(d) ≥ expected(d) − tol
```
On the first such `d`: `reflected_date=d`, `lag_days = d − lastDispatchDate`, `status='reflected'`,
`reflected_qty=totalDispatched`, `gap_qty=0`.

If never fully reflected, at the last available snapshot compute the reflected fraction
`f = clamp((actualLast − (sohBefore − cumSalesLast)) / totalDispatched, 0, 1)`;
`reflected_qty = round(f·totalDispatched)`, `gap_qty = totalDispatched − reflected_qty`. Then:
- `today < lastDispatchDate + deadlineDays` → **pending** (still within the grace/deadline window).
- past deadline and `f ≤ tolerancePct/100` → **not_reflected** (≈nothing arrived).
- past deadline and `f ≥ 1 − tolerancePct/100` → **reflected** (caught up late; set reflected_date to the catch-up day if found).
- otherwise → **partial** (some arrived, short of full).

**Params (env, with defaults):** `PM_REFLECT_GRACE_DAYS=3`, `PM_REFLECT_DEADLINE_DAYS=7`,
`PM_REFLECT_TOLERANCE_PCT=15`.

**Scope:** primary warehouse only (per locked decision — secondary warehouse 429s ignored). Snapshots
from `ee_inventory_daily_snapshot`, sales from `ee_sales_daily` `source='mini_sales_report'`, same
basis the cut engine uses.

### 4. Nightly reconciliation job

`reconcileDispatchReflection(pool, params)` (new `utils/dispatchReflection.js`), folded into
`runPullWorker` ([utils/easyecomPullWorker.js](../../../utils/easyecomPullWorker.js)) as a final
`reconcile_reflection` step bracketed by `logStep(...)`, gated on `PM_CUT_AUDIT`.

Steps (bounded + idempotent):
1. Select `(lot_no, size_label)` with any `finishing_dispatches.sent_at` in the last
   `deadlineDays + buffer` (e.g. +14) days; aggregate `dispatched_qty, first/last_dispatch_date,
   batch_count`. Join `cutting_lots` for `style`.
2. Resolve `size_sku` via `resolveSizeSku(style, size_label, resolutionMap, canonSet)` — build the
   resolution map + canon set once (reuse the loaders from `utils/onOrder.js`).
3. For each, load `soh_before` (snapshot on the day before `first_dispatch_date`), the per-day
   `snapshots` and `sales` for `size_sku` over the window, call `assessReflection`, and upsert into
   `pm_dispatch_reflection` (`ON DUPLICATE KEY UPDATE` on `uniq_lot_size`).

Rows already `reflected` can be skipped on later runs (terminal), keeping the nightly cost bounded.

### 5. Surfacing

- **Audit page `/pm/audit`** (new route + view on the `pm-suite` design system; sidebar → Tools →
  "Cut Audit"). Table of recent lot/size rows: style, lot, size, dispatched, dispatched dates +
  batch count, reflected qty, reflected date, lag, gap, status pill (green reflected / amber partial
  / grey pending / red not_reflected). Filter by status; the matching **decision snapshot**
  (DRR/suggested at cut time) shown alongside by style+size. Backed by `GET /pm/api/audit`.
- **Dashboard flag:** a small count of `status='not_reflected'` (from a lightweight
  `GET /pm/api/audit/summary`) shown on the dashboard, so problems find the PM.

## Reuse

`resolveSizeSku` + the resolution-map/canon loaders (`utils/onOrder.js`), `finishing_dispatches`,
`ee_inventory_daily_snapshot`, `ee_sales_daily`, `runPullWorker` + `logStep`, the `pm-suite.css`
system, `pmHead`/`pmSidebar` partials.

## Out of scope

Forward-binding / cutter lot-writeback (makes decision↔lot exact); Feature A (style-page UX); the
LINKS.csv Myntra load; any change to the live cut/suggested math (that was Feature B).

## Risks / assumptions

- **Decision↔lot correlation is best-effort (style+size)** until forward-binding lands. The
  reflection audit itself (lot-anchored) is exact; only the DRR/suggested *context* shown beside a
  lot is approximate.
- **Reflection detection is heuristic.** Returns/RTOs, transfers between warehouses, and manual stock
  adjustments also move SOH and can muddy "expected vs actual." The tolerance + sales adjustment
  absorb normal noise; persistent `not_reflected` is a signal to investigate, not proof.
- **Resolver coverage.** Unresolved `size_sku` (no `pm_sku_resolution` row + no canon match) can't be
  reconciled against snapshots; such rows are written with `size_sku NULL`, `status='pending'`, and
  surfaced as "unresolved" on the audit page rather than silently dropped.
- **Snapshot retention.** The ledger persists `reflected_date`/`gap` so the audit survives snapshot
  pruning; reconciliation needs only the recent-window snapshots.

## Verification (end-to-end, dev DB, `PM_CUT_AUDIT=1`)

1. **Decision snapshot:** approve & assign a cut → `pm_cut_decision_snapshot` gets one row per size
   with the DRR/suggested/soh/doh that `/pm` showed at that moment; `size_sku` resolved.
2. **Clean reflection:** seed a lot with dispatches (e.g. 20+30+20) for a size-SKU and snapshot rows
   where SOH rises by ~70 over the next 1–2 days (minus sales) → run `reconcileDispatchReflection` →
   ledger row `status='reflected'`, sensible `lag_days`, `gap_qty=0`.
3. **Not reflected:** same dispatches but SOH flat for `deadlineDays+1` → `status='not_reflected'`,
   `gap_qty ≈ dispatched`; dashboard count increments; row appears on `/pm/audit` filtered to
   not_reflected.
4. **Sales masking:** dispatch 30, same-window sales 35, SOH dips then recovers to expected →
   `assessReflection` still marks reflected (sales-adjusted), not a false alarm.
5. **Pending:** a dispatch from today → `status='pending'` (within grace), no false flag.
6. **Idempotent + bounded:** re-run the job → reflected rows unchanged, only recent-window lots
   recomputed.
7. **Unit tests:** `assessReflection` covers reflected / not_reflected / partial / pending /
   sales-masked / multi-batch on synthetic series, no DB. Flag OFF → `runPullWorker` skips the step
   and the audit routes return empty/disabled.
