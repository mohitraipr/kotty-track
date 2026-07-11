# Kotty Track

Production tracking and operations system for **Kotty** (garment/denim manufacturing).
Node.js + Express + EJS, MySQL (Cloud SQL), deployed on **Google Cloud Run** from `main`
via Cloud Build. React/Vite islands for newer surfaces (`/tasks`, `/qc`).

> New here? Read **`docs/plans/00-PROGRESS.md`** first — it is the living map:
> what shipped, what's open, invariants, and a successor orientation.

## What the system does

- **Event-sourced production pipeline** — cutting → stitching → (jeans assembly →
  washing → washing-in, denim only) → finishing. Truth lives in append-only
  `{stage}_events` + `{stage}_event_sizes`; every stage take-in pays the upstream
  worker via `stage_payments`. Nothing stores a "current stage" — everything derives.
- **Floor screens** ("Kotty Floor" design system) — mobile-first lot screens for each
  stage master (type-first quantity grids, stage-rail journey, per-size take / reject /
  rewash / complete / dispatch), plus a desktop-first **operator hub** (`/operator/hub`)
  that is the operator's dashboard: KPIs, SKU insights, feature search, and every tool
  as a card — including **System Health** (uptime & service checks), **Documentation**
  (every URL & feature mapped), **Usage Analytics**, and **Security Logs**.
- **Lot Admin** — guarded operator interventions: denim/hosiery flow change, stage
  reversal (payment-safe), size-wise quantity edits; all audited in `pm_lot_audit_log`.
- **Production planning** (`/pm`) — DRR/SOH/DOH cutting suggestions fed hourly from
  EasyEcom (orders, inventory snapshots, reports); cut-plan assignment → "Start this
  lot" pre-filled cutting entry; CAD-based fabric/marker prediction.
- **EasyEcom dispatch→PO pipeline** (`/finishingdashboard/ee-po`) — finishing dispatches
  to the warehouse become **Purchase Orders** in EasyEcom (challan-backed); the warehouse
  GRNs them manually on physical receipt; the screen confirms batches automatically.
  **No code path ever writes EasyEcom inventory.** Blocked SKUs are resolved inline from
  a verified dropdown (mappings persist to `pm_sku_resolution` and feed planning).
  Design + live-tested API quirks: `docs/EASYECOM_DISPATCH_GRN_DESIGN.md`.
- **QC Capture** — Chrome extension (Myntra returns console) ingesting QC data with
  token auth; dashboard at `/qc`.
- **Employee ops** — supervisors, attendance, salaries, advances; store inventory;
  returns/challans; PO management.

## Architecture notes

- **Roles** drive everything: each role lands on its own dashboard after login
  (`routes/authRoutes.js`); route gates (`middlewares/auth.js`) are per-role. When
  adding links/navigation, check the destination's gate against the screen's audience.
- **Sessions** are MySQL-backed (`express-mysql-session`, `sessions` table) — shared
  across instances, survive deploys.
- **Design system**: stage screens use scoped `.sx-*` styles + `flx-top` chrome; the hub
  uses Tailwind partials (`views/partials/floorHead/floorNav.ejs`); ~16 header-based
  screens use `views/partials/floorTokens.ejs`. Tokens: indigo `#2563eb`, quiet white
  cards, Space Grotesk numbers + Inter.
- **EasyEcom auth**: account-level `X-API-Key` on every call; location scoping via JWT
  minted with a `location_key` (`/access/token`). Faridabad is the PO pipeline context.

## Development

```bash
npm install
npm test               # node --test (fast, no DB needed for most suites)
node app.js            # local (uses secure-env encrypted .env.enc)
```

- Views verify: render with route-accurate locals + parse every inline script.
- Frontend islands: `cd frontend && npm run build && npm run build:qc` (CI enforces this).

## Deployment & operations

- **Deploys**: merge to `main` → Cloud Build (global region) → Cloud Run
  `kotty-track` (project `kotty-track-prod`, asia-south1, 2Gi, min-instances 1).
- **Env changes**: ONLY `gcloud run services update --update-env-vars` /
  `--update-secrets`. Never `--set-*` or `--clear-*` (they wipe everything else).
- **Feature flags**: `EE_GRN_PUSH` (PO pipeline push), `EE_PO_SINCE` (dispatch sweep
  cutoff, default 2026-07-11), `PM_CLOSED_LOOP`, `PM_PULL_ENABLED`.
- **Read-only prod inspection**: `cloud-sql-proxy --port 3307
  kotty-track-prod:asia-south1:kotty-mysql`, user `kotty_user`, db `kotty_db`,
  password from Secret Manager `db-password`. Run node from the repo root.

## Do-not-break invariants

1. The event ledger is append-only truth; corrections go through Lot Admin (audited).
2. Nothing writes EasyEcom inventory via API — POs only; the warehouse GRNs.
3. Stage screens' payload code is payment-critical: UI changes must leave
   `doTake*` / `doMarkDone*` / `/event/*` payloads byte-identical.
4. Env via `--update-env-vars` only.

## Key documentation

| Doc | What |
|---|---|
| `docs/plans/00-PROGRESS.md` | **Start here** — living tracker + successor orientation |
| `docs/plans/01–05` | QC extension · cutting-planning backlog · React migration · frontend best-practices · architecture/testing/security programs |
| `docs/EASYECOM_DISPATCH_GRN_DESIGN.md` | The dispatch→PO pipeline (read before touching EasyEcom) |
| `docs/FLOOR_REDESIGN_HANDOFF.md` | Floor design system rationale |
| `docs/PM_CUTTING_PLANNING_HANDOFF.md` | Production-planning data pipeline |
