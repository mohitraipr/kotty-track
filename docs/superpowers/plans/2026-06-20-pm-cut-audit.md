# PM Cut Audit (Feature C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the cut decision (DRR/suggested) and nightly-reconcile each lot/size's finishing dispatches against sales-adjusted EasyEcom snapshot deltas, surfaced on a `/pm/audit` page + a dashboard flag.

**Architecture:** A pure, unit-tested `assessReflection()` decides whether/when dispatched goods showed up in SOH (sales-adjusted). A DB `reconcileDispatchReflection()` feeds it real rows and upserts a ledger, run nightly inside the existing pull worker. A decision-snapshot write hooks into the assign handler. Two new tables; a new audit page + API. Everything gated behind `PM_CUT_AUDIT` (default OFF).

**Tech Stack:** Node.js, Express, EJS, mysql2; tests via `node --test` (no mocking lib — fake pools dispatch by SQL shape, house pattern in `test/approvalCorrection.test.js`).

## Global Constraints

- All new behavior gated behind env **`PM_CUT_AUDIT`** (truthy `'1'`/`'true'` = ON; default OFF = no behavior change anywhere).
- Reflection params (env, defaults): **`PM_REFLECT_GRACE_DAYS=3`**, **`PM_REFLECT_DEADLINE_DAYS=7`**, **`PM_REFLECT_TOLERANCE_PCT=15`**. Reconcile window = `deadlineDays + 14` days.
- Primary warehouse only (snapshots/sales are primary-only in this DB) — SUM across `warehouse_id` (collapses to primary). Sales use `ee_sales_daily` `source='mini_sales_report'`.
- Reuse `resolveSizeSku` from `utils/onOrder.js`; unresolved `size_sku` rows are written `NULL` + `status='pending'`, never dropped.
- Tests in `test/*.test.js`, run with `node --test`. Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch `feat/pm-cut-audit` (stacked on `feat/pm-overcut-fix`; do NOT switch branches).

---

## File Structure

- **Modify** `utils/onOrder.js` — extract+export `loadResolutionMap(pool)` and `loadCanonSet(pool)` (DRY; reused by reconcile + snapshot).
- **Create** `utils/dispatchReflection.js` — pure `assessReflection(input)` + date helpers + DB `reconcileDispatchReflection(pool, opts)`.
- **Create** `test/dispatchReflection.test.js` — unit tests for both.
- **Create** `sql/2026_06_pm_cut_audit.sql` — `pm_cut_decision_snapshot` + `pm_dispatch_reflection`.
- **Modify** `routes/productionManagerRoutes.js` — decision-snapshot write in the assign handler; `GET /api/audit`, `GET /api/audit/summary`, `GET /audit` page route.
- **Create** `views/productionManagerAudit.ejs` — the audit page (pm-suite system).
- **Modify** `utils/easyecomPullWorker.js` — gated `reconcile_reflection` step in `runPullWorker`.
- **Modify** `views/partials/pmSidebar.ejs` — "Cut Audit" nav item.
- **Modify** `views/productionManagerDashboard.ejs` — "not reflecting" count flag.

---

### Task 1: Extract resolution/canon loaders in `utils/onOrder.js` (DRY)

**Files:**
- Modify: `utils/onOrder.js`
- Test: `test/onOrder.test.js` (add 2 cases)

**Interfaces:**
- Produces: `async loadResolutionMap(pool) -> Map<'STYLE||LABEL', 'SIZESKU'>` and `async loadCanonSet(pool) -> Set<'SIZESKU'>`. `computeOnOrderBySku` is refactored to call them (behavior unchanged).

- [ ] **Step 1: Write the failing test** (append to `test/onOrder.test.js`)

```javascript
const { loadResolutionMap, loadCanonSet } = require('../utils/onOrder.js');

test('loadResolutionMap keys UPPER(cl_sku)||UPPER(size_label) -> UPPER(size_sku)', async () => {
  const pool = { async query() { return [[{ cl_sku: 'kttTop374', size_label: 'l', size_sku: 'ktttop374l' }]]; } };
  const m = await loadResolutionMap(pool);
  assert.strictEqual(m.get('KTTTOP374||L'), 'KTTTOP374L');
});

test('loadCanonSet returns an uppercase Set of canon SKUs', async () => {
  const pool = { async query() { return [[{ sku: 'KTTTOP374L' }, { sku: 'KTTTOP374M' }]]; } };
  const s = await loadCanonSet(pool);
  assert.ok(s.has('KTTTOP374L') && s.has('KTTTOP374M'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/onOrder.test.js`
Expected: FAIL — `loadResolutionMap is not a function`.

- [ ] **Step 3: Refactor `utils/onOrder.js`**

Add the two loaders and use them in `computeOnOrderBySku`:

```javascript
async function loadResolutionMap(pool) {
  const [resolution] = await pool.query(
    `SELECT cl_sku, size_label, size_sku FROM pm_sku_resolution
     WHERE state = 'resolved' AND size_sku IS NOT NULL`
  );
  return new Map(resolution.map((r) => [U(r.cl_sku) + '||' + U(r.size_label), U(r.size_sku)]));
}

async function loadCanonSet(pool) {
  const [canonRows] = await pool.query(
    `SELECT DISTINCT UPPER(sku) AS sku FROM ee_suborders WHERE sku IS NOT NULL AND sku <> ''`
  );
  return new Set(canonRows.map((r) => r.sku));
}
```

