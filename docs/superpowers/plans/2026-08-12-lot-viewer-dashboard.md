# Lot Viewer Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first read-only `/lot-view` dashboard (new `lotviewers` role) showing a lot's stage flow, masters, per-size breakdown, dispatch summary, and activity feed.

**Architecture:** Extract the lot-journey data builders into `utils/lotJourneyData.js` (shared by the existing operator screen and the new viewer routes); add two new builders (`buildSizeMatrix`, `recentLots`); new route file `routes/lotViewerRoutes.js` mounted at `/lot-view` guarded by `allowRoles(['lotviewers','admin'])`; new `views/lotViewer.ejs` on the floor shell (Tailwind CDN, `partials/floorHead`, NO `floorNav`).

**Tech Stack:** Node/Express, EJS, mysql2, Tailwind CDN (floorHead shell), Material Symbols, node:test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-12-lot-viewer-dashboard-design.md` (decisions are locked there).
- Role name is exactly `lotviewers` (as requested by the user).
- Read-only: no POST routes, no export endpoint, no mutations.
- The viewer screen must NOT link to operator/admin pages (no `floorNav`).
- Existing operator lot-journey behavior must not change (extraction is verbatim).
- Tests: `npm test` (node test runner) must stay green; new pure logic gets stub-conn unit tests following `test/stageEvents.test.js:7-20`.
- New data builders take `db` as first arg (`buildSizeMatrix(db, lot)`, `recentLots(db, limit)`); routes pass `pool`. Extracted functions keep their current pool-bound signatures verbatim.

---

### Task 1: Role plumbing (seed SQL, login map, launcher card)

**Files:**
- Create: `sql/2026_08_lotviewers_role.sql`
- Modify: `routes/authRoutes.js:85-86` (inside the `dashboards` map, after `'jitrgp'`)
- Modify: `routes/launcherRoutes.js` `ROLE_META` object (~line 26)

**Interfaces:**
- Produces: role name `lotviewers` → dashboard `/lot-view` (Task 5 mounts it).

- [ ] **Step 1: Write the seed migration**

```sql
-- sql/2026_08_lotviewers_role.sql
-- Read-only mobile lot flow viewer role. Dashboard: /lot-view.
-- Run on prod before assigning the role to anyone (harmless to run any time —
-- the routes 403 unknown roles and login falls back safely).
INSERT IGNORE INTO roles (name, description)
VALUES ('lotviewers', 'Read-only mobile lot flow viewer');
```

- [ ] **Step 2: Add the login redirect**

In `routes/authRoutes.js`, in `getDashboardForRole`'s `dashboards` map after `'jitrgp': '/qc/dashboard',`:

```js
    'jitrgp': '/qc/dashboard',
    'lotviewers': '/lot-view',
```

- [ ] **Step 3: Add the launcher card meta**

In `routes/launcherRoutes.js` `ROLE_META` (Bootstrap icon names, matching neighbors):

```js
  lotviewers:           { label: 'Lot Viewer',             icon: 'eye-fill',       desc: 'Read-only lot flow, sizes & stages' },
```

- [ ] **Step 4: Verify + commit**

Run: `node --check routes/authRoutes.js && node --check routes/launcherRoutes.js`
Expected: no output (both parse).

```bash
git add sql/2026_08_lotviewers_role.sql routes/authRoutes.js routes/launcherRoutes.js
git commit -m "feat(lot-view): seed lotviewers role + login/launcher wiring"
```

---

### Task 2: Extract shared data layer `utils/lotJourneyData.js`

**Files:**
- Create: `utils/lotJourneyData.js`
- Modify: `routes/lotJourneyRoutes.js` (remove moved code, import from the util; `GET /`, `GET /data`, `GET /export` behavior unchanged)

**Interfaces:**
- Produces (consumed by Tasks 3–5):
  `module.exports = { TAT_DAYS, STAGE_LABEL, EVENT_TABLE, resolveLot, stageTiming, buildActivity, buildJourney }`
  — `resolveLot(q) → Promise<rows>` (lot candidate rows, best match first);
  `buildJourney(lot) → Promise<{lot, timeline, current_stage, dispatch, activity}>`.

- [ ] **Step 1: Create the util by moving code verbatim**

Move from `routes/lotJourneyRoutes.js` into `utils/lotJourneyData.js`, unchanged:
constants `TAT_DAYS`, `STAGE_LABEL`, `EVENT_TABLE`; functions `resolveLot`,
`stageTiming`, `buildActivity`, `buildJourney`. Header + imports for the new file:

```js
/**
 * Lot journey data builders — shared by the operator lot-journey screen
 * (routes/lotJourneyRoutes.js) and the read-only lot viewer (routes/lotViewerRoutes.js).
 * Pure data assembly from *_events / cutting_lots / finishing_dispatches /
 * pm_lot_audit_log; no Express here.
 */
