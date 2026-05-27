/**
 * EasyEcom Returns API Client
 * Handles return creation, AWB fetching, and courier assignment
 */

const axios = require('axios');

// Configuration from environment
// Uses global.env from secure-env (loaded in app.js) with fallback to process.env
const EASYECOM_API_BASE = global.env?.EASYECOM_API_BASE || process.env.EASYECOM_API_BASE || 'https://api.easyecom.io';
const EASYECOM_API_KEY = global.env?.EASYECOM_API_KEY || process.env.EASYECOM_API_KEY || '';
const EASYECOM_ACCESS_TOKEN = global.env?.EASYECOM_ACCESS_TOKEN || process.env.EASYECOM_ACCESS_TOKEN || '';

// Email/Password auth - Default (Faridabad)
const EASYECOM_EMAIL = global.env?.EASYECOM_EMAIL || process.env.EASYECOM_EMAIL || '';
const EASYECOM_PASSWORD = global.env?.EASYECOM_PASSWORD || process.env.EASYECOM_PASSWORD || '';

// Delhi warehouse credentials
const EASYECOM_DELHI_EMAIL = global.env?.EASYECOM_DELHI_EMAIL || process.env.EASYECOM_DELHI_EMAIL || '';
const EASYECOM_DELHI_PASSWORD = global.env?.EASYECOM_DELHI_PASSWORD || process.env.EASYECOM_DELHI_PASSWORD || '';

// Warehouse credentials mapping
const WAREHOUSE_CREDENTIALS = {
  faridabad: { email: EASYECOM_EMAIL, password: EASYECOM_PASSWORD, c_id: 173983 },
  delhi: { email: EASYECOM_DELHI_EMAIL, password: EASYECOM_DELHI_PASSWORD, c_id: 176318 },
};

// Cached JWT tokens per warehouse
const cachedTokens = {
  faridabad: { token: null, expiry: null },
  delhi: { token: null, expiry: null },
};

/**
 * Authenticate with EasyEcom using email/password to get JWT token
 * Supports per-warehouse authentication
 * @param {string} warehouse - 'delhi' or 'faridabad' (default)
 */
