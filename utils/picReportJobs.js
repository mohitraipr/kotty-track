// Async job runner for PIC-size report downloads.
//
// Wide-range/all-styles pulls can take minutes; running that inline on the HTTP
// request blocks the connection until Cloud Run's own timeout kills it ("Server
// error" / "Failed to fetch" client-side) — and a user re-clicking a stuck-looking
// download stacks more identical heavy queries on the same instance, making it worse.
//
// Same two-part fix as utils/catchupPull.js's self-healing pull:
//   TRIGGER    — the route handler creates a job row (or reuses an identical
//                in-flight one — the actual pile-up fix, enforced server-side via
//                pic_report_jobs instead of a client-side flag that resets on reload)
//                and fires a self-call. The HTTP response returns immediately.
//   COMPLETION — the self-call hits POST /internal/run-pic-report-job, which AWAITS
//                the report build inside that request, so Cloud Run keeps CPU
//                allocated until it finishes. Result goes to GCS; the row records
//                the key. The frontend polls the job's status and downloads via a
//                signed URL once it's done.

const { pool } = require('../config/db');
const { fnv1a, buildPicSizeRows, writePicSizeCsv } = require('./picSizeReport');
const gcs = require('./gcsClient');

const JOB_TTL_DAYS = 3; // best-effort cleanup of old job rows + their GCS objects

function envv(name) {
  return process.env[name] || (global.env && global.env[name]) || undefined;
}

function paramsHash(params) {
  return fnv1a(JSON.stringify(params, Object.keys(params).sort()));
}

// Reuse a queued/running job for the identical request instead of creating a new
// one — this is what actually stops the pile-up (server-side, survives reloads/
// multiple tabs/multiple people), unlike a client-side in-flight flag.
async function createOrReuseJob({ reportType, params, userId }) {
  const hash = paramsHash(params);
  const [existing] = await pool.query(
    `SELECT id, status FROM pic_report_jobs
      WHERE report_type = ? AND params_hash = ? AND status IN ('queued','running')
        AND created_at > (NOW() - INTERVAL 30 MINUTE)
      ORDER BY created_at DESC LIMIT 1`,
    [reportType, hash]
  );
  if (existing.length) return { id: existing[0].id, reused: true };

  const [result] = await pool.query(
    `INSERT INTO pic_report_jobs (report_type, params_hash, params_json, requested_by, status)
     VALUES (?, ?, ?, ?, 'queued')`,
    [reportType, hash, JSON.stringify(params), userId || null]
  );

  cleanupOldJobs().catch((e) => console.error('[picReportJobs] cleanup failed:', e.message));

  return { id: result.insertId, reused: false };
}

async function getJob(jobId) {
  const [rows] = await pool.query('SELECT * FROM pic_report_jobs WHERE id = ?', [jobId]);
  return rows[0] || null;
}

async function markRunning(jobId) {
  await pool.query("UPDATE pic_report_jobs SET status='running', started_at=NOW() WHERE id=?", [jobId]);
}
async function markDone(jobId, { gcsKey, filename, rowCount }) {
  await pool.query(
    "UPDATE pic_report_jobs SET status='done', finished_at=NOW(), gcs_key=?, filename=?, row_count=? WHERE id=?",
    [gcsKey, filename, rowCount, jobId]
  );
}
async function markFailed(jobId, err) {
  await pool.query(
    "UPDATE pic_report_jobs SET status='failed', finished_at=NOW(), message=? WHERE id=?",
    [String((err && err.message) || err).slice(0, 490), jobId]
  );
}

// Fire the self-call that actually runs the report inside a fresh request (CPU
// stays allocated for the duration). Falls back to an inline run if the self-call
// infra isn't configured (may be CPU-throttled on Cloud Run — acceptable stopgap).
function fireSelfCall(jobId) {
  const base = envv('SERVICE_BASE_URL');
  const secret = envv('PM_CRON_SECRET');
  if (!base || !secret) {
    console.warn('[picReportJobs] SERVICE_BASE_URL/PM_CRON_SECRET not set — running job inline (may be CPU-throttled)');
    processJob(jobId).catch((e) => console.error('[picReportJobs] inline run failed:', e.message));
    return;
  }
  const url = base.replace(/\/+$/, '') + '/internal/run-pic-report-job';
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
    body: JSON.stringify({ job_id: jobId }),
  }).then((r) => {
    console.log(`[picReportJobs] self-call dispatched for job ${jobId} (status ${r.status})`);
  }).catch((e) => {
    console.error('[picReportJobs] self-call dispatch failed:', e.message);
  });
}

// Build the report and upload it to GCS. `params` mirrors what the route handlers
// already pass to buildPicSizeRows — reportType picks the right filename shape.
async function processJob(jobId) {
  const job = await getJob(jobId);
  if (!job || job.status !== 'queued') return; // already claimed/finished
  await markRunning(jobId);

  try {
    const params = JSON.parse(job.params_json);
    const rows = await buildPicSizeRows(params);

    const chunks = [];
    const fakeRes = { write: (s) => chunks.push(s), end: () => {} };
    writePicSizeCsv(fakeRes, rows);
    const csvBuffer = Buffer.from(chunks.join(''), 'utf8');

    const safeStyle = params.style ? params.style.replace(/[^A-Za-z0-9._-]/g, '_') : '';
    const filename = job.report_type === 'pm_in_production'
      ? `PICReport-InProduction-${safeStyle || 'AllStyles'}-BySize.csv`
      : `PICReport-BySize-${new Date().toISOString().split('T')[0]}.csv`;
    const gcsKey = `pic-report-jobs/${jobId}-${filename}`;

    await gcs.putObject(gcsKey, csvBuffer, { contentType: 'text/csv; charset=utf-8' });
    await markDone(jobId, { gcsKey, filename, rowCount: rows.length });
  } catch (err) {
    await markFailed(jobId, err);
    throw err;
  }
}

async function cleanupOldJobs() {
  const [old] = await pool.query(
    `SELECT id, gcs_key FROM pic_report_jobs WHERE created_at < (NOW() - INTERVAL ? DAY)`,
    [JOB_TTL_DAYS]
  );
  if (!old.length) return;
  for (const j of old) {
    if (j.gcs_key) await gcs.deleteObject(j.gcs_key).catch(() => {});
  }
  await pool.query(`DELETE FROM pic_report_jobs WHERE created_at < (NOW() - INTERVAL ? DAY)`, [JOB_TTL_DAYS]);
}

// POST /internal/run-pic-report-job — secret-gated (mirrors /internal/run-pull).
async function internalRunJobHandler(req, res) {
  const secret = envv('PM_CRON_SECRET');
  if (!secret || req.get('x-cron-secret') !== secret) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const jobId = req.body && req.body.job_id;
  if (!jobId) return res.status(400).json({ ok: false, error: 'job_id required' });
  try {
    await processJob(jobId);
    return res.json({ ok: true, job_id: jobId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = {
  createOrReuseJob,
  getJob,
  fireSelfCall,
  processJob,
  internalRunJobHandler,
};
