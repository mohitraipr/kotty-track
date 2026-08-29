-- Async job tracking for PIC-size report downloads (operator + PM in-production).
-- Wide date ranges / all-styles pulls can take minutes; running them inline on the
-- request blocks the connection until Cloud Run's timeout kills it ("Server error" /
-- "Failed to fetch"). Jobs move the work off the request: create job -> self-call
-- keeps CPU allocated while it runs -> poll -> download from GCS when done.
-- Run on prod before deploying the job-based download flow.
CREATE TABLE IF NOT EXISTS pic_report_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  report_type ENUM('operator_size', 'pm_in_production') NOT NULL,
  params_hash VARCHAR(32) NOT NULL,
  params_json TEXT NOT NULL,
  requested_by INT NULL,
  status ENUM('queued', 'running', 'done', 'failed') NOT NULL DEFAULT 'queued',
  gcs_key VARCHAR(255) NULL,
  filename VARCHAR(255) NULL,
  row_count INT NULL,
  message VARCHAR(500) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  -- Dedup lookup: an identical in-flight request (double-click, page reload,
  -- second tab) reuses the existing job instead of stacking a new one.
  INDEX idx_dedup (report_type, params_hash, status, created_at),
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL
);
