# PM Style-Page UX (Feature A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-style sales+inventory trend (free 1–90 days + daily/weekly/monthly, two sparklines) and restructure the style page so the lot journey sits above a collapsed Approve & assign panel.

**Architecture:** A pure, unit-tested bucketing core (`utils/styleTrend.js`) turns daily sales/SOH rows into period buckets; a thin `computeStyleTrend(pool, opts)` resolves the style's size-SKUs (via the now-exported `deriveStyle`) and feeds it; a thin route exposes `/pm/api/style-trend`. The view gains a trend section (reusing the existing inline SVG sparkline) and is reordered/collapsed.

**Tech Stack:** Node.js, Express, EJS, mysql2; tests via `node --test` (fake pools dispatch by SQL shape). No charting library — reuse the inline `<svg class="spark">` polyline.

## Global Constraints

- Purely additive; **no env flag**. The endpoint degrades to `{ sales: [], inventory: [] }` on missing tables/errors so the page renders empty.
- `days` clamped to **1–90** (default 30); `granularity` ∈ `daily`|`weekly`|`monthly` (default `daily`).
- Sales is a **flow** (summed per bucket); inventory (SOH) is a **level** (end-of-bucket / last value per bucket, never summed). Sales `source = 'mini_sales_report'`; primary-warehouse-only (SUM across `warehouse_id`).
- Style→size-SKU resolution is **exact** via `deriveStyle(sku) === style` (prefilter `LIKE 'style%'` only to bound the scan).
- **Quote hygiene:** straight ASCII quotes only in JS/HTML; build SVG strings by concatenation. Inline `<script>` blocks must pass `node --check`.
- Tests in `test/*.test.js`, run with `node --test`. Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch `feat/pm-style-ux` (stacked on `feat/pm-cut-audit`; do NOT switch branches).

---

## File Structure

- **Create** `utils/styleTrend.js` — pure `trendBucketKey(ymd, gran)` + `buildTrendBuckets({salesDaily, invDaily, granularity})`; and async `computeStyleTrend(pool, {style, days, granularity})`.
- **Create** `test/styleTrend.test.js` — unit tests for the pure helpers + a fake-pool test for `computeStyleTrend`.
- **Modify** `utils/easyecomAnalytics.js` — export `deriveStyle`, `deriveSize` (currently private).
- **Modify** `routes/productionManagerRoutes.js` — add the thin `GET /api/style-trend` route.
- **Modify** `views/productionManagerStyle.ejs` — trend section + `loadTrend`/sparkline JS (Task 3); reorder + collapse (Task 4).
- **Modify** `public/css/pm-suite.css` — trend + segmented-toggle + `.pm-collapse` styles.

---

### Task 1: Pure trend bucketing — `trendBucketKey` + `buildTrendBuckets`

**Files:**
- Create: `utils/styleTrend.js`
- Test: `test/styleTrend.test.js`

**Interfaces:**
- Produces: `trendBucketKey(ymd, granularity) -> string` (daily→`ymd`; weekly→the Monday `YYYY-MM-DD` of that week; monthly→`YYYY-MM`).
- Produces: `buildTrendBuckets({ salesDaily, invDaily, granularity }) -> { sales: [{bucket, qty}], inventory: [{bucket, qty}] }`. `salesDaily`/`invDaily` are `[{date:'YYYY-MM-DD', qty}]` chronological. Sales summed per bucket; inventory = last value per bucket; both chronological by bucket.

- [ ] **Step 1: Write the failing test**