const { pool } = require('../config/db');
const stageEvents = require('./stageEvents');
const {
  orderedStages, deriveStageStatus, dispatchSummary, currentStage, mergeActivity,
} = require('./lotJourney');

// ... moved code, byte-identical ...

module.exports = { TAT_DAYS, STAGE_LABEL, EVENT_TABLE, resolveLot, stageTiming, buildActivity, buildJourney };
```

- [ ] **Step 2: Slim the route file**

`routes/lotJourneyRoutes.js` keeps express/ExcelJS/auth imports and the three
handlers; replace the moved definitions with:

```js
const {
  TAT_DAYS, STAGE_LABEL, resolveLot, buildActivity, buildJourney,
} = require('../utils/lotJourneyData');
```

(`stageEvents`, `pool`, `orderedStages` etc. imports can be dropped from the
route if no handler references them anymore — check with grep before deleting.)

- [ ] **Step 3: Verify behavior preserved**

Run: `npm test` → all pass.
Run: `SKIP_DB_CONNECT=1 NODE_ENV=test node -e "require('./routes/lotJourneyRoutes'); require('./utils/lotJourneyData'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add utils/lotJourneyData.js routes/lotJourneyRoutes.js
git commit -m "refactor(lot-journey): extract data builders into utils/lotJourneyData"
```

---

### Task 3: `buildSizeMatrix(db, lot)` (TDD)

**Files:**
- Modify: `utils/lotJourneyData.js` (add function + export)
- Test: `test/lotViewerData.test.js` (new)

**Interfaces:**
- Consumes: `stageEvents.getStageSizeAggregates(db, stage, lotId)`, `orderedStages(flow_type)`, `stageEvents.normalizeSizeLabel`.
- Produces: `buildSizeMatrix(db, lot) → Promise<{ stages, rows, totals }>` where
  `stages` = non-cutting stage keys for the lot's flow;
  `rows` = `[{ size, cut, byStage: {stageKey: {approved, completed}}, dispatched }]` (ordered by cutting_lot_sizes insertion);
  `totals` = same shape summed.

- [ ] **Step 1: Write the failing tests**

```js
// test/lotViewerData.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { buildSizeMatrix } = require('../utils/lotJourneyData.js');

// Stub db: dispatch by SQL shape (pattern from test/stageEvents.test.js).
// getStageSizeAggregates issues one query per stage against ${stage}_event_sizes join.
function stubDb({ cutSizes, sizeAggRows, dispatchRows }) {
  return {
    async query(sql, params) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/FROM cutting_lot_sizes/.test(flat)) return [cutSizes];
      if (/_event_sizes/.test(flat)) {
        const table = flat.match(/JOIN (\w+_events) e/)[1];
        return [(sizeAggRows[table] || [])];
      }
      if (/FROM finishing_dispatches/.test(flat)) return [dispatchRows || []];
      throw new Error('unexpected query: ' + flat);
    },
  };
}

test('buildSizeMatrix: denim lot merges cut, per-stage and dispatch by normalized size', async () => {
  const db = stubDb({
    cutSizes: [{ size_label: '30', cut: 100 }, { size_label: '32', cut: 50 }],
    sizeAggRows: {
      stitching_events: [
        { size_label: '30', event_type: 'approve', bucket: 'u', pieces: 100 },
        { size_label: '30', event_type: 'complete', bucket: 'i', pieces: 80 },
      ],
      jeans_assembly_events: [], washing_events: [], washing_in_events: [],
      finishing_events: [{ size_label: '30', event_type: 'approve', bucket: 'u', pieces: 10 }],
    },
    dispatchRows: [{ size_label: '30', dispatched: 5 }],
  });
  const m = await buildSizeMatrix(db, { id: 1, flow_type: 'denim' });
  assert.deepStrictEqual(m.stages, ['stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing']);
  const r30 = m.rows.find(r => r.size === '30');
  assert.strictEqual(r30.cut, 100);
  assert.strictEqual(r30.byStage.stitching.approved, 100);
  assert.strictEqual(r30.byStage.stitching.completed, 80);
  assert.strictEqual(r30.byStage.finishing.approved, 10);
  assert.strictEqual(r30.dispatched, 5);
  const r32 = m.rows.find(r => r.size === '32');
  assert.strictEqual(r32.cut, 50);
  assert.strictEqual(r32.byStage.stitching.approved, 0);
  assert.strictEqual(r32.dispatched, 0);
  assert.strictEqual(m.totals.cut, 150);
  assert.strictEqual(m.totals.byStage.stitching.approved, 100);
  assert.strictEqual(m.totals.dispatched, 5);
});

