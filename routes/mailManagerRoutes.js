// routes/mailManagerRoutes.js
// Mail Manager - Zoho Mail integration for AJIO CCTV requests

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { isAuthenticated, isOnlyMohitOperator } = require('../middlewares/auth');
const zohoMail = require('../utils/zohoMailClient');
const { findVideosByAwb, formatFileSize } = require('../utils/s3Client');
const { pool } = require('../config/db');

// In-memory storage for Excel mappings (Order ID -> AWB)
// Also persisted to database for durability
const sessionMappings = new Map();

// ==================== DATABASE HELPERS ====================

// Save reply to database for tracking
async function saveReplyRecord(data) {
  try {
    await pool.query(`
      INSERT INTO mail_replies
        (message_id, thread_id, from_address, to_address, subject, order_id, awb, video_url, status, classification, replied_by, replied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        video_url = VALUES(video_url),
        replied_at = NOW(),
        replied_by = VALUES(replied_by)
    `, [
      data.messageId,
      data.threadId || null,
      data.fromAddress || null,
      data.toAddress,
      data.subject,
      data.orderId || null,
      data.awb || null,
      data.videoUrl || null,
      data.status || 'replied',
      data.classification || null,
      data.userId
    ]);
    return true;
  } catch (err) {
    console.error('Failed to save reply record:', err);
    return false;
  }
}

// Get reply status for a message
async function getReplyStatus(messageId) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM mail_replies WHERE message_id = ?',
      [messageId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('Failed to get reply status:', err);
    return null;
  }
}

// Get all replies with pagination
async function getReplies(limit = 50, offset = 0, status = null) {
  try {
    let query = 'SELECT * FROM mail_replies';
    const params = [];

    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await pool.query(query, params);
    return rows;
  } catch (err) {
    console.error('Failed to get replies:', err);
    return [];
  }
}

// Save order-AWB mapping to database (for persistence across sessions)
async function saveOrderAwbMapping(mappings, userId, sourceFile) {
  try {
    const entries = Object.entries(mappings);
    if (entries.length === 0) return 0;

    // Batch insert with ON DUPLICATE KEY UPDATE
    const values = entries.map(([orderId, awb]) => [orderId, awb, userId, sourceFile]);

    // Insert in batches of 500
    let inserted = 0;
    for (let i = 0; i < values.length; i += 500) {
      const batch = values.slice(i, i + 500);
      const placeholders = batch.map(() => '(?, ?, ?, ?)').join(',');
      const flatValues = batch.flat();

      await pool.query(`
        INSERT INTO order_awb_mapping (order_id, awb, uploaded_by, source_file)
        VALUES ${placeholders}
        ON DUPLICATE KEY UPDATE awb = VALUES(awb), uploaded_by = VALUES(uploaded_by), uploaded_at = NOW()
      `, flatValues);

      inserted += batch.length;
    }

    return inserted;
  } catch (err) {
    console.error('Failed to save order-AWB mapping:', err);
    return 0;
  }
}

// Load order-AWB mapping from database
async function loadOrderAwbMapping() {
  try {
    const [rows] = await pool.query(
      'SELECT order_id, awb FROM order_awb_mapping'
    );
    const mapping = {};
    rows.forEach(row => {
      mapping[row.order_id] = row.awb;
    });
    return mapping;
  } catch (err) {
    console.error('Failed to load order-AWB mapping:', err);
    return {};
  }
}

// Lookup AWB from database
async function lookupAwbFromDb(orderId) {
  try {
    const [rows] = await pool.query(
      'SELECT awb FROM order_awb_mapping WHERE order_id = ?',
      [orderId.toUpperCase()]
    );
    return rows[0]?.awb || null;
  } catch (err) {
    return null;
  }
}

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

    // Replace existing mapping in session (as per requirement)
    sessionMappings.set(sessionKey, mapping);

    // Also persist to database for durability (async, don't wait)
    const userId = req.session?.user?.id;
    const sourceFile = req.file.originalname;
    saveOrderAwbMapping(mapping, userId, sourceFile).then(saved => {
      console.log(`Persisted ${saved} order-AWB mappings to database`);
    }).catch(err => {
      console.error('Failed to persist mappings:', err);
    });

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