In `computeOnOrderBySku`, replace the inline `resolution`/`resolutionMap` and `canonRows`/`canonSet` blocks (the two `await pool.query(...)` for `pm_sku_resolution` and `ee_suborders`) with:

```javascript
  const resolutionMap = await loadResolutionMap(pool);
  const canonSet = await loadCanonSet(pool);
```

Update exports:

```javascript
module.exports = { resolveSizeSku, buildOnOrderMap, computeOnOrderBySku, loadResolutionMap, loadCanonSet, U };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/onOrder.test.js`
Expected: PASS (existing 12 + 2 new = 14). The flag-ON `computeOnOrderBySku` test still asserts `pool.queries.length === 5` — the loaders issue the same two queries, so the count is unchanged.

- [ ] **Step 5: Commit**

```bash
git add utils/onOrder.js test/onOrder.test.js
git commit -m "refactor(pm): extract loadResolutionMap/loadCanonSet from onOrder for reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `assessReflection` — pure sales-adjusted reflection detector

**Files:**
- Create: `utils/dispatchReflection.js`
- Test: `test/dispatchReflection.test.js`

**Interfaces:**
- Produces: `assessReflection(input) -> verdict`, plus date helpers `addDays(ymd, n)`, `daysBetween(a, b)`.
  - input: `{ sohBefore:number, dispatches:[{date,qty}], sales:[{date,qty}], snapshots:[{date,qty}], graceDays, deadlineDays, tolerancePct, today }` (dates `'YYYY-MM-DD'`).
  - verdict: `{ status:'reflected'|'partial'|'not_reflected'|'pending', reflected_date, lag_days, reflected_qty, gap_qty, dispatched_qty, first_dispatch_date, last_dispatch_date }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/dispatchReflection.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { assessReflection, addDays, daysBetween } = require('../utils/dispatchReflection.js');

const P = { graceDays: 3, deadlineDays: 7, tolerancePct: 15 };

test('addDays / daysBetween do UTC calendar math', () => {
  assert.strictEqual(addDays('2026-06-20', 3), '2026-06-23');
  assert.strictEqual(daysBetween('2026-06-20', '2026-06-23'), 3);
});

test('reflected: SOH rises by ~dispatched within window', () => {
  const v = assessReflection({
    sohBefore: 10,
    dispatches: [{ date: '2026-06-01', qty: 20 }, { date: '2026-06-02', qty: 30 }, { date: '2026-06-03', qty: 20 }],
    sales: [],
    snapshots: [{ date: '2026-06-03', qty: 10 }, { date: '2026-06-04', qty: 80 }],
    today: '2026-06-10', ...P,
  });
  assert.strictEqual(v.status, 'reflected');
  assert.strictEqual(v.gap_qty, 0);
  assert.strictEqual(v.reflected_date, '2026-06-04');
  assert.strictEqual(v.lag_days, 1); // 06-04 minus last dispatch 06-03
});

test('sales-masked: net SOH dips but recovers to expected → still reflected', () => {
  const v = assessReflection({
    sohBefore: 5,
    dispatches: [{ date: '2026-06-01', qty: 30 }],
    sales: [{ date: '2026-06-01', qty: 35 }],
    // expected on 06-02 = 5 + 30 - 35 = 0; actual 0 → reflected
    snapshots: [{ date: '2026-06-01', qty: 0 }, { date: '2026-06-02', qty: 0 }],
    today: '2026-06-10', ...P,
  });
  assert.strictEqual(v.status, 'reflected');
});

test('not_reflected: SOH flat past deadline', () => {
  const v = assessReflection({
    sohBefore: 10,
    dispatches: [{ date: '2026-06-01', qty: 50 }],
    sales: [],
    snapshots: [{ date: '2026-06-01', qty: 10 }, { date: '2026-06-09', qty: 10 }],
    today: '2026-06-15', ...P, // deadline = 06-08
  });
  assert.strictEqual(v.status, 'not_reflected');
  assert.strictEqual(v.gap_qty, 50);
});

test('pending: dispatch today, within grace/deadline', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-20', qty: 40 }],
    sales: [],
    snapshots: [{ date: '2026-06-20', qty: 0 }],
    today: '2026-06-21', ...P,
  });
  assert.strictEqual(v.status, 'pending');
});

test('partial: about half showed up past deadline', () => {
  const v = assessReflection({
    sohBefore: 0,
    dispatches: [{ date: '2026-06-01', qty: 100 }],
    sales: [],
    snapshots: [{ date: '2026-06-01', qty: 0 }, { date: '2026-06-09', qty: 50 }],
    today: '2026-06-15', ...P, // deadline 06-08; f=0.5 → partial
  });
  assert.strictEqual(v.status, 'partial');
  assert.strictEqual(v.reflected_qty, 50);
  assert.strictEqual(v.gap_qty, 50);
});

