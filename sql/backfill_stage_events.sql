-- ─────────────────────────────────────────────────────────────────
-- Backfill historical *_data into *_events for all five stages.
--
-- For every existing *_data row that has NO matching event yet, we
-- create paired (approve, complete) events in *_events with the same
-- size breakdown copied into *_event_sizes. Pieces are mirrored —
-- the old "submit auto-approves" model meant submit = receive AND
-- complete in one shot, so approved == completed for these rows.
--
-- Idempotent: each procedure only inserts when no event exists for
-- that (cutting_lot_id, operator_id, created_at) combination, so it's
-- safe to re-run.
--
-- HOW TO RUN
--   1. Paste this entire file into Cloud SQL Studio, click Run.
--      That CREATES the five stored procedures.
--   2. In a fresh query tab, run:
--         CALL backfill_stitching_events();
--         CALL backfill_jeans_assembly_events();
--         CALL backfill_washing_events();
--         CALL backfill_washing_in_events();
--         CALL backfill_finishing_events();
--   3. Each call returns a summary row { rows_inserted } so you know
--      how many *_data rows were ported in each stage.
--   4. Drop the procedures afterwards if you like:
--         DROP PROCEDURE backfill_stitching_events;
--         (etc.)
-- ─────────────────────────────────────────────────────────────────

DROP PROCEDURE IF EXISTS backfill_stitching_events;
DROP PROCEDURE IF EXISTS backfill_jeans_assembly_events;
DROP PROCEDURE IF EXISTS backfill_washing_events;
DROP PROCEDURE IF EXISTS backfill_washing_in_events;
DROP PROCEDURE IF EXISTS backfill_finishing_events;

DELIMITER $$

-- ─── stitching ────────────────────────────────────────────────────
CREATE PROCEDURE backfill_stitching_events()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_data_id INT;
  DECLARE v_lot_no VARCHAR(100);
  DECLARE v_user_id INT;
  DECLARE v_total INT;
  DECLARE v_remark TEXT;
  DECLARE v_created_at DATETIME;
  DECLARE v_cutting_lot_id INT;
  DECLARE v_approve_id INT;
  DECLARE v_complete_id INT;
  DECLARE v_inserted INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT sd.id, sd.lot_no, sd.user_id, sd.total_pieces, sd.remark, sd.created_at
    FROM stitching_data sd
    JOIN cutting_lots cl ON cl.lot_no = sd.lot_no
    WHERE NOT EXISTS (
      SELECT 1 FROM stitching_events se
      WHERE se.cutting_lot_id = cl.id
        AND se.operator_id = sd.user_id
        AND se.event_type = 'approve'
        AND se.created_at = sd.created_at
        AND se.pieces = sd.total_pieces
    );
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_data_id, v_lot_no, v_user_id, v_total, v_remark, v_created_at;
    IF done THEN LEAVE read_loop; END IF;

    SELECT id INTO v_cutting_lot_id FROM cutting_lots WHERE lot_no = v_lot_no LIMIT 1;
    IF v_cutting_lot_id IS NULL THEN ITERATE read_loop; END IF;

    INSERT INTO stitching_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'approve', NULL, v_total, v_user_id,
       CONCAT('Backfilled from stitching_data #', v_data_id), v_created_at);
    SET v_approve_id = LAST_INSERT_ID();

    INSERT INTO stitching_event_sizes (event_id, size_label, pieces)
    SELECT v_approve_id, size_label, pieces
    FROM stitching_data_sizes WHERE stitching_data_id = v_data_id;

    INSERT INTO stitching_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'complete', v_approve_id, v_total, v_user_id,
       v_remark, v_created_at);
    SET v_complete_id = LAST_INSERT_ID();

    INSERT INTO stitching_event_sizes (event_id, size_label, pieces)
    SELECT v_complete_id, size_label, pieces
    FROM stitching_data_sizes WHERE stitching_data_id = v_data_id;

    SET v_inserted = v_inserted + 1;
  END LOOP;
  CLOSE cur;

  SELECT v_inserted AS rows_inserted, 'stitching' AS stage;
END$$