// Lookup AWB by Order ID (checks session first, then database)
router.get('/lookup-awb/:orderId', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  const sessionKey = getSessionKey(req);
  const mapping = sessionMappings.get(sessionKey);
  const orderId = (req.params.orderId || '').trim().toUpperCase();

  // First check session mapping
  if (mapping && mapping[orderId]) {
    return res.json({
      found: true,
      orderId,
      awb: mapping[orderId],
      source: 'session'
    });
  }

  // Then check database
  const dbAwb = await lookupAwbFromDb(orderId);
  if (dbAwb) {
    return res.json({
      found: true,
      orderId,
      awb: dbAwb,
      source: 'database'
    });
  }

  res.json({
    found: false,
    orderId,
    awb: null,
    error: mapping ? 'Order ID not found in mapping' : 'No mapping loaded'
  });
});

// ==================== EMAIL ROUTES ====================

// Search emails - checks database for existing replies to prevent double-reply
router.get('/emails/search', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { query, limit = 200, start = 0, fromDate, toDate } = req.query;

    if (!query) {
      return res.status(400).json({ error: 'Search query required' });
    }

    const emails = await zohoMail.searchEmails(query, parseInt(limit), parseInt(start));

    // Filter by date if provided
    let filtered = emails;
    if (fromDate || toDate) {
      filtered = emails.filter(email => {
        const emailDate = new Date(parseInt(email.receivedTime));
        if (fromDate && emailDate < new Date(fromDate)) return false;
        if (toDate) {
          const endDate = new Date(toDate);
          endDate.setHours(23, 59, 59, 999);
          if (emailDate > endDate) return false;
        }
        return true;
      });
    }

    // Get message IDs for batch lookup
    const messageIds = filtered.map(e => e.messageId);

    // Check database for existing reply records (prevents double-reply)
    let replyStatusMap = {};
    if (messageIds.length > 0) {
      try {
        const [dbRecords] = await pool.query(
          `SELECT message_id, status, replied_at FROM mail_replies WHERE message_id IN (?)`,
          [messageIds]
        );
        dbRecords.forEach(rec => {
          replyStatusMap[rec.message_id] = {
            status: rec.status,
            repliedAt: rec.replied_at
          };
        });
      } catch (dbErr) {
        console.error('Failed to check reply status:', dbErr);
      }
    }

    // Classify each email, but override with DB status if already replied
    const classified = filtered.map(email => {
      const dbStatus = replyStatusMap[email.messageId];
      let classification = zohoMail.classifyEmail(email.subject, email.summary || '');

      // If we have a database record showing this was replied, use that status
      if (dbStatus) {
        classification = dbStatus.status; // 'replied', 'proceeding', 'closed', etc.
      }

      return {
        ...email,
        classification,
        dbStatus: dbStatus || null // Include for UI to show reply info
      };
    });

    res.json({ emails: classified, count: classified.length });
  } catch (err) {
    console.error('Email search error:', err);
    res.status(500).json({ error: 'Failed to search emails: ' + (err.message || err) });
  }
});

// Get inbox emails - checks database for existing replies
router.get('/emails/inbox', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { limit = 200, start = 0 } = req.query;
    const emails = await zohoMail.getEmails('inbox', parseInt(limit), parseInt(start));

    // Get message IDs for batch lookup
    const messageIds = emails.map(e => e.messageId);

    // Check database for existing reply records
    let replyStatusMap = {};
    if (messageIds.length > 0) {
      try {
        const [dbRecords] = await pool.query(
          `SELECT message_id, status, replied_at FROM mail_replies WHERE message_id IN (?)`,
          [messageIds]
        );
        dbRecords.forEach(rec => {
          replyStatusMap[rec.message_id] = {
            status: rec.status,
            repliedAt: rec.replied_at
          };
        });
      } catch (dbErr) {
        console.error('Failed to check reply status:', dbErr);
      }
    }

    // Classify each email, override with DB status if already replied
    const classified = emails.map(email => {
      const dbStatus = replyStatusMap[email.messageId];
      let classification = zohoMail.classifyEmail(email.subject, email.summary || '');

      if (dbStatus) {
        classification = dbStatus.status;
      }

      return {
        ...email,
        classification,
        dbStatus: dbStatus || null
      };
    });

    res.json({ emails: classified, count: classified.length });
  } catch (err) {
    console.error('Inbox fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch inbox: ' + (err.message || err) });
  }
});

