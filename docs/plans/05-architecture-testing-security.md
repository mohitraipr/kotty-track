# Plan 05 — Split Architecture, Test Coverage, Security & Stress Testing

_Status: Not started. Captures the cross-cutting program the user added on 2026-07-03:
"frontend and backend as different projects (React + Vite + Tailwind v4 + shadcn),
test cases for every feature (backend + frontend), migrate features one by one,
plus stress testing, security testing, and hardening server/DB access."_

This is a **multi-month program**. It runs alongside Plans 01–04 (extension, cutting bugs,
migration, FE best-practices) and reframes Plan 03's "islands inside EJS" into a clean split.

---

## 1. Split into two projects

### Target shape
- **`backend/`** — Node/Express, **JSON API only** (no EJS rendering for migrated features),
  MySQL, session **or token** auth. Owns all business logic + DB.
- **`frontend/`** — React 18 + **Vite** + **Tailwind v4** + **shadcn/Radix** SPA (the existing
  `frontend/` Tasks app is the seed — same stack, expand it into the full app).
- **`qcpass_extension/`** — stays its own MV3 project (Plan 01).

### Repo strategy (decision needed)
- **Option A — monorepo** (`/backend`, `/frontend`, `/qcpass_extension` in this repo).
  Simplest for shared CI, one PR spans API+UI, atomic feature migration. **Recommended.**
- **Option B — two repos.** Cleaner separation, but cross-cutting features need coordinated PRs
  and versioned API contracts. More overhead for a small team.

### Auth across the split (decision needed — ties to Plan 01)
Today: `express-session` + **MemoryStore** (not shared across Cloud Run instances). A separate
React SPA on its own origin makes cookies harder (CORS + sameSite). Choose ONE:
- **Session cookie + shared store** (`express-mysql-session`/Redis) + CORS `credentials` for the
  SPA origin — keeps the current model, fixes multi-instance logouts.
- **Token auth (JWT/opaque)** for the SPA + extension — cleanest for cross-origin + background
  workers; bigger change (login, refresh, storage). Aligns with Plan 01's extension token.
> Recommendation: **token auth** for all programmatic/SPA clients; keep sessions only for any
> remaining EJS pages during transition. Decide before the first migrated feature.

### CI/CD
- `cloudbuild.yaml` must build **both** projects (backend image + `frontend` build) and run
  tests; fail the deploy on any test/build failure. (Today it builds neither the frontend nor
  runs tests.)

### Migration mechanics (feature by feature)
For each feature: (1) build/confirm the JSON API in `backend/` with tests; (2) build the React
screen in `frontend/` with tests; (3) cut traffic over (route the page to the SPA), retire the
EJS view; (4) update `00-PROGRESS.md`. **One feature per PR.** Keep EJS serving un-migrated
features until each is ported.

---

## 2. Test coverage — every feature, backend + frontend

Today there are **no meaningful automated tests** (root `package.json` has a `test` placeholder;
only ~13 ad-hoc tests referenced historically). This is the single biggest risk for a big
refactor. Establish the harness FIRST, then require tests with every migrated/fixed feature.

### Backend
- **Framework:** Jest (or Vitest) + **Supertest** for HTTP routes.
- **DB:** a disposable MySQL (Docker/testcontainers) seeded per suite; never touch prod.
- **Layers:** unit tests for `utils/*` (the calc chain — `getCuttingRecommendations`, `onOrder`,
  `cutPlanner`, `picSizeReport`, `stageEvents`), integration tests for each route (auth, role
  gating, happy-path, validation, idempotency), and regression tests pinning the bugs we fixed
  (e.g. amber trigger, In=approved report model, orphan-approve dedup invariant).
- **Coverage gate:** start at a realistic floor, ratchet up per feature.

### Frontend
- **Framework:** **Vitest** + **React Testing Library**; **Playwright** for end-to-end.
- **Scope:** component tests (render, states: loading/empty/error), hook/API-client tests
  (mock fetch), and E2E per feature flow (login → view → action → assert DB effect via API).