-- ─── jeans assembly ───────────────────────────────────────────────
CREATE PROCEDURE backfill_jeans_assembly_events()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_data_id, v_user_id, v_total, v_cutting_lot_id, v_approve_id, v_complete_id INT;
  DECLARE v_lot_no VARCHAR(100);
  DECLARE v_remark TEXT;
  DECLARE v_created_at DATETIME;
  DECLARE v_inserted INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT jad.id, jad.lot_no, jad.user_id, jad.total_pieces, jad.remark, jad.created_at
    FROM jeans_assembly_data jad
    JOIN cutting_lots cl ON cl.lot_no = jad.lot_no
    WHERE NOT EXISTS (
      SELECT 1 FROM jeans_assembly_events je
      WHERE je.cutting_lot_id = cl.id
        AND je.operator_id = jad.user_id
        AND je.event_type = 'approve'
        AND je.created_at = jad.created_at
        AND je.pieces = jad.total_pieces
    );
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_data_id, v_lot_no, v_user_id, v_total, v_remark, v_created_at;
    IF done THEN LEAVE read_loop; END IF;

    SELECT id INTO v_cutting_lot_id FROM cutting_lots WHERE lot_no = v_lot_no LIMIT 1;
    IF v_cutting_lot_id IS NULL THEN ITERATE read_loop; END IF;

    INSERT INTO jeans_assembly_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'approve', NULL, v_total, v_user_id,
       CONCAT('Backfilled from jeans_assembly_data #', v_data_id), v_created_at);
    SET v_approve_id = LAST_INSERT_ID();

    INSERT INTO jeans_assembly_event_sizes (event_id, size_label, pieces)
    SELECT v_approve_id, size_label, pieces
    FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = v_data_id;

    INSERT INTO jeans_assembly_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'complete', v_approve_id, v_total, v_user_id,
       v_remark, v_created_at);
    SET v_complete_id = LAST_INSERT_ID();

    INSERT INTO jeans_assembly_event_sizes (event_id, size_label, pieces)
    SELECT v_complete_id, size_label, pieces
    FROM jeans_assembly_data_sizes WHERE jeans_assembly_data_id = v_data_id;

    SET v_inserted = v_inserted + 1;
  END LOOP;
  CLOSE cur;

  SELECT v_inserted AS rows_inserted, 'jeans_assembly' AS stage;
END$$

-- ─── washing ──────────────────────────────────────────────────────
CREATE PROCEDURE backfill_washing_events()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_data_id, v_user_id, v_total, v_cutting_lot_id, v_approve_id, v_complete_id INT;
  DECLARE v_lot_no VARCHAR(100);
  DECLARE v_remark TEXT;
  DECLARE v_created_at DATETIME;
  DECLARE v_inserted INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT wd.id, wd.lot_no, wd.user_id, wd.total_pieces, wd.remark, wd.created_at
    FROM washing_data wd
    JOIN cutting_lots cl ON cl.lot_no = wd.lot_no
    WHERE NOT EXISTS (
      SELECT 1 FROM washing_events we
      WHERE we.cutting_lot_id = cl.id
        AND we.operator_id = wd.user_id
        AND we.event_type = 'approve'
        AND we.created_at = wd.created_at
        AND we.pieces = wd.total_pieces
    );
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_data_id, v_lot_no, v_user_id, v_total, v_remark, v_created_at;
    IF done THEN LEAVE read_loop; END IF;

    SELECT id INTO v_cutting_lot_id FROM cutting_lots WHERE lot_no = v_lot_no LIMIT 1;
    IF v_cutting_lot_id IS NULL THEN ITERATE read_loop; END IF;

    INSERT INTO washing_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'approve', NULL, v_total, v_user_id,
       CONCAT('Backfilled from washing_data #', v_data_id), v_created_at);
    SET v_approve_id = LAST_INSERT_ID();

    INSERT INTO washing_event_sizes (event_id, size_label, pieces)
    SELECT v_approve_id, size_label, pieces
    FROM washing_data_sizes WHERE washing_data_id = v_data_id;

    INSERT INTO washing_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'complete', v_approve_id, v_total, v_user_id,
       v_remark, v_created_at);
    SET v_complete_id = LAST_INSERT_ID();

    INSERT INTO washing_event_sizes (event_id, size_label, pieces)
    SELECT v_complete_id, size_label, pieces
    FROM washing_data_sizes WHERE washing_data_id = v_data_id;

    SET v_inserted = v_inserted + 1;
  END LOOP;
  CLOSE cur;

  SELECT v_inserted AS rows_inserted, 'washing' AS stage;
END$$

