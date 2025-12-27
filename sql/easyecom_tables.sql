-- EasyEcom webhook persistence and analytics tables

CREATE TABLE IF NOT EXISTS ee_orders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL,
    invoice_id BIGINT NULL,
    reference_code VARCHAR(255) NULL,
    company_name VARCHAR(255) NULL,
    marketplace VARCHAR(255) NULL,
    marketplace_id BIGINT NULL,
    warehouse_id BIGINT NULL,
    location_key VARCHAR(100) NULL,
    order_status VARCHAR(100) NULL,
    order_status_id INT NULL,
    order_date DATETIME NULL,
    import_date DATETIME NULL,
    tat DATETIME NULL,
    last_update_date DATETIME NULL,
    total_amount DECIMAL(15,4) NULL,
    total_tax DECIMAL(15,4) NULL,
    total_shipping_charge DECIMAL(15,4) NULL,
    total_discount DECIMAL(15,4) NULL,
    collectable_amount DECIMAL(15,4) NULL,
    order_quantity INT NULL,
    raw JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ee_order_id (order_id),
    INDEX idx_ee_orders_import_date (import_date),
    INDEX idx_ee_orders_marketplace (marketplace_id),
    INDEX idx_ee_orders_warehouse (warehouse_id)
);

CREATE TABLE IF NOT EXISTS ee_suborders (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT NOT NULL,
    suborder_id BIGINT NOT NULL,
    sku VARCHAR(100) NOT NULL,
    marketplace_sku VARCHAR(100) NULL,
    product_id BIGINT NULL,
    company_product_id BIGINT NULL,
    quantity INT NULL,
    selling_price DECIMAL(15,4) NULL,
    tax DECIMAL(15,4) NULL,
    tax_rate DECIMAL(10,4) NULL,
    status VARCHAR(100) NULL,
    shipment_type VARCHAR(100) NULL,
    size VARCHAR(50) NULL,
    brand VARCHAR(100) NULL,
    category VARCHAR(100) NULL,
    product_name VARCHAR(255) NULL,
    warehouse_id BIGINT NULL,
    marketplace_id BIGINT NULL,
    order_date DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ee_suborder_id (suborder_id),
    INDEX idx_ee_suborders_order (order_id),
    INDEX idx_ee_suborders_sku (sku),
    INDEX idx_ee_suborders_wh (warehouse_id)
);

CREATE TABLE IF NOT EXISTS ee_inventory_snapshots (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(100) NOT NULL,
    warehouse_id BIGINT NULL,
    company_product_id BIGINT NULL,
    product_id BIGINT NULL,
    inventory INT NULL,
    sku_status VARCHAR(50) NULL,
    location_key VARCHAR(100) NULL,
    raw JSON NULL,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ee_inventory_snapshot (sku, warehouse_id),
    INDEX idx_ee_inventory_received (received_at)
);

CREATE TABLE IF NOT EXISTS ee_replenishment_rules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(100) NOT NULL,
    warehouse_id BIGINT NULL,
    threshold INT NULL,
    making_time_days DECIMAL(10,2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_ee_rule (sku, warehouse_id)
);

CREATE TABLE IF NOT EXISTS ee_inventory_health (
    sku VARCHAR(100) NOT NULL,
    warehouse_id BIGINT NOT NULL,
    inventory INT NOT NULL,
    drr_orders DECIMAL(15,4) NULL,
    drr_per_day DECIMAL(15,4) NULL,
    reorder_point DECIMAL(15,4) NULL,
    days_until_production DECIMAL(15,4) NULL,
    threshold_breached TINYINT(1) NOT NULL DEFAULT 0,
    drr_breached TINYINT(1) NOT NULL DEFAULT 0,
    status ENUM('red','orange','green') NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (sku, warehouse_id)
);

-- Link EasyEcom users to the warehouses they are allowed to view/operate
CREATE TABLE IF NOT EXISTS ee_user_warehouses (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    warehouse_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_user_warehouse (user_id, warehouse_id),
    INDEX idx_user_warehouse_user (user_id),
    CONSTRAINT fk_ee_user_warehouses_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
