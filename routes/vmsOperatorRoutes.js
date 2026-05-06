// vmsOperator dashboard
// - Upload AWB list (Excel/CSV) into vms_awb_uploads
// - Browse mails (replied / unreplied / closed) from mail_replies
// - Browse video uploads
// - Per-packer counts
// - Each list exportable to Excel

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { isAuthenticated, isVmsOperator } = require('../middlewares/auth');
const { generatePresignedUrl } = require('../utils/s3Client');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ---------- helpers ----------
function findColIndex(headerRow, names) {
  const lc = headerRow.map((h) => String(h || '').trim().toLowerCase());
  for (const n of names) {
    const idx = lc.indexOf(n.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseSheet(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (!rows.length) return { rows: [] };
  const header = rows[0];
  const awbIdx = findColIndex(header, ['awb', 'awb number', 'awb_number', 'tracking', 'tracking number']);
  const orderIdx = findColIndex(header, ['customer order id', 'customer_order_id', 'order id', 'order_id', 'ajio order', 'ajio order number']);
  const mktIdx = findColIndex(header, ['marketplace', 'channel', 'platform']);
  const noteIdx = findColIndex(header, ['notes', 'note', 'remarks']);
  if (awbIdx === -1) return { rows: [], error: 'No AWB column found' };
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const awb = String(r[awbIdx] || '').trim();
    if (!awb) continue;
    out.push({
      awb,
      customer_order_id: orderIdx !== -1 ? String(r[orderIdx] || '').trim() || null : null,
      marketplace: mktIdx !== -1 ? String(r[mktIdx] || '').trim() || null : null,
      notes: noteIdx !== -1 ? String(r[noteIdx] || '').trim() || null : null,
    });
  }
  return { rows: out };
}

async function exportRowsAsXlsx(res, name, columns, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name.slice(0, 30));
  ws.columns = columns;
  for (const r of rows) ws.addRow(r);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}_${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

// ---------- page ----------
router.get('/', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const [[counts]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM vms_awb_uploads) AS uploaded_awbs,
        (SELECT COUNT(*) FROM vms_videos)     AS total_videos,
        (SELECT COUNT(*) FROM mail_replies WHERE status='replied')                       AS mails_replied,
        (SELECT COUNT(*) FROM mail_replies WHERE status IN ('initial','proceeding'))     AS mails_unreplied,
        (SELECT COUNT(*) FROM mail_replies WHERE status='closed')                        AS mails_closed
    `);
    res.render('vmsOperator', { user: req.session.user, counts });
  } catch (err) {
    console.error('vmsOperator dashboard error:', err);
    res.status(500).send('Failed: ' + err.message);
  }
});

// ---------- upload AWB sheet ----------
router.post('/api/upload', isAuthenticated, isVmsOperator, upload.single('awbFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    const { rows, error } = parseSheet(req.file.buffer);
    if (error) return res.status(400).json({ ok: false, error });
    if (!rows.length) return res.status(400).json({ ok: false, error: 'No AWBs found in file' });

    const userId = req.session.user?.id || null;
    const sourceFile = (req.file.originalname || 'upload').slice(0, 255);

    const values = rows.map((r) => [r.awb, r.customer_order_id, r.marketplace, r.notes, userId, sourceFile]);
    await pool.query(
      `INSERT INTO vms_awb_uploads (awb, customer_order_id, marketplace, notes, uploaded_by, source_file)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         customer_order_id = COALESCE(VALUES(customer_order_id), customer_order_id),
         marketplace       = COALESCE(VALUES(marketplace), marketplace),
         notes             = COALESCE(VALUES(notes), notes),
         uploaded_by       = COALESCE(VALUES(uploaded_by), uploaded_by),
         source_file       = COALESCE(VALUES(source_file), source_file)`,
      [values]
    );
    res.json({ ok: true, received: rows.length });
  } catch (err) {
    console.error('vmsOperator upload error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- AWB uploads list ----------
router.get('/api/awbs', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
    const [rows] = await pool.query(`
      SELECT u.awb, u.customer_order_id, u.marketplace, u.notes,
             u.created_at, u.source_file,
             usr.username AS uploaded_by_name,
             v.id IS NOT NULL AS has_video,
             v.created_at AS video_at, v.packer_name
      FROM vms_awb_uploads u
      LEFT JOIN users usr ON usr.id = u.uploaded_by
      LEFT JOIN vms_videos v ON v.awb = u.awb
      ORDER BY u.created_at DESC
      LIMIT ?`, [limit]);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/awbs/export.xlsx', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.awb, u.customer_order_id, u.marketplace, u.notes,
             u.created_at, u.source_file,
             usr.username AS uploaded_by_name,
             v.id IS NOT NULL AS has_video, v.created_at AS video_at, v.packer_name
      FROM vms_awb_uploads u
      LEFT JOIN users usr ON usr.id = u.uploaded_by
      LEFT JOIN vms_videos v ON v.awb = u.awb
      ORDER BY u.created_at DESC LIMIT 50000`);
    await exportRowsAsXlsx(res, 'vms_awbs', [
      { header: 'AWB', key: 'awb', width: 22 },
      { header: 'Customer Order ID', key: 'customer_order_id', width: 22 },
      { header: 'Marketplace', key: 'marketplace', width: 14 },
      { header: 'Has Video', key: 'has_video', width: 10 },
      { header: 'Video At', key: 'video_at', width: 20 },
      { header: 'Packer', key: 'packer_name', width: 16 },
      { header: 'Uploaded By', key: 'uploaded_by_name', width: 16 },
      { header: 'Source File', key: 'source_file', width: 30 },
      { header: 'Uploaded At', key: 'created_at', width: 20 },
      { header: 'Notes', key: 'notes', width: 30 },
    ], rows);
  } catch (err) { res.status(500).send(err.message); }
});

