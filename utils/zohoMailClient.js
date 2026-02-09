// utils/zohoMailClient.js
// Zoho Mail API client for email search, fetch, and reply operations

const https = require('https');

// Environment variables for Zoho Mail
const ZOHO_DC = process.env.ZOHO_DC || 'IN'; // Data center: IN, US, EU, etc.
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const ZOHO_SENDER_EMAIL = process.env.ZOHO_SENDER_EMAIL || 'ksonu@kotty.in';

// Zoho API base URLs by data center
const ZOHO_ACCOUNTS_BASE = {
  IN: 'accounts.zoho.in',
  US: 'accounts.zoho.com',
  COM: 'accounts.zoho.com',
  EU: 'accounts.zoho.eu',
  AU: 'accounts.zoho.com.au',
  JP: 'accounts.zoho.jp'
};

const ZOHO_MAIL_BASE = {
  IN: 'mail.zoho.in',
  US: 'mail.zoho.com',
  COM: 'mail.zoho.com',
  EU: 'mail.zoho.eu',
  AU: 'mail.zoho.com.au',
  JP: 'mail.zoho.jp'
};

// Token cache
let accessToken = null;
let tokenExpiry = null;

// Classification patterns (based on AJIO CCTV request patterns)
const CLASSIFICATION_PATTERNS = {
  initial: /cctv\s*(footage|video|recording|request)/i,
  closed: /(closed|resolved|completed|done)/i,
  proceeding: /(proceeding|processing|in\s*progress|working)/i,
  error: /(error|failed|issue|problem)/i
};

/**
 * Make HTTPS request (promisified)
 */
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject({ status: res.statusCode, data: json });
          }
        } catch (e) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject({ status: res.statusCode, data });
          }
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

/**
 * Get fresh access token using refresh token
 */
async function getAccessToken() {
  // Return cached token if still valid
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return accessToken;
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Missing Zoho OAuth credentials. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN');
  }

  const params = new URLSearchParams({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const options = {
    hostname: ZOHO_ACCOUNTS_BASE[ZOHO_DC] || ZOHO_ACCOUNTS_BASE.IN,
    path: '/oauth/v2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params.toString())
    }
  };

  try {
    const result = await makeRequest(options, params.toString());
    if (result.access_token) {
      accessToken = result.access_token;
      // Token typically valid for 1 hour, cache for 55 minutes
      tokenExpiry = Date.now() + (55 * 60 * 1000);
      return accessToken;
    }
    throw new Error(result.error || 'Failed to get access token');
  } catch (err) {
    console.error('Zoho OAuth error:', err);
    throw err;
  }
}

/**
 * Get account ID for the authenticated user
 */
async function getAccountId() {
  const token = await getAccessToken();

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: '/api/accounts',
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  const result = await makeRequest(options);
  if (result.data && result.data.length > 0) {
    return result.data[0].accountId;
  }
  throw new Error('No Zoho Mail accounts found');
}

/**
 * Search emails by query
 * @param {string} query - Search query keyword
 * @param {number} limit - Max results to return
 * @param {number} start - Pagination start index
 */
async function searchEmails(query, limit = 50, start = 0) {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  // Format search key like Python tool: entire:keyword::in:Inbox
  // Use Zoho's search syntax
  const searchKey = `entire:${query.toLowerCase()}::in:Inbox`;

  const params = new URLSearchParams({
    searchKey: searchKey,
    limit: limit.toString(),
    start: start.toString(),
    includeto: 'true'
  });

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/messages/search?${params.toString()}`,
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  console.log('Zoho search URL:', options.path);

  try {
    const result = await makeRequest(options);
    console.log('Zoho search result count:', (result.data || []).length);
    return result.data || [];
  } catch (err) {
    console.error('Zoho search error:', err);
    throw err;
  }
}

/**
 * Get emails from a specific folder
 * @param {string} folderId - Folder ID (use 'inbox' for inbox)
 * @param {number} limit - Max results
 * @param {number} start - Pagination start
 */
async function getEmails(folderId = 'inbox', limit = 50, start = 0) {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const params = new URLSearchParams({
    limit: limit.toString(),
    start: start.toString()
  });

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/folders/${folderId}/messages?${params.toString()}`,
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  const result = await makeRequest(options);
  return result.data || [];
}

