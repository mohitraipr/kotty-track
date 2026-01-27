/**
 * Return Management Routes
 * Handles customer return requests, operator dashboard, and refund processing
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const { isAuthenticated, isMohitOperator } = require('../middlewares/auth');
const returnHelpers = require('../utils/returnHelpers');
const shopifyClient = require('../utils/shopifyClient');
const easyecomClient = require('../utils/easyecomReturnsClient');

// Middleware: Allow returns dashboard access
function allowReturnsAccess(req, res, next) {
  const username = req.session?.user?.username?.toLowerCase();
  const role = req.session?.user?.roleName;

  // Allow mohitOperator, operators, or returns_operator role
  if (username === 'mohitoperator' ||
      role === 'operator' ||
      role === 'returns_operator' ||
      role === 'admin') {
    return next();
  }

  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(403).json({ error: 'Access denied' });
  }

  req.flash && req.flash('error', 'You do not have permission to view this page.');
  return res.redirect('/');
}

// ===============================
// CUSTOMER-FACING PUBLIC ENDPOINTS
// ===============================

/**
 * GET /returns/request
 * Render customer return request form
 */
router.get('/request', (req, res) => {
  res.render('returns/customerReturnForm', {
    title: 'Request a Return'
  });
});

/**
 * POST /returns/api/lookup-orders
 * Lookup orders by email or phone for customer return form
 */
router.post('/api/lookup-orders', async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier || identifier.trim().length < 5) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email or phone number'
      });
    }

    if (!shopifyClient.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: 'Order lookup is temporarily unavailable'
      });
    }

    // Get orders by email or phone
    const orders = await shopifyClient.getOrdersByCustomerIdentifier(identifier.trim());

    if (!orders || orders.length === 0) {
      return res.json({
        success: false,
        message: 'No orders found for this email/phone. Please check and try again.'
      });
    }

    // Filter and add eligibility info
    const ordersWithEligibility = shopifyClient.filterEligibleOrders(orders, 10);

    // Simplify order data for frontend (include customer info for display)
    const simplifiedOrders = ordersWithEligibility.map(order => {
      // Extract customer name from various sources
      const customerName = order.shipping_address?.name
        || order.billing_address?.name
        || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim()
        || null;

      // Extract customer phone from various sources
      const customerPhone = order.phone
        || order.shipping_address?.phone
        || order.billing_address?.phone
        || order.customer?.phone
        || null;

      // Extract customer email
      const customerEmail = order.email || order.customer?.email || null;

      return {
        id: order.id,
        name: order.name,
        email: customerEmail,
        customer_name: customerName,
        customer_phone: customerPhone,
        created_at: order.created_at,
        total_price: order.total_price,
        fulfillment_status: order.fulfillment_status,
        financial_status: order.financial_status,
        shipping_address: order.shipping_address ? {
          name: order.shipping_address.name,
          phone: order.shipping_address.phone,
          address1: order.shipping_address.address1,
          city: order.shipping_address.city,
          province: order.shipping_address.province,
          zip: order.shipping_address.zip
        } : null,
        line_items: order.line_items?.map(item => ({
          id: item.id,
          name: item.name || item.title,
          title: item.title,
          variant_title: item.variant_title,
          sku: item.sku,
          quantity: item.quantity,
          price: item.price,
          image_url: item.image_url || null
        })) || [],
        returnEligibility: order.returnEligibility
      };
    });

    return res.json({
      success: true,
      orders: simplifiedOrders
    });

  } catch (error) {
    console.error('Error looking up orders:', error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: 'Failed to lookup orders. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /returns/api/request
 * Customer submits return request (no authentication required)
 * Supports both legacy (orderIdentifier) and new form (shopifyOrderId) submissions
 */
router.post('/api/request', async (req, res) => {
  try {
    const {
      orderIdentifier,
      shopifyOrderId: directOrderId,
      orderName: directOrderName,
      email,
      customerName: formCustomerName,
      customerPhone: formCustomerPhone,
      lookupIdentifier, // The email or phone customer entered in lookup
      returnReason,
      notes,
      source,
      selectedItems,
      isIssue,
      bankDetails // Bank details for COD orders
    } = req.body;

    console.log('[Return Request] Received:', { directOrderId, directOrderName, email, formCustomerName, formCustomerPhone, lookupIdentifier, returnReason, source, isIssue, hasBankDetails: !!bankDetails });

    let order = null;
    let orders = [];

    // New form submission: directOrderId is provided
    if (directOrderId && shopifyClient.isConfigured()) {
      console.log('[Return Request] Fetching Shopify order:', directOrderId);
      order = await shopifyClient.getOrder(directOrderId);

      if (order) {
        // Log full raw data to debug customer data issue
        console.log('[Return Request] RAW ORDER DATA:', JSON.stringify({
          id: order.id,
          name: order.name,
          email: order.email,
          phone: order.phone,
          contact_email: order.contact_email,
          customer: order.customer,
          shipping_address: order.shipping_address,
          billing_address: order.billing_address
        }, null, 2));
      } else {
        console.log('[Return Request] NO ORDER FOUND for ID:', directOrderId);
      }
    }
    // Legacy form submission: orderIdentifier is provided
    else if (orderIdentifier) {
      const parsed = returnHelpers.parseOrderIdentifier(orderIdentifier);

      if (shopifyClient.isConfigured()) {
        if (parsed.type === 'order_number') {
          order = await shopifyClient.getOrderByName(parsed.value);
        } else if (parsed.type === 'phone') {
          orders = await shopifyClient.searchOrdersByPhone(parsed.value);
          if (orders.length === 1) {
            order = orders[0];
          }
        } else if (parsed.type === 'email' && email) {
          orders = await shopifyClient.searchOrdersByEmail(email);
          if (orders.length === 1) {
            order = orders[0];
          }
        }
      }
    } else {
      return res.status(400).json({ success: false, message: 'Order identifier is required' });
    }

    // Generate return ID
    const returnId = returnHelpers.generateReturnId();

    // Determine order type and details
    let orderType = 'prepaid';
    let orderDate = null;
    let deliveryDate = null;
    let originalTotal = null;
    let customerName = formCustomerName || null; // Prioritize form data
    let shopifyOrderId = directOrderId || null;
    let shopifyOrderName = directOrderName || null;
    let returnType = isIssue ? 'customer_issue' : 'customer_return';

    // Use lookupIdentifier (what customer entered) as primary source for contact info
    // This is reliable because customer verified it by finding their order with it
    const isLookupEmail = lookupIdentifier && lookupIdentifier.includes('@');
    let customerEmail = email || (isLookupEmail ? lookupIdentifier : null);
    let customerPhone = formCustomerPhone || (!isLookupEmail && lookupIdentifier ? lookupIdentifier : null);

    if (order) {
      orderType = shopifyClient.getOrderPaymentType(order);
      orderDate = order.created_at;
      deliveryDate = shopifyClient.getDeliveryDate(order);
      originalTotal = parseFloat(order.total_price) || 0;

      // Extract customer name - prioritize form data, then check order
      if (!customerName) {
        customerName = order.shipping_address?.name
          || order.billing_address?.name
          || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim()
          || null;
      }

      // Extract customer phone - prioritize form data, then check order
      if (!customerPhone) {
        customerPhone = order.phone
          || order.shipping_address?.phone
          || order.billing_address?.phone
          || order.customer?.phone
          || null;
      }

      // Use order ID/name from Shopify if fetched
      shopifyOrderId = order.id;
      shopifyOrderName = order.name;

      console.log('[Return Request] Extracted customer data:', { customerName, customerPhone, customerEmail, shopifyOrderId, shopifyOrderName, returnType });

      // Extract customer email from order if not provided in form
      if (!customerEmail) {
        customerEmail = order.email || order.customer?.email || null;
      }

      // Check for duplicate return (prevent multiple returns for same order)
      const [existingReturns] = await pool.query(`
        SELECT return_id, status FROM returns
        WHERE shopify_order_id = ? AND status NOT IN ('rejected', 'cancelled')
      `, [shopifyOrderId]);

      if (existingReturns.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'A return request already exists for this order.',
          existingReturnId: existingReturns[0].return_id,
          existingStatus: existingReturns[0].status
        });
      }
    }

    // Insert return request into database (returnType already set based on isIssue flag)
    const insertQuery = `
      INSERT INTO returns (
        return_id, shopify_order_id, shopify_order_name,
        customer_phone, customer_email, customer_name,
        order_type, order_date, delivery_date, original_total,
        return_type, return_reason, customer_notes, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')
    `;

    await pool.query(insertQuery, [
      returnId,
      shopifyOrderId,
      shopifyOrderName,
      customerPhone || null,
      customerEmail,
      customerName || null,
      orderType,
      orderDate,
      deliveryDate,
      originalTotal,
      returnType,
      returnReason || null,
      notes || null
    ]);

    // Get the inserted return ID
    const [[{ id: dbReturnId }]] = await pool.query(
      'SELECT id FROM returns WHERE return_id = ?',
      [returnId]
    );

    // If we have order line items, insert them
    if (order && order.line_items) {
      const lineItems = shopifyClient.extractLineItems(order);
      for (const item of lineItems) {
        await pool.query(`
          INSERT INTO return_items (
            return_id, sku, product_name, variant_title, size,
            ordered_quantity, return_quantity, unit_price, tax_amount,
            discount_amount, shopify_line_item_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          dbReturnId,
          item.sku,
          item.product_name,
          item.variant_title,
          item.variant_title, // Use variant as size for now
          item.quantity,
          item.quantity, // Default: return all
          item.unit_price,
          item.tax_amount,
          item.discount_amount,
          item.line_item_id
        ]);
      }
    }

    // Log audit entry
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, new_status, actor_type, actor_name, ip_address)
      VALUES (?, 'return_requested', 'pending_review', 'customer', ?, ?)
    `, [dbReturnId, email || 'Customer', req.ip]);

    // Save bank details if provided (for COD orders)
    if (bankDetails && orderType === 'cod') {
      try {
        // Generate a token for the bank details link (in case needed later)
        const crypto = require('crypto');
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours

        if (bankDetails.type === 'upi') {
          await pool.query(`
            INSERT INTO return_bank_details (return_id, token, upi_id, submitted_at, expires_at)
            VALUES (?, ?, ?, NOW(), ?)
          `, [dbReturnId, token, bankDetails.upi_id, expiresAt]);
          console.log(`[Return Request] Saved UPI details for return ${returnId}`);
        } else if (bankDetails.type === 'bank') {
          await pool.query(`
            INSERT INTO return_bank_details (return_id, token, account_holder_name, bank_name, account_number, ifsc_code, submitted_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
          `, [dbReturnId, token, bankDetails.account_holder_name, bankDetails.bank_name, bankDetails.account_number, bankDetails.ifsc_code, expiresAt]);
          console.log(`[Return Request] Saved bank details for return ${returnId}`);
        }
      } catch (bankError) {
        console.error('[Return Request] Failed to save bank details:', bankError.message);
        // Don't fail the request, bank details can be collected later
      }
    }

    // Check for auto-approval
    const settings = await returnHelpers.getSettings(pool);
    const returnRequest = { delivery_date: deliveryDate, requested_at: new Date(), return_type: returnType };

    if (returnHelpers.shouldAutoApprove(returnRequest, settings)) {
      // Auto-approve the return
      await pool.query(
        'UPDATE returns SET status = ?, approved_at = NOW() WHERE id = ?',
        ['approved', dbReturnId]
      );

      await pool.query(`
        INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_name)
        VALUES (?, 'auto_approved', 'pending_review', 'approved', 'system', 'Auto-approval system')
      `, [dbReturnId]);
    }

    return res.json({
      success: true,
      returnId: returnId,
      message: 'Return request submitted successfully'
    });

  } catch (error) {
    console.error('Error creating return request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to submit return request. Please try again.'
    });
  }
});

/**
 * GET /returns/bank-details/:token
 * Bank details form (public, token-authenticated)
 */
router.get('/bank-details/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const [rows] = await pool.query(`
      SELECT bd.*, r.return_id, r.refund_amount, r.customer_name, r.status
      FROM return_bank_details bd
      JOIN returns r ON r.id = bd.return_id
      WHERE bd.access_token = ? AND bd.token_expires_at > NOW()
    `, [token]);

    if (!rows.length) {
      return res.status(404).render('returns/bankDetailsExpired', {
        title: 'Link Expired',
        message: 'This bank details link has expired or is invalid.'
      });
    }

    const bankDetails = rows[0];

    // Check if already submitted
    if (bankDetails.submitted_at) {
      return res.render('returns/bankDetailsSuccess', {
        title: 'Details Already Submitted',
        returnData: bankDetails
      });
    }

    return res.render('returns/bankDetailsForm', {
      title: 'Enter Bank Details',
      token: token,
      returnData: bankDetails
    });

  } catch (error) {
    console.error('Error loading bank details form:', error);
    return res.status(500).send('An error occurred');
  }
});

/**
 * POST /returns/bank-details/:token
 * Submit bank details
 */
router.post('/bank-details/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const {
      payment_method,
      upi_id,
      account_holder_name,
      bank_name,
      account_number,
      ifsc_code
    } = req.body;

    // Validate token
    const [rows] = await pool.query(`
      SELECT bd.*, r.id as return_db_id
      FROM return_bank_details bd
      JOIN returns r ON r.id = bd.return_id
      WHERE bd.access_token = ? AND bd.token_expires_at > NOW()
    `, [token]);

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'Invalid or expired token' });
    }

    const bankDetails = rows[0];

    // Validate input based on payment method
    if (payment_method === 'upi') {
      if (!upi_id || !returnHelpers.isValidUpiId(upi_id)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid UPI ID' });
      }
    } else if (payment_method === 'bank') {
      if (!account_holder_name || !bank_name || !account_number || !ifsc_code) {
        return res.status(400).json({ success: false, message: 'All bank details are required' });
      }
      if (!returnHelpers.isValidIfsc(ifsc_code)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid IFSC code' });
      }
    }

    // Update bank details
    await pool.query(`
      UPDATE return_bank_details SET
        upi_id = ?,
        account_holder_name = ?,
        bank_name = ?,
        account_number = ?,
        ifsc_code = ?,
        submitted_at = NOW()
      WHERE id = ?
    `, [
      payment_method === 'upi' ? upi_id : null,
      payment_method === 'bank' ? account_holder_name : null,
      payment_method === 'bank' ? bank_name : null,
      payment_method === 'bank' ? account_number : null,
      payment_method === 'bank' ? (ifsc_code ? ifsc_code.toUpperCase() : null) : null,
      bankDetails.id
    ]);

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, actor_type, actor_name)
      VALUES (?, 'bank_details_submitted', 'customer', 'Customer')
    `, [bankDetails.return_id]);

    // Redirect to success page
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, message: 'Bank details submitted successfully' });
    }

    return res.redirect(`/returns/bank-details/${token}/success`);

  } catch (error) {
    console.error('Error submitting bank details:', error);
    return res.status(500).json({ success: false, message: 'Failed to submit bank details' });
  }
});

