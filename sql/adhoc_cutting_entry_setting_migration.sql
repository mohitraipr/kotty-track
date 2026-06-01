-- Seeds the global switch that controls whether cutters may enter fabric types /
-- roll numbers not present in the fabric database. Default OFF ('false').
-- The store_settings table is created by store_indent_revamp_migration.sql.
INSERT IGNORE INTO store_settings (setting_key, setting_value)
VALUES ('allow_adhoc_cutting_entry', 'false');
