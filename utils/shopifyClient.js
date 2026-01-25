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
 * Get orders by customer identifier (email or phone)
 * Uses Shopify customer search for better accuracy
 */
async function getOrdersByCustomerIdentifier(identifier) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const cleanIdentifier = identifier.trim();

    // If it looks like an email, search orders directly by email (most efficient)
    if (cleanIdentifier.includes('@')) {
      const { data } = await api.get('/orders.json', {
        params: {
          email: cleanIdentifier.toLowerCase(),
          status: 'any',
          limit: 50
        }
      });
      return data.orders || [];
    }

    // For phone, first search for customer
    const cleanPhone = cleanIdentifier.replace(/[\s\-\+]/g, '').slice(-10);

    // Search customer by phone
    const { data: customerData } = await api.get('/customers/search.json', {
      params: { query: cleanPhone }
    });

    if (!customerData.customers || customerData.customers.length === 0) {
      // Fallback: try direct order search
      return await searchOrdersByPhone(cleanPhone);
    }

    // Get orders for found customer
    const customerId = customerData.customers[0].id;
    const { data: orderData } = await api.get('/orders.json', {
      params: {
        customer_id: customerId,
        status: 'any',
        limit: 50
      }
    });

    return orderData.orders || [];
  } catch (error) {
    console.error('Error in getOrdersByCustomerIdentifier:', error.message);
    throw new Error(`Failed to fetch orders: ${error.message}`);
  }
}

/**
 * Filter orders eligible for return
 * @param {Array} orders - List of orders from Shopify
 * @param {number} windowDays - Return window in days (default 10)
 */
function filterEligibleOrders(orders, windowDays = 10) {
  if (!orders || orders.length === 0) return [];

  const now = Date.now();

  return orders.map(order => {
    // Check fulfillment and delivery status
    const isFulfilled = order.fulfillment_status === 'fulfilled';

    // Check actual delivery status from fulfillments
    const fulfillment = order.fulfillments?.[0];
    const shipmentStatus = fulfillment?.shipment_status || null;

    // Determine if actually delivered (not failed, not in transit)
    const isDelivered = shipmentStatus === 'delivered' ||
                        shipmentStatus === 'success' ||
                        (isFulfilled && !shipmentStatus); // Assume delivered if no status but fulfilled

    const isFailedDelivery = shipmentStatus === 'failure' ||
                             shipmentStatus === 'attempted_delivery';

    const isInTransit = shipmentStatus === 'in_transit' ||
                        shipmentStatus === 'out_for_delivery';

    // Calculate days since delivery
    const deliveryDate = getDeliveryDate(order);
    let daysSinceDelivery = null;
    let isWithinWindow = false;

    if (deliveryDate && isDelivered) {
      daysSinceDelivery = Math.floor((now - new Date(deliveryDate)) / (1000 * 60 * 60 * 24));
      isWithinWindow = daysSinceDelivery <= windowDays;
    } else if (isFulfilled && fulfillment && !isFailedDelivery) {
      // If no delivery date but fulfilled and not failed, use fulfillment date
      const fulfillmentDate = new Date(fulfillment.created_at);
      daysSinceDelivery = Math.floor((now - fulfillmentDate) / (1000 * 60 * 60 * 24));
      isWithinWindow = daysSinceDelivery <= windowDays;
    }

    // Determine return eligibility (only delivered within window)
    const eligible = isDelivered && isWithinWindow;

    // Determine if can raise issue (any order that exists)
    // Past window orders and failed deliveries can raise issues but not returns
    const canRaiseIssue = true; // All orders can raise issues

    // Reason for ineligibility
    let ineligibleReason = null;
    let status = 'eligible';

    if (isFailedDelivery) {
      ineligibleReason = 'Delivery failed - please raise an issue';
      status = 'failed_delivery';
    } else if (isInTransit) {
      ineligibleReason = 'Order is still in transit';
      status = 'in_transit';
    } else if (!isFulfilled) {
      ineligibleReason = 'Order not yet shipped';
      status = 'not_shipped';
    } else if (!isDelivered) {
      ineligibleReason = 'Awaiting delivery confirmation';
      status = 'awaiting_delivery';
    } else if (!isWithinWindow) {
      ineligibleReason = `Return window expired (${daysSinceDelivery} days ago) - you can still raise an issue`;
      status = 'window_expired';
    }

    return {
      ...order,
      returnEligibility: {
        eligible,
        canRaiseIssue,
        status,
        reason: ineligibleReason,
        daysSinceDelivery,
        windowDays,
        shipmentStatus,
        isDelivered,
        isFailedDelivery
      }
    };
  }).sort((a, b) => {
    // Sort: eligible first, then by status priority, then by date
    if (a.returnEligibility.eligible !== b.returnEligibility.eligible) {
      return a.returnEligibility.eligible ? -1 : 1;
    }
    // Secondary sort: window_expired before failed_delivery before others
    const statusPriority = { 'window_expired': 1, 'failed_delivery': 2, 'in_transit': 3, 'not_shipped': 4 };
    const aPriority = statusPriority[a.returnEligibility.status] || 5;
    const bPriority = statusPriority[b.returnEligibility.status] || 5;
    if (aPriority !== bPriority) return aPriority - bPriority;

    return new Date(b.created_at) - new Date(a.created_at);
  });
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
 * Map line_item_id to fulfillment_line_item_id
 * Returns array with fulfillment_line_item_id added for each item
 */
async function mapLineItemsToFulfillmentItems(orderId, lineItems) {
  const fulfillments = await getOrderFulfillments(orderId);

  if (!fulfillments || fulfillments.length === 0) {
    throw new Error('Order has no fulfillments - cannot create return');
  }

  // Build a map of line_item_id -> fulfillment_line_item_id
  const lineItemMap = {};
  for (const fulfillment of fulfillments) {
    for (const lineItem of fulfillment.line_items || []) {
      // Store the fulfillment line item ID keyed by both line_item_id and id
      lineItemMap[lineItem.line_item_id] = lineItem.id;
      lineItemMap[lineItem.id] = lineItem.id; // In case id is passed directly
    }
  }

  // Map the requested line items to fulfillment line items
  return lineItems.map(item => {
    const lineItemId = item.line_item_id || item.id;
    const fulfillmentLineItemId = lineItemMap[lineItemId];

    if (!fulfillmentLineItemId) {
      console.warn(`[Shopify] Could not find fulfillment_line_item_id for line_item ${lineItemId}`);
    }

    return {
      ...item,
      fulfillment_line_item_id: item.fulfillment_line_item_id || fulfillmentLineItemId
    };
  }).filter(item => item.fulfillment_line_item_id); // Only include items with valid fulfillment IDs
}

/**
 * Create return in Shopify
 * @param {number} orderId - Shopify order ID
 * @param {object} returnData - Return data containing line_items
 * @param {array} returnData.line_items - Items to return with line_item_id, quantity, return_reason
 * @param {string} returnData.notify_customer - Whether to notify customer (default true)
 * @returns {object} - Created return object with id, or throws error
 */
async function createReturn(orderId, returnData) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    // Map line items to fulfillment line items
    const mappedItems = await mapLineItemsToFulfillmentItems(orderId, returnData.line_items || []);

    if (mappedItems.length === 0) {
      throw new Error('No valid line items with fulfillment IDs found for return');
    }

    // Map return reason to Shopify return reason enum
    const reasonMap = {
      'size_issue': 'SIZE_TOO_SMALL', // or SIZE_TOO_LARGE
      'quality_issue': 'DEFECTIVE',
      'wrong_product': 'WRONG_ITEM',
      'not_as_described': 'NOT_AS_DESCRIBED',
      'damaged_in_transit': 'DAMAGED_IN_TRANSIT',
      'changed_mind': 'UNWANTED',
      'other': 'OTHER',
      'missing_items': 'MISSING_PARTS'
    };

    const payload = {
      return: {
        order_id: orderId,
        return_line_items: mappedItems.map(item => ({
          fulfillment_line_item_id: item.fulfillment_line_item_id,
          quantity: item.quantity || 1,
          return_reason: reasonMap[item.return_reason] || item.return_reason || 'UNWANTED',
          return_reason_note: item.return_reason_note || item.notes || ''
        })),
        notify_customer: returnData.notify_customer !== false
      }
    };

    console.log('[Shopify] Creating return with payload:', JSON.stringify(payload, null, 2));

    const { data } = await api.post('/returns.json', payload);

    console.log('[Shopify] Return created successfully:', data.return?.id);
    return data.return;
  } catch (error) {
    const errorMessage = error.response?.data?.errors || error.message;
    console.error('[Shopify] Failed to create return:', errorMessage);

    // Throw with detailed error message
    throw new Error(`Failed to create Shopify return: ${JSON.stringify(errorMessage)}`);
  }
}