/**
 * GET /returns/bank-details/:token/success
 * Bank details submission success page
 */
router.get('/bank-details/:token/success', async (req, res) => {
  return res.render('returns/bankDetailsSuccess', {
    title: 'Details Submitted',
    message: 'Your bank details have been submitted successfully. Your refund will be processed within 2-3 business days.'
  });
});

/**
 * GET /returns/track/:returnId
 * Customer tracking page (public)
 */
router.get('/track/:returnId', async (req, res) => {
  try {
    const { returnId } = req.params;

    const [rows] = await pool.query(`
      SELECT r.*,
             (SELECT COUNT(*) FROM return_items WHERE return_id = r.id) as item_count
      FROM returns r
      WHERE r.return_id = ?
    `, [returnId]);

    if (!rows.length) {
      return res.status(404).render('returns/trackingNotFound', {
        title: 'Return Not Found'
      });
    }

    const returnData = rows[0];
    const statusConfig = returnHelpers.STATUS_CONFIG[returnData.status] || {};

    return res.render('returns/tracking', {
      title: 'Track Your Return',
      returnData,
      statusConfig,
      formatDate: returnHelpers.formatDate,
      formatCurrency: returnHelpers.formatCurrency
    });

  } catch (error) {
    console.error('Error loading tracking page:', error);
    return res.status(500).send('An error occurred');
  }
});

// ===============================
// OPERATOR DASHBOARD (AUTH REQUIRED)
// ===============================

/**
 * GET /returns/dashboard
 * Main returns management dashboard
 */
router.get('/dashboard', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { status = 'all', page = 1, search = '' } = req.query;
    const limit = 50;
    const offset = (parseInt(page) - 1) * limit;

    // Get statistics
    const stats = await returnHelpers.getReturnStats(pool);

    // Build query for returns list
    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status !== 'all') {
      whereClause += ' AND r.status = ?';
      params.push(status);
    }

    if (search) {
      whereClause += ' AND (r.return_id LIKE ? OR r.shopify_order_name LIKE ? OR r.customer_phone LIKE ? OR r.customer_name LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }

    // Get returns
    const [returns] = await pool.query(`
      SELECT r.*,
             (SELECT COUNT(*) FROM return_items WHERE return_id = r.id) as item_count,
             (SELECT submitted_at FROM return_bank_details WHERE return_id = r.id) as bank_details_submitted
      FROM returns r
      ${whereClause}
      ORDER BY r.requested_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    // Get total count for pagination
    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) as total FROM returns r ${whereClause}
    `, params);

    return res.render('returns/returnsDashboard', {
      title: 'Returns Management',
      user: req.session.user,
      returns,
      stats,
      activeStatus: status,
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / limit),
      search,
      STATUS_CONFIG: returnHelpers.STATUS_CONFIG,
      formatDate: returnHelpers.formatDate,
      formatCurrency: returnHelpers.formatCurrency
    });

  } catch (error) {
    console.error('Error loading returns dashboard:', error);
    return res.status(500).send('Failed to load dashboard');
  }
});

/**
 * GET /returns/dashboard/data
 * AJAX data refresh for dashboard
 */
router.get('/dashboard/data', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { status = 'all', search = '' } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status !== 'all') {
      whereClause += ' AND r.status = ?';
      params.push(status);
    }

    if (search) {
      whereClause += ' AND (r.return_id LIKE ? OR r.shopify_order_name LIKE ? OR r.customer_phone LIKE ?)';
      const searchPattern = `%${search}%`;
      params.push(searchPattern, searchPattern, searchPattern);
    }

    const [returns] = await pool.query(`
      SELECT r.*,
             (SELECT submitted_at FROM return_bank_details WHERE return_id = r.id) as bank_details_submitted
      FROM returns r
      ${whereClause}
      ORDER BY r.requested_at DESC
      LIMIT 100
    `, params);

    const stats = await returnHelpers.getReturnStats(pool);

    return res.json({ returns, stats });

  } catch (error) {
    console.error('Error fetching returns data:', error);
    return res.status(500).json({ error: 'Failed to fetch data' });
  }
});

/**
 * GET /returns/cash-flow
 * Cash flow view for pending refunds
 */
