/**
 * Return Management Helper Functions
 * Business logic for returns, refunds, and status management
 */

const crypto = require('crypto');

// Status transition rules
const RETURN_STATUS_TRANSITIONS = {
  pending_review: {
    allowed: ['approved', 'rejected', 'cancelled'],
    autoActions: []
  },
  approved: {
    allowed: ['pickup_scheduled', 'cancelled'],
    autoActions: ['create_easyecom_return', 'fetch_awb']
  },
  pickup_scheduled: {
    allowed: ['picked_up', 'cancelled'],
    autoActions: []
  },
  picked_up: {
    allowed: ['in_transit'],
    autoActions: ['send_bank_details_link_for_cod']
  },
  in_transit: {
    allowed: ['received'],
    autoActions: []
  },
  received: {
    allowed: ['qc_passed', 'qc_failed', 'refund_pending'],
    autoActions: []
  },
  qc_passed: {
    allowed: ['refund_pending'],
    autoActions: ['calculate_refund_amount']
  },
  qc_failed: {
    allowed: ['rejected'],
    autoActions: []
  },
  refund_pending: {
    allowed: ['refund_processing'],
    autoActions: []
  },
  refund_processing: {
    allowed: ['refunded', 'refund_pending'],
    autoActions: []
  },
  refunded: {
    allowed: [],
    autoActions: ['sync_shopify_refund_status']
  },
  rejected: {
    allowed: [],
    autoActions: []
  },
  cancelled: {
    allowed: [],
    autoActions: []
  }
};

// Status display names and colors
const STATUS_CONFIG = {
  pending_review: { label: 'Pending Review', color: 'warning', icon: 'bi-hourglass-split' },
  approved: { label: 'Approved', color: 'info', icon: 'bi-check-circle' },
  pickup_scheduled: { label: 'Pickup Scheduled', color: 'info', icon: 'bi-calendar-check' },
  picked_up: { label: 'Picked Up', color: 'primary', icon: 'bi-box-seam' },
  in_transit: { label: 'In Transit', color: 'primary', icon: 'bi-truck' },
  received: { label: 'Received', color: 'success', icon: 'bi-inbox' },
  qc_passed: { label: 'QC Passed', color: 'success', icon: 'bi-patch-check' },
  qc_failed: { label: 'QC Failed', color: 'danger', icon: 'bi-x-circle' },
  refund_pending: { label: 'Refund Pending', color: 'warning', icon: 'bi-cash' },
  refund_processing: { label: 'Refund Processing', color: 'info', icon: 'bi-arrow-repeat' },
  refunded: { label: 'Refunded', color: 'success', icon: 'bi-check-all' },
  rejected: { label: 'Rejected', color: 'danger', icon: 'bi-x-lg' },
  cancelled: { label: 'Cancelled', color: 'secondary', icon: 'bi-slash-circle' }
};

// Return type display names
const RETURN_TYPE_CONFIG = {
  rto: { label: 'RTO', description: 'Return to Origin' },
  customer_return: { label: 'Customer Return', description: 'Customer initiated return' },
  cancellation: { label: 'Cancellation', description: 'Order cancelled before delivery' },
  partial_return: { label: 'Partial Return', description: 'Returning some items from order' },
  wrong_quantity: { label: 'Wrong Quantity', description: 'Incorrect quantity received' }
};

// Return reason options
const RETURN_REASONS = [
  { value: 'size_issue', label: 'Size doesn\'t fit' },
  { value: 'quality_issue', label: 'Quality issue / Defect' },
  { value: 'wrong_product', label: 'Received wrong product' },
  { value: 'not_as_described', label: 'Product not as described' },
  { value: 'damaged_in_transit', label: 'Damaged during delivery' },
  { value: 'changed_mind', label: 'Changed my mind' },
  { value: 'late_delivery', label: 'Delivery too late' },
  { value: 'missing_items', label: 'Missing items in order' },
  { value: 'other', label: 'Other' }
];

/**
 * Generate unique return ID
 * Format: RET-YYYYMMDD-XXXX
 */
function generateReturnId() {
  const date = new Date();
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '');
  const random = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `RET-${dateStr}-${random}`;
}

/**
 * Generate secure access token for bank details form
 */
function generateBankDetailsToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Check if status transition is valid
 */
function isValidTransition(currentStatus, newStatus) {
  const transitions = RETURN_STATUS_TRANSITIONS[currentStatus];
  if (!transitions) return false;
  return transitions.allowed.includes(newStatus);
}

/**
 * Get allowed next statuses for a given status
 */
function getAllowedNextStatuses(currentStatus) {
  const transitions = RETURN_STATUS_TRANSITIONS[currentStatus];
  return transitions ? transitions.allowed : [];
}