test('buildSizeMatrix: hosiery chain has only stitching + finishing columns', async () => {
  const db = stubDb({
    cutSizes: [{ size_label: 'M', cut: 10 }],
    sizeAggRows: { stitching_events: [], finishing_events: [] },
    dispatchRows: [],
  });
  const m = await buildSizeMatrix(db, { id: 2, flow_type: 'hosiery' });
  assert.deepStrictEqual(m.stages, ['stitching', 'finishing']);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/lotViewerData.test.js`
Expected: FAIL — `buildSizeMatrix is not a function`.

- [ ] **Step 3: Implement in `utils/lotJourneyData.js`**

```js
// "Where is every size right now" — rows per size from cutting_lot_sizes,
// approved/completed per stage from the event size aggregates, dispatched from
// finishing_dispatches. Labels matched via normalizeSizeLabel throughout.
async function buildSizeMatrix(db, lot) {
  const stages = orderedStages(lot.flow_type).filter((s) => s !== 'cutting');

  const [cutRows] = await db.query(
    `SELECT size_label, SUM(total_pieces) AS cut
       FROM cutting_lot_sizes WHERE cutting_lot_id = ?
      GROUP BY size_label ORDER BY MIN(id)`,
    [lot.id]
  );

  const aggByStage = {};
  for (const stage of stages) {
    aggByStage[stage] = await stageEvents.getStageSizeAggregates(db, stage, lot.id);
  }

  const [dispRows] = await db.query(
    `SELECT size_label, COALESCE(SUM(quantity),0) AS dispatched
       FROM finishing_dispatches WHERE lot_no = ? GROUP BY size_label`,
    [lot.lot_no]
  );
  const dispMap = {};
  for (const d of dispRows) {
    dispMap[stageEvents.normalizeSizeLabel(d.size_label)] = Number(d.dispatched) || 0;
  }

  const totals = { cut: 0, byStage: {}, dispatched: 0 };
  for (const s of stages) totals.byStage[s] = { approved: 0, completed: 0 };

  const rows = cutRows.map((r) => {
    const key = stageEvents.normalizeSizeLabel(r.size_label);
    const byStage = {};
    for (const s of stages) {
      const a = aggByStage[s][key] || {};
      byStage[s] = { approved: Number(a.approved) || 0, completed: Number(a.completed) || 0 };
      totals.byStage[s].approved += byStage[s].approved;
      totals.byStage[s].completed += byStage[s].completed;
    }
    const row = {
      size: String(r.size_label),
      cut: Number(r.cut) || 0,
      byStage,
      dispatched: dispMap[key] || 0,
    };
    totals.cut += row.cut;
    totals.dispatched += row.dispatched;
    return row;
  });

  return { stages, rows, totals };
}
```

Add `buildSizeMatrix` to `module.exports`.

- [ ] **Step 4: Run to verify pass** — `node --test test/lotViewerData.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/lotJourneyData.js test/lotViewerData.test.js
git commit -m "feat(lot-view): per-size per-stage matrix builder"
```

---

### Task 4: `recentLots(db, limit)` (TDD)

**Files:**
- Modify: `utils/lotJourneyData.js` (add function + export)
- Test: `test/lotViewerData.test.js` (append)

**Interfaces:**
- Produces: `recentLots(db, limit=30) → Promise<[{ id, lot_no, manual_lot_number, sku, total_pieces, flow_type, created_at, current_stage }]>` — newest cutting lots; `current_stage` = furthest stage (full denim chain order) with any events, else `'cutting'`.

- [ ] **Step 1: Write the failing tests** (append to `test/lotViewerData.test.js`)

```js
const { recentLots } = require('../utils/lotJourneyData.js');

function recentStub({ lots, presence }) {
  return {
    async query(sql, params) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (/FROM cutting_lots/.test(flat)) return [lots];
      const m = flat.match(/FROM (\w+_events)/);
      if (m) {
        return [(presence[m[1]] || []).map((id) => ({ cutting_lot_id: id }))];
      }
      throw new Error('unexpected query: ' + flat);
    },
  };
}

test('recentLots: current_stage is the furthest stage with events, else cutting', async () => {
  const db = recentStub({
    lots: [
      { id: 1, lot_no: 'A1', manual_lot_number: 'M1', sku: 'S1', total_pieces: 10, flow_type: 'denim', created_at: '2026-08-10' },
      { id: 2, lot_no: 'A2', manual_lot_number: null, sku: 'S2', total_pieces: 20, flow_type: 'hosiery', created_at: '2026-08-09' },
    ],
    presence: {
      stitching_events: [1, 2],
      washing_events: [1],
      // finishing has none — furthest for lot 1 is washing, for lot 2 stitching
    },
  });
  const lots = await recentLots(db, 10);
  assert.strictEqual(lots.find(l => l.id === 1).current_stage, 'washing');
  assert.strictEqual(lots.find(l => l.id === 2).current_stage, 'stitching');
});

test('recentLots: empty table short-circuits without probing event tables', async () => {
  const db = recentStub({ lots: [], presence: {} });
  assert.deepStrictEqual(await recentLots(db, 10), []);
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/lotViewerData.test.js` → FAIL (`recentLots is not a function`).

- [ ] **Step 3: Implement**

```js
// Newest cutting lots for the viewer home list, with a cheap current-stage
// chip: furthest stage (full denim chain) that has ANY events for the lot.
// Approximation is fine for a list — the detail screen computes real status.
async function recentLots(db, limit = 30) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const [lots] = await db.query(
    `SELECT id, lot_no, manual_lot_number, sku, total_pieces, flow_type, created_at
       FROM cutting_lots ORDER BY created_at DESC LIMIT ${lim}`
  );
  if (!lots.length) return [];

  const ids = lots.map((l) => l.id);
  const stageOf = {};
  for (const stage of stageEvents.STAGES) { // chain order: stitching → … → finishing
    const [rows] = await db.query(
      `SELECT DISTINCT cutting_lot_id FROM ${EVENT_TABLE[stage]} WHERE cutting_lot_id IN (?)`,
      [ids]
    );
    for (const r of rows) stageOf[r.cutting_lot_id] = stage; // later stages overwrite
  }
  return lots.map((l) => ({ ...l, current_stage: stageOf[l.id] || 'cutting' }));
}
```

Add `recentLots` to `module.exports`.

- [ ] **Step 4: Run to verify pass** — `node --test test/lotViewerData.test.js` → PASS. Then full `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add utils/lotJourneyData.js test/lotViewerData.test.js
git commit -m "feat(lot-view): recent lots list builder with current-stage chip"
```

---

### Task 5: Routes `routes/lotViewerRoutes.js` + mount

**Files:**
- Create: `routes/lotViewerRoutes.js`
- Modify: `app.js:264-265` (mount next to lot-journey)
- Test: `test/lotViewerRoutes.test.js` (new, guard smoke test)

**Interfaces:**
- Consumes: `resolveLot`, `buildJourney`, `buildSizeMatrix`, `recentLots` from `utils/lotJourneyData`; `allowRoles` from `middlewares/auth`.
- Produces: `GET /lot-view` (HTML), `GET /lot-view/recent` (JSON), `GET /lot-view/data?q=` (JSON) — consumed by Task 6's view.

- [ ] **Step 1: Write the route file**

```js
/**
 * Lot Viewer — read-only, mobile-first lot flow dashboard for the
 * `lotviewers` role (admins allowed for support). No mutations, no export.
 * Spec: docs/superpowers/specs/2026-08-12-lot-viewer-dashboard-design.md
 */
const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, allowRoles } = require('../middlewares/auth');
const {
  resolveLot, buildJourney, buildSizeMatrix, recentLots,
} = require('../utils/lotJourneyData');

const guard = [isAuthenticated, allowRoles(['lotviewers', 'admin'])];

router.get('/', ...guard, (req, res) => {
  res.render('lotViewer', { user: req.session.user });
});

router.get('/recent', ...guard, async (req, res) => {
  try {
    const lots = await recentLots(pool, req.query.limit);
    res.json({ ok: true, lots });
  } catch (err) {
    console.error('GET /lot-view/recent error:', err);
    res.status(500).json({ ok: false, error: 'Failed to load recent lots' });
  }
});

router.get('/data', ...guard, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, matches: [], journey: null, sizeMatrix: null });
    const matches = await resolveLot(q);
    if (!matches.length) return res.json({ ok: true, matches: [], journey: null, sizeMatrix: null });
    const [journey, sizeMatrix] = await Promise.all([
      buildJourney(matches[0]),
      buildSizeMatrix(pool, matches[0]),
    ]);
    res.json({
      ok: true, journey, sizeMatrix,
      matches: matches.map((m) => ({
        id: m.id, lot_no: m.lot_no, manual_lot_number: m.manual_lot_number || '', sku: m.sku,
      })),
    });
  } catch (err) {
    console.error('GET /lot-view/data error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: Mount in app.js**

After `app.use('/operator/lot-journey', require('./routes/lotJourneyRoutes'));` (line 264):

```js
app.use('/lot-view', require('./routes/lotViewerRoutes'));
```

- [ ] **Step 3: Guard smoke test**

```js
// test/lotViewerRoutes.test.js
const { test } = require('node:test');
const assert = require('node:assert');

// The route module must exist, and every layer must carry the auth guards —
// a read-only viewer surface with a missing guard is an access-control bug.
test('lot-view router: every route is guarded (isAuthenticated + role check)', () => {
  process.env.SKIP_DB_CONNECT = '1';
  const router = require('../routes/lotViewerRoutes');
  const routes = router.stack.filter((l) => l.route);
  assert.ok(routes.length >= 3, 'expected the three lot-view routes');
  for (const layer of routes) {
    // stack per route: [isAuthenticated, allowRoles(...), handler]
    assert.ok(layer.route.stack.length >= 3, `${layer.route.path} missing guards`);
    assert.strictEqual(layer.route.stack[0].handle.name, 'isAuthenticated');
  }
  // read-only: GET only
  for (const layer of routes) {
    assert.deepStrictEqual(Object.keys(layer.route.methods), ['get'], `${layer.route.path} must be GET-only`);
  }
});
```

- [ ] **Step 4: Run** — `node --test test/lotViewerRoutes.test.js` → PASS; `node --check app.js`.

- [ ] **Step 5: Commit**

```bash
git add routes/lotViewerRoutes.js app.js test/lotViewerRoutes.test.js
git commit -m "feat(lot-view): read-only viewer routes at /lot-view"
```

---

### Task 6: View `views/lotViewer.ejs`

**Files:**
- Create: `views/lotViewer.ejs`

**Interfaces:**
- Consumes: `GET /lot-view/recent` → `{ok, lots}`; `GET /lot-view/data?q=` → `{ok, matches, journey:{lot,timeline,current_stage,dispatch,activity}, sizeMatrix:{stages,rows,totals}}` (shapes from Tasks 3–5). `partials/floorHead` params per `views/partials/floorHead.ejs:1-12`.
- Produces: the complete viewer UI; closes `</body></html>` itself (no floorNav).

- [ ] **Step 1: Build the view** — mobile-first, two client-side states. Full structure (implementer may refine Tailwind classes but keep structure, ids, and endpoints exactly):

```ejs
<%- include('partials/floorHead', {
  pageTitle: 'Lot View', topTitle: 'LOT VIEW', topIcon: 'travel_explore',
  topEyebrow: 'KOTTY', topSub: 'Read-only lot flow', user: user
}) %>

<main class="pt-24 pb-12 px-4 max-w-2xl mx-auto">
  <!-- HOME -->
  <section id="homeView">
    <form id="searchForm" class="sticky top-20 z-10 bg-background-light dark:bg-background-dark pb-3">
      <div class="flex gap-2">
        <input id="q" type="search" inputmode="search" autocomplete="off"
               placeholder="Lot no / manual lot no / SKU"
               class="flex-1 rounded-xl border-none bg-surface px-4 py-3 text-base shadow-sm" />
        <button class="rounded-xl bg-primary px-4 text-white font-semibold" type="submit">
          <span class="material-symbols-outlined align-middle">search</span>
        </button>
      </div>
    </form>
    <h2 class="font-headline text-sm uppercase tracking-wider text-on-surface-variant mt-2 mb-2">Recent lots</h2>
    <div id="recentList" class="space-y-2"><!-- cards injected --></div>
  </section>

  <!-- DETAIL -->
  <section id="detailView" class="hidden">
    <button id="backBtn" class="mb-3 flex items-center gap-1 text-primary font-semibold">
      <span class="material-symbols-outlined">arrow_back</span> All lots
    </button>
    <div id="identityCard"></div>
    <div id="stageStepper" class="mt-4"></div>
    <h3 class="font-headline text-sm uppercase tracking-wider text-on-surface-variant mt-6 mb-2">Sizes</h3>
    <div class="overflow-x-auto rounded-xl bg-surface shadow-sm"><table id="sizeMatrix" class="min-w-full text-sm"></table></div>
    <h3 class="font-headline text-sm uppercase tracking-wider text-on-surface-variant mt-6 mb-2">Dispatch</h3>
    <div id="dispatchCard"></div>
    <h3 class="font-headline text-sm uppercase tracking-wider text-on-surface-variant mt-6 mb-2">Activity</h3>
    <div id="activityFeed" class="space-y-1.5"></div>
  </section>

  <div id="emptyState" class="hidden text-center py-10 text-on-surface-variant"></div>
</main>

<script>
/* Client logic (vanilla, ~150 lines):
   - esc(), fmtDate()/fmtWhen() IST formatters (copy from views/lotJourney.ejs:120-122)
   - STAGE_LABEL map {cutting:'Cutting', stitching:'Stitching', jeans_assembly:'Assembly',
     washing:'Washing', washing_in:'Wash-In', finishing:'Finishing', dispatch:'Dispatch', admin:'Admin'}
   - loadRecent(): fetch('/lot-view/recent') → cards: lot_no + manual no, SKU, pieces,
     flow chip, STAGE_LABEL[current_stage] chip, created date; card onclick → openLot(lot_no)
   - openLot(q): fetch('/lot-view/data?q='+encodeURIComponent(q)); on !journey → empty state;
     else render:
       identityCard: lot_no, manual, sku, flow chip, total pieces, cutter, remark
       stageStepper: journey.timeline → node per stage: colored dot
         (done=green/secondary, in_progress=blue/primary+pulse, not_started=gray),
         label, master, days + "overdue" red badge when t.overdue,
         approved/completed/rejected from t.pieces
       sizeMatrix: header [Size, Cut, ...stages.map(short label: Stitch/Asm/Wash/W-In/Fin) as "Appr·Done", Disp];
         one row per sizeMatrix.rows (first col sticky: class="sticky left-0 bg-surface"),
         totals row bold from sizeMatrix.totals
       dispatchCard: totalFinished / totalDispatched / remaining (red if >0) + destination chips
       activityFeed: rows: fmtWhen(a.when) (+ ' (manual: '+fmtDate(a.manual_date)+')' when set),
         stage chip, a.label, pieces, by, note
     history.replaceState → '?q='+q (deep link); show detailView, hide homeView
   - backBtn → show homeView (restore URL to /lot-view)
   - searchForm submit → openLot(q input value)
   - on load: new URLSearchParams(location.search).get('q') ? openLot(that) : loadRecent()
*/
</script>
</body>
</html>
```

- [ ] **Step 2: Verify render + fetches manually**

Run the app locally (`npm start` with dev DB), log in as an admin, open `/lot-view`
in a phone-sized viewport: recent list loads; search a known lot; verify all five
detail sections, hosiery lot shows 2 stage columns, deep link `?q=` works,
no operator links anywhere. (No automated EJS render test — repo has none.)

- [ ] **Step 3: Commit**

```bash
git add views/lotViewer.ejs
git commit -m "feat(lot-view): mobile-first viewer screen on the floor shell"
```

---

### Task 7: Full verification + PR

- [ ] **Step 1:** `npm test` → all green (base 220 + new).
- [ ] **Step 2:** `SKIP_DB_CONNECT=1 NODE_ENV=test node -e "require('./app'); console.log('APP OK')"` — app wires up.
- [ ] **Step 3:** Push branch, open PR to `main` titled `feat(lot-view): mobile-first lot flow dashboard for lotviewers role`, body noting: run `sql/2026_08_lotviewers_role.sql` on prod (safe any time), then create/assign `lotviewers` users via the admin UI.

## Self-review notes

- Spec coverage: role/access → T1+T5; extraction → T2; size matrix → T3; recent list → T4; routes → T5; view (all 5 sections, deep link, no floorNav) → T6; tests/errors → T3–T5 + T7. Launcher card → T1. ✓
- Types consistent: `buildSizeMatrix(db, lot)` / `recentLots(db, limit)` everywhere; route passes `pool`. ✓
- The view's client logic is specified as structured pseudocode with exact ids/endpoints/field names; all field names match Task 3–5 outputs. ✓
