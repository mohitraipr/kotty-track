-- ─────────────────────────────────────────────────────────────────
-- Backfill historical *_data into *_events  (Cloud SQL Studio-safe)
--
-- Pure-SQL version. No stored procedures, no DELIMITER. Paste each
-- stage's 4 statements into Cloud SQL Studio and click Run for that
-- stage. Each stage is independent — run any subset in any order.
--
-- Idempotent. Each step uses NOT EXISTS so re-running is safe.
--
-- Marker convention: backfilled approve events carry a remark of the
-- form "BACKFILL:<stage>_data#<id>" so we can correlate them with the
-- original *_data rows for steps 2/3/4. The marker stays on the row
-- as audit trail.
-- ─────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════
-- STITCHING — paste these 4 statements together and Run
-- ═══════════════════════════════════════════════════════════════════

-- 1/4  Approve events
INSERT INTO stitching_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT cl.id, 'approve', NULL, sd.total_pieces, sd.user_id,
       CONCAT('BACKFILL:stitching_data#', sd.id), sd.created_at
FROM stitching_data sd
JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
WHERE NOT EXISTS (
  SELECT 1 FROM stitching_events se
  WHERE se.cutting_lot_id = cl.id
    AND se.operator_id = sd.user_id
    AND se.event_type = 'approve'
    AND se.pieces = sd.total_pieces
    AND se.created_at = sd.created_at
);

-- 2/4  Size rows for those approves
INSERT INTO stitching_event_sizes (event_id, size_label, pieces)
SELECT se.id, sds.size_label, sds.pieces
FROM stitching_events se
JOIN stitching_data_sizes sds
  ON sds.stitching_data_id = CAST(SUBSTRING_INDEX(se.remark, '#', -1) AS UNSIGNED)
WHERE se.event_type = 'approve'
  AND se.remark LIKE 'BACKFILL:stitching_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM stitching_event_sizes ses
    WHERE ses.event_id = se.id AND ses.size_label = sds.size_label
  );

-- 3/4  Complete events parented on the approves we just made
INSERT INTO stitching_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT se.cutting_lot_id, 'complete', se.id, se.pieces, se.operator_id,
       sd.remark, se.created_at
FROM stitching_events se
JOIN stitching_data sd
  ON sd.id = CAST(SUBSTRING_INDEX(se.remark, '#', -1) AS UNSIGNED)
WHERE se.event_type = 'approve'
  AND se.remark LIKE 'BACKFILL:stitching_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM stitching_events comp
    WHERE comp.parent_event_id = se.id AND comp.event_type = 'complete'
  );

-- 4/4  Size rows for the completes
INSERT INTO stitching_event_sizes (event_id, size_label, pieces)
SELECT comp.id, sds.size_label, sds.pieces
FROM stitching_events comp
JOIN stitching_events appr ON appr.id = comp.parent_event_id
JOIN stitching_data_sizes sds
  ON sds.stitching_data_id = CAST(SUBSTRING_INDEX(appr.remark, '#', -1) AS UNSIGNED)
WHERE comp.event_type = 'complete'
  AND appr.remark LIKE 'BACKFILL:stitching_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM stitching_event_sizes ses
    WHERE ses.event_id = comp.id AND ses.size_label = sds.size_label
  );

-- Sanity check (run after the 4 inserts):
SELECT 'stitching' AS stage,
       COUNT(*) FILTER (WHERE event_type='approve')  AS approves,
       COUNT(*) FILTER (WHERE event_type='complete') AS completes
FROM stitching_events
WHERE remark LIKE 'BACKFILL:stitching_data#%'
   OR parent_event_id IN (SELECT id FROM stitching_events WHERE remark LIKE 'BACKFILL:stitching_data#%');
-- If FILTER syntax errors on your MySQL version, use this equivalent:
--   SELECT 'stitching' AS stage,
--          SUM(event_type='approve')  AS approves,
--          SUM(event_type='complete') AS completes
--   FROM stitching_events;


-- ═══════════════════════════════════════════════════════════════════
-- JEANS ASSEMBLY
-- ═══════════════════════════════════════════════════════════════════

-- 1/4
INSERT INTO jeans_assembly_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT cl.id, 'approve', NULL, jad.total_pieces, jad.user_id,
       CONCAT('BACKFILL:jeans_assembly_data#', jad.id), jad.created_at
FROM jeans_assembly_data jad
JOIN cutting_lots cl ON cl.lot_no = jad.lot_no
WHERE NOT EXISTS (
  SELECT 1 FROM jeans_assembly_events je
  WHERE je.cutting_lot_id = cl.id
    AND je.operator_id = jad.user_id
    AND je.event_type = 'approve'
    AND je.pieces = jad.total_pieces
    AND je.created_at = jad.created_at
);

-- 2/4
INSERT INTO jeans_assembly_event_sizes (event_id, size_label, pieces)
SELECT je.id, jads.size_label, jads.pieces
FROM jeans_assembly_events je
JOIN jeans_assembly_data_sizes jads
  ON jads.jeans_assembly_data_id = CAST(SUBSTRING_INDEX(je.remark, '#', -1) AS UNSIGNED)
