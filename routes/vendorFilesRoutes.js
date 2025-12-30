const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const multerS3 = require('multer-s3');
const ExcelJS = require('exceljs');
const archiver = require('archiver');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { pool } = require('../config/db');
const { isAuthenticated, isVendorFiles } = require('../middlewares/auth');

const router = express.Router();

const AWS_REGION = global.env.AWS_REGION || 'ap-south-1';
const VENDOR_BUCKET = global.env.VENDOR_FILES_BUCKET || global.env.AWS_BUCKET_NAME || 'my-app-uploads-kotty';
const ROOT_PREFIX = `${(global.env.VENDOR_FILES_PREFIX || 'vendor-files/').replace(/^\/+|\/+$/g, '')}/`;
const SIGNED_URL_TTL = 60 * 60; // 1 hour

const credentials = global.env.AWS_ACCESS_KEY_ID && global.env.AWS_SECRET_ACCESS_KEY
  ? {
      accessKeyId: global.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: global.env.AWS_SECRET_ACCESS_KEY
    }
  : undefined;

const s3 = new S3Client({
  region: AWS_REGION,
  credentials
});

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ZIP_EXTS = new Set(['.zip']);
const EXCEL_EXTS = new Set(['.xls', '.xlsx', '.csv']);

const FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB to reduce "file too big" issues
const MAX_DIRECT_UPLOAD_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB per S3 PUT

let assignmentsTableReady;
async function ensureAssignmentsTable() {
  if (assignmentsTableReady) return assignmentsTableReady;
  assignmentsTableReady = pool.query(`
    CREATE TABLE IF NOT EXISTS vendor_file_assignments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      s3_key VARCHAR(512) NOT NULL,
      item_type ENUM('file','folder') NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      date_key DATE NOT NULL,
      folder_name VARCHAR(255) NOT NULL,
      assigned_user_id BIGINT NOT NULL,
      assigned_role VARCHAR(100) NOT NULL,
      assigned_by BIGINT NOT NULL,
      assigned_by_name VARCHAR(191) NOT NULL,
      uploader_name VARCHAR(191) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_user_key (assigned_user_id, s3_key),
      INDEX idx_assigned_user_date (assigned_user_id, date_key),
      INDEX idx_folder_date (folder_name, date_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
  return assignmentsTableReady;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDate(input) {
  if (typeof input !== 'string') return today();
  const trimmed = input.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : today();
}

function datePrefix(date) {
  return `${ROOT_PREFIX}${date}/`;
}

function sanitizeFolder(folder) {
  if (!folder) return '';
  return folder
    .trim()
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sanitizePathSegments(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return '';
  const cleaned = relativePath.replace(/^\.+/g, '');
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  return segments
    .map(seg => sanitizeFolder(seg) || 'folder')
    .join('/');
}

function detectType(key) {
  const ext = path.extname(key).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ZIP_EXTS.has(ext)) return 'zip';
  if (EXCEL_EXTS.has(ext)) return 'excel';
  return 'file';
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTimestamp(date) {
  if (!(date instanceof Date)) return '';
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function ensureKeyAllowed(key) {
  return typeof key === 'string' && key.startsWith(ROOT_PREFIX);
}

function extractDateFromKey(key) {
  if (!ensureKeyAllowed(key)) return '';
  const withoutRoot = key.slice(ROOT_PREFIX.length);
  return withoutRoot.split('/')[0];
}

async function listDateFolders(date) {
  const folders = [];
  const prefix = datePrefix(date);
  let continuationToken;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: VENDOR_BUCKET,
        Prefix: prefix,
        Delimiter: '/',
        ContinuationToken: continuationToken
      })
    );

    (resp.CommonPrefixes || []).forEach(cp => {
      const name = cp.Prefix.replace(prefix, '').replace(/\/$/, '');
      if (name && !folders.includes(name)) {
        folders.push(name);
      }
    });

    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return folders;
}

async function listFiles(date, folder) {
  const prefix = `${datePrefix(date)}${folder ? `${folder}/` : ''}`;
  const files = [];
  let continuationToken;

  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: VENDOR_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken
      })
    );

    (resp.Contents || []).forEach(obj => {
      if (obj.Key !== prefix) {
        files.push(obj);
      }
    });

    continuationToken = resp.NextContinuationToken;
  } while (continuationToken);

  return files
    .sort((a, b) => (b.LastModified?.getTime?.() || 0) - (a.LastModified?.getTime?.() || 0))
    .map(obj => {
      const name = obj.Key.startsWith(prefix) ? obj.Key.slice(prefix.length) : obj.Key;
      const type = detectType(obj.Key);
      return {
        key: obj.Key,
        name,
        size: obj.Size,
        type,
        lastModified: obj.LastModified,
        sizeLabel: formatSize(obj.Size),
        lastModifiedLabel: formatTimestamp(obj.LastModified),
        downloadPath: `/vendor-files/download?key=${encodeURIComponent(obj.Key)}&date=${date}`,
        isImage: type === 'image'
      };
    });
}

function parseSelectedKeys(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function groupImagesBySku(keys) {
  const grouped = {};
  let maxIndex = 0;

  keys.forEach(key => {
    const filename = path.basename(key);
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const match = base.match(/^(.*?)[\s_-]*\((\d+)\)$/);
    const sku = (match ? match[1] : base).trim().replace(/[-_]+$/g, '') || 'SKU';
    const index = match && match[2] ? parseInt(match[2], 10) : 1;
    const safeIndex = Number.isFinite(index) ? index : 1;
    if (!grouped[sku]) grouped[sku] = {};
    grouped[sku][safeIndex] = key;
    if (safeIndex > maxIndex) maxIndex = safeIndex;
  });

  return { grouped, maxIndex };
}

async function getAssignableUsers() {
  const [rows] = await pool.query(
    `SELECT u.id, u.username, r.name AS roleName
     FROM users u
     JOIN roles r ON u.role_id = r.id
     ORDER BY u.username`
  );
  return rows;
}

async function getAssignmentsForUser(userId) {
  await ensureAssignmentsTable();
  const [rows] = await pool.query(
    `SELECT id, s3_key AS s3Key, item_type AS itemType, item_name AS itemName, date_key AS dateKey, folder_name AS folderName,
            assigned_role AS assignedRole, assigned_by_name AS assignedByName, uploader_name AS uploaderName, created_at AS createdAt
     FROM vendor_file_assignments
     WHERE assigned_user_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId]
  );
  return rows;
}