router.get('/cash-flow', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    // Get all pending refunds with bank details
    const [pendingRefunds] = await pool.query(`
      SELECT r.*, bd.upi_id, bd.account_holder_name, bd.bank_name,
             bd.account_number, bd.ifsc_code, bd.submitted_at as bank_submitted_at
      FROM returns r
      LEFT JOIN return_bank_details bd ON bd.return_id = r.id
      WHERE r.status IN ('refund_pending', 'refund_processing')
      ORDER BY r.picked_at ASC
    `);

    // Calculate totals
    const totalPending = pendingRefunds.reduce((sum, r) => sum + (parseFloat(r.refund_amount) || 0), 0);
    const withBankDetails = pendingRefunds.filter(r => r.bank_submitted_at).length;
    const withoutBankDetails = pendingRefunds.filter(r => !r.bank_submitted_at && r.order_type === 'cod').length;

    return res.render('returns/cashFlow', {
      title: 'Cash Flow - Pending Refunds',
      user: req.session.user,
      pendingRefunds,
      totalPending,
      withBankDetails,
      withoutBankDetails,
      formatDate: returnHelpers.formatDate,
      formatCurrency: returnHelpers.formatCurrency,
      maskAccountNumber: returnHelpers.maskAccountNumber
    });

  } catch (error) {
    console.error('Error loading cash flow:', error);
    return res.status(500).send('Failed to load cash flow');
  }
});

/**
 * GET /returns/:id
 * Return detail view
 */
router.get('/:id(\\d+)', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;

    // Get return details
    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).send('Return not found');
    }

    // Get return items
    const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [id]);

    // Get bank details if exists
    const [[bankDetails]] = await pool.query('SELECT * FROM return_bank_details WHERE return_id = ?', [id]);

    // Get refund transactions
    const [refunds] = await pool.query('SELECT * FROM return_refunds WHERE return_id = ? ORDER BY created_at DESC', [id]);

    // Get audit log
    const [auditLog] = await pool.query(
      'SELECT * FROM return_audit_log WHERE return_id = ? ORDER BY created_at DESC LIMIT 20',
      [id]
    );

    // Get allowed next statuses
    const allowedNextStatuses = returnHelpers.getAllowedNextStatuses(returnData.status);

    // Calculate refund eligibility
    const refundEligibility = returnHelpers.calculateRefundEligibility(returnData);

    return res.render('returns/returnDetail', {
      title: `Return ${returnData.return_id}`,
      user: req.session.user,
      returnData,
      items,
      bankDetails,
      refunds,
      auditLog,
      allowedNextStatuses,
      refundEligibility,
      STATUS_CONFIG: returnHelpers.STATUS_CONFIG,
      RETURN_TYPE_CONFIG: returnHelpers.RETURN_TYPE_CONFIG,
      formatDate: returnHelpers.formatDate,
      formatCurrency: returnHelpers.formatCurrency,
      maskAccountNumber: returnHelpers.maskAccountNumber
    });

  } catch (error) {
    console.error('Error loading return detail:', error);
    return res.status(500).send('Failed to load return details');
  }
});

/**
 * POST /returns/:id/approve
 * Approve a return request
 */
router.post('/:id/approve', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!returnHelpers.isValidTransition(returnData.status, 'approved')) {
      return res.status(400).json({ success: false, message: 'Cannot approve from current status' });
    }

    // Update status
    await pool.query(
      'UPDATE returns SET status = ?, approved_at = NOW(), assigned_operator_id = ? WHERE id = ?',
      ['approved', user.id, id]
    );

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'approved', ?, 'approved', 'operator', ?, ?, ?)
    `, [id, returnData.status, user.id, user.username, JSON.stringify({ notes })]);

    // Sync to Shopify - add tag and create Shopify return when return is approved
    let shopifyReturnId = null;
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        // Add tag and note
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Approved');
        await shopifyClient.addOrderNote(returnData.shopify_order_id, `Return ${returnData.return_id} approved`);

        // Get return items from database
        const [returnItems] = await pool.query(
          'SELECT * FROM return_items WHERE return_id = ?',
          [id]
        );

        // Try to create Shopify return if we have items
        if (returnItems && returnItems.length > 0) {
          try {
            const shopifyReturn = await shopifyClient.createReturn(returnData.shopify_order_id, {
              line_items: returnItems.map(item => ({
                line_item_id: item.shopify_line_item_id,
                quantity: item.return_quantity || 1,
                return_reason: returnData.return_reason || 'changed_mind',
                return_reason_note: returnData.customer_notes || ''
              })),
              notify_customer: true
            });

            if (shopifyReturn && shopifyReturn.id) {
              shopifyReturnId = shopifyReturn.id;
              // Store Shopify return ID
              await pool.query(
                'UPDATE returns SET shopify_return_id = ? WHERE id = ?',
                [shopifyReturnId, id]
              );
              console.log(`[Return Approval] Created Shopify return ${shopifyReturnId} for return ${returnData.return_id}`);
            }
          } catch (returnError) {
            // Log but don't fail the approval - Shopify return is optional
            console.warn('[Return Approval] Could not create Shopify return:', returnError.message);
          }
        } else {
          // No return_items - try using line items from Shopify order directly
          try {
            const order = await shopifyClient.getOrder(returnData.shopify_order_id);
            if (order && order.line_items && order.line_items.length > 0) {
              const shopifyReturn = await shopifyClient.createReturn(returnData.shopify_order_id, {
                line_items: order.line_items.map(item => ({
                  line_item_id: item.id,
                  quantity: item.quantity,
                  return_reason: returnData.return_reason || 'changed_mind',
                  return_reason_note: returnData.customer_notes || ''
                })),
                notify_customer: true
              });

              if (shopifyReturn && shopifyReturn.id) {
                shopifyReturnId = shopifyReturn.id;
                await pool.query(
                  'UPDATE returns SET shopify_return_id = ? WHERE id = ?',
                  [shopifyReturnId, id]
                );
                console.log(`[Return Approval] Created Shopify return ${shopifyReturnId} for return ${returnData.return_id}`);
              }
            }
          } catch (orderReturnError) {
            console.warn('[Return Approval] Could not create Shopify return from order:', orderReturnError.message);
          }
        }
      } catch (shopifyError) {
        console.error('Failed to sync approval to Shopify:', shopifyError.message);
      }
    }

    return res.json({
      success: true,
      message: 'Return approved successfully',
      shopifyReturnId: shopifyReturnId
    });

  } catch (error) {
    console.error('Error approving return:', error);
    return res.status(500).json({ success: false, message: 'Failed to approve return' });
  }
});

/**
 * POST /returns/:id/reject
 * Reject a return request
 */
router.post('/:id/reject', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!returnHelpers.isValidTransition(returnData.status, 'rejected')) {
      return res.status(400).json({ success: false, message: 'Cannot reject from current status' });
    }

    await pool.query('UPDATE returns SET status = ? WHERE id = ?', ['rejected', id]);

    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'rejected', ?, 'rejected', 'operator', ?, ?, ?)
    `, [id, returnData.status, user.id, user.username, JSON.stringify({ reason })]);

    return res.json({ success: true, message: 'Return rejected' });

  } catch (error) {
    console.error('Error rejecting return:', error);
    return res.status(500).json({ success: false, message: 'Failed to reject return' });
  }
});

/**
 * POST /returns/:id/initiate-pickup
 * Create return in EasyEcom and get AWB
 */