```javascript
// test/styleTrend.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { trendBucketKey, buildTrendBuckets } = require('../utils/styleTrend.js');

test('trendBucketKey: daily returns the date', () => {
  assert.strictEqual(trendBucketKey('2026-06-17', 'daily'), '2026-06-17');
});
test('trendBucketKey: monthly returns YYYY-MM', () => {
  assert.strictEqual(trendBucketKey('2026-06-17', 'monthly'), '2026-06');
});
test('trendBucketKey: weekly returns the Monday of that week', () => {
  // 2026-06-15 is Monday; 17 (Wed) and 21 (Sun) fall in the same week; 22 is the next Monday.
  assert.strictEqual(trendBucketKey('2026-06-17', 'weekly'), '2026-06-15');
  assert.strictEqual(trendBucketKey('2026-06-21', 'weekly'), '2026-06-15');
  assert.strictEqual(trendBucketKey('2026-06-22', 'weekly'), '2026-06-22');
});

test('buildTrendBuckets: sales summed per bucket, inventory last-per-bucket (monthly)', () => {
  const r = buildTrendBuckets({
    salesDaily: [
      { date: '2026-05-30', qty: 10 }, { date: '2026-06-01', qty: 5 }, { date: '2026-06-15', qty: 7 },
    ],
    invDaily: [
      { date: '2026-05-30', qty: 100 }, { date: '2026-06-01', qty: 90 }, { date: '2026-06-15', qty: 80 },
    ],
    granularity: 'monthly',
  });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-05', qty: 10 }, { bucket: '2026-06', qty: 12 }]);
  // inventory = last value in each month (a stock level, not a sum)
  assert.deepStrictEqual(r.inventory, [{ bucket: '2026-05', qty: 100 }, { bucket: '2026-06', qty: 80 }]);
});

test('buildTrendBuckets: daily passes through, chronological', () => {
  const r = buildTrendBuckets({
    salesDaily: [{ date: '2026-06-02', qty: 3 }, { date: '2026-06-01', qty: 1 }],
    invDaily: [], granularity: 'daily',
  });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-06-01', qty: 1 }, { bucket: '2026-06-02', qty: 3 }]);
  assert.deepStrictEqual(r.inventory, []);
});

test('buildTrendBuckets: empty inputs → empty arrays', () => {
  const r = buildTrendBuckets({ salesDaily: [], invDaily: [], granularity: 'weekly' });
  assert.deepStrictEqual(r, { sales: [], inventory: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/styleTrend.test.js`
Expected: FAIL — `Cannot find module '../utils/styleTrend.js'`.

- [ ] **Step 3: Write the implementation**

```javascript
// utils/styleTrend.js
'use strict';

// Bucket label for a 'YYYY-MM-DD' date. weekly → the Monday (YYYY-MM-DD) of that
// week; monthly → 'YYYY-MM'; daily → the date itself. (Monday-keyed weeks avoid
// ISO week-number edge cases and sort lexically = chronologically.)
function trendBucketKey(ymd, granularity) {
  if (granularity === 'monthly') return String(ymd).slice(0, 7);
  if (granularity === 'weekly') {
    const d = new Date(ymd + 'T00:00:00Z');
    const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }
  return String(ymd);
}

// salesDaily/invDaily: [{date:'YYYY-MM-DD', qty}], chronological. Sales summed per
// bucket; inventory = last (latest-date) value per bucket. Both returned sorted by
// bucket label (lexical == chronological for these key formats).
function buildTrendBuckets({ salesDaily, invDaily, granularity }) {
  const gran = ['daily', 'weekly', 'monthly'].includes(granularity) ? granularity : 'daily';
  const salesMap = new Map();
  for (const r of (salesDaily || [])) {
    const k = trendBucketKey(r.date, gran);
    salesMap.set(k, (salesMap.get(k) || 0) + (Number(r.qty) || 0));
  }
  const invMap = new Map();
  for (const r of (invDaily || [])) {
    // input is chronological → later dates overwrite, so the latest value per bucket wins
    invMap.set(trendBucketKey(r.date, gran), Number(r.qty) || 0);
  }
  const toSorted = (m) => [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, qty]) => ({ bucket, qty }));
  return { sales: toSorted(salesMap), inventory: toSorted(invMap) };
}

module.exports = { trendBucketKey, buildTrendBuckets };
```

- [ ] **Step 4: Run tests**

