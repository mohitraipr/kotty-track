# Kotty-Track — Progress & Roadmap Tracker

> Master index. Each initiative has its own detailed plan file in this folder.
> Update the **Status** and **Last touched** columns as work lands. Anyone picking
> this up should read this file first, then the relevant `NN-*.md` plan.

_Last updated: 2026-07-03_

---

## Plan files in this folder
| File | What it covers |
|------|----------------|
| `00-PROGRESS.md` | This tracker. |
| `01-qcpass-extension.md` | Authenticated ingestion of the QC-Capture Chrome extension into the kotty-track DB, restricted to the `jitrgp` role, with the realtime-vs-queue design. |
| `02-cutting-planning-bugs.md` | The cutting-planning correctness backlog (audit findings), one by one. |
| `03-ejs-to-react-migration.md` | Effort + benefits + incremental approach for moving the EJS frontend to React. |
| `04-frontend-best-practices.md` | Frontend issues measured against best practice, with fixes. |
| `05-architecture-testing-security.md` | Split into separate backend/React projects, full test coverage (backend+frontend), security testing + server/DB hardening, stress/load testing. |

---

## A. Recently shipped (context for whoever continues)

All merged to `main` unless noted. These fixed the production-manager (PM) data feed and reports.

| PR | What |
|----|------|
| #473 | Mini-sales freeze fix — single adaptive-window report + resilient polling. |
| #474 | 429-as-transient in mini-sales; freshness indicator. |
| #475 | Aging feed: parallelize warehouses, honest status, dedicated deadline (later superseded — see below). |
| #476 | In-production **size-PIC report** download on the PM style page; extracted shared `utils/picSizeReport.js` from `routes/operatorRoutes.js`. |
| #477 | Scoped that download to the current style. |
| #478 | Cloud Run **2Gi + min-instances=1** (durable, in `cloudbuild.yaml`) — stopped OOM + stabilized the EasyEcom auth token → un-froze the feed. |
| #479 | PIC reports reworked: per-stage **In=approved / Out=completed / In-line=WIP / Pending=handoff** (was In=previous-stage-completed). |
| #480 | Renamed those download columns to "Approved / Completed". |
| #481 | Removed **aging** from the freshness banner (it only powers Dead Stock, which has a fallback). |
| #482 | Stopped pulling `INVENTORY_AGING_REPORT` nightly — it has **never** returned data (EasyEcom won't generate it for our two secondary warehouses); reclaims ~20 min/run. |

### Data repairs done directly on prod (uncommitted scripts, backups kept)
- Stage-qty corruption repair (37 lots).
- **Orphan-approve dedup**: deleted 329 duplicate `AUTO_APPROVE_ORPHAN` approve events across 328 lots (241,810 phantom pieces). 9 lots flagged for manual review (benign 0-piece pairs + `ak4972`).

### Verified healthy (2026-07-03, read-only vs prod)
- Feed fresh: orders/DRR, stock, mini_sales, snapshot all refreshed 03 Jul 04:07.
- `getCuttingRecommendations`: 26,244 size-SKU rows in 5.2 s; recommendations sane.

---

## B. Open initiatives

| # | Initiative | Status | Plan | Priority |
|---|-----------|--------|------|----------|
| 1 | QC-Capture extension → authenticated DB ingestion (`jitrgp`) | **Not started** | `01-qcpass-extension.md` | High (new feature the user is adding) |
| 2 | Cutting-planning correctness bugs | **Not started** | `02-cutting-planning-bugs.md` | High — one bug hides 107 "cut-soon" styles |
| 3 | EJS → React migration | **Analysis only** | `03-ejs-to-react-migration.md` | Medium — decision pending |
| 4 | Frontend best-practices cleanup | **Not started** | `04-frontend-best-practices.md` | Medium |

---

## C. Cutting-planning bug backlog — quick status (details in `02`)
| ID | Bug / gap | Severity | Status (updated 2026-07-10) |
|----|-----------|----------|--------|
| CP-1 | `orange` vs `amber` trigger mismatch → 107 "cut-soon" styles shown as Covered | **High** | **DONE — PR #483** |
| CP-2 | Closed loop not wired (assign never becomes "cut") | **High (design)** | **DONE** — Start-this-lot (#498) links assignment→cutting_lot + status 'cut'; GRN pipeline (#538) closes the dispatch end |
| CP-3 | Marketplace-PO sign (`+ upcomingPoQty`) | High | **DONE** — business confirmed POs are OUTBOUND DEMAND; `+` is correct; semantics locked in a code comment (easyecomAnalytics) |
| CP-4 | No transaction in `POST /api/cut-plan/assign` (per-lot mode) | Medium | **DONE** — per-lot assign refactor (#507) wrapped all inserts in one transaction |
| CP-5 | Style-scope lead-times ignored (only `scope='sku'` loaded) | Medium | Open |
| CP-6 | CAD size vocabulary not unified (no 5XL/6XL/numeric) | Medium | Open |
| CP-7 | `deriveStyle` over-strip (base ending in S/M/L/XL) | Medium | Open |
| CP-8 | Leftover `GET /pm/debug-ee` endpoint | Low | **DONE** — endpoint no longer exists |
| CP-9 | Redundant heavy recompute in assign path | Low | Open |
| CP-10 | Resolver gap: unresolved in-flight counted, not netted → over-cut | Medium | Open — `pm_sku_resolution` still EMPTY; upload the two PREFILLED sheets via /pm/resolver/upload-*; note the GRN pipeline (#538) has its own concat-verified fallback |
| *(new)* | Duplicate size-label rows: netting double-subtracted dispatches; displays/validations under-counted | High | **DONE — PRs #541/#542** (2026-07-10) |

## D. Known environment facts (so nobody re-discovers them)
- Prod = GCP `kotty-track-prod`, Cloud Run, deploys from `main` via `cloudbuild.yaml` (2Gi, min-instances=1, timeout 3600).
- Sessions use **in-process MemoryStore** (not shared across instances, lost on restart) — relevant to the extension auth choice.
- No token/JWT/API-key auth exists; the only header-secret path is `POST /internal/run-pull` (`x-cron-secret` vs `PM_CRON_SECRET`).
- Env changes on Cloud Run must use `--update-env-vars` (never `--set/--clear`).
- Read-only prod inspection: cloud-sql-proxy → `127.0.0.1:3306`, creds from Secret Manager `db-password`.