router.post('/:id/initiate-pickup', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { courier_id } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (returnData.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'Return must be approved first' });
    }

    // Get return items
    const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [id]);

    // Get order from Shopify for pickup address
    let pickupAddress = null;
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      const order = await shopifyClient.getOrder(returnData.shopify_order_id);
      if (order) {
        pickupAddress = {
          name: order.shipping_address?.name || returnData.customer_name,
          phone: order.shipping_address?.phone || returnData.customer_phone,
          address_line1: order.shipping_address?.address1,
          address_line2: order.shipping_address?.address2,
          city: order.shipping_address?.city,
          state: order.shipping_address?.province,
          pincode: order.shipping_address?.zip,
          country: 'India'
        };
      }
    }

    // Create return in EasyEcom
    let easyecomResult = { success: false };
    let easyecomOrderId = returnData.easyecom_order_id;

    console.log('[Initiate Pickup] Starting EasyEcom flow:', {
      returnId: returnData.return_id,
      shopifyOrderName: returnData.shopify_order_name,
      existingEasyecomOrderId: easyecomOrderId,
      easyecomConfigured: easyecomClient.isConfigured()
    });

    if (easyecomClient.isConfigured()) {
      // If EasyEcom order ID not set, try to find it by Shopify order name
      if (!easyecomOrderId && returnData.shopify_order_name) {
        try {
          const orderName = returnData.shopify_order_name.replace('#', '').trim();
          console.log('[Initiate Pickup] Searching EasyEcom for order:', orderName);
          const easyecomOrders = await easyecomClient.searchOrders({ reference_code: orderName });
          console.log('[Initiate Pickup] EasyEcom search result:', easyecomOrders);
          if (easyecomOrders && easyecomOrders.length > 0) {
            easyecomOrderId = easyecomOrders[0].id || easyecomOrders[0].order_id;
            console.log('[Initiate Pickup] Found EasyEcom order ID:', easyecomOrderId);
            // Save the found EasyEcom order ID for future use
            if (easyecomOrderId) {
              await pool.query('UPDATE returns SET easyecom_order_id = ? WHERE id = ?', [easyecomOrderId, id]);
            }
          } else {
            console.log('[Initiate Pickup] No EasyEcom order found for:', orderName);
          }
        } catch (searchError) {
          console.error('[Initiate Pickup] Failed to search EasyEcom order:', searchError.message);
        }
      }

      if (easyecomOrderId) {
        console.log('[Initiate Pickup] Creating return in EasyEcom with order ID:', easyecomOrderId);
        easyecomResult = await easyecomClient.createReturn({
          order_id: easyecomOrderId,
          return_reason: returnData.return_reason,
          return_type: returnData.return_type,
          items: items.map(item => ({
            sku: item.sku,
            quantity: item.return_quantity,
            product_name: item.product_name,
            reason: returnData.return_reason
          })),
          pickup_address: pickupAddress,
          courier_id: courier_id
        });
        console.log('[Initiate Pickup] EasyEcom createReturn result:', easyecomResult);
      } else {
        console.log('[Initiate Pickup] No EasyEcom order ID - skipping EasyEcom return creation');
      }
    } else {
      console.log('[Initiate Pickup] EasyEcom not configured');
    }

    // Update return with AWB info
    if (easyecomResult.success) {
      await pool.query(`
        UPDATE returns SET
          status = 'pickup_scheduled',
          easyecom_return_id = ?,
          awb_number = ?,
          courier_name = ?,
          courier_tracking_url = ?
        WHERE id = ?
      `, [
        easyecomResult.return_id,
        easyecomResult.awb_number,
        easyecomResult.courier_name,
        easyecomResult.tracking_url,
        id
      ]);
    } else {
      // Even if EasyEcom fails, move to pickup_scheduled for manual handling
      await pool.query('UPDATE returns SET status = ? WHERE id = ?', ['pickup_scheduled', id]);
    }

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'pickup_initiated', 'approved', 'pickup_scheduled', 'operator', ?, ?, ?)
    `, [id, user.id, user.username, JSON.stringify({
      easyecom_success: easyecomResult.success,
      awb: easyecomResult.awb_number,
      courier: easyecomResult.courier_name
    })]);

    // Sync to Shopify - add tag and note when AWB is generated
    if (easyecomResult.success && easyecomResult.awb_number && returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Pickup-Scheduled');
        const noteText = `Return ${returnData.return_id} - Pickup scheduled. AWB: ${easyecomResult.awb_number}${easyecomResult.courier_name ? ` (${easyecomResult.courier_name})` : ''}`;
        await shopifyClient.addOrderNote(returnData.shopify_order_id, noteText);
      } catch (shopifyError) {
        console.error('Failed to sync pickup to Shopify:', shopifyError.message);
      }
    }

    return res.json({
      success: true,
      message: easyecomResult.success
        ? `Pickup scheduled. AWB: ${easyecomResult.awb_number}`
        : 'Return moved to pickup scheduled. Please create AWB manually.',
      awb: easyecomResult.awb_number,
      courier: easyecomResult.courier_name
    });

  } catch (error) {
    console.error('Error initiating pickup:', error);
    return res.status(500).json({ success: false, message: 'Failed to initiate pickup' });
  }
});

/**
 * POST /returns/:id/mark-picked
 * Mark return as picked up by courier
 */
router.post('/:id/mark-picked', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    await pool.query(
      'UPDATE returns SET status = ?, picked_at = NOW() WHERE id = ?',
      ['picked_up', id]
    );

    // For COD orders, create bank details token
    if (returnData.order_type === 'cod') {
      const token = returnHelpers.generateBankDetailsToken();
      const expiryHours = 72;

      await pool.query(`
        INSERT INTO return_bank_details (return_id, access_token, token_expires_at)
        VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))
        ON DUPLICATE KEY UPDATE access_token = ?, token_expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR)
      `, [id, token, expiryHours, token, expiryHours]);
    }

    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name)
      VALUES (?, 'marked_picked', ?, 'picked_up', 'operator', ?, ?)
    `, [id, returnData.status, user.id, user.username]);

    return res.json({ success: true, message: 'Return marked as picked up' });

  } catch (error) {
    console.error('Error marking picked:', error);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /returns/:id/mark-received
 * Mark return as received at warehouse
 */
router.post('/:id/mark-received', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    // Calculate refund amount from items
    const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [id]);
    const refundAmount = returnHelpers.calculateRefundAmount(items);

    await pool.query(
      'UPDATE returns SET status = ?, received_at = NOW(), refund_amount = ? WHERE id = ?',
      ['refund_pending', id, refundAmount]
    );

    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'marked_received', ?, 'refund_pending', 'operator', ?, ?, ?)
    `, [id, returnData.status, user.id, user.username, JSON.stringify({ refund_amount: refundAmount })]);

    // Sync to Shopify - add tag when return is received
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Received');
        await shopifyClient.addOrderNote(returnData.shopify_order_id, `Return ${returnData.return_id} received at warehouse. Refund amount: ₹${refundAmount}`);
      } catch (shopifyError) {
        console.error('Failed to sync received status to Shopify:', shopifyError.message);
      }
    }

    return res.json({ success: true, message: 'Return marked as received. Ready for refund processing.' });

  } catch (error) {
    console.error('Error marking received:', error);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /returns/:id/send-bank-link
 * Send bank details collection link to customer
 */
router.post('/:id/send-bank-link', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (returnData.order_type !== 'cod') {
      return res.status(400).json({ success: false, message: 'Bank details only needed for COD orders' });
    }

    // Get or create bank details token
    let [[existing]] = await pool.query('SELECT * FROM return_bank_details WHERE return_id = ?', [id]);

    if (!existing || new Date(existing.token_expires_at) < new Date()) {
      const token = returnHelpers.generateBankDetailsToken();
      const expiryHours = 72;

      if (existing) {
        await pool.query(
          'UPDATE return_bank_details SET access_token = ?, token_expires_at = DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE return_id = ?',
          [token, expiryHours, id]
        );
      } else {
        await pool.query(
          'INSERT INTO return_bank_details (return_id, access_token, token_expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
          [id, token, expiryHours]
        );
      }

      [[existing]] = await pool.query('SELECT * FROM return_bank_details WHERE return_id = ?', [id]);
    }

    // Generate link
    const baseUrl = process.env.APP_URL || 'https://erp.kotty.in';
    const bankLink = `${baseUrl}/returns/bank-details/${existing.access_token}`;

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, actor_type, actor_id, actor_name, details)
      VALUES (?, 'bank_link_generated', 'operator', ?, ?, ?)
    `, [id, user.id, user.username, JSON.stringify({ link: bankLink })]);

    return res.json({
      success: true,
      message: 'Bank details link generated',
      link: bankLink,
      phone: returnData.customer_phone
    });

  } catch (error) {
    console.error('Error generating bank link:', error);
    return res.status(500).json({ success: false, message: 'Failed to generate bank link' });
  }
});

/**
 * POST /returns/:id/process-refund
 * Process refund (Shopify or manual)
 */
router.post('/:id/process-refund', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { refund_method, transaction_reference, notes } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!['refund_pending', 'refund_processing'].includes(returnData.status)) {
      return res.status(400).json({ success: false, message: 'Return is not ready for refund' });
    }

    const refundAmount = parseFloat(returnData.refund_amount) || 0;

    if (refundAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid refund amount' });
    }

    let shopifyRefundId = null;

    // Process Shopify refund for prepaid orders
    if (refund_method === 'shopify_refund' && returnData.order_type === 'prepaid') {
      if (!shopifyClient.isConfigured()) {
        return res.status(400).json({ success: false, message: 'Shopify not configured' });
      }

      try {
        // Get line items to refund
        const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [id]);

        const lineItemsToRefund = items.map(item => ({
          line_item_id: item.shopify_line_item_id,
          quantity: item.return_quantity,
          restock_type: 'return'
        }));

        const refund = await shopifyClient.createRefund(returnData.shopify_order_id, {
          line_items: lineItemsToRefund,
          note: `Refund for return ${returnData.return_id}`,
          notify: true
        });

        shopifyRefundId = refund.id;
      } catch (shopifyError) {
        console.error('Shopify refund error:', shopifyError);
        return res.status(500).json({ success: false, message: `Shopify refund failed: ${shopifyError.message}` });
      }
    }

    // Create refund transaction record
    await pool.query(`
      INSERT INTO return_refunds (return_id, refund_method, amount, shopify_refund_id, transaction_reference, status, processed_by, processed_at, notes)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, NOW(), ?)
    `, [id, refund_method, refundAmount, shopifyRefundId, transaction_reference, user.id, notes]);

    // Update return status
    await pool.query(`
      UPDATE returns SET
        status = 'refunded',
        refund_method = ?,
        shopify_refund_id = ?,
        refunded_at = NOW()
      WHERE id = ?
    `, [refund_method, shopifyRefundId, id]);

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'refund_processed', ?, 'refunded', 'operator', ?, ?, ?)
    `, [id, returnData.status, user.id, user.username, JSON.stringify({
      method: refund_method,
      amount: refundAmount,
      shopify_refund_id: shopifyRefundId,
      transaction_reference
    })]);

    // Sync to Shopify - add tag and note when refund is processed
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Refunded');
        const noteText = `Return ${returnData.return_id} refunded. Amount: ₹${refundAmount} via ${refund_method}${shopifyRefundId ? ` (Shopify Refund ID: ${shopifyRefundId})` : ''}`;
        await shopifyClient.addOrderNote(returnData.shopify_order_id, noteText);
      } catch (e) {
        console.warn('Failed to sync refund to Shopify:', e.message);
      }
    }

    return res.json({
      success: true,
      message: 'Refund processed successfully',
      shopify_refund_id: shopifyRefundId
    });

  } catch (error) {
    console.error('Error processing refund:', error);
    return res.status(500).json({ success: false, message: 'Failed to process refund' });
  }
});

/**
 * POST /returns/:id/update-status
 * Generic status update endpoint
 */
router.post('/:id/update-status', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (!returnHelpers.isValidTransition(returnData.status, status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from ${returnData.status} to ${status}`
      });
    }

    await pool.query('UPDATE returns SET status = ? WHERE id = ?', [status, id]);

    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'status_updated', ?, ?, 'operator', ?, ?, ?)
    `, [id, returnData.status, status, user.id, user.username, JSON.stringify({ notes })]);

    return res.json({ success: true, message: 'Status updated' });

  } catch (error) {
    console.error('Error updating status:', error);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /returns/:id/update-awb
 * Update AWB number manually and sync to Shopify
 */
router.post('/:id/update-awb', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { awb_number, courier_name } = req.body;
    const user = req.session.user;

    if (!awb_number) {
      return res.status(400).json({ success: false, message: 'AWB number is required' });
    }

    // Get return data to find Shopify order
    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);
    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    await pool.query(
      'UPDATE returns SET awb_number = ?, courier_name = ? WHERE id = ?',
      [awb_number, courier_name || null, id]
    );

    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, actor_type, actor_id, actor_name, details)
      VALUES (?, 'awb_updated', 'operator', ?, ?, ?)
    `, [id, user.id, user.username, JSON.stringify({ awb_number, courier_name })]);

    // Sync to Shopify - add tag and note to the order
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        // Add return tag to order
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Pickup-Scheduled');

        // Add note with AWB details
        const noteText = `Return ${returnData.return_id} - Pickup scheduled. AWB: ${awb_number}${courier_name ? ` (${courier_name})` : ''}`;
        await shopifyClient.addOrderNote(returnData.shopify_order_id, noteText);
      } catch (shopifyError) {
        console.error('Failed to sync AWB to Shopify:', shopifyError.message);
        // Don't fail the request, just log the error
      }
    }

    return res.json({ success: true, message: 'AWB updated and synced to Shopify' });

  } catch (error) {
    console.error('Error updating AWB:', error);
    return res.status(500).json({ success: false, message: 'Failed to update AWB' });
  }
});

