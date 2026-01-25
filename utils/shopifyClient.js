/**
 * Shopify API Client
 * Handles order lookup, refund processing, and return management
 */

const axios = require('axios');
const crypto = require('crypto');

// Configuration - these should be set in environment variables
// Uses global.env from secure-env (loaded in app.js) with fallback to process.env
const SHOPIFY_STORE = global.env?.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_STORE_DOMAIN || '';
const SHOPIFY_ACCESS_TOKEN = global.env?.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_API_VERSION = global.env?.SHOPIFY_API_VERSION || process.env.SHOPIFY_API_VERSION || '2024-01';
const SHOPIFY_WEBHOOK_SECRET = global.env?.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_WEBHOOK_SECRET || '';

// Create axios instance for Shopify API
const createShopifyApi = () => {
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    console.warn('Shopify credentials not configured. Set SHOPIFY_STORE_DOMAIN and SHOPIFY_ACCESS_TOKEN');
    return null;
  }

  return axios.create({
    baseURL: `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    timeout: 30000
  });
};

let shopifyApi = null;

const getApi = () => {
  if (!shopifyApi) {
    shopifyApi = createShopifyApi();
  }
  return shopifyApi;
};

/**
 * Get order by Shopify order ID
 */
async function getOrder(orderId) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.get(`/orders/${orderId}.json`);
    return data.order;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
}

/**
 * Get order by order name/number (e.g., "1234" or "#1234")
 */
async function getOrderByName(orderName) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const cleanName = orderName.replace('#', '').trim();
    const { data } = await api.get('/orders.json', {
      params: {
        name: cleanName,
        status: 'any',
        limit: 1
      }
    });
    return data.orders[0] || null;
  } catch (error) {
    throw new Error(`Failed to search order by name: ${error.message}`);
  }
}

/**
 * Search orders by customer phone number
 */
async function searchOrdersByPhone(phone) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    // Clean phone number - remove country code, spaces, dashes
    const cleanPhone = phone.replace(/[\s\-\+]/g, '').slice(-10);

    const { data } = await api.get('/orders.json', {
      params: {
        status: 'any',
        limit: 50
      }
    });

    // Filter by phone (Shopify doesn't support phone search directly)
    const orders = data.orders.filter(order => {
      const orderPhone = (order.phone || order.billing_address?.phone || order.shipping_address?.phone || '')
        .replace(/[\s\-\+]/g, '')
        .slice(-10);
      return orderPhone === cleanPhone;
    });

    return orders;
  } catch (error) {
    throw new Error(`Failed to search orders by phone: ${error.message}`);
  }
}

/**
 * Search orders by customer email
 */
async function searchOrdersByEmail(email) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.get('/orders.json', {
      params: {
        email: email.toLowerCase().trim(),
        status: 'any',
        limit: 50
      }
    });
    return data.orders;
  } catch (error) {
    throw new Error(`Failed to search orders by email: ${error.message}`);
  }
}

/**
 * Get fulfillments for an order
 */
async function getOrderFulfillments(orderId) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.get(`/orders/${orderId}/fulfillments.json`);
    return data.fulfillments;
  } catch (error) {
    throw new Error(`Failed to fetch fulfillments: ${error.message}`);
  }
}

/**
 * Calculate refund for given line items
 */
async function calculateRefund(orderId, lineItems, shipping = { full_refund: false }) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.post(`/orders/${orderId}/refunds/calculate.json`, {
      refund: {
        shipping,
        refund_line_items: lineItems.map(item => ({
          line_item_id: item.line_item_id,
          quantity: item.quantity,
          restock_type: item.restock_type || 'return'
        }))
      }
    });
    return data.refund;
  } catch (error) {
    throw new Error(`Failed to calculate refund: ${error.message}`);
  }
}

/**
 * Create refund for an order
 */
async function createRefund(orderId, refundData) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const payload = {
      refund: {
        currency: 'INR',
        notify: refundData.notify !== false, // Default to notify customer
        note: refundData.note || 'Refund processed via Kotty Track',
        shipping: refundData.shipping || { full_refund: false },
        refund_line_items: refundData.line_items?.map(item => ({
          line_item_id: item.line_item_id,
          quantity: item.quantity,
          restock_type: item.restock_type || 'return'
        })) || [],
        transactions: refundData.transactions || []
      }
    };

    const { data } = await api.post(`/orders/${orderId}/refunds.json`, payload);
    return data.refund;
  } catch (error) {
    const errorMsg = error.response?.data?.errors || error.message;
    throw new Error(`Failed to create refund: ${JSON.stringify(errorMsg)}`);
  }
}

/**
 * Get existing refunds for an order
 */
async function getOrderRefunds(orderId) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.get(`/orders/${orderId}/refunds.json`);
    return data.refunds;
  } catch (error) {
    throw new Error(`Failed to fetch refunds: ${error.message}`);
  }
}

/**
 * Create return in Shopify (if using Shopify's return system)
 */
async function createReturn(orderId, returnData) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    // Note: This uses Shopify's newer Return API
    // May need to use GraphQL for full return functionality
    const payload = {
      return: {
        order_id: orderId,
        return_line_items: returnData.line_items.map(item => ({
          fulfillment_line_item_id: item.fulfillment_line_item_id,
          quantity: item.quantity,
          return_reason: item.return_reason || 'CUSTOMER_CHANGED_MIND',
          return_reason_note: item.return_reason_note || ''
        }))
      }
    };

    // Note: Returns API endpoint structure may vary by Shopify version
    const { data } = await api.post('/returns.json', payload);
    return data.return;
  } catch (error) {
    // If return API isn't available, return null
    console.warn('Shopify Returns API not available or error:', error.message);
    return null;
  }
}

/**
 * Add note to order
 */
async function addOrderNote(orderId, note) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const order = await getOrder(orderId);
    const existingNote = order.note || '';
    const timestamp = new Date().toISOString();
    const newNote = `${existingNote}\n\n[${timestamp}] ${note}`.trim();

    const { data } = await api.put(`/orders/${orderId}.json`, {
      order: { id: orderId, note: newNote }
    });
    return data.order;
  } catch (error) {
    throw new Error(`Failed to add order note: ${error.message}`);
  }
}

/**
 * Add tag to order
 */
async function addOrderTag(orderId, tag) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const order = await getOrder(orderId);
    const existingTags = order.tags ? order.tags.split(',').map(t => t.trim()) : [];

    if (!existingTags.includes(tag)) {
      existingTags.push(tag);
      const { data } = await api.put(`/orders/${orderId}.json`, {
        order: { id: orderId, tags: existingTags.join(', ') }
      });
      return data.order;
    }
    return order;
  } catch (error) {
    throw new Error(`Failed to add order tag: ${error.message}`);
  }
}

/**
 * Verify Shopify webhook HMAC signature
 */
function verifyWebhookHmac(rawBody, hmacHeader) {
  if (!SHOPIFY_WEBHOOK_SECRET) {
    console.warn('SHOPIFY_WEBHOOK_SECRET not configured');
    return false;
  }

  const hash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody, 'utf8')
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(hmacHeader)
  );
}

/**
 * Determine if order is prepaid or COD
 */
function getOrderPaymentType(order) {
  if (!order) return null;

  // Check payment gateway names for COD indicators
  const codGateways = ['cash_on_delivery', 'cod', 'cash on delivery', 'manual'];
  const gateway = (order.gateway || '').toLowerCase();

  if (codGateways.some(g => gateway.includes(g))) {
    return 'cod';
  }

  // Check financial status
  if (order.financial_status === 'pending' && order.fulfillment_status === 'fulfilled') {
    return 'cod';
  }

  // Check payment method in transactions
  if (order.payment_gateway_names) {
    const hasCod = order.payment_gateway_names.some(pg =>
      codGateways.some(g => pg.toLowerCase().includes(g))
    );
    if (hasCod) return 'cod';
  }

  return 'prepaid';
}

/**
 * Get delivery date from order fulfillments
 */
function getDeliveryDate(order) {
  if (!order || !order.fulfillments || order.fulfillments.length === 0) {
    return null;
  }

  // Find the latest fulfillment with delivered status
  const deliveredFulfillment = order.fulfillments
    .filter(f => f.shipment_status === 'delivered' || f.status === 'success')
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];

  if (deliveredFulfillment) {
    return deliveredFulfillment.updated_at;
  }

  // If no delivered status, use the fulfillment created date as estimate
  const latestFulfillment = order.fulfillments
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

  return latestFulfillment?.created_at || null;
}

/**
 * Extract line items for return from order
 */
function extractLineItems(order) {
  if (!order || !order.line_items) return [];

  return order.line_items.map(item => ({
    line_item_id: item.id,
    variant_id: item.variant_id,
    product_id: item.product_id,
    sku: item.sku || '',
    product_name: item.name || item.title,
    variant_title: item.variant_title,
    quantity: item.quantity,
    fulfillable_quantity: item.fulfillable_quantity,
    unit_price: parseFloat(item.price),
    tax_amount: item.tax_lines?.reduce((sum, t) => sum + parseFloat(t.price), 0) || 0,
    discount_amount: item.total_discount ? parseFloat(item.total_discount) : 0,
    total: parseFloat(item.price) * item.quantity
  }));
}

/**
 * Check if Shopify is configured
 */
function isConfigured() {
  return !!(SHOPIFY_STORE && SHOPIFY_ACCESS_TOKEN);
}

module.exports = {
  // Order operations
  getOrder,
  getOrderByName,
  searchOrdersByPhone,
  searchOrdersByEmail,
  getOrderFulfillments,

  // Refund operations
  calculateRefund,
  createRefund,
  getOrderRefunds,

  // Return operations
  createReturn,

  // Order updates
  addOrderNote,
  addOrderTag,

  // Webhook verification
  verifyWebhookHmac,

  // Utilities
  getOrderPaymentType,
  getDeliveryDate,
  extractLineItems,
  isConfigured
};
