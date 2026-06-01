# Cutting Weight Auto-Calc + Fabric Consumption Analysis — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Re-introduce the `weight_used = table_length × layers` auto-calc gated to denim lots only, with hosiery using a manual `Used = Full − Remaining` flow; (2) add a fabric-manager analysis page (consumption-by-type, roll ledger, ad-hoc/unknown rolls & types) with a date filter and Excel exports.

**Architecture:** Both features push their error-prone logic into small, pure, dependency-free modules tested with Node's built-in test runner (`node --test`, Node v22). Feature 1's weight math lives in a browser-loadable UMD module (`public/js/cuttingWeight.js`) shared by the EJS form. Feature 2's row aggregation lives in a server-side CommonJS module (`utils/fabricConsumption.js`) consumed by a new route. The EJS/visual work is built with the `/frontend-design` skill. Feature 1 needs **no change to existing POST handlers** — both modes submit a hidden `remaining_weight` and the server already computes `used = full − remaining`.

**Tech Stack:** Node v22 (built-in `node:test`), Express, EJS, MySQL (`mysql2/pool`), `exceljs` (already a dependency).

**Spec:** `docs/superpowers/specs/2026-06-01-cutting-weight-and-fabric-consumption-design.md`

---

## File Structure

**Feature 1 — Denim-only weight auto-calc**
- Create: `public/js/cuttingWeight.js` — pure weight math (UMD: browser global + CommonJS export).
- Create: `test/cuttingWeight.test.js` — `node:test` unit tests for the math.
- Modify: `routes/cuttingManagerRoutes.js` — pass `isDenim` to the dashboard render.
- Modify: `views/cuttingManagerDashboard.ejs` — load the module, branch weight wiring on `isDenim`.
- Modify: `routes/editcuttinglots.js` — branch the add-missed-roll form on `lot.flow_type`.
- Modify: `package.json` — add `"test": "node --test"`.

**Feature 2 — Fabric consumption analysis**
- Create: `utils/fabricConsumption.js` — pure transforms (group by type, roll ledger, ad-hoc detection).
- Create: `test/fabricConsumption.test.js` — `node:test` unit tests for the transforms.
- Create: `views/fabricConsumptionAnalysis.ejs` — tabbed analysis page.
- Modify: `routes/fabricManagerRoutes.js` — add `GET /analysis` and `GET /analysis/export`.
- Modify: `views/fabricManagerDashboard.ejs` — add a link to the analysis page.

---

# PART A — Feature 1: Denim-only weight auto-calc

## Task 1: Weight-math module + tests

**Files:**
- Create: `public/js/cuttingWeight.js`
- Create: `test/cuttingWeight.test.js`
- Modify: `package.json` (scripts)

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, change the `scripts` block to include a `test` entry:

```json
  "scripts": {
    "start": "node app.js",
    "start:dev": "node --watch app.js",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test**

Create `test/cuttingWeight.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { computeRollWeights } = require('../public/js/cuttingWeight.js');

test('denim: used = tableLength * layers, remaining = full - used', () => {
  const r = computeRollWeights('denim', { tableLength: 1.5, layers: 8, full: 50 });
  assert.strictEqual(r.used, 12);
  assert.strictEqual(r.remaining, 38);
  assert.strictEqual(r.over, false);
});

test('denim: over-weight flags and clamps remaining to 0', () => {
  const r = computeRollWeights('denim', { tableLength: 10, layers: 8, full: 50 });
  assert.strictEqual(r.used, 80);
  assert.strictEqual(r.remaining, 0);
  assert.strictEqual(r.over, true);
});

test('denim: missing tableLength or layers yields nulls', () => {
  const r = computeRollWeights('denim', { tableLength: '', layers: 8, full: 50 });
  assert.strictEqual(r.used, null);
  assert.strictEqual(r.remaining, null);
});

test('hosiery: used = full - remaining', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: 4 });
  assert.strictEqual(r.used, 26);
  assert.strictEqual(r.remaining, 4);
  assert.strictEqual(r.over, false);
});

test('hosiery: empty remaining defaults to 0 so used = full', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: '' });
  assert.strictEqual(r.used, 30);
  assert.strictEqual(r.remaining, 0);
});

test('hosiery: remaining > full flags over and clamps used to 0', () => {
  const r = computeRollWeights('hosiery', { full: 30, remaining: 40 });
  assert.strictEqual(r.used, 0);
  assert.strictEqual(r.over, true);
});

