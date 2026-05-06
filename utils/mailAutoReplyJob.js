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

async function isAlreadyReplied(messageId) {
  const [[row]] = await pool.query(
    `SELECT status FROM mail_replies WHERE message_id = ? LIMIT 1`,
    [messageId]
  );
  return row && row.status === 'replied';
}

async function lookupAwbForOrder(orderId) {
  if (!orderId) return null;

  // (1) order_awb_mapping (manual Excel upload)
  const [[mapped]] = await pool.query(
    `SELECT awb FROM order_awb_mapping WHERE order_id = ? LIMIT 1`,
    [orderId.toUpperCase()]
  );
  if (mapped?.awb) return { awb: mapped.awb, source: 'mapping' };

  // (2) ee_orders.reference_code (the Ajio customer order number) → ee_shipments
  const [[ref]] = await pool.query(
    `SELECT s.awb
       FROM ee_orders o
       JOIN ee_shipments s ON s.order_id = o.order_id
      WHERE UPPER(o.reference_code) = UPPER(?)
        AND o.marketplace LIKE '%ajio%'
      ORDER BY s.updated_at DESC
      LIMIT 1`,
    [orderId]
  );
  if (ref?.awb) return { awb: ref.awb, source: 'ee_shipments' };

  return null;
}

async function recordInitial(email, classification, orderId) {
  await pool.query(
    `INSERT INTO mail_replies
       (message_id, thread_id, from_address, to_address, subject, order_id,
        status, classification)
     VALUES (?, ?, ?, ?, ?, ?, 'initial', ?)
     ON DUPLICATE KEY UPDATE
       order_id = COALESCE(VALUES(order_id), order_id),
       classification = COALESCE(VALUES(classification), classification)`,
    [
      email.messageId, email.threadId || null,
      email.fromAddress || null, email.toAddress || null,
      (email.subject || '').slice(0, 500),
      orderId || null, classification || null,
    ]
  );
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

async function processOneEmail(email, stats) {
  // Skip our own outbound mails (anti-loop)
  if ((email.fromAddress || '').toLowerCase().includes(OUR_SENDER)) {
    stats.skipped_own++;
    return;
  }

  if (await isAlreadyReplied(email.messageId)) {
    stats.skipped_already_replied++;
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
  await recordInitial(email, classification, details.orderId);

  if (!details.orderId) {
    stats.skipped_no_order_id++;
    return;
  }

  const awbResult = await lookupAwbForOrder(details.orderId);
  if (!awbResult) {
    stats.skipped_no_awb++;
    return;
  }

  const video = await findVideoByAwb(awbResult.awb);
  if (!video) {
    stats.skipped_no_video++;
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

async function runMailAutoReply() {
  if (!zohoMail.isConfigured()) {
    console.log('[mailAutoReply] Zoho not configured, skipping');
    return { skipped: 'not_configured' };
  }
  const startedAt = Date.now();
  const stats = {
    fetched: 0, processed: 0, replied: 0, errors: 0,
    skipped_own: 0, skipped_already_replied: 0,
    skipped_no_order_id: 0, skipped_no_awb: 0, skipped_no_video: 0,
  };

  let emails = [];
  try {
    emails = await zohoMail.getEmails('inbox', MAX_EMAILS_PER_RUN, 0);
  } catch (err) {
    console.error('[mailAutoReply] fetch failed:', err.message);
    return { error: err.message };
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
      await processOneEmail(email, stats);
    } catch (err) {
      stats.errors++;
      console.error('[mailAutoReply] error on', email.messageId, err.message);
    }
  }

  console.log(`[mailAutoReply] done in ${Date.now() - startedAt}ms`, stats);
  return stats;
}

module.exports = { runMailAutoReply };
