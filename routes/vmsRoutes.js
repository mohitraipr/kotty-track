// VMS (AWB Video Recorder) — server side.
// Browser records video, uploads via presigned PUT directly to S3,
// then confirms via /confirm so we can persist a row in vms_videos.

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isVideoCreator } = require('../middlewares/auth');
const {
  generatePresignedPutUrl,
  generatePresignedUrl,
  headObject,
  S3_BUCKET,
  S3_PREFIX,
} = require('../utils/s3Client');

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024; // 250 MB hard cap
const MAX_DURATION_MS = 2 * 60 * 1000;       // 2 min hard cap (matches client)

// ---------- helpers ----------
function sanitizeChunk(s) {
  return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}

function buildKey({ awb, packerName, marketplace, ext }) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD (folder)
  const compactDate = datePart.replace(/-/g, '');
  let hh = now.getHours();
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12 || 12;
  const timePart = `${String(hh).padStart(2, '0')}-${mm}-${ss}_${ampm}`;
  const file = `${sanitizeChunk(packerName)}_${sanitizeChunk(awb)}_${compactDate}_${timePart}.${ext}`;
  const folder = `${S3_PREFIX || ''}${datePart}/`;
  return `${folder}${file}`;
}

function pickExtensionFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogv';
  return 'bin';
}

// ---------- page ----------
router.get('/', isAuthenticated, isVideoCreator, (req, res) => {
  res.render('vmsRecorder', {
    user: req.session.user,
  });
});

// ---------- server time (watermark) ----------
// Returned as ISO so the client can compute a fixed offset and refuse to
// trust the local clock for the watermark.
router.get('/api/server-time', isAuthenticated, isVideoCreator, (req, res) => {
  res.json({ now: new Date().toISOString() });
});

// ---------- AWB list ----------
// Pending = AWBs uploaded by vmsOperator that don't yet have a video.
router.get('/api/awbs', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const [rows] = await pool.query(
      `SELECT u.awb,
              u.marketplace,
              u.customer_order_id  AS reference_code,
              u.created_at         AS label_printed_at,
              CASE WHEN v.id IS NULL THEN 'Pending' ELSE 'Recorded' END AS current_status,
              v.id IS NOT NULL AS has_video
         FROM vms_awb_uploads u
         LEFT JOIN vms_videos v ON v.awb = u.awb
        WHERE u.created_at >= NOW() - INTERVAL ? DAY
        ORDER BY u.created_at DESC
        LIMIT 5000`,
      [days]
    );
    res.json({
      ok: true,
      total: rows.length,
      pending: rows.filter((r) => !r.has_video).length,
      rows,
    });
  } catch (err) {
    console.error('VMS awbs error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Lookup a single AWB. Used by the recorder to warn if the AWB hasn't
// been uploaded by vmsOperator yet (still allow recording — won't block
// the packer — but flag it on the UI).
router.get('/api/awb/:awb', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const awb = String(req.params.awb || '').trim();
    if (!awb) return res.status(400).json({ ok: false, error: 'awb required' });
    const [[uploaded]] = await pool.query(
      `SELECT awb, customer_order_id AS reference_code, marketplace, created_at AS label_printed_at,
              'Pending' AS current_status
         FROM vms_awb_uploads WHERE awb = ? LIMIT 1`,
      [awb]
    );
    const [[video]] = await pool.query(
      `SELECT id, s3_key, created_at FROM vms_videos WHERE awb = ? LIMIT 1`,
      [awb]
    );
    res.json({ ok: true, awb, shipment: uploaded || null, video: video || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- upload URL ----------
router.post('/api/upload-url', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const awb = String(req.body?.awb || '').trim();
    const packerName = String(req.body?.packerName || req.session.user?.username || 'unknown').trim();
    const marketplace = String(req.body?.marketplace || '').trim();
    const mimeType = String(req.body?.mimeType || 'video/webm').trim();

    if (!awb) return res.status(400).json({ ok: false, error: 'awb required' });
    if (!marketplace) return res.status(400).json({ ok: false, error: 'marketplace required' });

    // Reject re-upload (UNIQUE on awb in vms_videos enforces it too, but
    // surface a friendly error before the upload happens).
    const [[existing]] = await pool.query(
      `SELECT id FROM vms_videos WHERE awb = ? LIMIT 1`,
      [awb]
    );
    if (existing) {
      return res.status(409).json({ ok: false, error: 'video_already_exists', awb });
    }

    const ext = pickExtensionFromMime(mimeType);
    const key = buildKey({ awb, packerName, marketplace, ext });
    const url = await generatePresignedPutUrl(key, mimeType, 900);
    res.json({
      ok: true,
      key,
      url,
      bucket: S3_BUCKET,
      expiresInSeconds: 900,
      contentType: mimeType,
    });
  } catch (err) {
    console.error('VMS upload-url error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- confirm ----------
// After the browser PUTs to S3 it calls this to record the video.
// We HEAD the object to verify it actually arrived at the expected key
// before inserting — prevents fake "I uploaded" calls.
router.post('/api/confirm', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const {
      awb,
      key,
      marketplace,
      packerName,
      mimeType,
      durationMs,
      clientStartedAt,
    } = req.body || {};

    if (!awb || !key) return res.status(400).json({ ok: false, error: 'awb and key required' });
    if (!key.endsWith('.webm') && !key.endsWith('.mp4') && !key.endsWith('.ogv')) {
      return res.status(400).json({ ok: false, error: 'unexpected key extension' });
    }
    if (durationMs && durationMs > MAX_DURATION_MS + 5000) {
      return res.status(400).json({ ok: false, error: 'video too long' });
    }

    const head = await headObject(key);
    if (!head.exists) {
      return res.status(404).json({ ok: false, error: 'object_not_found_in_s3', key });
    }
    if (head.size > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: 'object_too_large', size: head.size });
    }

    try {
      await pool.query(
        `INSERT INTO vms_videos
           (awb, marketplace, packer_id, packer_name, s3_bucket, s3_key,
            size_bytes, mime_type, duration_ms,
            client_started_at, server_started_at, server_finished_at,
            ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
        [
          awb.trim(),
          marketplace || null,
          req.session.user?.id || null,
          packerName || req.session.user?.username || null,
          S3_BUCKET,
          key,
          head.size,
          mimeType || head.contentType || null,
          durationMs || null,
          clientStartedAt ? new Date(clientStartedAt) : null,
          // server_started_at — we don't know the exact moment recording began;
          // approximate from now - duration so we can sanity-check later.
          durationMs ? new Date(Date.now() - durationMs) : null,
          (req.headers['x-forwarded-for'] || req.ip || '').toString().slice(0, 64),
          (req.headers['user-agent'] || '').toString().slice(0, 500),
        ]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ ok: false, error: 'video_already_exists', awb });
      }
      throw err;
    }

    res.json({ ok: true, awb, key });
  } catch (err) {
    console.error('VMS confirm error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- recent uploads (for the recorder UI) ----------
router.get('/api/recent', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const [rows] = await pool.query(
      `SELECT id, awb, marketplace, packer_name, s3_key, size_bytes, duration_ms, created_at
         FROM vms_videos
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit]
    );
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generate a fresh GET presign for playback
router.get('/api/playback-url', isAuthenticated, isVideoCreator, async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    const url = await generatePresignedUrl(key);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