function isAllowedExtension(name) {
  const ext = path.extname(name).toLowerCase();
  return IMAGE_EXTS.has(ext) || ZIP_EXTS.has(ext) || EXCEL_EXTS.has(ext);
}

const upload = multer({
  storage: multerS3({
    s3,
    bucket: VENDOR_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    metadata: (req, file, cb) => {
      cb(null, {
        uploader: req.session?.user?.username || 'uploader',
        folder: sanitizeFolder(req.body.folder || req.body.selectedFolder || '')
      });
    },
    key: (req, file, cb) => {
      try {
        const selectedDate = normalizeDate(req.body.date);
        const folder = sanitizeFolder(req.body.folder || req.body.selectedFolder);
        if (!folder) {
          return cb(new Error('Please create and select a folder first.'));
        }
        const ext = path.extname(file.originalname).toLowerCase();
        const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '-') || 'file';
        const timestamp = Date.now();
        const key = `${datePrefix(selectedDate)}${folder}/${timestamp}-${base}${ext}`;
        req.uploadContext = { selectedDate, folder };
        cb(null, key);
      } catch (err) {
        cb(err);
      }
    }
  }),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTS.has(ext) || ZIP_EXTS.has(ext) || EXCEL_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files, Excel sheets, and images are allowed.'));
    }
  },
  limits: { fileSize: FILE_SIZE_LIMIT }
});

