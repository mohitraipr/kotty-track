-- ─────────────────────────────────────────────────────────────────────
-- Stage Quantity Reconciliation (READ-ONLY diagnostic)
--
-- Confirms the "cutting = 10 but stitching = 20" class of bug: a lot whose
-- piece total at a DOWNSTREAM stage exceeds the cutting ceiling.
--
-- Canonical total per (lot, stage):
--   = SUM(<stage>_event_sizes.pieces) for event_type='complete'  (preferred)
--   = SUM(<stage>_data_sizes.pieces)                             (legacy fallback)
-- Cutting baseline = SUM(cutting_lot_sizes.total_pieces).
--
-- Query 1 — cross-stage offenders (a stage total > cutting ceiling).
-- Query 2 — denormalized drift  (*_data.total_pieces != SUM(*_data_sizes)).
-- Query 3 — duplicate legacy rows (same lot, identical size breakdown twice).
--
-- Pure SELECTs. Safe to run on prod. Requires MySQL 8 (CTEs).
-- ─────────────────────────────────────────────────────────────────────

-- ─── Query 1: cross-stage offenders ──────────────────────────────────
WITH cut AS (
  SELECT cl.id AS cutting_lot_id, cl.lot_no, cl.lot_type,
         COALESCE((SELECT SUM(cls.total_pieces) FROM cutting_lot_sizes cls
                   WHERE cls.cutting_lot_id = cl.id), 0) AS cut_pcs
  FROM cutting_lots cl
),
st_leg AS (SELECT d.lot_no, SUM(s.pieces) sz FROM stitching_data d JOIN stitching_data_sizes s ON s.stitching_data_id=d.id GROUP BY d.lot_no),
st_ev  AS (SELECT cl.lot_no, SUM(es.pieces) sz FROM stitching_event_sizes es JOIN stitching_events e ON e.id=es.event_id JOIN cutting_lots cl ON cl.id=e.cutting_lot_id WHERE e.event_type='complete' GROUP BY cl.lot_no),
as_leg AS (SELECT d.lot_no, SUM(s.pieces) sz FROM jeans_assembly_data d JOIN jeans_assembly_data_sizes s ON s.jeans_assembly_data_id=d.id GROUP BY d.lot_no),
as_ev  AS (SELECT cl.lot_no, SUM(es.pieces) sz FROM jeans_assembly_event_sizes es JOIN jeans_assembly_events e ON e.id=es.event_id JOIN cutting_lots cl ON cl.id=e.cutting_lot_id WHERE e.event_type='complete' GROUP BY cl.lot_no),
wa_leg AS (SELECT d.lot_no, SUM(s.pieces) sz FROM washing_data d JOIN washing_data_sizes s ON s.washing_data_id=d.id GROUP BY d.lot_no),
wa_ev  AS (SELECT cl.lot_no, SUM(es.pieces) sz FROM washing_event_sizes es JOIN washing_events e ON e.id=es.event_id JOIN cutting_lots cl ON cl.id=e.cutting_lot_id WHERE e.event_type='complete' GROUP BY cl.lot_no),
wi_leg AS (SELECT d.lot_no, SUM(s.pieces) sz FROM washing_in_data d JOIN washing_in_data_sizes s ON s.washing_in_data_id=d.id GROUP BY d.lot_no),
wi_ev  AS (SELECT cl.lot_no, SUM(es.pieces) sz FROM washing_in_event_sizes es JOIN washing_in_events e ON e.id=es.event_id JOIN cutting_lots cl ON cl.id=e.cutting_lot_id WHERE e.event_type='complete' GROUP BY cl.lot_no),
fi_leg AS (SELECT d.lot_no, SUM(s.pieces) sz FROM finishing_data d JOIN finishing_data_sizes s ON s.finishing_data_id=d.id GROUP BY d.lot_no),
fi_ev  AS (SELECT cl.lot_no, SUM(es.pieces) sz FROM finishing_event_sizes es JOIN finishing_events e ON e.id=es.event_id JOIN cutting_lots cl ON cl.id=e.cutting_lot_id WHERE e.event_type='complete' GROUP BY cl.lot_no)
SELECT c.lot_no, c.lot_type, c.cut_pcs,
       COALESCE(st_ev.sz, st_leg.sz) AS stitch_pcs,
       COALESCE(as_ev.sz, as_leg.sz) AS assembly_pcs,
       COALESCE(wa_ev.sz, wa_leg.sz) AS washing_pcs,
       COALESCE(wi_ev.sz, wi_leg.sz) AS washing_in_pcs,
       COALESCE(fi_ev.sz, fi_leg.sz) AS finishing_pcs
FROM cut c
LEFT JOIN st_leg ON st_leg.lot_no=c.lot_no LEFT JOIN st_ev ON st_ev.lot_no=c.lot_no
LEFT JOIN as_leg ON as_leg.lot_no=c.lot_no LEFT JOIN as_ev ON as_ev.lot_no=c.lot_no
LEFT JOIN wa_leg ON wa_leg.lot_no=c.lot_no LEFT JOIN wa_ev ON wa_ev.lot_no=c.lot_no
LEFT JOIN wi_leg ON wi_leg.lot_no=c.lot_no LEFT JOIN wi_ev ON wi_ev.lot_no=c.lot_no
LEFT JOIN fi_leg ON fi_leg.lot_no=c.lot_no LEFT JOIN fi_ev ON fi_ev.lot_no=c.lot_no
WHERE c.cut_pcs > 0
  AND ( COALESCE(st_ev.sz, st_leg.sz) > c.cut_pcs + 0.5
     OR COALESCE(as_ev.sz, as_leg.sz) > c.cut_pcs + 0.5
     OR COALESCE(wa_ev.sz, wa_leg.sz) > c.cut_pcs + 0.5
     OR COALESCE(wi_ev.sz, wi_leg.sz) > c.cut_pcs + 0.5
     OR COALESCE(fi_ev.sz, fi_leg.sz) > c.cut_pcs + 0.5 )
ORDER BY GREATEST(
   COALESCE(st_ev.sz, st_leg.sz, 0), COALESCE(as_ev.sz, as_leg.sz, 0),
   COALESCE(wa_ev.sz, wa_leg.sz, 0), COALESCE(wi_ev.sz, wi_leg.sz, 0),
   COALESCE(fi_ev.sz, fi_leg.sz, 0)) - c.cut_pcs DESC;

-- ─── Query 2: denormalized drift (total_pieces != SUM of size rows) ───
-- Run per stage; example for stitching (repeat for the other *_data tables):
-- SELECT d.id, d.lot_no, d.user_id, d.total_pieces,
--        (SELECT SUM(pieces) FROM stitching_data_sizes WHERE stitching_data_id=d.id) AS sizes_sum
-- FROM stitching_data d
-- HAVING ABS(d.total_pieces - sizes_sum) > 0.5;

-- ─── Query 3: duplicate legacy rows (same lot, identical breakdown) ───
-- SELECT lot_no, COUNT(*) n_rows, GROUP_CONCAT(id) ids, SUM(total_pieces) tot
-- FROM stitching_data GROUP BY lot_no HAVING n_rows > 1;
