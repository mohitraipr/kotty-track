# Ad-hoc Cutting Entry Switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global, admin-controlled switch (`store_settings.allow_adhoc_cutting_entry`, default OFF) that blocks cutters from entering fabric types / roll numbers not in the fabric database — enforced in the UI and on the server across the create-lot form, add-missed-roll form, and bulk upload.

**Architecture:** A shared `utils/storeSettings.js` reads the key/value `store_settings` table and resolves the switch to a fail-safe boolean (missing/garbage → OFF). Each entry point reads the flag and, when OFF, (a) makes the UI pickers strict and (b) rejects unknown fabric types / rolls server-side (server is the source of truth). An admin toggle on `/admin` flips the setting.

**Tech Stack:** Node v22 (built-in `node:test`), Express, EJS, MySQL (`mysql2`, `const { pool } = require('../config/db')`).

**Spec:** `docs/superpowers/specs/2026-06-01-adhoc-cutting-entry-switch-design.md`

---

## File Structure

- Create: `utils/storeSettings.js` — `getStoreSetting`, `resolveAllowAdhoc`, `allowAdhocCuttingEntry`, `isKnownFabricType`, `ADHOC_KEY`.
- Create: `test/storeSettings.test.js` — `node:test` for the pure functions.
- Create: `sql/adhoc_cutting_entry_setting_migration.sql` — seed the setting row.
- Modify: `routes/adminRoutes.js` — pass `allowAdhoc` to `/admin`; add `POST /admin/settings`.
- Modify: `views/admin.ejs` — settings card with the toggle.
- Modify: `routes/cuttingManagerRoutes.js` — pass `allowAdhoc` to dashboard; enforce in create-lot POST.
- Modify: `views/cuttingManagerDashboard.ejs` — strict pickers when `!allowAdhoc`.
- Modify: `routes/editcuttinglots.js` — enforce in add-roll POST + strict picker in edit-form.
- Modify: `routes/bulkUploadRoutes.js` — fabric-type known-check when `!allowAdhoc`.

---

## Task 1: Shared store-settings util + tests

**Files:**
- Create: `utils/storeSettings.js`
- Create: `test/storeSettings.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/storeSettings.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAllowAdhoc, isKnownFabricType } = require('../utils/storeSettings.js');

test('resolveAllowAdhoc: only literal true (any case) is true', () => {
  assert.strictEqual(resolveAllowAdhoc('true'), true);
  assert.strictEqual(resolveAllowAdhoc('TRUE'), true);
  assert.strictEqual(resolveAllowAdhoc(' True '), true);
  assert.strictEqual(resolveAllowAdhoc('false'), false);
  assert.strictEqual(resolveAllowAdhoc(''), false);
  assert.strictEqual(resolveAllowAdhoc('yes'), false);
  assert.strictEqual(resolveAllowAdhoc('1'), false);
  assert.strictEqual(resolveAllowAdhoc(undefined), false);
  assert.strictEqual(resolveAllowAdhoc(null), false);
});

test('isKnownFabricType: case-insensitive, trimmed membership', () => {
  const known = ['Denim', 'Cotton Lycra', 'Hosiery'];
  assert.strictEqual(isKnownFabricType('Denim', known), true);
  assert.strictEqual(isKnownFabricType('  denim ', known), true);
  assert.strictEqual(isKnownFabricType('COTTON LYCRA', known), true);
  assert.strictEqual(isKnownFabricType('Linen', known), false);
  assert.strictEqual(isKnownFabricType('', known), false);
  assert.strictEqual(isKnownFabricType('Denim', []), false);
  assert.strictEqual(isKnownFabricType(null, known), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/storeSettings.test.js`
Expected: FAIL — `Cannot find module '../utils/storeSettings.js'`.

- [ ] **Step 3: Write the module**

Create `utils/storeSettings.js`:

```js
// Shared access to the key/value `store_settings` table + the ad-hoc cutting switch.
const { pool } = require('../config/db');

const ADHOC_KEY = 'allow_adhoc_cutting_entry';

// Reads a store_settings value; returns defaultValue on miss or error.
async function getStoreSetting(key, defaultValue = null) {
  try {
    const [[row]] = await pool.query(
      'SELECT setting_value FROM store_settings WHERE setting_key = ?',
      [key]
    );
    return row ? row.setting_value : defaultValue;
  } catch {
    return defaultValue;
  }
}

// Coerce a stored string to a boolean. Fail-safe: only the literal 'true'
// (case-insensitive, trimmed) is true; everything else (incl. missing) is false.
function resolveAllowAdhoc(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

// Resolves the ad-hoc cutting switch to a boolean. Default OFF (false).
async function allowAdhocCuttingEntry() {
  const v = await getStoreSetting(ADHOC_KEY, 'false');
  return resolveAllowAdhoc(v);
}

function normalize(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// True if `type` matches one of knownTypes (case-insensitive, trimmed).
function isKnownFabricType(type, knownTypes) {
  const t = normalize(type);
  if (!t) return false;
  return (knownTypes || []).some((k) => normalize(k) === t);
}

module.exports = {
  ADHOC_KEY,
  getStoreSetting,
  resolveAllowAdhoc,
  allowAdhocCuttingEntry,
  isKnownFabricType,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/storeSettings.test.js`
