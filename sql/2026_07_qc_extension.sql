-- QC-Capture extension ingestion (see docs/plans/01-qcpass-extension.md).
-- The `jitrgp` role already exists; login gates on it. Tokens are DB-backed + revocable.

CREATE TABLE IF NOT EXISTS qc_ext_tokens (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  token_hash    CHAR(64) NOT NULL UNIQUE,      -- sha256 of the raw token; raw is never stored
  user_id       INT NOT NULL,
  device_label  VARCHAR(80) NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TIMESTAMP NULL,
  revoked_at    TIMESTAMP NULL,
  INDEX idx_qet_user (user_id),
  CONSTRAINT fk_qet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS qc_return_captures (
  capture_uid   CHAR(64) NOT NULL PRIMARY KEY, -- client-stable dedupe id (idempotent upsert)
  captured_by   INT NOT NULL,
  return_id     VARCHAR(40) NULL,
  item_barcode  VARCHAR(60) NULL,
  tracking_number VARCHAR(80) NULL,
  oms_release_id VARCHAR(40) NULL,
  sku_id        VARCHAR(40) NULL,
  sku_code      VARCHAR(80) NULL,
  style_id      VARCHAR(40) NULL,
  article_no    VARCHAR(80) NULL,
  product_name  VARCHAR(255) NULL,
  size          VARCHAR(20) NULL,
  price         DECIMAL(10,2) NULL,
  return_type   VARCHAR(40) NULL,
  return_mode   VARCHAR(40) NULL,
  return_status VARCHAR(40) NULL,
  rms_status    VARCHAR(40) NULL,
  qc_action     VARCHAR(40) NULL,
  quality       VARCHAR(20) NULL,
  logistics_status VARCHAR(60) NULL,
  courier_code  VARCHAR(40) NULL,
  return_hub    VARCHAR(40) NULL,
  dispatch_wh   VARCHAR(40) NULL,
  return_destination_wh VARCHAR(40) NULL,
  delivery_center VARCHAR(40) NULL,
  ship_city     VARCHAR(80) NULL,
  created_date  DATE NULL,
  refund_date   DATE NULL,
  return_received_on DATE NULL,
  return_restocked_on DATE NULL,
  raw_json      JSON NULL,                      -- full record, so nothing is lost pre-columnization
  captured_at   DATETIME NULL,
  ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qrc_return (return_id),
  INDEX idx_qrc_barcode (item_barcode),
  INDEX idx_qrc_by (captured_by),
  INDEX idx_qrc_at (captured_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS qc_return_passes (
  capture_uid   CHAR(64) NOT NULL PRIMARY KEY,
  passed_by     INT NOT NULL,
  item_barcode  VARCHAR(60) NULL,
  oms_release_id VARCHAR(40) NULL,
  qc_action     VARCHAR(40) NULL,
  quality       VARCHAR(20) NULL,
  desk_code     VARCHAR(20) NULL,
  warehouse_id  VARCHAR(40) NULL,
  pass_success  TINYINT(1) NULL,
  new_status    VARCHAR(40) NULL,
  pass_error    VARCHAR(255) NULL,
  passed_at     DATETIME NULL,
  raw_json      JSON NULL,
  ingested_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qrp_barcode (item_barcode),
  INDEX idx_qrp_by (passed_by),
  INDEX idx_qrp_at (passed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
