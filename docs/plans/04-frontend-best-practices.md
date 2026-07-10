# Plan 04 — Frontend Issues vs Best Practice (one by one)

_Status: **FE-5 + FE-6 DONE** (#539: MySQL session store, CI island build), **FE-3 + FE-2 DONE** (#540: XSS audit/fixes, `public/js/api.js` client — 3 screens migrated, ~80 call sites remain). FE-1 open (unlocks FE-4/CSP); FE-7–10 best absorbed by Plan 03 islands. Each item: **Issue → Best practice → Fix**. These apply to
the current EJS frontend and are largely independent of the React question (Plan 03); doing
them makes an eventual React migration easier, not harder._

Baseline (measured): 194 `.ejs` views, **132 with inline `<script>`**, **83 with inline
`fetch()`**, only 6 shared `public/js/` files, `express-session` on **MemoryStore**, no CI
build for the `frontend/` island.

---

## FE-1 — Inline `<script>` sprawl  **[High]**
- **Issue:** 132 views hand-roll DOM logic inline. No reuse, no tests, easy to drift (this is
  the soil the `orange`/`amber`-class bugs grow in).
- **Best practice:** keep behavior in versioned, cacheable JS modules (or components), not in
  server-rendered markup; markup should be declarative.
- **Fix:** extract repeated inline logic into `public/js/` modules (or React islands per
  Plan 03) and load with `<script type="module" src>`. Start with the most-duplicated patterns
  (fetch-render-table, filter chips, modal open/close).

## FE-2 — Inline `fetch()` with no shared client / error handling  **[High]**
- **Issue:** 83 views call `fetch()` directly; each re-implements JSON parsing, error handling,
  and loading/empty states inconsistently (many just `.then(r=>r.json())` with no `res.ok`
  check → silent failures on 401/500).
- **Best practice:** one thin API client that handles base URL, credentials, `res.ok`, JSON,
  and a consistent error/toast + auth-redirect on 401.
- **Fix:** add `public/js/api.js` (`apiGet/apiPost` → throw on !ok, redirect to `/login` on
  401, surface a toast on 5xx). Migrate the 83 call sites incrementally. In React islands this
  becomes TanStack Query.

## FE-3 — Unescaped output / XSS surface  **[High · security]**
- **Issue:** EJS `<%- %>` (unescaped) used with data that can contain user/vendor input renders
  raw HTML. History shows prior HTML-injection fixes — the pattern still exists in places.
- **Best practice:** default to escaped `<%= %>`; only use `<%- %>` for trusted server HTML;
  never interpolate user/DB strings into `<%- %>` or into inline `<script>` as JS literals.
- **Fix:** audit every `<%- %>` and every `<script>… <%= %> …</script>` interpolation; switch
  user-derived values to escaped output or pass them via `data-*`/`JSON.stringify` with proper
  escaping. Add a lint/grep check in review.

## FE-4 — No Content-Security-Policy; inline scripts block one  **[Medium · security]**
- **Issue:** heavy inline `<script>` makes a strict CSP impossible, so there's no defense-in-
  depth against injected script.
- **Best practice:** a CSP that disallows inline script (`script-src 'self'`); externalize JS.
- **Fix:** FE-1 is the prerequisite; then add `helmet` CSP starting in report-only mode, tighten
  as inline scripts are removed.

## FE-5 — Session on in-process MemoryStore  **[High · reliability/UX]**
- **Issue:** `express-session` uses the default MemoryStore → sessions are per-instance and lost
  on restart. With `max-instances=10`, users get **intermittent logouts** when routed to another
  instance. (Also blocks scaling React islands and complicates the extension — Plan 01/03.)
- **Best practice:** a shared, persistent session store.
- **Fix:** add `express-mysql-session` (reuse the existing MySQL) or Redis; low-risk, big UX win.

## FE-6 — No CI build for the frontend island  **[Medium]**
- **Issue:** `cloudbuild.yaml` doesn't run `cd frontend && npm run build`; the Tasks island
  assets are built by hand, so a deploy can ship stale/missing assets.
- **Best practice:** build all client assets in CI, fail the deploy if the build fails.
- **Fix:** add a `frontend` install+build step to `cloudbuild.yaml` before the image build (or
  bake it into the Docker build), and commit `public/tasks` out of git if it's currently tracked.

## FE-7 — Duplicated layout / no shared shell  **[Medium]**
- **Issue:** partials exist (`views/partials/*`, `layouts/master.ejs`) but many pages re-declare
  nav/header/styles; inconsistent look across roles.
- **Best practice:** one layout + shared partials (or one React `AppShell`); design tokens for
  color/spacing.
- **Fix:** consolidate onto `layouts/master.ejs` + a single nav partial; define CSS variables
  for the palette (there's already an amber/red/green trigger vocabulary to standardize).

## FE-8 — Inconsistent loading / empty / error states  **[Medium · UX]**
- **Issue:** fetch-driven pages often show nothing (or a spinner forever) on error/empty; the
  PM freshness-banner saga showed how silent staleness misleads users.
- **Best practice:** every async view has explicit loading, empty, and error states, and
  surfaces data freshness where relevant.
- **Fix:** standardize skeleton/empty/error components (ties to FE-2's client); reuse the
  freshness-banner pattern for any data that can be stale.

## FE-9 — Asset caching / cache-busting  **[Low]**
- **Issue:** `public/css` + `public/js` served without content-hash filenames → stale assets or
  aggressive cache-busting via query strings.
- **Best practice:** hashed filenames (Vite already does this for islands) + long-cache headers;
  fingerprint the shared `public/js` too.
- **Fix:** either move shared JS into the Vite pipeline or add a small hashing step +
  `Cache-Control` in `express.static`.

## FE-10 — Accessibility & mobile  **[Low–Medium]**
- **Issue:** factory-floor tools are used on phones/tablets; inline-built tables/forms have
  inconsistent responsive + a11y (labels, focus, contrast).
- **Best practice:** semantic HTML, labelled controls, keyboard focus, responsive tables.
- **Fix:** address per island during Plan 03 (shadcn/Radix give a11y primitives); for EJS pages,
  a pass on the highest-traffic operator screens.

---

## Suggested order
FE-5 (session store — quick, stops random logouts) → FE-3 (XSS audit — security) → FE-2
(API client) → FE-1 (externalize scripts) → FE-6 (CI build) → FE-4 (CSP) → FE-7/8 → FE-9/10.

Most of FE-1/2/4/7/8 are naturally absorbed by migrating a page to a React island (Plan 03),
so sequence them with that work rather than duplicating effort.
