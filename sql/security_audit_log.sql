-- Security Audit Log Table
-- Tracks login attempts, failed access, and suspicious activity

CREATE TABLE IF NOT EXISTS security_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  username VARCHAR(100),
  ip_address VARCHAR(50),
  user_agent TEXT,
  details JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_event_type (event_type),
  INDEX idx_username (username),
  INDEX idx_ip_address (ip_address),
  INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- View for failed login attempts (last 24 hours)
CREATE OR REPLACE VIEW v_failed_logins_24h AS
SELECT
  ip_address,
  username,
  COUNT(*) as attempt_count,
  MIN(created_at) as first_attempt,
  MAX(created_at) as last_attempt
FROM security_audit_log
WHERE event_type = 'LOGIN_FAILED'
  AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY ip_address, username
ORDER BY attempt_count DESC;

-- View for suspicious IPs (more than 5 failed attempts)
CREATE OR REPLACE VIEW v_suspicious_ips AS
SELECT
  ip_address,
  COUNT(DISTINCT username) as unique_usernames_tried,
  COUNT(*) as total_attempts,
  MAX(created_at) as last_attempt
FROM security_audit_log
WHERE event_type = 'LOGIN_FAILED'
  AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY ip_address
HAVING COUNT(*) >= 5
ORDER BY total_attempts DESC;
