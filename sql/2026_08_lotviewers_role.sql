-- Read-only mobile lot flow viewer role. Dashboard: /lot-view.
-- Run on prod before assigning the role to anyone (harmless to run any time —
-- the routes 403 unknown roles and login falls back safely).
INSERT IGNORE INTO roles (name, description)
VALUES ('lotviewers', 'Read-only mobile lot flow viewer');
