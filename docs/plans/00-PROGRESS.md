# Kotty-Track — Progress & Roadmap Tracker

> Master index. Each initiative has its own detailed plan file in this folder.
> Anyone picking this up: read this file first, then the relevant `NN-*.md` plan.

_Last updated: **2026-07-10** (major refresh — the previous owner's final week; everything
below was verified against code and prod, not copied forward)._

---

## Plan files in this folder
| File | What it covers | Status |
|------|----------------|--------|
| `00-PROGRESS.md` | This tracker + successor orientation. | — |
| `01-qcpass-extension.md` | QC-Capture Chrome extension → DB ingestion. | **SHIPPED** (PRs #483–#494); one open item: live test of Myntra auto-pass |
| `02-cutting-planning-bugs.md` | Cutting-planning correctness backlog. | CP-1/2/3/4/8 done; CP-5/6/7/9 open (code); CP-10 open (data task) |
| `03-ejs-to-react-migration.md` | EJS → React analysis. | Analysis done; decision pending. `/tasks` + `/qc` are the first React islands |
| `04-frontend-best-practices.md` | Frontend vs best practice. | FE-2/3/5/6 **DONE** (#539/#540); FE-1/4/7–10 open |
| `05-architecture-testing-security.md` | Split architecture / tests / security / load. | Not started — successor program |

Related design docs (repo `docs/`):
- `EASYECOM_DISPATCH_GRN_DESIGN.md` — the dispatch→PO pipeline (live). **Read before touching anything EasyEcom.**
- `FLOOR_REDESIGN_HANDOFF.md` — the floor design system (now implemented; keep for the design rationale).
- `PM_CUTTING_PLANNING_HANDOFF.md` — the production-planning data pipeline.

---

## A. What shipped in the final week (2026-07-07 → 07-10) — the map git can't give you

### 1. Floor redesign — every operator/master screen (PRs #515–#534)
All ~45 floor screens now share one design system (indigo `#2563eb`, quiet white cards,
Space Grotesk numbers + Inter, status colours only for status).
- **The operator hub IS the operator dashboard** (`/operator/hub`; `/operator/dashboard`
  redirects to it; login lands operators there). Desktop-first, live feature search,
  KPIs, SKU insights, Account Usage (mohitoperator-only). `views/operatorDashboard.ejs`
  was deleted.
- **5 stage lot screens** (`stitchingEvents.ejs` + 4 near-identical siblings): standalone
  chrome (no shared navbar), body search, stage-rail journey, **type-first quantity grids**
  (Size | Avail | Take | Reject — tap-to-type, no ± hunting), one bottom CTA per card
  (take = blue, done = green). The take/complete/payment engine was NEVER rewritten — every
  redesign pass was verified byte-identical on payload code.
- **Shared pieces:** `views/partials/floorHead.ejs` + `floorNav.ejs` (Tailwind shell, hub
  only), `views/partials/floorTokens.ejs` (style-only token override used by ~16 header-based
  screens), per-screen `flx-top` chrome on the stage/master screens.
- **Audience rule** (learned the hard way, PR #534): never add a link/nav without checking
  the destination's role gate against the screen's audience. Stage screens are used by
  MASTERS; most `/operator/*` routes are operator-only.
- Cutting screens intentionally untouched (owner's decision).

### 2. EasyEcom dispatch→PO pipeline — LIVE (PR #538, flag ON since 2026-07-10)
Finishing dispatches (destination = Warehouse) → swept into batches on
`/finishingdashboard/ee-po` (finishing role) → operator pushes → **a Purchase Order is
created in EasyEcom** (vendor "Kotty Production", code V002, vendor_c_id 289541) → the
**warehouse GRNs it manually in the EasyEcom UI** on physical receipt → the screen's
"Check for warehouse GRNs" (getGrnDetails.po_id match) marks the batch confirmed.
- **No code path writes inventory. Ever.** `bulkInventoryUpdate` was explicitly rejected.
- Hard cutoff `EE_PO_SINCE=2026-07-11` — the 880 historical dispatch rows can never ride a PO.
- SKU gate: `pm_sku_resolution` map → CONCAT(style,size) **verified against the
  `ee_product_master` mirror** → else the line blocks. Never guessed.
- Idempotency: `ee_dispatch_po_lines.dispatch_id` UNIQUE + EasyEcom's own PO-quantity cap.
- API quirks (live-tested; in `utils/eeDispatchPo.js` comments): PO `vendorId` = vendor CODE
  ('V002') but GRN `vendor_id` = numeric id; `expDeliveryDate` strictly > today; bin =
  lowercase `default`; GRN-queue success `queueId` is at the TOP level; auth = account
  X-API-Key + JWT minted with the FARIDABAD location_key (`EASYECOM_LOCATION_KEY`).
- Weekly product-master sync now persists `cost`/`mrp` (PO unit-price source).
- **Watch item:** the first real batch (first Warehouse dispatch after 07-11) — verify the
  PO→GRN→confirm round-trip once, like the Phase-0 test (documented in the design doc §7–8).

### 3. Sessions moved to MySQL (PR #539)
`express-mysql-session` on the existing pool (`sessions` table, 24h TTL). Random logouts
(per-instance MemoryStore) are gone. Any old doc mentioning MemoryStore is obsolete.

### 4. Security + correctness sweeps
- XSS audit of every unescaped `<%- %>` in 194 views; real injections fixed (#540).
- `public/js/api.js` (`window.KottyApi`) — shared fetch client; 3 screens migrated, ~80 to go.
- **Duplicate size-label bug class** (#541/#542): a lot cut with several patterns of the
  same size has multiple `cutting_lot_sizes` rows per label. Everything reading those rows
  1:1 was fixed with GROUP BY/SUM (stitching availability, PM in-flight netting — which was
  double-subtracting dispatches → over-cut suggestions — size-PIC report, style page) and
  all 10 stage validations hardened from `.find()` (first-match) to summed checks.
- Search-dashboard 500 + lot-journey `?q=` fixed (#528). sku-categories page fixed (#537).

### 5. Ops facts that changed this week
- `EE_GRN_PUSH=1` is SET on the service (env). `EE_PO_SINCE` defaults in code to 2026-07-11.
- Env changes: ONLY `--update-env-vars` / `--update-secrets`. Never `--set-*`/`--clear-*`.
- Builds run in Cloud Build **global** region (`gcloud builds list` without --region);
  deploys from `main` only; the frontend islands build now fails the deploy if broken.
- The repo owner merges PRs within minutes — **never push follow-up commits to an open PR's
  branch; open a new PR per change.**

## B. Earlier context (still true, condensed)
PM data feed is healthy (orders_api-driven DRR, snapshot SOH, freshness banner). Historical
prod data repairs (stage-qty corruption, orphan-approve dedup) are documented in the git
history of this file. Payment ledger is event-sourced: `{stage}_events` +
`{stage}_event_sizes` are the truth; every stage approve pays the upstream worker via
`stage_payments`. Cutting payments stopped 2026-05-06 (pre-dates everything here; business
said leave it).

---

## C. Open work, prioritized for whoever continues

| # | Item | Where | Size |
|---|------|-------|------|
| 1 | **Verify the first real dispatch→PO→GRN round-trip** | `/finishingdashboard/ee-po` + design doc §7–8 | 1h, watch-only |
| 2 | **Upload the two PREFILLED resolver sheets** (`pm_sku_resolution` is EMPTY) | `POST /pm/resolver/upload-sizes` / `upload-styles`; files in repo root | data task |
| 3 | QC auto-pass live test on the Myntra portal | Plan 01 | 1h |
| 4 | CP-5/6/7/9 (cutting-planning math) | Plan 02 | ~1 day |
| 5 | FE-1 (externalize 132 inline scripts) → unlocks FE-4 (CSP) | Plan 04 | incremental |
| 6 | React decision (Plan 03), then absorb FE-7–10 per island | Plan 03/04 | program |
| 7 | Architecture split / test coverage / load (Plan 05) | Plan 05 | program |

## D. Successor orientation — your first week

1. **Access you need:** GCP project `kotty-track-prod` (Cloud Run svc `kotty-track`,
   region asia-south1; Cloud SQL `kotty-mysql`; Secret Manager `db-password`), the GitHub
   repo, and an EasyEcom login (creds live as env vars on the service).
2. **Inspect prod read-only:** `cloud-sql-proxy --port 3307
   kotty-track-prod:asia-south1:kotty-mysql`, then mysql2 as `kotty_user` /
   `$(gcloud secrets versions access latest --secret=db-password)`, db `kotty_db`.
   Run node from the repo root so `mysql2` resolves.
3. **Invariants — do not break:**
   - The event ledger is append-only truth. Never edit `*_events`/`*_event_sizes` casually;
     reversal/corrections go through the Lot Admin tools (audited in `pm_lot_audit_log`).
   - Nothing may write EasyEcom inventory via API. POs only; the warehouse GRNs.
   - Stage screens' payload code is payment-critical — visual work must leave
     `doTake*`/`doMarkDone*`/`/event/*` payloads byte-identical (diff-filter before merging).
   - Env via `--update-env-vars` only.
4. **How things are verified here** (keep the bar): EJS render with route-accurate locals +
   `new Function()` on every inline script; `NODE_ENV=test node --test` (167 tests);
   payment-code diffs against main; read-only prod queries for data claims.
5. **Where the bodies are buried:** `docs/plans/02` CP-10 (resolver gap),
   `pm_open_cutting_lots` bridge (currently 0 open rows), the `SCK*`-prefixed duplicate
   marketplace listings, Delhi warehouse not yet on the PO pipeline (Faridabad only).