test('no dispatches → reflected/no-op verdict', () => {
  const v = assessReflection({ sohBefore: 0, dispatches: [], sales: [], snapshots: [], today: '2026-06-10', ...P });
  assert.strictEqual(v.status, 'reflected');
  assert.strictEqual(v.dispatched_qty, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dispatchReflection.test.js`
Expected: FAIL — `Cannot find module '../utils/dispatchReflection.js'`.

- [ ] **Step 3: Write the implementation**

```javascript
// utils/dispatchReflection.js
'use strict';

// UTC calendar-date helpers ('YYYY-MM-DD' in/out).
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00Z');
  const db = new Date(b + 'T00:00:00Z');
  return Math.round((db - da) / 86400000);
}

const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const cumThrough = (rows, day) => rows.reduce((s, r) => (r.date <= day ? s + (Number(r.qty) || 0) : s), 0);

// Decide whether/when dispatched goods reflected in SOH, adjusting for concurrent
// sales: expected(day) = sohBefore + cumDispatched(<=day) - cumSales(<=day).
function assessReflection(input) {
  const dispatches = (input.dispatches || []).slice().sort(byDate);
  const sales = (input.sales || []).slice().sort(byDate);
  const snaps = (input.snapshots || []).slice().sort(byDate);
  const totalDispatched = dispatches.reduce((s, d) => s + (Number(d.qty) || 0), 0);
  const firstDispatchDate = dispatches.length ? dispatches[0].date : null;
  const lastDispatchDate = dispatches.length ? dispatches[dispatches.length - 1].date : null;
  const sohBefore = Number(input.sohBefore) || 0;
  const tolPct = Number(input.tolerancePct) || 0;
  const tol = Math.max(1, Math.round((tolPct / 100) * totalDispatched));

  const out = {
    status: 'pending', reflected_date: null, lag_days: null,
    reflected_qty: 0, gap_qty: totalDispatched,
    dispatched_qty: totalDispatched,
    first_dispatch_date: firstDispatchDate, last_dispatch_date: lastDispatchDate,
  };
  if (!totalDispatched || !firstDispatchDate) { out.status = 'reflected'; out.gap_qty = 0; return out; }

  // Full reflection: first day all batches are out AND actual >= expected - tol.
  for (const sn of snaps) {
    if (sn.date < firstDispatchDate) continue;
    const cumDisp = cumThrough(dispatches, sn.date);
    if (cumDisp < totalDispatched) continue;
    const expected = sohBefore + cumDisp - cumThrough(sales, sn.date);
    if ((Number(sn.qty) || 0) >= expected - tol) {
      out.status = 'reflected';
      out.reflected_date = sn.date;
      out.lag_days = daysBetween(lastDispatchDate, sn.date);
      out.reflected_qty = totalDispatched;
      out.gap_qty = 0;
      return out;
    }
  }

  // Not fully reflected — estimate the arrived fraction from the last snapshot.
  const lastSnap = snaps.length ? snaps[snaps.length - 1] : null;
  if (lastSnap) {
    const arrived = (Number(lastSnap.qty) || 0) - (sohBefore - cumThrough(sales, lastSnap.date));
    const f = Math.max(0, Math.min(1, totalDispatched ? arrived / totalDispatched : 0));
    out.reflected_qty = Math.round(f * totalDispatched);
    out.gap_qty = totalDispatched - out.reflected_qty;
  }

  const deadline = addDays(lastDispatchDate, Number(input.deadlineDays) || 0);
  const f = totalDispatched ? out.reflected_qty / totalDispatched : 1;
  if (input.today < deadline) { out.status = 'pending'; return out; }
  if (f <= tolPct / 100) out.status = 'not_reflected';
  else if (f >= 1 - tolPct / 100) {
    out.status = 'reflected';
    out.reflected_qty = totalDispatched; out.gap_qty = 0;
    if (lastSnap) { out.reflected_date = lastSnap.date; out.lag_days = daysBetween(lastDispatchDate, lastSnap.date); }
  } else out.status = 'partial';
  return out;
}

module.exports = { assessReflection, addDays, daysBetween };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/dispatchReflection.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/dispatchReflection.js test/dispatchReflection.test.js
git commit -m "feat(pm): assessReflection — sales-adjusted dispatch→stock reflection detector

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migration — the two audit tables

**Files:**
- Create: `sql/2026_06_pm_cut_audit.sql`

- [ ] **Step 1: Write the migration** (verbatim from the spec)

```sql
-- Feature C — PM cut audit (decision snapshot + dispatch→reflection ledger)
CREATE TABLE IF NOT EXISTS pm_cut_decision_snapshot (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  assignment_id   INT NULL,
  style           VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,
  assigned_qty    INT NOT NULL,
  drr             DECIMAL(10,4) NULL,
  suggested_cut_qty INT NULL,
  soh             INT NULL,
  doh             DECIMAL(10,2) NULL,
  decided_by      INT NULL,
  decided_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_style_size (style, size_label),
  INDEX idx_decided_at (decided_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_dispatch_reflection (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  lot_no          VARCHAR(100) NOT NULL,
  size_label      VARCHAR(40)  NOT NULL,
  size_sku        VARCHAR(100) NULL,
  style           VARCHAR(100) NULL,
  dispatched_qty  INT NOT NULL,
  first_dispatch_date DATE NULL,
  last_dispatch_date  DATE NULL,
  batch_count     INT NOT NULL DEFAULT 0,
  soh_before      INT NULL,
  reflected_qty   INT NULL,
  reflected_date  DATE NULL,
  lag_days        INT NULL,
  gap_qty         INT NULL,
  status          ENUM('pending','reflected','partial','not_reflected') NOT NULL DEFAULT 'pending',
  reconciled_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_lot_size (lot_no, size_label),
  INDEX idx_status (status),
  INDEX idx_size_sku (size_sku),
  INDEX idx_last_dispatch (last_dispatch_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

- [ ] **Step 2: Sanity-check the SQL parses** (no MySQL needed)

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('sql/2026_06_pm_cut_audit.sql','utf8');if(!/pm_cut_decision_snapshot/.test(s)||!/pm_dispatch_reflection/.test(s)||(s.match(/CREATE TABLE/g)||[]).length!==2){process.exit(1)}console.log('2 tables, OK')"`
Expected: `2 tables, OK`

- [ ] **Step 3: Commit**

```bash
git add sql/2026_06_pm_cut_audit.sql
git commit -m "feat(pm): migration for cut-audit tables (decision snapshot + reflection ledger)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> Apply to the dev DB before the integration verification: `mysql … < sql/2026_06_pm_cut_audit.sql` (and on prod only with explicit owner authorization).

---

### Task 4: `reconcileDispatchReflection` — DB orchestration of the ledger

**Files:**
- Modify: `utils/dispatchReflection.js`
- Test: `test/dispatchReflection.test.js`

**Interfaces:**
- Consumes: `assessReflection` (Task 2); `loadResolutionMap`, `loadCanonSet`, `resolveSizeSku` (Task 1 / onOrder).
- Produces: `async reconcileDispatchReflection(pool, { graceDays, deadlineDays, tolerancePct, windowDays, today } = {}) -> { processed, reflected, not_reflected, partial, pending, unresolved }`. Upserts `pm_dispatch_reflection` (one row per lot_no+size_label in the window).

- [ ] **Step 1: Write the failing test** (fake pool dispatching by SQL shape)

```javascript
// append to test/dispatchReflection.test.js
const { reconcileDispatchReflection } = require('../utils/dispatchReflection.js');

function ymd(d) { return d; }
function fakePool(data) {
  return {
    upserts: [],
    async query(sql, params) {
      if (/FROM finishing_dispatches/.test(sql) && /GROUP BY/.test(sql)) return [data.dispatchGroups || []];
      if (/FROM pm_sku_resolution/.test(sql)) return [data.resolution || []];
      if (/FROM ee_suborders/.test(sql)) return [data.canon || []];
      if (/MAX\(snapshot_date\)/.test(sql)) return [[{ qty: data.sohBefore != null ? data.sohBefore : null }]];
      if (/FROM ee_inventory_daily_snapshot/.test(sql)) return [data.snapshots || []];
      if (/FROM ee_sales_daily/.test(sql)) return [data.sales || []];
      if (/INSERT INTO pm_dispatch_reflection/.test(sql)) { this.upserts.push(params); return [{ affectedRows: 1 }]; }
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('reconcileDispatchReflection: resolves, assesses, and upserts a reflected lot', async () => {
  const pool = fakePool({
    dispatchGroups: [{ lot_no: 'A1', size_label: 'L', dispatched_qty: 50, first_dispatch_date: '2026-06-01', last_dispatch_date: '2026-06-02', batch_count: 2, style: 'KTTTOP374' }],
    resolution: [{ cl_sku: 'KTTTOP374', size_label: 'L', size_sku: 'KTTTOP374L' }],
    canon: [{ sku: 'KTTTOP374L' }],
    sohBefore: 0,
    snapshots: [{ date: '2026-06-03', qty: 50 }],
    sales: [],
  });
  const r = await reconcileDispatchReflection(pool, { today: '2026-06-10' });
  assert.strictEqual(r.processed, 1);
  assert.strictEqual(r.reflected, 1);
  assert.strictEqual(pool.upserts.length, 1);
});

test('reconcileDispatchReflection: unresolved size_sku → pending/unresolved, still upserted', async () => {
  const pool = fakePool({
    dispatchGroups: [{ lot_no: 'B2', size_label: 'XL', dispatched_qty: 20, first_dispatch_date: '2026-06-01', last_dispatch_date: '2026-06-01', batch_count: 1, style: 'WEIRD' }],
    resolution: [], canon: [],
  });
  const r = await reconcileDispatchReflection(pool, { today: '2026-06-10' });
  assert.strictEqual(r.unresolved, 1);
  assert.strictEqual(pool.upserts.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dispatchReflection.test.js`
Expected: FAIL — `reconcileDispatchReflection is not a function`.

- [ ] **Step 3: Implement** (append to `utils/dispatchReflection.js`, above `module.exports`)

```javascript
const { resolveSizeSku, loadResolutionMap, loadCanonSet } = require('./onOrder');

const toYmd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function reconcileDispatchReflection(pool, opts = {}) {
  const graceDays = Number(opts.graceDays ?? process.env.PM_REFLECT_GRACE_DAYS ?? 3);
  const deadlineDays = Number(opts.deadlineDays ?? process.env.PM_REFLECT_DEADLINE_DAYS ?? 7);
  const tolerancePct = Number(opts.tolerancePct ?? process.env.PM_REFLECT_TOLERANCE_PCT ?? 15);
  const windowDays = Number(opts.windowDays ?? deadlineDays + 14);
  const today = opts.today || new Date().toISOString().slice(0, 10);

  const [groups] = await pool.query(
    `SELECT fd.lot_no, fd.size_label,
            COALESCE(SUM(fd.quantity),0) AS dispatched_qty,
            MIN(DATE(fd.sent_at)) AS first_dispatch_date,
            MAX(DATE(fd.sent_at)) AS last_dispatch_date,
            COUNT(*) AS batch_count,
            MAX(cl.sku) AS style
       FROM finishing_dispatches fd
       LEFT JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
      WHERE fd.sent_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY fd.lot_no, fd.size_label`,
    [windowDays]
  );

  const resolutionMap = await loadResolutionMap(pool);
  const canonSet = await loadCanonSet(pool);
  const summary = { processed: 0, reflected: 0, not_reflected: 0, partial: 0, pending: 0, unresolved: 0 };

  for (const g of groups) {
    summary.processed++;
    const firstDate = toYmd(g.first_dispatch_date);
    const lastDate = toYmd(g.last_dispatch_date);
    const sku = resolveSizeSku(g.style, g.size_label, resolutionMap, canonSet);

    let v, sohBeforeVal = null;
    if (!sku) {
      summary.unresolved++;
      v = { status: 'pending', reflected_date: null, lag_days: null, reflected_qty: 0,
            gap_qty: Number(g.dispatched_qty) || 0 };
    } else {
      const [[sb]] = await pool.query(
        `SELECT COALESCE(SUM(qty),0) AS qty FROM ee_inventory_daily_snapshot
          WHERE sku = ? AND snapshot_date = (
            SELECT MAX(snapshot_date) FROM ee_inventory_daily_snapshot
             WHERE sku = ? AND snapshot_date < ?)`,
        [sku, sku, firstDate]
      );
      sohBeforeVal = Number(sb && sb.qty) || 0;
      const [snapRows] = await pool.query(
        `SELECT snapshot_date AS date, SUM(qty) AS qty FROM ee_inventory_daily_snapshot
          WHERE sku = ? AND snapshot_date >= ? GROUP BY snapshot_date ORDER BY snapshot_date`,
        [sku, firstDate]
      );
      const [saleRows] = await pool.query(
        `SELECT sale_date AS date, SUM(qty) AS qty FROM ee_sales_daily
          WHERE sku = ? AND source = 'mini_sales_report' AND sale_date >= ?
          GROUP BY sale_date ORDER BY sale_date`,
        [sku, firstDate]
      );
      // The group query gives only the per-(lot,size) total, not per-batch dates.
      // Model the whole qty as dispatched at last_dispatch_date: reflection can only
      // be judged once all batches are out, and the deadline/lag anchor on the last
      // batch. soh_before is the snapshot before the FIRST dispatch; sales/snapshots
      // run from the first date so concurrent sales are credited correctly.
      v = assessReflection({
        sohBefore: sohBeforeVal,
        dispatches: [{ date: lastDate, qty: Number(g.dispatched_qty) || 0 }],
        sales: saleRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
        snapshots: snapRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
        graceDays, deadlineDays, tolerancePct, today,
      });
    }

    summary[v.status] = (summary[v.status] || 0) + 1;

    await pool.query(
      `INSERT INTO pm_dispatch_reflection
         (lot_no,size_label,size_sku,style,dispatched_qty,first_dispatch_date,last_dispatch_date,
          batch_count,soh_before,reflected_qty,reflected_date,lag_days,gap_qty,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         size_sku=VALUES(size_sku), style=VALUES(style), dispatched_qty=VALUES(dispatched_qty),
         first_dispatch_date=VALUES(first_dispatch_date), last_dispatch_date=VALUES(last_dispatch_date),
         batch_count=VALUES(batch_count), soh_before=VALUES(soh_before),
         reflected_qty=VALUES(reflected_qty), reflected_date=VALUES(reflected_date),
         lag_days=VALUES(lag_days), gap_qty=VALUES(gap_qty), status=VALUES(status),
         reconciled_at=CURRENT_TIMESTAMP`,
      [g.lot_no, g.size_label, sku, g.style, Number(g.dispatched_qty) || 0, firstDate, lastDate,
       Number(g.batch_count) || 0, sohBeforeVal,
       v.reflected_qty, v.reflected_date, v.lag_days, v.gap_qty, v.status]
    );
  }
  return summary;
}
```

Update `module.exports`:

```javascript
module.exports = { assessReflection, reconcileDispatchReflection, addDays, daysBetween };
```

> Note for the implementer: the per-(lot,size) row carries only the *total* dispatched qty (batches aren't individually dated in the group query), so `reconcile` models one dispatch entry dated at `first_dispatch_date` and anchors the deadline/lag on the real `last_dispatch_date` (overridden after the call). This is intentional and sufficient for the audit; do not try to re-split batches.

- [ ] **Step 4: Run tests**

Run: `node --test test/dispatchReflection.test.js`
Expected: PASS (9 tests). If the `sohBefore` upsert param is undefined, bind `null` (the test's `fakePool` returns `qty: null` → `sohBefore` 0; bind `0`/`null` consistently — match the column which is nullable).

- [ ] **Step 5: Commit**

```bash
git add utils/dispatchReflection.js test/dispatchReflection.test.js
git commit -m "feat(pm): reconcileDispatchReflection — build the dispatch→reflection ledger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Capture the decision snapshot in the assign handler

**Files:**
- Modify: `routes/productionManagerRoutes.js` (`POST /api/cut-plan/assign`, [:528-616](../../../routes/productionManagerRoutes.js#L528))

**Interfaces:**
- Consumes: `getCuttingRecommendations` (via existing `safeCall`), `resolveSizeSku`, `loadResolutionMap`, `loadCanonSet` (onOrder).
- Produces: rows in `pm_cut_decision_snapshot` (one per assigned size) when `PM_CUT_AUDIT` is ON. Never breaks the assign on audit failure.

- [ ] **Step 1: Add the require + helper near the top of the file**

Confirm the onOrder require exists (Feature B added it for `/api/styles`? if not, add): `const { resolveSizeSku, loadResolutionMap, loadCanonSet } = require('../utils/onOrder');`. Then add:

```javascript
function pmCutAuditOn() {
  const v = String(process.env.PM_CUT_AUDIT || '').toLowerCase();
  return v === '1' || v === 'true';
}

// Persist DRR/suggested/soh/doh at the moment a cut is approved & assigned.
// Best-effort: any failure is logged and swallowed so it never blocks an assign.
async function recordCutDecisionSnapshot(pool, { style, assignedSizes, assignmentId, decidedBy }) {
  if (!pmCutAuditOn() || !assignedSizes || !assignedSizes.length) return;
  try {
    const recs = await safeCall('getCuttingRecommendations', pool, { periodKey: '30d' });
    const bySize = new Map();
    for (const r of (recs || [])) {
      if (r.style === style && r.size) bySize.set(String(r.size).toUpperCase(), r);
    }
    const resolutionMap = await loadResolutionMap(pool);
    const canonSet = await loadCanonSet(pool);
    const rows = assignedSizes.map((s) => {
      const rec = bySize.get(String(s.size_label).toUpperCase());
      return [
        assignmentId, style, s.size_label,
        resolveSizeSku(style, s.size_label, resolutionMap, canonSet),
        Number(s.qty) || 0,
        rec ? rec.drr : null, rec ? rec.suggested_cut_qty : null,
        rec ? rec.soh : null, rec ? rec.doh : null, decidedBy,
      ];
    });
    if (rows.length) {
      await pool.query(
        `INSERT INTO pm_cut_decision_snapshot
           (assignment_id,style,size_label,size_sku,assigned_qty,drr,suggested_cut_qty,soh,doh,decided_by)
         VALUES ?`,
        [rows]
      );
    }
  } catch (err) {
    console.error('[pm] cut decision snapshot failed:', err.message);
  }
}
```

- [ ] **Step 2: Hook it into both assign paths**

In the single-master path, after `const id = await insertAssignment(header, sizes, null);` and before the `res.json`, add:

```javascript
      await recordCutDecisionSnapshot(pool, { style, assignedSizes: sizes, assignmentId: id, decidedBy: createdBy });
```

In the per-lot loop, after `const id = await insertAssignment(header, sizes, `Lot ${i + 1}/${n}`);` add:

```javascript
      await recordCutDecisionSnapshot(pool, { style, assignedSizes: sizes, assignmentId: id, decidedBy: createdBy });
```

(`sizes` in both paths is the `buildAssignmentPayload` output: `[{ size_label, qty }]`.)

- [ ] **Step 3: Verify the routes file still loads + suite green**

Run: `node -e "require('./routes/productionManagerRoutes.js'); console.log('routes load OK')"` then `node --test`
Expected: `routes load OK`; full suite passes (no test targets this handler; this guards against a syntax/require error).

- [ ] **Step 4: Commit**

```bash
git add routes/productionManagerRoutes.js
git commit -m "feat(pm): snapshot DRR/suggested at cut-assign time (PM_CUT_AUDIT)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Nightly reconcile step in the pull worker

**Files:**
- Modify: `utils/easyecomPullWorker.js` (`runPullWorker`, [:636](../../../utils/easyecomPullWorker.js#L636))

**Interfaces:**
- Consumes: `reconcileDispatchReflection` (Task 4); `logStep` (existing).
- Produces: a gated `reconcile_reflection` step that logs a summary; no-op when `PM_CUT_AUDIT` is OFF.

- [ ] **Step 1: Add the require at the top of `utils/easyecomPullWorker.js`**

```javascript
const { reconcileDispatchReflection } = require('./dispatchReflection');
```

- [ ] **Step 2: Add the step inside `runPullWorker`**

Locate where the prior steps run inside `runPullWorker` (each is `await someStep(pool, runStartedAt)` or an inline `try { … logStep(…) }`). After the last existing step call and before the function returns, add:

```javascript
  if (String(process.env.PM_CUT_AUDIT || '').toLowerCase() === '1' || String(process.env.PM_CUT_AUDIT || '').toLowerCase() === 'true') {
    const reflStart = Date.now();
    try {
      const s = await reconcileDispatchReflection(pool);
      await logStep(pool, runStartedAt, 'reconcile_reflection',
        s.not_reflected > 0 ? 'partial' : 'ok',
        `processed=${s.processed} reflected=${s.reflected} not_reflected=${s.not_reflected} partial=${s.partial} pending=${s.pending} unresolved=${s.unresolved}`,
        Date.now() - reflStart);
    } catch (err) {
      console.error('[pullWorker] reconcile_reflection failed:', err.message);
      await logStep(pool, runStartedAt, 'reconcile_reflection', 'error', err.message, Date.now() - reflStart);
    }
  }
```

- [ ] **Step 3: Verify the worker loads + suite green**

Run: `node -e "require('./utils/easyecomPullWorker.js'); console.log('worker load OK')"` then `node --test`
Expected: `worker load OK`; full suite passes.

- [ ] **Step 4: Commit**

```bash
git add utils/easyecomPullWorker.js
git commit -m "feat(pm): nightly reconcile_reflection step in pull worker (PM_CUT_AUDIT)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Audit API routes

**Files:**
- Modify: `routes/productionManagerRoutes.js`

**Interfaces:**
- Produces: `GET /pm/api/audit?status=` → `{ ok, items, summary }`; `GET /pm/api/audit/summary` → `{ ok, not_reflected, partial, pending, reflected }`; `GET /pm/audit` → renders `productionManagerAudit`.

- [ ] **Step 1: Add the three routes** (place near the other `/api/*` routes)

```javascript
// GET /pm/api/audit/summary — counts by status (for the dashboard flag).
router.get('/api/audit/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT status, COUNT(*) AS c FROM pm_dispatch_reflection GROUP BY status`
    );
    const out = { ok: true, not_reflected: 0, partial: 0, pending: 0, reflected: 0 };
    for (const r of rows) out[r.status] = Number(r.c) || 0;
    res.json(out);
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true, not_reflected: 0, partial: 0, pending: 0, reflected: 0 });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pm/api/audit — reflection ledger rows with the decision-snapshot context.
router.get('/api/audit', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim().toLowerCase();
    const valid = ['reflected', 'partial', 'pending', 'not_reflected'];
    const where = valid.includes(status) ? 'WHERE r.status = ?' : '';
    const params = valid.includes(status) ? [status] : [];
    const [items] = await pool.query(
      `SELECT r.lot_no, r.size_label, r.size_sku, r.style, r.dispatched_qty,
              r.first_dispatch_date, r.last_dispatch_date, r.batch_count,
              r.reflected_qty, r.reflected_date, r.lag_days, r.gap_qty, r.status,
              d.drr, d.suggested_cut_qty
         FROM pm_dispatch_reflection r
         LEFT JOIN pm_cut_decision_snapshot d
           ON d.style = r.style AND d.size_label = r.size_label
          AND d.id = (SELECT MAX(d2.id) FROM pm_cut_decision_snapshot d2
                       WHERE d2.style = r.style AND d2.size_label = r.size_label)
         ${where}
         ORDER BY r.last_dispatch_date DESC, r.lot_no
         LIMIT 500`,
      params
    );
    const [srows] = await pool.query(`SELECT status, COUNT(*) AS c FROM pm_dispatch_reflection GROUP BY status`);
    const summary = { not_reflected: 0, partial: 0, pending: 0, reflected: 0 };
    for (const r of srows) summary[r.status] = Number(r.c) || 0;
    res.json({ ok: true, items, summary });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return res.json({ ok: true, items: [], summary: { not_reflected: 0, partial: 0, pending: 0, reflected: 0 } });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /pm/audit — the cut-audit page.
router.get('/audit', (req, res) => {
  res.render('productionManagerAudit', { user: req.session.user });
});
```

- [ ] **Step 2: Verify routes load**

Run: `node -e "require('./routes/productionManagerRoutes.js'); console.log('routes load OK')"`
Expected: `routes load OK`.

- [ ] **Step 3: Commit**

```bash
git add routes/productionManagerRoutes.js
git commit -m "feat(pm): /pm/audit page route + /api/audit(+summary) endpoints

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Audit page view + sidebar nav + dashboard flag

**Files:**
- Create: `views/productionManagerAudit.ejs`
- Modify: `views/partials/pmSidebar.ejs` (add "Cut Audit" under the Tools group)
- Modify: `views/productionManagerDashboard.ejs` (not-reflected count)

**Interfaces:**
- Consumes: `GET /pm/api/audit`, `GET /pm/api/audit/summary`.

- [ ] **Step 1: Create `views/productionManagerAudit.ejs`** (pm-suite system; mirrors the dashboard shell)

```html
<%- include('partials/pmHead', { pageTitle: 'Cut Audit' }) %>
<%- include('partials/pmSidebar', { active: 'audit', user: user }) %>
<div class="main">
  <header class="topbar">
    <div class="page-head"><h1>Cut Audit</h1><p class="page-sub">Did dispatched goods reflect in EasyEcom stock?</p></div>
  </header>
  <main class="content">
    <div class="pm-toolbar">
      <select class="select" id="statusFilter">
        <option value="">All statuses</option>
        <option value="not_reflected">Not reflected</option>
        <option value="partial">Partial</option>
        <option value="pending">Pending</option>
        <option value="reflected">Reflected</option>
      </select>
      <span id="auditSummary" class="page-sub"></span>
    </div>
    <div class="tcard">
      <table class="prio" id="auditTable">
        <thead><tr>
          <th>Style / Lot</th><th>Size</th><th>Dispatched</th><th>Dispatch dates</th>
          <th>Reflected</th><th>Lag</th><th>Gap</th><th>DRR / Suggested</th><th>Status</th>
        </tr></thead>
        <tbody><tr><td colspan="9" class="pm-empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </main>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const fmtNum = (v) => v == null ? '—' : Number(v).toLocaleString('en-IN');
  const fmtDate = (d) => d ? String(d).slice(0, 10) : '—';
  const PILL = { reflected: ['green', 'Reflected'], partial: ['amber', 'Partial'], pending: ['', 'Pending'], not_reflected: ['red', 'Not reflected'] };
  async function load() {
    const status = $('statusFilter').value;
    const j = await (await fetch('/pm/api/audit' + (status ? '?status=' + status : ''))).json();
    const tb = $('auditTable').querySelector('tbody');
    if (!j.ok || !j.items.length) { tb.innerHTML = '<tr><td colspan="9" class="pm-empty">Nothing to audit yet.</td></tr>'; }
    else {
      tb.innerHTML = j.items.map((r) => {
        const p = PILL[r.status] || ['', r.status];
        return `<tr>
          <td><b>${r.style || '—'}</b><div class="fab">${r.lot_no}${r.size_sku ? '' : ' · <span style="color:var(--amber-ink)">unresolved SKU</span>'}</div></td>
          <td>${r.size_label}</td>
          <td><span class="num">${fmtNum(r.dispatched_qty)}</span> <small>(${r.batch_count}×)</small></td>
          <td>${fmtDate(r.first_dispatch_date)}${r.last_dispatch_date !== r.first_dispatch_date ? ' → ' + fmtDate(r.last_dispatch_date) : ''}</td>
          <td>${fmtNum(r.reflected_qty)}${r.reflected_date ? ' · ' + fmtDate(r.reflected_date) : ''}</td>
          <td>${r.lag_days == null ? '—' : r.lag_days + 'd'}</td>
          <td>${r.gap_qty ? '<span style="color:var(--red-ink)">' + fmtNum(r.gap_qty) + '</span>' : '0'}</td>
          <td>${r.drr == null ? '—' : Number(r.drr).toFixed(2) + '/d'} · ${fmtNum(r.suggested_cut_qty)}</td>
          <td><span class="pill ${p[0]}">${p[1]}</span></td>
        </tr>`;
      }).join('');
    }
    const s = j.summary || {};
    $('auditSummary').textContent = `${s.not_reflected || 0} not reflected · ${s.partial || 0} partial · ${s.pending || 0} pending · ${s.reflected || 0} reflected`;
  }
  $('statusFilter').addEventListener('change', load);
  load();
</script>
</body></html>
```

- [ ] **Step 2: Add the sidebar nav item** — in `views/partials/pmSidebar.ejs`, inside the `Tools` group (after the `Marketplace POs` link), add:

```html
    <a href="/pm/audit" class="<%= _active === 'audit' ? 'active' : '' %>" <%= _active === 'audit' ? 'aria-current="page"' : '' %>>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      Cut Audit
    </a>
```

- [ ] **Step 3: Add the dashboard flag** — in `views/productionManagerDashboard.ejs`, in the inline script where summary data loads, add a fetch + render (place near where `loadCutting` runs):

```javascript
  fetch('/pm/api/audit/summary').then((r) => r.json()).then((s) => {
    if (s && s.ok && s.not_reflected > 0) {
      const foot = document.getElementById('cuttingFoot');
      if (foot) foot.innerHTML += ` · <a href="/pm/audit?status=not_reflected" style="color:var(--red-ink)">${s.not_reflected} dispatch${s.not_reflected === 1 ? '' : 'es'} not reflecting in stock</a>`;
    }
  }).catch(() => {});
```

- [ ] **Step 4: Verify EJS renders + scripts parse**

Run:
```bash
node -e "const ejs=require('ejs');ejs.renderFile('views/productionManagerAudit.ejs',{user:{username:'u'}},{views:['views']},(e)=>{if(e){console.error(e.message);process.exit(1)}console.log('audit ejs OK')})"
```
Then extract the inline `<script>` blocks of both edited views and `node --check` them (guard against the smart-quote class of bug):
```bash
node -e "const fs=require('fs');for(const f of ['views/productionManagerAudit.ejs','views/productionManagerDashboard.ejs']){const m=(fs.readFileSync(f,'utf8').match(/<script>([\s\S]*?)<\/script>/g)||[]).join('\n').replace(/<%[\s\S]*?%>/g,'0').replace(/<\/?script>/g,'');require('fs').writeFileSync('/tmp/chk.js',m);require('child_process').execSync('node --check /tmp/chk.js');console.log(f,'script OK')}"
```
Expected: `audit ejs OK`, and `... script OK` for both files (no `SyntaxError`).

- [ ] **Step 5: Commit**

```bash
git add views/productionManagerAudit.ejs views/partials/pmSidebar.ejs views/productionManagerDashboard.ejs
git commit -m "feat(pm): cut-audit page, sidebar nav, and dashboard not-reflecting flag

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (end-to-end, dev DB, `PM_CUT_AUDIT=1`)

After applying `sql/2026_06_pm_cut_audit.sql`:

1. **Decision snapshot:** approve & assign a cut → `pm_cut_decision_snapshot` has one row per size with the DRR/suggested/soh/doh `/pm` showed; `size_sku` resolved.
2. **Clean reflection:** seed a lot's dispatches (20+30+20) and snapshot rows where SOH rises ~70 → run `reconcileDispatchReflection` (or the nightly step) → ledger `status='reflected'`, sane `lag_days`, `gap_qty=0`.
3. **Not reflected:** SOH flat past deadline → `status='not_reflected'`, `gap_qty≈dispatched`; `/pm` shows the red "not reflecting" link; `/pm/audit?status=not_reflected` lists it.
4. **Sales masking:** dispatch 30 with same-window sales 35 → still `reflected` (sales-adjusted).
5. **Pending:** a dispatch today → `status='pending'`, no false flag.
6. **Idempotent:** re-run → reflected rows unchanged; summary stable.
7. **Flag OFF:** unset `PM_CUT_AUDIT` → `runPullWorker` skips the step, assign writes no snapshot, `/api/audit` returns empty; `node --test` green in both states.

## Self-Review

- **Spec coverage:** decision snapshot (Task 3 table + Task 5 write); reflection ledger (Task 3 table + Task 4); sales-adjusted detector + params (Task 2); nightly job (Task 6); `/pm/audit` page + dashboard flag (Tasks 7–8); reuse of `resolveSizeSku`/loaders (Task 1); unresolved flagged not dropped (Task 4 + Task 8 "unresolved SKU"); `PM_CUT_AUDIT` gating (Tasks 5,6,7-via-empty,8). All spec sections map to tasks.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Type consistency:** `assessReflection(input)->verdict{status,reflected_date,lag_days,reflected_qty,gap_qty,dispatched_qty,first_dispatch_date,last_dispatch_date}`; `reconcileDispatchReflection(pool,opts)->{processed,reflected,not_reflected,partial,pending,unresolved}`; loaders `loadResolutionMap/loadCanonSet`; resolution key `UPPER(style)||UPPER(label)`; ledger unique `(lot_no,size_label)` — used consistently across Tasks 1–8.