Run: `node --test test/styleTrend.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add utils/styleTrend.js test/styleTrend.test.js
git commit -m "feat(pm): trend bucketing — trendBucketKey + buildTrendBuckets

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `computeStyleTrend` + exported `deriveStyle` + the route

**Files:**
- Modify: `utils/easyecomAnalytics.js` (export `deriveStyle`, `deriveSize`)
- Modify: `utils/styleTrend.js` (add `computeStyleTrend`)
- Modify: `routes/productionManagerRoutes.js` (add the route)
- Test: `test/styleTrend.test.js` (fake-pool test)

**Interfaces:**
- Consumes: `buildTrendBuckets` (Task 1); `deriveStyle` (easyecomAnalytics).
- Produces: `async computeStyleTrend(pool, { style, days, granularity }) -> { sales, inventory }`. Resolves the style's size-SKUs (`LIKE 'style%'` prefilter, exact via `deriveStyle(sku) === style.toUpperCase()`), fetches daily sales + daily SOH over the window, returns bucketed output. Returns empty on no SKUs / missing tables.

- [ ] **Step 1: Export the helpers from `utils/easyecomAnalytics.js`**

In its `module.exports` object ([easyecomAnalytics.js:979](../../../utils/easyecomAnalytics.js#L979)), add `deriveStyle,` and `deriveSize,` alongside the existing exports. (No other change; the functions already exist at lines 592 and 601.)

- [ ] **Step 2: Write the failing fake-pool test** (append to `test/styleTrend.test.js`)

```javascript
const { computeStyleTrend } = require('../utils/styleTrend.js');

