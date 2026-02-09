// routes/mailManagerRoutes.js
// Mail Manager - Zoho Mail integration for AJIO CCTV requests

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { isAuthenticated, isOnlyMohitOperator } = require('../middlewares/auth');
const zohoMail = require('../utils/zohoMailClient');
const { findVideosByAwb } = require('../utils/s3Client');

// In-memory storage for Excel mappings (Order ID -> AWB)
// Each user session gets its own mapping
const sessionMappings = new Map();

// Multer setup for memory storage (no disk writes)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
    if (allowedTypes.includes(file.mimetype) ||
        file.originalname.match(/\.(xlsx|xls|csv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only Excel/CSV files allowed'));
    }
  }
});

// Helper to get session mapping key
function getSessionKey(req) {
  return req.session?.id || 'default';
}

// ==================== PAGE ROUTES ====================

// Main Mail Manager page
router.get('/', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  const sessionKey = getSessionKey(req);
  const mapping = sessionMappings.get(sessionKey);
  const mappingCount = mapping ? Object.keys(mapping).length : 0;

  // Check Zoho connection status
  let zohoStatus = { configured: zohoMail.isConfigured(), connected: false };
  if (zohoStatus.configured) {
    try {
      const test = await zohoMail.testConnection();
      zohoStatus.connected = test.success;
    } catch (e) {
      zohoStatus.connected = false;
    }
  }

  res.render('mailManager', {
    user: req.session.user,
    mappingCount,
    zohoStatus
  });
});

// ==================== EXCEL MAPPING ROUTES ====================

// Upload Excel mapping (AJAX, no page refresh)
router.post('/upload-mapping', isAuthenticated, isOnlyMohitOperator, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Parse Excel from buffer
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet);

    if (!rows || rows.length === 0) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Find Order ID and AWB columns (case-insensitive)
    const firstRow = rows[0];
    const keys = Object.keys(firstRow);

    const orderIdCol = keys.find(k =>
      /order.?id|order.?no|order.?number/i.test(k)
    );
    const awbCol = keys.find(k =>
      /awb|tracking|shipment|waybill/i.test(k)
    );

    if (!orderIdCol || !awbCol) {
      return res.status(400).json({
        error: 'Could not find Order ID and AWB columns. Please ensure your Excel has columns named like "Order ID" and "AWB".',
        columns: keys
      });
    }

    // Build mapping (Order ID -> AWB)
    const mapping = {};
    let skipped = 0;

    rows.forEach(row => {
      const orderId = String(row[orderIdCol] || '').trim().toUpperCase();
      const awb = String(row[awbCol] || '').trim().toUpperCase();

      if (orderId && awb) {
        mapping[orderId] = awb;
      } else {
        skipped++;
      }
    });

    const sessionKey = getSessionKey(req);

    // Replace existing mapping (as per requirement)
    sessionMappings.set(sessionKey, mapping);

    res.json({
      success: true,
      count: Object.keys(mapping).length,
      skipped,
      message: `Loaded ${Object.keys(mapping).length} order-to-AWB mappings`
    });
  } catch (err) {
    console.error('Excel parse error:', err);
    res.status(500).json({ error: 'Failed to parse Excel file: ' + err.message });
  }
});

// Get current mapping stats
router.get('/mapping-stats', isAuthenticated, isOnlyMohitOperator, (req, res) => {
  const sessionKey = getSessionKey(req);
  const mapping = sessionMappings.get(sessionKey);

  res.json({
    count: mapping ? Object.keys(mapping).length : 0,
    loaded: !!mapping
  });
});

// Clear mapping
router.post('/clear-mapping', isAuthenticated, isOnlyMohitOperator, (req, res) => {
  const sessionKey = getSessionKey(req);
  sessionMappings.delete(sessionKey);
  res.json({ success: true, message: 'Mapping cleared' });
});

// Lookup AWB by Order ID
router.get('/lookup-awb/:orderId', isAuthenticated, isOnlyMohitOperator, (req, res) => {
  const sessionKey = getSessionKey(req);
  const mapping = sessionMappings.get(sessionKey);
  const orderId = (req.params.orderId || '').trim().toUpperCase();

  if (!mapping) {
    return res.json({ found: false, error: 'No mapping loaded' });
  }

  const awb = mapping[orderId];
  res.json({
    found: !!awb,
    orderId,
    awb: awb || null
  });
});

// ==================== EMAIL ROUTES ====================

