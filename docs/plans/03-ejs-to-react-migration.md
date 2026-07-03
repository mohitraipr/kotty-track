# Plan 03 — EJS → React: Effort, Benefits, Approach

_Status: Analysis / decision pending. This answers "how long, and what gets better."_

## Where we are today
- **194 `.ejs` files** in `views/` (~157 top-level pages + partials/layouts).
- Interactivity is **inline**: **132 views contain `<script>` blocks; 83 make `fetch()` calls**
  straight to per-feature JSON routes. Only **6 shared JS files** in `public/js/` — no SPA,
  no shared state, no component library on the EJS side.
- Server coupling is high: every page is `res.render(view, { user, …locals })` reading
  `req.session.user` + feature data.
- **A React stack already exists and is proven in prod**: `frontend/` = **Vite 6 + React 18 +
  TypeScript + Tailwind v4 + shadcn/Radix**, built to `public/tasks/`, bridged into EJS by
  `utils/viteManifest.js`, mounted by `views/tasks.ejs` passing session via `data-*`, behind
  session-gated `/tasks/api/*`. The **island migration rails are already laid.**

## Two ways to do it

### Option A — Incremental "islands" (recommended)
Migrate **feature by feature**, reusing the Tasks pattern: a Vite entry per feature →
`public/<feature>/` → manifest bridge → thin EJS shell with `data-*` → session-gated JSON API.
Old EJS pages keep working; you convert the **high-interactivity** pages first and leave
simple server-rendered pages (static lists, print views, admin CRUD) on EJS possibly forever.

- **Pros:** ship value continuously; no big-bang risk; auth/session unchanged; each island is
  independently testable; you already have one working.
- **Cons:** two rendering models coexist for a long time; some duplicated layout/partials.

### Option B — Full SPA rewrite (not recommended now)
Replace EJS entirely with a React app + a JSON-only backend (React Router, a real session-or-JWT
API, shared design system).
- **Pros:** one model, best DX/UX ceiling, shared components/state.
- **Cons:** months before anything ships; must re-implement **all 194 views + 83 fetch flows +
  auth/session/flash** at once; high regression risk across every role's daily workflow; freezes
  feature work. For a live factory ops tool this is the wrong risk profile.

## Rough effort (one experienced full-stack dev)
Estimates are for migrating a page's UI to a React island **and** hardening its API. Wide
ranges because complexity varies.

| Page type | Examples | Per page | Count (approx) |
|-----------|----------|----------|----------------|
| Simple list/CRUD | units master, config pages | 0.5–1.5 d | many (leave most on EJS) |
| Interactive dashboard | PM dashboard, operator day-activity, lot-TAT, cutting/washing/finishing dashboards | 3–8 d | ~12–18 |
| Complex flow | cut-planning approve-&-assign, PIC reports, PO creator, returns | 5–12 d | ~6–10 |
| Shared foundation (one-time) | design system, auth/session hook, API client, layout shell, CI build step | 10–20 d | once |

- **Recommended subset** (the ~20 high-value interactive pages + foundation): **~3–5 months.**
- **Everything** (all 194 views): **~9–15 months** and a long two-model period — only worth it
  if you commit to it as a program, not a side quest.

## What genuinely gets better with React
1. **No more inline `<script>` sprawl** — 132 pages of ad-hoc DOM code become typed components.
2. **A real component/design system** (shadcn already in place) → consistent UI, faster new
   screens, dark-mode/theming for free.
3. **Type safety** (TS) across the 83 fetch flows → fewer field-name/shape bugs (the kind that
   caused the `orange`/`amber` mismatch class of defect).
4. **Client state & optimistic UI** — the production dashboards (live counts, filters, assign)
   are exactly where React + a data layer (TanStack Query) shines vs full-page reloads.
5. **Testability** — component + hook tests vs untestable inline scripts.
6. **Reuse** — the PIC report table, size grids, KPI cards, priority tables recur across
   dashboards; build once.

## What does NOT need React (keep on EJS)
Print/label views, simple admin CRUD, one-off report pages, login. Forcing these into React is
pure cost.

## Prerequisites / things to fix first (independent of React)
- Add the `frontend` build to CI (`cloudbuild.yaml` currently doesn't run `cd frontend && npm
  run build` — Tasks assets are built manually). Any island migration needs this automated.
- Decide the **API auth story** for a growing JSON surface — session cookies work for
  same-site islands (Tasks proves it), but see the MemoryStore caveat (not shared across
  instances). Consider a shared session store (Redis/MySQL) before scaling islands, or you'll
  hit intermittent logouts under `max-instances>1`. (This also matters for Plan 01.)

## Recommendation
- **Do Option A, opportunistically.** When a dashboard needs real work, migrate it to an island
  instead of extending its inline script.
- **First islands to target** (highest interactivity + churn): the **PM cutting-planning**
  screens (dashboard, style page, approve-&-assign) — they're already the most JS-heavy and are
  getting active bug-fix work (Plan 02), so you'd get typed models + reuse immediately.
- **Two hard prerequisites before scaling islands:** (1) CI builds `frontend/`; (2) a shared
  session store (or token auth) so multi-instance doesn't drop sessions.
- Treat a full Option-B rewrite as a **separate, staffed program**, not implied by "move to React."
