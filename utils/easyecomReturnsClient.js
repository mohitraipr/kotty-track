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

  const warehouseKey = warehouse.toLowerCase();
  const creds = WAREHOUSE_CREDENTIALS[warehouseKey] || WAREHOUSE_CREDENTIALS.faridabad;

  const params = {};
  // EasyEcom requires created_after/created_before together, max 7 day range
  if (fromDate && toDate) {
    params.created_after = fromDate;
    params.created_before = toDate;
  }

  console.log(`Fetching pending returns for ${warehouse} with params:`, JSON.stringify(params));

  try {
    const response = await axios.get(`${EASYECOM_API_BASE}/getPendingReturns`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-api-key': EASYECOM_API_KEY
      },
      params,
      timeout: 60000
    });

    const data = response.data;
    console.log(`Returns API response for ${warehouse}: code=${data.code}, count=${(data.data || []).length}`);

    return {
      success: data.code === 200 || data.success !== false,
      returns: data.data || [],
      pagination: {
        page: data.page || page,
        limit: data.limit || limit,
        total: data.total || (data.data || []).length,
        hasMore: data.hasMore || false
      },
      warehouse
    };
  } catch (error) {
    console.error(`Failed to fetch returns for ${warehouse}:`, error.response?.status, error.response?.data || error.message);
    return { success: false, returns: [], warehouse, error: error.message };
  }
}

/**
 * Get all returns from all warehouses
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

  // Inventory operations (live API, includes virtual inventory)
  authenticateWithCredentials,
  getInventoryFromApi,

  // Webhook handling
  parseReturnWebhook,
  mapReturnStatus,
  verifyWebhookToken,

  // Utilities
  getPickupAddress,
  isConfigured
};
