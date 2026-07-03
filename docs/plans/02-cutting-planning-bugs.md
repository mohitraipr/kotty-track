# Plan 02 — Cutting-Planning Correctness Backlog

_Status: Not started. Source: end-to-end audit (2026-07-03) of `/pm` cutting planning,
verified live against prod. Fix these **one by one**, each on its own branch/PR, each with a
before/after check. Ordered by value/effort._

## How cutting planning works (1-paragraph refresher)
`getCuttingRecommendations` (`utils/easyecomAnalytics.js:696`) computes, per size-SKU,
`suggested = max(0, horizon×DRR − SOH − in_flight + upcoming_PO)` where
`horizon = lead_time + safety_days` (default 12+3=15). DRR = units sold ÷ selling-days
(calendar-days fallback when <7 selling days). In-flight (cut-but-not-dispatched) netting is
in `utils/onOrder.js` (flag `PM_CLOSED_LOOP`, **on** in prod). The dashboard rolls size-SKUs
up to styles (`aggregateStyles`, `routes/productionManagerRoutes.js`), the style page shows
per-size detail, and "Approve & assign" writes a PM intent row (`pm_cut_assignment`).

Live health (03 Jul): engine returns 26,244 rows in 5.2 s, feed fresh — the engine **works**;
these are correctness/completeness defects on top.

---

## CP-1 — `orange` vs `amber` trigger mismatch  **[High · one-line fix]**
**Symptom:** the entire "Cut soon" tier is dead at style/dashboard level. Measured live:
**282 orange size-SKUs, 107 styles that are orange-only** (no red) show as **GREEN "Covered"**
and drop off the priority list.
**Cause:** analytics emits `trigger='orange'` (`easyecomAnalytics.js:851`), but the roll-up
and filters test `'amber'` (`routes/productionManagerRoutes.js:122`, `:132`, and the
`/api/styles` trigger filter `:422`; the view uses `value="amber"`).
**Fix:** unify the vocabulary — simplest is to emit `'amber'` from analytics (rename the one
literal at `:851`, and the demotion at `:852`), OR map orange→amber in `aggregateStyles`.
Prefer renaming at the source so per-size and style agree. Grep for every `'orange'`/`'amber'`
before/after.
**Verify:** re-run the live count — orange-only styles should now roll up as `amber`/`cut_soon`
and appear under the "Cut soon" filter.

## CP-2 — Closed loop not wired (assign never becomes "cut")  **[High · design decision]**
**Symptom:** "Approve & assign" only ever INSERTs `pm_cut_assignment` (+ `_sizes`). Nothing
ever sets `status='cut'` or links a `cutting_lot_id`. So the "Cut as lot X" link in
`assignedCuts.ejs` is dead, assignment status is permanently "TO CUT", and every master's
"cut" count in `/api/analytics` (`master_output`) is structurally **0**. When a cutting
master actually cuts, `routes/cuttingManagerRoutes.js` inserts `cutting_lots` independently
with **no back-reference** to the assignment.
**Decision needed:** is the PM "assign" meant to be (a) just an advisory note, or (b) a real
work order that gets marked cut? If (b):
- Add `cutting_lots.source_assignment_id` (nullable FK) — set it when a master cuts a lot that
  originated from an assignment (surface the assignment on the cutting-master screen so they
  cut "from" it).
- On lot creation, `UPDATE pm_cut_assignment SET status='cut', cutting_lot_id=? …`.
- Then the status pill, "Cut as lot X" link, and master cut-counts all light up.
**Verify:** assign a style → master cuts → assignment flips to "cut" with the lot linked;
`master_output.cut` > 0.

## CP-3 — Marketplace-PO sign  **[High · needs confirmation, then trivial]**
**Symptom/risk:** the formula does `… + upcomingPoQty` (`easyecomAnalytics.js:843`) — upcoming
PO **increases** the suggested cut. Correct only if `pm_marketplace_po_lines` are **outbound
demand** POs. If they're **inbound supply**, the sign is inverted (should subtract). Currently
the table is **empty (0 rows)**, so no live impact — but confirm intent before anyone uploads.
**Fix:** confirm semantics with the user; keep `+` for demand, switch to `−` (and clamp) for
supply. Add a code comment stating which it is.

