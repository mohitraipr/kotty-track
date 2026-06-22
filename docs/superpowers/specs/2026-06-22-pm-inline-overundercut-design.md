# PM Style Page — inline (in-production) qty + over/undercut (Feature D)

*Date: 2026-06-22. Status: design approved, ready for implementation plan.*
*Branch `feat/pm-inline-overundercut` off `main` (B/C/A merged). Frontend-only.*

## Context / Problem

The style page shows per-size SOH / Days-left / Suggested and a "Suggested cut" total, but it
doesn't show how much of a size is **already in production** (the in-flight/"inline" qty), nor
whether each size is **under- or over-cut** relative to what's actually needed. The owner wants the
inline quantity surfaced — total in the Suggested-cut card and per-size in the Size breakdown — with
a clear undercut/overcut indicator.

## Goal

On `views/productionManagerStyle.ejs` (frontend only — no endpoint change), using fields
`/pm/api/sizes` already returns per size (`soh`, `drr`, `lead_time`, `safety_days`,
`upcoming_po_qty`, `open_lot_qty`, `suggested_cut_qty`):

1. **Size breakdown** — each size card shows **"In production: N"** (N = `open_lot_qty`) and a status
   chip: **Undercut · need X** / **Overcut · Y extra** / **Covered**.
2. **Suggested-cut card** — a roll-up sub-line: **"In production {total} · Undercut {U} · Overcut {O}"**.

## Definitions (owner-approved: compare inline to the cut requirement)

Per size, from the `/api/sizes` row `r`:
- `inline = open_lot_qty`
- `under = suggested_cut_qty` — the authoritative undercut amount (the server already computes
  `suggested = max(0, horizon×DRR − SOH − open_lot_qty + PO)`, i.e. the remaining gap after inline).
- `over` (only when `under === 0`): `req = (lead_time + safety_days)×DRR − SOH + upcoming_po_qty`;
  `over = max(0, round(inline − req))` — how much more is in production than the horizon requires.
- Status: `under > 0` → **Undercut**; else `over > 0` → **Overcut**; else **Covered**.

Using the server's `suggested_cut_qty` for the undercut amount keeps the per-size number identical to
the displayed "Suggested", and `over` is derived only in the covered/overstocked case — a size is
never both under and over.

## Design

All changes are in the inline `<script>` of `views/productionManagerStyle.ejs`, plus a few CSS chips
in `public/css/pm-suite.css`. Straight ASCII quotes only (inline-script must pass `node --check`).

### 1. Pure helper `sizeOverUnder(r)`

Returns `{ inline, under, over, status }` per the definitions above. `status ∈ 'under'|'over'|'covered'`.

### 2. Size breakdown (`loadSizes`, the `SIZES.map` card render at ~line 136)

Each `.sizecard` gains, below the existing Suggested row:
- an **"In production"** row showing `inline` (omit/― when 0 is fine to still show "0"),
- a status chip: amber `Undercut · need {under}` / red `Overcut · {over} extra` / green `Covered`.

### 3. Suggested-cut card roll-up

`loadSizes` already computes `SUGGESTED_TOTAL` (= Σ`suggested_cut_qty` = Σ under) and `IN_PROD`
(= Σ`open_lot_qty`). Add `TOTAL_OVER = Σ over`. Render a sub-line inside the "Suggested cut" `.scard`
(a new `<div class="sub" id="kSuggestedSub">` under `#kSuggested`):
**"In production {IN_PROD} · Undercut {SUGGESTED_TOTAL} · Overcut {TOTAL_OVER}"** (hide the zero
segments to stay clean, e.g. show "Covered" if both totals are 0).

### CSS (`public/css/pm-suite.css`)

Small chip styles `.ouchip` with `.under` (amber), `.over` (red), `.covered` (green), mirroring the
existing pill/`pm-pill` token usage; and `.scard .sub` (muted, 12.5px) for the roll-up line.

## Reuse / out of scope

Reuses `/api/sizes` (no backend change), the `pm-suite` color tokens, `fmtNum`. **Out of scope:**
any endpoint/data change; `PM_CLOSED_LOOP`/`PM_CUT_AUDIT` enablement; resolver coverage. Note the
inline numbers are small while `PM_CLOSED_LOOP` is off (manual table only) and become the real
in-flight totals once it's on — the UI simply reflects `open_lot_qty`.

## Verification (manual)

1. Open `/pm/style/<style>`: each size card shows "In production: N" and exactly one chip
   (Undercut/Overcut/Covered); the Undercut amount equals that size's "Suggested".
2. The Suggested-cut card shows the roll-up; `Undercut` total == the "Suggested cut" big number;
   `In production` total == Σ per-size inline.
3. A size with `suggested_cut_qty = 0` and high `open_lot_qty`/SOH shows **Overcut · Y extra** with a
   sensible Y; a covered size with no inline shows **Covered**.
4. Inline `<script>` passes `node --check`; `ejs.renderFile` renders the page; `node --test` stays
   green (no test targets the view).
