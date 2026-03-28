-- Store & Indent Module Revamp Migration
-- All changes are additive and non-breaking

-- 1. Add shade column to goods_inventory
ALTER TABLE goods_inventory
  ADD COLUMN shade VARCHAR(100) DEFAULT NULL AFTER size;

-- 2. Create store_settings table for global settings
CREATE TABLE IF NOT EXISTS store_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
INSERT IGNORE INTO store_settings (setting_key, setting_value) VALUES ('allow_freetext_indent', 'true');

-- 3. Add invoice/vendor columns to incoming_data
ALTER TABLE incoming_data
  ADD COLUMN invoice_number VARCHAR(100) DEFAULT NULL,
  ADD COLUMN vendor_name VARCHAR(255) DEFAULT NULL,
  ADD COLUMN entry_date DATE DEFAULT NULL;

-- 4. Create store_vendors table for autocomplete
CREATE TABLE IF NOT EXISTS store_vendors (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Add goods_id FK to indent_requests
ALTER TABLE indent_requests
  ADD COLUMN goods_id BIGINT UNSIGNED DEFAULT NULL AFTER filler_id;

-- Add FK constraint (wrapped in procedure to avoid duplicate key errors on re-run)
DELIMITER //
CREATE PROCEDURE add_indent_goods_fk()
BEGIN
  DECLARE CONTINUE HANDLER FOR 1061 BEGIN END; -- duplicate key
  DECLARE CONTINUE HANDLER FOR 1005 BEGIN END; -- can't create table (FK exists)
  ALTER TABLE indent_requests
    ADD CONSTRAINT fk_indent_goods FOREIGN KEY (goods_id) REFERENCES goods_inventory(id) ON DELETE SET NULL;
END //
DELIMITER ;
CALL add_indent_goods_fk();
DROP PROCEDURE IF EXISTS add_indent_goods_fk;

-- 6. Add indexes for analytics queries
ALTER TABLE dispatched_data ADD INDEX idx_dispatched_goods_date (goods_id, dispatched_at);
ALTER TABLE indent_requests ADD INDEX idx_indent_goods_status (goods_id, status);

-- 7. Backfill existing indent_requests with goods_id where possible
UPDATE indent_requests ir
JOIN goods_inventory gi ON LOWER(TRIM(ir.goods_description)) = LOWER(TRIM(gi.description_of_goods))
SET ir.goods_id = gi.id
WHERE ir.goods_id IS NULL;
