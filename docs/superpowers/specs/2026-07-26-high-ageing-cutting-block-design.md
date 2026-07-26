# High-Ageing Cutting Block — Design

_2026-07-26_

## Problem & goal
If a style already has a pile of old, unsold inventory ("high ageing" = stock sitting
long without selling), cutting more of it wastes fabric and labour on dead stock. Give
production-planning a **High Ageing** tab on the cutting-planning dashboard that:
1. surfaces high-ageing styles (auto-detected + manually added), and
2. **blocks cutting masters from creating a lot for a blocked style** when enforcement
   is on, with a one-switch override and per-style exceptions.

## Definition of "high ageing"
A **style** is high-ageing when its stock will take **more than 90 days to sell** at its
current rate — style **days-of-cover = total_soh ÷ drr_sum > 90** — OR it has stock but
effectively zero sales in the window (`drr_sum ≈ 0 AND total_soh > 0` → dead stock).
Computed at **style level** (summed across sizes), matching how cutting works.

Data source is already produced: `aggregateStyles(getCuttingRecommendations(...))` in
`routes/productionManagerRoutes.js` yields per-style `total_soh` and `drr_sum`. The
cut-recs call is now single-flight cached (PR #580), so recomputing per tab load is cheap.

## Control model (locked)
- **Auto + manual.** Auto-flagged styles are computed live; humans can also manually
  block a style and can allow (exempt) an auto-flagged one.
- **Global enforcement toggle**, ON by default. ON = blocked styles cannot be cut.
  OFF = list still shows but cutting is allowed (advisory only).
- **Per-style exceptions.** Allow a single auto-flagged style through without disabling
  the whole switch.
- **Hard block** (not a warning) when enforced.

**Effective blocklist** = (auto-flagged ∪ manual_block) − allow-exceptions.

## Data model
New table — stores only human decisions (auto is never persisted stale):
```sql
CREATE TABLE pm_cutting_blocklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  style       VARCHAR(100) NOT NULL,
  mode        ENUM('manual_block','allow') NOT NULL,
  reason      VARCHAR(255) NULL,
  created_by  INT NULL,
  created_by_name VARCHAR(100) NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_style (style)
);
```
`UNIQUE(style)` — a style is either manually blocked or allowed, not both; a new decision
upserts `mode`. Global toggle reuses `store_settings` (key `high_ageing_block_enabled`,
default `'true'`) via `utils/storeSettings.js`.

## Server — a small reusable module
`utils/highAgeing.js`:
- `computeHighAgeingStyles(pool)` → `[{ style, soh, drr, days_of_cover, dead }]` for styles
  over threshold (reuses `aggregateStyles`; `THRESHOLD_DOC = 90`).
- `getEffectiveBlocklist(pool)` → `Set<style>` = (auto ∪ manual_block) − allow, plus the
  reason per style. Single source of truth used by BOTH the tab and the cut-time check.
- `isBlockEnforced(pool)` → boolean from `store_settings`.
- `isStyleBlocked(pool, style)` → `{ blocked, reason }` (enforced AND in effective list).

## Endpoints
PM dashboard (`/pm`, guard `allowRoles(['admin','production_manager'])`):
- `GET  /pm/high-ageing` → `{ enforced, styles:[{style,soh,drr,days_of_cover,source,status,reason}] }`
  (merge auto-computed with the blocklist table for source/status).
- `POST /pm/high-ageing/toggle` `{enabled}` → set `store_settings`.
- `POST /pm/high-ageing/add` `{style, reason?}` → upsert `mode='manual_block'`.
- `POST /pm/high-ageing/allow` `{style, reason?}` → upsert `mode='allow'`.
- `POST /pm/high-ageing/reblock` `{style}` → delete the `allow` row (auto re-applies).
- `DELETE /pm/high-ageing/manual/:style` → delete a `manual_block` row.

Cutting side (`/cutting-manager`, guard `isCuttingManager`):
- `GET /cutting-manager/api/blocked?style=…` → `{ blocked, reason }` (calls `isStyleBlocked`).

## Enforcement (two layers)
1. **Server (authoritative)** — in the create-lot handler
   `routes/cuttingManagerRoutes.js` POST `/create-lot` (~line 265), after resolving the
   style/SKU and before the `INSERT INTO cutting_lots`: `const b = await
   isStyleBlocked(pool, sku); if (b.blocked) return fail(400, b.reason);`. Respects the
   existing AJAX/redirect `fail()` pattern so the create-lot form keeps the user's data.
2. **Client (UX)** — the SKU Builder in `views/cuttingManagerDashboard.ejs`: when the
   composed style/SKU changes, call `GET /cutting-manager/api/blocked?style=…`; if blocked,
   show an inline warning and disable the submit button, so the master sees it before
   trying. (Mirrors the existing brand/category dynamic pattern just added.)

## UI — High Ageing tab on `/pm`
New tab/section in `views/productionManagerDashboard.ejs` (matches the existing
`deadTable`/`lotsTable` table sections):
- Header row: **Enforcement** toggle (ON/OFF) + a "manually add style" input with Add.
- Table: Style · SOH · DRR · Days of cover · Source (Auto/Manual) · Status
  (Blocked / Allowed) · Action. Action = **Allow** (auto rows) / **Re-block** (allowed
  rows) / **Remove** (manual rows). Days-of-cover shows "∞ (no sales)" for dead stock.
- Small note explaining the >90-day rule so it's self-documenting.

## Edge cases
- Style with `drr_sum = 0` and `total_soh > 0` → dead stock, flagged (days-of-cover ∞).
- Style with no inventory/sales data → not flagged (nothing to age).
- Manual-block a style that is NOT auto-flagged → still blocked (source=Manual).
- Allow-exception on a style that later drops below threshold → harmless (it wasn't
  blocked anyway; the `allow` row can be cleaned up but needn't be).
- Toggle OFF → `isStyleBlocked` returns `blocked:false` for everything; tab still lists.

## Testing / verification
1. Unit (`test/highAgeing.test.js`): `computeHighAgeingStyles` flags >90-DOC and
   dead-stock, not healthy styles; `getEffectiveBlocklist` = (auto ∪ manual) − allow;
   `isStyleBlocked` honours the toggle. Pure functions fed mock rows.
2. Prod read-only: run `computeHighAgeingStyles(pool)` — sanity-check the flagged styles
   have genuinely high SOH / low DRR.
3. E2E (stubbed sessions): PM adds a manual block → `GET /cutting-manager/api/blocked`
   returns blocked; cutting create-lot for that style → 400 with reason; toggle OFF →
   create-lot succeeds; allow-exception → create-lot succeeds while others stay blocked.
4. `NODE_ENV=test node --test` green; EJS render of the dashboard + inline-script parse.

## Files
- `sql/2026_07_pm_cutting_blocklist.sql` (new table).
- `utils/highAgeing.js` (new module).
- `routes/productionManagerRoutes.js` (tab endpoints).
- `routes/cuttingManagerRoutes.js` (create-lot block + `/api/blocked`).
- `views/productionManagerDashboard.ejs` (High Ageing tab).
- `views/cuttingManagerDashboard.ejs` (SKU-builder block check).
- `test/highAgeing.test.js`.

## Out of scope (YAGNI)
Per-SKU enforcement toggles; configurable threshold (fixed 90, trivial to change);
notifications; populating the empty `ee_inventory_aging` table.