/**
 * Get full email content by message ID
 * @param {string} messageId - Message ID
 */
async function getEmailContent(messageId) {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/messages/${messageId}/content`,
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  const result = await makeRequest(options);
  return result.data || null;
}

/**
 * Get email details (metadata)
 * @param {string} messageId - Message ID
 */
async function getEmailDetails(messageId) {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/messages/${messageId}`,
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  const result = await makeRequest(options);
  return result.data || null;
}

/**
 * Send a reply to an email
 * @param {string} messageId - Original message ID
 * @param {string} threadId - Thread ID (for threading)
 * @param {string} toAddress - Recipient email
 * @param {string} subject - Email subject
 * @param {string} htmlContent - HTML body content
 */
async function sendReply(messageId, threadId, toAddress, subject, htmlContent) {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const emailData = {
    fromAddress: ZOHO_SENDER_EMAIL,
    toAddress: toAddress,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    content: htmlContent,
    mailFormat: 'html',
    inReplyTo: messageId,
    askReceipt: 'no'
  };

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const postData = JSON.stringify(emailData);
  options.headers['Content-Length'] = Buffer.byteLength(postData);

  const result = await makeRequest(options, postData);
  return result;
}

/**
 * Send a new email
 * @param {string} toAddress - Recipient email
 * @param {string} subject - Email subject
 * @param {string} htmlContent - HTML body content
 * @param {string} ccAddress - CC addresses (optional)
 */
async function sendEmail(toAddress, subject, htmlContent, ccAddress = '') {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const emailData = {
    fromAddress: ZOHO_SENDER_EMAIL,
    toAddress: toAddress,
    subject: subject,
    content: htmlContent,
    mailFormat: 'html',
    askReceipt: 'no'
  };

  if (ccAddress) {
    emailData.ccAddress = ccAddress;
  }

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/messages`,
    method: 'POST',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`,
      'Content-Type': 'application/json'
    }
  };

  const postData = JSON.stringify(emailData);
  options.headers['Content-Length'] = Buffer.byteLength(postData);

  const result = await makeRequest(options, postData);
  return result;
}

/**
 * Classify email based on content patterns
 * @param {string} subject - Email subject
 * @param {string} body - Email body text
 * @returns {string} Classification: 'initial', 'closed', 'proceeding', 'error', or 'unknown'
 */
function classifyEmail(subject, body) {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();

  // Check patterns in priority order
  if (CLASSIFICATION_PATTERNS.error.test(text)) return 'error';
  if (CLASSIFICATION_PATTERNS.closed.test(text)) return 'closed';
  if (CLASSIFICATION_PATTERNS.proceeding.test(text)) return 'proceeding';
  if (CLASSIFICATION_PATTERNS.initial.test(text)) return 'initial';

  return 'unknown';
}

/**
 * Extract order details from email subject and body
 * @param {string} body - Email body text
 * @param {string} subject - Email subject (optional)
 * @returns {object} Extracted details: orderId, packingTime, ticket, awb
 */
