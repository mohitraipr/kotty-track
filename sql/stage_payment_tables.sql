-- Stage Payment System Tables
-- Unified payment tracking across all production stages

-- 1. Base rates per SKU per stage
CREATE TABLE IF NOT EXISTS stage_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  stage ENUM('cutting', 'stitching', 'washing', 'assembly', 'finishing') NOT NULL,
  rate DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_salary_tracked TINYINT(1) DEFAULT 0,  -- For costing purposes (salaried workers)
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sku_stage (sku, stage),
  INDEX idx_stage (stage),
  INDEX idx_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Extra jobwork rates (additive to base rate)
CREATE TABLE IF NOT EXISTS stage_extra_rates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  stage ENUM('cutting', 'stitching', 'washing', 'assembly', 'finishing') NOT NULL,
  extra_name VARCHAR(100) NOT NULL,  -- e.g., "Special Wash", "Hand Finish", "Double Stitch"
  rate DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_by INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_sku_stage_extra (sku, stage, extra_name),
  INDEX idx_stage_sku (stage, sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Payment records
CREATE TABLE IF NOT EXISTS stage_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  lot_no VARCHAR(50) NOT NULL,
  sku VARCHAR(100) NOT NULL,
  stage ENUM('cutting', 'stitching', 'washing', 'assembly', 'finishing') NOT NULL,
  qty INT NOT NULL,
  base_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
  extra_rates_json JSON,  -- [{"name": "Special Wash", "rate": 5}]
  extra_amount DECIMAL(10,2) DEFAULT 0,
  total_amount DECIMAL(10,2) NOT NULL,
  is_salary_tracked TINYINT(1) DEFAULT 0,  -- If true, for costing only (not actual payment)
  status ENUM('pending', 'paid', 'cancelled') DEFAULT 'pending',
  batch_id VARCHAR(50),  -- Group payments processed together
  paid_on DATETIME,
  paid_by INT,  -- Operator who marked as paid
  created_by INT NOT NULL,  -- Operator who created payment
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_stage (user_id, stage),
  INDEX idx_user_status (user_id, status),
  INDEX idx_lot_stage (lot_no, stage),
  INDEX idx_status (status),
  INDEX idx_batch (batch_id),
  INDEX idx_created_at (created_at),
  UNIQUE KEY uk_lot_stage_user (lot_no, stage, user_id)  -- Prevent duplicate payments
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Debit/deduction records
CREATE TABLE IF NOT EXISTS stage_debits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(100) NOT NULL,
  lot_no VARCHAR(50),  -- NULL for general debits (not lot-linked)
  sku VARCHAR(100),
  stage ENUM('cutting', 'stitching', 'washing', 'assembly', 'finishing') NOT NULL,
  qty INT,
  rate DECIMAL(10,2),
  amount DECIMAL(10,2) NOT NULL,
  reason TEXT NOT NULL,  -- e.g., "250 pcs repair work found in washing"
  status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
  raised_by INT NOT NULL,  -- Operator who raised the debit
  raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_by INT,  -- Operator who approved/rejected
  approved_on DATETIME,
  rejection_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_status (user_id, status),
  INDEX idx_stage_status (stage, status),
  INDEX idx_status (status),
  INDEX idx_lot (lot_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. Payment batches (for grouping payments when marking as paid)
CREATE TABLE IF NOT EXISTS stage_payment_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id VARCHAR(50) NOT NULL UNIQUE,
  stage ENUM('cutting', 'stitching', 'washing', 'assembly', 'finishing') NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL,
  payment_count INT NOT NULL,
  paid_by INT NOT NULL,
  paid_on DATETIME DEFAULT CURRENT_TIMESTAMP,
  notes TEXT,
  INDEX idx_stage (stage),
  INDEX idx_paid_on (paid_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