// Get single email content
// Returns extracted details with proper AWB lookup from mapping
// NOTE: Email metadata (subject, fromAddress) should be passed via query params
// because Zoho API doesn't support GET on /messages/{messageId}
router.get('/emails/:messageId', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId } = req.params;
    // Get metadata from query params (passed from frontend which has search results)
    const { subject: subjectParam, fromAddress: fromAddressParam } = req.query;

    // Only fetch content - metadata comes from search results via query params
    const content = await zohoMail.getEmailContent(messageId);

    const bodyText = content?.content || '';
    // Use subject from query param, or try to extract from content
    const subject = subjectParam || content?.subject || '';

    // Extract details from BOTH subject (for RT/INC numbers) and body
    const extractedDetails = zohoMail.extractOrderDetails(bodyText, subject);

    // Get session mapping for AWB lookup
    const sessionKey = getSessionKey(req);
    const mapping = sessionMappings.get(sessionKey);

    // Lookup OUTBOUND AWB from mapping using Order ID
    // NOTE: returnAwb from email is the RETURN tracking number, not for video search
    let outboundAwb = null;
    let awbSource = null;

    if (extractedDetails.orderId) {
      // Check session mapping first
      if (mapping && mapping[extractedDetails.orderId.toUpperCase()]) {
        outboundAwb = mapping[extractedDetails.orderId.toUpperCase()];
        awbSource = 'session';
      }
      // Then check database
      if (!outboundAwb) {
        outboundAwb = await lookupAwbFromDb(extractedDetails.orderId);
        if (outboundAwb) awbSource = 'database';
      }
    }

    // Add outbound AWB to extracted details (separate from returnAwb)
    extractedDetails.outboundAwb = outboundAwb;
    extractedDetails.awbSource = awbSource;

    // Build details object from query params (from search results)
    const details = {
      messageId,
      subject,
      fromAddress: fromAddressParam || ''
    };

    res.json({
      details,
      content,
      extracted: extractedDetails,
      classification: zohoMail.classifyEmail(subject, bodyText),
      hasMappingLoaded: !!(mapping && Object.keys(mapping).length > 0),
      mappingCount: mapping ? Object.keys(mapping).length : 0
    });
  } catch (err) {
    console.error('Email fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch email: ' + (err.message || err) });
  }
});

// ==================== VIDEO + REPLY ROUTES ====================

// Find videos for an order using OUTBOUND AWB
// Flow: If Order ID provided, lookup AWB from mapping first
// If AWB provided directly, use that (for manual override)
router.post('/find-videos', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { orderId, awb, packingDate } = req.body;

    // Get AWB from mapping if not provided directly
    let awbToSearch = awb; // Allow direct AWB override
    let awbSource = awb ? 'provided' : null;

    if (!awbToSearch && orderId) {
      // Lookup from session mapping first
      const sessionKey = getSessionKey(req);
      const mapping = sessionMappings.get(sessionKey);
      if (mapping && mapping[orderId.toUpperCase()]) {
        awbToSearch = mapping[orderId.toUpperCase()];
        awbSource = 'session';
      }

      // Then try database
      if (!awbToSearch) {
        awbToSearch = await lookupAwbFromDb(orderId);
        if (awbToSearch) awbSource = 'database';
      }
    }

    if (!awbToSearch) {
      return res.json({
        found: false,
        orderId,
        error: orderId
          ? 'Order ID not found in AWB mapping. Please upload Excel mapping first.'
          : 'No Order ID or AWB provided'
      });
    }

    // Search S3 for videos using the OUTBOUND AWB
    const packingDatesMap = {};
    if (packingDate) {
      packingDatesMap[awbToSearch.toUpperCase()] = packingDate;
    }

    const results = await findVideosByAwb([awbToSearch], packingDatesMap);
    const videos = results.get(awbToSearch.toUpperCase());

    if (videos && videos.length > 0) {
      res.json({
        found: true,
        orderId,
        awb: awbToSearch,
        awbSource,
        videos: videos.map(v => ({
          key: v.key,
          url: v.url,
          filename: v.key.split('/').pop(),
          size: v.size,
          lastModified: v.lastModified
        }))
      });
    } else {
      res.json({
        found: false,
        orderId,
        awb: awbToSearch,
        awbSource,
        error: 'No videos found in S3 for this AWB'
      });
    }
  } catch (err) {
    console.error('Video search error:', err);
    res.status(500).json({ error: 'Failed to search videos: ' + err.message });
  }
});

