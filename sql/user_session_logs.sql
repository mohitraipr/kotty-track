-- Tracks per-session login durations for operator dashboard usage analytics
CREATE TABLE IF NOT EXISTS user_session_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(255) NOT NULL,
  session_id VARCHAR(128) NOT NULL,
  login_time DATETIME NOT NULL,
  last_activity_time DATETIME NOT NULL,
  logout_time DATETIME DEFAULT NULL,
  duration_seconds INT DEFAULT 0,
  INDEX idx_user_date (user_id, login_time),
  INDEX idx_session (session_id)
);
