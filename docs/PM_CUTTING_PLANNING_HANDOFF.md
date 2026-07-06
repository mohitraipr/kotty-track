# Cutting-Planning (Production Manager) — Handoff & Runbook

Owner handoff, 2026-07. This is the single doc to understand, operate, and debug the PM
cutting-planning system. It replaces tribal knowledge — read it top to bottom once.

---

## 1. What this is (in one paragraph)

The `/pm` dashboard tells the factory **what to cut, how much, and when**, by joining two
systems: **EasyEcom** (the ERP — sales, inventory, dead-stock) and **kotty-track** (this app,
the OMS — cutting lots, stitching/wash/finish stages, dispatch). A background worker pulls
EasyEcom data hourly into this app's MySQL DB; analytics turn that into a per-SKU
**suggested cut** with a red/amber/green priority. It's live in prod and drives real cutting.

## 2. Architecture / data flow

```
EasyEcom API ──(pull worker, hourly)──►  kotty_db tables  ──► analytics ──► /pm dashboard
  sales, inventory                        ee_sales_daily        DRR/SOH/DOH     cut recs
  snapshot, aging                         ee_inventory_health   suggested_cut   priority
                                          ee_orders/_suborders
kotty-track OMS (same DB)  ─────────────► cutting_lots, *_events, dispatches ──► on-order netting
```

- **Pull worker**: `utils/easyecomPullWorker.js` → `runPullWorker()`. Not a normal cron
  (Cloud Run scales to zero); it's driven by `utils/catchupPull.js` — the first web request
  after the due time fires a self-call to `POST /internal/run-pull` (secret-gated) which
  `await`s the whole pull. Also a node-cron at 02:30 IST when the instance is warm.
- **EasyEcom client / auth**: `utils/easyecomReturnsClient.js` (`/access/token` V2.1 auth,
  per-warehouse creds, report queue+poll).
- **Analytics**: `utils/easyecomAnalytics.js` (`getCuttingRecommendations`, DRR, SOH, DOH),
  `utils/onOrder.js` (in-flight netting), `utils/cutPlanner.js` (split into ≤1500-pc lots +
  fabric from CAD), `utils/skuResolver.js` (cut-style → ecom size-SKU map).
- **UI**: `views/productionManagerDashboard.ejs`, `views/productionManagerStyle.ejs`,
  `views/cutPlanning.ejs`. Routes: `routes/productionManagerRoutes.js` (mounted at `/pm`).

## 3. The cut formula

`suggested_cut = max(0, horizon*DRR − SOH − openLotQty + upcomingPoQty)`
(`utils/easyecomAnalytics.js`, ~L840). `horizon = lead_time + safety_days` (default 12+3).
Trigger: `DOH ≤ lead_time` → **red** (cut now), `DOH ≤ horizon` → **amber**, else **green**.
`DOH = SOH / DRR`.

## 4. What actually drives each number (current real state)

