# Design: Denim-only weight auto-calc + fabric consumption analysis

Date: 2026-06-01
Branch: feat/production-manager-dashboard
Status: Approved (ready for implementation plan)

## Summary

Two independent features in the kotty-track manufacturing app:

1. **Cutting dashboard** — re-introduce the `weight_used = table_length × layers`
   auto-calculation, but gate it to **denim** lots only. Hosiery lots use the
   "normal" manual flow (enter Remaining, derive Used). Both still look up rolls
   in the fabric DB and deduct stock when the roll exists.
2. **Fabric-manager dashboard** — a new analysis page (3 tabs) showing where
   fabric is consumed, a roll-level ledger, and an unknown/ad-hoc data report
   for rolls and fabric types typed into cutting lots but absent from fabric data.

The two features share no code and can be built/merged independently.

---

## Feature 1 — Denim-only weight auto-calculation

### Background

The `weight_used = table_length × layers` auto-calc previously existed and was
reverted to manual entry in commits `a836111` (create form) and `48320f0`
(editcuttinglots add-roll). This feature brings the auto-calc back, but **only
for denim**.

A cutter is either a denim cutter or a hosiery cutter, determined by the
existing `users.is_denim_cutter` flag. The create-lot POST already stamps
`cutting_lots.flow_type` ('denim' | 'hosiery') from this flag
(cuttingManagerRoutes.js ~229-234). So the create form renders in a **single
mode** for the whole session — no per-roll toggle.

### Behavior

| Aspect | Denim (`is_denim_cutter = true`) | Hosiery (`is_denim_cutter = false`) |
|---|---|---|
| Weight Used | auto = `table_length × layers`, read-only | derived = `Full − Remaining`, read-only |
| Operator weight input | none (driven by layers + table_length) | **Remaining** (default `0`, editable) |
| `table_length` | **required** | not required |
| Roll lookup from fabric DB | yes — Full auto-fills + locks when roll found | yes — same |
| Roll not in DB | operator types Full | operator types Full |
| Deduct `fabric_invoice_rolls.per_roll_weight` | yes, when roll in DB | yes, when roll in DB |

### Why no backend change is needed

Both modes submit a **hidden `remaining_weight`**, and the create-lot POST
already recomputes `weight_used = full_weight − remaining_weight`
(cuttingManagerRoutes.js:351 for in-DB rolls, :371 for ad-hoc rolls). Therefore:

- **Denim frontend** computes `used = table_length × layers`, then back-fills the
  hidden `remaining = max(full − used, 0)`. The server recovers the same `used`.
- **Hosiery frontend** takes the operator's typed `remaining` directly.

The POST handlers in `cuttingManagerRoutes.js` and the add-roll handler in
`editcuttinglots.js` are unchanged. The only backend edits are passing an
`isDenim` flag into the two `res.render` calls.

Edge case (preserved from prior behavior): if denim `used > full`, the usage bar
flags red and hidden `remaining` clamps to `0` (server then records
`used = full`). This is the same clamp the pre-revert code had; we are not adding
new server-side validation.

### Worked examples

**Denim** — Lot `table_length = 1.5`. Operator picks roll `R-123` →
**Full = 50.00** auto-fills and locks. Enters **layers = 8** →
**Used = 1.5 × 8 = 12.00** (read-only); hidden `remaining = 50 − 12 = 38`. Save
deducts 12 from R-123 stock.

**Hosiery** — Operator picks roll `H-7` → **Full = 30.00** auto-fills. Leaves
**Remaining = 0** (default) → **Used = 30.00**. Or returns part: Remaining = 4 →
**Used = 26.00**. Save deducts the used amount.

### Scope / touchpoints

- `routes/cuttingManagerRoutes.js` — in `GET /dashboard`, query the cutter's
  `is_denim_cutter` and pass `isDenim` to `res.render('cuttingManagerDashboard', …)`.