// Search emails
router.get('/emails/search', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { query, limit = 50, start = 0 } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const emails = await zohoMail.searchEmails(query, parseInt(limit), parseInt(start));

    // Classify each email
    const classified = emails.map(email => ({
      ...email,
      classification: zohoMail.classifyEmail(email.subject, email.summary || '')
    }));

    res.json({ emails: classified, count: classified.length });
  } catch (err) {
    console.error('Email search error:', err);
    res.status(500).json({ error: 'Failed to search emails: ' + (err.message || err) });
  }
});

// Get inbox emails
router.get('/emails/inbox', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { limit = 50, start = 0 } = req.query;
    const emails = await zohoMail.getEmails('inbox', parseInt(limit), parseInt(start));

    // Classify each email
    const classified = emails.map(email => ({
      ...email,
      classification: zohoMail.classifyEmail(email.subject, email.summary || '')
    }));

    res.json({ emails: classified, count: classified.length });
  } catch (err) {
    console.error('Inbox fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox: ' + (err.message || err) });
  }
});

// Get single email content
router.get('/emails/:messageId', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId } = req.params;

    const [details, content] = await Promise.all([
      zohoMail.getEmailDetails(messageId),
      zohoMail.getEmailContent(messageId)
    ]);

    const bodyText = content?.content || '';
    const extractedDetails = zohoMail.extractOrderDetails(bodyText);

    // Try to find AWB from mapping if we have an order ID
    const sessionKey = getSessionKey(req);
    const mapping = sessionMappings.get(sessionKey);

    if (extractedDetails.orderId && mapping && !extractedDetails.awb) {
      extractedDetails.awb = mapping[extractedDetails.orderId.toUpperCase()] || null;
    }

    res.json({
      details,
      content,
      extracted: extractedDetails,
      classification: zohoMail.classifyEmail(details?.subject, bodyText)
    });
  } catch (err) {
    console.error('Email fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch email: ' + (err.message || err) });
  }
});

// ==================== VIDEO + REPLY ROUTES ====================

// Find videos for an order/AWB
router.post('/find-videos', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { orderId, awb, packingDate } = req.body;

    // Get AWB from mapping if not provided
    let awbToSearch = awb;
    if (!awbToSearch && orderId) {
      const sessionKey = getSessionKey(req);
      const mapping = sessionMappings.get(sessionKey);
      if (mapping) {
        awbToSearch = mapping[orderId.toUpperCase()];
      }
    }

    if (!awbToSearch) {
      return res.json({ found: false, error: 'No AWB number available' });
    }

    // Search S3 for videos
    const packingDatesMap = {};
    if (packingDate) {
      packingDatesMap[awbToSearch.toUpperCase()] = packingDate;
    }

    const results = await findVideosByAwb([awbToSearch], packingDatesMap);
    const videos = results.get(awbToSearch.toUpperCase());

    if (videos && videos.length > 0) {
      res.json({
        found: true,
        awb: awbToSearch,
        videos: videos.map(v => ({
          key: v.key,
          url: v.url,
          filename: v.key.split('/').pop(),
          size: v.size,
          lastModified: v.lastModified
        }))
      });
    } else {
      res.json({ found: false, awb: awbToSearch, error: 'No videos found for this AWB' });
    }
  } catch (err) {
    console.error('Video search error:', err);
    res.status(500).json({ error: 'Failed to search videos: ' + err.message });
  }
});

// Send reply with video links
router.post('/reply', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId, threadId, toAddress, subject, orderId, videos } = req.body;

    if (!messageId || !toAddress || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Build video links array
    const videoLinks = (videos || []).map(v => ({
      awb: v.awb || 'N/A',
      url: v.url,
      filename: v.filename || 'Download Video'
    }));

    // Build HTML reply
    const htmlContent = zohoMail.buildVideoReplyHtml(orderId || 'N/A', videoLinks);

    // Send reply
    const result = await zohoMail.sendReply(messageId, threadId, toAddress, subject, htmlContent);

    res.json({
      success: true,
      message: 'Reply sent successfully',
      result
    });
  } catch (err) {
    console.error('Reply send error:', err);
    res.status(500).json({ error: 'Failed to send reply: ' + (err.message || err) });
  }
});

// ==================== UTILITY ROUTES ====================

// Test Zoho connection
router.get('/test-connection', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const result = await zohoMail.testConnection();
    res.json(result);
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Get folders
router.get('/folders', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const folders = await zohoMail.getFolders();
    res.json({ folders });
  } catch (err) {
    console.error('Folders fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

module.exports = router;