router.get('/', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.query.date);
  const requestedFolder = sanitizeFolder(req.query.folder);
  const user = { ...req.session.user, role: req.session.user.roleName };

  try {
    await ensureAssignmentsTable();
    const assignableUsers = await getAssignableUsers();
    const roles = [...new Set(assignableUsers.map(u => u.roleName))].sort();
    const assignmentsRaw = await getAssignmentsForUser(user.id);
    const myAssignments = assignmentsRaw.map(item => ({
      ...item,
      dateKey: typeof item.dateKey === 'string' ? item.dateKey : item.dateKey?.toISOString?.().slice(0, 10) || ''
    }));
    const folders = await listDateFolders(selectedDate);
    const selectedFolder = requestedFolder && folders.includes(requestedFolder)
      ? requestedFolder
      : (folders[0] || '');
    const files = selectedFolder || folders.length === 0 ? await listFiles(selectedDate, selectedFolder) : [];
    const imageFiles = files.filter(file => file.isImage);
    const stats = {
      total: files.length,
      images: imageFiles.length,
      zips: files.filter(f => f.type === 'zip').length,
      excel: files.filter(f => f.type === 'excel').length
    };

    res.render('vendorFiles', {
      user,
      req,
      selectedDate,
      folders,
      selectedFolder,
      files,
      imageFiles,
      stats,
      assignableUsers,
      roles,
      myAssignments
    });
  } catch (err) {
    console.error('Error loading vendor files:', err);
    req.flash('error', 'Could not load vendor files.');
    res.redirect('/');
  }
});

router.post('/folders', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.body.date);
  const folder = sanitizeFolder(req.body.folderName);

  if (!folder) {
    req.flash('error', 'Folder name is required.');
    return res.redirect(`/vendor-files?date=${selectedDate}`);
  }

  try {
    const key = `${datePrefix(selectedDate)}${folder}/`;
    await s3.send(
      new PutObjectCommand({
        Bucket: VENDOR_BUCKET,
        Key: key,
        Body: '',
        Metadata: {
          uploader: req.session?.user?.username || 'unknown',
          createdby: req.session?.user?.username || 'unknown'
        }
      })
    );
    req.flash('success', `Folder "${folder}" created for ${selectedDate}.`);
  } catch (err) {
    console.error('Error creating folder:', err);
    req.flash('error', 'Could not create folder.');
  }

  res.redirect(`/vendor-files?date=${selectedDate}&folder=${encodeURIComponent(folder)}`);
});

router.post('/upload', isAuthenticated, isVendorFiles, (req, res) => {
  upload.single('vendorFile')(req, res, err => {
    const selectedDate = normalizeDate(req.body.date);
    const folder = sanitizeFolder(req.body.folder || req.body.selectedFolder);
    const redirectUrl = `/vendor-files?date=${selectedDate}${folder ? `&folder=${encodeURIComponent(folder)}` : ''}`;

    if (err) {
      console.error('Upload error:', err);
      req.flash('error', err.message || 'Upload failed.');
      return res.redirect(redirectUrl);
    }

    req.flash('success', 'File uploaded successfully.');
    return res.redirect(redirectUrl);
  });
});

