/**
 * Catalog Upload Routes - GCP Cloud Storage Version
 * Replace catalogupload.js with this file after migration
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { pool } = require('../config/db');
const {
  bucket,
  BUCKET_NAME,
  getObject,
  createGCSStorage,
  streamToBuffer
} = require('../utils/gcsClient');
const {
  isAuthenticated,
  isCatalogUpload,
  isAdmin
} = require('../middlewares/auth');

const BUCKET = BUCKET_NAME;

// In memory cache for searches { key: { data, ts } }
const searchCache = new Map();
const SEARCH_TTL = 10 * 60 * 1000; // 10 minutes

// Simple in-memory cache for marketplaces
let marketCache = { data: null, ts: 0 };
const MARKET_TTL = 5 * 60 * 1000; // 5 minutes

async function getMarketplaces() {
  const now = Date.now();
  if (!marketCache.data || (now - marketCache.ts) > MARKET_TTL) {
    const [rows] = await pool.query('SELECT id,name FROM marketplaces ORDER BY name');
    marketCache = { data: rows, ts: now };
  }
  return marketCache.data;
}

// GCS Multer setup
const upload = multer({
  storage: createGCSStorage({
    bucket: BUCKET,
    contentType: (req, file) => file.mimetype,
    key: (req, file, cb) => {
      const uid = req.session.user.id;
      const mkt = req.body.marketplace;
      const timestamp = Date.now();
      const ext = path.extname(file.originalname);
      const base = path.basename(file.originalname, ext);
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

// Build SQL + params for listing
function listSql(userId, marketplaceId, lastId) {
  let sql = `
    SELECT
      uf.id,
      uf.original_filename,
      uf.uploaded_at,
      m.name AS marketplace_name
    FROM uploaded_files uf
    JOIN marketplaces m ON uf.marketplace_id = m.id
    WHERE uf.user_id = ?
  `;
  const args = [userId];

  if (marketplaceId) {
    sql += ' AND uf.marketplace_id = ?';
    args.push(marketplaceId);
  }
  if (lastId) {
    sql += ' AND uf.id < ?';
    args.push(lastId);
  }

  sql += ' ORDER BY uf.uploaded_at DESC';
  return { sql, args };
}

async function searchFiles(userId, marketplaceId, term) {
  const cacheKey = `${userId}-${marketplaceId}-${term}`;
  const now = Date.now();
  const cached = searchCache.get(cacheKey);
  if (cached && now - cached.ts < SEARCH_TTL) return cached.data;

  const [rows] = await pool.query(
    `SELECT id, filename, original_filename
       FROM uploaded_files
      WHERE user_id=? AND marketplace_id=?
      ORDER BY uploaded_at DESC`,
    [userId, marketplaceId]
  );

  const matches = [];
  const batch = 5; // limit concurrent GCS fetches

  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const results = await Promise.all(slice.map(async r => {
      try {
        const data = await getObject(r.filename);

        if (r.filename.toLowerCase().endsWith('.csv')) {
          const buffer = await streamToBuffer(data.Body);
          if (buffer.toString('utf8').toLowerCase().includes(term)) return r;
          return null;
        }

        const buffer = await streamToBuffer(data.Body);
        const wb = XLSX.read(buffer, { type: 'buffer' });
        for (const sn of wb.SheetNames) {
          const j = XLSX.utils.sheet_to_json(wb.Sheets[sn], { raw: false });
          if (JSON.stringify(j).toLowerCase().includes(term)) return r;
        }
        return null;
      } catch (err) {
        console.error('Search file error:', err);
        return null;
      }
    }));
    results.forEach(r => { if (r) matches.push(r); });
  }

  searchCache.set(cacheKey, { data: matches, ts: now });
  return matches;
}

// GET /catalogUpload — main page with initial batch
router.get('/', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10) || null;
  const limit = 20;

  try {
    const markets = await getMarketplaces();

    const { sql, args } = listSql(userId, marketplaceId, null);
    const [files] = await pool.query(sql + ' LIMIT ?', [...args, limit]);

    res.render('catalogUpload', {
      markets,
      selectedMarketplace: marketplaceId,
      files,
      initialLimit: files.length,
      q: ''
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Cannot load page.');
    res.redirect('/');
  }
});

// GET /catalogUpload/files — JSON for lazy-loading
router.get('/files', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10) || null;
  const limit = parseInt(req.query.limit, 10) || 20;
  const lastId = parseInt(req.query.lastId, 10) || null;

  try {
    const { sql, args } = listSql(userId, marketplaceId, lastId);
    const [rows] = await pool.query(sql + ' LIMIT ?', [...args, limit]);
    res.json({ files: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load more files.' });
  }
});

// POST /catalogUpload/upload — upload to GCS + metadata
router.post(
  '/upload',
  isAuthenticated,
  isCatalogUpload,
  upload.single('csvfile'),
  async (req, res) => {
    try {
      const userId = req.session.user.id;
      const marketplaceId = parseInt(req.body.marketplace, 10);
      if (!marketplaceId) throw new Error('Marketplace required');

      let originalName = req.file.originalname;
      const today = new Date().toISOString().slice(0, 10);
      const [[dup]] = await pool.query(`
        SELECT 1
          FROM uploaded_files
         WHERE user_id=?
           AND marketplace_id=?
           AND original_filename=?
           AND DATE(uploaded_at)=?
         LIMIT 1
      `, [userId, marketplaceId, originalName, today]);

      if (dup) {
        const ext = path.extname(originalName);
        const base = path.basename(originalName, ext);
        originalName = `${base}_${today}${ext}`;
      }

      await pool.query(`
        INSERT INTO uploaded_files
          (user_id, marketplace_id, filename, original_filename)
        VALUES (?,?,?,?)
      `, [userId, marketplaceId, req.file.key, originalName]);

      req.flash('success', 'File uploaded.');
    } catch (err) {
      console.error(err);
      req.flash('error', err.message || 'Upload failed.');
    }
    res.redirect(`/catalogUpload?marketplace=${req.body.marketplace}`);
  }
);

// GET /catalogUpload/search — search within files
router.get('/search', isAuthenticated, isCatalogUpload, async (req, res) => {
  const userId = req.session.user.id;
  const marketplaceId = parseInt(req.query.marketplace, 10);
  const term = (req.query.q || '').trim().toLowerCase();
  if (!marketplaceId || !term) {
    req.flash('error', 'Marketplace + search term required');
    return res.redirect('/catalogUpload');
  }

  try {
    const matches = await searchFiles(userId, marketplaceId, term);

    if (!matches.length) {
      req.flash('error', 'No matching files found.');
      return res.redirect(`/catalogUpload?marketplace=${marketplaceId}`);
    }

    const markets = await getMarketplaces();
    res.render('catalogUpload', {
      markets,
      selectedMarketplace: marketplaceId,
      files: matches,
      initialLimit: matches.length,
      q: term
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Search failed.');
    res.redirect(`/catalogUpload?marketplace=${marketplaceId}`);
  }
});

// GET /catalogUpload/download/:id — stream back from GCS
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

    const data = await getObject(filename);
    data.Body.pipe(res).on('error', err => {
      console.error('Stream error:', err);
      res.status(500).end('Download error');
    });
  } catch (err) {
    console.error('Download failed:', err);
    req.flash('error', 'Download failed.');
    res.redirect('/catalogUpload');
  }
});

// Admin: list all uploads + aggregate counts
router.get(
  '/admin',
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      const limit = parseInt(req.query.limit, 10) || 500;
      const [files] = await pool.query(`
        SELECT uf.id,
               u.username,
               m.name   AS marketplace,
               uf.original_filename,
               uf.uploaded_at
          FROM uploaded_files uf
          JOIN users u ON uf.user_id = u.id
          JOIN marketplaces m ON uf.marketplace_id = m.id
         ORDER BY uf.uploaded_at DESC
         LIMIT ?
      `, [limit]);

      const [aggData] = await pool.query(`
        SELECT u.username,
               m.name   AS marketplace,
               COUNT(*) AS count
          FROM uploaded_files uf
          JOIN users u ON uf.user_id = u.id
          JOIN marketplaces m ON uf.marketplace_id = m.id
         GROUP BY u.username, m.name
         ORDER BY u.username, m.name
      `);

      res.render('catalogUploadAdmin', {
        files,
        aggData,
        error: req.flash('error')
      });
    } catch (err) {
      console.error(err);
      req.flash('error', 'Cannot load admin view.');
      res.redirect('/');
    }
  }
);

module.exports = router;
