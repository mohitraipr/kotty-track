-- Technical role: URL directory + route/role diagnostics. Dashboard: /tech.
-- Run on prod BEFORE deploying the /tech route, then grant the role to a user
-- via /admin/user-roles — access is strictly 'tech' (no admin fallback), so
-- until someone holds the role nobody can open the page at all.
-- Harmless to run any time: unknown roles are rejected by the route guard.
INSERT IGNORE INTO roles (name, description)
VALUES ('tech', 'Technical: URL directory and route diagnostics');
