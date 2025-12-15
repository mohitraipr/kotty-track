-- Migration script for panel auto-increment feature
-- Run this with: mysql -u root -p kotty_track < sql/panel_auto_increment_migration.sql

-- Create panel_names table
CREATE TABLE IF NOT EXISTS panel_names (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  prefix VARCHAR(10) NOT NULL UNIQUE,
  current_number INT UNSIGNED NOT NULL DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default panel names
INSERT INTO panel_names (name, prefix) VALUES
  ('FLIPKART', 'FL'),
  ('AMAZON', 'AM'),
  ('MYNTRA', 'MY')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- Show created data
SELECT * FROM panel_names;
