-- Production Manager dashboard + scheduled pull worker tables

CREATE TABLE IF NOT EXISTS ee_inventory_daily_snapshot (
    sku VARCHAR(100) NOT NULL,
    warehouse_id INT NOT NULL,
    snapshot_date DATE NOT NULL,
    qty INT NOT NULL,
    PRIMARY KEY (sku, warehouse_id, snapshot_date),
    INDEX idx_snapshot_date (snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_marketplace_pos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    marketplace VARCHAR(40) NULL,
    po_number VARCHAR(100) NULL,
    uploaded_by INT NULL,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'open',
    INDEX idx_marketplace (marketplace),
    INDEX idx_po_number (po_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_marketplace_po_lines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    po_id INT NOT NULL,
    sku VARCHAR(100) NULL,
    size VARCHAR(40) NULL,
    qty INT NULL,
    required_by_date DATE NULL,
    FOREIGN KEY (po_id) REFERENCES pm_marketplace_pos(id) ON DELETE CASCADE,
    INDEX idx_required_by (required_by_date),
    INDEX idx_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_open_cutting_lots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(100) NULL,
    style VARCHAR(100) NULL,
    size VARCHAR(40) NULL,
    qty INT NULL,
    expected_completion_date DATE NULL,
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL,
    INDEX idx_sku_open (sku, closed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_style_lead_times (
    id INT AUTO_INCREMENT PRIMARY KEY,
    scope ENUM('style','sku') NOT NULL,
    key_value VARCHAR(100) NOT NULL,
    default_lead_time_days INT DEFAULT 12,
    fabric_lead_time_days INT DEFAULT 0,
    safety_days INT DEFAULT 3,
    override_drr DECIMAL(8,3) NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_scope_key (scope, key_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pm_pull_runs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    run_started_at DATETIME NOT NULL,
    step VARCHAR(40) NULL,
    status ENUM('ok','error','partial') NOT NULL,
    message TEXT NULL,
    duration_ms INT NULL,
    INDEX idx_started (run_started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO roles(name) VALUES ('production_manager');
