-- Seed standard departments used by the return-challan dashboard.
-- Idempotent: inserts only names that don't already exist (the `departments`
-- table has no guaranteed UNIQUE constraint on name, so guard with NOT EXISTS).
-- Run against prod DB.
INSERT INTO departments (name)
SELECT v.name FROM (
  SELECT 'EROS' AS name UNION ALL SELECT 'GB-65' UNION ALL
  SELECT 'GC-197 FINISHING' UNION ALL SELECT 'GC-20' UNION ALL
  SELECT 'GC-78 FINISHING' UNION ALL SELECT 'GC-78 WAREHOUSE' UNION ALL
  SELECT 'HAWRAH' UNION ALL SELECT 'NEW BUILDING DENIM' UNION ALL
  SELECT 'NEW BUILDING DENIM-2' UNION ALL SELECT 'NEW BUILDING FINISHING' UNION ALL
  SELECT 'NEW BUILDING WAREHOUSE' UNION ALL SELECT 'SAMBHAL' UNION ALL SELECT 'TIRANGA'
) v
WHERE NOT EXISTS (SELECT 1 FROM departments d WHERE d.name = v.name);
