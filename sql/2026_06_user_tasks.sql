-- 2026_06_user_tasks.sql
-- Personal to-dos + user task assignment (mohitteam feature).
-- Apply manually via Cloud SQL Studio. Idempotent (CREATE TABLE IF NOT EXISTS).
--
-- PREFLIGHT: run `SHOW CREATE TABLE users;` first and make `created_by` / `assigned_to`
-- match the exact type of `users.id`. A MySQL FK requires identical column type + signedness.
-- Evidence across this repo (sql/multi_role_user.sql, sql/return_challan_tables.sql, etc.)
-- points to `users.id` being INT, so INT is used below. If it is BIGINT UNSIGNED instead,
-- change both columns to BIGINT UNSIGNED.

CREATE TABLE IF NOT EXISTS user_tasks (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title        VARCHAR(255) NOT NULL,
  description  TEXT DEFAULT NULL,
  status       ENUM('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
  priority     ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  due_date     DATE DEFAULT NULL,
  created_by   INT NOT NULL,            -- creator; must match users.id type
  assigned_to  INT NOT NULL,            -- assignee; personal todo => assigned_to == created_by
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL DEFAULT NULL,
  CONSTRAINT fk_user_tasks_creator  FOREIGN KEY (created_by)  REFERENCES users(id),
  CONSTRAINT fk_user_tasks_assignee FOREIGN KEY (assigned_to) REFERENCES users(id),
  INDEX idx_user_tasks_assigned_status (assigned_to, status),
  INDEX idx_user_tasks_creator_status  (created_by, status),
  INDEX idx_user_tasks_due_date (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_task_history (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id         BIGINT UNSIGNED NOT NULL,
  changed_by      INT NOT NULL,
  previous_status ENUM('open','in_progress','done','cancelled') DEFAULT NULL,  -- NULL on the creation row
  new_status      ENUM('open','in_progress','done','cancelled') NOT NULL,
  note            VARCHAR(500) DEFAULT NULL,
  changed_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_uth_task FOREIGN KEY (task_id)    REFERENCES user_tasks(id),
  CONSTRAINT fk_uth_user FOREIGN KEY (changed_by) REFERENCES users(id),
  INDEX idx_uth_task (task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