// Send reply with video links
// Expects orderId and videos array with outbound AWB (from mapping lookup)
router.post('/reply', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId, threadId, toAddress, subject, orderId, videos, classification, fromAddress, outboundAwb } = req.body;

    if (!messageId || !toAddress || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Build video links array (AWB should be the outbound AWB, not RT number)
    const videoLinks = (videos || []).map(v => ({
      awb: v.awb || outboundAwb || 'N/A',
      url: v.url,
      filename: v.filename || 'Download Video'
    }));

    // Build HTML reply
    const htmlContent = zohoMail.buildVideoReplyHtml(orderId || 'N/A', videoLinks);

    // Send reply
    const result = await zohoMail.sendReply(messageId, threadId, toAddress, subject, htmlContent);

    // Save reply record to database for tracking
    // Use outbound AWB (from mapping), not RT number
    const awb = outboundAwb || (videos && videos.length > 0 ? videos[0].awb : null);
    await saveReplyRecord({
      messageId,
      threadId,
      fromAddress,
      toAddress,
      subject,
      orderId,
      awb,
      videoUrl: videos && videos.length > 0 ? videos[0].url : null,
      status: 'replied',
      classification,
      userId: req.session?.user?.id
    });

    res.json({
      success: true,
      message: 'Reply sent successfully',
      orderId,
      awb,
      result
    });
  } catch (err) {
    console.error('Reply send error:', err);
    res.status(500).json({ error: 'Failed to send reply: ' + (err.message || err) });
  }
});

// ==================== BULK REPLY WITH SSE STREAMING ====================

