-- Product Links Feature Migration
-- Created: 2026-02-20
-- Description: Creates product_links table and adds productviewer role

-- =====================================================
-- 1. Add productviewer role
-- =====================================================
INSERT INTO roles (name) VALUES ('productviewer')
ON DUPLICATE KEY UPDATE name = name;

-- =====================================================
-- 2. Create product_links table
-- =====================================================
CREATE TABLE IF NOT EXISTS product_links (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  amazon_link VARCHAR(500) DEFAULT NULL,
  myntra_link VARCHAR(500) DEFAULT NULL,
  nykaa_link VARCHAR(500) DEFAULT NULL,
  flipkart_link VARCHAR(500) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_by INT NOT NULL,
  UNIQUE KEY unique_sku (sku),
  INDEX idx_sku (sku),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =====================================================
-- 3. Verify migration
-- =====================================================
-- Check role was added:
-- SELECT * FROM roles WHERE name = 'productviewer';

-- Check table was created:
-- DESCRIBE product_links;
