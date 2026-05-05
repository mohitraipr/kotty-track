-- Mail Manager: per-email video lookup history.
-- One row per message_id (upsert on every scan/lookup) so we can export
-- "video found" vs "video not found" without re-hitting Zoho/S3.

CREATE TABLE IF NOT EXISTS mail_video_checks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(100) NOT NULL,
  thread_id VARCHAR(100),
  subject VARCHAR(500),
  from_address VARCHAR(255),
  to_address VARCHAR(255),
  received_at TIMESTAMP NULL,
  order_id VARCHAR(100),
  outbound_awb VARCHAR(100),
  return_awb VARCHAR(100),
  ticket VARCHAR(100),
  video_found TINYINT(1) NOT NULL DEFAULT 0,
  video_url TEXT,
  video_s3_key VARCHAR(500),
  video_size BIGINT,
  scan_source VARCHAR(40) DEFAULT 'manual',
  checked_by INT,
  checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_message_id (message_id),
  INDEX idx_video_found (video_found),
  INDEX idx_order_id (order_id),
  INDEX idx_outbound_awb (outbound_awb),
  INDEX idx_received_at (received_at),
  INDEX idx_checked_at (checked_at),
  FOREIGN KEY (checked_by) REFERENCES users(id) ON DELETE SET NULL
);