/**
 * Determine if return should be auto-approved
 * Auto-approve if:
 * 1. Within return window (default 7 days)
 * 2. Standard return type (not partial_return or wrong_quantity)
 * 3. Auto-approve is enabled in settings
 */
function shouldAutoApprove(returnRequest, settings = {}) {
  const returnWindowDays = parseInt(settings.return_window_days || 7);
  const autoApproveEnabled = settings.auto_approve_enabled !== '0';

  if (!autoApproveEnabled) return false;

  // Check if within return window
  if (returnRequest.delivery_date) {
    const deliveryDate = new Date(returnRequest.delivery_date);
    const requestDate = new Date(returnRequest.requested_at || new Date());
    const daysSinceDelivery = Math.floor((requestDate - deliveryDate) / (1000 * 60 * 60 * 24));

    if (daysSinceDelivery > returnWindowDays) {
      return false;
    }
  }

  // Special cases require manual review
  const manualReviewTypes = ['partial_return', 'wrong_quantity'];
  if (manualReviewTypes.includes(returnRequest.return_type)) {
    return false;
  }

  return true;
}

/**
 * Calculate refund eligibility and method based on order type and return type
 */
function calculateRefundEligibility(returnRequest) {
  const { order_type, return_type, delivery_date } = returnRequest;

  // Prepaid Orders - Always eligible for refund via Shopify
  if (order_type === 'prepaid') {
    if (return_type === 'rto') {
      return {
        eligible: true,
        method: 'shopify_refund',
        reason: 'RTO - Prepaid order',
        requiresBankDetails: false
      };
    }
    if (return_type === 'cancellation') {
      return {
        eligible: true,
        method: 'shopify_refund',
        reason: 'Cancellation - Prepaid order',
        requiresBankDetails: false
      };
    }
    // All other return types for prepaid
    return {
      eligible: true,
      method: 'shopify_refund',
      reason: 'Customer return - Prepaid order',
      requiresBankDetails: false
    };
  }

  // COD Orders
  if (order_type === 'cod') {
    // RTO for COD - No refund needed (payment wasn't collected)
    if (return_type === 'rto') {
      return {
        eligible: false,
        method: null,
        reason: 'RTO - COD order (no payment collected)',
        requiresBankDetails: false
      };
    }

    // Customer return for COD - Check return window
    if (return_type === 'customer_return' || return_type === 'partial_return') {
      const extendedWindowDays = 10;

      if (delivery_date) {
        const deliveryDateObj = new Date(delivery_date);
        const now = new Date();
        const daysSinceDelivery = Math.floor((now - deliveryDateObj) / (1000 * 60 * 60 * 24));

        if (daysSinceDelivery <= extendedWindowDays) {
          return {
            eligible: true,
            method: 'upi',
            reason: 'Customer return within window - COD order',
            requiresBankDetails: true
          };
        }
        return {
          eligible: false,
          method: null,
          reason: `Return window expired (${daysSinceDelivery} days since delivery)`,
          requiresBankDetails: false
        };
      }

      // No delivery date - assume eligible
      return {
        eligible: true,
        method: 'upi',
        reason: 'Customer return - COD order',
        requiresBankDetails: true
      };
    }

    // Wrong quantity - COD - eligible for refund on missing items
    if (return_type === 'wrong_quantity') {
      return {
        eligible: true,
        method: 'upi',
        reason: 'Wrong quantity - COD order (refund for missing items)',
        requiresBankDetails: true
      };
    }

    // Cancellation for COD - No refund (not yet paid)
    if (return_type === 'cancellation') {
      return {
        eligible: false,
        method: null,
        reason: 'Cancellation - COD order (no payment collected)',
        requiresBankDetails: false
      };
    }
  }

  return {
    eligible: false,
    method: null,
    reason: 'Unknown scenario - requires manual review',
    requiresBankDetails: false
  };
}

/**
 * Calculate total refund amount from return items
 */
function calculateRefundAmount(returnItems) {
  let totalRefund = 0;

  for (const item of returnItems) {
    const quantity = item.return_quantity || 1;
    const unitPrice = parseFloat(item.unit_price) || 0;
    const tax = parseFloat(item.tax_amount) || 0;
    const discount = parseFloat(item.discount_amount) || 0;

    const itemRefund = (unitPrice * quantity) + tax - discount;
    totalRefund += itemRefund;
  }

  return Math.round(totalRefund * 100) / 100; // Round to 2 decimal places
}

/**
 * Get days since delivery
 */
function getDaysSinceDelivery(deliveryDate) {
  if (!deliveryDate) return null;
  const delivery = new Date(deliveryDate);
  const now = new Date();
  return Math.floor((now - delivery) / (1000 * 60 * 60 * 24));
}

/**
 * Check if return is within valid window
 */
