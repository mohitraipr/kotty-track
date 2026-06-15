// Self-healing catch-up pull.
//
// The nightly EasyEcom pull (utils/easyecomPullWorker.runPullWorker) cannot rely on
// the in-process node-cron: Cloud Run scales to zero, so at 02:30 IST there is usually
// no container alive to fire it, and even a manual fire-and-forget trigger dies because
// Cloud Run throttles CPU once the originating request returns.
//
// Fix (two separable problems):
//   TRIGGER    — the first app request seen after the 02:30 IST cutoff claims the day's
//                run (single-runner lock via pm_pull_claims PRIMARY KEY) and fires a
//                self-call. No external scheduler needed; piggybacks on real traffic.
//   COMPLETION — the self-call hits POST /internal/run-pull, which AWAITS runPullWorker
//                inside the request. Cloud Run keeps CPU allocated for an in-flight
//                request, so the pull runs to completion instead of dying after step 1.
//
// The user request is never blocked: the middleware calls next() first and does the
// claim check detached; the self-call is fire-and-forget from the trigger side.

const os = require('os');
const { pool } = require('../config/db');
const { runPullWorker } = require('./easyecomPullWorker');

const CUTOFF_HOUR = 2;                       // 02:30 IST daily cutoff
const CUTOFF_MIN = 30;
const CHECK_THROTTLE_MS = 10 * 60 * 1000;    // at most one claim-check per instance / 10 min
const STALE_CLAIM_MIN = 60;                  // a 'running' claim older than this may be re-claimed
const MAX_ATTEMPTS = 3;                      // cap same-day retries after failures

let lastCheckAt = 0;
let checkInFlight = false;

function envv(name) {
  return process.env[name] || (global.env && global.env[name]) || undefined;
}
function pullEnabled() {
  const v = envv('PM_PULL_ENABLED');
  return v === '1' || v === 'true';
}
function instanceId() {
  return (envv('K_REVISION') || os.hostname() || 'unknown').slice(0, 64);
}

