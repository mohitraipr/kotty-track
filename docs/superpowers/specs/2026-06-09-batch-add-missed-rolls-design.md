# Batch "Add Missed Rolls" on Edit Cutting Lots

**Date:** 2026-06-09
**Page:** `/operator/editcuttinglots` → Edit lot → Sizes & Rolls tab → "Add a missed roll"

## Context

The "Add a missed roll" feature currently adds **one** roll at a time. After a successful add it re-fetches and re-renders the whole edit-form modal, which also bounces the operator back to the first tab ("Lot Details"). When an operator needs to add several missed rolls to a lot, this is tedious: fill → add → full reload → re-navigate to Sizes & Rolls → scroll down → repeat.

This spec replaces the single-row add UI with a **multi-row batch entry** form: the operator stacks several roll rows and submits them all at once, committed **all-or-nothing** in a single DB transaction.

The backend single-roll endpoint (`POST /editcuttinglots/add-roll`, [routes/editcuttinglots.js:781-894](../../../routes/editcuttinglots.js#L781-L894)) is already correct and handles inventory depletion, duplicate guarding, and totals recompute. This feature generalizes that logic to a batch.

**Note on a prior bug:** the add-roll client wiring must live in the parent page's `attachFormListeners()` in `views/editcuttinglots.ejs`, NOT in a `<script>` inside the server-rendered fragment — fragments are injected via `innerHTML`, and browsers never execute `<script>` tags inserted that way. The fragment passes data through an inert `<script type="application/json" id="addRollConfig">` block. This design preserves that pattern.

## Goals

- Operator can enter N roll rows and add them in one action.
- All-or-nothing commit: if any row is invalid, nothing is saved; the error names the offending row/roll; typed rows remain on screen to fix and resubmit.
- Per-row weight computation matches existing rules (denim vs hosiery).
- Inventory depletion, duplicate guarding, and piece-total recompute remain correct.

## Non-Goals

- No change to the normal "Update Lot" submit flow.
- No change to the single-roll `add-roll` endpoint (left in place, unused by the UI after this change — kept to minimize risk).
- No bulk paste/import; rows are entered one at a time via "+ Add another row".

## Design

### 1. UI — edit-form fragment (`routes/editcuttinglots.js`, the `add a missed roll` block ~lines 411-460)

Replace the single static input row with a **row repeater**:

- A container `#addRollRows` holding one or more roll rows. Each row carries the same fields as today:
  - **Roll Number** — text input with the shared `<datalist id="addRollNoOptions">` (autocomplete from inventory for the lot's `fabric_type`).
  - **Layers** — number.
  - **Full Weight** — number (auto-filled + locked when the roll is found in inventory).
  - **Weight Used** — readonly, auto-computed.
  - **Remaining** — readonly for denim (auto), editable default 0 for hosiery.
  - **✕ Remove** button (hidden/disabled when only one row remains).
  - A per-row availability hint element (the `addRollAvail` equivalent).
- A hidden **row template** (e.g. a `<template id="addRollRowTemplate">` or a JS-built string) used to clone new rows.
- **"+ Add another row"** button (`#addRollAddRow`).
- One **"Add N rolls to lot"** submit button (`#addRollBtn`), disabled for denim lots missing `table_length` (same guard as today).
- A shared error area `#addRollError`.

The inert `#addRollConfig` JSON block (rollInventory, isDenim, allowAdhoc, tableLength, managerId, lotId) stays as-is.

### 2. Frontend wiring — `views/editcuttinglots.ejs`, inside `attachFormListeners()`

Extend the existing `wireAddRoll()` block (added when the single-roll bug was fixed):

- Read `#addRollConfig` once (rollInventory, isDenim, allowAdhoc, tableLength).
- `attachRowListeners(row)` — wires one row's listeners:
  - Roll-number `change`: look up inventory; if found, set+lock Full Weight and show "Available in inventory: …"; else unlock + "New roll (manual entry…)"; then recompute that row.
  - `recomputeRowWeights(row)`: denim → `used = tableLength × layers`, `remaining = full − used`; hosiery → `used = full − remaining`. Toggle `text-danger` when `used > full`. (Same math as the current `recomputeAddRollWeights`, scoped to the row.)
  - Full Weight `input` always recomputes; Layers (denim) or Remaining (hosiery) `input` recomputes.
- `#addRollAddRow` click: clone the template, append to `#addRollRows`, call `attachRowListeners` on the new row, focus its Roll Number field, show Remove buttons.
- ✕ Remove click: remove that row (guard: never remove the last remaining row).
- `#addRollBtn` click:
  1. Collect all rows; skip fully-empty rows.
  2. Client-side validate each non-empty row (roll# present; if `!allowAdhoc`, roll must be in inventory; layers > 0; full > 0; used ≥ 0; used ≤ full). On failure, show "Row K: …" and abort.
  3. Client-side duplicate check across rows (same roll_no twice) → "Row K duplicates row J (roll …)".
  4. POST `FormData` with parallel arrays `roll_no[]`, `layers[]`, `full_weight[]`, `weight_used[]` to `/operator/editcuttinglots/add-rolls?managerId=…&lotId=…`.
  5. On `{success:true}`: alert "Added N rolls. Total pieces is now …", then `loadEditForm(managerId, lotId)` once.
  6. On `{success:false}`: `showErr(data.error)`; leave rows on screen.

### 3. Backend — new `POST /editcuttinglots/add-rolls` (plural)

Mirrors the single `add-roll` logic, looped inside ONE transaction:

- Parse arrays (normalize single values to length-1 arrays, like the `update` handler does).
- Open transaction; `SELECT … FOR UPDATE` the lot (confirm `user_id = managerId`); load `fabric_type`, `table_length`.
- Load `allowAdhoc` once.
- Build a `Set` of existing roll_nos in the lot (one query) for duplicate detection, plus an in-batch `Set` to catch duplicates within the submission.
- For each row:
  - Validate `layers > 0`, `full_weight > 0`, `weight_used ≥ 0`, `weight_used ≤ full_weight` → else `throw` naming the row.
  - Duplicate (existing lot or earlier in batch) → throw.
  - Inventory lookup (`fabric_invoice_rolls` JOIN `fabric_invoices` on `fabric_type` FOR UPDATE). If found: `resolvedFullWeight = per_roll_weight`, guard `weight_used ≤ available`, deplete with `UPDATE … WHERE roll_no=? AND per_roll_weight >= ?` (throw if `affectedRows === 0`). If not found and `!allowAdhoc` → throw.
  - `remaining_weight = max(resolvedFullWeight − weight_used, 0)`.
  - Add roll_no to the in-batch and existing sets.
  - Stage the INSERT values.
- Compute `sumPatterns` once; each row's `total_pieces = layers × sumPatterns`.
- Bulk INSERT all rows into `cutting_lot_rolls`.
- Increment each size: `UPDATE cutting_lot_sizes SET total_pieces = total_pieces + (pattern_count * ?)` with the **sum of all batched layers**, in one statement.
- Recompute lot total = `SUM(cutting_lot_sizes.total_pieces)`; update `cutting_lots.total_pieces`.
- `COMMIT`; return `{ success, added: N, total_pieces, sum_layers, sum_patterns }`.
- Any throw → `ROLLBACK`, return `{ success:false, error }`.

Use `upload.none()` middleware (FormData parsing), consistent with the other endpoints.

## Error Handling

All-or-nothing. The first invalid row aborts the whole transaction; the error message identifies the row (1-based index) and roll number. The client keeps all typed rows so the operator corrects the flagged row and resubmits.

## Testing / Verification

Run locally (`npm start`), open the page, edit a lot, Sizes & Rolls tab:

1. **1-row parity:** add a single roll → behaves like before (row appears, totals bump).
2. **N rows:** add 3 rolls in one submit → all appear, inventory depleted for each, lot/size totals correct.
3. **Duplicate in batch:** two rows same roll# → rejected, nothing saved.
4. **Duplicate vs existing:** a row whose roll# already exists in the lot → rejected.
5. **Over-inventory:** a row with weight_used > available → rejected, error names the row, nothing saved.
6. **Denim math:** Weight Used = table_length × layers per row, Remaining auto.
7. **Hosiery math:** enter Remaining, Weight Used = full − remaining.
8. **DB checks:** new `cutting_lot_rolls` rows present; `fabric_invoice_rolls.per_roll_weight` depleted; `cutting_lots.total_pieces` and per-size totals consistent.
9. **Regression:** normal "Update Lot" submit still fires once and saves size/layer edits.
