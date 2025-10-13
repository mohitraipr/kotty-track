-- sql/api_lot_tables.sql
-- Schema objects to support API driven lot creation and tracking.

CREATE TABLE IF NOT EXISTS api_lots (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lot_number VARCHAR(32) NOT NULL UNIQUE,
  cutting_master_id BIGINT UNSIGNED NOT NULL,
  sku VARCHAR(100) NOT NULL,
  fabric_type VARCHAR(100) NOT NULL,
  remark VARCHAR(255),
  bundle_size INT UNSIGNED NOT NULL,
  total_bundles INT UNSIGNED NOT NULL,
  total_pieces INT UNSIGNED NOT NULL,
  total_weight DECIMAL(12,3) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_api_lots_cutting_master FOREIGN KEY (cutting_master_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_lot_rolls (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lot_id BIGINT UNSIGNED NOT NULL,
  fabric_roll_id BIGINT UNSIGNED NOT NULL,
  roll_no VARCHAR(100) NOT NULL,
  weight_used DECIMAL(12,3) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_api_lot_rolls_lot FOREIGN KEY (lot_id) REFERENCES api_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_lot_rolls_fabric_roll FOREIGN KEY (fabric_roll_id) REFERENCES fabric_invoice_rolls(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_lot_sizes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lot_id BIGINT UNSIGNED NOT NULL,
  size_label VARCHAR(16) NOT NULL,
  pattern_count INT UNSIGNED NOT NULL,
  total_pieces INT UNSIGNED NOT NULL,
  bundle_count INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_api_lot_sizes_lot FOREIGN KEY (lot_id) REFERENCES api_lots(id) ON DELETE CASCADE,
  UNIQUE KEY uk_api_lot_sizes (lot_id, size_label)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_lot_bundles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lot_id BIGINT UNSIGNED NOT NULL,
  size_id BIGINT UNSIGNED NOT NULL,
  bundle_sequence INT UNSIGNED NOT NULL,
  size_bundle_index INT UNSIGNED NOT NULL,
  bundle_code CHAR(6) NOT NULL,
  pieces_in_bundle INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_api_lot_bundles_lot FOREIGN KEY (lot_id) REFERENCES api_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_lot_bundles_size FOREIGN KEY (size_id) REFERENCES api_lot_sizes(id) ON DELETE CASCADE,
  UNIQUE KEY uk_api_lot_bundle_code (lot_id, bundle_code),
  UNIQUE KEY uk_api_lot_bundle_sequence (lot_id, bundle_sequence)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_lot_piece_codes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  lot_id BIGINT UNSIGNED NOT NULL,
  bundle_id BIGINT UNSIGNED NOT NULL,
  size_id BIGINT UNSIGNED NOT NULL,
  piece_sequence INT UNSIGNED NOT NULL,
  bundle_piece_index INT UNSIGNED NOT NULL,
  piece_code CHAR(8) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_api_lot_piece_codes_lot FOREIGN KEY (lot_id) REFERENCES api_lots(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_lot_piece_codes_bundle FOREIGN KEY (bundle_id) REFERENCES api_lot_bundles(id) ON DELETE CASCADE,
  CONSTRAINT fk_api_lot_piece_codes_size FOREIGN KEY (size_id) REFERENCES api_lot_sizes(id) ON DELETE CASCADE,
  UNIQUE KEY uk_api_lot_piece_code (lot_id, piece_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
