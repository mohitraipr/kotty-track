# Floor-dashboard redesign — hand-off (design set)

The factory-floor operator dashboards (cutting, stitching, jeans-assembly, washing, washing-in,
finishing, the operator hub, Lot Admin) need a mobile-first, calmer redesign. This is the
**design package** to implement from — the direction, the design system, per-screen element
inventories, and the rendered reference screens. (The PM suite — `pm-suite.css` — is already
clean and is out of scope.)

## Where the designs live
Stitch project **"Kotty Floor — Operator (mobile)"** — `projects/2840441440757295069`
Design system asset — `assets/4693631576292800968`
Rendered reference screens (open in Stitch): **Stitching Operator (refined)**, **Operator Hub**,
**Lot Admin**, plus **Cutting entry** and **Stitching (complete controls)** generated with the Pro
model. Regenerate/extend any screen against the design-system asset above.

## Design direction — "The Lot's Journey"
Calm, precise, **industrial-editorial**. A phone-first tool used on the floor: one-handed, big tap
targets, single column, no horizontal scroll, thumb-reachable primary action. Spend all the
boldness on ONE signature; keep everything else quiet.

**Signature — the Stage Rail:** every lot is anchored by a horizontal journey — cut → stitch →
assembly → wash → wash-in → finish (hosiery hides the middle three). Small circular nodes joined by
a thin connector; done = green-ringed check + operator name; current = solid indigo node, slightly
larger; upcoming = hollow grey. Wraps to two rows on a phone, never scrolls sideways. (This already
exists in code as the cross-stage chain from the "who handled this lot" feature — utils/lotStageUsers.js.)

## Design tokens (the ONE system — replaces the 3 colliding ones today)
- **Ground** `#f7f8fa` · **ink** `#0f172a` · **muted** `#64748b` · **hairline** `#e5e7eb`
- **Action accent (only one):** indigo `#2563eb` (buttons, active tab, focus ring)
- **Status colours — used ONLY for status:** green `#16a34a` = completed/healthy · amber `#b45309`
  = in-progress / inline (WIP still held) · red `#dc2626` = reject / urgent. Show status as a soft
  pill (10–15% tint bg + solid text), never a big colour block.
- **Cards:** white, 12px radius, hairline border + soft shadow `0 1px 2px rgba(15,23,42,.06)`. No heavy borders.
- **Type:** numbers & headings = **Space Grotesk** (tight, industrial-gauge); UI & body = **Inter**;
  micro-labels (stage names, "cut by") = 11px uppercase, 0.04–0.06em tracking, muted.
- **Rhythm:** 8px spacing grid. **No gradients. No extra hues.** Numbers are the hero.

## Screen inventory — the REAL elements each screen must keep
A redesign that drops the critical controls is useless; reproduce every element below.

### Stage operator (stitching / jeans-assembly / washing / washing-in / finishing — one template)
Source: `views/stitchingEvents.ejs` + `routes/stitchingRoutes.js` (siblings are near-identical).
- Sticky search (lot no / SKU).
- Lot header: lot no, DENIM/HOSIERY pill, sku, "cut by", cutting remark, **Stage Rail**, the
  cross-stage "who handled it" chips.
- Stat strip: **Approved · Completed · Rejected · Inline** (semantic colours).
- **The critical work panel** — per-SIZE entry: each size row has an AVAILABLE count and a **stepper**
  (− / number / +) to take pieces in; a **Reject / rewash** toggle that expands a red-tinted stepper +
  a **reason** field; per-size running mini-totals; a grand total; a **remark** field; a full-width
  primary "Take into stitching" + a "Mark complete".
- Tabs: **My Work** (event history with day/type filters), **My Payments**, **Material Indent**.
- Finishing additionally has **dispatch** (destination + per-size quantity) — `finishing_dispatches`.

### Cutting entry (create lot)
Source: `views/cuttingManagerDashboard.ejs` + `routes/cuttingManagerRoutes.js` `POST /create-lot`.
- **Denim/Hosiery toggle** (drives the form; hosiery relaxes table_length) — the #5 selector.
- Lot no (auto), manual lot number (required), cutting date.
- **SKU builder** (brand · gender · category · code → live SKU preview).
- Fabric type (searchable), table length (denim), remark, image.
- **Sizes & patterns** (per-size dropdown + pattern-count stepper; bulk "30-6,32-7" entry).
- **Rolls used** (roll no · layers · full/remaining weight → live weight-used).
- Live **Total pieces = Σpattern × Σlayers** + "Create lot".

### Operator hub
Source: `views/operatorDashboard.ejs`. A 2-column tile grid (My Lots, Lot TAT, Lot Journey, Lot
Admin, Edit Cutting Lots, Rewash, Payments, Material Indent) + a quiet stat strip + bottom nav.

### Lot Admin (already built, mobile-first — `views/lotAdmin.ejs`)
Search → lot header + Stage Rail (per-stage event counts) → **Denim/Hosiery change** (guarded) →
**Edit cut quantity size-wise** (per-size floor) → **Reverse a mistaken take-in** (guarded, voids
pending payment). Keep the guard notes and disabled states.

## Implementation guidance (for whoever builds this)
1. **Consolidate to one token layer first.** Today `header.ejs` loads BOTH `kotty-theme.css` and
   `professional.css`, whose `:root` vars collide. Pick one token file (these tokens), stop loading
   the other, and cut the 10 web-fonts to the two above. This alone calms the "too many colours".
2. **Mobile chrome:** harden the off-canvas sidebar (scrim + touch sizing) and **wrap every wide
   `<table>` in an `overflow-x:auto` container** — that fixes the #1 mobile breakage across all stage
   dashboards at once. Add the viewport meta to the standalone form/print views that lack it.
3. **Migrate per dashboard**, highest-traffic first (stitching → cutting → operator hub), moving the
   giant inline `<style>` blocks onto the tokens and rebuilding each screen to the reference designs.
   Verify each in a browser — do NOT big-bang it.
4. Reuse `myLots.ejs` / `lotJourney.ejs` (already good mobile card patterns) as CSS references.

`lotAdmin.ejs` is the first screen already built to this direction — use it as the coding reference.