test('hosiery: missing full yields null used', () => {
  const r = computeRollWeights('hosiery', { full: '', remaining: 5 });
  assert.strictEqual(r.used, null);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../public/js/cuttingWeight.js'`.

- [ ] **Step 4: Write the module**

Create `public/js/cuttingWeight.js`:

```js
// Pure weight math shared by the cutting-entry forms (browser) and tests (node).
// UMD wrapper: attaches `CuttingWeight` to the browser global and also exports
// for CommonJS so `node:test` can require it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CuttingWeight = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function num(v) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }

  // mode: 'denim' | 'hosiery'
  // inputs: { tableLength, layers, full, remaining }
  // returns: { used, remaining, over }  (used/remaining are numbers or null)
  function computeRollWeights(mode, inputs) {
    const full = num(inputs.full);

    if (mode === 'denim') {
      const tableLength = num(inputs.tableLength);
      const layers = num(inputs.layers);
      if (tableLength === null || layers === null) {
        return { used: null, remaining: null, over: false };
      }
      const used = tableLength * layers;
      const remaining = full === null ? null : Math.max(full - used, 0);
      const over = full !== null && used > full;
      return { used, remaining, over };
    }

    // hosiery: operator enters remaining (default 0); used = full - remaining
    const remaining = num(inputs.remaining) === null ? 0 : num(inputs.remaining);
    if (full === null) {
      return { used: null, remaining, over: false };
    }
    const rawUsed = full - remaining;
    const over = remaining > full;
    return { used: Math.max(rawUsed, 0), remaining, over };
  }

  return { computeRollWeights };
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all 7 `cuttingWeight` tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json public/js/cuttingWeight.js test/cuttingWeight.test.js
git commit -m "feat(cutting): add tested weight-math module (denim auto-calc / hosiery manual)"
```

---

## Task 2: Pass `isDenim` to the cutting dashboard render

**Files:**
- Modify: `routes/cuttingManagerRoutes.js` (GET `/dashboard`, around lines 169-179)

- [ ] **Step 1: Query the cutter's `is_denim_cutter` flag**

In `routes/cuttingManagerRoutes.js`, inside the `GET /dashboard` handler, immediately before the `res.render('cuttingManagerDashboard', { ... })` call (currently ~line 172), add:

```js
    // Determine the cutter's flow type so the form renders in denim or hosiery mode.
    const [[cutterFlag]] = await pool.query(
      'SELECT is_denim_cutter FROM users WHERE id = ?',
      [userId]
    );
    const isDenim = !!(cutterFlag && cutterFlag.is_denim_cutter);
```

- [ ] **Step 2: Add `isDenim` to the render payload**

Change the render call to include `isDenim`:

```js
    res.render('cuttingManagerDashboard', {
      user: req.session.user,
      cuttingLots,
      departmentUsers,
      pendingAssignments,
      rollsByFabricType, // Now includes vendor_name
      generatedLotNumber, // Pass the generated lot number
      isDenim,
    });
```

- [ ] **Step 3: Verify the app boots**

Run: `node -e "require('./routes/cuttingManagerRoutes.js'); console.log('OK')"`
Expected: prints `OK` with no syntax/require error.

- [ ] **Step 4: Commit**

```bash
git add routes/cuttingManagerRoutes.js
git commit -m "feat(cutting): pass isDenim flag to cutting dashboard view"
```

---

## Task 3: Branch the create-lot form weight wiring on `isDenim`

> **Use the `/frontend-design` skill** for the EJS/markup edits in this task. The data contract and JS behavior below are fixed; apply the skill for styling/labels/affordances consistent with the existing dashboard.

**Files:**
- Modify: `views/cuttingManagerDashboard.ejs`
  - Script include area (near line 1269)
  - `updateWeightUsed()` (lines 819-835)
  - Weight Used input markup (around line 550-552)
  - The roll-section input listeners (`initializeRollNoAutocomplete` ~727-768, `addNewRoll` ~779-803)

- [ ] **Step 1: Load the weight module and expose the mode flag**

Near the other script includes (after line 1269 `<script src="/public/js/lot-size-expand.js"></script>`), add:

```html
<script src="/public/js/cuttingWeight.js"></script>
```

At the top of the main inline `<script>` that defines `updateWeightUsed` (before that function), add a mode constant sourced from the server flag:

```js
  const IS_DENIM = <%= isDenim ? 'true' : 'false' %>;
  const FLOW_MODE = IS_DENIM ? 'denim' : 'hosiery';
```

- [ ] **Step 2: Replace `updateWeightUsed()` to branch on the mode**

Replace the entire current `updateWeightUsed(rollSection)` function (lines 819-835) with:

```js
function updateWeightUsed(rollSection) {
  const usedInput = rollSection.querySelector('.weightUsedInput');
  const remInput  = rollSection.querySelector('.remainingWeightInput');
  const full      = rollSection.querySelector('.fullWeightInput').value;

  let res;
  if (FLOW_MODE === 'denim') {
    // Weight Used auto-computes from table_length × layers; remaining is derived (hidden-ish).
    res = CuttingWeight.computeRollWeights('denim', {
      tableLength: document.getElementById('table_length').value,
      layers: rollSection.querySelector('.layersInput').value,
      full: full,
    });
    if (res.used === null) { usedInput.value = ''; remInput.value = ''; usedInput.classList.remove('over-weight'); return; }
    usedInput.value = res.used.toFixed(2);
    remInput.value  = res.remaining === null ? '' : res.remaining.toFixed(2);
  } else {
    // Hosiery: operator enters Remaining; Weight Used is derived display-only.
    res = CuttingWeight.computeRollWeights('hosiery', {
      full: full,
      remaining: remInput.value,
    });
    if (res.used === null) { usedInput.value = ''; usedInput.classList.remove('over-weight'); return; }
    usedInput.value = res.used.toFixed(2);
  }
  usedInput.classList.toggle('over-weight', res.over);
}
```

- [ ] **Step 3: Set input editability per mode in the Weight Used / Remaining markup**

The Weight Used input (around line 550) must be **read-only in both modes** (denim auto, hosiery derived):

```html
        <input type="number" step="0.01" class="kotty-input weightUsedInput" name="weight_used[]" min="0" readonly placeholder="Weight used (auto)" />
```

Locate the Remaining input (`remainingWeightInput`, `name="roll_remaining_weight[]"`). Make it editable for hosiery and default to `0`, read-only for denim. Render its attributes conditionally:

```html
        <input type="number" step="0.01" class="kotty-input remainingWeightInput" name="roll_remaining_weight[]" min="0"
               <%= isDenim ? 'readonly' : 'value="0"' %> placeholder="<%= isDenim ? 'Auto (full − used)' : 'Remaining (default 0)' %>" />
```

> If the Remaining input is currently a hidden field, convert it to a visible number input so hosiery operators can edit it. For denim it stays read-only/derived.

- [ ] **Step 4: Add the Remaining-input listener (hosiery) and keep table_length re-trigger (denim)**

In `initializeRollNoAutocomplete(rollSection, fabricType)` (after the existing `weightUsedInput` listener block ~763-767), add a listener on the remaining input:

```js
  remainingWeightInput.addEventListener('input', () => {
    updateWeightUsed(rollSection);
    updateWeightProgress(rollSection);
    checkRollsCompletion();
  });
```

In `addNewRoll()` (after the existing per-roll listeners ~796-800), add the same for the cloned roll:

```js
  newRoll.querySelector('.remainingWeightInput').addEventListener('input', () => {
    updateWeightUsed(newRoll);
    updateWeightProgress(newRoll);
    checkRollsCompletion();
  });
```

For denim, recompute all rolls when `table_length` changes. After the `addRollBtn`/`addSizeBtn` wiring near line 874, add:

```js
  const tableLengthInput = document.getElementById('table_length');
  if (tableLengthInput && FLOW_MODE === 'denim') {
    tableLengthInput.addEventListener('input', () => {
      rollsContainer.querySelectorAll('.roll-section:not(.d-none)').forEach(rs => {
        updateWeightUsed(rs);
        updateWeightProgress(rs);
      });
      checkRollsCompletion();
    });
  }
```

- [ ] **Step 5: Require `table_length` for denim only**

Find the `table_length` input in the form (id `table_length`). Make it `required` only for denim:

```html
        <input type="number" step="0.01" min="0" class="kotty-input" id="table_length" name="table_length" <%= isDenim ? 'required' : '' %> placeholder="<%= isDenim ? 'Table length (required for denim)' : 'Table length (optional)' %>" />
```

If `checkRollsCompletion()` gates the Create button, add a denim-only guard so the button stays disabled until `table_length` is a positive number. Inside `checkRollsCompletion()`, before it enables the submit button, add:

```js
  if (FLOW_MODE === 'denim') {
    const tl = parseFloat(document.getElementById('table_length').value);
    if (!(tl > 0)) { /* keep submit disabled */ allComplete = false; }
  }
```

(Use the function's existing completion variable name in place of `allComplete` if it differs.)

- [ ] **Step 6: Verify EJS parses**

Run: `node -e "const ejs=require('ejs');const fs=require('fs');ejs.compile(fs.readFileSync('views/cuttingManagerDashboard.ejs','utf8'),{filename:'views/cuttingManagerDashboard.ejs'});console.log('EJS OK')"`
Expected: prints `EJS OK` (template compiles; no syntax error).

- [ ] **Step 7: Manual browser check (denim)**

Run `npm start`, log in as a cutter whose `users.is_denim_cutter = 1`, open the cutting dashboard.
Expected: Weight Used is read-only; setting `table_length=1.5`, picking an in-DB roll (Full auto-fills, e.g. 50), and entering `layers=8` shows Weight Used = `12.00`; Remaining shows `38.00`; the Create button stays disabled until table_length > 0.

- [ ] **Step 8: Manual browser check (hosiery)**

Log in as a cutter with `is_denim_cutter = 0`.
Expected: Remaining input is editable and pre-filled `0`; picking an in-DB roll fills Full (e.g. 30) → Weight Used shows `30.00`; changing Remaining to `4` → Weight Used `26.00`; table_length is optional. Saving a lot deducts the used weight from `fabric_invoice_rolls` (verify the roll's available weight dropped).

- [ ] **Step 9: Commit**

```bash
git add views/cuttingManagerDashboard.ejs
git commit -m "feat(cutting): denim weight auto-calc vs hosiery manual remaining in create form"
```

---

## Task 4: Branch the add-missed-roll form on `lot.flow_type`

> **Use the `/frontend-design` skill** for the markup edits. The `lot` object in this route already carries `flow_type`.

**Files:**
- Modify: `routes/editcuttinglots.js` (the `GET /editcuttinglots/edit-form` handler that renders the add-missed-roll form, ~lines 405-560)

- [ ] **Step 1: Compute an `isDenim` flag in the edit-form handler**

In `routes/editcuttinglots.js`, after the `lot` row is loaded in the `edit-form` GET handler, add:

```js
          const isDenim = (lot.flow_type === 'denim');
```

Confirm the SELECT that loads `lot` includes `flow_type` (it joins `cutting_lots`); if not, add `flow_type` to that SELECT's column list.

- [ ] **Step 2: Make Weight Used read-only and Remaining editable for hosiery**

In the add-missed-roll markup, the Weight Used input becomes read-only in both modes:

```html
                        <input type="number" step="0.01" min="0" class="form-control" id="addRollWeightUsed" readonly placeholder="Weight used (auto)">
```

The Remaining input is editable + default `0` for hosiery, read-only for denim:

```html
                        <input type="number" step="0.01" min="0" class="form-control" id="addRollRemaining" ${isDenim ? 'readonly' : 'value="0"'} placeholder="${isDenim ? 'Auto' : 'Remaining (default 0)'}">
```

(Match the actual existing id for the remaining field — it is the `addRollRem`/`addRollRemaining` element used in `recomputeAddRollWeights`.)

- [ ] **Step 3: Branch `recomputeAddRollWeights()` on the mode**

Pass the table length and mode into the inline script, then branch. Add near the existing `ROLL_INVENTORY` constant:

```js
          const IS_DENIM = ${isDenim ? 'true' : 'false'};
          const TABLE_LENGTH = ${lot.table_length ? Number(lot.table_length) : 'null'};
```

Replace `recomputeAddRollWeights()` with:

```js
          function recomputeAddRollWeights() {
            const full = parseFloat(addRollFullW.value);
            if (IS_DENIM) {
              const layers = parseFloat(addRollLayers.value);
              if (isNaN(layers) || TABLE_LENGTH == null) { addRollUsed.value=''; addRollRem.value=''; return; }
              const used = TABLE_LENGTH * layers;
              addRollUsed.value = used.toFixed(2);
              addRollRem.value = isNaN(full) ? '' : Math.max(full - used, 0).toFixed(2);
              addRollUsed.classList.toggle('text-danger', !isNaN(full) && used > full);
            } else {
              const remaining = addRollRem.value === '' ? 0 : parseFloat(addRollRem.value);
              if (isNaN(full)) { addRollUsed.value=''; addRollUsed.classList.remove('text-danger'); return; }
              addRollUsed.value = Math.max(full - remaining, 0).toFixed(2);
              addRollUsed.classList.toggle('text-danger', remaining > full);
            }
          }
```

- [ ] **Step 4: Fix the input listeners for the mode**

Replace the listener wiring so denim listens on layers and hosiery listens on remaining:

```js
          addRollFullW.addEventListener('input', recomputeAddRollWeights);
          if (IS_DENIM) {
            addRollLayers.addEventListener('input', recomputeAddRollWeights);
          } else {
            addRollRem.addEventListener('input', recomputeAddRollWeights);
          }
```

- [ ] **Step 5: Re-add the denim-only "no table_length" blocker**

Restore the warning + disabled button, gated to denim. In the markup intro paragraph add (denim only):

```js
                    ${isDenim && !lot.table_length ? `
                      <div class="alert alert-danger py-2 mb-2 small">
                        This denim lot has no <strong>table_length</strong> — Weight Used can't be computed. Set table_length on the lot first.
                      </div>` : ''}
```

And the Add button:

```js
                      <button type="button" class="btn btn-primary btn-sm" id="addRollBtn"${isDenim && !lot.table_length ? ' disabled' : ''}>
```

- [ ] **Step 6: Verify the route module loads**

Run: `node -e "require('./routes/editcuttinglots.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 7: Manual check**

Run `npm start`, open the edit form for a denim lot and a hosiery lot via the operator UI.
Expected: denim lot → Weight Used auto = table_length × layers, Add disabled when lot has no table_length; hosiery lot → Remaining editable (default 0), Weight Used = full − remaining.

- [ ] **Step 8: Commit**

```bash
git add routes/editcuttinglots.js
git commit -m "feat(cutting): denim/hosiery weight branching in add-missed-roll form"
```

---

# PART B — Feature 2: Fabric consumption analysis

## Task 5: Consumption transforms module + tests

**Files:**
- Create: `utils/fabricConsumption.js`
- Create: `test/fabricConsumption.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/fabricConsumption.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const {
  groupConsumptionByFabricType,
  buildRollLedger,
  findAdHocRolls,
  findAdHocFabricTypes,
} = require('../utils/fabricConsumption.js');

const rows = [
  { fabric_type: 'Denim', lot_no: 'L1', sku: 'S1', created_at: '2026-05-01', cutter: 'amy', cutting_lot_id: 1, roll_no: 'R1', full_weight: 50, weight_used: 12, remaining_weight: 38 },
  { fabric_type: 'Denim', lot_no: 'L1', sku: 'S1', created_at: '2026-05-01', cutter: 'amy', cutting_lot_id: 1, roll_no: 'R2', full_weight: 40, weight_used: 10, remaining_weight: 30 },
  { fabric_type: 'Denim', lot_no: 'L2', sku: 'S2', created_at: '2026-05-02', cutter: 'amy', cutting_lot_id: 2, roll_no: 'R1', full_weight: 38, weight_used: 8,  remaining_weight: 30 },
  { fabric_type: 'Cotton', lot_no: 'L3', sku: 'S3', created_at: '2026-05-03', cutter: 'bob', cutting_lot_id: 3, roll_no: 'X9', full_weight: 20, weight_used: 5,  remaining_weight: 15 },
];

test('groupConsumptionByFabricType aggregates per type and lot', () => {
  const g = groupConsumptionByFabricType(rows);
  const denim = g.find(x => x.fabricType === 'Denim');
  assert.strictEqual(denim.totalUsed, 30);
  assert.strictEqual(denim.lotCount, 2);
  assert.strictEqual(denim.rollCount, 3);
  const l1 = denim.lots.find(l => l.lotNo === 'L1');
  assert.strictEqual(l1.totalUsed, 22);
  assert.strictEqual(l1.rolls.length, 2);
});

test('buildRollLedger sums used per roll across lots and resolves master', () => {
  const master = [
    { roll_no: 'R1', fabric_type: 'Denim', vendor_name: 'Acme', per_roll_weight: 30, unit: 'kg' },
    { roll_no: 'R2', fabric_type: 'Denim', vendor_name: 'Acme', per_roll_weight: 30, unit: 'kg' },
  ];
  const ledger = buildRollLedger(rows, master);
  const r1 = ledger.find(r => r.rollNo === 'R1');
  assert.strictEqual(r1.totalUsed, 20);            // 12 + 8
  assert.strictEqual(r1.currentAvailable, 30);
  assert.strictEqual(r1.vendor, 'Acme');
  assert.deepStrictEqual(r1.lots.sort(), ['L1', 'L2']);
  const x9 = ledger.find(r => r.rollNo === 'X9');
  assert.strictEqual(x9.currentAvailable, null);   // ad-hoc, not in master
  assert.strictEqual(x9.vendor, '(ad-hoc)');
});

test('findAdHocRolls returns rolls absent from master', () => {
  const adhoc = findAdHocRolls(rows, ['R1', 'R2']);
  assert.strictEqual(adhoc.length, 1);
  assert.strictEqual(adhoc[0].rollNo, 'X9');
  assert.strictEqual(adhoc[0].lotNo, 'L3');
});

test('findAdHocFabricTypes is case-insensitive and deduped', () => {
  const adhoc = findAdHocFabricTypes(['Denim', 'cotton', 'Linen', 'LINEN'], ['Denim', 'Cotton']);
  assert.deepStrictEqual(adhoc, ['Linen']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/fabricConsumption.test.js`
Expected: FAIL — `Cannot find module '../utils/fabricConsumption.js'`.

- [ ] **Step 3: Write the module**

Create `utils/fabricConsumption.js`:

```js
// Pure transforms for the fabric-manager consumption analysis page.
// Input rows come from SQL (cutting_lot_rolls joined to cutting_lots + users).
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// rows: [{ fabric_type, lot_no, sku, created_at, cutter, cutting_lot_id, roll_no, full_weight, weight_used, remaining_weight }]
function groupConsumptionByFabricType(rows) {
  const byType = new Map();
  for (const r of rows) {
    const ft = r.fabric_type || '(none)';
    if (!byType.has(ft)) byType.set(ft, { fabricType: ft, totalUsed: 0, lots: new Map() });
    const g = byType.get(ft);
    g.totalUsed += Number(r.weight_used) || 0;
    if (!g.lots.has(r.cutting_lot_id)) {
      g.lots.set(r.cutting_lot_id, {
        lotNo: r.lot_no, sku: r.sku, createdAt: r.created_at, cutter: r.cutter, totalUsed: 0, rolls: [],
      });
    }
    const lot = g.lots.get(r.cutting_lot_id);
    lot.totalUsed += Number(r.weight_used) || 0;
    lot.rolls.push({
      rollNo: r.roll_no,
      full: round2(r.full_weight),
      used: round2(r.weight_used),
      remaining: round2(r.remaining_weight),
    });
  }
  return [...byType.values()].map(g => {
    const lots = [...g.lots.values()].map(l => ({ ...l, totalUsed: round2(l.totalUsed) }));
    return {
      fabricType: g.fabricType,
      totalUsed: round2(g.totalUsed),
      lotCount: lots.length,
      rollCount: lots.reduce((n, l) => n + l.rolls.length, 0),
      lots,
    };
  });
}

// masterRows: [{ roll_no, fabric_type, vendor_name, per_roll_weight, unit }]
function buildRollLedger(consumptionRows, masterRows) {
  const master = new Map((masterRows || []).map(m => [m.roll_no, m]));
  const byRoll = new Map();
  for (const r of consumptionRows) {
    if (!byRoll.has(r.roll_no)) {
      const m = master.get(r.roll_no);
      byRoll.set(r.roll_no, {
        rollNo: r.roll_no,
        fabricType: (m && m.fabric_type) || r.fabric_type || '(none)',
        vendor: (m && m.vendor_name) || '(ad-hoc)',
        currentAvailable: m ? round2(m.per_roll_weight) : null,
        unit: (m && m.unit) || '',
        totalUsed: 0,
        lots: [],
      });
    }
    const e = byRoll.get(r.roll_no);
    e.totalUsed += Number(r.weight_used) || 0;
    e.lots.push(r.lot_no);
  }
  return [...byRoll.values()].map(e => ({
    ...e,
    totalUsed: round2(e.totalUsed),
    lots: [...new Set(e.lots)],
  }));
}

function findAdHocRolls(consumptionRows, masterRollNos) {
  const set = new Set(masterRollNos || []);
  const out = new Map();
  for (const r of consumptionRows) {
    if (set.has(r.roll_no)) continue;
    const key = r.roll_no + '|' + r.cutting_lot_id;
    if (!out.has(key)) {
      out.set(key, {
        rollNo: r.roll_no,
        fabricType: r.fabric_type || '(none)',
        full: round2(r.full_weight),
        used: round2(r.weight_used),
        lotNo: r.lot_no,
        cutter: r.cutter,
      });
    }
  }
  return [...out.values()];
}

function findAdHocFabricTypes(lotFabricTypes, masterFabricTypes) {
  const master = new Set((masterFabricTypes || []).map(s => (s || '').toLowerCase().trim()));
  const seen = new Set();
  const out = [];
  for (const ft of lotFabricTypes || []) {
    if (!ft) continue;
    const key = ft.toLowerCase().trim();
    if (master.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(ft);
  }
  return out;
}

module.exports = {
  round2,
  groupConsumptionByFabricType,
  buildRollLedger,
  findAdHocRolls,
  findAdHocFabricTypes,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/fabricConsumption.test.js`
Expected: PASS — all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add utils/fabricConsumption.js test/fabricConsumption.test.js
git commit -m "feat(fabric): tested consumption-analysis transforms (group/ledger/ad-hoc)"
```

---

## Task 6: Analysis route with date filter

**Files:**
- Modify: `routes/fabricManagerRoutes.js` (add `GET /analysis`; place near the other GET routes)

- [ ] **Step 1: Import the transforms at the top of the file**

Near the top of `routes/fabricManagerRoutes.js` with the other `require`s, add:

```js
const {
  groupConsumptionByFabricType,
  buildRollLedger,
  findAdHocRolls,
  findAdHocFabricTypes,
} = require('../utils/fabricConsumption');
```

- [ ] **Step 2: Add a shared data-loader used by the page and the export**

Add this helper function in the module (above the route definitions). It runs the queries with an optional date range and returns the four computed datasets:

```js
// Loads + computes all analysis datasets for an optional [from, to] date range
// (inclusive of the whole `to` day). from/to are 'YYYY-MM-DD' strings or null.
async function loadConsumptionAnalysis(from, to) {
  const f = from || null;
  const t = to || null;
  const consumptionSql = `
    SELECT cl.fabric_type, cl.lot_no, cl.sku, cl.created_at, u.username AS cutter,
           cl.id AS cutting_lot_id, clr.roll_no, clr.full_weight, clr.weight_used, clr.remaining_weight
    FROM cutting_lot_rolls clr
    JOIN cutting_lots cl ON clr.cutting_lot_id = cl.id
    JOIN users u ON cl.user_id = u.id
    WHERE (? IS NULL OR cl.created_at >= ?)
      AND (? IS NULL OR cl.created_at < DATE_ADD(?, INTERVAL 1 DAY))
    ORDER BY cl.fabric_type ASC, cl.created_at DESC`;
  const [consumptionRows] = await pool.query(consumptionSql, [f, f, t, t]);

  const [masterRows] = await pool.query(`
    SELECT fir.roll_no, fi.fabric_type, v.name AS vendor_name, fir.per_roll_weight, fir.unit
    FROM fabric_invoice_rolls fir
    JOIN fabric_invoices fi ON fir.invoice_id = fi.id
    JOIN vendors v ON fir.vendor_id = v.id`);

  const [lotTypeRows] = await pool.query(`SELECT DISTINCT fabric_type FROM cutting_lots WHERE fabric_type IS NOT NULL`);
  const [masterTypeRows] = await pool.query(`SELECT DISTINCT fabric_type FROM fabric_invoices WHERE fabric_type IS NOT NULL`);

  const masterRollNos = masterRows.map(m => m.roll_no);
  const lotFabricTypes = lotTypeRows.map(r => r.fabric_type);
  const masterFabricTypes = masterTypeRows.map(r => r.fabric_type);

  return {
    byType: groupConsumptionByFabricType(consumptionRows),
    ledger: buildRollLedger(consumptionRows, masterRows),
    adHocRolls: findAdHocRolls(consumptionRows, masterRollNos),
    adHocTypes: findAdHocFabricTypes(lotFabricTypes, masterFabricTypes),
  };
}
```

> Note: confirm the pool variable name used elsewhere in this file (e.g. `pool` / `db`) and use that exact name. Confirm `isFabricManager` is the middleware imported in this file.

- [ ] **Step 3: Add the GET /analysis route**

```js
// GET /fabric-manager/analysis — consumption analysis (3 tabs + date filter)
router.get('/analysis', isAuthenticated, isFabricManager, async (req, res) => {
  try {
    const from = req.query.from || '';
    const to = req.query.to || '';
    const data = await loadConsumptionAnalysis(from, to);
    res.render('fabricConsumptionAnalysis', {
      user: req.session.user,
      from, to,
      byType: data.byType,
      ledger: data.ledger,
      adHocRolls: data.adHocRolls,
      adHocTypes: data.adHocTypes,
    });
  } catch (err) {
    console.error('Error loading fabric consumption analysis:', err);
    req.flash('error', 'Failed to load fabric consumption analysis.');
    res.redirect('/fabric-manager/dashboard');
  }
});
```

- [ ] **Step 4: Verify the module loads**

Run: `node -e "require('./routes/fabricManagerRoutes.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 5: Commit**

```bash
git add routes/fabricManagerRoutes.js
git commit -m "feat(fabric): add /analysis route + date-filtered data loader"
```

---

## Task 7: Analysis page view (3 tabs + date filter)

> **Use the `/frontend-design` skill** to build this view consistent with `views/fabricManagerDashboard.ejs` styling. The data contract below is fixed.

**Files:**
- Create: `views/fabricConsumptionAnalysis.ejs`
- Modify: `views/fabricManagerDashboard.ejs` (add a link to the analysis page in the bottom action area, ~lines 590-601)

**Data contract passed to the view:**
- `from`, `to` — date strings (may be empty).
- `byType` — `[{ fabricType, totalUsed, lotCount, rollCount, lots: [{ lotNo, sku, createdAt, cutter, totalUsed, rolls: [{ rollNo, full, used, remaining }] }] }]`
- `ledger` — `[{ rollNo, fabricType, vendor, currentAvailable, unit, totalUsed, lots: [lotNo, ...] }]`
- `adHocRolls` — `[{ rollNo, fabricType, full, used, lotNo, cutter }]`
- `adHocTypes` — `[fabricTypeString, ...]`

- [ ] **Step 1: Create the view skeleton with the date filter and three tabs**

Create `views/fabricConsumptionAnalysis.ejs`. Build with `/frontend-design`, fulfilling this structure:

- A `GET` form at top with two `<input type="date" name="from">` / `name="to"` pre-filled from `from`/`to`, an Apply button, and a "Clear" link to `/fabric-manager/analysis`.
- Three tabs (Bootstrap nav-tabs to match the existing dashboard):
  - **Consumption by fabric type** — for each `byType` entry, a collapsible group header showing `fabricType`, `totalUsed`, `lotCount`, `rollCount`; expanding shows each lot (`lotNo`, `sku`, `createdAt`, `cutter`, `totalUsed`) and its `rolls` table (`rollNo`, `full`, `used`, `remaining`).
  - **Roll ledger** — a table of `ledger` rows: `rollNo`, `fabricType`, `vendor`, `currentAvailable` (show `—` when null) + `unit`, `totalUsed`, and `lots` joined by `, `.
  - **Unknown / ad-hoc** — two sub-tables: `adHocRolls` (`rollNo`, `fabricType`, `full`, `used`, `lotNo`, `cutter`) and `adHocTypes` (a simple list).
- Each tab has an "Export to Excel" button linking to `/fabric-manager/analysis/export?tab=consumption|ledger|adhoc&from=<from>&to=<to>`.

- [ ] **Step 2: Add the link from the fabric-manager dashboard**

In `views/fabricManagerDashboard.ejs` bottom action area (~lines 590-601, alongside the bulk-upload / advanced-view buttons), add:

```html
<a href="/fabric-manager/analysis" class="btn btn-outline-primary">
  <i class="bi bi-graph-up"></i> Consumption Analysis
</a>
```

- [ ] **Step 3: Verify both views parse**

Run:
```bash
node -e "const ejs=require('ejs'),fs=require('fs');['views/fabricConsumptionAnalysis.ejs','views/fabricManagerDashboard.ejs'].forEach(f=>{ejs.compile(fs.readFileSync(f,'utf8'),{filename:f});console.log(f,'OK')})"
```
Expected: both print `OK`.

- [ ] **Step 4: Manual check**

Run `npm start`, log in as a `fabric_manager`, click "Consumption Analysis".
Expected: three tabs render with data; setting a from/to date and clicking Apply narrows the rows; "Clear" resets to all-time; ad-hoc tab lists rolls/types used in cutting that are not in fabric data.

- [ ] **Step 5: Commit**

```bash
git add views/fabricConsumptionAnalysis.ejs views/fabricManagerDashboard.ejs
git commit -m "feat(fabric): consumption analysis view (3 tabs + date filter) and dashboard link"
```

---

## Task 8: Excel export for each tab

**Files:**
- Modify: `routes/fabricManagerRoutes.js` (add `GET /analysis/export`)

- [ ] **Step 1: Add the export route**

Add after the `/analysis` route. It reuses `loadConsumptionAnalysis` and builds a sheet per `tab`. Use `exceljs` (already a dependency); match the response-header style of the existing `/download-excel` route in this file.

```js
const ExcelJS = require('exceljs'); // if not already required at top; otherwise reuse the existing import

// GET /fabric-manager/analysis/export?tab=consumption|ledger|adhoc&from=&to=
router.get('/analysis/export', isAuthenticated, isFabricManager, async (req, res) => {
  try {
    const from = req.query.from || '';
    const to = req.query.to || '';
    const tab = req.query.tab || 'consumption';
    const data = await loadConsumptionAnalysis(from, to);

    const wb = new ExcelJS.Workbook();

    if (tab === 'ledger') {
      const ws = wb.addWorksheet('Roll Ledger');
      ws.addRow(['Roll No', 'Fabric Type', 'Vendor', 'Current Available', 'Unit', 'Total Used', 'Lots']);
      data.ledger.forEach(r => ws.addRow([
        r.rollNo, r.fabricType, r.vendor,
        r.currentAvailable == null ? '' : r.currentAvailable, r.unit,
        r.totalUsed, r.lots.join(', '),
      ]));
    } else if (tab === 'adhoc') {
      const ws1 = wb.addWorksheet('Ad-hoc Rolls');
      ws1.addRow(['Roll No', 'Fabric Type', 'Full', 'Used', 'Lot No', 'Cutter']);
      data.adHocRolls.forEach(r => ws1.addRow([r.rollNo, r.fabricType, r.full, r.used, r.lotNo, r.cutter]));
      const ws2 = wb.addWorksheet('Ad-hoc Fabric Types');
      ws2.addRow(['Fabric Type (not in fabric data)']);
      data.adHocTypes.forEach(ft => ws2.addRow([ft]));
    } else {
      const ws = wb.addWorksheet('Consumption by Fabric Type');
      ws.addRow(['Fabric Type', 'Lot No', 'SKU', 'Created At', 'Cutter', 'Roll No', 'Full', 'Used', 'Remaining']);
      data.byType.forEach(g => g.lots.forEach(l => l.rolls.forEach(roll => {
        ws.addRow([g.fabricType, l.lotNo, l.sku, l.createdAt, l.cutter, roll.rollNo, roll.full, roll.used, roll.remaining]);
      })));
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="fabric-${tab}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting fabric analysis:', err);
    req.flash('error', 'Failed to export fabric analysis.');
    res.redirect('/fabric-manager/analysis');
  }
});
```

> If the file already `require`s `exceljs` (used by `/download-excel`), reuse that import instead of adding a second one.

- [ ] **Step 2: Verify the module loads**

Run: `node -e "require('./routes/fabricManagerRoutes.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Manual check**

Run `npm start`, on the analysis page click each tab's "Export to Excel".
Expected: three downloads — `fabric-consumption.xlsx`, `fabric-ledger.xlsx`, `fabric-adhoc.xlsx` — each opening with the expected columns and respecting the active date filter.

- [ ] **Step 4: Commit**

```bash
git add routes/fabricManagerRoutes.js
git commit -m "feat(fabric): Excel export per analysis tab (date-filter aware)"
```

---

## Final verification

- [ ] **Run the full unit suite**

Run: `npm test`
Expected: all `cuttingWeight` and `fabricConsumption` tests pass (11 tests total).

- [ ] **Smoke-test the app boots**

Run: `node -e "require('./app.js')" ` is not appropriate (starts server); instead confirm all touched route modules load:
```bash
node -e "require('./routes/cuttingManagerRoutes.js');require('./routes/editcuttinglots.js');require('./routes/fabricManagerRoutes.js');console.log('all routes OK')"
```
Expected: prints `all routes OK`.

---

## Self-Review notes (filled by plan author)

- **Spec coverage:** Feature 1 denim auto-calc (Tasks 1-4), hosiery manual remaining default 0 (Tasks 1,3,4), roll lookup + stock deduction unchanged (no backend change — relies on existing POST). Feature 2 three tabs (Task 7), date filter (Tasks 6-8), ad-hoc rolls + types (Tasks 5-7), Excel exports honoring filter (Task 8), dashboard link (Task 7). All spec sections mapped.
- **No new migrations / DB columns** — consistent with spec "no new DB columns."
- **Type consistency:** `computeRollWeights(mode, inputs)` signature identical across Tasks 1/3. `loadConsumptionAnalysis` return keys (`byType`, `ledger`, `adHocRolls`, `adHocTypes`) identical across Tasks 6/7/8. Transform output property names (`fabricType`, `totalUsed`, `lotCount`, `rollCount`, `lots`, `rollNo`, `currentAvailable`) identical between Task 5 module, Task 7 view contract, and Task 8 export.
- **Open confirmations for the executor (verify against live code, don't assume):** exact pool variable name and `isFabricManager`/`isAuthenticated` imports in `fabricManagerRoutes.js`; whether `exceljs` is already required there; the exact element id of the add-roll Remaining input in `editcuttinglots.js`; whether the create-form Remaining field is currently hidden (convert to visible number input for hosiery).
