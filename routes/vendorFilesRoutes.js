const express = require('express');
const path = require('path');
const multer = require('multer');
const multerS3 = require('multer-s3');
const ExcelJS = require('exceljs');
const {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
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

const FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB

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
        Delimiter: '/',
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

const upload = multer({
  storage: multerS3({
    s3,
    bucket: VENDOR_BUCKET,
    contentType: multerS3.AUTO_CONTENT_TYPE,
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
      stats
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
        Body: ''
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

module.exports = router;
