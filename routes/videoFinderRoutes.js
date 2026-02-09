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
  listObjects,
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

// Search for videos by AWB - AJAX API endpoint
router.post('/api/search', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  try {
    const { awbList } = req.body;

    // Parse AWB list (comma, newline, or space separated)
    const awbs = (awbList || '')
      .split(/[\n,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!awbs.length) {
      return res.status(400).json({ error: 'Please enter at least one AWB/tracking number.' });
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

    res.json({
      success: true,
      found: foundCount,
      total: awbs.length,
      results,
    });
  } catch (err) {
    console.error('Video search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// Keyword search - find all videos matching a keyword in filename
router.get('/api/keyword', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  try {
    const { keyword, date } = req.query;

    if (!keyword || keyword.length < 2) {
      return res.status(400).json({ error: 'Keyword must be at least 2 characters' });
    }

    const keywordUpper = keyword.toUpperCase();
    let allVideos = [];

    if (date) {
      // Search specific date folder
      allVideos = await getVideosForDate(date);
    } else {
      // Search last 14 days
      const today = new Date();
      for (let i = 0; i < 14; i++) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        const dateStr = d.toISOString().slice(0, 10);
        const videos = await getVideosForDate(dateStr);
        allVideos.push(...videos);
      }
    }

    // Filter by keyword
    const matches = allVideos.filter((v) =>
      v.filename.toUpperCase().includes(keywordUpper) ||
      v.key.toUpperCase().includes(keywordUpper)
    );

    const results = matches.map((v) => ({
      found: true,
      filename: v.filename,
      key: v.key,
      url: v.url,
      size: v.size,
      sizeFormatted: v.sizeFormatted,
    }));

    res.json({
      success: true,
      keyword,
      date: date || 'last 14 days',
      count: results.length,
      results,
    });
  } catch (err) {
    console.error('Keyword search error:', err);
    res.status(500).json({ error: 'Search failed: ' + err.message });
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
