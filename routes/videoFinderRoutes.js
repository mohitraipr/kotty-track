/**
 * Video Finder Routes
 * Search AWS S3 for CCTV/packing videos by AWB/tracking number
 * Supports large bulk searches with progress streaming (SSE)
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { isAuthenticated, isMohitOperator, isVideoFinder } = require('../middlewares/auth');
const {
  findVideosByAwb,
  findVideoByAwb,
  findVideosByAwbFromCache,
  preloadAllVideos,
  getVideosForDate,
  deleteObject,
  generatePresignedUrl,
  formatFileSize,
  listObjects,
  listDateFolders,
  S3_BUCKET,
} = require('../utils/s3Client');

// Constants for bulk search
const MAX_SINGLE_REQUEST_AWBS = 500; // Above this, use chunked/streaming
const CHUNK_SIZE = 100; // Process 100 AWBs at a time for progress updates

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
    user: req.session.user,
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
      // Search the full upload history (all date folders, newest-first)
      const folders = await listDateFolders();
      for (const folder of folders) {
        const dateStr = folder.replace(/\/$/, '');
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

// Bulk search via Excel upload (optimized with pre-loading)
router.post('/bulk-search', isAuthenticated, allowVideoFinderAccess, upload.single('awbFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse Excel/CSV
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });

    // Extract AWBs - check common column names
    const awbs = [];
    const headerRow = data[0] || [];
    let awbColIndex = 0;

    // Find AWB column by header name
    for (let i = 0; i < headerRow.length; i++) {
      const h = String(headerRow[i] || '').toUpperCase().trim();
      if (h === 'AWB' || h === 'FWD AWB' || h === 'TRACKING' || h.includes('AWB')) {
        awbColIndex = i;
        break;
      }
    }

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (row && row[awbColIndex]) {
        const val = String(row[awbColIndex]).trim().toUpperCase();
        if (val) {
          awbs.push(val);
        }
      }
    }

    if (!awbs.length) {
      return res.status(400).json({ error: 'No AWB numbers found in file' });
    }

    // For large lists, use pre-loading optimization
    let hits;
    if (awbs.length > 500) {
      console.log(`Bulk search: Pre-loading videos for ${awbs.length} AWBs`);
      const preloadedVideos = await preloadAllVideos();
      console.log(`Pre-loaded ${preloadedVideos.length} videos`);
      hits = await findVideosByAwbFromCache(awbs, preloadedVideos);
    } else {
      hits = await findVideosByAwb(awbs);
    }

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

// Chunked bulk search with Server-Sent Events (SSE) for progress
// Use this for large searches (>500 AWBs)
// OPTIMIZED: Pre-loads all S3 video listings once, then processes chunks against cache
// Uses POST to avoid URL length limits with large AWB lists
router.post('/api/search-stream', isAuthenticated, allowVideoFinderAccess, async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep-alive ping every 10 seconds to prevent timeout
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 10000);

  // Track if client disconnects
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    clearInterval(keepAlive);
  });

  try {
    // Support both query param (legacy) and POST body
    const awbListRaw = req.body?.awbList || req.query.awbList || '';
    const awbs = awbListRaw
      .split(/[\n,\s|]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (!awbs.length) {
      sendEvent('error', { message: 'No AWB numbers provided' });
      clearInterval(keepAlive);
      return res.end();
    }

    const total = awbs.length;
    const totalChunks = Math.ceil(awbs.length / CHUNK_SIZE);
    sendEvent('start', { total, chunkSize: CHUNK_SIZE, message: 'Loading video index...' });

    // Pre-load ALL videos from S3 (full upload history) - this is the key optimization
    // Instead of re-listing folders for each chunk, we list once and reuse
    const folders = await listDateFolders();
    const preloadedVideos = await preloadAllVideos();
    console.log(`Pre-loaded ${preloadedVideos.length} videos across ${folders.length} date folders for bulk search of ${total} AWBs`);

    if (clientDisconnected) {
      clearInterval(keepAlive);
      return res.end();
    }

    sendEvent('progress', {
      processed: 0,
      total,
      percent: 0,
      chunk: 0,
      totalChunks,
      found: 0,
      message: `Video index loaded (${preloadedVideos.length} files). Searching...`,
    });

    const allResults = [];
    let foundCount = 0;

    // Process in chunks against the cached video list
    for (let i = 0; i < awbs.length; i += CHUNK_SIZE) {
      if (clientDisconnected) {
        console.log('Client disconnected, stopping search');
        break;
      }

      const chunk = awbs.slice(i, i + CHUNK_SIZE);
      const chunkNum = Math.floor(i / CHUNK_SIZE) + 1;

      // Search this chunk against pre-loaded cache (much faster)
      const hits = await findVideosByAwbFromCache(chunk, preloadedVideos);

      // Build results for this chunk
      const chunkResults = chunk.map((awb) => {
        const hit = hits.get(awb);
        if (hit) {
          foundCount++;
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

      // Send found items immediately (streaming results)
      const foundInChunk = chunkResults.filter((r) => r.found);
      if (foundInChunk.length > 0) {
        sendEvent('found', { items: foundInChunk });
      }

      allResults.push(...chunkResults);

      sendEvent('progress', {
        processed: Math.min(i + chunk.length, total),
        total,
        percent: Math.round(((i + chunk.length) / total) * 100),
        chunk: chunkNum,
        totalChunks,
        found: foundCount,
      });
    }

    // Send completion (only if client still connected)
    if (!clientDisconnected) {
      sendEvent('complete', {
        success: true,
        total,
        found: foundCount,
        notFound: total - foundCount,
      });
    }
  } catch (err) {
    console.error('Stream search error:', err);
    if (!clientDisconnected) {
      sendEvent('error', { message: err.message });
    }
  } finally {
    clearInterval(keepAlive);
    res.end();
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
