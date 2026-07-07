-- Fabric width (inches) the CAD marker / consumption figure was derived at.
--
-- Reference metadata, NOT an input to the fabric-needed calc:
--   * When consumption is a per-piece WEIGHT (consumption_unit='KG'), the weight of fabric
--     in one garment = pattern area x GSM, which is independent of the roll width. So the
--     fabric-needed math (sum(qty x consumption_per_piece)) works without width.
--   * Width only changes per-piece LENGTH (consumption_unit='METER'): a wider roll fits more
--     pieces across the marker, so fewer running metres per piece. A metre figure is only
--     valid at the width it was markered on.
-- We store width so we can (a) validate the roll being cut is the width the CAD assumed,
-- (b) later convert KG<->METER (needs GSM too), and (c) keep the CAD input for audit.
ALTER TABLE pm_style_consumption
  ADD COLUMN width DECIMAL(6,2) NULL AFTER fabric_type;