- `views/cuttingManagerDashboard.ejs` — branch `updateWeightUsed()` on `isDenim`:
  - denim: `used = table_length × layers` (read-only Weight Used), back-fill
    hidden remaining, re-add `table_length` required validation + the
    create-button blocker when table_length is missing.
  - hosiery: Remaining is the editable input (default `0`); Weight Used becomes
    read-only derived = `full − remaining`.
  - Keep roll autocomplete, Full-weight auto-fill/lock, and the usage progress
    bar for both modes.
- `routes/editcuttinglots.js` — the add-missed-roll form already has
  `lot.flow_type`. Branch the same way: denim re-adds `table_length × layers`
  auto-calc + the "no table_length" blocker; hosiery keeps manual
  Remaining → derived Used.

### Out of scope

- No change to how `flow_type` / `is_denim_cutter` is set.
- No bulk-upload changes (bulkUploadRoutes.js) unless trivially needed.
- No new DB columns or migrations.

---

## Feature 2 — Fabric consumption analysis (fabric-manager dashboard)

### Goal

Give fabric managers visibility into where fabric is consumed, plus surface
data-quality gaps (rolls/types used in cutting that were never recorded in
fabric data).

### Page

New route `GET /fabric-manager/analysis`, gated by `isAuthenticated` +
`isFabricManager`, rendered as a tabbed page. Linked from the existing
fabric-manager dashboard action area.

### Data sources

- `cutting_lot_rolls` (roll_no, weight_used, full_weight, remaining_weight,
  cutting_lot_id) joined to `cutting_lots` (lot_no, sku, fabric_type, flow_type,
  created_at, user_id) for lot + fabric_type context.
- `fabric_invoice_rolls` (roll_no, per_roll_weight, unit, vendor_id) +
  `fabric_invoices` (fabric_type) + `vendors` (name) for the master/ledger side.
- `users` for "created by".

`cutting_lot_rolls` has no `fabric_type` column; fabric type comes from the
parent `cutting_lots` row.

### Tabs

**Tab 1 — Consumption by fabric type**
Grouped by `cutting_lots.fabric_type`. Each group header: total weight consumed,
distinct lot count, distinct roll count. Expand a group to list each lot
(`lot_no`, sku, created_at, cutter username, total used for that lot) and, under
each lot, the roll-by-roll breakdown (roll_no, full, used, remaining).

**Tab 2 — Roll-level ledger**
One row per roll that has been consumed. Columns: roll_no, fabric type, vendor,
original/current available weight (`fabric_invoice_rolls.per_roll_weight`, noting
this is the *current* post-deduction value), total used across all lots,
remaining, and the list of lots that consumed it. Fabric type usable as a
filter/sort.

**Tab 3 — Unknown / ad-hoc data**
- **Ad-hoc rolls**: `roll_no` in `cutting_lot_rolls` with no match in
  `fabric_invoice_rolls`. Show roll_no, fabric type (from the lot), full/used
  entered, owning lot, and who entered it.
  Detection: `LEFT JOIN fabric_invoice_rolls … WHERE fir.id IS NULL`.
- **Ad-hoc fabric types**: `cutting_lots.fabric_type` values not present in
  `fabric_invoices.fabric_type`.

### Date filter

A date-range filter (from / to, applied to `cutting_lots.created_at`) sits at the
top of the page and constrains all three tabs. Default range: all-time (empty
from/to). Filtering by consumption date means Tab 2's "total used" reflects only
lots within the range, while the roll's current available weight remains the
live `fabric_invoice_rolls.per_roll_weight`.

### Exports

Each tab gets an Excel export honoring the active date filter, matching the
existing fabric-manager download pattern (e.g. `/fabric-manager/download-excel`,
`/invoice/:id/download-rolls`).

### Frontend

Build the analysis view with the `/frontend-design` skill, following the
existing fabric-manager dashboard styling.

### Out of scope

- No edits/writes — analysis is read-only.

---

## Notes

- Frontend work for both features uses the `/frontend-design` skill per user
  request.
- Features are independent; either can ship without the other.
