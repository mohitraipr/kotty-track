# PM Overcut Fix (Feature B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Net real in-flight cut lots out of `/pm`'s suggested-cut number so it stops re-suggesting what's already in production.

**Architecture:** A new focused module `utils/onOrder.js` exposes two pure functions (`resolveSizeSku`, `buildOnOrderMap`) and one DB wrapper (`computeOnOrderBySku`). `getCuttingRecommendations` replaces its manual-table-only `openLotMap` with a call to `computeOnOrderBySku`, which (behind the `PM_CLOSED_LOOP` flag) unions the manual table with real in-flight lots netted against finishing dispatches. Because every downstream surface already reads `suggested_cut_qty`, the fix propagates with no other logic changes.

**Tech Stack:** Node.js, Express, EJS, mysql2; tests via Node's built-in runner (`node --test`), no mocking library — fake pools are hand-written stubs dispatching by SQL shape (house pattern, see `test/approvalCorrection.test.js`).

## Global Constraints

- New real-lot behavior is gated behind env flag **`PM_CLOSED_LOOP`** — truthy (`'1'` or `'true'`) enables it; default OFF reproduces today's exact numbers (manual `pm_open_cutting_lots` only).
- Staleness window env **`PM_INFLIGHT_WINDOW_DAYS`** (default `120`) bounds which cut lots count as in-flight.
- `computeOnOrderBySku` must use a small fixed number of set-based queries (not per-SKU) and build its map once per `getCuttingRecommendations` call.
- Tests run with `node --test`. Test files live in `test/*.test.js`.
- Deploy ONLY from `main` (merge a PR to ship). Never wipe Cloud Run env vars — `--update-env-vars`/`--update-secrets` only.
- Every commit ends with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch: `feat/pm-overcut-fix` (already created; the design spec is committed there).

---

## File Structure

