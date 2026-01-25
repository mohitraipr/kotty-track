-- Returns Management System Tables
-- Created for Kotty Track ERP
-- Run this migration to set up the returns/refund tracking system

-- Main returns tracking table
CREATE TABLE IF NOT EXISTS returns (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

    -- Identifiers
    return_id VARCHAR(50) NOT NULL UNIQUE COMMENT 'Generated: RET-YYYYMMDD-XXXX',
    shopify_order_id VARCHAR(100) NULL,
    shopify_order_name VARCHAR(50) NULL COMMENT 'e.g., #1234',
    easyecom_order_id BIGINT NULL,
    customer_phone VARCHAR(20) NULL,
    customer_email VARCHAR(255) NULL,
    customer_name VARCHAR(255) NULL,

    -- Order Context
    order_type ENUM('prepaid', 'cod') NOT NULL,
    order_date DATE NULL,
    delivery_date DATE NULL,
    original_total DECIMAL(15,2) NULL,

    -- Return Details
    return_type ENUM('rto', 'customer_return', 'cancellation', 'partial_return', 'wrong_quantity') NOT NULL,
    return_reason TEXT NULL,
    customer_notes TEXT NULL,

    -- Status Tracking (State Machine)
    status ENUM(
        'pending_review',
        'approved',
        'pickup_scheduled',
        'picked_up',
        'in_transit',
        'received',
        'qc_passed',
        'qc_failed',
        'refund_pending',
        'refund_processing',
        'refunded',
        'rejected',
        'cancelled'
    ) NOT NULL DEFAULT 'pending_review',

    -- EasyEcom Integration
    easyecom_return_id BIGINT NULL,
    awb_number VARCHAR(100) NULL,
    courier_name VARCHAR(100) NULL,
    courier_tracking_url TEXT NULL,

    -- Shopify Integration
    shopify_return_id VARCHAR(100) NULL,
    shopify_refund_id VARCHAR(100) NULL,

    -- Refund Details
    refund_amount DECIMAL(15,2) NULL,
    refund_method ENUM('shopify_refund', 'upi', 'bank_transfer', 'store_credit') NULL,

    -- Assignment
    assigned_operator_id BIGINT UNSIGNED NULL,

    -- Timestamps
    requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at TIMESTAMP NULL,
    picked_at TIMESTAMP NULL,
    received_at TIMESTAMP NULL,
    refunded_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    -- Indexes
    INDEX idx_returns_status (status),
    INDEX idx_returns_shopify_order (shopify_order_id),
    INDEX idx_returns_phone (customer_phone),
    INDEX idx_returns_easyecom (easyecom_order_id),
    INDEX idx_returns_requested (requested_at),
    INDEX idx_returns_operator (assigned_operator_id),
    INDEX idx_returns_return_id (return_id)
);

-- Return line items - for partial returns or multi-item orders
CREATE TABLE IF NOT EXISTS return_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    return_id BIGINT UNSIGNED NOT NULL,

    -- Product Details
    sku VARCHAR(100) NOT NULL,
    product_name VARCHAR(255) NULL,
    variant_title VARCHAR(255) NULL,
    size VARCHAR(50) NULL,
    color VARCHAR(100) NULL,

    -- Quantities
    ordered_quantity INT NOT NULL DEFAULT 1,
    return_quantity INT NOT NULL DEFAULT 1,
    received_quantity INT NULL COMMENT 'Actual received after pickup',

    -- Pricing
    unit_price DECIMAL(15,2) NULL,
    tax_amount DECIMAL(15,2) NULL,
    discount_amount DECIMAL(15,2) NULL,
    refund_amount DECIMAL(15,2) NULL,

    -- Item-specific status
    item_status ENUM('pending', 'approved', 'received', 'qc_passed', 'qc_failed', 'refunded') DEFAULT 'pending',
    qc_notes TEXT NULL,

    -- Shopify/EasyEcom references
    shopify_line_item_id VARCHAR(100) NULL,
    easyecom_suborder_id BIGINT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_return_items_return (return_id),
    INDEX idx_return_items_sku (sku),

    CONSTRAINT fk_return_items_return FOREIGN KEY (return_id)
        REFERENCES returns(id) ON DELETE CASCADE
);