/**
 * POST /returns/:id/sync-status
 * Fetch and sync status from all sources (Shopify, EasyEcom, Courier)
 */
router.post('/:id/sync-status', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);
    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    const syncResults = {
      shopify: null,
      easyecom: null,
      courier: null,
      statusUpdated: false,
      previousStatus: returnData.status,
      newStatus: returnData.status
    };

    // 1. Fetch from Shopify
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        const order = await shopifyClient.getOrder(returnData.shopify_order_id);
        if (order) {
          syncResults.shopify = {
            financial_status: order.financial_status,
            fulfillment_status: order.fulfillment_status,
            tags: order.tags,
            refunds: order.refunds ? order.refunds.length : 0
          };

          // Check if refund was processed in Shopify
          if (order.refunds && order.refunds.length > 0 && returnData.status !== 'refunded') {
            // Check if there's a refund after return was created
            const latestRefund = order.refunds.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
            if (new Date(latestRefund.created_at) > new Date(returnData.requested_at)) {
              syncResults.shopify.refundDetected = true;
              syncResults.shopify.refundId = latestRefund.id;
              syncResults.shopify.refundAmount = latestRefund.transactions?.reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);
            }
          }

          // Check Shopify return status if we have a return ID
          if (returnData.shopify_return_id) {
            try {
              const shopifyReturn = await shopifyClient.getReturn(returnData.shopify_return_id);
              if (shopifyReturn) {
                syncResults.shopify.returnStatus = shopifyReturn.status;
              }
            } catch (e) {
              console.warn('Could not fetch Shopify return:', e.message);
            }
          }
        }
      } catch (error) {
        syncResults.shopify = { error: error.message };
      }
    }

    // 2. Fetch from EasyEcom
    if (returnData.easyecom_return_id && easyecomClient.isConfigured()) {
      try {
        const easyecomStatus = await easyecomClient.getReturnStatus(returnData.easyecom_return_id);
        if (easyecomStatus.success) {
          syncResults.easyecom = {
            status: easyecomStatus.status,
            awb_number: easyecomStatus.awb_number,
            courier_name: easyecomStatus.courier_name,
            tracking_url: easyecomStatus.tracking_url,
            pickup_date: easyecomStatus.pickup_date,
            delivered_date: easyecomStatus.delivered_date
          };

          // Update AWB if we got one and don't have it
          if (easyecomStatus.awb_number && !returnData.awb_number) {
            await pool.query(
              'UPDATE returns SET awb_number = ?, courier_name = ?, courier_tracking_url = ? WHERE id = ?',
              [easyecomStatus.awb_number, easyecomStatus.courier_name, easyecomStatus.tracking_url, id]
            );
            syncResults.easyecom.awbUpdated = true;
          }

          // Map EasyEcom status to internal status
          const mappedStatus = easyecomClient.mapReturnStatus(easyecomStatus.status);
          if (mappedStatus && mappedStatus !== returnData.status) {
            if (returnHelpers.isValidTransition(returnData.status, mappedStatus)) {
              syncResults.newStatus = mappedStatus;
              syncResults.statusUpdated = true;
            }
          }
        }
      } catch (error) {
        syncResults.easyecom = { error: error.message };
      }
    }

    // 3. Fetch from Courier (if AWB exists)
    if (returnData.awb_number) {
      try {
        // Determine courier and fetch tracking
        const courierName = (returnData.courier_name || '').toLowerCase();
        let trackingInfo = null;

        // Try to get tracking info based on courier
        // For now, construct tracking URLs - actual API integration would need courier-specific credentials
        if (courierName.includes('delhivery')) {
          syncResults.courier = {
            name: 'Delhivery',
            awb: returnData.awb_number,
            tracking_url: `https://www.delhivery.com/track/package/${returnData.awb_number}`,
            note: 'Visit tracking URL for live status'
          };
        } else if (courierName.includes('bluedart')) {
          syncResults.courier = {
            name: 'BlueDart',
            awb: returnData.awb_number,
            tracking_url: `https://www.bluedart.com/tracking/${returnData.awb_number}`,
            note: 'Visit tracking URL for live status'
          };
        } else if (courierName.includes('xpressbees') || courierName.includes('xpress')) {
          syncResults.courier = {
            name: 'XpressBees',
            awb: returnData.awb_number,
            tracking_url: `https://www.xpressbees.com/track?awb=${returnData.awb_number}`,
            note: 'Visit tracking URL for live status'
          };
        } else if (courierName.includes('ekart')) {
          syncResults.courier = {
            name: 'Ekart',
            awb: returnData.awb_number,
            tracking_url: `https://ekartlogistics.com/track/${returnData.awb_number}`,
            note: 'Visit tracking URL for live status'
          };
        } else {
          syncResults.courier = {
            name: returnData.courier_name || 'Unknown',
            awb: returnData.awb_number,
            tracking_url: returnData.courier_tracking_url,
            note: 'Courier tracking info available'
          };
        }
      } catch (error) {
        syncResults.courier = { error: error.message };
      }
    }

    // 4. Auto-transition logic based on synced data
    // Smart status transitions based on what we found
    const currentStatus = returnData.status;
    let suggestedTransitions = [];

    // If Shopify shows refund processed and we're not yet refunded
    if (syncResults.shopify?.refundDetected && !['refunded', 'cancelled', 'rejected'].includes(currentStatus)) {
      syncResults.newStatus = 'refunded';
      syncResults.statusUpdated = true;
      syncResults.autoTransitionReason = 'Shopify refund detected';
    }

    // If we have AWB and in approved status, suggest moving to pickup_scheduled
    if (returnData.awb_number && currentStatus === 'approved') {
      suggestedTransitions.push({
        status: 'pickup_scheduled',
        reason: 'AWB already assigned'
      });
    }

    // If status is pickup_scheduled for more than 3 days, suggest moving to picked_up
    if (currentStatus === 'pickup_scheduled' && returnData.approved_at) {
      const daysSinceApproval = Math.floor((Date.now() - new Date(returnData.approved_at)) / 86400000);
      if (daysSinceApproval >= 3) {
        suggestedTransitions.push({
          status: 'picked_up',
          reason: `${daysSinceApproval} days since pickup scheduled`
        });
      }
    }

    // If status is picked_up for more than 5 days, suggest moving to received
    if (currentStatus === 'picked_up' && returnData.picked_at) {
      const daysSincePicked = Math.floor((Date.now() - new Date(returnData.picked_at)) / 86400000);
      if (daysSincePicked >= 5) {
        suggestedTransitions.push({
          status: 'received',
          reason: `${daysSincePicked} days since pickup`
        });
      }
    }

    syncResults.suggestedTransitions = suggestedTransitions;

    // 5. Update status if changed
    if (syncResults.statusUpdated && syncResults.newStatus !== returnData.status) {
      await pool.query('UPDATE returns SET status = ? WHERE id = ?', [syncResults.newStatus, id]);

      await pool.query(`
        INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
        VALUES (?, 'status_auto_synced', ?, ?, 'system', ?, ?, ?)
      `, [id, returnData.status, syncResults.newStatus, user.id, user.username, JSON.stringify({
        source: 'sync-status',
        reason: syncResults.autoTransitionReason,
        results: syncResults
      })]);
    }

    // Log sync attempt
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, actor_type, actor_id, actor_name, details)
      VALUES (?, 'status_sync_attempted', 'operator', ?, ?, ?)
    `, [id, user.id, user.username, JSON.stringify(syncResults)]);

    let message = syncResults.statusUpdated
      ? `Status updated to ${syncResults.newStatus.replace(/_/g, ' ')}`
      : 'Status synced (no changes)';

    if (syncResults.suggestedTransitions && syncResults.suggestedTransitions.length > 0) {
      message += '\n\nSuggested actions:\n';
      syncResults.suggestedTransitions.forEach(t => {
        message += `- Move to ${t.status.replace(/_/g, ' ')}: ${t.reason}\n`;
      });
    }

    return res.json({
      success: true,
      message,
      data: syncResults,
      suggestedTransitions: syncResults.suggestedTransitions || []
    });

  } catch (error) {
    console.error('Error syncing return status:', error);
    return res.status(500).json({ success: false, message: 'Failed to sync status', error: error.message });
  }
});

/**
 * GET /returns/api/search-orders
 * Search Shopify orders for linking (operator only)
 */
router.get('/api/search-orders', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Search query must be at least 3 characters'
      });
    }

    if (!shopifyClient.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: 'Shopify not configured'
      });
    }

    const searchTerm = q.trim();
    let orders = [];

    // Try different search methods
    if (searchTerm.startsWith('#') || /^\d+$/.test(searchTerm)) {
      // Search by order number
      const order = await shopifyClient.getOrderByName(searchTerm.replace('#', ''));
      if (order) orders = [order];
    } else if (searchTerm.includes('@')) {
      // Search by email
      orders = await shopifyClient.searchOrdersByEmail(searchTerm);
    } else {
      // Search by phone or customer identifier
      orders = await shopifyClient.getOrdersByCustomerIdentifier(searchTerm);
    }

    // Simplify order data
    const simplifiedOrders = orders.slice(0, 20).map(order => ({
      id: order.id,
      name: order.name,
      email: order.email,
      phone: order.phone || order.shipping_address?.phone,
      created_at: order.created_at,
      total_price: order.total_price,
      customer_name: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
      fulfillment_status: order.fulfillment_status,
      financial_status: order.financial_status,
      line_items_count: order.line_items?.length || 0
    }));

    return res.json({
      success: true,
      orders: simplifiedOrders
    });

  } catch (error) {
    console.error('Error searching orders:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to search orders'
    });
  }
});

/**
 * POST /returns/:id/link-order
 * Link a Shopify order to a return (operator only)
 */
router.post('/:id/link-order', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { shopify_order_id } = req.body;
    const user = req.session.user;

    if (!shopify_order_id) {
      return res.status(400).json({
        success: false,
        message: 'Shopify order ID is required'
      });
    }

    // Get current return
    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    // Fetch order from Shopify
    if (!shopifyClient.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: 'Shopify not configured'
      });
    }

    const order = await shopifyClient.getOrder(shopify_order_id);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Shopify order not found'
      });
    }

    // Check if order already has a return
    const [existingReturns] = await pool.query(`
      SELECT return_id FROM returns
      WHERE shopify_order_id = ? AND id != ? AND status NOT IN ('rejected', 'cancelled')
    `, [shopify_order_id, id]);

    if (existingReturns.length > 0) {
      return res.status(400).json({
        success: false,
        message: `This order already has an active return (${existingReturns[0].return_id})`
      });
    }

    // Extract order details
    const orderType = shopifyClient.getOrderPaymentType(order);
    const deliveryDate = shopifyClient.getDeliveryDate(order);
    const customerName = `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim();
    const customerPhone = order.phone || order.customer?.phone || order.shipping_address?.phone;

    // Update return with order info
    await pool.query(`
      UPDATE returns SET
        shopify_order_id = ?,
        shopify_order_name = ?,
        customer_name = COALESCE(customer_name, ?),
        customer_phone = COALESCE(customer_phone, ?),
        customer_email = COALESCE(customer_email, ?),
        order_type = ?,
        order_date = ?,
        delivery_date = ?,
        original_total = ?
      WHERE id = ?
    `, [
      order.id,
      order.name,
      customerName || null,
      customerPhone || null,
      order.email || null,
      orderType,
      order.created_at,
      deliveryDate,
      parseFloat(order.total_price) || 0,
      id
    ]);

    // Delete existing return items and add new ones
    await pool.query('DELETE FROM return_items WHERE return_id = ?', [id]);

    // Insert line items
    if (order.line_items && order.line_items.length > 0) {
      const lineItems = shopifyClient.extractLineItems(order);
      for (const item of lineItems) {
        await pool.query(`
          INSERT INTO return_items (
            return_id, sku, product_name, variant_title, size,
            ordered_quantity, return_quantity, unit_price, tax_amount,
            discount_amount, shopify_line_item_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          id,
          item.sku,
          item.product_name,
          item.variant_title,
          item.variant_title,
          item.quantity,
          item.quantity,
          item.unit_price,
          item.tax_amount,
          item.discount_amount,
          item.line_item_id
        ]);
      }
    }

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, actor_type, actor_id, actor_name, details)
      VALUES (?, 'order_linked', 'operator', ?, ?, ?)
    `, [id, user.id, user.username, JSON.stringify({
      shopify_order_id: order.id,
      shopify_order_name: order.name
    })]);

    return res.json({
      success: true,
      message: `Order ${order.name} linked successfully`,
      order: {
        id: order.id,
        name: order.name,
        customer_name: customerName,
        order_type: orderType,
        total: order.total_price
      }
    });

  } catch (error) {
    console.error('Error linking order:', error);
    return res.status(500).json({ success: false, message: 'Failed to link order' });
  }
});

