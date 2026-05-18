-- Production Manager — EasyEcom V2.1 native endpoints
-- Adds tables for Snapshot CSV ingestion, Reports queue/download (aging + status-wise stock),
-- Product Master sync, and a sales cross-check between getAllOrders and MINI_SALES_REPORT.

CREATE TABLE IF NOT EXISTS ee_product_master (
    sku VARCHAR(100) NOT NULL PRIMARY KEY,
    product_id BIGINT NULL,
    cp_id BIGINT NULL,
    product_name VARCHAR(255) NULL,
    style VARCHAR(100) NULL,
    description TEXT NULL,
    active TINYINT(1) DEFAULT 1,
    custom_fields JSON NULL,
    ee_updated_at DATETIME NULL,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_style (style),
    INDEX idx_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Stock split by status from STATUS_WISE_STOCK_REPORT. Only "Available" feeds DRR math.
CREATE TABLE IF NOT EXISTS ee_stock_status (
    sku VARCHAR(100) NOT NULL,
    warehouse_id INT NOT NULL,
    status VARCHAR(40) NOT NULL,
    qty INT NOT NULL,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sku, warehouse_id, status),
    INDEX idx_captured (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Inventory aging from INVENTORY_AGING_REPORT — authoritative dead-stock signal.
CREATE TABLE IF NOT EXISTS ee_inventory_aging (
    sku VARCHAR(100) NOT NULL,
    warehouse_id INT NOT NULL,
    bucket VARCHAR(40) NOT NULL DEFAULT 'all',
    qty INT NOT NULL,
    avg_age_days DECIMAL(8,2) NULL,
    oldest_age_days INT NULL,
    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sku, warehouse_id, bucket),
    INDEX idx_captured (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pre-aggregated sales from MINI_SALES_REPORT (cross-check vs getAllOrders).
CREATE TABLE IF NOT EXISTS ee_sales_daily (
    sku VARCHAR(100) NOT NULL,
    warehouse_id INT NOT NULL,
    sale_date DATE NOT NULL,
    qty INT NOT NULL,
    revenue DECIMAL(12,2) NULL,
    source ENUM('orders_api','mini_sales_report') NOT NULL,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (sku, warehouse_id, sale_date, source),
    INDEX idx_sale_date (sale_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cross-check audit: per-day delta between the two sales sources.
CREATE TABLE IF NOT EXISTS ee_sales_cross_check (
    check_date DATE NOT NULL,
    warehouse_id INT NOT NULL,
    orders_api_qty INT NOT NULL,
    mini_sales_qty INT NOT NULL,
    delta_pct DECIMAL(6,2) NULL,
    flagged TINYINT(1) DEFAULT 0,
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (check_date, warehouse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Snapshot CSV ingest audit: which daily CSVs we've already downloaded + parsed.
CREATE TABLE IF NOT EXISTS ee_snapshot_files (
    warehouse_id INT NOT NULL,
    entry_date DATETIME NOT NULL,
    file_url VARCHAR(1024) NOT NULL,
    row_count INT NULL,
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (warehouse_id, entry_date),
    INDEX idx_ingested (ingested_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
