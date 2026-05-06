-- VMS (AWB Video Recorder) + EasyEcom shipment ingestion
-- Run order:
--   1. Requires existing ee_orders, users tables.
--   2. Creates ee_shipments (one row per AWB) and vms_videos.

-- One row per AWB. Populated from EasyEcom order webhook (order_update)
-- whenever awb_number is present, and from a reconciliation pull cron
-- that hits EasyEcom for printed-label Ajio orders.
CREATE TABLE IF NOT EXISTS ee_shipments (
  awb VARCHAR(64) NOT NULL PRIMARY KEY,
  order_id BIGINT NOT NULL,
  invoice_id BIGINT NULL,
  reference_code VARCHAR(255) NULL,
  marketplace VARCHAR(120) NULL,
  marketplace_id BIGINT NULL,
  warehouse_id BIGINT NULL,
  courier_name VARCHAR(120) NULL,
  manifest_id VARCHAR(120) NULL,
  tracking_url TEXT NULL,
  label_status VARCHAR(60) NULL,
  current_status VARCHAR(60) NULL,
  order_status_id INT NULL,
  label_printed_at DATETIME NULL,
  dispatched_at DATETIME NULL,
  delivered_at DATETIME NULL,
  rto_at DATETIME NULL,
  last_seen_at DATETIME NULL,
  source ENUM('webhook','reconcile','manual') NOT NULL DEFAULT 'webhook',
  raw JSON NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ee_shipments_order (order_id),
  INDEX idx_ee_shipments_marketplace (marketplace_id),
  INDEX idx_ee_shipments_status (current_status),
  INDEX idx_ee_shipments_label_printed_at (label_printed_at),
  INDEX idx_ee_shipments_reference_code (reference_code)
);

-- One row per uploaded video. AWB is the natural key (one video per AWB).
-- Re-uploads should be rejected at the API layer; if retention rules ever
-- require versions, drop the UNIQUE and add (awb, version).
CREATE TABLE IF NOT EXISTS vms_videos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  awb VARCHAR(64) NOT NULL,
  marketplace VARCHAR(120) NULL,
  packer_id INT NULL,
  packer_name VARCHAR(120) NULL,
  s3_bucket VARCHAR(120) NULL,
  s3_key VARCHAR(500) NOT NULL,
  size_bytes BIGINT NULL,
  mime_type VARCHAR(60) NULL,
  duration_ms INT NULL,
  client_started_at DATETIME NULL,
  server_started_at DATETIME NULL,
  server_finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_vms_awb (awb),
  INDEX idx_vms_packer (packer_id),
  INDEX idx_vms_created_at (created_at),
  CONSTRAINT fk_vms_packer FOREIGN KEY (packer_id) REFERENCES users(id) ON DELETE SET NULL
);
