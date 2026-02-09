-- Mail Manager tables for reply tracking and Excel mapping persistence

-- Track email replies and their status
CREATE TABLE IF NOT EXISTS mail_replies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(100) NOT NULL,
  thread_id VARCHAR(100),
  from_address VARCHAR(255),
  to_address VARCHAR(255),
  subject VARCHAR(500),
  order_id VARCHAR(50),
  awb VARCHAR(50),
  video_url TEXT,
  status ENUM('initial', 'proceeding', 'replied', 'closed', 'error') DEFAULT 'initial',
  classification VARCHAR(50),
  replied_by INT,
  replied_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_message_id (message_id),
  INDEX idx_order_id (order_id),
  INDEX idx_awb (awb),
  INDEX idx_status (status),
  INDEX idx_created_at (created_at),
  FOREIGN KEY (replied_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Persistent Order-to-AWB mapping from Excel uploads
CREATE TABLE IF NOT EXISTS order_awb_mapping (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(100) NOT NULL,
  awb VARCHAR(100) NOT NULL,
  uploaded_by INT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  source_file VARCHAR(255),
  UNIQUE KEY idx_order_awb (order_id, awb),
  INDEX idx_order_id (order_id),
  INDEX idx_awb (awb),
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

-- Bulk search job tracking for large AWB searches
CREATE TABLE IF NOT EXISTS bulk_search_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id VARCHAR(36) NOT NULL UNIQUE,
  user_id INT,
  total_awbs INT DEFAULT 0,
  processed_awbs INT DEFAULT 0,
  found_count INT DEFAULT 0,
  status ENUM('pending', 'processing', 'completed', 'failed', 'cancelled') DEFAULT 'pending',
  results_json LONGTEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_job_id (job_id),
  INDEX idx_user_status (user_id, status),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
