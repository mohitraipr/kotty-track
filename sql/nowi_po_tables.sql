-- sql/nowi_po_tables.sql
-- Tables for Nowi PO mapping and vendor purchase order generation

CREATE TABLE IF NOT EXISTS nowi_po_sku_mappings (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(100) NOT NULL,
  vendor_code VARCHAR(100) NOT NULL,
  color VARCHAR(100) DEFAULT NULL,
  link TEXT DEFAULT NULL,
  image TEXT DEFAULT NULL,
  weight DECIMAL(10,3) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_nowi_po_sku (sku),
  INDEX idx_nowi_po_vendor_code (vendor_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nowi_po_headers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_number VARCHAR(50) DEFAULT NULL,
  vendor_code VARCHAR(100) NOT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_nowi_po_headers_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_nowi_po_number (po_number),
  INDEX idx_nowi_po_vendor_code (vendor_code),
  INDEX idx_nowi_po_created_by (created_by)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS nowi_po_lines (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  po_id BIGINT UNSIGNED NOT NULL,
  sku VARCHAR(100) NOT NULL,
  size VARCHAR(30) NOT NULL,
  quantity INT NOT NULL,
  color VARCHAR(100) DEFAULT NULL,
  image TEXT DEFAULT NULL,
  link TEXT DEFAULT NULL,
  weight DECIMAL(10,3) DEFAULT NULL,
  vendor_code VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_nowi_po_lines_po FOREIGN KEY (po_id) REFERENCES nowi_po_headers(id) ON DELETE CASCADE,
  INDEX idx_nowi_po_lines_po (po_id),
  INDEX idx_nowi_po_lines_vendor (vendor_code),
  INDEX idx_nowi_po_lines_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