router.post('/upload-requests', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.body.date);
  const folder = sanitizeFolder(req.body.folder || req.body.selectedFolder);
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  const isFolderUpload = Boolean(req.body.folderUpload);
  const uploaderName = req.session?.user?.username || 'uploader';

  if (!folder) {
    return res.status(400).json({ error: 'Folder is required before uploading.' });
  }
  if (!entries.length) {
    return res.status(400).json({ error: 'No files received for upload.' });
  }

  try {
    const uploads = [];
    for (const entry of entries) {
      const { name, size, type, relativePath } = entry || {};
      if (!name || !isAllowedExtension(name)) {
        return res.status(400).json({ error: `File ${name || ''} is not allowed.` });
      }
      if (size && size > MAX_DIRECT_UPLOAD_SIZE) {
        return res.status(400).json({ error: `${name} exceeds the 5GB direct upload limit.` });
      }

      const ext = path.extname(name).toLowerCase();
      const base = path.basename(name, ext).replace(/[^a-zA-Z0-9-_]/g, '-') || 'file';
      const relative = sanitizePathSegments(relativePath && relativePath !== name ? relativePath : '');
      const subFolders = [];

      if (isFolderUpload) {
        subFolders.push(sanitizeFolder(uploaderName));
      }

      if (relative) {
        const parts = relative.split('/');
        if (parts.length > 1) {
          subFolders.push(...parts.slice(0, -1));
        }
      }

      const unique = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const key = `${datePrefix(selectedDate)}${folder}/${subFolders.length ? `${subFolders.join('/')}/` : ''}${unique}-${base}${ext}`;
      const command = new PutObjectCommand({
        Bucket: VENDOR_BUCKET,
        Key: key,
        ContentType: type || 'application/octet-stream',
        Metadata: {
          uploader: uploaderName,
          folder,
          date: selectedDate
        }
      });
      const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 60 * 15 });
      uploads.push({
        key,
        uploadUrl,
        contentType: command.input.ContentType,
        size: size || 0,
        name
      });
    }

    return res.json({
      uploads,
      folder,
      date: selectedDate
    });
  } catch (err) {
    console.error('Error preparing signed uploads:', err);
    return res.status(500).json({ error: 'Could not prepare uploads.' });
  }
});

router.get('/download', isAuthenticated, isVendorFiles, async (req, res) => {
  const key = decodeURIComponent(req.query.key || '');
  const selectedDate = normalizeDate(req.query.date);

  if (!ensureKeyAllowed(key)) {
    req.flash('error', 'Invalid file key.');
    return res.redirect(`/vendor-files?date=${selectedDate}`);
  }

  const keyDate = extractDateFromKey(key);
  if (keyDate && keyDate !== selectedDate) {
    req.flash('error', 'The requested file is outside the selected date.');
    return res.redirect(`/vendor-files?date=${selectedDate}`);
  }

  try {
    const obj = await s3.send(
      new GetObjectCommand({
        Bucket: VENDOR_BUCKET,
        Key: key
      })
    );

    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(key)}"`);
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    obj.Body.pipe(res).on('error', streamErr => {
      console.error('Stream error:', streamErr);
      res.status(500).end('Download failed.');
    });
  } catch (err) {
    console.error('Download failed:', err);
    req.flash('error', 'Could not download the requested file.');
    res.redirect(`/vendor-files?date=${selectedDate}`);
  }
});