/**
 * GET /returns/export
 * Export returns data to Excel
 */
router.get('/export', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { status, from, to, source, delivery_from, delivery_to } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      whereClause += ' AND r.status = ?';
      params.push(status);
    }

    if (from) {
      whereClause += ' AND r.requested_at >= ?';
      params.push(from);
    }

    if (to) {
      whereClause += ' AND r.requested_at <= ?';
      params.push(to + ' 23:59:59');
    }

    // New filter: source (customer_form, shopify_page, shopify, operator)
    if (source && source !== 'all') {
      whereClause += ' AND r.source = ?';
      params.push(source);
    }

    // New filter: delivery date range
    if (delivery_from) {
      whereClause += ' AND r.delivery_date >= ?';
      params.push(delivery_from);
    }

    if (delivery_to) {
      whereClause += ' AND r.delivery_date <= ?';
      params.push(delivery_to + ' 23:59:59');
    }

    const [returns] = await pool.query(`
      SELECT r.*, bd.upi_id, bd.account_holder_name, bd.bank_name
      FROM returns r
      LEFT JOIN return_bank_details bd ON bd.return_id = r.id
      ${whereClause}
      ORDER BY r.requested_at DESC
    `, params);

    // Create Excel workbook
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Returns');

    // Enhanced columns with new fields
    sheet.columns = [
      { header: 'Return ID', key: 'return_id', width: 20 },
      { header: 'Shopify Return ID', key: 'shopify_return_id', width: 18 },
      { header: 'Order', key: 'shopify_order_name', width: 12 },
      { header: 'Customer', key: 'customer_name', width: 25 },
      { header: 'Phone', key: 'customer_phone', width: 15 },
      { header: 'Email', key: 'customer_email', width: 25 },
      { header: 'Order Type', key: 'order_type', width: 10 },
      { header: 'Return Type', key: 'return_type', width: 15 },
      { header: 'Status', key: 'status', width: 15 },
      { header: 'Source', key: 'source', width: 15 },
      { header: 'Return Reason', key: 'return_reason', width: 20 },
      { header: 'Refund Amount', key: 'refund_amount', width: 15 },
      { header: 'AWB', key: 'awb_number', width: 20 },
      { header: 'Courier', key: 'courier_name', width: 15 },
      { header: 'Tracking URL', key: 'courier_tracking_url', width: 30 },
      { header: 'UPI ID', key: 'upi_id', width: 25 },
      { header: 'Bank', key: 'bank_name', width: 20 },
      { header: 'Account Holder', key: 'account_holder_name', width: 25 },
      { header: 'Order Date', key: 'order_date', width: 18 },
      { header: 'Delivery Date', key: 'delivery_date', width: 18 },
      { header: 'Requested', key: 'requested_at', width: 18 },
      { header: 'Approved', key: 'approved_at', width: 18 },
      { header: 'Picked', key: 'picked_at', width: 18 },
      { header: 'Received', key: 'received_at', width: 18 },
      { header: 'Refunded', key: 'refunded_at', width: 18 }
    ];

    // Format dates and add rows
    returns.forEach(r => {
      const row = { ...r };
      // Format dates for Excel
      ['order_date', 'delivery_date', 'requested_at', 'approved_at', 'picked_at', 'received_at', 'refunded_at'].forEach(field => {
        if (row[field]) {
          row[field] = new Date(row[field]).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
        }
      });
      sheet.addRow(row);
    });

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' }
    };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=returns-export-${new Date().toISOString().slice(0, 10)}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Error exporting returns:', error);
    return res.status(500).send('Failed to export');
  }
});

// ===============================
// SHOPIFY SYNC
// ===============================

/**
 * GET /returns/sync-from-shopify
 * Fetch returns created in Shopify and import to ERP
 * Query params: days (default 7), status (open, closed)
 */