| Number | Source of truth | State |
|---|---|---|
| **DRR** (demand/day) | `ee_sales_daily` where `source='orders_api'` | ✅ Fresh. Uses the robust ±5% orders feed (PR #496). `mini_sales_report` is cross-check only. |
| **SOH** (stock on hand) | `ee_inventory_health.inventory` (= latest snapshot) | ⚠️ **Total** on-hand, NOT Available-only. The intended `ee_stock_status` (STATUS_WISE_STOCK_REPORT) 400s for this account and is **disabled**; SOH rides the snapshot fallback. Runs slightly high → cuts slightly conservative. |
| **On-order** (in-flight) | `utils/onOrder.js`, gated `PM_CLOSED_LOOP=1` | ⚠️ Real `cutting_lots` net of dispatch + manual `pm_open_cutting_lots`. Lot→SKU binding uses concat fallback (resolver map empty — see §7). Unresolved pcs are tallied & shown on the dashboard, never dropped. |
| **Dead stock** | `getDeadStock` (aging report disabled → sales-based heuristic) | ⚠️ INVENTORY_AGING_REPORT times out; aging is off and excluded from the freshness banner by design. |
| **Freshness banner** | oldest of `orders_aggregate` + `snapshot` last-OK pull | ✅ Tracks the two feeds that actually drive DRR/SOH. |

## 5. Feature flags (prod values as of handoff)

| Flag | Prod | Gates |
|---|---|---|
| `PM_PULL_ENABLED` | `1` | whether the EasyEcom pull runs at all |
| `PM_CLOSED_LOOP` | `1` | real in-flight lots count as on-order (off ⇒ manual table only) |
| `PM_DRR_MODE` | unset (legacy) | legacy vs clean-day DRR. **Keep legacy** — clean-day still needs ≥90%-coverage validation |
| `PM_CUT_AUDIT` | unset (off) | decision snapshots + dispatch-reflection reconcile step |
| `PM_STOCK_STATUS_ENABLED` | unset (off) | re-enables the STATUS_WISE_STOCK_REPORT pull if the 400 is fixed |
| `PM_INFLIGHT_WINDOW_DAYS` | unset (120d) | in-flight lot lookback |

Change flags with `gcloud run services update kotty-track --region=asia-south1 --update-env-vars KEY=VAL`
— **never** `--set-env-vars` (it wipes the rest).

## 6. The pull pipeline (order & safety)

`runPullWorker` runs steps in this order, each under a per-step deadline (`STEP_DEADLINE_MS`
10 min) and an overall budget (`RUN_DEADLINE_MS` 25 min); over-budget steps log `partial`:

1. `snapshot` → `ee_inventory_daily_snapshot` + pushes latest into `ee_inventory_health` (**SOH**)
2. `orders` → `ee_orders` / `ee_suborders`
3. `orders_aggregate` → `ee_sales_daily` source=`orders_api` (**DRR**)
4. `stock_status` — **disabled** (400s)
5. `product_master` (Sundays/bootstrap)
6. `mini_sales` — **last, best-effort**; skipped if attempted <2h ago (EasyEcom 1 report/2h cap)
7. `sales_cross_check` (DB-only) → `recomputeAllHealth`

Why this order: the freeze we fixed (PR #474) was mini_sales (a 15-min-per-warehouse poll)
running *before* the cheap high-value steps and getting killed by the 1800s Cloud Run
timeout, which starved DRR/stock. mini_sales now runs last and fails fast.

## 7. Known gaps & conscious decisions (NOT bugs)

- **SOH = total, not Available-only** — stock report 400s; accepted (snapshot fallback). To
  fix later: debug STATUS_WISE_STOCK_REPORT params in `easyecomReturnsClient.js`, then set
  `PM_STOCK_STATUS_ENABLED=1`.
- **Resolver map empty** — `pm_sku_resolution` has 0 rows (the PREFILLED sheets were lost).
  Lot→SKU binding runs on the `style+size` concat fallback (`utils/onOrder.js:resolveSizeSku`).
  Unresolved in-flight pcs are surfaced as the "N pcs in M lots not matched" footer, so they're
  visible, not silent. **To improve**: regenerate the SIZE/STYLE templates, fill them, upload
  via `POST /pm/resolver/upload-sizes` / `/pm/resolver/upload-styles` (admin). Waist-ruling
  styles need the size sheet (`utils/skuResolver.js:103`).
- **assign → cutting_lot** — `POST /pm/api/cut-plan/assign` writes `pm_cut_assignment` only,
  not a real `cutting_lot`; an assigned plan doesn't reduce future suggestions until a lot is
  cut. Bridge: add the `(sku, qty)` to `pm_open_cutting_lots` (unioned into on-order,
  `utils/onOrder.js:43`), set `closed_at` when the real lot exists. NOT auto-created on assign
  to avoid double-counting once `PM_CLOSED_LOOP` nets the real lot.
- **Clean-day DRR** — computed in shadow only; not driving cuts. Keep `PM_DRR_MODE` unset.

## 8. Health checks (runbook)

Read-only prod access (no mysql client needed; proxy at `~/google-cloud-sdk/bin`):
```bash
cloud-sql-proxy --port 3307 kotty-track-prod:asia-south1:kotty-mysql &   # uses gcloud ADC
DB_PW=$(gcloud secrets versions access latest --secret=db-password)
# then run node one-liners with mysql2 from the repo dir against 127.0.0.1:3307, user kotty_user, db kotty_db
```

Key queries (run from the repo dir so `require('mysql2/promise')` resolves):
```sql
-- Is data fresh? (both should be ~today)
SELECT source, MAX(sale_date) FROM ee_sales_daily GROUP BY source;
-- Did the last pull complete? (want a recent 'run' = ok)
SELECT run_started_at, step, status, LEFT(message,60) FROM pm_pull_runs
  WHERE run_started_at >= NOW()-INTERVAL 3 HOUR ORDER BY id;
-- Per-step last success (drives the freshness banner)
SELECT step, MAX(run_started_at) FROM pm_pull_runs WHERE status='ok' GROUP BY step;
-- Resolver coverage
SELECT state, COUNT(*) FROM pm_sku_resolution GROUP BY state;
```
Trigger a pull manually (admin) from the dashboard "Run pull", or:
```bash
curl -X POST https://<run-url>/internal/run-pull -H "x-cron-secret: $(gcloud secrets versions access latest --secret=pm-cron-secret)"
```

## 9. Debugging common failures

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Banner "N d old — stale" | full pull not completing | §8 last-3h query; look for a step with no `run` after it — that step is hanging/erroring |
| DRR / suggested_cut all ~0 | orders_api feed stale | `MAX(sale_date) WHERE source='orders_api'`; if stale, check `orders`+`orders_aggregate` steps |
| Feed frozen for days | EasyEcom auth or rate limit | `pm_pull_runs` `auth` step; `mini_sales:*` "Limit Exceeded" is normal (rate cap), not fatal |
| mini_sales always partial | EasyEcom 1-report/2h cap | expected — DRR uses orders_api now, mini_sales is only cross-check |
| Raw EasyEcom debugging | — | `GET /pm/debug-ee?what=snapshot|mini-sales|orders|locations&warehouse=faridabad` (admin) |

## 10. Deploy

Merge a PR to `main` → Cloud Build (`cloudbuild.yaml`) runs backend+frontend tests, builds the
image, deploys to Cloud Run `kotty-track` (region `asia-south1`, project `kotty-track-prod`).
~5 min. Verify: `gcloud run services describe kotty-track --region=asia-south1
--format="value(status.latestReadyRevisionName)"`. Prod DB = Cloud SQL
`kotty-track-prod:asia-south1:kotty-mysql`, db `kotty_db`. Local test: `node --test`
(`test/picSizeReport.test.js` needs a live DB and fails locally — that's expected).

## 11. Open follow-ups for the next owner (priority order)

1. **Resolver map** — regenerate + fill the SIZE/STYLE sheets and upload; shrinks the
   unresolved in-flight tail (biggest accuracy lever left).
2. **Available-only SOH** — fix the STATUS_WISE_STOCK_REPORT 400, re-enable
   `PM_STOCK_STATUS_ENABLED=1`; makes SOH sellable-only instead of total.
3. **assign → real cutting_lot** — close the bridge so approved plans reduce suggestions
   without manual `pm_open_cutting_lots` upkeep.
4. **Clean-day DRR cutover** — validate ≥90% snapshot coverage, then `PM_DRR_MODE=cleanday`.

Relevant PRs: #474 (feed-freeze fix), #496 (DRR→orders_api + honest feed status), and this
handoff change (disable stock_status noise, SOH/freshness on snapshot).