function fakePool(data) {
  return {
    async query(sql) {
      if (/FROM ee_sales_daily[\s\S]*UNION/.test(sql) || /SELECT DISTINCT sku FROM \(/.test(sql)) return [data.skuRows || []];
      if (/FROM ee_sales_daily/.test(sql)) return [data.salesRows || []];
      if (/FROM ee_inventory_daily_snapshot/.test(sql)) return [data.invRows || []];
      throw new Error('unexpected query: ' + sql);
    },
  };
}

test('computeStyleTrend: resolves SKUs exactly via deriveStyle and buckets', async () => {
  const pool = fakePool({
    // KTTTOP374L belongs to style KTTTOP374; KTTTOP37XL belongs to KTTTOP37 (sibling) — must be excluded
    skuRows: [{ sku: 'KTTTOP374L' }, { sku: 'KTTTOP374M' }, { sku: 'KTTTOP37XL' }],
    salesRows: [{ date: '2026-06-01', qty: 4 }, { date: '2026-06-02', qty: 6 }],
    invRows: [{ date: '2026-06-01', qty: 50 }, { date: '2026-06-02', qty: 45 }],
  });
  const r = await computeStyleTrend(pool, { style: 'KTTTOP374', days: 30, granularity: 'daily' });
  assert.deepStrictEqual(r.sales, [{ bucket: '2026-06-01', qty: 4 }, { bucket: '2026-06-02', qty: 6 }]);
  assert.deepStrictEqual(r.inventory, [{ bucket: '2026-06-01', qty: 50 }, { bucket: '2026-06-02', qty: 45 }]);
});

test('computeStyleTrend: no matching SKUs → empty', async () => {
  const pool = fakePool({ skuRows: [{ sku: 'KTTTOP37XL' }] }); // only the sibling style
  const r = await computeStyleTrend(pool, { style: 'KTTTOP374', days: 30, granularity: 'daily' });
  assert.deepStrictEqual(r, { sales: [], inventory: [] });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/styleTrend.test.js`
Expected: FAIL — `computeStyleTrend is not a function`.

- [ ] **Step 4: Implement `computeStyleTrend`** (append to `utils/styleTrend.js`, above `module.exports`)

```javascript
const { deriveStyle } = require('./easyecomAnalytics');

const toYmd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10));

async function computeStyleTrend(pool, { style, days, granularity } = {}) {
  const st = String(style || '').trim().toUpperCase();
  if (!st) return { sales: [], inventory: [] };
  const n = Math.min(90, Math.max(1, Number(days) || 30));
  const gran = ['daily', 'weekly', 'monthly'].includes(granularity) ? granularity : 'daily';
  try {
    const [skuRows] = await pool.query(
      `SELECT DISTINCT sku FROM (
         SELECT sku FROM ee_sales_daily
           WHERE sku LIKE CONCAT(?, '%') AND sale_date >= CURDATE() - INTERVAL ? DAY
         UNION
         SELECT sku FROM ee_inventory_daily_snapshot
           WHERE sku LIKE CONCAT(?, '%') AND snapshot_date >= CURDATE() - INTERVAL ? DAY
       ) u`,
      [st, n, st, n]
    );
    const skus = skuRows.map((r) => r.sku).filter((s) => deriveStyle(s) === st);
    if (!skus.length) return { sales: [], inventory: [] };

    const [salesRows] = await pool.query(
      `SELECT sale_date AS date, SUM(qty) AS qty FROM ee_sales_daily
        WHERE sku IN (?) AND source = 'mini_sales_report' AND sale_date >= CURDATE() - INTERVAL ? DAY
        GROUP BY sale_date ORDER BY sale_date`,
      [skus, n]
    );
    const [invRows] = await pool.query(
      `SELECT snapshot_date AS date, SUM(qty) AS qty FROM ee_inventory_daily_snapshot
        WHERE sku IN (?) AND snapshot_date >= CURDATE() - INTERVAL ? DAY
        GROUP BY snapshot_date ORDER BY snapshot_date`,
      [skus, n]
    );

    return buildTrendBuckets({
      salesDaily: salesRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
      invDaily: invRows.map((r) => ({ date: toYmd(r.date), qty: Number(r.qty) || 0 })),
      granularity: gran,
    });
  } catch (err) {
    if (err.code === 'ER_NO_SUCH_TABLE') return { sales: [], inventory: [] };
    throw err;
  }
}
```

Update `module.exports`:

```javascript
module.exports = { trendBucketKey, buildTrendBuckets, computeStyleTrend };
```

- [ ] **Step 5: Add the route** in `routes/productionManagerRoutes.js` (near the other `/api/*` routes). First add the require with the other top requires if not present: `const { computeStyleTrend } = require('../utils/styleTrend');`

```javascript
// GET /pm/api/style-trend?style=&days=&granularity= — per-style sales + inventory trend.
router.get('/api/style-trend', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const granularity = ['daily', 'weekly', 'monthly'].includes(req.query.granularity) ? req.query.granularity : 'daily';
    const out = await computeStyleTrend(pool, { style: req.query.style, days, granularity });
    res.json({ ok: true, style: String(req.query.style || ''), days, granularity, ...out });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
```

- [ ] **Step 6: Run tests + load check**

Run: `node --test test/styleTrend.test.js` → PASS (8 total). Then `node -e "require('./routes/productionManagerRoutes.js'); require('./utils/easyecomAnalytics.js'); console.log('load OK')"` → `load OK`. Then `node --test` → full suite green.

- [ ] **Step 7: Commit**

```bash
git add utils/easyecomAnalytics.js utils/styleTrend.js routes/productionManagerRoutes.js test/styleTrend.test.js
git commit -m "feat(pm): /api/style-trend endpoint + computeStyleTrend (export deriveStyle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Trend section UI (sparklines + controls)

**Files:**
- Modify: `views/productionManagerStyle.ejs`
- Modify: `public/css/pm-suite.css`

**Interfaces:**
- Consumes: `GET /pm/api/style-trend`. Uses existing `STYLE`, `$()` in the view's inline script.

- [ ] **Step 1: Add the trend section markup** — in `views/productionManagerStyle.ejs`, immediately AFTER the Size breakdown block (after the `<div class="sizegrid" id="sizeGrid">…</div>` at [:48](../../../views/productionManagerStyle.ejs#L48)):

```html
    <!-- Sales & inventory trend -->
    <h2 class="section-h">Sales &amp; inventory
      <span class="trend-ctrls">
        <input type="number" id="trendDays" min="1" max="90" value="30" class="select" style="width:74px;height:34px" />
        <span class="seg" id="trendGran">
          <button type="button" data-g="daily" class="seg-btn active">Daily</button>
          <button type="button" data-g="weekly" class="seg-btn">Weekly</button>
          <button type="button" data-g="monthly" class="seg-btn">Monthly</button>
        </span>
      </span>
    </h2>
    <div class="trendgrid" id="trendBody">
      <div class="trendcard"><div class="tlab">Units sold</div><div class="tval num" id="trendSalesVal">—</div><div id="trendSalesSpark"></div></div>
      <div class="trendcard"><div class="tlab">Inventory (SOH)</div><div class="tval num" id="trendInvVal">—</div><div id="trendInvSpark"></div></div>
    </div>
```

- [ ] **Step 2: Add the trend JS** — inside the view's `<script>`, near the other loaders (before the final `loadLotHistory();` line). Use straight ASCII quotes; build the SVG by concatenation:

```javascript
function trendSpark(series) {
  const vals = (series || []).map((p) => Number(p.qty) || 0);
  if (!vals.length) return '<div class="pm-empty" style="padding:8px 0">No data in range</div>';
  const max = Math.max.apply(null, vals.concat([1]));
  const min = Math.min.apply(null, vals.concat([0]));
  const span = (max - min) || 1;
  const pts = vals.map((v, i) => {
    const x = vals.length === 1 ? 0 : (i / (vals.length - 1)) * 100;
    const y = 30 - ((v - min) / span) * 28 - 1;
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  const last = pts[pts.length - 1].split(',');
  return '<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="' + pts.join(' ') + '"/><circle class="dot" cx="' + last[0] + '" cy="' + last[1] + '" r="2.4"/></svg>';
}
let trendGran = 'daily';
async function loadTrend() {
  const days = Math.min(90, Math.max(1, Number($('trendDays').value) || 30));
  try {
    const j = await (await fetch('/pm/api/style-trend?style=' + encodeURIComponent(STYLE) + '&days=' + days + '&granularity=' + trendGran)).json();
    const sales = (j && j.sales) || [];
    const inv = (j && j.inventory) || [];
    $('trendSalesVal').textContent = sales.reduce((s, p) => s + (Number(p.qty) || 0), 0).toLocaleString('en-IN');
    $('trendInvVal').textContent = inv.length ? Number(inv[inv.length - 1].qty).toLocaleString('en-IN') : '—';
    $('trendSalesSpark').innerHTML = trendSpark(sales);
    $('trendInvSpark').innerHTML = trendSpark(inv);
  } catch (e) {
    $('trendSalesSpark').innerHTML = '<div class="pm-empty" style="padding:8px 0">Couldn\'t load</div>';
    $('trendInvSpark').innerHTML = '';
  }
}
$('trendDays').addEventListener('input', () => { clearTimeout(window.__trendT); window.__trendT = setTimeout(loadTrend, 250); });
$('trendGran').addEventListener('click', (e) => {
  const b = e.target.closest('[data-g]');
  if (!b) return;
  trendGran = b.dataset.g;
  $('trendGran').querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  loadTrend();
});
loadTrend();
```

- [ ] **Step 3: Add CSS** — append to `public/css/pm-suite.css`:

```css
/* Style-page sales/inventory trend */
.trend-ctrls{display:inline-flex;gap:10px;align-items:center;font-weight:500;font-size:13px}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
.seg-btn{border:0;background:var(--card);color:var(--ink-2);font:inherit;font-size:12.5px;padding:7px 12px;cursor:pointer}
.seg-btn.active{background:var(--blue-bg);color:var(--blue-ink);font-weight:600}
.trendgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:8px}
.trendcard{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.trendcard .tlab{font-size:12.5px;color:var(--ink-3);font-weight:600}
.trendcard .tval{font-size:24px;font-weight:700;margin-top:4px}
.trendcard .spark{display:block;width:100%;height:34px;margin-top:10px;overflow:visible}
.trendcard .spark polyline{fill:none;stroke:var(--blue);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.trendcard .spark .dot{stroke:none;fill:var(--blue-ink)}
@media(max-width:720px){.trendgrid{grid-template-columns:1fr}}
```

- [ ] **Step 4: Verify render + script parses**

Run:
```bash
node -e "require('ejs').renderFile('views/productionManagerStyle.ejs',{style:'KTTTOP374',user:{username:'u'}},{views:['views']},(e)=>{if(e){console.error(e.message);process.exit(1)}console.log('style ejs OK')})"
node -e "const fs=require('fs');const m=(fs.readFileSync('views/productionManagerStyle.ejs','utf8').match(/<script>([\s\S]*?)<\/script>/g)||[]).join('\n').replace(/<%[\s\S]*?%>/g,'0').replace(/<\/?script>/g,'');fs.writeFileSync('/tmp/chk.js',m);require('child_process').execSync('node --check /tmp/chk.js');console.log('style script OK')"
```
Expected: `style ejs OK` and `style script OK` (no SyntaxError, no smart quotes).

- [ ] **Step 5: Commit**

```bash
git add views/productionManagerStyle.ejs public/css/pm-suite.css
git commit -m "feat(pm): style-page sales/inventory trend section (sparklines + controls)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Reorder lot journey above assign + collapse the assign panel

**Files:**
- Modify: `views/productionManagerStyle.ejs`
- Modify: `public/css/pm-suite.css`

- [ ] **Step 1: Reorder + wrap assign in `<details>`** — replace the Approve & assign block followed by the Lot journey block ([productionManagerStyle.ejs:65-73](../../../views/productionManagerStyle.ejs#L65)):

```html
    <!-- Approve & assign -->
    <h2 class="section-h" id="assignSection">Approve &amp; assign cut <span class="link" id="planSummary"></span></h2>
    <div class="tcard" style="padding:0">
      <div id="assignBody" style="padding:20px"><div class="pm-empty">Loading suggested cut…</div></div>
    </div>

    <!-- Lot journey -->
    <h2 class="section-h">Lot journey <select class="select" id="lotPicker" style="height:36px;min-width:220px;font-size:13px"></select></h2>
    <div id="lotJourney"><div class="tcard" style="padding:0"><div class="pm-empty" id="lotEmpty">Loading lot history…</div></div></div>
```

with (journey first, then the assign panel collapsed into a `<details>`):

```html
    <!-- Lot journey -->
    <h2 class="section-h">Lot journey <select class="select" id="lotPicker" style="height:36px;min-width:220px;font-size:13px"></select></h2>
    <div id="lotJourney"><div class="tcard" style="padding:0"><div class="pm-empty" id="lotEmpty">Loading lot history…</div></div></div>

    <!-- Approve & assign (collapsed) -->
    <details class="pm-collapse" id="assignSection">
      <summary>Approve &amp; assign cut <span class="link" id="planSummary"></span></summary>
      <div class="tcard" style="padding:0;border:0">
        <div id="assignBody" style="padding:20px"><div class="pm-empty">Loading suggested cut…</div></div>
      </div>
    </details>
```

(`#planSummary`, `#assignBody`, `#assignSection`, `#lotPicker`, `#lotEmpty` ids are preserved, so all existing JS keeps working.)

- [ ] **Step 2: Update the header CTA** — the `#approveTop` button ([:32](../../../views/productionManagerStyle.ejs#L32)) currently does `document.getElementById('assignSection').scrollIntoView(...)`. Since `#assignSection` is now a `<details>`, open it before scrolling. Replace its `onclick` attribute value with:

```javascript
(function(){var d=document.getElementById('assignSection');d.open=true;d.scrollIntoView({behavior:'smooth'});})()
```

So the button tag becomes:

```html
        <button class="btn primary" id="approveTop" onclick="(function(){var d=document.getElementById('assignSection');d.open=true;d.scrollIntoView({behavior:'smooth'});})()">
```

- [ ] **Step 3: Add `.pm-collapse` CSS** — append to `public/css/pm-suite.css`:

```css
/* Collapsible Approve & assign */
.pm-collapse{border:1px solid var(--line);border-radius:12px;margin-top:8px;background:var(--card)}
.pm-collapse>summary{list-style:none;cursor:pointer;padding:16px 18px;font-weight:700;font-size:15px;display:flex;align-items:center;gap:10px}
.pm-collapse>summary::-webkit-details-marker{display:none}
.pm-collapse>summary::after{content:'\25BE';margin-left:auto;color:var(--ink-3);transition:transform .15s}
.pm-collapse[open]>summary::after{transform:rotate(180deg)}
.pm-collapse .link{font-weight:500}
```

- [ ] **Step 4: Verify render, order, and script parses**

Run:
```bash
node -e "require('ejs').renderFile('views/productionManagerStyle.ejs',{style:'KTTTOP374',user:{username:'u'}},{views:['views']},(e)=>{if(e){console.error(e.message);process.exit(1)}console.log('style ejs OK')})"
node -e "const s=require('fs').readFileSync('views/productionManagerStyle.ejs','utf8');const j=s.indexOf('Lot journey');const a=s.indexOf('Approve &amp; assign cut');if(j<a&&a>-1){console.log('order OK: journey before assign')}else{console.error('ORDER WRONG');process.exit(1)}if(/details class=\"pm-collapse\" id=\"assignSection\"/.test(s)){console.log('collapse OK')}else{console.error('NO DETAILS');process.exit(1)}"
node -e "const fs=require('fs');const m=(fs.readFileSync('views/productionManagerStyle.ejs','utf8').match(/<script>([\s\S]*?)<\/script>/g)||[]).join('\n').replace(/<%[\s\S]*?%>/g,'0').replace(/<\/?script>/g,'');fs.writeFileSync('/tmp/chk.js',m);require('child_process').execSync('node --check /tmp/chk.js');console.log('style script OK')"
```
Expected: `style ejs OK`, `order OK: journey before assign`, `collapse OK`, `style script OK`. Then `node --test` → full suite green.

- [ ] **Step 5: Commit**

```bash
git add views/productionManagerStyle.ejs public/css/pm-suite.css
git commit -m "feat(pm): lot journey above a collapsible Approve & assign panel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Verification (manual, dev DB)

1. `GET /pm/api/style-trend?style=<known>&days=30&granularity=daily` → chronological `sales`/`inventory`; `days=2` narrows; `weekly`/`monthly` re-bucket; `days=999` clamps to 90 (response `days:90`).
2. A style with a longer-prefixed sibling (`KTTTOP37` vs `KTTTOP374`) does not cross-count (deriveStyle exactness; covered by the Task 2 test too).
3. Style page renders the "Sales & inventory" section with two sparklines; changing the day input (debounced) and the Daily/Weekly/Monthly toggle updates them; the input is clamped 1–90.
4. Section order: Header → Size breakdown → Sales & inventory → Lot journey → Approve & assign; the assign panel is collapsed by default; the header "Approve & assign" button opens it and scrolls down.
5. No data / missing tables → the trend shows "No data in range" and the rest of the page is unaffected.
6. `node --test` green; both verification scripts pass (no smart-quote/syntax regression).

## Self-Review

- **Spec coverage:** export deriveStyle/deriveSize (Task 2 Step 1); endpoint with clamp/granularity/graceful-empty + exact SKU resolution (Task 2); sales summed / inventory end-of-bucket (Task 1 `buildTrendBuckets`); trend UI with day-count + granularity + two reused sparklines (Task 3); reorder + collapse + CTA (Task 4). All spec sections map to tasks.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Type consistency:** `trendBucketKey(ymd, granularity)->string`; `buildTrendBuckets({salesDaily,invDaily,granularity})->{sales:[{bucket,qty}],inventory:[{bucket,qty}]}`; `computeStyleTrend(pool,{style,days,granularity})->{sales,inventory}` — used consistently across Tasks 1–3. Ids `trendDays/trendGran/trendSalesSpark/trendInvSpark/assignSection/planSummary/assignBody` consistent between view tasks.