// ---------- mails ----------
const MAIL_BUCKETS = {
  replied:    `status='replied'`,
  unreplied:  `status IN ('initial','proceeding')`,
  closed:     `status='closed'`,
};

router.get('/api/mails/:bucket', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const where = MAIL_BUCKETS[req.params.bucket];
    if (!where) return res.status(400).json({ ok: false, error: 'unknown bucket' });
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
    const [rows] = await pool.query(`
      SELECT id, message_id, thread_id, from_address, to_address, subject,
             order_id, awb, video_url, status, classification,
             replied_at, created_at
      FROM mail_replies
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`, [limit]);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/mails/:bucket/export.xlsx', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const where = MAIL_BUCKETS[req.params.bucket];
    if (!where) return res.status(400).send('unknown bucket');
    const [rows] = await pool.query(`
      SELECT id, message_id, from_address, to_address, subject,
             order_id, awb, video_url, status, classification,
             replied_at, created_at
      FROM mail_replies WHERE ${where}
      ORDER BY created_at DESC LIMIT 50000`);
    await exportRowsAsXlsx(res, `mails_${req.params.bucket}`, [
      { header: 'Created', key: 'created_at', width: 20 },
      { header: 'From', key: 'from_address', width: 28 },
      { header: 'Subject', key: 'subject', width: 50 },
      { header: 'Order ID', key: 'order_id', width: 18 },
      { header: 'AWB', key: 'awb', width: 22 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Classification', key: 'classification', width: 18 },
      { header: 'Replied At', key: 'replied_at', width: 20 },
      { header: 'Video URL', key: 'video_url', width: 60 },
      { header: 'Message ID', key: 'message_id', width: 36 },
    ], rows);
  } catch (err) { res.status(500).send(err.message); }
});

