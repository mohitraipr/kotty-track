// Mail auto-reply cron — at 9 AM and 9 PM IST.
//
// Picks Zoho inbox emails (last N days) that haven't been replied to,
// resolves AWB via:
//   (1) order_awb_mapping (Excel uploads)
//   (2) ee_orders.reference_code (Ajio order # → order_id → ee_shipments.awb)
//   (3) skipped — kept for the next run / manual intervention
// then checks S3 for a matching video and replies via Zoho if found.

const { pool } = require('../config/db');
const zohoMail = require('./zohoMailClient');
const { findVideoByAwb, formatFileSize } = require('./s3Client');

const LOOKBACK_DAYS = parseInt(process.env.MAIL_REPLY_LOOKBACK_DAYS || '7', 10);
const MAX_EMAILS_PER_RUN = parseInt(process.env.MAIL_REPLY_MAX_PER_RUN || '200', 10);
const OUR_SENDER = (process.env.OUR_SENDER_EMAIL || 'sales@kotty.in').toLowerCase();
// Search terms run against Zoho's /messages/search with searchKey
// entire:<term>::in:Inbox. Comma-separated env override. Each term is
// queried once per run and results are de-duplicated by message_id.
// 'cctv' covers Ajio CCTV-footage requests which is the main target.
const SEARCH_TERMS = (process.env.MAIL_REPLY_SEARCH_TERMS || 'cctv').split(',').map(s => s.trim()).filter(Boolean);

async function isAlreadyReplied(messageId) {
  const [[row]] = await pool.query(
    `SELECT status FROM mail_replies WHERE message_id = ? LIMIT 1`,
    [messageId]
  );
  return row && row.status === 'replied';
}

async function lookupAwbForOrder(orderId) {
  if (!orderId) return null;

  // (1) vmsOperator AWB upload sheet (primary source)
  const [[upload]] = await pool.query(
    `SELECT awb FROM vms_awb_uploads
      WHERE UPPER(customer_order_id) = UPPER(?)
      ORDER BY created_at DESC LIMIT 1`,
    [orderId]
  );
  if (upload?.awb) return { awb: upload.awb, source: 'vms_uploads' };

  // (2) order_awb_mapping (legacy manual Excel via Mail Manager)
  const [[mapped]] = await pool.query(
    `SELECT awb FROM order_awb_mapping WHERE order_id = ? LIMIT 1`,
    [orderId.toUpperCase()]
  );
  if (mapped?.awb) return { awb: mapped.awb, source: 'mapping' };

  return null;
}

async function recordInitial(email, classification, orderId, runId = null) {
  await pool.query(
    `INSERT INTO mail_replies
       (message_id, thread_id, from_address, to_address, subject, order_id,
        status, classification, run_id)
     VALUES (?, ?, ?, ?, ?, ?, 'initial', ?, ?)
     ON DUPLICATE KEY UPDATE
       order_id = COALESCE(VALUES(order_id), order_id),
       classification = COALESCE(VALUES(classification), classification),
       run_id = VALUES(run_id)`,
    [
      email.messageId, email.threadId || null,
      email.fromAddress || null, email.toAddress || null,
      (email.subject || '').slice(0, 500),
      orderId || null, classification || null, runId,
    ]
  );
}

async function markSkipped(messageId, skipReason, runId) {
  // Update the most-recent row for this email with the reason it stayed in
  // 'initial' on this run. Safe to call multiple times — only sets when row
  // still in 'initial' so we never overwrite a successful 'replied' state.
  try {
    await pool.query(
      `UPDATE mail_replies
         SET skip_reason = ?, run_id = COALESCE(?, run_id)
       WHERE message_id = ? AND status = 'initial'`,
      [skipReason, runId, messageId]
    );
  } catch (_) { /* best-effort */ }
}

async function recordReplied(email, orderId, awb, videoUrl) {
  await pool.query(
    `INSERT INTO mail_replies
       (message_id, thread_id, from_address, to_address, subject, order_id,
        awb, video_url, status, replied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'replied', NOW())
     ON DUPLICATE KEY UPDATE
       awb = VALUES(awb),
       video_url = VALUES(video_url),
       order_id = COALESCE(VALUES(order_id), order_id),
       status = 'replied',
       replied_at = NOW()`,
    [
      email.messageId, email.threadId || null,
      email.fromAddress || null, email.toAddress || null,
      (email.subject || '').slice(0, 500),
      orderId || null, awb, videoUrl,
    ]
  );
}

async function processOneEmail(email, stats, runId) {
  // Skip our own outbound mails (anti-loop)
  if ((email.fromAddress || '').toLowerCase().includes(OUR_SENDER)) {
    stats.skipped_own++;
    // don't even write a row for our own mails — too noisy
    return;
  }

  if (await isAlreadyReplied(email.messageId)) {
    stats.skipped_already_replied++;
    await markSkipped(email.messageId, 'already_replied', runId);
    return;
  }

  // Get full body for order-id extraction
  let bodyText = email.summary || '';
  try {
    const content = await zohoMail.getEmailContent(email.messageId);
    bodyText = content?.content || content?.body || bodyText;
  } catch (err) {
    // continue with summary if fetch fails
  }

  const details = zohoMail.extractOrderDetails(bodyText, email.subject || '');
  const classification = zohoMail.classifyEmail(email.subject || '', bodyText);
  await recordInitial(email, classification, details.orderId, runId);

  if (!details.orderId) {
    stats.skipped_no_order_id++;
    await markSkipped(email.messageId, 'no_order_id', runId);
    return;
  }

  const awbResult = await lookupAwbForOrder(details.orderId);
  if (!awbResult) {
    stats.skipped_no_awb++;
    await markSkipped(email.messageId, 'no_awb', runId);
    return;
  }

  const video = await findVideoByAwb(awbResult.awb);
  if (!video) {
    stats.skipped_no_video++;
    await markSkipped(email.messageId, 'no_video', runId);
    return;
  }

  // Send reply
  try {
    const html = zohoMail.buildVideoReplyHtml(details.orderId, [{
      awb: awbResult.awb,
      url: video.url,
      filename: video.key.split('/').pop(),
    }]);
    await zohoMail.sendReply(
      email.messageId,
      email.threadId,
      email.fromAddress,
      email.subject || `Re: Order ${details.orderId}`,
      html,
      ''
    );
    await recordReplied(email, details.orderId, awbResult.awb, video.url);
    stats.replied++;
  } catch (err) {
    stats.errors++;
    console.error(`[mailAutoReply] reply failed for ${email.messageId}:`, err.message);
  }
}

