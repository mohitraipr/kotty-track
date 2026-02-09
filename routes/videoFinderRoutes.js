/**
 * Video Finder Routes
 * Search AWS S3 for CCTV/packing videos by AWB/tracking number
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { isAuthenticated, isMohitOperator, isVideoFinder } = require('../middlewares/auth');
const {
  findVideosByAwb,
  findVideoByAwb,
  getVideosForDate,
  deleteObject,
  generatePresignedUrl,
  formatFileSize,
  S3_BUCKET,
} = require('../utils/s3Client');

// Multer for Excel upload (in-memory only)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Access: videofinder role OR mohitOperator
function allowVideoFinderAccess(req, res, next) {
  const username = req.session?.user?.username?.toLowerCase();
  const role = req.session?.user?.roleName;

  if (username === 'mohitoperator' || role === 'videofinder') {
    return next();
  }

  req.flash('error', 'You do not have permission to access Video Finder.');
  return res.redirect('/');
}

// Check if user is mohitOperator (for delete access)
function checkMohitOperator(req) {
  return req.session?.user?.username?.toLowerCase() === 'mohitoperator';
}

// Main video finder page
router.get('/', isAuthenticated, allowVideoFinderAccess, (req, res) => {
  res.render('videoFinder', {
    results: [],
    searchQuery: '',
    dateFilter: '',
    isMohitOperator: checkMohitOperator(req),
    bucketName: S3_BUCKET,
  });
});

// Search for videos by AWB (single or multiple)
router.post('/search', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  const { awbList, dateFilter } = req.body;
  const isMohit = checkMohitOperator(req);

  try {
    // Parse AWB list (comma, newline, or space separated)
    const awbs = (awbList || '')
      .split(/[\n,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!awbs.length) {
      return res.render('videoFinder', {
        results: [],
        searchQuery: awbList || '',
        dateFilter: dateFilter || '',
        isMohitOperator: isMohit,
        bucketName: S3_BUCKET,
        error: 'Please enter at least one AWB/tracking number.',
      });
    }

    // Search S3 for matching videos
    const hits = await findVideosByAwb(awbs);

    // Build results array
    const results = awbs.map((awb) => {
      const hit = hits.get(awb);
      if (hit) {
        return {
          awb,
          found: true,
          key: hit.key,
          filename: hit.key.split('/').pop(),
          url: hit.url,
          size: hit.size,
          sizeFormatted: formatFileSize(hit.size),
          lastModified: hit.lastModified,
        };
      }
      return { awb, found: false };
    });

    const foundCount = results.filter((r) => r.found).length;

    res.render('videoFinder', {
      results,
      searchQuery: awbList,
      dateFilter: dateFilter || '',
      isMohitOperator: isMohit,
      bucketName: S3_BUCKET,
      message: `Found ${foundCount} of ${awbs.length} videos`,
    });
  } catch (err) {
    console.error('Video search error:', err);
    res.render('videoFinder', {
      results: [],
      searchQuery: awbList || '',
      dateFilter: dateFilter || '',
      isMohitOperator: isMohit,
      bucketName: S3_BUCKET,
      error: 'Search failed: ' + err.message,
    });
  }
});

// Bulk search via Excel upload
router.post('/bulk-search', isAuthenticated, allowVideoFinderAccess, upload.single('awbFile'), async (req, res) => {
  const isMohit = checkMohitOperator(req);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse Excel/CSV
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Extract AWBs from first column
    const awbs = [];
    for (const row of data) {
      if (row[0]) {
        const val = String(row[0]).trim().toUpperCase();
        if (val && val !== 'AWB' && val !== 'FWD AWB' && val !== 'TRACKING') {
          awbs.push(val);
        }
      }
    }

    if (!awbs.length) {
      return res.status(400).json({ error: 'No AWB numbers found in file' });
    }

    // Search S3
    const hits = await findVideosByAwb(awbs);

    const results = awbs.map((awb) => {
      const hit = hits.get(awb);
      if (hit) {
        return {
          awb,
          found: true,
          key: hit.key,
          filename: hit.key.split('/').pop(),
          url: hit.url,
          size: hit.size,
          sizeFormatted: formatFileSize(hit.size),
        };
      }
      return { awb, found: false };
    });

    res.json({
      success: true,
      found: results.filter((r) => r.found).length,
      total: awbs.length,
      results,
    });
  } catch (err) {
    console.error('Bulk search error:', err);
    res.status(500).json({ error: 'Bulk search failed: ' + err.message });
  }
});

// List videos for a specific date
router.get('/date/:date', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  const isMohit = checkMohitOperator(req);

  try {
    const dateStr = req.params.date; // YYYY-MM-DD
    const videos = await getVideosForDate(dateStr);

    res.json({
      success: true,
      date: dateStr,
      count: videos.length,
      videos,
      canDelete: isMohit,
    });
  } catch (err) {
    console.error('Date listing error:', err);
    res.status(500).json({ error: 'Failed to list videos: ' + err.message });
  }
});

// Generate fresh presigned URL for a specific key
router.get('/url', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  try {
    const { key } = req.query;
    if (!key) {
      return res.status(400).json({ error: 'Missing key parameter' });
    }

    const url = await generatePresignedUrl(key);
    if (!url) {
      return res.status(404).json({ error: 'Could not generate URL' });
    }

    res.json({ success: true, url });
  } catch (err) {
    console.error('URL generation error:', err);
    res.status(500).json({ error: 'Failed to generate URL: ' + err.message });
  }
});

// Delete video (mohitOperator only)
router.delete('/delete', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  if (!checkMohitOperator(req)) {
    return res.status(403).json({ error: 'Only mohitOperator can delete videos' });
  }

  try {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'Missing key parameter' });
    }

    const success = await deleteObject(key);
    if (success) {
      console.log(`Video deleted by ${req.session.user.username}: ${key}`);
      res.json({ success: true, message: 'Video deleted' });
    } else {
      res.status(500).json({ error: 'Failed to delete video' });
    }
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

module.exports = router;
