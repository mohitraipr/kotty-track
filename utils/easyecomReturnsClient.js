/**
 * EasyEcom Returns API Client
 * Handles return creation, AWB fetching, and courier assignment
 */

const axios = require('axios');

// Configuration from environment
// Uses global.env from secure-env (loaded in app.js) with fallback to process.env
const EASYECOM_API_BASE = global.env?.EASYECOM_API_BASE || process.env.EASYECOM_API_BASE || 'https://api.easyecom.io';
const EASYECOM_API_KEY = global.env?.EASYECOM_API_KEY || process.env.EASYECOM_API_KEY || '';
const EASYECOM_ACCESS_TOKEN = global.env?.EASYEECOM_ACCESS_TOKEN || process.env.EASYEECOM_ACCESS_TOKEN || '';

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
 */
function isConfigured() {
  return !!(EASYECOM_API_KEY || EASYECOM_ACCESS_TOKEN);
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

  // Webhook handling
  parseReturnWebhook,
  mapReturnStatus,
  verifyWebhookToken,

  // Utilities
  getPickupAddress,
  isConfigured
};
