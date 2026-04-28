-- Rewash & Reject System Migration
-- Run this on production database

-- 1. Add rewash_rate column to settings or use config
-- For now, we'll use a fixed rate of 200 in code

-- 2. Add columns to rewash_requests to link with debit
-- Check and add columns if they don't exist (using separate statements for compatibility)
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rewash_requests' AND COLUMN_NAME = 'washer_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE rewash_requests ADD COLUMN washer_id INT DEFAULT NULL AFTER user_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rewash_requests' AND COLUMN_NAME = 'debit_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE rewash_requests ADD COLUMN debit_id INT DEFAULT NULL AFTER status', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rewash_requests' AND COLUMN_NAME = 'completed_by');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE rewash_requests ADD COLUMN completed_by INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'rewash_requests' AND COLUMN_NAME = 'completed_at');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE rewash_requests ADD COLUMN completed_at DATETIME DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Create reject_data table for tracking rejected pieces
CREATE TABLE IF NOT EXISTS reject_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lot_no VARCHAR(50) NOT NULL,
  sku VARCHAR(100),
  stage ENUM('stitching', 'washing_in', 'finishing') NOT NULL,
  user_id INT NOT NULL COMMENT 'Who rejected',
  source_data_id INT COMMENT 'stitching_data_id or washing_in_data_id etc',
  total_pieces INT NOT NULL DEFAULT 0,
  reason VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_reject_lot (lot_no),
  INDEX idx_reject_stage (stage),
  INDEX idx_reject_user (user_id)
);

-- 4. Create reject_data_sizes for size-wise reject tracking
CREATE TABLE IF NOT EXISTS reject_data_sizes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reject_data_id INT NOT NULL,
  size_label VARCHAR(20) NOT NULL,
  pieces INT NOT NULL DEFAULT 0,
  FOREIGN KEY (reject_data_id) REFERENCES reject_data(id) ON DELETE CASCADE
);

-- 5. Add rewash_request_id to stage_debits for linking
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stage_debits' AND COLUMN_NAME = 'rewash_request_id');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE stage_debits ADD COLUMN rewash_request_id INT DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stage_debits' AND COLUMN_NAME = 'auto_created');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE stage_debits ADD COLUMN auto_created TINYINT(1) DEFAULT 0', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. Add destination field to finishing_data
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'finishing_data' AND COLUMN_NAME = 'destination');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE finishing_data ADD COLUMN destination ENUM(''warehouse'', ''po'', ''return'', ''other'') DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'finishing_data' AND COLUMN_NAME = 'destination_remark');
SET @sql = IF(@col_exists = 0, 'ALTER TABLE finishing_data ADD COLUMN destination_remark VARCHAR(255) DEFAULT NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 7. Create index for faster rewash lookups (ignore errors if already exists)
-- Note: MySQL doesn't support CREATE INDEX IF NOT EXISTS, so we use a procedure approach or just let it fail silently