router.get('/sync-from-shopify', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { days = 7, status } = req.query;
    const user = req.session.user;

    if (!shopifyClient.isConfigured()) {
      return res.status(500).json({
        success: false,
        message: 'Shopify not configured'
      });
    }

    // Calculate min created date
    const minDate = new Date();
    minDate.setDate(minDate.getDate() - parseInt(days));

    // Fetch returns from Shopify
    const shopifyReturns = await shopifyClient.getAllReturns({
      created_at_min: minDate.toISOString(),
      status: status || undefined
    });

    if (!shopifyReturns || shopifyReturns.length === 0) {
      return res.json({
        success: true,
        message: 'No returns found in Shopify for the given period',
        imported: 0,
        skipped: 0,
        returns: []
      });
    }

    let imported = 0;
    let skipped = 0;
    const results = [];

    for (const shopifyReturn of shopifyReturns) {
      try {
        // Check if already exists
        const [existing] = await pool.query(
          'SELECT id, return_id FROM returns WHERE shopify_return_id = ?',
          [shopifyReturn.id]
        );

        if (existing.length > 0) {
          skipped++;
          results.push({
            shopify_return_id: shopifyReturn.id,
            status: 'skipped',
            reason: 'Already exists',
            local_return_id: existing[0].return_id
          });
          continue;
        }

        // Get order details
        const orderId = shopifyReturn.order_id;
        const order = await shopifyClient.getOrder(orderId);

        if (!order) {
          skipped++;
          results.push({
            shopify_return_id: shopifyReturn.id,
            status: 'skipped',
            reason: 'Order not found'
          });
          continue;
        }

        // Check if order already has a return
        const [existingOrderReturn] = await pool.query(
          'SELECT return_id FROM returns WHERE shopify_order_id = ? AND status NOT IN (?, ?)',
          [orderId, 'rejected', 'cancelled']
        );

        if (existingOrderReturn.length > 0) {
          // Update existing return with Shopify return ID
          await pool.query(
            'UPDATE returns SET shopify_return_id = ? WHERE shopify_order_id = ?',
            [shopifyReturn.id, orderId]
          );
          skipped++;
          results.push({
            shopify_return_id: shopifyReturn.id,
            status: 'linked',
            reason: 'Linked to existing return',
            local_return_id: existingOrderReturn[0].return_id
          });
          continue;
        }

        // Create new return from Shopify data
        const returnId = returnHelpers.generateReturnId();
        const orderType = shopifyClient.getOrderPaymentType(order);
        const deliveryDate = shopifyClient.getDeliveryDate(order);

        // Extract customer info
        const customerName = order.shipping_address?.name
          || order.billing_address?.name
          || `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim()
          || null;
        const customerPhone = order.phone
          || order.shipping_address?.phone
          || order.billing_address?.phone
          || order.customer?.phone
          || null;
        const customerEmail = order.email || order.customer?.email || null;

        // Map Shopify return status to internal status
        let internalStatus = 'pending_review';
        const shopifyStatus = (shopifyReturn.status || '').toLowerCase();
        if (shopifyStatus === 'open' || shopifyStatus === 'requested') {
          internalStatus = 'approved';
        } else if (shopifyStatus === 'closed' || shopifyStatus === 'complete') {
          internalStatus = 'received';
        } else if (shopifyStatus === 'cancelled' || shopifyStatus === 'declined') {
          internalStatus = 'cancelled';
        }

        // Insert return
        await pool.query(`
          INSERT INTO returns (
            return_id, shopify_order_id, shopify_order_name, shopify_return_id,
            customer_phone, customer_email, customer_name,
            order_type, order_date, delivery_date, original_total,
            return_type, return_reason, status, source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shopify')
        `, [
          returnId,
          order.id,
          order.name,
          shopifyReturn.id,
          customerPhone,
          customerEmail,
          customerName,
          orderType,
          order.created_at,
          deliveryDate,
          parseFloat(order.total_price) || 0,
          'customer_return',
          'Imported from Shopify',
          internalStatus
        ]);

        // Get the inserted return ID
        const [[{ id: dbReturnId }]] = await pool.query(
          'SELECT id FROM returns WHERE return_id = ?',
          [returnId]
        );

        // Insert return items if available
        if (shopifyReturn.return_line_items) {
          for (const item of shopifyReturn.return_line_items) {
            await pool.query(`
              INSERT INTO return_items (
                return_id, product_name, return_quantity, shopify_line_item_id, item_status
              ) VALUES (?, ?, ?, ?, 'pending')
            `, [dbReturnId, item.line_item?.title || 'Unknown', item.quantity || 1, item.fulfillment_line_item_id]);
          }
        }

        // Log audit
        await pool.query(`
          INSERT INTO return_audit_log (return_id, action, new_status, actor_type, actor_id, actor_name, details)
          VALUES (?, 'imported_from_shopify', ?, 'operator', ?, ?, ?)
        `, [dbReturnId, internalStatus, user.id, user.username, JSON.stringify({ shopify_return_id: shopifyReturn.id })]);

        imported++;
        results.push({
          shopify_return_id: shopifyReturn.id,
          status: 'imported',
          local_return_id: returnId
        });

      } catch (itemError) {
        console.error('Error processing Shopify return:', itemError.message);
        results.push({
          shopify_return_id: shopifyReturn.id,
          status: 'error',
          reason: itemError.message
        });
      }
    }

    return res.json({
      success: true,
      message: `Imported ${imported} returns, skipped ${skipped}`,
      imported,
      skipped,
      total: shopifyReturns.length,
      returns: results
    });

  } catch (error) {
    console.error('Error syncing from Shopify:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync from Shopify',
      error: error.message
    });
  }
});

// ===============================
// SIMPLIFIED WORKFLOW ENDPOINTS
// ===============================

/**
 * POST /returns/:id/quick-approve
 * One-click approve with AWB - combines approve + schedule pickup in one step
 * This is the simplified workflow that works without EasyEcom
 */
router.post('/:id/quick-approve', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { awb_number, courier_name } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    if (returnData.status !== 'pending_review') {
      return res.status(400).json({ success: false, message: 'Return is not pending review' });
    }

    // Determine final status based on whether AWB is provided
    const finalStatus = awb_number ? 'pickup_scheduled' : 'approved';

    // Update return with approval + AWB in one go
    const updateFields = {
      status: finalStatus,
      approved_at: 'NOW()',
      assigned_operator_id: user.id
    };

    if (awb_number) {
      updateFields.awb_number = awb_number;
      updateFields.courier_name = courier_name || null;
      // Build tracking URL based on courier
      const courierLower = (courier_name || '').toLowerCase();
      if (courierLower.includes('delhivery')) {
        updateFields.courier_tracking_url = `https://www.delhivery.com/track/package/${awb_number}`;
      } else if (courierLower.includes('bluedart')) {
        updateFields.courier_tracking_url = `https://www.bluedart.com/tracking/${awb_number}`;
      } else if (courierLower.includes('xpressbees') || courierLower.includes('xpress')) {
        updateFields.courier_tracking_url = `https://www.xpressbees.com/track?awb=${awb_number}`;
      } else if (courierLower.includes('ekart')) {
        updateFields.courier_tracking_url = `https://ekartlogistics.com/track/${awb_number}`;
      }
    }

    await pool.query(
      `UPDATE returns SET
        status = ?,
        approved_at = NOW(),
        assigned_operator_id = ?,
        awb_number = COALESCE(?, awb_number),
        courier_name = COALESCE(?, courier_name),
        courier_tracking_url = COALESCE(?, courier_tracking_url)
      WHERE id = ?`,
      [finalStatus, user.id, awb_number || null, courier_name || null, updateFields.courier_tracking_url || null, id]
    );

    // Log audit with detailed info
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'quick_approved', ?, ?, 'operator', ?, ?, ?)
    `, [id, returnData.status, finalStatus, user.id, user.username, JSON.stringify({
      awb_number,
      courier_name,
      workflow: 'quick_approve'
    })]);

    // Sync to Shopify - add tags
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Approved');
        if (awb_number) {
          await shopifyClient.addOrderTag(returnData.shopify_order_id, 'Return-Pickup-Scheduled');
          await shopifyClient.addOrderNote(returnData.shopify_order_id,
            `Return ${returnData.return_id} approved and pickup scheduled. AWB: ${awb_number}${courier_name ? ` (${courier_name})` : ''}`
          );
        } else {
          await shopifyClient.addOrderNote(returnData.shopify_order_id, `Return ${returnData.return_id} approved`);
        }
      } catch (shopifyError) {
        // Log error to audit but don't fail
        await pool.query(`
          INSERT INTO return_audit_log (return_id, action, actor_type, actor_name, details)
          VALUES (?, 'shopify_sync_failed', 'system', 'system', ?)
        `, [id, JSON.stringify({ error: shopifyError.message, action: 'quick_approve' })]);
      }
    }

    return res.json({
      success: true,
      message: awb_number
        ? `Return approved and pickup scheduled with AWB: ${awb_number}`
        : 'Return approved. You can add AWB later.',
      status: finalStatus
    });

  } catch (error) {
    console.error('Error in quick-approve:', error);
    return res.status(500).json({ success: false, message: 'Failed to approve return' });
  }
});

/**
 * POST /returns/:id/quick-transition
 * Direct status transition without external API calls
 * For fast manual processing when EasyEcom is not configured
 */
router.post('/:id/quick-transition', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { id } = req.params;
    const { target_status, awb_number, courier_name, notes } = req.body;
    const user = req.session.user;

    const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [id]);

    if (!returnData) {
      return res.status(404).json({ success: false, message: 'Return not found' });
    }

    // Define allowed transitions for quick workflow
    const allowedTransitions = {
      'pending_review': ['approved', 'pickup_scheduled', 'rejected'],
      'approved': ['pickup_scheduled', 'picked_up', 'rejected'],
      'pickup_scheduled': ['picked_up', 'received', 'cancelled'],
      'picked_up': ['in_transit', 'received'],
      'in_transit': ['received'],
      'received': ['refund_pending'],
      'refund_pending': ['refund_processing', 'refunded']
    };

    const allowed = allowedTransitions[returnData.status] || [];
    if (!allowed.includes(target_status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot transition from ${returnData.status} to ${target_status}. Allowed: ${allowed.join(', ')}`
      });
    }

    // Build update query based on target status
    const updates = ['status = ?'];
    const params = [target_status];

    if (awb_number) {
      updates.push('awb_number = ?');
      params.push(awb_number);
    }
    if (courier_name) {
      updates.push('courier_name = ?');
      params.push(courier_name);
    }

    // Add timestamp fields based on status
    if (target_status === 'approved') {
      updates.push('approved_at = NOW()');
      updates.push('assigned_operator_id = ?');
      params.push(user.id);
    } else if (target_status === 'picked_up') {
      updates.push('picked_at = NOW()');
    } else if (target_status === 'received') {
      updates.push('received_at = NOW()');
      // Calculate refund amount
      const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [id]);
      if (items.length > 0) {
        const refundAmount = returnHelpers.calculateRefundAmount(items);
        updates.push('refund_amount = ?');
        params.push(refundAmount);
      }
    } else if (target_status === 'refund_pending') {
      updates.push('status = ?');
      params[0] = 'refund_pending';
    }

    params.push(id);
    await pool.query(`UPDATE returns SET ${updates.join(', ')} WHERE id = ?`, params);

    // Log audit
    await pool.query(`
      INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
      VALUES (?, 'quick_transition', ?, ?, 'operator', ?, ?, ?)
    `, [id, returnData.status, target_status, user.id, user.username, JSON.stringify({ notes, awb_number, courier_name })]);

    // Sync tags to Shopify
    if (returnData.shopify_order_id && shopifyClient.isConfigured()) {
      try {
        const statusTagMap = {
          'approved': 'Return-Approved',
          'pickup_scheduled': 'Return-Pickup-Scheduled',
          'picked_up': 'Return-Picked-Up',
          'received': 'Return-Received',
          'refunded': 'Return-Refunded'
        };
        if (statusTagMap[target_status]) {
          await shopifyClient.addOrderTag(returnData.shopify_order_id, statusTagMap[target_status]);
        }
      } catch (shopifyError) {
        // Log but don't fail
        await pool.query(`
          INSERT INTO return_audit_log (return_id, action, actor_type, actor_name, details)
          VALUES (?, 'shopify_sync_failed', 'system', 'system', ?)
        `, [id, JSON.stringify({ error: shopifyError.message })]);
      }
    }

    return res.json({
      success: true,
      message: `Status changed to ${target_status.replace(/_/g, ' ')}`,
      newStatus: target_status
    });

  } catch (error) {
    console.error('Error in quick-transition:', error);
    return res.status(500).json({ success: false, message: 'Failed to update status' });
  }
});