function extractOrderDetails(body, subject = '') {
  const details = {
    orderId: null,
    packingTime: null,
    ticket: null,
    awb: null
  };

  const text = `${subject || ''} ${body || ''}`;

  // AJIO CCTV subject pattern: ||INC00101496592||RT205313651||DV00336119
  // Extract RT number as AWB (this is the tracking number)
  const rtMatch = subject?.match(/\|\|RT(\d+)\|\|/i) || text.match(/\bRT(\d{6,})\b/i);
  if (rtMatch) {
    details.awb = 'RT' + rtMatch[1];
  }

  // Extract INC number as ticket
  const incMatch = subject?.match(/\|\|INC(\d+)\|\|/i) || text.match(/\bINC(\d{6,})\b/i);
  if (incMatch) {
    details.ticket = 'INC' + incMatch[1];
  }

  // Order ID patterns (AJIO format: OD followed by numbers)
  const orderMatch = text.match(/order\s*(?:id|no|number)?[:\s]*([A-Z0-9-]+)/i) ||
                     text.match(/\bOD\d{10,}\b/i);
  if (orderMatch) {
    details.orderId = orderMatch[1] || orderMatch[0];
  }

  // If no AWB from RT pattern, try other patterns
  if (!details.awb) {
    const awbMatch = text.match(/(?:awb|tracking|shipment)\s*(?:no|number|id)?[:\s]*([A-Z0-9]+)/i);
    if (awbMatch) {
      details.awb = awbMatch[1];
    }
  }

  // Packing time/date patterns
  const timeMatch = text.match(/(?:packing|packed|dispatch)\s*(?:time|date)?[:\s]*(\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4}[\s]*\d{0,2}[:\s]?\d{0,2}[\s]*(?:am|pm)?)/i);
  if (timeMatch) {
    details.packingTime = timeMatch[1];
  }

  // If no ticket from INC pattern, try other patterns
  if (!details.ticket) {
    const ticketMatch = text.match(/(?:ticket|case|reference)\s*(?:no|number|id)?[:\s]*([A-Z0-9-]+)/i);
    if (ticketMatch) {
      details.ticket = ticketMatch[1];
    }
  }

  return details;
}

/**
 * Build HTML reply content with video links
 * @param {string} orderId - Order ID
 * @param {Array} videoLinks - Array of { awb, url, filename } objects
 * @returns {string} HTML content for reply
 */
function buildVideoReplyHtml(orderId, videoLinks) {
  let html = `
    <div style="font-family: Arial, sans-serif; font-size: 14px;">
      <p>Dear Team,</p>
      <p>Please find the CCTV footage links for Order ID: <strong>${orderId}</strong></p>
      <br>
  `;

  if (videoLinks && videoLinks.length > 0) {
    html += '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse;">';
    html += '<tr style="background-color: #f0f0f0;"><th>AWB</th><th>Video Link</th></tr>';

    videoLinks.forEach(video => {
      html += `
        <tr>
          <td>${video.awb}</td>
          <td><a href="${video.url}" target="_blank">${video.filename || 'Download Video'}</a></td>
        </tr>
      `;
    });

    html += '</table>';
    html += '<br><p><strong>Note:</strong> These links will expire in 3 days. Please download the videos before expiry.</p>';
  } else {
    html += '<p style="color: #cc0000;"><strong>No matching videos found for this order.</strong></p>';
  }

  html += `
      <br>
      <p>Thanks & Regards,<br>Kotty Team</p>
    </div>
  `;

  return html;
}

/**
 * Get folders list
 */
async function getFolders() {
  const token = await getAccessToken();
  const accountId = await getAccountId();

  const options = {
    hostname: ZOHO_MAIL_BASE[ZOHO_DC] || ZOHO_MAIL_BASE.IN,
    path: `/api/accounts/${accountId}/folders`,
    method: 'GET',
    headers: {
      'Authorization': `Zoho-oauthtoken ${token}`
    }
  };

  const result = await makeRequest(options);
  return result.data || [];
}

/**
 * Check if Zoho credentials are configured
 */
function isConfigured() {
  return !!(ZOHO_CLIENT_ID && ZOHO_CLIENT_SECRET && ZOHO_REFRESH_TOKEN);
}

/**
 * Test connection to Zoho Mail
 */
async function testConnection() {
  try {
    if (!isConfigured()) {
      return { success: false, error: 'Zoho credentials not configured' };
    }

    const accountId = await getAccountId();
    return { success: true, accountId };
  } catch (err) {
    return { success: false, error: err.message || 'Connection failed' };
  }
}

module.exports = {
  getAccessToken,
  getAccountId,
  searchEmails,
  getEmails,
  getEmailContent,
  getEmailDetails,
  sendReply,
  sendEmail,
  classifyEmail,
  extractOrderDetails,
  buildVideoReplyHtml,
  getFolders,
  isConfigured,
  testConnection
};
