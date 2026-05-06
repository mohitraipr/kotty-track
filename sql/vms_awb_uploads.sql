-- vmsOperator manually uploads the AWBs we need to record videos for.
-- Replaces the EasyEcom-recon path for the VMS pending list.

CREATE TABLE IF NOT EXISTS vms_awb_uploads (
  awb VARCHAR(64) NOT NULL PRIMARY KEY,
  customer_order_id VARCHAR(100) NULL,
  marketplace VARCHAR(120) NULL,
  notes VARCHAR(255) NULL,
  uploaded_by INT NULL,
  source_file VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_vms_uploads_customer_order (customer_order_id),
  INDEX idx_vms_uploads_created_at (created_at),
  CONSTRAINT fk_vms_uploads_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
