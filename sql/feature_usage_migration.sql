-- Feature Usage Tracking Migration
-- Run on kotty-track-prod Cloud SQL

-- Table to track feature/route usage
CREATE TABLE IF NOT EXISTS feature_usage (
  id INT AUTO_INCREMENT PRIMARY KEY,
  feature_name VARCHAR(100) NOT NULL,
  route_path VARCHAR(200) NOT NULL,
  user_id INT DEFAULT NULL,
  username VARCHAR(100) DEFAULT NULL,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  response_time_ms INT DEFAULT NULL,
  INDEX idx_feature (feature_name),
  INDEX idx_timestamp (timestamp),
  INDEX idx_user (user_id),
  INDEX idx_route (route_path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Table to store daily aggregated usage (for performance)
CREATE TABLE IF NOT EXISTS feature_usage_daily (
  id INT AUTO_INCREMENT PRIMARY KEY,
  feature_name VARCHAR(100) NOT NULL,
  route_path VARCHAR(200) NOT NULL,
  date DATE NOT NULL,
  total_hits INT DEFAULT 0,
  unique_users INT DEFAULT 0,
  avg_response_ms INT DEFAULT NULL,
  UNIQUE KEY unique_feature_date (feature_name, route_path, date),
  INDEX idx_date (date),
  INDEX idx_feature (feature_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Scheduled event to aggregate daily data and cleanup old raw data
-- Run this manually or set up a Cloud Scheduler job
-- Note: This keeps 7 days of raw data, aggregates older data into daily table

DELIMITER //
CREATE PROCEDURE IF NOT EXISTS aggregate_feature_usage()
BEGIN
  -- Insert/update daily aggregates for yesterday
  INSERT INTO feature_usage_daily (feature_name, route_path, date, total_hits, unique_users, avg_response_ms)
  SELECT
    feature_name,
    route_path,
    DATE(timestamp) as date,
    COUNT(*) as total_hits,
    COUNT(DISTINCT user_id) as unique_users,
    AVG(response_time_ms) as avg_response_ms
  FROM feature_usage
  WHERE DATE(timestamp) = CURDATE() - INTERVAL 1 DAY
  GROUP BY feature_name, route_path, DATE(timestamp)
  ON DUPLICATE KEY UPDATE
    total_hits = VALUES(total_hits),
    unique_users = VALUES(unique_users),
    avg_response_ms = VALUES(avg_response_ms);

  -- Delete raw data older than 7 days (keep aggregates)
  DELETE FROM feature_usage WHERE timestamp < NOW() - INTERVAL 7 DAY;
END //
DELIMITER ;