- **Accessibility checks** (axe) baked into component tests.

### "Every single feature" — approach
Enumerate features from the route map (Plan 00/02 + the 194 views). For each: a backend
integration test file + a frontend test file, written **as that feature is migrated** (not a
big-bang test-writing phase). Track per-feature test status in `00-PROGRESS.md`.

---

## 3. Security testing & server/DB access hardening

The user's concern: "if someone could get access to our server or database." Work items:

### AuthN/AuthZ
- Replace the fragile session model (see §1). Enforce role checks on **every** API route (audit
  for any unguarded `/api/*`). Rate-limit login + token endpoints (there's already
  express-rate-limit in the app — extend it).
- Extension/token endpoints: short-lived or revocable tokens, per-user attribution, no secrets
  in client code (the extension currently has none, but the localhost debug endpoints must go).

### Input / injection
- Audit all raw SQL for parameterization (the codebase uses `pool.query(?, [..])` widely — verify
  no string-concatenated user input). Add a lint rule / review checklist.
- XSS: the EJS `<%- %>` unescaped-output audit (Plan 04 FE-3). CSP (FE-4).
- File uploads (XLSX importers): validate type/size, parse in a sandbox, cap rows.

### Secrets & infra
- Confirm no secrets in the repo/history; all via Secret Manager (there are API keys in Cloud
  Run env today — review least-privilege). Rotate anything that's been in logs.
- **DB access:** the app connects as `kotty_user` — verify it has only needed grants (no
  SUPER/FILE); restrict Cloud SQL to the Cloud Run service account + the proxy; no public IP.
- Cloud Run: `--no-allow-unauthenticated` is NOT possible (public app), so WAF/Cloud Armor +
  rate limiting at the edge; lock down `/internal/*` and `/ext/*` to secret/token only.
- Dependency scanning (`npm audit` / Dependabot — already surfaced by GitHub), and CI SAST.

### Testing
- **Security tests:** automated checks for authz bypass (hit protected routes without/with wrong
  role → expect 401/403), SQLi/XSS payloads in test suites, and a periodic dependency + secret
  scan in CI. Consider a pentest pass before/after the split.

---

## 4. Stress / load testing
- **Tooling:** k6 (or Artillery) scripts per critical endpoint — the recommendation engine
  (`/pm/api/*` — 26k-row compute, currently ~5 s), the report downloads (PIC size — large XLSX),
  the extension ingest (`/ext/qc/capture` — batched writes), and login.
- **Goals:** find the p95 latency + breakpoint under N concurrent QC desks / PM users; verify the
  pull worker + API coexist on 2Gi/min-instances=1; validate DB connection-pool limits and the
  Cloud Run 32 MiB response cap (already a known gotcha for big reports).
- **Where:** against a **staging** environment, never prod. Add a staging Cloud Run service +
  Cloud SQL (or a smaller instance) as part of this program.
- **Outputs:** a baseline report + autoscaling/pool tuning; re-run after each big feature.

---

## Sequencing (high level)
0. **Now:** cutting-planning bugs (Plan 02) on the current stack — safe, high value, no rearchitecture.
1. **Foundation:** test harness (backend Jest+Supertest, frontend Vitest+RTL+Playwright), CI
   builds both + runs tests, staging env, shared session store or token auth (decision).
2. **Extension (Plan 01):** first real token-auth + ingest feature — good pilot for the split.
3. **Feature-by-feature migration** (Plan 03 reframed as the split): start with the PM
   cutting-planning screens (most active), each with backend + frontend tests.
4. **Security + stress passes** continuous, with a formal review gate before cutover of each
   high-risk feature.

## Decisions needed before Foundation
1. Repo: monorepo (recommended) vs two repos.
2. Auth: token (recommended) vs session+shared-store.
3. Test stack: Jest vs Vitest (backend); confirm Vitest+RTL+Playwright (frontend).
4. Staging environment budget (needed for stress + safe security testing).