// Bulk reply for multiple emails - uses SSE for progress
// CORRECT FLOW:
// 1. Extract Order ID from email body (e.g., FN9735702115)
// 2. Lookup Order ID in Excel mapping to get OUTBOUND AWB
// 3. Search S3 for videos using the OUTBOUND AWB
// 4. Send reply with video links
//
// NOTE: The RT number in email subjects (e.g., ||RT205327752||) is the RETURN AWB
// which will NEVER match videos. Videos are stored by OUTBOUND AWB.
router.get('/bulk-reply-stream', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep-alive ping every 15 seconds
  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 15000);

  // Get session mapping for AWB lookup
  const sessionKey = getSessionKey(req);
  const mapping = sessionMappings.get(sessionKey);

  try {
    const messageIdsRaw = req.query.messageIds || '';
    const messageIds = messageIdsRaw.split(',').filter(Boolean);

    if (!messageIds.length) {
      sendEvent('error', { message: 'No message IDs provided' });
      clearInterval(keepAlive);
      return res.end();
    }

    // Check if mapping is loaded
    const hasMappingLoaded = mapping && Object.keys(mapping).length > 0;

    // Check which emails are already replied (from database)
    const [alreadyReplied] = await pool.query(
      `SELECT message_id FROM mail_replies WHERE message_id IN (?) AND status = 'replied'`,
      [messageIds]
    );
    const repliedSet = new Set(alreadyReplied.map(r => r.message_id));

    // Filter out already replied
    const toProcess = messageIds.filter(id => !repliedSet.has(id));

    sendEvent('start', {
      total: messageIds.length,
      toProcess: toProcess.length,
      alreadyReplied: repliedSet.size,
      hasMappingLoaded,
      mappingCount: mapping ? Object.keys(mapping).length : 0
    });

    const results = {
      success: 0,
      failed: 0,
      skipped: repliedSet.size,
      noOrderId: 0,
      noMapping: 0,
      noVideo: 0,
      details: []
    };

    // Process each email
    for (let i = 0; i < toProcess.length; i++) {
      const messageId = toProcess[i];

      sendEvent('progress', {
        current: i + 1,
        total: toProcess.length,
        percent: Math.round(((i + 1) / toProcess.length) * 100),
        messageId
      });

      try {
        // Only fetch content - Zoho API doesn't support GET on /messages/{messageId}
        // Subject must come from search results (cached or passed in)
        const content = await zohoMail.getEmailContent(messageId);

        if (!content) {
          results.failed++;
          results.details.push({ messageId, status: 'failed', error: 'Could not fetch email content' });
          continue;
        }

        // Extract subject from content if available, otherwise empty
        // Note: For bulk reply, we extract order details from body - subject less critical
        const subject = content?.subject || '';
        const bodyText = content?.content || '';
        const fromAddress = content?.fromAddress || content?.sender || '';
        const toAddress = content?.toAddress || content?.replyTo || fromAddress;

        // Extract Order ID from email (NOT the RT number - that's return AWB)
        const extracted = zohoMail.extractOrderDetails(bodyText, subject);

        // STEP 1: Check if we have an Order ID
        if (!extracted.orderId) {
          results.noOrderId++;
          results.details.push({
            messageId,
            subject,
            status: 'no_order_id',
            error: 'No Order ID found in email body',
            returnAwb: extracted.returnAwb // Show RT number for reference
          });
          continue;
        }

        // STEP 2: Lookup the OUTBOUND AWB from mapping using Order ID
        let outboundAwb = null;

        // Check session mapping first
        if (mapping && mapping[extracted.orderId.toUpperCase()]) {
          outboundAwb = mapping[extracted.orderId.toUpperCase()];
        }

        // Then check database if not found in session
        if (!outboundAwb) {
          outboundAwb = await lookupAwbFromDb(extracted.orderId);
        }

        if (!outboundAwb) {
          results.noMapping++;
          results.details.push({
            messageId,
            subject,
            orderId: extracted.orderId,
            status: 'no_mapping',
            error: 'Order ID not found in AWB mapping. Upload Excel mapping first.',
            returnAwb: extracted.returnAwb
          });
          continue;
        }

        // STEP 3: Search S3 for videos using the OUTBOUND AWB
        const videoResults = await findVideosByAwb([outboundAwb]);
        const videoHit = videoResults.get(outboundAwb.toUpperCase());

        if (!videoHit) {
          results.noVideo++;
          results.details.push({
            messageId,
            subject,
            orderId: extracted.orderId,
            awb: outboundAwb,
            status: 'no_video',
            error: 'No video found for AWB in S3'
          });
          continue;
        }

        // STEP 4: Build video links and reply HTML
        const videoLinks = [{
          awb: outboundAwb,
          url: videoHit.url,
          filename: videoHit.key.split('/').pop()
        }];
        const htmlContent = zohoMail.buildVideoReplyHtml(extracted.orderId, videoLinks);

        // STEP 5: Send reply (threadId from content or null)
        const threadId = content?.threadId || null;
        await zohoMail.sendReply(messageId, threadId, fromAddress, subject, htmlContent);

        // Save to database
        await saveReplyRecord({
          messageId,
          threadId,
          fromAddress,
          toAddress,
          subject,
          orderId: extracted.orderId,
          awb: outboundAwb,
          videoUrl: videoHit.url,
          status: 'replied',
          classification: 'initial',
          userId: req.session?.user?.id
        });

        results.success++;
        results.details.push({
          messageId,
          subject,
          orderId: extracted.orderId,
          awb: outboundAwb,
          status: 'replied',
          videoUrl: videoHit.url
        });

        sendEvent('replied', {
          messageId,
          subject: subject.substring(0, 60),
          orderId: extracted.orderId,
          awb: outboundAwb
        });

      } catch (emailErr) {
        console.error(`Bulk reply error for ${messageId}:`, emailErr);
        results.failed++;

        // Extract meaningful error message
        let errorMsg = emailErr.message || 'Unknown error';
        if (emailErr.data?.errorCode) {
          errorMsg = emailErr.data.errorCode;
        }

        results.details.push({ messageId, status: 'error', error: errorMsg });

        // Send failure event to client
        sendEvent('failed', {
          messageId,
          error: errorMsg
        });

        // If rate limited, add extra delay
        if (errorMsg.includes('THROTTLE') || errorMsg.includes('LIMIT')) {
          console.log('Rate limited, waiting 5 seconds...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }

      // Longer delay to avoid Zoho rate limiting (1.5 seconds between emails)
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    sendEvent('complete', {
      success: results.success,
      failed: results.failed,
      skipped: results.skipped,
      noOrderId: results.noOrderId,
      noMapping: results.noMapping,
      noVideo: results.noVideo,
      total: messageIds.length
    });

  } catch (err) {
    console.error('Bulk reply stream error:', err);
    sendEvent('error', { message: err.message });
  } finally {
    clearInterval(keepAlive);
    res.end();
  }
});

// Get multiple emails' AWBs and video status at once (for bulk reply prep)
// Uses correct flow: Order ID → Mapping → Outbound AWB → S3 video search
router.post('/bulk-check-videos', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !messageIds.length) {
      return res.status(400).json({ error: 'No message IDs provided' });
    }

    // Get session mapping for AWB lookup
    const sessionKey = getSessionKey(req);
    const mapping = sessionMappings.get(sessionKey);
    const hasMappingLoaded = mapping && Object.keys(mapping).length > 0;

    // Check which are already replied
    const [alreadyReplied] = await pool.query(
      `SELECT message_id, status FROM mail_replies WHERE message_id IN (?)`,
      [messageIds]
    );
    const statusMap = {};
    alreadyReplied.forEach(r => {
      statusMap[r.message_id] = r.status;
    });

    const results = [];

    for (const messageId of messageIds) {
      // Skip already replied
      if (statusMap[messageId] === 'replied') {
        results.push({ messageId, status: 'already_replied', canReply: false });
        continue;
      }

      try {
        // Fetch email content to extract Order ID
        // Zoho API doesn't support GET on /messages/{messageId}
        const content = await zohoMail.getEmailContent(messageId);

        const subject = content?.subject || '';
        const bodyText = content?.content || '';
        const extracted = zohoMail.extractOrderDetails(bodyText, subject);

        // Check for Order ID (NOT the RT number)
        if (!extracted.orderId) {
          results.push({
            messageId,
            subject,
            status: 'no_order_id',
            canReply: false,
            returnAwb: extracted.returnAwb
          });
          continue;
        }

        // Lookup OUTBOUND AWB from mapping using Order ID
        let outboundAwb = null;
        if (mapping && mapping[extracted.orderId.toUpperCase()]) {
          outboundAwb = mapping[extracted.orderId.toUpperCase()];
        }
        if (!outboundAwb) {
          outboundAwb = await lookupAwbFromDb(extracted.orderId);
        }

        if (!outboundAwb) {
          results.push({
            messageId,
            subject,
            orderId: extracted.orderId,
            status: 'no_mapping',
            canReply: false,
            returnAwb: extracted.returnAwb
          });
          continue;
        }

        // Check if video exists for the OUTBOUND AWB
        const videoResults = await findVideosByAwb([outboundAwb]);
        const hasVideo = videoResults.has(outboundAwb.toUpperCase());

        results.push({
          messageId,
          subject,
          orderId: extracted.orderId,
          awb: outboundAwb,
          ticket: extracted.ticket,
          hasVideo,
          canReply: hasVideo,
          status: hasVideo ? 'ready' : 'no_video'
        });
      } catch (err) {
        results.push({ messageId, status: 'error', error: err.message, canReply: false });
      }
    }

    const readyCount = results.filter(r => r.canReply).length;

    res.json({
      total: messageIds.length,
      ready: readyCount,
      hasMappingLoaded,
      mappingCount: mapping ? Object.keys(mapping).length : 0,
      results
    });
  } catch (err) {
    console.error('Bulk check error:', err);
    res.status(500).json({ error: 'Failed to check videos: ' + err.message });
  }
});

