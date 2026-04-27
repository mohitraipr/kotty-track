-- Cost Optimization: Database Indexes
-- MySQL compatible version

-- Index for ee_suborders queries (30-50% improvement expected)
CREATE INDEX idx_ee_suborders_sku_warehouse ON ee_suborders(sku, warehouse_id);

-- Index for ee_orders date range queries
CREATE INDEX idx_ee_orders_import_warehouse ON ee_orders(import_date, warehouse_id);

-- Index for feature_usage analytics
CREATE INDEX idx_feature_usage_timestamp ON feature_usage(timestamp);
CREATE INDEX idx_feature_usage_name ON feature_usage(feature_name);

-- Index for inventory snapshots (using correct column name: received_at)
CREATE INDEX idx_ee_inventory_snapshots_received ON ee_inventory_snapshots(received_at);

-- Index for replenishment rules (used in health checks)
CREATE INDEX idx_ee_replenishment_rules_sku_warehouse ON ee_replenishment_rules(sku, warehouse_id);

-- Index for cutting lots (used in operator analytics)
CREATE INDEX idx_cutting_lots_created_at ON cutting_lots(created_at);
