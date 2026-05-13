-- Multi-role users. Additive on top of users.role_id.
--
-- After this migration:
--   - users.role_id remains the user's PRIMARY role (default landing).
--   - user_roles is the source of truth for "what roles does this user
--     have access to?". A user can have many rows.
--   - Existing single-role users are backfilled so user_roles always
--     contains at least their primary role.
--
-- Column types match users.id and roles.id exactly so FK constraints
-- pass. If your users.id is INT UNSIGNED, change the types accordingly
-- (run `DESCRIBE users;` and `DESCRIBE roles;` first).
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     INT NOT NULL,
  role_id     INT NOT NULL,
  granted_by  INT NULL,           -- audit: who added the grant
  granted_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id),
  KEY idx_user_roles_user (user_id),
  KEY idx_user_roles_role (role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backfill from each user's current primary role.
INSERT IGNORE INTO user_roles (user_id, role_id, granted_at)
SELECT id, role_id, NOW() FROM users WHERE role_id IS NOT NULL;