/**
 * Get return by ID from Shopify
 */
async function getReturn(returnId) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const { data } = await api.get(`/returns/${returnId}.json`);
    return data.return;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;
    }
    throw new Error(`Failed to fetch return: ${error.message}`);
  }
}

/**
 * Get all returns for an order
 */
async function getOrderReturns(orderId) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    // Shopify doesn't have a direct endpoint for order returns via REST
    // We need to fetch returns and filter by order_id
    const { data } = await api.get('/returns.json', {
      params: { order_id: orderId }
    });
    return data.returns || [];
  } catch (error) {
    console.warn('[Shopify] Could not fetch returns for order:', error.message);
    return [];
  }
}

/**
 * Get all returns from Shopify (paginated)
 * @param {object} options - Query options
 * @param {number} options.limit - Max returns per page (default 50)
 * @param {string} options.status - Filter by status (open, closed, cancelled)
 * @param {string} options.created_at_min - Filter by min created date
 */
async function getAllReturns(options = {}) {
  const api = getApi();
  if (!api) throw new Error('Shopify API not configured');

  try {
    const params = {
      limit: options.limit || 50
    };
    if (options.status) params.status = options.status;
    if (options.created_at_min) params.created_at_min = options.created_at_min;

    const { data } = await api.get('/returns.json', { params });
    return data.returns || [];
  } catch (error) {
    console.warn('[Shopify] Could not fetch returns:', error.message);
    return [];
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
  getOrdersByCustomerIdentifier,
  filterEligibleOrders,
  getOrderFulfillments,

  // Refund operations
  calculateRefund,
  createRefund,
  getOrderRefunds,

  // Return operations
  createReturn,
  getReturn,
  getOrderReturns,
  getAllReturns,
  mapLineItemsToFulfillmentItems,

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