-- Customer bank details for COD refunds
CREATE TABLE IF NOT EXISTS return_bank_details (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    return_id BIGINT UNSIGNED NOT NULL UNIQUE,

    -- Secure Token for form access
    access_token VARCHAR(100) NOT NULL UNIQUE,
    token_expires_at TIMESTAMP NOT NULL,

    -- UPI Option
    upi_id VARCHAR(100) NULL,

    -- Bank Account Option
    account_holder_name VARCHAR(255) NULL,
    bank_name VARCHAR(255) NULL,
    account_number VARCHAR(50) NULL,
    ifsc_code VARCHAR(20) NULL,

    -- Verification
    is_verified TINYINT(1) DEFAULT 0,
    verified_by BIGINT UNSIGNED NULL,
    verified_at TIMESTAMP NULL,

    -- Submission tracking
    submitted_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_bank_details_token (access_token),

    CONSTRAINT fk_bank_details_return FOREIGN KEY (return_id)
        REFERENCES returns(id) ON DELETE CASCADE
);

-- Refund transactions tracking
CREATE TABLE IF NOT EXISTS return_refunds (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    return_id BIGINT UNSIGNED NOT NULL,

    -- Transaction Details
    refund_method ENUM('shopify_refund', 'upi', 'bank_transfer', 'store_credit') NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',

    -- External References
    shopify_refund_id VARCHAR(100) NULL,
    transaction_reference VARCHAR(255) NULL COMMENT 'UPI ref number, bank transfer ref, etc.',

    -- Status
    status ENUM('initiated', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'initiated',
    failure_reason TEXT NULL,

    -- Operator Action
    processed_by BIGINT UNSIGNED NULL,
    processed_at TIMESTAMP NULL,
    notes TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_refunds_return (return_id),
    INDEX idx_refunds_status (status),

    CONSTRAINT fk_refunds_return FOREIGN KEY (return_id)
        REFERENCES returns(id) ON DELETE CASCADE
);

-- Audit trail for all return status changes
CREATE TABLE IF NOT EXISTS return_audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    return_id BIGINT UNSIGNED NOT NULL,

    -- Change Details
    action VARCHAR(100) NOT NULL,
    old_status VARCHAR(50) NULL,
    new_status VARCHAR(50) NULL,
    details JSON NULL,

    -- Actor
    actor_type ENUM('customer', 'operator', 'system', 'webhook') NOT NULL,
    actor_id BIGINT UNSIGNED NULL,
    actor_name VARCHAR(255) NULL,

    -- Context
    ip_address VARCHAR(45) NULL,
    user_agent TEXT NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_audit_return (return_id),
    INDEX idx_audit_created (created_at),

    CONSTRAINT fk_audit_return FOREIGN KEY (return_id)
        REFERENCES returns(id) ON DELETE CASCADE
);

-- Webhook logs for debugging
CREATE TABLE IF NOT EXISTS return_webhook_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source ENUM('shopify', 'easyecom') NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSON NOT NULL,
    processing_status ENUM('received', 'processed', 'failed') DEFAULT 'received',
    error_message TEXT NULL,
    return_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_webhook_source (source),
    INDEX idx_webhook_created (created_at),
    INDEX idx_webhook_status (processing_status)
);

-- Return settings table for configurable values
CREATE TABLE IF NOT EXISTS return_settings (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) NOT NULL UNIQUE,
    setting_value TEXT NOT NULL,
    description VARCHAR(255) NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Insert default settings
INSERT INTO return_settings (setting_key, setting_value, description) VALUES
    ('return_window_days', '7', 'Number of days after delivery within which return is auto-approved'),
    ('extended_window_days', '10', 'Extended window for special cases'),
    ('bank_link_expiry_hours', '72', 'Hours before bank details link expires'),
    ('auto_approve_enabled', '1', 'Whether to auto-approve standard returns')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
