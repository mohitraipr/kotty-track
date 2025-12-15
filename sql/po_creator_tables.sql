-- sql/po_creator_tables.sql
-- Tables for PO Creator Inward/Outward Management System

-- Table to store carton information
CREATE TABLE IF NOT EXISTS cartons (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  carton_number VARCHAR(100) NOT NULL UNIQUE,
  date_of_packing DATE NOT NULL,
  packed_by VARCHAR(255) NOT NULL,
  panel_name VARCHAR(255) NOT NULL,
  creator_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_cartons_creator FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_carton_number (carton_number),
  INDEX idx_creator_user_id (creator_user_id),
  INDEX idx_date_of_packing (date_of_packing),
  INDEX idx_panel_name (panel_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Migration: Add panel_name column to existing cartons table
ALTER TABLE cartons ADD COLUMN IF NOT EXISTS panel_name VARCHAR(255) DEFAULT '' AFTER packed_by;

-- Table to store panel names and their prefixes
CREATE TABLE IF NOT EXISTS panel_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  prefix VARCHAR(10) NOT NULL UNIQUE,
  current_number INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default panel names
INSERT INTO panel_names (name, prefix) VALUES
  ('FLIPKART', 'FL'),
  ('AMAZON', 'AM'),
  ('MYNTRA', 'MY')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Table to store SKU details for each carton
CREATE TABLE IF NOT EXISTS carton_skus (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  carton_id BIGINT UNSIGNED NOT NULL,
  brand_code VARCHAR(20) NOT NULL,
  category VARCHAR(100) NOT NULL,
  sku_code VARCHAR(50) NOT NULL,
  full_sku VARCHAR(200) NOT NULL,
  size VARCHAR(20) NOT NULL,
  quantity INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_carton_skus_carton FOREIGN KEY (carton_id) REFERENCES cartons(id) ON DELETE CASCADE,
  INDEX idx_carton_id (carton_id),
  INDEX idx_full_sku (full_sku),
  INDEX idx_brand_code (brand_code),
  INDEX idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to store outward/dispatch information
CREATE TABLE IF NOT EXISTS carton_outward (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  carton_id BIGINT UNSIGNED NOT NULL,
  po_number VARCHAR(100) NOT NULL,
  dispatch_date DATE NOT NULL,
  panel_name VARCHAR(255) NOT NULL,
  creator_user_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_carton_outward_carton FOREIGN KEY (carton_id) REFERENCES cartons(id) ON DELETE CASCADE,
  CONSTRAINT fk_carton_outward_creator FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_po_number (po_number),
  INDEX idx_dispatch_date (dispatch_date),
  INDEX idx_carton_id (carton_id),
  INDEX idx_creator_user_id (creator_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table to store brand codes (hardcoded values)
CREATE TABLE IF NOT EXISTS sku_brand_codes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  description VARCHAR(100),
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default brand codes
INSERT INTO sku_brand_codes (code, description) VALUES
  ('KTT', 'KTT Brand'),
  ('KOTTY', 'KOTTY Brand'),
  ('KOTY', 'KOTY Brand'),
  ('KOTI', 'KOTI Brand'),
  ('KTY', 'KTY Brand')
ON DUPLICATE KEY UPDATE description = VALUES(description);

-- Table to store categories (hardcoded values)
CREATE TABLE IF NOT EXISTS sku_categories (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255),
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default categories
INSERT INTO sku_categories (name, description) VALUES
  ('LADIESJEANS', 'Ladies Jeans'),
  ('SKIRT', 'Skirt'),
  ('MENSJEANS', 'Mens Jeans'),
  ('WOMENSJEANS', 'Womens Jeans'),
  ('WOMENSPANT', 'Womens Pant')
ON DUPLICATE KEY UPDATE description = VALUES(description);