// process.env.TZ='Asia/Kolkata' is set in app.js, so Date components are already IST.
// due_date = the most recent calendar date whose 02:30 cutoff has passed (the day's run).
function computeDueDate(now = new Date()) {
  const d = new Date(now.getTime());
  const past = d.getHours() > CUTOFF_HOUR ||
    (d.getHours() === CUTOFF_HOUR && d.getMinutes() >= CUTOFF_MIN);
  if (!past) d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Attempt to claim today's run. Returns the run_date if THIS call won the claim
// (and a self-call should fire), or null if someone else owns it / it's done.
async function tryClaim(dueDate) {
  const [rows] = await pool.query(
    'SELECT status, attempts, claimed_at FROM pm_pull_claims WHERE run_date = ?',
    [dueDate]
  );

  if (!rows.length) {
    // No claim yet — atomic insert wins the race; a concurrent winner gets ER_DUP_ENTRY.
    try {
      await pool.query(
        `INSERT INTO pm_pull_claims (run_date, status, attempts, claimed_at, claimed_by)
         VALUES (?, 'running', 1, NOW(), ?)`,
        [dueDate, instanceId()]
      );
      return dueDate;
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return null;
      throw e;
    }
  }

  const c = rows[0];
  if (c.status === 'done') return null;

  if (c.status === 'running') {
    // Re-claim only if the previous runner is stale (likely a killed instance).
    const [upd] = await pool.query(
      `UPDATE pm_pull_claims
         SET status='running', claimed_at=NOW(), claimed_by=?, attempts=attempts+1
       WHERE run_date=? AND status='running'
         AND claimed_at < (NOW() - INTERVAL ? MINUTE) AND attempts < ?`,
      [instanceId(), dueDate, STALE_CLAIM_MIN, MAX_ATTEMPTS]
    );
    return upd.affectedRows ? dueDate : null;
  }

  if (c.status === 'failed' && c.attempts < MAX_ATTEMPTS) {
    const [upd] = await pool.query(
      `UPDATE pm_pull_claims
         SET status='running', claimed_at=NOW(), claimed_by=?, attempts=attempts+1
       WHERE run_date=? AND status='failed' AND attempts < ?`,
      [instanceId(), dueDate, MAX_ATTEMPTS]
    );
    return upd.affectedRows ? dueDate : null;
  }

  return null;
}

async function markDone(dueDate) {
  await pool.query(
    "UPDATE pm_pull_claims SET status='done', finished_at=NOW(), message=NULL WHERE run_date=?",
    [dueDate]
  ).catch((e) => console.error('[catchup] markDone failed:', e.message));
}
async function markFailed(dueDate, err) {
  await pool.query(
    "UPDATE pm_pull_claims SET status='failed', finished_at=NOW(), message=? WHERE run_date=?",
    [String(err && err.message || err).slice(0, 250), dueDate]
  ).catch((e) => console.error('[catchup] markFailed failed:', e.message));
}

// Fire the self-call that actually runs the pull inside a fresh request (CPU stays
// allocated). Must hit the PUBLIC service URL so it traverses the Cloud Run frontend
// and counts as a live request. If the URL/secret aren't configured yet, fall back to
// an inline run (works, but may be CPU-throttled on Cloud Run — acceptable stopgap).
function fireSelfCall(dueDate) {
  const base = envv('SERVICE_BASE_URL');
  const secret = envv('PM_CRON_SECRET');
  if (!base || !secret) {
    console.warn('[catchup] SERVICE_BASE_URL/PM_CRON_SECRET not set — running pull inline (may be CPU-throttled)');
    runPullWorker(pool).then(() => markDone(dueDate)).catch((e) => markFailed(dueDate, e));
    return;
  }
  const url = base.replace(/\/+$/, '') + '/internal/run-pull';
  // Fire-and-forget; the trigger side does not wait for the (long) pull to finish.
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
    body: JSON.stringify({ run_date: dueDate }),
  }).then((r) => {
    console.log(`[catchup] self-call dispatched for ${dueDate} (status ${r.status})`);
  }).catch((e) => {
    // Self-call could not be dispatched — leave the claim 'running'; it becomes
    // re-claimable after STALE_CLAIM_MIN so a later request retries.
    console.error('[catchup] self-call dispatch failed:', e.message);
  });
}

async function checkAndMaybeRun() {
  const dueDate = computeDueDate();
  const won = await tryClaim(dueDate);
  if (won) {
    console.log(`[catchup] claimed pull for ${dueDate} on ${instanceId()} — dispatching`);
    fireSelfCall(dueDate);
  }
}

// Express middleware — registered before routes. Never blocks the request.
function catchupMiddleware(req, res, next) {
  next();
  if (!pullEnabled()) return;
  const p = req.path || '';
  if (
    p.startsWith('/internal/') || p.startsWith('/health') || p.startsWith('/favicon') ||
    p.startsWith('/css') || p.startsWith('/js') || p.startsWith('/images') ||
    p.startsWith('/public') || p.startsWith('/uploads')
  ) return;

  const now = Date.now();
  if (checkInFlight || now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;
  checkInFlight = true;
  Promise.resolve()
    .then(checkAndMaybeRun)
    .catch((e) => console.error('[catchup] check error:', e.message))
    .finally(() => { checkInFlight = false; });
}

// POST /internal/run-pull — runs the pull synchronously inside the request so Cloud Run
// keeps CPU allocated until it finishes. Secret-gated (header x-cron-secret).
async function internalRunPullHandler(req, res) {
  const secret = envv('PM_CRON_SECRET');
  if (!secret || req.get('x-cron-secret') !== secret) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const dueDate = (req.body && req.body.run_date) || computeDueDate();
  console.log(`[catchup] /internal/run-pull starting for ${dueDate}`);
  try {
    await runPullWorker(pool);
    await markDone(dueDate);
    console.log(`[catchup] /internal/run-pull done for ${dueDate}`);
    return res.json({ ok: true, run_date: dueDate });
  } catch (e) {
    await markFailed(dueDate, e);
    console.error(`[catchup] /internal/run-pull failed for ${dueDate}:`, e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = {
  catchupMiddleware,
  internalRunPullHandler,
  computeDueDate,   // exported for tests
  tryClaim,
};