// ---------- videos ----------
router.get('/api/videos', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '500', 10), 5000);
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const args = [];
    let dateClause = '';
    if (fromDate) { dateClause += ' AND v.created_at >= ?'; args.push(fromDate); }
    if (toDate)   { dateClause += ' AND v.created_at < ?';  args.push(toDate); }

    const [rows] = await pool.query(`
      SELECT v.id, v.awb, v.marketplace, v.packer_name, v.s3_bucket, v.s3_key,
             v.size_bytes, v.duration_ms, v.created_at, u.username AS packer_username
      FROM vms_videos v
      LEFT JOIN users u ON u.id = v.packer_id
      WHERE 1=1 ${dateClause}
      ORDER BY v.created_at DESC
      LIMIT ?`, [...args, limit]);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/videos/export.xlsx', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const includeUrls = req.query.includeUrls === '1';
    const args = [];
    let dateClause = '';
    if (fromDate) { dateClause += ' AND v.created_at >= ?'; args.push(fromDate); }
    if (toDate)   { dateClause += ' AND v.created_at < ?';  args.push(toDate); }

    const [rows] = await pool.query(`
      SELECT v.awb, v.marketplace, v.packer_name, u.username AS packer_username,
             v.s3_bucket, v.s3_key, v.size_bytes, v.duration_ms, v.created_at
      FROM vms_videos v
      LEFT JOIN users u ON u.id = v.packer_id
      WHERE 1=1 ${dateClause}
      ORDER BY v.created_at DESC LIMIT 50000`, args);

    if (includeUrls) {
      // Generate fresh presigned URLs for each row. Slow on huge exports;
      // capped at 5000 to avoid timing out.
      const cap = Math.min(rows.length, 5000);
      for (let i = 0; i < cap; i++) {
        try { rows[i].video_url = await generatePresignedUrl(rows[i].s3_key); }
        catch (e) { rows[i].video_url = ''; }
      }
    }

    const cols = [
      { header: 'Created', key: 'created_at', width: 20 },
      { header: 'AWB', key: 'awb', width: 22 },
      { header: 'Marketplace', key: 'marketplace', width: 14 },
      { header: 'Packer', key: 'packer_name', width: 16 },
      { header: 'Packer (user)', key: 'packer_username', width: 16 },
      { header: 'Size', key: 'size_bytes', width: 12 },
      { header: 'Duration (ms)', key: 'duration_ms', width: 14 },
      { header: 'S3 Key', key: 's3_key', width: 60 },
    ];
    if (includeUrls) cols.push({ header: 'Video URL (15-min)', key: 'video_url', width: 100 });
    await exportRowsAsXlsx(res, 'vms_videos', cols, rows);
  } catch (err) { res.status(500).send(err.message); }
});

// ---------- per-packer counts ----------
router.get('/api/packer-counts', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const args = [];
    let dateClause = '';
    if (fromDate) { dateClause += ' AND v.created_at >= ?'; args.push(fromDate); }
    if (toDate)   { dateClause += ' AND v.created_at < ?';  args.push(toDate); }
    const [rows] = await pool.query(`
      SELECT COALESCE(u.username, v.packer_name, 'unknown') AS packer,
             COUNT(*) AS video_count,
             MIN(v.created_at) AS first_at,
             MAX(v.created_at) AS last_at
      FROM vms_videos v
      LEFT JOIN users u ON u.id = v.packer_id
      WHERE 1=1 ${dateClause}
      GROUP BY packer
      ORDER BY video_count DESC`, args);
    res.json({ ok: true, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/packer-counts/export.xlsx', isAuthenticated, isVmsOperator, async (req, res) => {
  try {
    const fromDate = req.query.from || null;
    const toDate = req.query.to || null;
    const args = [];
    let dateClause = '';
    if (fromDate) { dateClause += ' AND v.created_at >= ?'; args.push(fromDate); }
    if (toDate)   { dateClause += ' AND v.created_at < ?';  args.push(toDate); }
    const [rows] = await pool.query(`
      SELECT COALESCE(u.username, v.packer_name, 'unknown') AS packer,
             COUNT(*) AS video_count,
             MIN(v.created_at) AS first_at,
             MAX(v.created_at) AS last_at
      FROM vms_videos v
      LEFT JOIN users u ON u.id = v.packer_id
      WHERE 1=1 ${dateClause}
      GROUP BY packer
      ORDER BY video_count DESC`, args);
    await exportRowsAsXlsx(res, 'vms_packer_counts', [
      { header: 'Packer', key: 'packer', width: 22 },
      { header: 'Videos', key: 'video_count', width: 10 },
      { header: 'First', key: 'first_at', width: 20 },
      { header: 'Last', key: 'last_at', width: 20 },
    ], rows);
  } catch (err) { res.status(500).send(err.message); }
});

// ---------- single playback URL (used by table buttons) ----------
router.get('/api/playback-url', isAuthenticated, isVmsOperator, async (req, res) => {
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
