# Plan 01 — QC-Capture Extension → Authenticated DB Ingestion (`jitrgp`)

_Status: Not started. Owner: TBD. Related: `qcpass_extension/`, `routes/`, `middlewares/auth.js`._

## Context — what prompted this
`qcpass_extension/` is a Manifest-V3 Chrome extension ("QC Capture — Full Return Data")
that the QC / return-gate-pass team runs on Myntra's return console
(`rejoyui.myntrainfo.com`). It piggybacks on the page's own session and API calls to:
- **Capture** the full return record on every scan/search (`searchReturnDetails/search2`),
  enriched with logistics (`getReturnLMSDetails`) — ~40 fields (tracking, item barcode,
  return_id, sku, style, size, price, qc_action, quality, dates, courier, warehouses, …).
- Optionally **auto-pass** each scanned item (`updateReturnRestocked` PUT) and suppress the
  print popup.
- Write every record to a **durable IndexedDB queue** and batch-sync to a backend, only
  removing a record after the backend confirms (survives crashes / reload / offline).

**Current gaps (why this plan exists):**
1. **No login / no auth.** Anyone who installs it captures and posts data anonymously.
2. Backend is hardcoded to a throwaway `http://localhost:8000/api/capture` — that endpoint
   **does not exist in kotty-track**. Data goes nowhere real.
3. There are leftover **debug endpoints** (`localhost:8000/api/debug-dump`, `/api/debug-pass`)
   that ship raw Myntra API responses.

**Goal:** only users with the **`jitrgp`** role can use the extension; each captured record
is attributed to that user and stored in the kotty-track DB, **reliably (no lost or
duplicated records) whether online, offline, or flaky** — the user explicitly wants the
best realtime-vs-queue approach.

---

## Key constraints discovered (drive the design)
- **No token/JWT/API-key auth exists** in the app; everything is `express-session` cookie based.
- Sessions use **in-process `MemoryStore`** → not shared across Cloud Run instances, lost on
  restart. The service runs `min-instances=1, max-instances=10`.
- Session cookie is `httpOnly` + `sameSite=lax` + `secure` → a background-worker cross-site
  POST **won't reliably carry the cookie**, and extension JS can't read it.
- **No global CORS** (only `/returns/api` has `cors()`).
- The one existing machine-to-machine pattern is `POST /internal/run-pull`, gated by
  `x-cron-secret` header vs `PM_CRON_SECRET`, mounted **before** the session/auth middleware
  (`app.js:210`, `utils/catchupPull.js:179`). **This is the template.**
- The **`jitrgp` role does not exist yet** — must be created.

**Conclusion:** session-cookie auth is the wrong tool for a background-worker extension.
Use a **per-user bearer token**, on an endpoint mounted before the session middleware, that
resolves the token → user → confirms the `jitrgp` role. Stateless-per-request (any Cloud Run
instance can serve it), no cookie, so CORS is trivial.

---

## Design

### 1. Role
Create the role once (seed SQL, mirroring `sql/2026_05_production_manager.sql:70`):
```sql
INSERT IGNORE INTO roles (name, description) VALUES ('jitrgp', 'JIT Return Gate Pass — QC capture');
```
Grant it to the relevant users (primary `users.role_id` or via `user_roles`). Add a
`getDashboardForRole('jitrgp')` entry in `routes/authRoutes.js:48` (can point at a simple
status page) and, if they should log into the web app too, nothing else is needed —
`allowRoles(['jitrgp'])` already works off `req.session.user.roleName`.

### 2. Token-based auth for the extension (recommended: DB-backed opaque token)
Two token options — **recommend DB-backed opaque token** for revocability + per-user audit:

**A. DB-backed opaque token (recommended).** New table:
```sql
CREATE TABLE qc_ext_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  token_hash    CHAR(64) NOT NULL UNIQUE,   -- sha256 of the random token; never store raw
  user_id       INT NOT NULL,
  device_label  VARCHAR(80) NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TIMESTAMP NULL,
  revoked_at    TIMESTAMP NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```