Expected: PASS — 2 tests pass.
Also run `npm test` and confirm the whole suite still passes.

- [ ] **Step 5: Commit**

```bash
git add utils/storeSettings.js test/storeSettings.test.js
git commit -m "feat(settings): shared store-settings util + ad-hoc switch resolver (tested)"
```

---

## Task 2: Seed migration for the setting

**Files:**
- Create: `sql/adhoc_cutting_entry_setting_migration.sql`

- [ ] **Step 1: Create the migration**

Create `sql/adhoc_cutting_entry_setting_migration.sql`:

```sql
-- Seeds the global switch that controls whether cutters may enter fabric types /
-- roll numbers not present in the fabric database. Default OFF ('false').
-- The store_settings table is created by store_indent_revamp_migration.sql.
INSERT IGNORE INTO store_settings (setting_key, setting_value)
VALUES ('allow_adhoc_cutting_entry', 'false');
```

- [ ] **Step 2: Sanity-check the SQL parses (syntax only, no DB needed)**

Run: `grep -c "allow_adhoc_cutting_entry" sql/adhoc_cutting_entry_setting_migration.sql`
Expected: prints `1`.

> Note: `allowAdhocCuttingEntry()` defaults to `false` when the row is absent, so the switch is OFF even before this migration runs. The migration just makes the row explicit; the admin POST (Task 3) also upserts it.

- [ ] **Step 3: Commit**

```bash
git add sql/adhoc_cutting_entry_setting_migration.sql
git commit -m "feat(settings): seed allow_adhoc_cutting_entry=false migration"
```

---

## Task 3: Admin toggle (read on /admin + POST /admin/settings + UI)

**Files:**
- Modify: `routes/adminRoutes.js` (GET `/admin` render ~lines 66-73; add a POST route near the other POST routes)
- Modify: `views/admin.ejs` (Overview tab, insert a settings card before the Overview pane closes ~line 553)

- [ ] **Step 1: Import the helper in adminRoutes.js**

At the top of `routes/adminRoutes.js`, with the other requires, add:

```js
const { allowAdhocCuttingEntry } = require('../utils/storeSettings');
```

- [ ] **Step 2: Pass `allowAdhoc` to the /admin render**

In the GET `/admin` handler, before `res.render('admin', { ... })`, add:

```js
    const allowAdhoc = await allowAdhocCuttingEntry();
```

Add `allowAdhoc` to the render locals object (keep all existing keys: user, roles, users, dashboards, existingTables, auditLogs):

```js
    res.render('admin', {
      user: req.session.user,
      roles,
      users,
      dashboards,
      existingTables,
      auditLogs,
      allowAdhoc,
    });
```

- [ ] **Step 3: Add the POST /admin/settings route**

Add this route in `routes/adminRoutes.js` near the other `router.post(...)` routes:

```js
// POST /admin/settings — toggle the ad-hoc cutting entry switch
router.post('/settings', isAuthenticated, isAdmin, async (req, res) => {
  try {
    // An unchecked checkbox is not submitted, so absence => 'false'.
    const raw = req.body.allow_adhoc_cutting_entry;
    const allow = (raw === 'on' || raw === 'true') ? 'true' : 'false';
    await pool.query(
      `INSERT INTO store_settings (setting_key, setting_value)
       VALUES ('allow_adhoc_cutting_entry', ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
      [allow]
    );
    req.flash('success', `Ad-hoc cutting entry ${allow === 'true' ? 'ENABLED' : 'DISABLED'}.`);
  } catch (err) {
    console.error('Error updating ad-hoc cutting setting:', err);
    req.flash('error', 'Failed to update the cutting entry setting.');
  }
  res.redirect('/admin');
});
```

- [ ] **Step 4: Add the settings card to admin.ejs**

In `views/admin.ejs`, inside the Overview tab pane (before its closing `</div>` around line 553, after the "Existing Tables" section), add a card matching the existing admin styling:

```html
        <!-- Cutting entry setting -->
        <div class="admin-section">
          <h3 class="admin-section-title"><i class="bi bi-scissors"></i> Cutting Entry</h3>
          <form method="POST" action="/admin/settings" class="d-flex align-items-center" style="gap:12px; flex-wrap:wrap;">
            <label class="form-check-label" style="display:flex; align-items:center; gap:8px;">
              <input type="checkbox" name="allow_adhoc_cutting_entry" value="true" <%= allowAdhoc ? 'checked' : '' %>>
              Allow cutters to enter fabric types / roll numbers <strong>not in the fabric database</strong>
            </label>
            <button type="submit" class="btn btn-primary btn-sm">Save</button>
          </form>
          <p class="text-muted small mb-0" style="margin-top:6px;">
            Off (recommended): cutters can only pick existing fabric types and rolls. Currently
            <strong><%= allowAdhoc ? 'ON (ad-hoc allowed)' : 'OFF (ad-hoc blocked)' %></strong>.
          </p>
        </div>
