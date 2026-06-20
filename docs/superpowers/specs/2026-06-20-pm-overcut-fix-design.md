# PM Overcut Fix — In-flight-aware suggested cut (Feature B)

*Date: 2026-06-20. Status: design approved, ready for implementation plan.*

## Context / Problem

`/pm` recommends how much to cut per size-SKU with:

```
suggested = max(0, horizon×DRR − SOH − openLotQty + upcomingPO)
```
([utils/easyecomAnalytics.js:842-845](../../../utils/easyecomAnalytics.js#L842))

The formula already subtracts an "on-order" quantity (`openLotQty`), **but that number is
built only from the manual `pm_open_cutting_lots` table**
([easyecomAnalytics.js:757-761](../../../utils/easyecomAnalytics.js#L757)). It does **not**
look at the real lots currently in production — the same lots the style page's lot-journey
panel displays. So when a lot for a size is sitting in stitching / washing / finishing, the
system is blind to it and re-suggests cutting it again → **overcut**.

The owner's intent: the in-flight ("inline") pipeline must be netted out of the suggested
cut, so that only the *remaining* gap is presented for assignment. This is the "close the
awareness loop / PE1" item from the cutting-planning roadmap.

## Goal

Make `suggested_cut_qty` (and therefore everything derived from it) account for real
in-flight cut lots, not just the manual table — with no overcut and no double-counting
against incoming stock.

## Why this is a small, well-bounded change

The assign flow's per-size `demand` is built **directly** from `getCuttingRecommendations`'
`suggested_cut_qty` ([routes/productionManagerRoutes.js:470-490](../../../routes/productionManagerRoutes.js#L470)
— `computeStyleCutPlan`). The dashboard priority table, the style page's per-size suggested,
the CAD cut-plan, the lot split, and the assign panel **all** read `suggested_cut_qty`
downstream. Therefore fixing the single on-order input fixes every surface automatically:
"after the inline data, whatever is left is assignable" falls out for free.

## Design

### 1. New function: `computeOnOrderBySku(pool)` (in `utils/easyecomAnalytics.js`)

Returns `Map<size_sku, qty>` = the union of two sources:

- **(a) Real in-flight lots.** Join `cutting_lots` → `cutting_lot_sizes`, net against shipped:
  per lot-size, **in-flight qty = cut pieces − pieces already dispatched**, where dispatched
  is `SUM(finishing_dispatches.quantity)` aggregated by `lot_no` + `size_label`. A fully
  dispatched lot-size contributes 0. Negative/zero results are clamped to 0.
  - Rationale for netting the dispatched portion (rather than treating a lot as all-or-nothing
    until fully dispatched): the already-shipped pieces are about to appear in EasyEcom SOH;
    counting them as both on-order **and** soon-to-be-SOH would double-count and over-suppress.
    Netting is the precise form of the approved "stop at dispatch" rule.
- **(b) Manual `pm_open_cutting_lots`** (existing query, `WHERE closed_at IS NULL`), kept
  during the transition while the real-lot path proves out. The manual table winds down over
  time; where a style has real in-flight lots, those are the source of truth.

Union semantics: sum (a)+(b) per `size_sku`. (Double-count risk only arises if an operator
both manually logged a lot **and** it exists as a real `cutting_lots` row for the same
size-SKU — surfaced by the verification step below; the manual table is being deprecated.)

### 2. Binding a lot's size → EasyEcom size-SKU

Suggested cut is keyed by ecom size-SKU, so each in-flight lot-size must resolve to one:

- **Primary — `pm_sku_resolution`:** look up `(cl_sku = lot.sku/style, size_label) → size_sku`
  where `state = 'resolved'`. This table exists for exactly this forward-binding purpose
  ([sql/2026_06_pm_sku_resolution.sql](../../../sql/2026_06_pm_sku_resolution.sql)).
- **Fallback (row not in the resolver):** build candidates `UPPER(style)+UPPER(label)` and
  `UPPER(style)+'_'+UPPER(label)`; accept whichever exists in the canonical EasyEcom SKU set
  (`ee_suborders`). Reuses the existing letter-matching approach in
  [utils/skuResolver.js](../../../utils/skuResolver.js).
- **Unresolved (neither resolves):** **not** silently dropped. Aggregate into a data-quality
  signal returned alongside the recommendations (count of lots + pieces that could not be
  netted) and surface it on the dashboard ("N in-flight lots, M pcs not netted — resolve
  these"). This keeps unresolved in-flight visible instead of letting it cause silent overcut.

### 3. Wiring point

Replace the `openLotMap` construction at
[easyecomAnalytics.js:757-761](../../../utils/easyecomAnalytics.js#L757) with a call to
`computeOnOrderBySku(pool)`. No change to the formula itself. Gate the new real-lot source
behind an env flag **`PM_CLOSED_LOOP`** (default off until validated on prod), so the
behavior can be toggled without a redeploy of logic.

### 4. Style-page surfacing (small, optional but recommended)

Near the per-size suggested cut on the style page
([views/productionManagerStyle.ejs](../../../views/productionManagerStyle.ejs)), add one line:
*"X pcs already in production across Y lots"*, driven by the same on-order data (the API
already returns `open_lot_qty` per size). This explains **why** the suggested number shrank;
the lot-journey panel directly below already enumerates those lots.

## Out of scope (separate specs)

- **C — Audit ledger:** persist DRR/suggested at decision time and reconcile finishing
  dispatches against EasyEcom snapshot deltas (the "did dispatched goods reflect in stock?"
  audit). When C lands, it upgrades the in-flight end-boundary from "stop at dispatch" to
  "stop when SOH actually reflects it," closing the 1–3 day transit gap.
- **A — Style-page UX:** sales/inventory period picker, collapse Approve & Assign into a
  dropdown, move lot journey above it.

## Risks / assumptions

- **Resolver coverage.** Netting at size-SKU grain is only as good as `pm_sku_resolution` +
  the fallback heuristic. Sparse coverage → more "unresolved" lots (flagged, not silently
  dropped). The data-quality signal makes the coverage gap visible and drives resolver fills.
- **Manual/real double-count.** Summing (a)+(b) can double-count if the same lot is in both.
  Mitigated by deprecating the manual table; the verification step checks for it explicitly.
- **Performance.** `computeOnOrderBySku` must be a small number of set-based queries (one for
  in-flight lots + dispatched aggregation, one for resolution, one for the manual table),
  building the map once per `getCuttingRecommendations` call — not per-SKU.

## Verification (end-to-end)

1. Pick a recent **undispatched** `cutting_lots` row for style X, size M (e.g. 80 pcs).
   With `PM_CLOSED_LOOP` on: `open_lot_qty` for X-M rises by 80, `suggested_cut_qty` for X-M
   drops by 80, the CAD cut-plan `demand` and lot split shrink accordingly; if the size is
   fully covered, the assign panel shows "covered."
2. Record a **partial** `finishing_dispatches` (e.g. 20 of the 80) → in-flight for X-M becomes
   60; suggested rises by 20.
3. Dispatch the remainder → the lot drops out of on-order entirely; suggested returns to the
   pre-lot value (modulo the 1–3 day SOH transit gap, which C will close).
4. **Double-count check:** a size-SKU present in both `pm_open_cutting_lots` and a real lot —
   confirm the reported on-order matches the intended union, not an accidental 2× subtraction.
5. **Toggle:** `PM_CLOSED_LOOP` off reproduces today's exact numbers (manual table only).
6. Dashboard shows the "unresolved in-flight" data-quality line when a lot's size can't be
   bound to a size-SKU.