- **Login** `POST /ext/qc/login` (mounted before auth, like `/internal`): body `{username, password, device_label?}`. bcrypt-compare against `users JOIN roles`, **require the user to hold `jitrgp`** (primary role or a `user_roles` row). On success, generate `crypto.randomBytes(32).hex()`, store its sha256 in `qc_ext_tokens`, return the raw token once. Extension saves it in `chrome.storage.local`.
- **Verify** middleware `requireQcToken`: read `Authorization: Bearer <t>` (or `x-qc-token`), sha256, look up a non-revoked row, join to user+role, confirm `jitrgp`, set `req.qcUser = {id, username}`, bump `last_used_at`. 401 on any failure.
- Revocable per user/device from an admin action (`UPDATE ... SET revoked_at=NOW()`).

**B. Stateless JWT** (HS256, new `EXT_TOKEN_SECRET`, `exp` ~12 h, payload `{uid, role}`).
Simpler (no table) but not revocable and needs re-login on expiry. Acceptable fallback.

> Why not "extension logs in via `/api/login` and rides the session cookie"? Because
> `MemoryStore` isn't shared across instances and the `sameSite=lax`/`httpOnly` cookie won't
> reliably attach to background POSTs — you'd get intermittent 401s. Tokens avoid all of it.

### 3. Ingestion endpoint
`POST /ext/qc/capture` (mounted before session middleware, `requireQcToken` gate):
- Body: `{ records: [ {…, _type:'capture'|'pass', capture_uid } ] }` (≤100, matches the
  extension's existing batch shape).
- **Idempotent upsert** into new tables (see §4) keyed on `capture_uid`, all in **one
  transaction**; respond `200 {ok:true, accepted:n}` **only after commit** — this satisfies
  the extension's "remove from queue only after backend confirms" contract.
- Attribute every row to `req.qcUser.id` (server-side, never trust a client-supplied user).
- On any error → 5xx (no partial state, transaction rolls back) so the extension retries.

### 4. Storage schema (idempotent)
```sql
CREATE TABLE qc_return_captures (
  capture_uid   CHAR(64) NOT NULL PRIMARY KEY,   -- client-stable dedupe id
  captured_by   INT NOT NULL,
  return_id     VARCHAR(40), item_barcode VARCHAR(60), tracking_number VARCHAR(80),
  oms_release_id VARCHAR(40), sku_id VARCHAR(40), sku_code VARCHAR(80),
  style_id VARCHAR(40), article_no VARCHAR(80), product_name VARCHAR(255),
  size VARCHAR(20), price DECIMAL(10,2),
  return_type VARCHAR(40), return_mode VARCHAR(40), return_status VARCHAR(40),
  rms_status VARCHAR(40), qc_action VARCHAR(40), quality VARCHAR(20),
  logistics_status VARCHAR(60), courier_code VARCHAR(40),
  return_hub VARCHAR(40), dispatch_wh VARCHAR(40), return_destination_wh VARCHAR(40),
  delivery_center VARCHAR(40), ship_city VARCHAR(80),
  created_date DATE, refund_date DATE, return_received_on DATE, return_restocked_on DATE,
  raw_json JSON NULL,                       -- keep the full record for anything unmapped
  captured_at   DATETIME, ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (return_id), INDEX (item_barcode), INDEX (captured_by), INDEX (captured_at)
);

CREATE TABLE qc_return_passes (
  capture_uid   CHAR(64) NOT NULL PRIMARY KEY,
  passed_by     INT NOT NULL,
  item_barcode VARCHAR(60), oms_release_id VARCHAR(40),
  qc_action VARCHAR(40), quality VARCHAR(20), desk_code VARCHAR(20), warehouse_id VARCHAR(40),
  pass_success TINYINT(1), new_status VARCHAR(40), pass_error VARCHAR(255),
  passed_at DATETIME, ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX (item_barcode), INDEX (passed_by), INDEX (passed_at)
);
```
Ingest = `INSERT … ON DUPLICATE KEY UPDATE` on `capture_uid` → replays are no-ops. Keep
`raw_json` so no captured field is ever lost even before it's columnized.

### 5. Realtime vs queue — **the recommended approach**
**Keep the durable queue; make the server idempotent + transactional. Do NOT switch to
per-event realtime (WebSocket/SSE).** Reasons and how each failure mode is handled:

| Concern | How this design handles it |
|--------|----------------------------|
| Flaky wifi / offline QC desk | IndexedDB queue holds records; `flush()` retries every 30 s + on capture. Nothing lost. |
| Backend down / deploy / 5xx | Batch stays queued (record removed only on 200-after-commit). |
| Duplicate delivery (retry after a dropped 200) | `capture_uid` primary key + upsert → exact-once effect. |
| Out-of-order capture vs pass | Both keyed independently and idempotent; order doesn't matter. |
| Token expired / revoked | Endpoint returns 401 → extension surfaces "re-login" in the panel and **keeps** the queue until re-auth (must handle 401 distinctly from 5xx — see §6). |
| Multi-instance Cloud Run | Token auth is stateless → any instance serves ingest (session couldn't). |
| Volume / bursts | Batches of 100 + back-pressure via the queue; server commits per batch. |

Realtime (WebSocket) would add a persistent connection, server fan-in, and reconnection
logic while making durability *harder* — the opposite of what's wanted. Near-realtime
(30 s batch) is already effectively live for a human-paced QC desk.

**Required precondition:** a **stable `capture_uid`.** Add it in the extension when a record
is created — e.g. `sha256(return_id + '|' + item_barcode + '|' + captured_at)` for captures,
`sha256(item_barcode + '|' + passed_at)` for passes (or a persisted `crypto.randomUUID()`
stored with the queued record). Without it, retries double-insert.

---

## Work items

### Extension side (`qcpass_extension/`)
1. `background.js`: change `BACKEND` from `localhost:8000/api/capture` → the kotty-track URL
   (`https://<prod-host>/ext/qc/capture`); make it configurable via `chrome.storage.local`.
2. `background.js`: add `Authorization: Bearer <token>` (from storage) to the POST; add a
   **stable `capture_uid`** to each queued record; treat **401** specially (set `needsLogin`,
   stop flushing, surface in panel) vs 5xx (keep retrying).
3. Add a tiny **login UI** — a popup (add `action`/`default_popup` to the manifest) or a form
   in the on-screen panel — that calls `POST /ext/qc/login`, stores the token, and shows the
   logged-in user. Panel status: "logged in as X · queued N · synced M · OFFLINE/RE-LOGIN".
4. `inject.js`: **remove the debug endpoints** (`debugPost`/`debugPostPass` to localhost) and
   the `window.__qcRaw` console dump for the prod build (or gate behind a dev flag).
5. `manifest.json`: replace `localhost` host permissions with the prod host; keep
   `rejoyui.myntrainfo.com` + `spectrum-babylon-api.myntrainfo.com` (needed for capture).
6. Decide **auto-pass** policy: keep it as an explicit opt-in toggle (it mutates Myntra state).
   Document that captures are read-only; auto-pass is a separate, deliberate action.

### Server side (kotty-track)
1. Seed the `jitrgp` role + grant to users (`sql/…jitrgp.sql`).
2. New `routes/qcExtensionRoutes.js` with `POST /ext/qc/login` + `POST /ext/qc/capture`,
   mounted in `app.js` **before** the session/auth block (next to `/internal/run-pull`).
3. `requireQcToken` middleware + `qc_ext_tokens`, `qc_return_captures`, `qc_return_passes`
   tables (migration in `sql/`).
4. `cors()` scoped to `/ext/qc` (token, no cookie → can allow the extension origin; ideally
   restrict `Origin: chrome-extension://<id>` once the extension id is fixed).
5. Secrets: `EXT_TOKEN_SECRET` (if JWT) via Secret Manager + `--update-env-vars`.
6. A minimal admin/report view (later): list `qc_ext_tokens` (issue/revoke) and browse
   `qc_return_captures`. Optional first cut: reuse the existing admin pages.

### Verification
- Local: run the app, `POST /ext/qc/login` with a jitrgp user → token; `POST /ext/qc/capture`
  with a batch twice → second is a no-op (idempotency); non-jitrgp user → 403; bad token → 401.
- Load the extension against a staging URL, scan a return, pull the plug (offline) → queue
  grows; restore → syncs; verify rows land once in `qc_return_captures` attributed to the user.
- Confirm 401 handling: revoke the token mid-session → panel shows "re-login", queue preserved.

## Open decisions (need the user)
1. **Token style**: DB-backed opaque (revocable, audited — recommended) vs stateless JWT (simpler).
2. **What is the captured data *for* downstream** — pure QC/return audit store, or does it feed
   an RGP reconciliation / report? (Affects whether we build reporting now.)
3. **Auto-pass in production** — keep the toggle, or capture-only? (It writes to Myntra.)
4. **Where the extension points in prod** — main Cloud Run host, or a dedicated ingest path.