async function authenticateWithCredentials(warehouse = 'faridabad') {
  const warehouseKey = warehouse.toLowerCase();
  const creds = WAREHOUSE_CREDENTIALS[warehouseKey] || WAREHOUSE_CREDENTIALS.faridabad;
  const cache = cachedTokens[warehouseKey] || cachedTokens.faridabad;

  if (!creds.email || !creds.password) {
    console.error(`No credentials configured for warehouse: ${warehouse}`);
    return null;
  }

  // Check if we have a valid cached token
  if (cache.token && cache.expiry && Date.now() < cache.expiry) {
    return cache.token;
  }

  try {
    console.log(`Authenticating with EasyEcom for ${warehouse}...`);

    const response = await axios.post(`${EASYECOM_API_BASE}/getApiToken`, {
      email: creds.email,
      password: creds.password
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    // Extract token from response
    const data = response.data;
    const token = data.data?.jwt_token || data.jwt_token || data.token || data.access_token;

    if (token) {
      cache.token = token;
      // Token typically valid for 24 hours, cache for 23 hours
      cache.expiry = Date.now() + (23 * 60 * 60 * 1000);
      console.log(`EasyEcom ${warehouse} authentication successful, token cached`);
      return token;
    } else {
      console.error('No token in EasyEcom auth response:', JSON.stringify(data).substring(0, 200));
      return null;
    }
  } catch (error) {
    console.error(`EasyEcom ${warehouse} authentication failed:`, error.response?.data || error.message);
    return null;
  }
}

// Create axios instance for EasyEcom API
const createEasyecomApi = () => {
  const headers = {
    'Content-Type': 'application/json'
  };

  // EasyEcom uses different auth methods - api-key or access token
  if (EASYECOM_API_KEY) {
    headers['api-key'] = EASYECOM_API_KEY;
  }
  if (EASYECOM_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${EASYECOM_ACCESS_TOKEN}`;
  }

  return axios.create({
    baseURL: EASYECOM_API_BASE,
    headers,
    timeout: 30000
  });
};

let easyecomApi = null;

const getApi = () => {
  if (!easyecomApi) {
    easyecomApi = createEasyecomApi();
  }
  return easyecomApi;
};

/**
 * Get order details from EasyEcom
 */
async function getOrder(orderId) {
  const api = getApi();

  try {
    const { data } = await api.get(`/orders/${orderId}`);
    return data.data || data;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch order from EasyEcom: ${error.message}`);
  }
}

/**
 * Search orders by reference code or invoice
 */
async function searchOrders(params) {
  const api = getApi();

  try {
    const { data } = await api.get('/orders', { params });
    return data.data || data.orders || [];
  } catch (error) {
    throw new Error(`Failed to search orders in EasyEcom: ${error.message}`);
  }
}

/**
 * Get available couriers for reverse pickup
 */
async function getReverseCouriers(warehouseId = null) {
  const api = getApi();

  try {
    const params = {};
    if (warehouseId) {
      params.warehouse_id = warehouseId;
    }

    const { data } = await api.get('/couriers/reverse', { params });
    return data.couriers || data.data || [];
  } catch (error) {
    console.warn('Failed to fetch reverse couriers:', error.message);
    // Return default couriers if API fails
    return [
      { id: 'delhivery', name: 'Delhivery', enabled: true },
      { id: 'bluedart', name: 'BlueDart', enabled: true },
      { id: 'xpressbees', name: 'XpressBees', enabled: true }
    ];
  }
}

/**
 * Create return/reverse pickup in EasyEcom
 *
 * @param {Object} returnData - Return request data
 * @param {number} returnData.order_id - EasyEcom order ID
 * @param {string} returnData.return_reason - Reason for return
 * @param {string} returnData.return_type - Type of return (customer_return, rto, etc.)
 * @param {Array} returnData.items - Items to return
 * @param {Object} returnData.pickup_address - Customer pickup address
 * @param {string} returnData.courier_id - Optional preferred courier
 */
async function createReturn(returnData) {
  const api = getApi();

  try {
    const payload = {
      order_id: returnData.order_id,
      return_reason: returnData.return_reason || 'Customer requested return',
      return_type: mapReturnType(returnData.return_type),
      products: returnData.items?.map(item => ({
        sku: item.sku,
        quantity: item.quantity || 1,
        product_name: item.product_name,
        reason: item.reason || returnData.return_reason
      })) || [],
      pickup_address: returnData.pickup_address || null,
      preferred_courier: returnData.courier_id || null,
      notes: returnData.notes || ''
    };

    const { data } = await api.post('/returns/initiate', payload);

    return {
      success: true,
      return_id: data.return_id || data.data?.return_id,
      awb_number: data.awb_number || data.data?.awb_number,
      courier_name: data.courier_name || data.data?.courier_name,
      tracking_url: data.tracking_url || data.data?.tracking_url,
      raw: data
    };
  } catch (error) {
    const errorMessage = error.response?.data?.message || error.message;
    return {
      success: false,
      error: errorMessage,
      raw: error.response?.data
    };
  }
}

/**
 * Map internal return type to EasyEcom return type
 */
function mapReturnType(internalType) {
  const typeMap = {
    'rto': 'RTO',
    'customer_return': 'CUSTOMER_RETURN',
    'cancellation': 'CANCELLATION',
    'partial_return': 'PARTIAL_RETURN',
    'wrong_quantity': 'QUALITY_ISSUE'
  };
  return typeMap[internalType] || 'CUSTOMER_RETURN';
}

/**
 * Get AWB number for a return
 */
async function getAwbNumber(returnId) {
  const api = getApi();

  try {
    const { data } = await api.get(`/returns/${returnId}/awb`);
    return {
      awb_number: data.awb_number || data.data?.awb_number,
      courier_name: data.courier_name || data.data?.courier_name,
      tracking_url: data.tracking_url || data.data?.tracking_url
    };
  } catch (error) {
    throw new Error(`Failed to fetch AWB: ${error.message}`);
  }
}

/**
 * Assign courier for return pickup
 */
async function assignCourier(returnId, courierId) {
  const api = getApi();

  try {
    const { data } = await api.post(`/returns/${returnId}/assign-courier`, {
      courier_id: courierId
    });

    return {
      success: true,
      awb_number: data.awb_number || data.data?.awb_number,
      courier_name: data.courier_name || data.data?.courier_name,
      tracking_url: data.tracking_url || data.data?.tracking_url,
      raw: data
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

/**
 * Get return status from EasyEcom
 */
async function getReturnStatus(returnId) {
  const api = getApi();

  try {
    const { data } = await api.get(`/returns/${returnId}`);

    return {
      success: true,
      status: data.status || data.data?.status,
      awb_number: data.awb_number || data.data?.awb_number,
      courier_name: data.courier_name || data.data?.courier_name,
      tracking_url: data.tracking_url || data.data?.tracking_url,
      pickup_date: data.pickup_date || data.data?.pickup_date,
      delivered_date: data.delivered_date || data.data?.delivered_date,
      raw: data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Cancel a return request
 */
async function cancelReturn(returnId, reason) {
  const api = getApi();

  try {
    const { data } = await api.post(`/returns/${returnId}/cancel`, {
      reason: reason || 'Cancelled by operator'
    });

    return {
      success: true,
      raw: data
    };
  } catch (error) {
    return {
      success: false,
      error: error.response?.data?.message || error.message
    };
  }
}

/**
 * Update return status (for webhook processing)
 */
function parseReturnWebhook(payload) {
  // Parse EasyEcom return webhook payload
  const data = payload.data || payload;

  return {
    return_id: data.return_id,
    order_id: data.order_id,
    status: data.status,
    awb_number: data.awb_number,
    courier_name: data.courier_name,
    pickup_date: data.pickup_date,
    delivery_date: data.delivery_date,
    tracking_events: data.tracking_events || []
  };
}

/**
 * Map EasyEcom return status to internal status
 */
function mapReturnStatus(easyecomStatus) {
  const statusMap = {
    'CREATED': 'approved',
    'AWB_GENERATED': 'pickup_scheduled',
    'PICKUP_SCHEDULED': 'pickup_scheduled',
    'PICKED_UP': 'picked_up',
    'IN_TRANSIT': 'in_transit',
    'OUT_FOR_DELIVERY': 'in_transit',
    'DELIVERED': 'received',
    'RECEIVED': 'received',
    'CANCELLED': 'cancelled',
    'FAILED': 'rejected'
  };

  return statusMap[easyecomStatus?.toUpperCase()] || 'pending_review';
}

/**
 * Get return pickup address from order
 */
function getPickupAddress(order) {
  if (!order) return null;

  // Use shipping address from order
  const addr = order.shipping_address || order.customer_address || {};

  return {
    name: addr.name || order.customer_name,
    phone: addr.phone || order.customer_phone,
    address_line1: addr.address1 || addr.address_line1,
    address_line2: addr.address2 || addr.address_line2,
    city: addr.city,
    state: addr.state || addr.province,
    pincode: addr.zip || addr.pincode || addr.postal_code,
    country: addr.country || 'India'
  };
}

/**
 * Check if EasyEcom is configured
 * @param {string} warehouse - Optional warehouse to check ('delhi' or 'faridabad')
 */
function isConfigured(warehouse = null) {
  if (warehouse) {
    const creds = WAREHOUSE_CREDENTIALS[warehouse.toLowerCase()];
    return !!(creds?.email && creds?.password);
  }
  // Check if at least one warehouse is configured
  return !!(EASYECOM_API_KEY || EASYECOM_ACCESS_TOKEN ||
    (EASYECOM_EMAIL && EASYECOM_PASSWORD) ||
    (EASYECOM_DELHI_EMAIL && EASYECOM_DELHI_PASSWORD));
}

/**
 * Get inventory from EasyEcom API (includes virtual inventory)
 * Uses getInventoryDetailsV3 endpoint
 *
 * V3 Response structure:
 * { data: { inventoryData: [...], nextUrl: "..." }, message: "..." }
 *
 * Each item has: sku, productName, availableInventory, virtual_inventory_count,
 * location_key, companyName (warehouse name)
 *
 * @param {string} warehouse - Warehouse to fetch: "delhi" or "faridabad"
 * @param {number} limit - Number of SKUs per page (default 100)
 */
async function* getInventoryFromApi(warehouse = 'faridabad', limit = 100) {
  const warehouseKey = (warehouse || 'faridabad').toLowerCase();
  const MAX_RETRIES = 5; // Increased from 3 to handle persistent 504s

  // Authenticate with the correct warehouse credentials
  const jwtToken = await authenticateWithCredentials(warehouseKey);

  if (!jwtToken) {
    throw new Error(`EasyEcom not configured for warehouse: ${warehouse}. Check credentials.`);
  }

  // Build headers
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwtToken}`
  };

  const api = axios.create({
    baseURL: EASYECOM_API_BASE,
    headers,
    timeout: 180000 // Increased to 3 minutes per request
  });

  let nextUrl = null;
  let page = 1;

  do {
    let retryCount = 0;
    let pageSuccess = false;
    let response = null;

    // Retry loop for transient errors (504, timeout, network issues)
    while (retryCount < MAX_RETRIES && !pageSuccess) {
      try {
        if (nextUrl) {
          console.log(`Fetching inventory page ${page}${retryCount > 0 ? ` (retry ${retryCount})` : ''}...`);
          response = await api.get(nextUrl);
        } else {
          const params = { limit, includeLocations: 1 };
          console.log(`Fetching inventory page ${page}${retryCount > 0 ? ` (retry ${retryCount})` : ''}...`);
          response = await api.get('/getInventoryDetailsV3', { params });
        }
        pageSuccess = true;

      } catch (error) {
        retryCount++;

        // Check if this is a transient error that should be retried
        const isTransientError =
          error.response?.status === 504 ||
          error.response?.status === 502 ||
          error.response?.status === 503 ||
          error.code === 'ECONNABORTED' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNRESET' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('timeout') ||
          error.message?.includes('socket hang up');

        // Handle 401 auth errors - refresh token and retry
        if (error.response?.status === 401) {
          console.warn(`Auth error on page ${page}, refreshing token...`);
          const cache = cachedTokens[warehouseKey];
          if (cache) {
            cache.token = null;
            cache.expiry = null;
          }
          const newToken = await authenticateWithCredentials(warehouseKey);
          if (newToken) {
            headers['Authorization'] = `Bearer ${newToken}`;
            api.defaults.headers['Authorization'] = `Bearer ${newToken}`;
            continue; // Retry with new token
          }
          throw new Error(`Failed to refresh auth token for ${warehouse}`);
        }

        // Retry transient errors with exponential backoff
        if (isTransientError && retryCount < MAX_RETRIES) {
          const delayMs = Math.min(5000 * Math.pow(2, retryCount - 1), 60000); // 5s, 10s, 20s, 40s, 60s
          console.warn(`Transient error on page ${page}: ${error.message}. Retrying in ${delayMs}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }

        // Max retries exceeded or non-transient error
        if (retryCount >= MAX_RETRIES) {
          console.error(`Failed to fetch page ${page} after ${MAX_RETRIES} retries: ${error.message}`);
          throw new Error(`Max retries exceeded on page ${page}: ${error.message}`);
        }

        console.error(`Non-transient error on page ${page}: ${error.message}`);
        throw error;
      }
    }

    // Process successful response
    const responseData = response.data;
    const items = responseData.data?.inventoryData || [];
    nextUrl = responseData.data?.nextUrl || null;

    // Diagnostic logging for pagination debugging
    const hasNextUrl = !!nextUrl;
    console.log(`Page ${page}: Got ${items.length} items, nextUrl: ${hasNextUrl ? 'present' : 'NULL'}`);

    if (items.length === 0) {
      console.log(`PAGINATION END: Empty items array on page ${page}. nextUrl was: ${hasNextUrl ? 'present' : 'NULL'}`);
      break;
    }

    for (const item of items) {
      yield {
        sku: item.sku,
        product_name: item.productName || item.product_name,
        available_qty: item.availableInventory || 0,
        virtual_qty: item.virtual_inventory_count || 0,
        total_qty: (item.availableInventory || 0) + (item.virtual_inventory_count || 0),
        warehouse_name: item.companyName,
        location_key: item.location_key,
        mrp: item.mrp,
        category: item.category,
        brand: item.brand,
        raw: item
      };
    }

    page++;

    // Log when pagination will end
    if (!nextUrl) {
      console.log(`PAGINATION END: nextUrl is NULL after page ${page - 1} with ${items.length} items`);
    }

    // Delay between pages to avoid rate limiting (500ms = 2 requests/sec)
    await new Promise(r => setTimeout(r, 500));

  } while (nextUrl);

  console.log(`Inventory fetch complete. Total pages fetched: ${page - 1}`);
}

/**
 * Verify EasyEcom webhook token
 */
function verifyWebhookToken(providedToken) {
  if (!EASYECOM_ACCESS_TOKEN) {
    console.warn('EASYECOM_ACCESS_TOKEN not configured for webhook verification');
    return true; // Skip verification if not configured
  }
  return providedToken === EASYECOM_ACCESS_TOKEN;
}

/**
 * Get list of return orders from EasyEcom
 * @param {Object} options - Filter options
 * @param {string} options.fromDate - Start date (YYYY-MM-DD)
 * @param {string} options.toDate - End date (YYYY-MM-DD)
 * @param {string} options.status - Return status filter
 * @param {number} options.page - Page number (default 1)
 * @param {number} options.limit - Items per page (default 100)
 * @param {string} warehouse - Warehouse key ('faridabad' or 'delhi')
 * @returns {Promise<Object>} Returns list with pagination info
 */
async function getReturnsList({ fromDate, toDate, status, page = 1, limit = 100 } = {}, warehouse = 'faridabad') {
  const token = await authenticateWithCredentials(warehouse);
  if (!token) {
    throw new Error(`Failed to authenticate with EasyEcom for warehouse: ${warehouse}`);
  }

  const params = {};
  if (fromDate && toDate) {
    params.created_after = fromDate;
    params.created_before = toDate;
  }

  console.log(`Fetching pending returns for ${warehouse} with params:`, JSON.stringify(params));

  const allReturns = [];
  let nextUrl = null;
  let pageNum = 1;

  try {
    do {
      const url = nextUrl || `${EASYECOM_API_BASE}/getPendingReturns`;
      const config = {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 60000
      };

      // Only add params on first request, subsequent use nextUrl directly
      if (!nextUrl) {
        config.params = params;
      }

      console.log(`Fetching pending returns page ${pageNum} for ${warehouse}...`);
      const response = nextUrl
        ? await axios.get(`${EASYECOM_API_BASE}${nextUrl}`, config)
        : await axios.get(url, config);

      const data = response.data;
      const returns = data.data?.pending_returns || [];
      allReturns.push(...returns);

      nextUrl = data.data?.nextUrl || null;
      pageNum++;

      console.log(`Page ${pageNum - 1}: Got ${returns.length} returns, total so far: ${allReturns.length}`);

      // Small delay to avoid rate limiting
      if (nextUrl) await new Promise(r => setTimeout(r, 200));

    } while (nextUrl);

    console.log(`Completed fetching pending returns for ${warehouse}: total ${allReturns.length}`);

    return {
      success: true,
      returns: allReturns,
      warehouse
    };
  } catch (error) {
    console.error(`Failed to fetch returns for ${warehouse}:`, error.response?.status, error.response?.data || error.message);
    return { success: false, returns: allReturns, warehouse, error: error.message };
  }
}

/**
 * Get all returns from all warehouses (pending returns)
 * @param {Object} options - Filter options
 * @returns {Promise<Array>} Combined returns from all warehouses
 */
async function getAllReturns(options = {}) {
  const warehouses = ['faridabad', 'delhi'];
  const results = [];

  for (const warehouse of warehouses) {
    try {
      const result = await getReturnsList(options, warehouse);
      if (result.success && result.returns) {
        results.push(...result.returns.map(r => ({ ...r, _warehouse: warehouse })));
      }
    } catch (error) {
      console.error(`Error fetching returns from ${warehouse}:`, error.message);
    }
  }

  return results;
}

/**
 * Get completed returns (credit notes) from EasyEcom
 * @param {Object} options - Filter options
 * @param {string} warehouse - Warehouse key ('faridabad' or 'delhi')
 * @returns {Promise<Object>} Completed returns list
 */
async function getCompletedReturns({ fromDate, toDate } = {}, warehouse = 'faridabad') {
  const token = await authenticateWithCredentials(warehouse);
  if (!token) {
    throw new Error(`Failed to authenticate with EasyEcom for warehouse: ${warehouse}`);
  }

  const params = {};
  if (fromDate && toDate) {
    params.created_after = fromDate;
    params.created_before = toDate;
  }

  console.log(`Fetching completed returns for ${warehouse} with params:`, JSON.stringify(params));

  const allReturns = [];
  let nextUrl = null;
  let pageNum = 1;

  try {
    do {
      const url = nextUrl || `${EASYECOM_API_BASE}/orders/getAllReturns`;
      const config = {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        timeout: 60000
      };

      if (!nextUrl) {
        config.params = params;
      }

      console.log(`Fetching completed returns page ${pageNum} for ${warehouse}...`);
      const response = nextUrl
        ? await axios.get(`${EASYECOM_API_BASE}${nextUrl}`, config)
        : await axios.get(url, config);

      const data = response.data;
      const returns = data.data?.credit_notes || data.data || [];
      allReturns.push(...(Array.isArray(returns) ? returns : []));

      nextUrl = data.data?.nextUrl || null;
      pageNum++;

      console.log(`Page ${pageNum - 1}: Got ${returns.length} completed returns, total so far: ${allReturns.length}`);

      if (nextUrl) await new Promise(r => setTimeout(r, 200));

    } while (nextUrl);

    console.log(`Completed fetching completed returns for ${warehouse}: total ${allReturns.length}`);

    return {
      success: true,
      returns: allReturns,
      warehouse
    };
  } catch (error) {
    console.error(`Failed to fetch completed returns for ${warehouse}:`, error.response?.status, error.response?.data || error.message);
    return { success: false, returns: allReturns, warehouse, error: error.message };
  }
}

/**
 * Get all completed returns from all warehouses
 * @param {Object} options - Filter options
 * @returns {Promise<Array>} Combined completed returns from all warehouses
 */
async function getAllCompletedReturns(options = {}) {
  const warehouses = ['faridabad', 'delhi'];
  const results = [];

  for (const warehouse of warehouses) {
    try {
      const result = await getCompletedReturns(options, warehouse);
      if (result.success && result.returns) {
        results.push(...result.returns.map(r => ({ ...r, _warehouse: warehouse })));
      }
    } catch (error) {
      console.error(`Error fetching completed returns from ${warehouse}:`, error.message);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Production Manager additions (V2.1 endpoints; legacy auth path)
// ---------------------------------------------------------------------------

function ensureAxiosForWarehouse(warehouseKey, timeoutMs = 60000) {
  return (async () => {
    const jwt = await authenticateWithCredentials(warehouseKey);
    if (!jwt) throw new Error(`EasyEcom not configured for warehouse: ${warehouseKey}`);
    return axios.create({
      baseURL: EASYECOM_API_BASE,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      timeout: timeoutMs,
    });
  })();
}

// GET /Products/GetProductMaster — full SKU/style catalog with custom fields.
// Returns an async generator of product rows; paginates via response.nextUrl when present.
async function* getProductMaster(warehouse = 'faridabad', { customFields = 1 } = {}) {
  const api = await ensureAxiosForWarehouse(warehouse, 120000);
  let nextUrl = null;
  let page = 1;
  do {
    const resp = nextUrl
      ? await api.get(nextUrl)
      : await api.get('/Products/GetProductMaster', { params: { custom_fields: customFields } });
    const data = resp.data && resp.data.data;
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.products) ? data.products : []);
    for (const r of rows) yield r;
    nextUrl = resp.data?.nextUrl || null;
    if (!nextUrl) break;
    page++;
    await new Promise(r => setTimeout(r, 400));
  } while (true);
}

// GET /inventory/getInventorySnapshotApi — returns an index of daily CSV files.
// Each row: { c_id, companyname, job_type_id, entry_date, file_url }
async function listInventorySnapshots({ startDate, endDate }, warehouse = 'faridabad') {
  const api = await ensureAxiosForWarehouse(warehouse, 60000);
  const resp = await api.get('/inventory/getInventorySnapshotApi', {
    params: { start_date: startDate, end_date: endDate },
  });
  return (resp.data?.data || []).filter(r => r && r.file_url);
}

// Download a CSV from a snapshot file_url. Returns the raw CSV text.
// Snapshot URLs are pre-signed S3 — no auth needed.
async function downloadSnapshotCsv(fileUrl) {
  const resp = await axios.get(fileUrl, { timeout: 600000, responseType: 'text' });
  return resp.data;
}

// Minimal RFC-4180 CSV parser. Returns array of objects keyed on header row.
// Handles quoted fields, embedded commas, escaped quotes ("").
function parseCsv(text) {
  if (!text) return [];
  const out = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { if (row.length > 1 || row[0] !== '') out.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  if (!out.length) return [];
  const header = out[0].map(h => String(h).trim());
  return out.slice(1).map(r => {
    const obj = {};
    for (let k = 0; k < header.length; k++) obj[header[k]] = r[k];
    return obj;
  });
}

// POST /reports/queue — async report generation. Returns reportId.
async function queueReport(reportType, params = {}, warehouse = 'faridabad') {
  const api = await ensureAxiosForWarehouse(warehouse, 60000);
  const body = Object.keys(params).length ? { reportType, params } : { reportType };
  const resp = await api.post('/reports/queue', body);
  const reportId = resp.data?.data?.reportId || resp.data?.reportId;
  if (!reportId) throw new Error(`Queue failed for ${reportType}: ${JSON.stringify(resp.data).slice(0,200)}`);
  return String(reportId);
}

// GET /reports/list — returns list of available reports with their statuses.
async function listReports(warehouse = 'faridabad') {
  const api = await ensureAxiosForWarehouse(warehouse, 30000);
  const resp = await api.get('/reports/list');
  return resp.data?.data || resp.data || [];
}

// Polls /reports/list until the given reportId is ready, then downloads via /reports/download.
// Returns parsed rows (array of objects).
async function waitForAndDownloadReport(reportId, warehouse = 'faridabad', { pollIntervalMs = 5000, maxWaitMs = 600000 } = {}) {
  const api = await ensureAxiosForWarehouse(warehouse, 120000);
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < maxWaitMs) {
    let entry = null;
    try {
      const list = await listReports(warehouse);
      entry = (Array.isArray(list) ? list : []).find(r =>
        String(r.reportId || r.id || r.report_id) === String(reportId)
      );
    } catch (_) {}
    const status = (entry?.status || entry?.report_status || '').toString().toLowerCase();
    if (status.includes('complete') || status.includes('ready') || status === 'done') { ready = true; break; }
    if (status.includes('fail') || status.includes('error')) {
      throw new Error(`Report ${reportId} failed: ${JSON.stringify(entry).slice(0,200)}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  if (!ready) throw new Error(`Report ${reportId} timed out after ${maxWaitMs}ms`);
  const dl = await api.get('/reports/download', { params: { reportId }, responseType: 'text' });
  const text = typeof dl.data === 'string' ? dl.data : JSON.stringify(dl.data);
  return parseCsv(text);
}

// Convenience wrappers — queue + poll + download for the reports we care about.
async function fetchMiniSalesReport({ startDate, endDate, warehouseIds, invoiceType = 'ALL', dateType = 'ORDER_DATE' }, warehouse = 'faridabad') {
  // EasyEcom rejects empty/missing warehouseIds with a 400 — only pass the
  // param when caller supplied a non-empty location-key list.
  const params = { invoiceType, dateType, startDate, endDate };
  if (warehouseIds && String(warehouseIds).trim()) params.warehouseIds = warehouseIds;
  const reportId = await queueReport('MINI_SALES_REPORT', params, warehouse);
  return waitForAndDownloadReport(reportId, warehouse);
}

async function fetchInventoryAgingReport(warehouse = 'faridabad') {
  const reportId = await queueReport('INVENTORY_AGING_REPORT', {}, warehouse);
  return waitForAndDownloadReport(reportId, warehouse);
}

async function fetchStatusWiseStockReport(warehouse = 'faridabad') {
  const reportId = await queueReport('STATUS_WISE_STOCK_REPORT', {}, warehouse);
  return waitForAndDownloadReport(reportId, warehouse);
}

// Per-warehouse cache of comma-joined location_key strings. EasyEcom requires
// `selectedLocations` for FULL_INVENTORY_REPORT and the keys are stable, so we
// only fetch them once per process.
const cachedLocationKeys = {};

async function getAllLocationKeys(warehouse = 'faridabad') {
  const key = warehouse.toLowerCase();
  if (cachedLocationKeys[key]) return cachedLocationKeys[key];
  const api = await ensureAxiosForWarehouse(warehouse, 30000);

  const FIELD_CANDIDATES = ['location_key', 'locationKey', 'token', 'location_token', 'companyToken', 'company_token', 'key'];
  const tryEndpoint = async (path) => {
    try {
      const resp = await api.get(path);
      const data = resp.data?.data ?? resp.data ?? [];
      const rows = Array.isArray(data) ? data : (data?.locations || data?.companies || []);
      const sample = JSON.stringify(rows[0] || {}).slice(0, 400);
      console.log(`[getAllLocationKeys:${warehouse}] ${path} → ${rows.length} rows. Sample keys: ${rows[0] ? Object.keys(rows[0]).join(',') : 'n/a'}. Sample: ${sample}`);
      return rows;
    } catch (err) {
      console.warn(`[getAllLocationKeys:${warehouse}] ${path} failed: ${err.response?.status || ''} ${err.message}`);
      return [];
    }
  };

  let rows = await tryEndpoint('/getAllLocation');
  let extracted = rows
    .map(r => FIELD_CANDIDATES.map(f => r[f]).find(Boolean))
    .filter(Boolean)
    .map(String);

  if (!extracted.length) {
    rows = await tryEndpoint('/account/v1/api/locations');
    extracted = rows
      .map(r => FIELD_CANDIDATES.map(f => r[f]).find(Boolean))
      .filter(Boolean)
      .map(String);
  }

  if (!extracted.length) {
    const sampleShape = rows[0] ? JSON.stringify(rows[0]).slice(0, 300) : 'no rows';
    throw new Error(`No location keys resolved for ${warehouse}. Last sample: ${sampleShape}`);
  }

  const joined = extracted.join(',');
  cachedLocationKeys[key] = joined;
  console.log(`[getAllLocationKeys:${warehouse}] Resolved ${extracted.length} location key(s): ${joined.slice(0, 200)}`);
  return joined;
}

// FULL_INVENTORY_REPORT — queues, polls, follows the S3 downloadUrl if present,
// and returns parsed rows. Emits onProgress({phase, status, elapsed, reportId})
// callbacks so the SSE route can stream user-visible progress while the report
// bakes server-side at EasyEcom. `selectedLocations` is required by EasyEcom;
// if caller omits it, we auto-discover via /getAllLocation.
async function fetchFullInventoryReport(
  warehouse = 'faridabad',
  { statuses = 'Available', locations = '', skus = '', bins = '' } = {},
  onProgress = () => {}
) {
  onProgress({ phase: 'resolving_locations' });
  const selectedLocations = locations || await getAllLocationKeys(warehouse);

  const params = {
    skus,
    bins,
    inventoryStatuses: statuses,
    selectedLocations,
    uomDetails: 1,
  };

  onProgress({ phase: 'queueing' });
  const reportId = await queueReport('FULL_INVENTORY_REPORT', params, warehouse);
  onProgress({ phase: 'queued', reportId });

  const api = await ensureAxiosForWarehouse(warehouse, 120000);
  const pollIntervalMs = 5000;
  const maxWaitMs = 900000; // 15 min — FULL_INVENTORY can be slower than smaller reports
  const start = Date.now();
  let ready = false;
  let lastStatus = '';
  while (Date.now() - start < maxWaitMs) {
    let entry = null;
    try {
      const list = await listReports(warehouse);
      entry = (Array.isArray(list) ? list : []).find(r =>
        String(r.reportId || r.id || r.report_id) === String(reportId)
      );
    } catch (_) {}
    const status = (entry?.status || entry?.report_status || entry?.reportStatus || '').toString().toLowerCase();
    if (status && status !== lastStatus) {
      lastStatus = status;
      onProgress({ phase: 'polling', reportId, status, elapsed: Math.round((Date.now() - start) / 1000) });
    }
    if (status.includes('complete') || status.includes('ready') || status === 'done') { ready = true; break; }
    if (status.includes('fail') || status.includes('error')) {
      throw new Error(`Report ${reportId} failed: ${JSON.stringify(entry).slice(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  if (!ready) throw new Error(`Report ${reportId} timed out after ${maxWaitMs}ms`);

  onProgress({ phase: 'downloading', reportId });
  const dl = await api.get('/reports/download', { params: { reportId }, responseType: 'text' });
  const raw = typeof dl.data === 'string' ? dl.data : JSON.stringify(dl.data);

  // EasyEcom may return either (a) raw CSV directly, or (b) a JSON envelope
  // `{ data: { reportStatus, downloadUrl } }` pointing at a pre-signed S3 CSV.
  // Handle both.
  let csvText = raw;
  if (raw && raw.trimStart().startsWith('{')) {
    try {
      const env = JSON.parse(raw);
      const url = env?.data?.downloadUrl || env?.downloadUrl;
      if (url) {
        onProgress({ phase: 'downloading_s3', reportId });
        const s3 = await axios.get(url, { timeout: 600000, responseType: 'text' });
        csvText = typeof s3.data === 'string' ? s3.data : JSON.stringify(s3.data);
      }
    } catch (_) {
      // Fall through and treat `raw` as CSV.
    }
  }

  onProgress({ phase: 'parsing', reportId });
  const rows = parseCsv(csvText);
  onProgress({ phase: 'parsed', reportId, rowCount: rows.length });
  return rows;
}

module.exports = {
  // Order operations
  getOrder,
  searchOrders,

  // Return operations
  createReturn,
  getAwbNumber,
  assignCourier,
  getReturnStatus,
  cancelReturn,
  getReverseCouriers,
  getReturnsList,
  getAllReturns,
  getCompletedReturns,
  getAllCompletedReturns,

  // Inventory operations (live API, includes virtual inventory)
  authenticateWithCredentials,
  getInventoryFromApi,

  // Production Manager additions
  getProductMaster,
  listInventorySnapshots,
  downloadSnapshotCsv,
  parseCsv,
  queueReport,
  listReports,
  waitForAndDownloadReport,
  fetchFullInventoryReport,
  fetchMiniSalesReport,
  fetchInventoryAgingReport,
  fetchStatusWiseStockReport,

  // Webhook handling
  parseReturnWebhook,
  mapReturnStatus,
  verifyWebhookToken,

  // Utilities
  getPickupAddress,
  isConfigured
};