WHERE je.event_type = 'approve'
  AND je.remark LIKE 'BACKFILL:jeans_assembly_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM jeans_assembly_event_sizes jes
    WHERE jes.event_id = je.id AND jes.size_label = jads.size_label
  );

-- 3/4
INSERT INTO jeans_assembly_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT je.cutting_lot_id, 'complete', je.id, je.pieces, je.operator_id,
       jad.remark, je.created_at
FROM jeans_assembly_events je
JOIN jeans_assembly_data jad
  ON jad.id = CAST(SUBSTRING_INDEX(je.remark, '#', -1) AS UNSIGNED)
WHERE je.event_type = 'approve'
  AND je.remark LIKE 'BACKFILL:jeans_assembly_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM jeans_assembly_events comp
    WHERE comp.parent_event_id = je.id AND comp.event_type = 'complete'
  );

-- 4/4
INSERT INTO jeans_assembly_event_sizes (event_id, size_label, pieces)
SELECT comp.id, jads.size_label, jads.pieces
FROM jeans_assembly_events comp
JOIN jeans_assembly_events appr ON appr.id = comp.parent_event_id
JOIN jeans_assembly_data_sizes jads
  ON jads.jeans_assembly_data_id = CAST(SUBSTRING_INDEX(appr.remark, '#', -1) AS UNSIGNED)
WHERE comp.event_type = 'complete'
  AND appr.remark LIKE 'BACKFILL:jeans_assembly_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM jeans_assembly_event_sizes jes
    WHERE jes.event_id = comp.id AND jes.size_label = jads.size_label
  );


-- ═══════════════════════════════════════════════════════════════════
-- WASHING
-- ═══════════════════════════════════════════════════════════════════

-- 1/4
INSERT INTO washing_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT cl.id, 'approve', NULL, wd.total_pieces, wd.user_id,
       CONCAT('BACKFILL:washing_data#', wd.id), wd.created_at
FROM washing_data wd
JOIN cutting_lots cl ON cl.lot_no = wd.lot_no
WHERE NOT EXISTS (
  SELECT 1 FROM washing_events we
  WHERE we.cutting_lot_id = cl.id
    AND we.operator_id = wd.user_id
    AND we.event_type = 'approve'
    AND we.pieces = wd.total_pieces
    AND we.created_at = wd.created_at
);

-- 2/4
INSERT INTO washing_event_sizes (event_id, size_label, pieces)
SELECT we.id, wds.size_label, wds.pieces
FROM washing_events we
JOIN washing_data_sizes wds
  ON wds.washing_data_id = CAST(SUBSTRING_INDEX(we.remark, '#', -1) AS UNSIGNED)
WHERE we.event_type = 'approve'
  AND we.remark LIKE 'BACKFILL:washing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_event_sizes wes
    WHERE wes.event_id = we.id AND wes.size_label = wds.size_label
  );

-- 3/4
INSERT INTO washing_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT we.cutting_lot_id, 'complete', we.id, we.pieces, we.operator_id,
       wd.remark, we.created_at
FROM washing_events we
JOIN washing_data wd
  ON wd.id = CAST(SUBSTRING_INDEX(we.remark, '#', -1) AS UNSIGNED)
WHERE we.event_type = 'approve'
  AND we.remark LIKE 'BACKFILL:washing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_events comp
    WHERE comp.parent_event_id = we.id AND comp.event_type = 'complete'
  );

-- 4/4
INSERT INTO washing_event_sizes (event_id, size_label, pieces)
SELECT comp.id, wds.size_label, wds.pieces
FROM washing_events comp
JOIN washing_events appr ON appr.id = comp.parent_event_id
JOIN washing_data_sizes wds
  ON wds.washing_data_id = CAST(SUBSTRING_INDEX(appr.remark, '#', -1) AS UNSIGNED)
WHERE comp.event_type = 'complete'
  AND appr.remark LIKE 'BACKFILL:washing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_event_sizes wes
    WHERE wes.event_id = comp.id AND wes.size_label = wds.size_label
  );


-- ═══════════════════════════════════════════════════════════════════
-- WASHING IN
-- ═══════════════════════════════════════════════════════════════════

-- 1/4
INSERT INTO washing_in_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT cl.id, 'approve', NULL, wid.total_pieces, wid.user_id,
       CONCAT('BACKFILL:washing_in_data#', wid.id), wid.created_at
FROM washing_in_data wid
JOIN cutting_lots cl ON cl.lot_no = wid.lot_no
WHERE NOT EXISTS (
  SELECT 1 FROM washing_in_events wie
  WHERE wie.cutting_lot_id = cl.id
    AND wie.operator_id = wid.user_id
    AND wie.event_type = 'approve'
    AND wie.pieces = wid.total_pieces
    AND wie.created_at = wid.created_at
);

-- 2/4
INSERT INTO washing_in_event_sizes (event_id, size_label, pieces)
SELECT wie.id, wids.size_label, wids.pieces
FROM washing_in_events wie
JOIN washing_in_data_sizes wids
  ON wids.washing_in_data_id = CAST(SUBSTRING_INDEX(wie.remark, '#', -1) AS UNSIGNED)
