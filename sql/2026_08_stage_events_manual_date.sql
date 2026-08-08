-- Manual date: the actual day the stage action happened on the floor, which can
-- differ from created_at (masters sometimes record work a day or more after it
-- happened). Shadow column beside the server-controlled created_at — created_at
-- is NEVER overridden. Display/bucketing consumers read the effective date via
-- COALESCE(manual_date, created_at); payment eligibility, in-flight windows and
-- cache keys stay on raw created_at.
-- Mirrors cutting_lots.manual_cutting_date (sql/cutting_manual_cutting_date_migration.sql).
--
-- Run BEFORE deploying the code that writes/reads manual_date.

ALTER TABLE stitching_events      ADD COLUMN manual_date DATE NULL AFTER remark;
ALTER TABLE jeans_assembly_events ADD COLUMN manual_date DATE NULL AFTER remark;
ALTER TABLE washing_events        ADD COLUMN manual_date DATE NULL AFTER remark;
ALTER TABLE washing_in_events     ADD COLUMN manual_date DATE NULL AFTER remark;
ALTER TABLE finishing_events      ADD COLUMN manual_date DATE NULL AFTER remark;