- **Create** `utils/onOrder.js` — on-order computation: `resolveSizeSku` (size-label→ecom-SKU binding), `buildOnOrderMap` (net + union + unresolved tally), `computeOnOrderBySku` (DB wrapper, flag-aware).
- **Create** `test/onOrder.test.js` — unit tests for all three.
- **Modify** `utils/easyecomAnalytics.js` — require `computeOnOrderBySku`; replace the `openLotMap` block ([:756-761](../../../utils/easyecomAnalytics.js#L756)); attach `results.onOrderUnresolved`.
- **Modify** `routes/productionManagerRoutes.js` — `/api/styles` ([:326-344](../../../routes/productionManagerRoutes.js#L326)) returns `in_flight_unresolved`.
- **Modify** `views/productionManagerDashboard.ejs` — show an "unresolved in-flight" data-quality line when present.
- **Modify** `views/productionManagerStyle.ejs` — show "X pcs already in production across Y lots" near the suggested cut.

---

### Task 1: `resolveSizeSku` — bind a lot's (style, size_label) to an EasyEcom size-SKU

**Files:**
- Create: `utils/onOrder.js`
- Test: `test/onOrder.test.js`

**Interfaces:**
- Produces: `resolveSizeSku(style, sizeLabel, resolutionMap, canonSet) -> string | null`
  - `resolutionMap`: `Map<string, string>` keyed `UPPER(style)+'||'+UPPER(sizeLabel)` → size_sku (from `pm_sku_resolution`).
  - `canonSet`: `Set<string>` of UPPERCASE canonical ecom SKUs (from `ee_suborders`).
  - Returns the resolved size-SKU (as stored — uppercase) or `null`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/onOrder.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveSizeSku } = require('../utils/onOrder.js');

test('resolveSizeSku: prefers pm_sku_resolution map', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+LABEL against canon set', () => {
  const canon = new Set(['KTTTOP374L']);
  assert.strictEqual(resolveSizeSku('KTTTOP374', 'L', new Map(), canon), 'KTTTOP374L');
});

test('resolveSizeSku: falls back to STYLE+_+LABEL for numeric sizes', () => {
  const canon = new Set(['KTTMENSJEANS381_28']);
  assert.strictEqual(resolveSizeSku('KTTMENSJEANS381', '28', new Map(), canon), 'KTTMENSJEANS381_28');
});

test('resolveSizeSku: case-insensitive on inputs', () => {
  const rmap = new Map([['KTTTOP374||L', 'KTTTOP374L']]);
  assert.strictEqual(resolveSizeSku('ktttop374', 'l', rmap, new Set()), 'KTTTOP374L');
});

test('resolveSizeSku: returns null when nothing matches', () => {
  assert.strictEqual(resolveSizeSku('NOPE', 'XL', new Map(), new Set()), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/onOrder.test.js`
Expected: FAIL — `Cannot find module '../utils/onOrder.js'`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// utils/onOrder.js
'use strict';

const U = (s) => String(s == null ? '' : s).toUpperCase().trim();

// Bind a cut lot's (style, size_label) to an EasyEcom size-SKU.
// Primary: the human-authored pm_sku_resolution map. Fallback: concatenation
// (letter sizes attach directly, numeric/long sizes via underscore) validated
// against the canonical ecom SKU set. Returns the size-SKU or null.
function resolveSizeSku(style, sizeLabel, resolutionMap, canonSet) {
  const st = U(style);
  const lbl = U(sizeLabel);
  if (!st || !lbl) return null;
  const fromMap = resolutionMap.get(st + '||' + lbl);
  if (fromMap) return fromMap;
  const direct = st + lbl;
  if (canonSet.has(direct)) return direct;
  const underscored = st + '_' + lbl;
  if (canonSet.has(underscored)) return underscored;
  return null;
}

module.exports = { resolveSizeSku, U };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/onOrder.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/onOrder.js test/onOrder.test.js
git commit -m "feat(pm): resolveSizeSku — bind cut-lot size to ecom size-SKU

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `buildOnOrderMap` — net dispatched, union manual, tally unresolved

**Files:**
- Modify: `utils/onOrder.js`
- Test: `test/onOrder.test.js`

**Interfaces:**
- Consumes: `resolveSizeSku` (Task 1).
- Produces: `buildOnOrderMap({ inFlightRows, dispatchedMap, manualRows, resolutionMap, canonSet }) -> { map, unresolvedLots, unresolvedPieces }`
  - `inFlightRows`: `Array<{ lot_no, style, size_label, cut_pieces }>` (one per cut lot-size).
  - `dispatchedMap`: `Map<string, number>` keyed `UPPER(lot_no)+'||'+UPPER(size_label)` → dispatched qty.
  - `manualRows`: `Array<{ sku, qty }>` from `pm_open_cutting_lots`.
  - `map`: `Map<string, number>` size_sku → on-order qty.
  - `unresolvedLots`: count of DISTINCT `lot_no` with at least one unresolved size.
  - `unresolvedPieces`: total net pieces that could not be bound to a size-SKU.

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/onOrder.test.js
const { buildOnOrderMap } = require('../utils/onOrder.js');

const RMAP = new Map([
  ['KTTTOP374||M', 'KTTTOP374M'],
  ['KTTTOP374||L', 'KTTTOP374L'],
]);
const CANON = new Set(['KTTTOP374M', 'KTTTOP374L']);

test('buildOnOrderMap: nets dispatched pieces off the cut qty', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 80 }],
    dispatchedMap: new Map([['A1||M', 20]]),
    manualRows: [],
    resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374M'), 60);
  assert.strictEqual(res.unresolvedLots, 0);
});

test('buildOnOrderMap: fully dispatched lot-size contributes 0 and is omitted', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 50 }],
    dispatchedMap: new Map([['A1||M', 50]]),
    manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.has('KTTTOP374M'), false);
});

test('buildOnOrderMap: sums multiple lots into the same size-SKU', () => {
  const res = buildOnOrderMap({
    inFlightRows: [
      { lot_no: 'A1', style: 'KTTTOP374', size_label: 'M', cut_pieces: 30 },
      { lot_no: 'A2', style: 'KTTTOP374', size_label: 'M', cut_pieces: 40 },
    ],
    dispatchedMap: new Map(), manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374M'), 70);
});

test('buildOnOrderMap: unresolved size tallied by distinct lot, not dropped silently', () => {
  const res = buildOnOrderMap({
    inFlightRows: [
      { lot_no: 'A1', style: 'WEIRDSTYLE', size_label: 'M', cut_pieces: 25 },
      { lot_no: 'A1', style: 'WEIRDSTYLE', size_label: 'L', cut_pieces: 15 },
    ],
    dispatchedMap: new Map(), manualRows: [], resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.size, 0);
  assert.strictEqual(res.unresolvedLots, 1);   // one distinct lot_no
  assert.strictEqual(res.unresolvedPieces, 40);
});

test('buildOnOrderMap: unions manual rows on top of real lots', () => {
  const res = buildOnOrderMap({
    inFlightRows: [{ lot_no: 'A1', style: 'KTTTOP374', size_label: 'L', cut_pieces: 10 }],
    dispatchedMap: new Map(),
    manualRows: [{ sku: 'KTTTOP374L', qty: 5 }, { sku: 'KTTTOP374M', qty: 7 }],
    resolutionMap: RMAP, canonSet: CANON,
  });
  assert.strictEqual(res.map.get('KTTTOP374L'), 15); // 10 real + 5 manual
  assert.strictEqual(res.map.get('KTTTOP374M'), 7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/onOrder.test.js`
Expected: FAIL — `buildOnOrderMap is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// utils/onOrder.js — add above module.exports
// Build the size_sku -> on-order qty map. In-flight = cut pieces net of pieces
// already dispatched (finishing); unresolved sizes are tallied, never dropped
// silently. The manual pm_open_cutting_lots rows are summed on top (transition).
function buildOnOrderMap({ inFlightRows, dispatchedMap, manualRows, resolutionMap, canonSet }) {
  const map = new Map();
  const unresolvedLotSet = new Set();
  let unresolvedPieces = 0;

  for (const r of (inFlightRows || [])) {
    const dispatched = dispatchedMap.get(U(r.lot_no) + '||' + U(r.size_label)) || 0;
    const net = (Number(r.cut_pieces) || 0) - dispatched;
    if (net <= 0) continue;
    const sku = resolveSizeSku(r.style, r.size_label, resolutionMap, canonSet);
    if (!sku) {
      unresolvedLotSet.add(U(r.lot_no));
      unresolvedPieces += net;
      continue;
    }
    map.set(sku, (map.get(sku) || 0) + net);
  }

  for (const r of (manualRows || [])) {
    const sku = U(r.sku);
    if (!sku) continue;
    map.set(sku, (map.get(sku) || 0) + (Number(r.qty) || 0));
  }

  return { map, unresolvedLots: unresolvedLotSet.size, unresolvedPieces };
}
```

Update `module.exports`:

```javascript
module.exports = { resolveSizeSku, buildOnOrderMap, U };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/onOrder.test.js`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add utils/onOrder.js test/onOrder.test.js
git commit -m "feat(pm): buildOnOrderMap — net dispatched, union manual, tally unresolved

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `computeOnOrderBySku(pool)` — flag-aware DB wrapper

**Files:**
- Modify: `utils/onOrder.js`
- Test: `test/onOrder.test.js`

**Interfaces:**
- Consumes: `buildOnOrderMap` (Task 2).
- Produces: `async computeOnOrderBySku(pool, { windowDays } = {}) -> { onOrder: Map<string,number>, unresolved: { lots: number, pieces: number } }`
  - When `PM_CLOSED_LOOP` is NOT truthy: runs ONLY the manual `pm_open_cutting_lots` query and returns `{ onOrder, unresolved: { lots: 0, pieces: 0 } }` (today's behavior).
  - When truthy: also loads in-flight lots (cut within `windowDays`, default `PM_INFLIGHT_WINDOW_DAYS` or 120), dispatches, resolution map, and canon set; returns the netted+unioned map + unresolved tally.

- [ ] **Step 1: Write the failing test**

```javascript
// append to test/onOrder.test.js
const { computeOnOrderBySku } = require('../utils/onOrder.js');

// Fake pool dispatching by SQL shape (house pattern, cf. test/approvalCorrection.test.js).
function fakePool(data) {
  return {
    queries: [],
    async query(sql) {
      this.queries.push(sql.replace(/\s+/g, ' ').trim());
      if (/FROM pm_open_cutting_lots/.test(sql)) return [data.manual || []];
      if (/FROM cutting_lots/.test(sql)) return [data.inflight || []];
      if (/FROM finishing_dispatches/.test(sql)) return [data.dispatched || []];
      if (/FROM pm_sku_resolution/.test(sql)) return [data.resolution || []];
      if (/FROM ee_suborders/.test(sql)) return [data.canon || []];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('computeOnOrderBySku: flag OFF uses ONLY the manual table', async () => {
  delete process.env.PM_CLOSED_LOOP;
  const pool = fakePool({ manual: [{ sku: 'KTTTOP374L', qty: 12 }] });
  const res = await computeOnOrderBySku(pool);
  assert.strictEqual(res.onOrder.get('KTTTOP374L'), 12);
  assert.deepStrictEqual(res.unresolved, { lots: 0, pieces: 0 });
  // Only the manual query should have run.
  assert.strictEqual(pool.queries.some((q) => /FROM cutting_lots/.test(q)), false);
});

test('computeOnOrderBySku: flag ON nets real lots + unions manual + tallies unresolved', async () => {
  process.env.PM_CLOSED_LOOP = '1';
  const pool = fakePool({
    manual: [{ sku: 'KTTTOP374M', qty: 5 }],
    inflight: [
      { lot_no: 'A1', style: 'KTTTOP374', size_label: 'L', cut_pieces: 80 },
      { lot_no: 'B2', style: 'WEIRDSTYLE', size_label: 'XL', cut_pieces: 30 },
    ],
    dispatched: [{ lot_no: 'A1', size_label: 'L', qty: 20 }],
    resolution: [{ cl_sku: 'KTTTOP374', size_label: 'L', size_sku: 'KTTTOP374L' }],
    canon: [{ sku: 'KTTTOP374L' }],
  });
  const res = await computeOnOrderBySku(pool);
  assert.strictEqual(res.onOrder.get('KTTTOP374L'), 60); // 80 - 20 dispatched
  assert.strictEqual(res.onOrder.get('KTTTOP374M'), 5);  // manual
  assert.deepStrictEqual(res.unresolved, { lots: 1, pieces: 30 }); // WEIRDSTYLE/B2
  delete process.env.PM_CLOSED_LOOP;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/onOrder.test.js`
Expected: FAIL — `computeOnOrderBySku is not a function`.

- [ ] **Step 3: Write minimal implementation**

```javascript
// utils/onOrder.js — add above module.exports
function flagOn() {
  const v = String(process.env.PM_CLOSED_LOOP || '').toLowerCase();
  return v === '1' || v === 'true';
}

async function loadManualRows(pool) {
  const [rows] = await pool.query(
    `SELECT sku, COALESCE(SUM(qty), 0) AS qty FROM pm_open_cutting_lots
     WHERE closed_at IS NULL GROUP BY sku`
  );
  return rows.map((r) => ({ sku: r.sku, qty: Number(r.qty) || 0 }));
}

// Returns { onOrder: Map<size_sku, qty>, unresolved: { lots, pieces } }.
// Flag OFF -> manual table only (today's behavior). Flag ON -> union real
// in-flight lots (cut within windowDays, net of dispatches) with the manual table.
async function computeOnOrderBySku(pool, { windowDays } = {}) {
  const manualRows = await loadManualRows(pool);

  if (!flagOn()) {
    const map = new Map();
    for (const r of manualRows) map.set(U(r.sku), (map.get(U(r.sku)) || 0) + r.qty);
    return { onOrder: map, unresolved: { lots: 0, pieces: 0 } };
  }

  const days = Number(windowDays || process.env.PM_INFLIGHT_WINDOW_DAYS || 120);

  const [inflight] = await pool.query(
    `SELECT cl.lot_no, cl.sku AS style, cls.size_label,
            COALESCE(cls.total_pieces, 0) AS cut_pieces
     FROM cutting_lots cl
     JOIN cutting_lot_sizes cls ON cls.cutting_lot_id = cl.id
     WHERE cl.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
    [days]
  );

  const [dispatched] = await pool.query(
    `SELECT lot_no, size_label, COALESCE(SUM(quantity), 0) AS qty
     FROM finishing_dispatches GROUP BY lot_no, size_label`
  );
  const dispatchedMap = new Map(
    dispatched.map((r) => [U(r.lot_no) + '||' + U(r.size_label), Number(r.qty) || 0])
  );

  const [resolution] = await pool.query(
    `SELECT cl_sku, size_label, size_sku FROM pm_sku_resolution
     WHERE state = 'resolved' AND size_sku IS NOT NULL`
  );
  const resolutionMap = new Map(
    resolution.map((r) => [U(r.cl_sku) + '||' + U(r.size_label), U(r.size_sku)])
  );

  const [canonRows] = await pool.query(
    `SELECT DISTINCT UPPER(sku) AS sku FROM ee_suborders WHERE sku IS NOT NULL AND sku <> ''`
  );
  const canonSet = new Set(canonRows.map((r) => r.sku));

  const built = buildOnOrderMap({
    inFlightRows: inflight, dispatchedMap, manualRows, resolutionMap, canonSet,
  });
  return {
    onOrder: built.map,
    unresolved: { lots: built.unresolvedLots, pieces: built.unresolvedPieces },
  };
}
```

Update `module.exports`:

```javascript
module.exports = { resolveSizeSku, buildOnOrderMap, computeOnOrderBySku, U };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/onOrder.test.js`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add utils/onOrder.js test/onOrder.test.js
git commit -m "feat(pm): computeOnOrderBySku — flag-aware on-order from real lots + manual

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Wire `computeOnOrderBySku` into `getCuttingRecommendations`

**Files:**
- Modify: `utils/easyecomAnalytics.js` (require at top; replace `openLotMap` block at [:756-761](../../../utils/easyecomAnalytics.js#L756); attach `results.onOrderUnresolved` before `return results`).

**Interfaces:**
- Consumes: `computeOnOrderBySku` (Task 3).
- Produces: `getCuttingRecommendations` returns its existing array, now carrying a non-enumerable-safe property `results.onOrderUnresolved = { lots, pieces }`. `openLotQty` per result now reflects the unioned on-order map.

This is an integration wiring task (no new pure logic). It is verified by: (a) the full suite still passing, and (b) the manual DB check in the Verification section.

- [ ] **Step 1: Add the require near the other requires at the top of `utils/easyecomAnalytics.js`**

```javascript
const { computeOnOrderBySku } = require('./onOrder');
```

- [ ] **Step 2: Replace the manual-only open-lot block**

Find (around [utils/easyecomAnalytics.js:756-761](../../../utils/easyecomAnalytics.js#L756)):

```javascript
  const [openLotRows] = await pool.query(
    `SELECT sku, COALESCE(SUM(qty), 0) AS qty FROM pm_open_cutting_lots
     WHERE closed_at IS NULL GROUP BY sku`
  );
  const openLotMap = new Map(openLotRows.map((r) => [r.sku, Number(r.qty) || 0]));
```

Replace with:

```javascript
  const { onOrder: openLotMap, unresolved: onOrderUnresolved } =
    await computeOnOrderBySku(pool);
```

- [ ] **Step 3: Make `openLotQty` lookup case-insensitive**

The map is now keyed by UPPERCASE size-SKU (canonical). Find (around [:835](../../../utils/easyecomAnalytics.js#L835)):

```javascript
    const openLotQty = openLotMap.get(sku) || 0;
```

Replace with:

```javascript
    const openLotQty = openLotMap.get(String(sku).toUpperCase()) || 0;
```

- [ ] **Step 4: Attach the unresolved tally to the result**

Find the end of `getCuttingRecommendations` (around [:887-889](../../../utils/easyecomAnalytics.js#L887)):

```javascript
  results.sort((a, b) => b.suggested_cut_qty - a.suggested_cut_qty);
  return results;
}
```

Replace with:

```javascript
  results.sort((a, b) => b.suggested_cut_qty - a.suggested_cut_qty);
  results.onOrderUnresolved = onOrderUnresolved || { lots: 0, pieces: 0 };
  return results;
}
```

- [ ] **Step 5: Run the full suite to verify no regressions**

Run: `node --test`
Expected: PASS — all existing suites green (the new `test/onOrder.test.js` included). No test references the removed inline query.

- [ ] **Step 6: Commit**

```bash
git add utils/easyecomAnalytics.js
git commit -m "feat(pm): wire computeOnOrderBySku into getCuttingRecommendations (PM_CLOSED_LOOP)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Surface the unresolved-in-flight signal on the dashboard

**Files:**
- Modify: `routes/productionManagerRoutes.js` (`/api/styles`, [:326-344](../../../routes/productionManagerRoutes.js#L326)).
- Modify: `views/productionManagerDashboard.ejs` (render the line in `loadCutting`/summary area).

**Interfaces:**
- Consumes: `recs.onOrderUnresolved` from Task 4.
- Produces: `/api/styles` response gains `in_flight_unresolved: { lots, pieces }`.

- [ ] **Step 1: Confirm the handler shape**

The `/api/styles` handler ([routes/productionManagerRoutes.js:326-344](../../../routes/productionManagerRoutes.js#L326)) holds the `getCuttingRecommendations` result in `rows`, aggregates to `styles`, and returns `{ ok: true, items: styles, dataQuality }`. The `onOrderUnresolved` property rides on `rows` (the array) from Task 4.

- [ ] **Step 2: Add `in_flight_unresolved` to the response**

Change the success response line at [:337](../../../routes/productionManagerRoutes.js#L337):

```javascript
    res.json({ ok: true, items: styles, dataQuality });
```

to:

```javascript
    res.json({ ok: true, items: styles, dataQuality, in_flight_unresolved: rows.onOrderUnresolved || { lots: 0, pieces: 0 } });
```

- [ ] **Step 3: Render the line on the dashboard**

In `views/productionManagerDashboard.ejs`, in the `loadCutting` / summary JS where the `/pm/api/styles` JSON is consumed, after the table renders add (near the `cuttingFoot` line):

```javascript
      const unres = json.in_flight_unresolved;
      if (unres && unres.lots > 0) {
        const foot = $('cuttingFoot');
        if (foot) foot.innerHTML += ` · <span style="color:var(--amber-ink)">${fmtNum(unres.pieces)} pcs in ${unres.lots} in-flight lot${unres.lots === 1 ? '' : 's'} not matched to a SKU — resolve to avoid overcut</span>`;
      }
```

- [ ] **Step 4: Manually verify the render**

Regenerate the faithful preview if available, or load `/pm` against a dev DB with `PM_CLOSED_LOOP=1`. Confirm the amber line appears only when `lots > 0` and is absent otherwise.

- [ ] **Step 5: Commit**

```bash
git add routes/productionManagerRoutes.js views/productionManagerDashboard.ejs
git commit -m "feat(pm): surface unresolved in-flight lots on dashboard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Style-page "already in production" line

**Files:**
- Modify: `views/productionManagerStyle.ejs` (near the per-size suggested cut / assign section).

**Interfaces:**
- Consumes: per-size `open_lot_qty` from `/pm/api/sizes` (already returned) and `LOTS` from `/pm/api/style-lots` (already loaded in `loadLotHistory`).

- [ ] **Step 1: Locate where `SIZES` is set (suggested cut) and where `LOTS` is populated**

Run: `grep -n "SIZES =\|LOTS =\|open_lot_qty\|SUGGESTED_TOTAL" views/productionManagerStyle.ejs`
Expected: `SIZES` assigned from `/pm/api/sizes`; `LOTS` from `/pm/api/style-lots`; `SUGGESTED_TOTAL` computed from `suggested_cut_qty`.

- [ ] **Step 2: Add the in-production summary line**

Where `SUGGESTED_TOTAL` is computed (around [:113](../../../views/productionManagerStyle.ejs#L113)), compute the in-production total from the same `SIZES` data and render it under the suggested-cut header. Add:

```javascript
  const IN_PROD = SIZES.reduce((s, r) => s + (Number(r.open_lot_qty) || 0), 0);
  const planSummary = document.getElementById('planSummary');
  if (planSummary && IN_PROD > 0) {
    planSummary.textContent = fmtNum(IN_PROD) + ' pcs already in production';
  }
```

(`#planSummary` already exists in the "Approve & assign cut" header at [:66](../../../views/productionManagerStyle.ejs#L66).)

- [ ] **Step 3: Manually verify**

Load `/pm/style/<a style with a recent undispatched lot>` with `PM_CLOSED_LOOP=1`. Confirm the header shows "N pcs already in production" and that the suggested cut is correspondingly lower than `horizon×DRR − SOH`.

- [ ] **Step 4: Commit**

```bash
git add views/productionManagerStyle.ejs
git commit -m "feat(pm): style page shows pieces already in production

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (end-to-end, against a dev DB)

Run with `PM_CLOSED_LOOP=1` set in the app environment.

1. **Suppression:** pick a recent **undispatched** `cutting_lots` row for style X, size M (say 80 pcs). `/pm/api/sizes?style=X` shows `open_lot_qty` for M ≥ 80 and `suggested_cut_qty` for M dropped by ~80 vs the flag-off value. The dashboard priority row and the CAD cut-plan `demand` shrink to match.
2. **Partial dispatch:** insert a partial `finishing_dispatches` (20 of the 80) → in-flight for X-M becomes 60; suggested rises by 20.
3. **Full dispatch:** dispatch the remaining 60 → the lot drops out of on-order; suggested returns to its pre-lot value (modulo the dispatch→SOH transit gap, which Feature C will close).
4. **Toggle parity:** unset `PM_CLOSED_LOOP` → numbers exactly match production today (manual table only). `node --test` passes in both states (tests set/unset the flag themselves).
5. **Double-count check:** for a size-SKU present in BOTH `pm_open_cutting_lots` and a real lot, confirm `open_lot_qty` equals the intended union (manual qty + netted real qty), not an accidental separate path.
6. **Unresolved flag:** with a cut lot whose size can't bind to a size-SKU, the dashboard shows the amber "N pcs in M in-flight lots not matched" line and `/api/styles` returns a non-zero `in_flight_unresolved`.
7. **Staleness:** a lot older than `PM_INFLIGHT_WINDOW_DAYS` with no dispatch does NOT suppress (excluded by the cut-date window).

---

## Self-Review

- **Spec coverage:** computeOnOrderBySku union (Tasks 2–3); net cut−dispatched (Task 2); staleness window (Task 3); pm_sku_resolution primary + concat fallback (Task 1); unresolved flagged not dropped (Tasks 2,5); single wiring point + PM_CLOSED_LOOP gate (Task 4); style-page surfacing (Task 6). All spec sections map to tasks.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Type consistency:** `resolveSizeSku(style, sizeLabel, resolutionMap, canonSet)`, `buildOnOrderMap({inFlightRows, dispatchedMap, manualRows, resolutionMap, canonSet}) -> {map, unresolvedLots, unresolvedPieces}`, `computeOnOrderBySku(pool, {windowDays}) -> {onOrder, unresolved:{lots,pieces}}` — names/shapes used consistently across Tasks 1–6. Dispatch/inflight map key is `UPPER(lot_no)+'||'+UPPER(size_label)` everywhere; resolution key `UPPER(style)+'||'+UPPER(label)` everywhere.
