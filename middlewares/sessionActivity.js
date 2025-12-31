// middlewares/sessionActivity.js
//
// Tracks login activity and keeps a heartbeat of the user's session.

const { pool } = require("../config/db");

const ACTIVITY_UPDATE_INTERVAL_MS = 60 * 1000;
const MAX_IDLE_CREDIT_MS = 5 * 60 * 1000; // Cap idle gaps so we only count realistic screen time

function calculateActiveSeconds(now, lastUpdate) {
  const elapsedMs = now - (lastUpdate || 0);
  if (elapsedMs <= 0) return 0;

  const boundedMs = Math.min(elapsedMs, MAX_IDLE_CREDIT_MS);
  return Math.floor(boundedMs / 1000);
}

/**
 * Update the last_activity_time for the active session log.
 * Throttled to once per ACTIVITY_UPDATE_INTERVAL_MS to reduce DB writes.
 */
async function markSessionActivity(req, res, next) {
  try {
    const sessionLogId = req.session?.sessionLogId;
    if (!sessionLogId) return next();

    const now = Date.now();
    const lastUpdate = req.session.lastActivityUpdate || 0;
    if (now - lastUpdate < ACTIVITY_UPDATE_INTERVAL_MS) return next();

    const incrementSeconds = calculateActiveSeconds(now, lastUpdate);
    req.session.lastActivityUpdate = now;

    await pool.query(
      `
        UPDATE user_session_logs
           SET last_activity_time = NOW(),
               duration_seconds = duration_seconds + ?
         WHERE id = ?
      `,
      [incrementSeconds, sessionLogId]
    );
    return next();
  } catch (err) {
    console.error("Error updating session activity:", err);
    return next();
  }
}

/**
 * Finalize the session log on logout or session destruction.
 */
async function closeSessionLog(sessionLogId, lastActivityUpdate) {
  if (!sessionLogId) return;
  try {
    const now = Date.now();
    const incrementSeconds = calculateActiveSeconds(now, lastActivityUpdate || now);

    await pool.query(
      `
        UPDATE user_session_logs
           SET last_activity_time = NOW(),
               logout_time = NOW(),
               duration_seconds = GREATEST(
                 duration_seconds + ?,
                 TIMESTAMPDIFF(SECOND, login_time, NOW())
               )
         WHERE id = ? AND logout_time IS NULL
      `,
      [incrementSeconds, sessionLogId]
    );
  } catch (err) {
    console.error("Error closing session log:", err);
  }
}

module.exports = {
  markSessionActivity,
  closeSessionLog,
};
