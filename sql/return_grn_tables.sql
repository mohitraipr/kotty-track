-- Return GRN (Goods Received Note) tables
-- For tracking returns received by warehouse employees

-- Main scans table
CREATE TABLE IF NOT EXISTS return_grn_scans (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    awb VARCHAR(50) NOT NULL,
    employee_id BIGINT UNSIGNED NOT NULL,
    employee_name VARCHAR(100) NULL,
    status ENUM('good', 'bad') NOT NULL DEFAULT 'good',
    image_url VARCHAR(500) NULL,
    scanned_at DATETIME NOT NULL,
    warehouse VARCHAR(50) NULL,

    -- Filled after reconciliation with EasyEcom
    is_matched TINYINT(1) DEFAULT 0,
    matched_at DATETIME NULL,
    ee_order_id VARCHAR(100) NULL,
    ee_reference_code VARCHAR(100) NULL,
    ee_sku VARCHAR(100) NULL,
    ee_customer_name VARCHAR(255) NULL,
    ee_customer_phone VARCHAR(20) NULL,
    ee_return_reason VARCHAR(255) NULL,
    ee_amount DECIMAL(15,2) NULL,
    ee_marketplace VARCHAR(100) NULL,
    ee_return_type VARCHAR(50) NULL,
    ee_return_date DATE NULL,
    ee_warehouse_id BIGINT NULL,
    ee_raw JSON NULL,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_awb (awb),
    INDEX idx_employee (employee_id),
    INDEX idx_scanned_at (scanned_at),
    INDEX idx_status (status),
    INDEX idx_matched (is_matched),
    INDEX idx_warehouse (warehouse)
);

-- Add return_grn role to users if not exists
-- Run this separately: UPDATE users SET role = 'return_grn' WHERE username = 'grn_employee';
