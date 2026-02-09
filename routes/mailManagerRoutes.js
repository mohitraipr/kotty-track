// routes/mailManagerRoutes.js
// Mail Manager - Zoho Mail integration for AJIO CCTV requests

const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const { isAuthenticated, isOnlyMohitOperator } = require('../middlewares/auth');
const zohoMail = require('../utils/zohoMailClient');
const { findVideosByAwb, formatFileSize } = require('../utils/s3Client');
const pool = require('../config/db');

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
router.get('/emails/:messageId', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageId } = req.params;

    const [details, content] = await Promise.all([
      zohoMail.getEmailDetails(messageId),
      zohoMail.getEmailContent(messageId)
    ]);

    const bodyText = content?.content || '';
    const subject = details?.subject || '';

    // Extract details from BOTH subject (for RT/INC numbers) and body
    const extractedDetails = zohoMail.extractOrderDetails(bodyText, subject);

    // Try to find AWB from mapping if we have an order ID but no AWB yet
    const sessionKey = getSessionKey(req);
    const mapping = sessionMappings.get(sessionKey);

    if (extractedDetails.orderId && !extractedDetails.awb) {
      // Check session mapping first
      if (mapping) {
        extractedDetails.awb = mapping[extractedDetails.orderId.toUpperCase()] || null;
      }
      // Then check database
      if (!extractedDetails.awb) {
        extractedDetails.awb = await lookupAwbFromDb(extractedDetails.orderId);
      }
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
    const { messageId, threadId, toAddress, subject, orderId, videos, classification, fromAddress } = req.body;

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

    // Save reply record to database for tracking
    const awb = videos && videos.length > 0 ? videos[0].awb : null;
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
      result
    });
  } catch (err) {
    console.error('Reply send error:', err);
    res.status(500).json({ error: 'Failed to send reply: ' + (err.message || err) });
  }
});

// ==================== BULK REPLY WITH SSE STREAMING ====================

// Bulk reply for multiple emails - uses SSE for progress
// This processes multiple "initial" emails: finds videos, sends replies, tracks progress
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

  try {
    const messageIdsRaw = req.query.messageIds || '';
    const messageIds = messageIdsRaw.split(',').filter(Boolean);

    if (!messageIds.length) {
      sendEvent('error', { message: 'No message IDs provided' });
      clearInterval(keepAlive);
      return res.end();
    }

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
      alreadyReplied: repliedSet.size
    });

    const results = {
      success: 0,
      failed: 0,
      skipped: repliedSet.size,
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
        // Fetch email details
        const [details, content] = await Promise.all([
          zohoMail.getEmailDetails(messageId),
          zohoMail.getEmailContent(messageId)
        ]);

        if (!details) {
          results.failed++;
          results.details.push({ messageId, status: 'failed', error: 'Could not fetch email' });
          continue;
        }

        const subject = details.subject || '';
        const bodyText = content?.content || '';
        const fromAddress = details.fromAddress || '';
        const toAddress = details.toAddress || details.sender || '';

        // Extract AWB from subject (AJIO pattern: ||RT205313651||)
        const extracted = zohoMail.extractOrderDetails(bodyText, subject);

        if (!extracted.awb) {
          results.noVideo++;
          results.details.push({ messageId, subject, status: 'no_awb', error: 'No AWB found in email' });
          continue;
        }

        // Search S3 for videos
        const videoResults = await findVideosByAwb([extracted.awb]);
        const videoHit = videoResults.get(extracted.awb.toUpperCase());

        if (!videoHit) {
          results.noVideo++;
          results.details.push({ messageId, subject, awb: extracted.awb, status: 'no_video', error: 'No video found for AWB' });
          continue;
        }

        // Build video links and reply HTML
        const videoLinks = [{
          awb: extracted.awb,
          url: videoHit.url,
          filename: videoHit.key.split('/').pop()
        }];
        const htmlContent = zohoMail.buildVideoReplyHtml(extracted.orderId || extracted.awb, videoLinks);

        // Send reply
        await zohoMail.sendReply(messageId, details.threadId, fromAddress, subject, htmlContent);

        // Save to database
        await saveReplyRecord({
          messageId,
          threadId: details.threadId,
          fromAddress,
          toAddress,
          subject,
          orderId: extracted.orderId,
          awb: extracted.awb,
          videoUrl: videoHit.url,
          status: 'replied',
          classification: 'initial',
          userId: req.session?.user?.id
        });

        results.success++;
        results.details.push({
          messageId,
          subject,
          awb: extracted.awb,
          status: 'replied',
          videoUrl: videoHit.url
        });

        sendEvent('replied', {
          messageId,
          subject: subject.substring(0, 60),
          awb: extracted.awb
        });

      } catch (emailErr) {
        console.error(`Bulk reply error for ${messageId}:`, emailErr);
        results.failed++;
        results.details.push({ messageId, status: 'error', error: emailErr.message });
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    sendEvent('complete', {
      success: results.success,
      failed: results.failed,
      skipped: results.skipped,
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
router.post('/bulk-check-videos', isAuthenticated, isOnlyMohitOperator, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !messageIds.length) {
      return res.status(400).json({ error: 'No message IDs provided' });
    }

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
        // Fetch email to extract AWB
        const details = await zohoMail.getEmailDetails(messageId);
        const content = await zohoMail.getEmailContent(messageId);

        const subject = details?.subject || '';
        const bodyText = content?.content || '';
        const extracted = zohoMail.extractOrderDetails(bodyText, subject);

        if (!extracted.awb) {
          results.push({ messageId, subject, status: 'no_awb', canReply: false });
          continue;
        }

        // Check if video exists
        const videoResults = await findVideosByAwb([extracted.awb]);
        const hasVideo = videoResults.has(extracted.awb.toUpperCase());

        results.push({
          messageId,
          subject,
          awb: extracted.awb,
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

module.exports = router;
