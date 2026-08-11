# Lot Viewer Dashboard (`/lot-view`) — Design

2026-08-12 · Approved by mohitrai

## Purpose

A mobile-first, read-only dashboard where users with the new `lotviewers` role can
follow a lot through production: which stage it is at, who worked it, how many
pieces of each size sit where, and what has been dispatched. It reuses the lot
journey's event-sourced data logic; it never mutates anything.

## Decisions (locked)

- Entry experience: search box + a list of **recently created** lots.
- Lot detail shows all four sections: stage timeline + masters, per-size
  per-stage breakdown, activity feed, dispatch summary.
- Nothing is hidden — master names, rejects, destinations all visible.
- Access: `allowRoles(['lotviewers', 'admin'])` (admins can verify what viewers see).
- Approach: new screen on the floor shell + extracted shared data layer
  (NOT retrofitting the desktop lot-journey screen, NOT a fresh Stitch design).

## 1. Role & access

- `sql/2026_08_lotviewers_role.sql`:
  `INSERT IGNORE INTO roles (name, description) VALUES ('lotviewers', 'Read-only mobile lot flow viewer');`
  (follows the `returnchallan`/`wishlinkops` seed pattern). Run on prod before
  assigning the role; harmless if run after deploy.
- `routes/authRoutes.js` `getDashboardForRole()` map: add `'lotviewers': '/lot-view'`.
- `routes/launcherRoutes.js` `ROLE_META`: add a card entry (label "Lot Viewer",
  icon `travel_explore`) so multi-role users get a proper launcher card.
- Every `/lot-view` route: `isAuthenticated, allowRoles(['lotviewers', 'admin'])`
  (middlewares/auth.js:283 `allowRoles`).
- Accounts/grants: existing admin UI (`routes/adminRoutes.js` role creation,
  `routes/adminUserRolesRoutes.js` grants). No new admin surface.

## 2. Shared data layer — `utils/lotJourneyData.js` (new)

Extract from `routes/lotJourneyRoutes.js` verbatim (behavior-preserving):
`resolveLot(q)`, `stageTiming(table, lotId)`, `buildActivity(lot)`,
`buildJourney(lot)`, plus the `EVENT_TABLE`/`TAT_DAYS`/`STAGE_LABEL` constants.
The module imports `pool` from `config/db` like the route does today.
`lotJourneyRoutes.js` becomes a thin route file importing these; its `/`,
`/data`, `/export` behavior is unchanged.

New builders in the same module. Unlike the extracted functions (which keep
their current pool-bound signatures verbatim), the NEW builders take an
explicit db handle as their first argument (`buildSizeMatrix(db, lot)`,
`recentLots(db, limit)`) so unit tests can pass a stub connection; the routes
pass `pool`.

### `buildSizeMatrix(db, lot)`
"Where is every size right now."
- Rows: `SELECT size_label, SUM(total_pieces) AS cut FROM cutting_lot_sizes
  WHERE cutting_lot_id = ? GROUP BY size_label` (the canonical aggregate —
  a lot can have multiple rows per label).
- Columns: for each stage in `orderedStages(lot.flow_type)` (minus cutting),
  `approved` and `completed` per size from
  `stageEvents.getStageSizeAggregates(pool, stage, lot.id)`; keys matched via
  `stageEvents.normalizeSizeLabel`.