## CP-4 — No transaction in `POST /api/cut-plan/assign`  **[Medium]**
**Symptom:** header + sizes inserts run on the bare pool; in **per-lot mode** (loop) a mid-loop
failure leaves partial assignments committed with no rollback (`productionManagerRoutes.js`
~`:655`, `:690`). Contrast the marketplace upload which is transactional (`:1037`).
**Fix:** wrap the whole assign (all lots + sizes + snapshots) in one `getConnection` +
`beginTransaction`/`commit`/`rollback`.
**Verify:** force a mid-loop error → nothing persists.

## CP-5 — Style-scope lead-times silently ignored  **[Medium]**
**Symptom:** the live recs path bulk-loads only `pm_style_lead_times WHERE scope='sku'`
(`easyecomAnalytics.js:756`); any `scope='style'` lead-time/safety/`override_drr` has **no
effect**, even though `getLeadTimeForSku` supports it. Today the table is empty so no impact,
but style-level config would silently do nothing.
**Fix:** also load `scope='style'` rows and resolve SKU→style fallback in `resolveLeadTime`
(SKU row wins, else style row, else defaults 12/3).
**Verify:** set a style-level override → recs for that style's SKUs reflect it.

## CP-6 — CAD size vocabulary not unified  **[Medium]**
**Symptom:** `cadConsumption.js` normalizes only letter sizes (`LETTER_SIZES`, no 5XL/6XL and
no numeric waist), but `deriveSize` emits 5XL/6XL/2–3-digit numerics. A CAD row for "5XL"/"34"
won't match, so that size is flagged `missing` in `fabricForCut` and cut **without a fabric
figure**.
**Fix:** unify the size grammar — share one `normalizeSize`/`deriveSize` between
`cadConsumption.js` and `easyecomAnalytics.js` (add 3XL–6XL + numeric to the CAD normalizer).
**Verify:** upload a CAD sheet with 5XL/6XL/numeric → those sizes get consumption, `missingSizes`
empty.

## CP-7 — `deriveStyle` over-strip  **[Medium]**
**Symptom:** `deriveStyle` (`easyecomAnalytics.js:594`) strips a trailing S/M/L/XL/XXL with no
delimiter, so a style whose base legitimately ends in one of those letters gets mis-read as a
size → mis-grouped, and `computeStyleCutPlan` drops SKUs whose derived size is null.
**Fix:** prefer the authored `pm_sku_resolution` map for style/size splitting where available;
for the regex path, add guards/known-style checks. Lower-risk: log/flag SKUs whose
`deriveStyle`+`deriveSize` don't round-trip so bad cases are visible.
**Verify:** pick a style ending in "…L" and confirm it groups correctly.

## CP-8 — Leftover `GET /pm/debug-ee`  **[Low · quick]**
Admin-only raw EasyEcom probe, self-labeled "remove after debugging"
(`productionManagerRoutes.js:1165`). **Delete it.**

## CP-9 — Redundant heavy recompute in assign path  **[Low]**
`computeStyleCutPlan` (→ full `getCuttingRecommendations`) runs 2× for single-master and once
**per lot** for per-lot mode (`recordCutDecisionSnapshot`). Compute the plan once and pass it
down.

## CP-10 — Resolver gap (over-cut risk)  **[Medium · monitor]**
In-flight lots whose size-SKU can't be resolved are **counted but not netted**
(`onOrder.js:35`), so their already-cut stock is invisible → potential over-cut. Surfaced as
`in_flight_unresolved` in `/api/styles` but with no threshold/alert.
**Fix:** (a) add an alert when unresolved pieces exceed a threshold; (b) drive down the gap by
filling `pm_sku_resolution` (there are resolver-upload endpoints already). Monitor the live
number after `PM_CLOSED_LOOP` is on.

---

## Also parked (not bugs, but incomplete/unused)
- **Marketplace POs**: `pm_marketplace_po_lines` empty — feature unused (see CP-3).
- **Lead-time config**: `pm_style_lead_times` empty — no per-style tuning in use (see CP-5).
- **Clean-day DRR**: running in `shadow` mode (legacy DRR is the live driver); the cleanday
  model is computed for diffing but the cutover isn't done (`easyecomAnalytics.js:779`).
- **Cut-decision audit**: gated behind `PM_CUT_AUDIT` (off) → no `pm_cut_decision_snapshot`
  rows → the Audit page's decision context is null.

## Suggested order
CP-1 (today, one line, big UI win) → CP-8 → CP-4 → CP-3 (decision) → CP-2 (decision, biggest)
→ CP-5 / CP-6 / CP-7 → CP-9 / CP-10.