async function startRun({ triggeredBy = 'cron', userId = null } = {}) {
  try {
    const [result] = await pool.query(
      `INSERT INTO mail_reply_runs (started_at, triggered_by, triggered_user_id)
       VALUES (NOW(), ?, ?)`,
      [triggeredBy, userId]
    );
    return result.insertId;
  } catch (err) {
    // table may not exist yet on a server that hasn't run the migration —
    // log once, never throw. The cron still works without the run log.
    if (!startRun._warned) {
      console.warn('[mailAutoReply] could not insert run row (table missing?)', err.message);
      startRun._warned = true;
    }
    return null;
  }
}

async function finishRun(runId, stats, errorMessage = null) {
  if (!runId) return;
  try {
    await pool.query(
      `UPDATE mail_reply_runs
         SET finished_at = NOW(),
             fetched = ?, processed = ?, replied = ?, errors = ?,
             skipped_own = ?, skipped_already_replied = ?,
             skipped_no_order_id = ?, skipped_no_awb = ?, skipped_no_video = ?,
             duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, NOW()) DIV 1000,
             error_message = ?,
             stats_json = ?
       WHERE id = ?`,
      [
        stats.fetched, stats.processed, stats.replied, stats.errors,
        stats.skipped_own, stats.skipped_already_replied,
        stats.skipped_no_order_id, stats.skipped_no_awb, stats.skipped_no_video,
        errorMessage, JSON.stringify(stats), runId,
      ]
    );
  } catch (_) { /* best-effort */ }
}

// Coerce any thrown value to a useful string. zohoMailClient.makeRequest
// rejects with a plain {status, data} object — not an Error — so a naive
// `err.message` gives 'undefined' and we lose the actual Zoho response.
function errToString(err) {
  if (!err) return 'unknown';
  if (err.message) return String(err.message);
  if (err.status || err.data) {
    let body;
    try { body = typeof err.data === 'string' ? err.data : JSON.stringify(err.data); }
    catch (_) { body = '[unserializable]'; }
    return `HTTP ${err.status || '?'}: ${String(body || '').slice(0, 800)}`;
  }
  try { return JSON.stringify(err).slice(0, 800); } catch (_) { return String(err); }
}

async function runMailAutoReply({ triggeredBy = 'cron', userId = null } = {}) {
  const startedAt = Date.now();
  const stats = {
    fetched: 0, processed: 0, replied: 0, errors: 0,
    skipped_own: 0, skipped_already_replied: 0,
    skipped_no_order_id: 0, skipped_no_awb: 0, skipped_no_video: 0,
  };

  // Persist the run row FIRST — even failed runs (zoho misconfigured, fetch
  // failed, etc.) should be visible on the dashboard so the operator sees
  // "Last run: FAILED — <reason>" instead of an empty card.
  const runId = await startRun({ triggeredBy, userId });

  if (!zohoMail.isConfigured()) {
    const msg = 'Zoho not configured: set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN';
    console.log('[mailAutoReply]', msg);
    await finishRun(runId, stats, msg);
    return { error: msg, run_id: runId };
  }

  // Use the /messages/search endpoint (the only inbox-listing endpoint
  // that reliably works on Zoho's IN data center for this account).
  // Run each search term, de-dup by message_id.
  const seenIds = new Set();
  let emails = [];
  try {
    for (const term of SEARCH_TERMS) {
      const batch = await zohoMail.searchEmails(term, MAX_EMAILS_PER_RUN, 0, 'Inbox');
      for (const e of (batch || [])) {
        if (!e.messageId || seenIds.has(e.messageId)) continue;
        seenIds.add(e.messageId);
        emails.push(e);
      }
    }
  } catch (err) {
    const msg = errToString(err);
    console.error('[mailAutoReply] fetch failed:', msg);
    await finishRun(runId, stats, msg);
    return { error: msg, run_id: runId };
  }
  stats.fetched = emails.length;

  // Filter to last LOOKBACK_DAYS
  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const recent = emails.filter((e) => {
    const t = parseInt(e.receivedTime || e.receivedAt || '0', 10);
    return t > cutoff;
  });

  for (const email of recent) {
    stats.processed++;
    try {
      await processOneEmail(email, stats, runId);
    } catch (err) {
      stats.errors++;
      await markSkipped(email.messageId, 'error', runId);
      console.error('[mailAutoReply] error on', email.messageId, errToString(err));
    }
  }

  await finishRun(runId, stats, null);
  console.log(`[mailAutoReply] done in ${Date.now() - startedAt}ms run=${runId}`, stats);
  return { ...stats, run_id: runId };
}

module.exports = { runMailAutoReply };
