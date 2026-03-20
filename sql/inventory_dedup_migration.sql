-- Inventory Snapshot Deduplication Migration
-- This migration converts the ee_inventory_snapshots table from storing every webhook
-- to storing only the latest value per SKU+warehouse (upsert pattern)

-- Step 1: Delete duplicate rows, keeping only the latest (highest id) per SKU+warehouse
-- This uses a self-join to find and delete older duplicates
-- Run in batches to avoid lock timeouts on large tables

DELIMITER //

DROP PROCEDURE IF EXISTS cleanup_snapshot_duplicates//

CREATE PROCEDURE cleanup_snapshot_duplicates()
BEGIN
    DECLARE rows_deleted INT DEFAULT 1;
    DECLARE batch_size INT DEFAULT 50000;
    DECLARE total_deleted INT DEFAULT 0;

    -- Loop until no more duplicates
    WHILE rows_deleted > 0 DO
        DELETE t1 FROM ee_inventory_snapshots t1
        INNER JOIN ee_inventory_snapshots t2
        ON t1.sku = t2.sku
           AND COALESCE(t1.warehouse_id, 0) = COALESCE(t2.warehouse_id, 0)
           AND t1.id < t2.id
        LIMIT batch_size;

        SET rows_deleted = ROW_COUNT();
        SET total_deleted = total_deleted + rows_deleted;

        -- Brief pause to reduce lock contention
        DO SLEEP(0.5);

        SELECT CONCAT('Deleted batch: ', rows_deleted, ', Total: ', total_deleted) AS progress;
    END WHILE;

    SELECT CONCAT('Cleanup complete. Total rows deleted: ', total_deleted) AS result;
END//

DELIMITER ;

-- Run the cleanup
CALL cleanup_snapshot_duplicates();

-- Drop the procedure after use
DROP PROCEDURE IF EXISTS cleanup_snapshot_duplicates;

-- Step 2: Add unique constraint to prevent future duplicates
-- First check if constraint already exists
SET @constraint_exists = (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ee_inventory_snapshots'
    AND CONSTRAINT_NAME = 'uniq_sku_warehouse'
);

-- Add constraint if it doesn't exist
SET @sql = IF(@constraint_exists = 0,
    'ALTER TABLE ee_inventory_snapshots ADD UNIQUE KEY uniq_sku_warehouse (sku, warehouse_id)',
    'SELECT "Constraint already exists" AS status'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify the constraint was added
SHOW INDEX FROM ee_inventory_snapshots WHERE Key_name = 'uniq_sku_warehouse';

-- Show final row count
SELECT COUNT(*) AS final_row_count FROM ee_inventory_snapshots;