/**
 * POST /returns/bulk-action
 * Process multiple returns at once
 */
router.post('/bulk-action', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const { return_ids, action, target_status, awb_prefix, courier_name } = req.body;
    const user = req.session.user;

    if (!return_ids || !Array.isArray(return_ids) || return_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'No returns selected' });
    }

    if (return_ids.length > 50) {
      return res.status(400).json({ success: false, message: 'Maximum 50 returns at a time' });
    }

    const results = {
      success: [],
      failed: []
    };

    for (const returnId of return_ids) {
      try {
        const [[returnData]] = await pool.query('SELECT * FROM returns WHERE id = ?', [returnId]);

        if (!returnData) {
          results.failed.push({ id: returnId, error: 'Not found' });
          continue;
        }

        let updateQuery = '';
        let updateParams = [];
        let auditAction = '';

        switch (action) {
          case 'approve':
            if (returnData.status !== 'pending_review') {
              results.failed.push({ id: returnId, return_id: returnData.return_id, error: 'Not pending review' });
              continue;
            }
            updateQuery = 'UPDATE returns SET status = ?, approved_at = NOW(), assigned_operator_id = ? WHERE id = ?';
            updateParams = ['approved', user.id, returnId];
            auditAction = 'bulk_approved';
            break;

          case 'transition':
            if (!target_status) {
              results.failed.push({ id: returnId, return_id: returnData.return_id, error: 'No target status' });
              continue;
            }
            updateQuery = 'UPDATE returns SET status = ? WHERE id = ?';
            updateParams = [target_status, returnId];
            auditAction = 'bulk_transition';
            break;

          case 'mark_picked':
            if (!['approved', 'pickup_scheduled'].includes(returnData.status)) {
              results.failed.push({ id: returnId, return_id: returnData.return_id, error: 'Cannot mark picked from ' + returnData.status });
              continue;
            }
            updateQuery = 'UPDATE returns SET status = ?, picked_at = NOW() WHERE id = ?';
            updateParams = ['picked_up', returnId];
            auditAction = 'bulk_marked_picked';
            break;

          case 'mark_received':
            if (!['picked_up', 'in_transit', 'pickup_scheduled'].includes(returnData.status)) {
              results.failed.push({ id: returnId, return_id: returnData.return_id, error: 'Cannot mark received from ' + returnData.status });
              continue;
            }
            // Calculate refund amount
            const [items] = await pool.query('SELECT * FROM return_items WHERE return_id = ?', [returnId]);
            const refundAmount = items.length > 0 ? returnHelpers.calculateRefundAmount(items) : returnData.refund_amount;
            updateQuery = 'UPDATE returns SET status = ?, received_at = NOW(), refund_amount = ? WHERE id = ?';
            updateParams = ['refund_pending', refundAmount, returnId];
            auditAction = 'bulk_marked_received';
            break;

          default:
            results.failed.push({ id: returnId, return_id: returnData.return_id, error: 'Unknown action' });
            continue;
        }

        await pool.query(updateQuery, updateParams);

        // Log audit
        await pool.query(`
          INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_id, actor_name, details)
          VALUES (?, ?, ?, ?, 'operator', ?, ?, ?)
        `, [returnId, auditAction, returnData.status, updateParams[0], user.id, user.username, JSON.stringify({ bulk: true })]);

        results.success.push({ id: returnId, return_id: returnData.return_id, newStatus: updateParams[0] });

      } catch (itemError) {
        results.failed.push({ id: returnId, error: itemError.message });
      }
    }

    return res.json({
      success: true,
      message: `Processed ${results.success.length} returns, ${results.failed.length} failed`,
      results
    });

  } catch (error) {
    console.error('Error in bulk-action:', error);
    return res.status(500).json({ success: false, message: 'Failed to process bulk action' });
  }
});

/**
 * GET /returns/pending-actions
 * Get count of returns needing action at each stage
 */
router.get('/pending-actions', isAuthenticated, allowReturnsAccess, async (req, res) => {
  try {
    const [counts] = await pool.query(`
      SELECT
        status,
        COUNT(*) as count,
        SUM(CASE WHEN order_type = 'cod' THEN 1 ELSE 0 END) as cod_count,
        SUM(CASE WHEN order_type = 'prepaid' THEN 1 ELSE 0 END) as prepaid_count
      FROM returns
      WHERE status NOT IN ('refunded', 'rejected', 'cancelled')
      GROUP BY status
    `);

    // Get returns needing bank details
    const [[needingBank]] = await pool.query(`
      SELECT COUNT(*) as count
      FROM returns r
      LEFT JOIN return_bank_details bd ON bd.return_id = r.id
      WHERE r.order_type = 'cod'
        AND r.status IN ('refund_pending', 'refund_processing')
        AND (bd.upi_id IS NULL AND bd.account_number IS NULL)
    `);

    // Get returns with AWB but no pickup status update for > 2 days
    const [[stalePickups]] = await pool.query(`
      SELECT COUNT(*) as count
      FROM returns
      WHERE status = 'pickup_scheduled'
        AND awb_number IS NOT NULL
        AND approved_at < DATE_SUB(NOW(), INTERVAL 2 DAY)
    `);

    return res.json({
      success: true,
      statusCounts: counts,
      needingBankDetails: needingBank.count,
      stalePickups: stalePickups.count,
      actions: [
        { label: 'Pending Review', status: 'pending_review', count: counts.find(c => c.status === 'pending_review')?.count || 0 },
        { label: 'Ready for Pickup', status: 'approved', count: counts.find(c => c.status === 'approved')?.count || 0 },
        { label: 'Awaiting Pickup', status: 'pickup_scheduled', count: counts.find(c => c.status === 'pickup_scheduled')?.count || 0 },
        { label: 'Ready for Refund', status: 'refund_pending', count: counts.find(c => c.status === 'refund_pending')?.count || 0 }
      ]
    });

  } catch (error) {
    console.error('Error getting pending actions:', error);
    return res.status(500).json({ success: false, message: 'Failed to get pending actions' });
  }
});

// ===============================
// WEBHOOKS
// ===============================

/**
 * POST /returns/webhook/easyecom
 * EasyEcom return status updates
 */
router.post('/webhook/easyecom', async (req, res) => {
  try {
    const token = req.get('Access-Token');

    if (!easyecomClient.verifyWebhookToken(token)) {
      return res.status(403).send('Invalid token');
    }

    // Log webhook
    await pool.query(`
      INSERT INTO return_webhook_logs (source, event_type, payload, processing_status)
      VALUES ('easyecom', ?, ?, 'received')
    `, [req.body.event_type || 'unknown', JSON.stringify(req.body)]);

    const webhookData = easyecomClient.parseReturnWebhook(req.body);

    if (webhookData.return_id) {
      // Find return by EasyEcom return ID
      const [[returnData]] = await pool.query(
        'SELECT * FROM returns WHERE easyecom_return_id = ?',
        [webhookData.return_id]
      );

      if (returnData) {
        const newStatus = easyecomClient.mapReturnStatus(webhookData.status);

        if (returnHelpers.isValidTransition(returnData.status, newStatus)) {
          await pool.query('UPDATE returns SET status = ? WHERE id = ?', [newStatus, returnData.id]);

          await pool.query(`
            INSERT INTO return_audit_log (return_id, action, old_status, new_status, actor_type, actor_name, details)
            VALUES (?, 'webhook_status_update', ?, ?, 'webhook', 'EasyEcom', ?)
          `, [returnData.id, returnData.status, newStatus, JSON.stringify(webhookData)]);
        }
      }
    }

    return res.json({ success: true });

  } catch (error) {
    console.error('EasyEcom webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
