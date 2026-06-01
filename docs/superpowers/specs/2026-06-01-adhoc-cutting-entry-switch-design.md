# Design: Admin switch for ad-hoc fabric type / roll entry in cutting

Date: 2026-06-01
Status: Approved (ready for implementation plan)

## Summary

Add a global, admin-controlled on/off switch that governs whether cutters may
enter **fabric types and roll numbers that are not in the fabric database**
("ad-hoc" entries). **Default: OFF** (ad-hoc entry blocked). The rule is enforced
both in the UI and on the server, across all three cutting entry points.

Today the system effectively behaves as "ON": the create-lot form, the
add-missed-roll form, and (for fabric type only) bulk upload all accept free-text
/ ad-hoc values. This feature makes OFF the default and gives an admin a toggle.

## Storage & default

- One row in the existing `store_settings` (key/value) table:
  `allow_adhoc_cutting_entry = 'false'`.
- A helper `getSetting(key, defaultValue)` reads `store_settings`, returning the
  default when the row is absent. The ad-hoc helper resolves to a boolean and is
  **fail-safe**: missing/invalid → treated as `false` (locked down).
- Seeded via a migration that `INSERT IGNORE`s the row as `'false'`.

## Admin toggle

- A "Cutting entry" settings card on the existing `/admin` dashboard
  (`isAuthenticated` + `isAdmin`) with an on/off control.
- New `POST /admin/settings` route (admin-only) that upserts the
  `allow_adhoc_cutting_entry` row to `'true'`/`'false'`, then redirects back to
  `/admin` with a flash confirmation.
- Label: "Allow cutters to enter fabric types / roll numbers not in the fabric
  database." Helper text notes OFF is the safe default.

## Known-value sources

- Known **fabric types**: `SELECT DISTINCT fabric_type FROM fabric_invoices WHERE fabric_type IS NOT NULL`.
- Known **rolls**: `roll_no` present in `fabric_invoice_rolls`.

## Enforcement (defence in depth: UI + server)

For every entry point, the UI restriction is convenience only; the **server
validation is the source of truth** (the API can be called directly).

### Create-lot form (`views/cuttingManagerDashboard.ejs` + `routes/cuttingManagerRoutes.js`)
- **UI when OFF:** the fabric-type and roll search boxes become strict pickers —
  the free-text fallback in `initializeAutocomplete` (which copies typed text into
  the hidden field on no-match / on blur) is suppressed, so a non-matching value
  cannot be submitted. The "unknown roll → enter your own full weight" path is
  disabled (full weight stays sourced from inventory only).
- **Server when OFF:** reject the request if `fabric_type` is not a known type, or
  if any `roll_no` is not in `fabric_invoice_rolls`. Clear flash error naming the
  offending value; no partial insert (existing transaction rolls back).
- The view receives an `allowAdhoc` boolean (passed from the GET handler) to drive
  the UI mode.

### Add-missed-roll form (`routes/editcuttinglots.js`)
- **UI when OFF:** the roll picker in the edit-form is strict (no free-text roll).
- **Server when OFF:** the add-roll POST rejects a `roll_no` not in
  `fabric_invoice_rolls` (today it silently accepts and treats it as ad-hoc).
- Fabric type is inherited from the existing lot here, so only the roll is gated.

### Bulk upload (`routes/bulkUploadRoutes.js`)
- Rolls: bulk **already** rejects unknown rolls and has no mechanism to supply an
  ad-hoc roll's full weight via Excel, so **bulk rolls remain DB-only regardless of
  the switch**. (Documented nuance — accepted by the user.)
- **Server when OFF:** add a fabric-type-must-be-known check (today bulk accepts
  any fabric type as free text). When ON, fabric type stays free-text as today.

## When ON

Exactly today's behavior: free-text fabric types and ad-hoc rolls in the create
and add-roll forms; free-text fabric type in bulk. No other change.

## Non-goals / edges

- Existing lots and previously-entered ad-hoc data are untouched; the switch
  governs new entries only.
- The Fabric Consumption "Unknown / Ad-hoc" tab keeps working; with the switch
  OFF, that list simply stops growing.
- No per-user or per-role granularity (explicitly global).
- The setting is read per request (single-row lookup); no caching layer needed.

## Testing

- Unit-test the `allow_adhoc_cutting_entry` resolution helper (string `'true'`/
  `'false'`/missing/garbage → correct boolean, default false) with `node:test`.
- Unit-test pure validators: `isKnownFabricType(type, knownTypes)` and
  `isKnownRoll(rollNo, knownRollNos)` (case/whitespace handling), with `node:test`.
- Manual: toggle in admin; confirm create/add-roll/bulk block ad-hoc when OFF and
  allow when ON; confirm server rejects ad-hoc via direct POST when OFF.
