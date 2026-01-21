-- ========================================================================
-- SQL Script: Cleanup ee_inventory_snapshots table
-- Purpose: Reduce server costs by removing old snapshot data
-- ========================================================================

-- PART 1: DIAGNOSTIC QUERIES
-- Run these first to understand the current state

-- 1.1 Check current table size
SELECT
    COUNT(*) as total_rows,
    ROUND(DATA_LENGTH/1024/1024, 2) as data_mb,
    ROUND(INDEX_LENGTH/1024/1024, 2) as index_mb,
    ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024, 2) as total_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ee_inventory_snapshots';

-- 1.2 Check data distribution by date
SELECT
    DATE(received_at) as snapshot_date,
    COUNT(*) as rows_count
FROM ee_inventory_snapshots
GROUP BY DATE(received_at)
ORDER BY snapshot_date DESC
LIMIT 30;

-- 1.3 Check how many rows are older than 7 days
SELECT
    COUNT(*) as rows_older_than_7_days
FROM ee_inventory_snapshots
WHERE received_at < DATE_SUB(NOW(), INTERVAL 7 DAY);

-- ========================================================================
-- PART 2: CREATE INDEX FOR EFFICIENT CLEANUP
-- This index speeds up the DELETE operations significantly

-- Check if index exists first
SELECT COUNT(*) as index_exists
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ee_inventory_snapshots'
  AND INDEX_NAME = 'idx_ee_snapshots_cleanup';

-- Create the index (only if it doesn't exist)
CREATE INDEX idx_ee_snapshots_cleanup
    ON ee_inventory_snapshots(received_at);

-- ========================================================================
-- PART 3: ONE-TIME CLEANUP (Manual - Run in batches)
-- IMPORTANT: Run during low-traffic hours to minimize impact

-- Delete old data in batches of 50,000 rows
-- Repeat this until affected rows = 0
DELETE FROM ee_inventory_snapshots
WHERE received_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
LIMIT 50000;

-- After all batches complete, reclaim space (optional but recommended)
-- This may take several minutes and will lock the table
-- OPTIMIZE TABLE ee_inventory_snapshots;

-- ========================================================================
-- PART 4: CREATE AUTOMATED CLEANUP EVENT
-- This runs daily to prevent unbounded growth

-- First, enable the event scheduler if not already enabled
-- Check current status:
SHOW VARIABLES LIKE 'event_scheduler';

-- If it shows OFF, enable it (requires SUPER privilege or modify my.cnf):
-- SET GLOBAL event_scheduler = ON;

-- Drop existing event if it exists
DROP EVENT IF EXISTS cleanup_old_inventory_snapshots;

-- Create the cleanup event - runs daily at 3 AM
DELIMITER //
CREATE EVENT cleanup_old_inventory_snapshots
ON SCHEDULE
    EVERY 1 DAY
    STARTS (TIMESTAMP(CURRENT_DATE) + INTERVAL 1 DAY + INTERVAL 3 HOUR)
DO
BEGIN
    DECLARE deleted_rows INT DEFAULT 1;
    DECLARE total_deleted INT DEFAULT 0;

    -- Delete in batches to avoid long locks
    WHILE deleted_rows > 0 DO
        DELETE FROM ee_inventory_snapshots
        WHERE received_at < DATE_SUB(NOW(), INTERVAL 7 DAY)
        LIMIT 10000;

        SET deleted_rows = ROW_COUNT();
        SET total_deleted = total_deleted + deleted_rows;
    END WHILE;

    -- Log the cleanup (optional - requires a log table)
    -- INSERT INTO cleanup_logs (table_name, rows_deleted, cleaned_at)
    -- VALUES ('ee_inventory_snapshots', total_deleted, NOW());
END//
DELIMITER ;

-- Verify event was created
SHOW EVENTS LIKE 'cleanup_old_inventory_snapshots';

-- ========================================================================
-- PART 5: VERIFICATION QUERIES
-- Run these after cleanup to verify success

-- Check new table size
SELECT
    COUNT(*) as total_rows,
    ROUND(DATA_LENGTH/1024/1024, 2) as data_mb
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'ee_inventory_snapshots';

-- Verify only recent data remains
SELECT
    MIN(received_at) as oldest_record,
    MAX(received_at) as newest_record,
    DATEDIFF(MAX(received_at), MIN(received_at)) as days_of_data
FROM ee_inventory_snapshots;

-- ========================================================================
-- PART 6: ADDITIONAL PERFORMANCE INDEXES
-- These indexes optimize frequently queried columns

-- Index for attendance edit logs (frequent COUNT queries)
CREATE INDEX IF NOT EXISTS idx_attendance_edit_logs_employee_id
    ON attendance_edit_logs(employee_id);

-- Index for washing item rates (frequent lookup by description)
CREATE INDEX IF NOT EXISTS idx_washing_item_rates_description
    ON washing_item_rates(description);

-- Index for finishing_data lot_no (used in subqueries)
CREATE INDEX IF NOT EXISTS idx_finishing_data_lot_no
    ON finishing_data(lot_no);

-- Index for washing_data lot_no (used in NOT IN subqueries)
CREATE INDEX IF NOT EXISTS idx_washing_data_lot_no
    ON washing_data(lot_no);

-- Index for audit_logs (if cleanup needed later)
CREATE INDEX IF NOT EXISTS idx_audit_logs_performed_at
    ON audit_logs(performed_at);

-- ========================================================================
-- NOTES:
--
-- 1. The 7-day retention period is a balance between:
--    - Having enough historical data for analytics
--    - Not consuming excessive storage
--
-- 2. If you need longer retention for specific SKUs, consider:
--    - A separate summary/aggregation table updated daily
--    - Archiving to S3 before deletion
--
-- 3. To change retention period, modify "INTERVAL 7 DAY" above
--
-- 4. If event_scheduler cannot be enabled, use a cron job instead:
--    Run this command daily: mysql -u user -p db < cleanup_snapshots.sql
-- ========================================================================