```

(If `admin-section` / `admin-section-title` classes don't exist verbatim, match the classes used by the adjacent Users / Dashboards sections.)

- [ ] **Step 5: Verify modules load and EJS compiles**

Run:
```bash
node -e "require('./routes/adminRoutes.js'); console.log('OK')"
node -e "const ejs=require('ejs'),fs=require('fs');ejs.compile(fs.readFileSync('views/admin.ejs','utf8'),{filename:'views/admin.ejs'});console.log('admin EJS OK')"
```
Expected: `OK` and `admin EJS OK`.

- [ ] **Step 6: Commit**

```bash
git add routes/adminRoutes.js views/admin.ejs
git commit -m "feat(admin): toggle for ad-hoc cutting entry switch"
```

---

## Task 4: Enforce in create-lot (server + form)

**Files:**
- Modify: `routes/cuttingManagerRoutes.js` (GET `/dashboard` render ~179-187; POST `/create-lot` fabric-type check + roll loop ~349-383)
- Modify: `views/cuttingManagerDashboard.ejs` (`initializeAutocomplete` ~614-722, fabric init ~725, `initializeRollNoAutocomplete` ~727-774)

- [ ] **Step 1: Import the helpers in cuttingManagerRoutes.js**

At the top with the other requires, add:

```js
const { allowAdhocCuttingEntry, isKnownFabricType } = require('../utils/storeSettings');
```

- [ ] **Step 2: Pass `allowAdhoc` to the dashboard render**

In GET `/dashboard`, before the `res.render('cuttingManagerDashboard', { ... })` call, add:

```js
    const allowAdhoc = await allowAdhocCuttingEntry();
```

Add `allowAdhoc` to the render locals (keep existing keys incl. `isDenim`):

```js
      isDenim,
      allowAdhoc,
```

- [ ] **Step 3: Enforce fabric-type + roll in the create-lot POST**

In the POST `/create-lot` handler, near the start of the transaction work (after the rolls are parsed, before/at the start of the roll loop section ~line 326), add the flag read:

```js
        const allowAdhoc = await allowAdhocCuttingEntry();
```

When ad-hoc is OFF, validate the fabric type against the fabric DB. Add this just after the presence check (`if (!lot_no || !sku || !fabric_type) {...}`) — but it needs `conn`; place it after `conn` is available and before inserting the lot:

```js
        if (!allowAdhoc) {
          const [knownTypeRows] = await conn.query(
            'SELECT DISTINCT fabric_type FROM fabric_invoices WHERE fabric_type IS NOT NULL'
          );
          if (!isKnownFabricType(fabric_type, knownTypeRows.map((r) => r.fabric_type))) {
            throw new Error(`Fabric type "${fabric_type}" is not in the fabric database. Ad-hoc entry is disabled.`);
          }
        }
