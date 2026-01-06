-- Accounts DC challan setup
-- 1) GST master table for senders/consignees
CREATE TABLE IF NOT EXISTS dc_gst_parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  party_type ENUM('sender','consignee') NOT NULL,
  name VARCHAR(200) NOT NULL,
  gstin VARCHAR(32),
  address TEXT,
  state VARCHAR(100),
  pan VARCHAR(32),
  place_of_supply VARCHAR(64),
  short_code VARCHAR(10),
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 2) Challan counter tracking per consignee + fiscal year
CREATE TABLE IF NOT EXISTS dc_challan_counters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  consignee_id INT NOT NULL,
  year_range VARCHAR(12) NOT NULL,
  current_counter INT NOT NULL DEFAULT 1,
  UNIQUE KEY uniq_consignee_year (consignee_id, year_range),
  CONSTRAINT fk_dc_counter_consignee FOREIGN KEY (consignee_id)
    REFERENCES dc_gst_parties(id) ON DELETE CASCADE
);

-- 3) Items issued in each challan (supports partial lots)
CREATE TABLE IF NOT EXISTS dc_challan_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  challan_id INT NOT NULL,
  washing_id INT NULL,
  lot_no VARCHAR(64),
  sku VARCHAR(64),
  total_pieces INT,
  issued_pieces INT NOT NULL,
  item_type ENUM('normal','rewash','mix') NOT NULL DEFAULT 'normal',
  -- mix entries can set washing_id to NULL and use the custom label + sku override fields
  custom_label VARCHAR(255),
  sku_override VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dc_challan_items_washing (washing_id),
  CONSTRAINT fk_dc_items_challan FOREIGN KEY (challan_id)
    REFERENCES challan(id) ON DELETE CASCADE
);
