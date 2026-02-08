-- ====================================================================
-- EASYECOM PERFORMANCE INDEXES MIGRATION
-- ====================================================================
-- Critical indexes for ee_orders, ee_suborders, ee_replenishment_rules
-- and ee_inventory_health tables to fix slow stock-market queries
--
-- Run this via Cloud SQL Studio or Cloud SQL Proxy
-- IMPORTANT: Run during low-traffic hours
-- ====================================================================

-- ====================================================================
-- EE_ORDERS TABLE INDEXES
-- ====================================================================

-- Index on order_date (queries filter by order_date, not import_date)
CREATE INDEX idx_ee_orders_order_date ON ee_orders(order_date);

-- Composite index for common query pattern (order_date + warehouse_id)
CREATE INDEX idx_ee_orders_date_warehouse ON ee_orders(order_date, warehouse_id);

-- ====================================================================
-- EE_SUBORDERS TABLE INDEXES
-- ====================================================================

-- Composite index for SKU + order_id joins (used in aggregation queries)
CREATE INDEX idx_ee_suborders_sku_order ON ee_suborders(sku, order_id);

-- ====================================================================
-- EE_REPLENISHMENT_RULES TABLE INDEXES
-- ====================================================================

-- Index on making_time_days (used in WHERE making_time_days IS NOT NULL)
CREATE INDEX idx_ee_rules_making_time ON ee_replenishment_rules(making_time_days);

-- Composite index for SKU + warehouse + making_time lookups
CREATE INDEX idx_ee_rules_sku_wh_making ON ee_replenishment_rules(sku, warehouse_id, making_time_days);

-- ====================================================================
-- EE_INVENTORY_HEALTH TABLE INDEXES
-- ====================================================================

-- Index on warehouse_id for filtered queries
CREATE INDEX idx_ee_health_warehouse ON ee_inventory_health(warehouse_id);

-- Index on status for alert queries
CREATE INDEX idx_ee_health_status ON ee_inventory_health(status);

-- ====================================================================
-- ANALYZE TABLES AFTER INDEX CREATION
-- ====================================================================

ANALYZE TABLE ee_orders;
ANALYZE TABLE ee_suborders;
ANALYZE TABLE ee_replenishment_rules;
ANALYZE TABLE ee_inventory_health;

-- ====================================================================
-- VERIFICATION QUERIES
-- ====================================================================
-- Run these to verify indexes were created:
-- SHOW INDEX FROM ee_orders WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM ee_suborders WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM ee_replenishment_rules WHERE Key_name LIKE 'idx_%';
-- SHOW INDEX FROM ee_inventory_health WHERE Key_name LIKE 'idx_%';
-- ====================================================================