WHERE wie.event_type = 'approve'
  AND wie.remark LIKE 'BACKFILL:washing_in_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_in_event_sizes wies
    WHERE wies.event_id = wie.id AND wies.size_label = wids.size_label
  );

-- 3/4
INSERT INTO washing_in_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT wie.cutting_lot_id, 'complete', wie.id, wie.pieces, wie.operator_id,
       wid.remark, wie.created_at
FROM washing_in_events wie
JOIN washing_in_data wid
  ON wid.id = CAST(SUBSTRING_INDEX(wie.remark, '#', -1) AS UNSIGNED)
WHERE wie.event_type = 'approve'
  AND wie.remark LIKE 'BACKFILL:washing_in_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_in_events comp
    WHERE comp.parent_event_id = wie.id AND comp.event_type = 'complete'
  );

-- 4/4
INSERT INTO washing_in_event_sizes (event_id, size_label, pieces)
SELECT comp.id, wids.size_label, wids.pieces
FROM washing_in_events comp
JOIN washing_in_events appr ON appr.id = comp.parent_event_id
JOIN washing_in_data_sizes wids
  ON wids.washing_in_data_id = CAST(SUBSTRING_INDEX(appr.remark, '#', -1) AS UNSIGNED)
WHERE comp.event_type = 'complete'
  AND appr.remark LIKE 'BACKFILL:washing_in_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM washing_in_event_sizes wies
    WHERE wies.event_id = comp.id AND wies.size_label = wids.size_label
  );


-- ═══════════════════════════════════════════════════════════════════
-- FINISHING
-- ═══════════════════════════════════════════════════════════════════

-- 1/4
INSERT INTO finishing_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT cl.id, 'approve', NULL, fd.total_pieces, fd.user_id,
       CONCAT('BACKFILL:finishing_data#', fd.id), fd.created_at
FROM finishing_data fd
JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
WHERE NOT EXISTS (
  SELECT 1 FROM finishing_events fe
  WHERE fe.cutting_lot_id = cl.id
    AND fe.operator_id = fd.user_id
    AND fe.event_type = 'approve'
    AND fe.pieces = fd.total_pieces
    AND fe.created_at = fd.created_at
);

-- 2/4
INSERT INTO finishing_event_sizes (event_id, size_label, pieces)
SELECT fe.id, fds.size_label, fds.pieces
FROM finishing_events fe
JOIN finishing_data_sizes fds
  ON fds.finishing_data_id = CAST(SUBSTRING_INDEX(fe.remark, '#', -1) AS UNSIGNED)
WHERE fe.event_type = 'approve'
  AND fe.remark LIKE 'BACKFILL:finishing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM finishing_event_sizes fes
    WHERE fes.event_id = fe.id AND fes.size_label = fds.size_label
  );

-- 3/4
INSERT INTO finishing_events
  (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
SELECT fe.cutting_lot_id, 'complete', fe.id, fe.pieces, fe.operator_id,
       fd.remark, fe.created_at
FROM finishing_events fe
JOIN finishing_data fd
  ON fd.id = CAST(SUBSTRING_INDEX(fe.remark, '#', -1) AS UNSIGNED)
WHERE fe.event_type = 'approve'
  AND fe.remark LIKE 'BACKFILL:finishing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM finishing_events comp
    WHERE comp.parent_event_id = fe.id AND comp.event_type = 'complete'
  );

-- 4/4
INSERT INTO finishing_event_sizes (event_id, size_label, pieces)
SELECT comp.id, fds.size_label, fds.pieces
FROM finishing_events comp
JOIN finishing_events appr ON appr.id = comp.parent_event_id
JOIN finishing_data_sizes fds
  ON fds.finishing_data_id = CAST(SUBSTRING_INDEX(appr.remark, '#', -1) AS UNSIGNED)
WHERE comp.event_type = 'complete'
  AND appr.remark LIKE 'BACKFILL:finishing_data#%'
  AND NOT EXISTS (
    SELECT 1 FROM finishing_event_sizes fes
    WHERE fes.event_id = comp.id AND fes.size_label = fds.size_label
  );


-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION (run after all 5 stages)
-- ═══════════════════════════════════════════════════════════════════

SELECT 'stitching'      AS stage,
       SUM(event_type='approve')  AS approves,
       SUM(event_type='complete') AS completes,
       SUM(event_type='reject')   AS rejects
  FROM stitching_events
UNION ALL
SELECT 'jeans_assembly',
       SUM(event_type='approve'),
       SUM(event_type='complete'),
       SUM(event_type='reject')
  FROM jeans_assembly_events
UNION ALL
SELECT 'washing',
       SUM(event_type='approve'),
       SUM(event_type='complete'),
       SUM(event_type='reject')
  FROM washing_events
UNION ALL
SELECT 'washing_in',
       SUM(event_type='approve'),
       SUM(event_type='complete'),
       SUM(event_type='reject')
  FROM washing_in_events
UNION ALL
SELECT 'finishing',
       SUM(event_type='approve'),
       SUM(event_type='complete'),
       SUM(event_type='reject')
  FROM finishing_events;