-- ─── washing_in ───────────────────────────────────────────────────
CREATE PROCEDURE backfill_washing_in_events()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_data_id, v_user_id, v_total, v_cutting_lot_id, v_approve_id, v_complete_id INT;
  DECLARE v_lot_no VARCHAR(100);
  DECLARE v_remark TEXT;
  DECLARE v_created_at DATETIME;
  DECLARE v_inserted INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT wid.id, wid.lot_no, wid.user_id, wid.total_pieces, wid.remark, wid.created_at
    FROM washing_in_data wid
    JOIN cutting_lots cl ON cl.lot_no = wid.lot_no
    WHERE NOT EXISTS (
      SELECT 1 FROM washing_in_events wie
      WHERE wie.cutting_lot_id = cl.id
        AND wie.operator_id = wid.user_id
        AND wie.event_type = 'approve'
        AND wie.created_at = wid.created_at
        AND wie.pieces = wid.total_pieces
    );
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_data_id, v_lot_no, v_user_id, v_total, v_remark, v_created_at;
    IF done THEN LEAVE read_loop; END IF;

    SELECT id INTO v_cutting_lot_id FROM cutting_lots WHERE lot_no = v_lot_no LIMIT 1;
    IF v_cutting_lot_id IS NULL THEN ITERATE read_loop; END IF;

    INSERT INTO washing_in_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'approve', NULL, v_total, v_user_id,
       CONCAT('Backfilled from washing_in_data #', v_data_id), v_created_at);
    SET v_approve_id = LAST_INSERT_ID();

    INSERT INTO washing_in_event_sizes (event_id, size_label, pieces)
    SELECT v_approve_id, size_label, pieces
    FROM washing_in_data_sizes WHERE washing_in_data_id = v_data_id;

    INSERT INTO washing_in_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'complete', v_approve_id, v_total, v_user_id,
       v_remark, v_created_at);
    SET v_complete_id = LAST_INSERT_ID();

    INSERT INTO washing_in_event_sizes (event_id, size_label, pieces)
    SELECT v_complete_id, size_label, pieces
    FROM washing_in_data_sizes WHERE washing_in_data_id = v_data_id;

    SET v_inserted = v_inserted + 1;
  END LOOP;
  CLOSE cur;

  SELECT v_inserted AS rows_inserted, 'washing_in' AS stage;
END$$

-- ─── finishing ────────────────────────────────────────────────────
CREATE PROCEDURE backfill_finishing_events()
BEGIN
  DECLARE done INT DEFAULT 0;
  DECLARE v_data_id, v_user_id, v_total, v_cutting_lot_id, v_approve_id, v_complete_id INT;
  DECLARE v_lot_no VARCHAR(100);
  DECLARE v_remark TEXT;
  DECLARE v_created_at DATETIME;
  DECLARE v_inserted INT DEFAULT 0;

  DECLARE cur CURSOR FOR
    SELECT fd.id, fd.lot_no, fd.user_id, fd.total_pieces, fd.remark, fd.created_at
    FROM finishing_data fd
    JOIN cutting_lots cl ON cl.lot_no = fd.lot_no
    WHERE NOT EXISTS (
      SELECT 1 FROM finishing_events fe
      WHERE fe.cutting_lot_id = cl.id
        AND fe.operator_id = fd.user_id
        AND fe.event_type = 'approve'
        AND fe.created_at = fd.created_at
        AND fe.pieces = fd.total_pieces
    );
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;

  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO v_data_id, v_lot_no, v_user_id, v_total, v_remark, v_created_at;
    IF done THEN LEAVE read_loop; END IF;

    SELECT id INTO v_cutting_lot_id FROM cutting_lots WHERE lot_no = v_lot_no LIMIT 1;
    IF v_cutting_lot_id IS NULL THEN ITERATE read_loop; END IF;

    INSERT INTO finishing_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'approve', NULL, v_total, v_user_id,
       CONCAT('Backfilled from finishing_data #', v_data_id), v_created_at);
    SET v_approve_id = LAST_INSERT_ID();

    INSERT INTO finishing_event_sizes (event_id, size_label, pieces)
    SELECT v_approve_id, size_label, pieces
    FROM finishing_data_sizes WHERE finishing_data_id = v_data_id;

    INSERT INTO finishing_events
      (cutting_lot_id, event_type, parent_event_id, pieces, operator_id, remark, created_at)
    VALUES
      (v_cutting_lot_id, 'complete', v_approve_id, v_total, v_user_id,
       v_remark, v_created_at);
    SET v_complete_id = LAST_INSERT_ID();

    INSERT INTO finishing_event_sizes (event_id, size_label, pieces)
    SELECT v_complete_id, size_label, pieces
    FROM finishing_data_sizes WHERE finishing_data_id = v_data_id;

    SET v_inserted = v_inserted + 1;
  END LOOP;
  CLOSE cur;

  SELECT v_inserted AS rows_inserted, 'finishing' AS stage;
END$$

DELIMITER ;
