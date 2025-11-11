-- sql/user_masters_table.sql
-- Table to store masters created by users in roles allowed by the API endpoints.
-- Each master belongs to the user (creator) who created it.

CREATE TABLE IF NOT EXISTS user_masters (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  creator_user_id BIGINT UNSIGNED NOT NULL,
  creator_role VARCHAR(64) NOT NULL,
  master_name VARCHAR(255) NOT NULL,
  contact_number VARCHAR(20) DEFAULT NULL,
  notes VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_masters_creator FOREIGN KEY (creator_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT uq_user_masters_per_creator UNIQUE (creator_user_id, master_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