```

In the roll loop, the `else` branch (the ad-hoc path, ~line 372) must reject when OFF. Change the start of that `else` block to:

```js
            } else {
              if (!allowAdhoc) {
                throw new Error(`Roll ${r.roll_no} is not in fabric inventory. Ad-hoc entry is disabled.`);
              }
              if (isNaN(r.full_weight) || isNaN(r.remaining_weight)) {
                throw new Error(`Full and remaining weights are required for roll ${r.roll_no}`);
              }
              // ...rest of existing ad-hoc branch unchanged...
```

(The handler already wraps this in a try/catch that rolls back the transaction and flashes `err.message`; throwing is the established pattern here.)

- [ ] **Step 4: Make the form pickers strict when OFF (view JS)**

In `views/cuttingManagerDashboard.ejs`, near the top of the main inline `<script>` (where `IS_DENIM`/`FLOW_MODE` are defined), add:

```js
  const ALLOW_ADHOC = <%= allowAdhoc ? 'true' : 'false' %>;
```

Add a `strict` parameter to `initializeAutocomplete(inputField, hiddenField, optionsContainer, data, strict)`. In its no-match handling (the place it currently copies typed text into `hiddenField` when there's no matching option, ~line 681) and its blur fallback (~lines 698-704), gate the free-text copy on `!strict`. When `strict` and there is no matching option:
- set `hiddenField.value = ''`,
- add the `is-invalid` class to `inputField` (and remove it once a valid option is chosen).

So the matched path stays the same; only the unmatched free-text fallback is suppressed under `strict`.

Update the fabric-type init call (~line 725) to pass `!ALLOW_ADHOC` as `strict`:

```js
  initializeAutocomplete(fabricTypeSearch, fabricTypeSel, fabricTypeOptions,
    fabricTypes.map(ft => ({ displayText: ft, value: ft })), !ALLOW_ADHOC);
```

Update the roll autocomplete init inside `initializeRollNoAutocomplete` (~line 732 where it calls `initializeAutocomplete(rollNoSearch, ...)`) to also pass `!ALLOW_ADHOC` as `strict`.

In the roll-select change handler (~lines 739-754): when `!ALLOW_ADHOC` and the selected value is NOT found in `availableRolls`, treat it as invalid — clear `rollNoSel.value`, keep `fullWeightInput` read-only and empty, and add `is-invalid` to the roll search input. When `ALLOW_ADHOC`, keep today's behavior (unknown roll → `fullWeightInput.readOnly = false` for manual entry).

- [ ] **Step 5: Verify**

Run:
```bash
node -e "require('./routes/cuttingManagerRoutes.js'); console.log('OK')"
node -e "const ejs=require('ejs'),fs=require('fs');ejs.compile(fs.readFileSync('views/cuttingManagerDashboard.ejs','utf8'),{filename:'views/cuttingManagerDashboard.ejs'});console.log('EJS OK')"
```
Expected: `OK` and `EJS OK`.

- [ ] **Step 6: Manual check**

`npm start`, log in as a cutting manager with the switch OFF (default): typing a fabric type or roll not in the DB does not stick (field flags invalid / clears), full weight can't be hand-entered for unknown rolls; submitting an ad-hoc value via direct POST is rejected with the flash error. Toggle ON via `/admin`: ad-hoc entry works as before.

- [ ] **Step 7: Commit**

```bash
git add routes/cuttingManagerRoutes.js views/cuttingManagerDashboard.ejs
git commit -m "feat(cutting): enforce ad-hoc switch in create-lot (strict pickers + server validation)"
```

---

## Task 5: Enforce in add-missed-roll (server + edit-form)

**Files:**
- Modify: `routes/editcuttinglots.js` (edit-form GET render of the add-roll HTML; add-roll POST inventory block ~809-832)

- [ ] **Step 1: Import the helper**

At the top of `routes/editcuttinglots.js` with the other requires, add:

```js
const { allowAdhocCuttingEntry } = require('../utils/storeSettings');
```

- [ ] **Step 2: Reject unknown roll in the add-roll POST when OFF**

In the add-roll POST handler, after the inventory lookup (`const [[inv]] = await conn.query(...)` ~line 809-816), the code currently treats "not found" as ad-hoc (no else). Add the read and a guard. Just before that lookup, add:

```js
    const allowAdhoc = await allowAdhocCuttingEntry();
```

After the `if (inv) { ...deplete... }` block (~line 831), add an else-if:

```js
    if (inv) {
      // ...existing deplete logic unchanged...
    } else if (!allowAdhoc) {
      throw new Error(`Roll ${roll_no} is not in fabric inventory. Ad-hoc entry is disabled.`);
    }
```

(The handler's catch returns `res.json({ success:false, error: err.message })` and rolls back — matching its existing error pattern.)

- [ ] **Step 3: Strict roll picker in the edit-form**

In the edit-form GET handler that renders the add-roll HTML string, add near where `isDenim` is computed:

```js
          const allowAdhoc = await allowAdhocCuttingEntry();
```

Inject it into the inline script alongside `IS_DENIM`/`ROLL_INVENTORY`:

```js
          const ALLOW_ADHOC = ${allowAdhoc ? 'true' : 'false'};
```

In the add-roll click handler / validation, when `!ALLOW_ADHOC`, require the typed roll to exist in `ROLL_INVENTORY`; if it doesn't, show the existing error UI (`showErr('Roll is not in fabric inventory; ad-hoc entry is disabled.')`) and do not submit. When `ALLOW_ADHOC`, keep today's behavior.

- [ ] **Step 4: Verify**

Run: `node -e "require('./routes/editcuttinglots.js'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add routes/editcuttinglots.js
git commit -m "feat(cutting): enforce ad-hoc switch in add-missed-roll (server + edit-form)"
```

---

## Task 6: Enforce fabric type in bulk upload when OFF

**Files:**
- Modify: `routes/bulkUploadRoutes.js` (lot loop, before the lot INSERT ~194-198)

- [ ] **Step 1: Import the helpers**

At the top of `routes/bulkUploadRoutes.js` with the other requires, add:

```js
const { allowAdhocCuttingEntry, isKnownFabricType } = require('../utils/storeSettings');
```

- [ ] **Step 2: Load the flag + known types once, before processing lots**

In the upload-lots POST handler, before the loop that inserts lots (and inside the transaction where `conn` exists), add:

```js
    const allowAdhoc = await allowAdhocCuttingEntry();
    let knownFabricTypes = [];
    if (!allowAdhoc) {
      const [knownTypeRows] = await conn.query(
        'SELECT DISTINCT fabric_type FROM fabric_invoices WHERE fabric_type IS NOT NULL'
      );
      knownFabricTypes = knownTypeRows.map((r) => r.fabric_type);
    }
```

- [ ] **Step 3: Validate each lot's fabric type when OFF**

Immediately before the lot `INSERT INTO cutting_lots ...` (~line 194), add:

```js
      if (!allowAdhoc && !isKnownFabricType(lot.fabric_type, knownFabricTypes)) {
        throw new Error(`Fabric type "${lot.fabric_type}" for lot ${lot.lot_no} is not in the fabric database. Ad-hoc entry is disabled.`);
      }
```

(Rolls are already rejected when unknown — unchanged. The handler's catch rolls back and reports the error.)

- [ ] **Step 4: Verify**

Run: `node -e "require('./routes/bulkUploadRoutes.js'); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add routes/bulkUploadRoutes.js
git commit -m "feat(cutting): bulk upload rejects unknown fabric type when ad-hoc switch is off"
```

---

## Final verification

- [ ] **Run the full unit suite**

Run: `npm test`
Expected: all pass (cuttingWeight 7 + fabricConsumption 4 + storeSettings 2 = 13).

- [ ] **All touched route modules load**

```bash
node -e "require('./routes/adminRoutes.js');require('./routes/cuttingManagerRoutes.js');require('./routes/editcuttinglots.js');require('./routes/bulkUploadRoutes.js');require('./utils/storeSettings.js');console.log('all OK')"
```
Expected: `all OK`.

- [ ] **All touched views compile**

```bash
node -e "const ejs=require('ejs'),fs=require('fs');['views/admin.ejs','views/cuttingManagerDashboard.ejs'].forEach(f=>{ejs.compile(fs.readFileSync(f,'utf8'),{filename:f});console.log(f,'OK')})"
```
Expected: both `OK`.

---

## Self-Review notes (plan author)

- **Spec coverage:** storage/default + fail-safe (Task 1, helper defaults to false; Task 2 seed). Admin toggle (Task 3). Create-lot UI+server (Task 4). Add-missed-roll UI+server (Task 5). Bulk fabric-type check, rolls already strict (Task 6). Known-value sources = `fabric_invoices.fabric_type` / `fabric_invoice_rolls` (Tasks 4-6). Defence-in-depth (server is source of truth) in every entry point. Non-goals (no migration of old data) respected — no data backfill task.
- **DRY note:** an existing `getStoreSetting` lives privately in `routes/indentRoutes.js`; this plan adds a shared `utils/storeSettings.js` for the new code and intentionally does NOT refactor indentRoutes (out of scope, avoid unrelated churn).
- **Type/name consistency:** `allowAdhocCuttingEntry()` (async→bool), `isKnownFabricType(type, knownTypes)`, `resolveAllowAdhoc(value)`, view flag `ALLOW_ADHOC`, render local `allowAdhoc`, setting key `allow_adhoc_cutting_entry` — used identically across Tasks 1/3/4/5/6.
- **Executor confirmations (verify against live code, don't assume):** exact admin.ejs section classes; the precise lines of `initializeAutocomplete`'s free-text fallback to gate on `strict`; that the create-lot and add-roll handlers' catch blocks flash/JSON the thrown `err.message` (they do per current code); the add-roll edit-form's existing `showErr` helper + `ROLL_INVENTORY` variable names.