function isWithinReturnWindow(deliveryDate, windowDays = 7) {
  const daysSince = getDaysSinceDelivery(deliveryDate);
  if (daysSince === null) return true; // No delivery date, assume valid
  return daysSince <= windowDays;
}

/**
 * Format currency for display
 */
function formatCurrency(amount, currency = 'INR') {
  if (amount === null || amount === undefined) return '-';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(amount);
}

/**
 * Format date for display
 */
function formatDate(date, format = 'short') {
  if (!date) return '-';
  const d = new Date(date);

  if (format === 'short') {
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  if (format === 'long') {
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return d.toISOString();
}

/**
 * Parse order identifier (could be order number like #1234 or phone number)
 */
function parseOrderIdentifier(identifier) {
  const cleaned = identifier.trim();

  // Check if it's an order number (starts with # or is numeric)
  if (cleaned.startsWith('#') || /^\d{4,}$/.test(cleaned)) {
    return {
      type: 'order_number',
      value: cleaned.replace('#', '')
    };
  }

  // Check if it's a phone number (10 digits, possibly with country code)
  const phoneClean = cleaned.replace(/[\s\-\+]/g, '');
  if (/^\d{10,13}$/.test(phoneClean)) {
    // Extract last 10 digits for Indian phone numbers
    const phone = phoneClean.slice(-10);
    return {
      type: 'phone',
      value: phone
    };
  }

  // Could be email
  if (cleaned.includes('@')) {
    return {
      type: 'email',
      value: cleaned.toLowerCase()
    };
  }

  return {
    type: 'unknown',
    value: cleaned
  };
}

/**
 * Validate UPI ID format
 */
function isValidUpiId(upiId) {
  if (!upiId) return false;
  // Basic UPI ID format: name@bank
  const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9]+$/;
  return upiRegex.test(upiId);
}

/**
 * Validate IFSC code format
 */
function isValidIfsc(ifsc) {
  if (!ifsc) return false;
  // IFSC format: 4 letters + 0 + 6 alphanumeric
  const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  return ifscRegex.test(ifsc.toUpperCase());
}

/**
 * Mask bank account number for display
 */
function maskAccountNumber(accountNumber) {
  if (!accountNumber || accountNumber.length < 4) return '****';
  return '*'.repeat(accountNumber.length - 4) + accountNumber.slice(-4);
}

/**
 * Build audit log entry
 */
function buildAuditEntry(returnId, action, changes, actor) {
  return {
    return_id: returnId,
    action: action,
    old_status: changes.old_status || null,
    new_status: changes.new_status || null,
    details: JSON.stringify(changes.details || {}),
    actor_type: actor.type || 'system',
    actor_id: actor.id || null,
    actor_name: actor.name || null,
    ip_address: actor.ip || null,
    user_agent: actor.userAgent || null
  };
}

/**
 * Get summary statistics for dashboard
 */
async function getReturnStats(pool) {
  const query = `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) as pending_review,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN status = 'pickup_scheduled' THEN 1 ELSE 0 END) as pickup_scheduled,
      SUM(CASE WHEN status IN ('picked_up', 'in_transit') THEN 1 ELSE 0 END) as in_transit,
      SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received,
      SUM(CASE WHEN status = 'refund_pending' THEN 1 ELSE 0 END) as refund_pending,
      SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
      SUM(CASE WHEN status = 'refunded' AND DATE(refunded_at) = CURDATE() THEN 1 ELSE 0 END) as refunded_today,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN status IN ('refund_pending', 'refund_processing') THEN IFNULL(refund_amount, 0) ELSE 0 END) as pending_refund_amount
    FROM returns
    WHERE status != 'cancelled'
  `;

  const [rows] = await pool.query(query);
  return rows[0];
}

/**
 * Get settings from database
 */
async function getSettings(pool) {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM return_settings');
  const settings = {};
  for (const row of rows) {
    settings[row.setting_key] = row.setting_value;
  }
  return settings;
}

module.exports = {
  // Status management
  RETURN_STATUS_TRANSITIONS,
  STATUS_CONFIG,
  RETURN_TYPE_CONFIG,
  RETURN_REASONS,
  isValidTransition,
  getAllowedNextStatuses,

  // ID generation
  generateReturnId,
  generateBankDetailsToken,

  // Business logic
  shouldAutoApprove,
  calculateRefundEligibility,
  calculateRefundAmount,
  getDaysSinceDelivery,
  isWithinReturnWindow,

  // Parsing and validation
  parseOrderIdentifier,
  isValidUpiId,
  isValidIfsc,
  maskAccountNumber,

  // Formatting
  formatCurrency,
  formatDate,

  // Audit
  buildAuditEntry,

  // Database helpers
  getReturnStats,
  getSettings
};
