-- Rewash & Reject System Migration
-- Run this on production database

-- 1. Add rewash_rate column to settings or use config
-- For now, we'll use a fixed rate of 200 in code

-- 2. Add columns to rewash_requests to link with debit
ALTER TABLE rewash_requests
ADD COLUMN IF NOT EXISTS washer_id INT DEFAULT NULL AFTER user_id,
ADD COLUMN IF NOT EXISTS debit_id INT DEFAULT NULL AFTER status,
ADD COLUMN IF NOT EXISTS completed_by INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS completed_at DATETIME DEFAULT NULL;

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
ALTER TABLE stage_debits
ADD COLUMN IF NOT EXISTS rewash_request_id INT DEFAULT NULL,
ADD COLUMN IF NOT EXISTS auto_created TINYINT(1) DEFAULT 0 COMMENT '1 if auto-created for rewash';

-- 6. Add destination field to finishing_data
ALTER TABLE finishing_data
ADD COLUMN IF NOT EXISTS destination ENUM('warehouse', 'po', 'return', 'other') DEFAULT NULL,
ADD COLUMN IF NOT EXISTS destination_remark VARCHAR(255) DEFAULT NULL;

-- 7. Create index for faster rewash lookups
CREATE INDEX IF NOT EXISTS idx_rewash_washer ON rewash_requests(washer_id);
CREATE INDEX IF NOT EXISTS idx_rewash_status ON rewash_requests(status);
CREATE INDEX IF NOT EXISTS idx_debit_rewash ON stage_debits(rewash_request_id);
