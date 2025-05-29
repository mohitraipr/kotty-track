// routes/catalogUploadRoutes.js

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const path    = require('path');
const XLSX    = require('xlsx');
const { pool } = require('../config/db');
const {
  isAuthenticated,
  isCatalogUpload,
  isAdmin
} = require('../middlewares/auth');

const s3     = new S3Client({ region: 'ap-south-1' });
const BUCKET = 'my-app-uploads-kotty';

// Multer-S3
const upload = multer({
  storage: multerS3({
    s3,
    bucket: BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
      const uid       = req.session.user.id;
      const mkt       = req.body.marketplace;
      const timestamp = Date.now();
      const ext       = path.extname(file.originalname);
      const base      = path.basename(file.originalname, ext);
      cb(null, `user_${uid}/mkt_${mkt}/${timestamp}-${base}${ext}`);
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xls', '.xlsx'].includes(ext)) cb(null, true);
    else cb(new Error('Only .csv, .xls & .xlsx allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Utility to build the base SQL & params for listing
function listSql(userId, marketplaceId) {
  let sql    = 'SELECT id, original_filename, uploaded_at FROM uploaded_files WHERE user_id=?';
  const args = [userId];
  if (marketplaceId) {
    sql += ' AND marketplace_id=?';
    args.push(marketplaceId);
  }
  sql += ' ORDER BY uploaded_at DESC';
  return { sql, args };
}

// GET /catalogUpload — main page, with upload & search forms + initial file batch
router.get('/', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId        = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10) || null;
  const limit         = 20;
  try {
    // 1) marketplaces for the dropdown
    const [markets] = await pool.query('SELECT id,name FROM marketplaces ORDER BY name');

    // 2) initial batch of files
    const { sql, args } = listSql(userId, marketplaceId);
    const [files] = await pool.query(sql + ' LIMIT ?', [...args, limit]);

    res.render('catalogUpload', {
      markets,
      selectedMarketplace: marketplaceId,
      files,
      initialLimit: limit,
      q: ''
    });
  } catch (err) {
    console.error(err);
    req.flash('error','Cannot load page.');
    res.redirect('/');
  }
});

// GET /catalogUpload/files — JSON endpoint for lazy-loading more files
router.get('/files', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId        = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10) || null;
  const offset        = parseInt(req.query.offset, 10) || 0;
  const limit         = parseInt(req.query.limit, 10) || 20;

  try {
    const { sql, args } = listSql(userId, marketplaceId);
    const [rows] = await pool.query(sql + ' LIMIT ?,?', [...args, offset, limit]);
    res.json({ files: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load more files.' });
  }
});

// POST /catalogUpload/upload — exactly as before
router.post(
  '/upload',
  isAuthenticated,
  isCatalogUpload,
  upload.single('csvfile'),
  async (req, res) => {
    try {
      const userId        = req.session.user.id;
      const marketplaceId = parseInt(req.body.marketplace, 10);
      if (!marketplaceId) throw new Error('Marketplace required');

      // handle duplicate original_filename per day
      let originalName = req.file.originalname;
      const today      = new Date().toISOString().slice(0,10);
      const [[{ cnt }]] = await pool.query(`
        SELECT COUNT(*) AS cnt 
          FROM uploaded_files 
         WHERE user_id=? 
           AND marketplace_id=? 
           AND original_filename=? 
           AND DATE(uploaded_at)=?
      `, [userId, marketplaceId, originalName, today]);

      if (cnt > 0) {
        const ext  = path.extname(originalName);
        const base = path.basename(originalName, ext);
        originalName = `${base}_${today}${ext}`;
      }

      await pool.query(`
        INSERT INTO uploaded_files 
          (user_id, marketplace_id, filename, original_filename)
        VALUES (?,?,?,?)
      `, [userId, marketplaceId, req.file.key, originalName]);

      req.flash('success','File uploaded.');
    } catch (err) {
      console.error(err);
      req.flash('error',err.message || 'Upload failed.');
    }
    // keep the same marketplace filter on redirect
    res.redirect(`/catalogUpload?marketplace=${req.body.marketplace}`);
  }
);

// GET /catalogUpload/search — unchanged
router.get('/search', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId        = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10);
  const term          = (req.query.q||'').trim().toLowerCase();
  if (!marketplaceId || !term) {
    req.flash('error','Marketplace + search term required');
    return res.redirect('/catalogUpload');
  }

  try {
    const [rows] = await pool.query(`
      SELECT id, filename, original_filename
        FROM uploaded_files
       WHERE user_id=? AND marketplace_id=?
       ORDER BY uploaded_at DESC
    `, [userId, marketplaceId]);

    const matches = [];
    for (const r of rows) {
      const data = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r.filename }));
      const chunks = []; for await (const c of data.Body) chunks.push(c);
      const buf    = Buffer.concat(chunks);
      let found    = false;

      if (r.filename.toLowerCase().endsWith('.csv')) {
        if (buf.toString('utf8').toLowerCase().includes(term)) found = true;
      } else {
        const wb = XLSX.read(buf, { type:'buffer' });
        for (const sn of wb.SheetNames) {
          const j = XLSX.utils.sheet_to_json(wb.Sheets[sn], { raw: false });
          if (JSON.stringify(j).toLowerCase().includes(term)) {
            found = true;
            break;
          }
        }
      }
      if (found) matches.push(r);
    }

    if (!matches.length) {
      req.flash('error','No matching files found.');
      return res.redirect(`/catalogUpload?marketplace=${marketplaceId}`);
    }

    const [markets] = await pool.query('SELECT id,name FROM marketplaces ORDER BY name');
    res.render('catalogUpload', {
      markets,
      selectedMarketplace: marketplaceId,
      files: matches,
      initialLimit: matches.length,
      q: term
    });
  } catch (err) {
    console.error(err);
    req.flash('error','Search failed.');
    res.redirect(`/catalogUpload?marketplace=${marketplaceId}`);
  }
});// GET /catalogUpload/download/:id — stream back from S3
router.get('/download/:id', isAuthenticated, isCatalogUpload, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const fileId = parseInt(req.params.id, 10);

    const [rows] = await pool.query(`
      SELECT filename, original_filename
        FROM uploaded_files
       WHERE id=? AND user_id=?
    `, [fileId, userId]);

    if (!rows.length) {
      req.flash('error', 'File not found.');
      return res.redirect('/catalogUpload');
    }

    const { filename, original_filename } = rows[0];
    res.attachment(original_filename);

    const getCmd = new GetObjectCommand({ Bucket: BUCKET, Key: filename });
    const data   = await s3.send(getCmd);

    data.Body
      .on('error', err => {
        console.error('Stream error:', err);
        res.status(500).end('Download error');
      })
      .pipe(res);

  } catch (err) {
    console.error('Download failed:', err);
    req.flash('error', 'Download failed.');
    res.redirect('/catalogUpload');
  }
});

// Admin: list all uploads
router.get('/admin', isAuthenticated, isAdmin, async (req, res) => {
  try {
    const [all] = await pool.query(`
      SELECT uf.id, u.username, m.name AS marketplace,
             uf.original_filename, uf.uploaded_at
        FROM uploaded_files uf
        JOIN users u ON uf.user_id=u.id
        JOIN marketplaces m ON uf.marketplace_id=m.id
       ORDER BY uf.uploaded_at DESC
    `);
    res.render('catalogUploadAdmin', { files: all });
  } catch (err) {
    console.error(err);
    req.flash('error','Cannot load admin view.');
    res.redirect('/');
  }
});

module.exports = router;