- Final column: dispatched per size from `finishing_dispatches` grouped by
  `size_label` (same normalization as lotJourneyRoutes' dispatch query).
- Returns `{ stages: [stageKey...], rows: [{ size, cut, byStage: {stage: {approved, completed}}, dispatched }], totals: {...same shape...} }`.

### `recentLots(db, limit = 30)`
- Newest cutting lots: `id, lot_no, manual_lot_number, sku, total_pieces,
  flow_type, created_at` ordered `created_at DESC LIMIT ?` (clamped ≤ 100).
- Current-stage chip, cheaply: 5 batched queries (one per `*_events` table)
  `SELECT cutting_lot_id, COUNT(*) n FROM <t> WHERE cutting_lot_id IN (?)
  GROUP BY cutting_lot_id`; chip = the furthest stage in the full denim chain
  with any events, else `cutting`. (Approximation is acceptable for a list;
  the detail screen computes real status.)

## 3. Routes — `routes/lotViewerRoutes.js` (new), mounted at `/lot-view` in app.js

| Route | Returns |
|---|---|
| `GET /` | renders `views/lotViewer.ejs` (shell only) |
| `GET /recent` | JSON `{ ok, lots: [...] }` from `recentLots()` |
| `GET /data?q=` | JSON `{ ok, matches, journey, sizeMatrix }` — `resolveLot`, then `buildJourney(matches[0])` + `buildSizeMatrix(matches[0])` |

All guarded `isAuthenticated, allowRoles(['lotviewers','admin'])`. Read-only —
no export endpoint, no POST routes. Errors: 500 JSON `{ ok:false, error }`;
empty `q` → `{ ok:true, matches: [], journey:null }` (mirrors lot journey).

## 4. View — `views/lotViewer.ejs` (new, mobile-first)

Built on the floor shell: includes `partials/floorHead` (Tailwind CDN config +
Material Symbols + fixed top bar with logout). Does NOT include
`partials/floorNav` — its three links target operator-only pages that would 403
a lotviewer; since floorNav normally closes the document, this view closes
`</body></html>` itself. No links out to any operator/admin screen.

Single page, two client-side states (same fetch-and-render pattern as
`lotJourney.ejs`, but Tailwind not Bootstrap):

**Home** — sticky search input (`lot no / manual lot no / SKU`, enter or button
to search) above a card list from `/recent`: each card shows lot_no, manual lot
no, SKU, pieces, flow chip (denim/hosiery), created date, current-stage chip;
tapping a card loads that lot's detail. Pull pattern: plain fetch on load.

**Lot detail** — back control returns to Home; sections stacked vertically:
1. Identity card — lot_no, manual lot no, SKU, flow, total pieces, cutter,
   effective cut date, remark.
2. Stage stepper — one node per stage in the lot's chain: status color
   (done / in progress / not started), days + overdue badge (TAT_DAYS), master
   name, approved/completed/rejected pieces (from `journey.timeline`).
3. Size matrix — table inside `overflow-x-auto`: rows sizes + totals row,
   columns Cut → per-stage Appr/Done → Dispatched. First column sticky.
4. Dispatch card — totalFinished / totalDispatched / remaining + destination
   chips (from `journey.dispatch`).
5. Activity feed — compact rows: date-time, stage chip, action, pieces, by,
   note, `(manual: …)` suffix when `manual_date` set (from `journey.activity`).

Deep link: `?q=LOT123` auto-searches on load (shareable URLs), same as
lotJourney.ejs does today.

## 5. Errors & testing

- No match → friendly empty state ("No lot found for …"); fetch failure → toast.
- Unit tests (`npm test`, stub-conn pattern from `test/stageEvents.test.js`):
  - `buildSizeMatrix` merges cut/stage/dispatch rows correctly, normalizes
    labels, hosiery chain excludes denim-only stages.
  - `recentLots` current-stage chip picks the furthest stage with events.
  - Route guard: `/lot-view` routes use `allowRoles(['lotviewers','admin'])`
    (smoke-assert the middleware wiring).
  - Behavior-preservation: existing `test/lotJourney.test.js` suite still green
    after the extraction.
- Manual QA: phone viewport — search, recent list, hosiery + denim lots,
  deep link, login-as-lotviewer lands on `/lot-view`, operator lot-journey
  unchanged.

## Out of scope (YAGNI)

Excel export for viewers, notifications, per-viewer lot bookmarks, filters on
the recent list, pagination beyond the 30-lot list, offline/PWA.