// Update email status (without sending reply)
router.post('/update-status', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId, status, orderId, awb, subject, classification } = req.body;

    if (!messageId || !status) {
      return res.status(400).json({ error: 'Missing messageId or status' });
    }

    const validStatuses = ['initial', 'proceeding', 'replied', 'closed', 'error'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    await saveReplyRecord({
      messageId,
      orderId,
      awb,
      subject,
      status,
      classification,
      userId: req.session?.user?.id
    });

    res.json({ success: true, message: 'Status updated' });
  } catch (err) {
    console.error('Status update error:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Get reply history
router.get('/replies', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;
    const replies = await getReplies(parseInt(limit), parseInt(offset), status || null);

    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) as total FROM mail_replies';
    if (status) {
      countQuery += ' WHERE status = ?';
    }
    const [countResult] = await pool.query(countQuery, status ? [status] : []);
    const total = countResult[0]?.total || 0;

    res.json({ replies, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    console.error('Replies fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch replies' });
  }
});

// Get status for a specific message
router.get('/reply-status/:messageId', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const status = await getReplyStatus(req.params.messageId);
    res.json({ found: !!status, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
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

// Export selected emails' Order IDs and AWBs to CSV
// This allows user to download and investigate the data
router.post('/export-selected', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !messageIds.length) {
      return res.status(400).json({ error: 'No message IDs provided' });
    }

    // Get session mapping for AWB lookup
    const sessionKey = getSessionKey(req);
    const mapping = sessionMappings.get(sessionKey);

    const results = [];

    // Process emails in smaller batches with delays to avoid rate limiting
    for (let i = 0; i < messageIds.length; i++) {
      const messageId = messageIds[i];

      try {
        // Fetch email content to extract Order ID
        // Zoho API doesn't support GET on /messages/{messageId}
        const content = await zohoMail.getEmailContent(messageId);

        const subject = content?.subject || '';
        const bodyText = content?.content || '';
        const extracted = zohoMail.extractOrderDetails(bodyText, subject);

        // Lookup OUTBOUND AWB from mapping
        let outboundAwb = null;
        if (extracted.orderId) {
          if (mapping && mapping[extracted.orderId.toUpperCase()]) {
            outboundAwb = mapping[extracted.orderId.toUpperCase()];
          }
          if (!outboundAwb) {
            outboundAwb = await lookupAwbFromDb(extracted.orderId);
          }
        }

        results.push({
          messageId,
          subject: subject.substring(0, 100),
          orderId: extracted.orderId || '',
          outboundAwb: outboundAwb || '',
          returnAwb: extracted.returnAwb || '',
          ticket: extracted.ticket || '',
          fromAddress: content?.fromAddress || content?.sender || ''
        });

        // Delay to avoid rate limiting (500ms between requests)
        if (i < messageIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        // If rate limited, wait longer
        if (err.data?.errorCode?.includes('THROTTLE')) {
          console.log('Rate limited during export, waiting 3 seconds...');
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        results.push({
          messageId,
          subject: '',
          orderId: '',
          outboundAwb: '',
          returnAwb: '',
          ticket: '',
          fromAddress: '',
          error: err.data?.errorCode || err.message || 'Failed to fetch'
        });
      }
    }

    // Generate CSV
    const headers = ['Message ID', 'Subject', 'Order ID', 'Outbound AWB', 'Return AWB', 'Ticket', 'From', 'Error'];
    const csvRows = [headers.join(',')];

    results.forEach(r => {
      const row = [
        r.messageId,
        `"${(r.subject || '').replace(/"/g, '""')}"`,
        r.orderId,
        r.outboundAwb,
        r.returnAwb,
        r.ticket,
        r.fromAddress,
        r.error || ''
      ];
      csvRows.push(row.join(','));
    });

    const csv = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=selected_emails_export.csv');
    res.send(csv);

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Failed to export: ' + err.message });
  }
});

module.exports = router;