router.get('/download-folder', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.query.date);
  const folder = sanitizeFolder(req.query.folder);
  const prefix = `${datePrefix(selectedDate)}${folder ? `${folder}/` : ''}`;

  if (!folder) {
    req.flash('error', 'Folder is required to download a bundle.');
    return res.redirect(`/vendor-files?date=${selectedDate}`);
  }

  try {
    res.setHeader('Content-Disposition', `attachment; filename="${folder}-${selectedDate}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('Archive error:', err);
      res.status(500).end('Could not create archive');
    });
    archive.pipe(res);

    let continuationToken;
    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: VENDOR_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      );

      for (const obj of resp.Contents || []) {
        if (obj.Key === prefix) continue;
        const streamResp = await s3.send(new GetObjectCommand({ Bucket: VENDOR_BUCKET, Key: obj.Key }));
        const relativeName = obj.Key.startsWith(prefix) ? obj.Key.slice(prefix.length) : obj.Key;
        archive.append(streamResp.Body, { name: relativeName || path.basename(obj.Key) });
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    archive.finalize();
  } catch (err) {
    console.error('Folder download failed:', err);
    req.flash('error', 'Could not download that folder.');
    res.redirect(`/vendor-files?date=${selectedDate}`);
  }
});

router.get('/list', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.query.date);
  const folder = sanitizeFolder(req.query.folder);

  try {
    const files = folder ? await listFiles(selectedDate, folder) : [];
    res.json({ files });
  } catch (err) {
    console.error('Error listing files for JSON:', err);
    res.status(500).json({ error: 'Could not fetch files.' });
  }
});

router.post('/export-excel', isAuthenticated, isVendorFiles, async (req, res) => {
  const selectedDate = normalizeDate(req.body.date);
  const selectedFolder = sanitizeFolder(req.body.folder);
  const redirectUrl = `/vendor-files?date=${selectedDate}${selectedFolder ? `&folder=${encodeURIComponent(selectedFolder)}` : ''}`;
  const rawKeys = parseSelectedKeys(req.body.selectedKeys);

  const validKeys = rawKeys
    .filter(k => ensureKeyAllowed(k))
    .filter(k => extractDateFromKey(k) === selectedDate)
    .filter(k => IMAGE_EXTS.has(path.extname(k).toLowerCase()));

  if (!validKeys.length) {
    req.flash('error', 'Please select at least one image to export.');
    return res.redirect(redirectUrl);
  }

  try {
    const signedUrlMap = new Map();
    await Promise.all(
      validKeys.map(async key => {
        const signedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: VENDOR_BUCKET, Key: key }),
          { expiresIn: SIGNED_URL_TTL }
        );
        signedUrlMap.set(key, signedUrl);
      })
    );

    const { grouped, maxIndex } = groupImagesBySku(validKeys);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Images');

    const columns = [{ header: 'SKU', key: 'sku', width: 35 }];
    for (let i = 1; i <= maxIndex; i += 1) {
      columns.push({ header: `${i}`, key: `col${i}`, width: 45 });
    }
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };

    Object.keys(grouped)
      .sort()
      .forEach(sku => {
        const rowValues = { sku };
        for (let i = 1; i <= maxIndex; i += 1) {
          const key = grouped[sku][i];
          if (key) {
            rowValues[`col${i}`] = {
              text: `${i}`,
              hyperlink: signedUrlMap.get(key)
            };
          }
        }
        sheet.addRow(rowValues);
      });

    res.setHeader('Content-Disposition', `attachment; filename="vendor-images-${selectedDate}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error creating Excel export:', err);
    req.flash('error', 'Could not generate Excel export.');
    res.redirect(redirectUrl);
  }
});

router.post('/assign', isAuthenticated, isVendorFiles, async (req, res) => {
  await ensureAssignmentsTable();
  const selectedDate = normalizeDate(req.body.date);
  const folder = sanitizeFolder(req.body.folder);
  const itemType = req.body.itemType === 'folder' ? 'folder' : 'file';
  const assignedUserId = Number(req.body.assignedUserId);
  const providedKey = req.body.s3Key;
  const itemName = req.body.itemName || folder;

  if (!assignedUserId || !folder) {
    return res.status(400).json({ error: 'Folder, item, and target user are required.' });
  }

  try {
    const [[targetUser]] = await pool.query(
      `SELECT u.id, u.username, r.name AS roleName
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?
       LIMIT 1`,
      [assignedUserId]
    );

    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found.' });
    }

    const key = itemType === 'folder'
      ? `${datePrefix(selectedDate)}${folder}/`
      : decodeURIComponent(providedKey || '');

    if (!ensureKeyAllowed(key)) {
      return res.status(400).json({ error: 'Invalid item path.' });
    }

    await pool.query(
      `INSERT INTO vendor_file_assignments
       (s3_key, item_type, item_name, date_key, folder_name, assigned_user_id, assigned_role, assigned_by, assigned_by_name, uploader_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE assigned_role = VALUES(assigned_role), assigned_by = VALUES(assigned_by), assigned_by_name = VALUES(assigned_by_name), uploader_name = VALUES(uploader_name)`,
      [
        key,
        itemType,
        itemName,
        selectedDate,
        folder,
        targetUser.id,
        targetUser.roleName,
        req.session.user.id,
        req.session.user.username || 'user',
        req.session.user.username || 'user'
      ]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('Error saving assignment:', err);
    return res.status(500).json({ error: 'Could not save assignment.' });
  }
});

router.get('/assignments', isAuthenticated, isVendorFiles, async (req, res) => {
  try {
    const rows = await getAssignmentsForUser(req.session.user.id);
    res.json({ assignments: rows });
  } catch (err) {
    console.error('Error fetching assignments:', err);
    res.status(500).json({ error: 'Could not fetch assignments.' });
  }
});

module.exports = router;
