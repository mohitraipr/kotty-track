-- 2026_06_user_tasks_v2.sql
-- Tasks v2: Linear-like model — status set (todo/in_progress/done/blocked),
-- richer priority, projects, and tags. Apply AFTER 2026_06_user_tasks.sql.
-- Apply manually via Cloud SQL Studio.
--
-- The ALTER ... MODIFY statements are effectively idempotent (re-running with
-- the same definition is a no-op). The ADD COLUMN / CREATE TABLE run once.

-- 1) Status: add 'todo' + 'blocked'; keep legacy values so existing rows survive.
--    Canonical board statuses are todo / in_progress / done / blocked.
ALTER TABLE user_tasks
  MODIFY status ENUM('todo','in_progress','done','blocked','open','cancelled')
  NOT NULL DEFAULT 'todo';

-- Migrate any legacy 'open' rows to 'todo'.
UPDATE user_tasks SET status = 'todo' WHERE status = 'open';

-- Drop the legacy 'open' value now that nothing uses it (keep 'cancelled').
ALTER TABLE user_tasks
  MODIFY status ENUM('todo','in_progress','done','blocked','cancelled')
  NOT NULL DEFAULT 'todo';

-- 1b) History table mirrors the status set (superset keeps legacy 'open' rows safe).
ALTER TABLE user_task_history
  MODIFY previous_status ENUM('open','todo','in_progress','done','blocked','cancelled') DEFAULT NULL,
  MODIFY new_status      ENUM('open','todo','in_progress','done','blocked','cancelled') NOT NULL;

-- 2) Priority: Linear-style scale. Keep existing low/medium/high, add none + urgent.
ALTER TABLE user_tasks
  MODIFY priority ENUM('none','low','medium','high','urgent') NOT NULL DEFAULT 'medium';

-- 3) Projects.
CREATE TABLE IF NOT EXISTS task_projects (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  project_key VARCHAR(12)  NOT NULL,          -- short code shown in the UI, e.g. ENG
  color       VARCHAR(20)  DEFAULT NULL,      -- optional accent hex
  created_by  INT NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_task_projects_key (project_key),
  CONSTRAINT fk_task_projects_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4) Link tasks to a project (nullable).
ALTER TABLE user_tasks
  ADD COLUMN project_id BIGINT UNSIGNED DEFAULT NULL AFTER assigned_to,
  ADD CONSTRAINT fk_user_tasks_project FOREIGN KEY (project_id)
      REFERENCES task_projects(id) ON DELETE SET NULL,
  ADD INDEX idx_user_tasks_project (project_id);

-- 5) Tags (free-form, multiple per task).
CREATE TABLE IF NOT EXISTS user_task_tags (
  id      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  task_id BIGINT UNSIGNED NOT NULL,
  tag     VARCHAR(50) NOT NULL,
  UNIQUE KEY uk_user_task_tags (task_id, tag),
  CONSTRAINT fk_user_task_tags_task FOREIGN KEY (task_id)
      REFERENCES user_tasks(id) ON DELETE CASCADE,
  INDEX idx_user_task_tags_tag (tag)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
