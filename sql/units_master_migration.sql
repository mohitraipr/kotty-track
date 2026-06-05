-- Units master table: the canonical unit-of-measure list for item types.
-- Also applied at runtime in routes/indentRoutes.js ensureMigration().

CREATE TABLE IF NOT EXISTS units (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed the previously-hardcoded units.
INSERT IGNORE INTO units (name) VALUES ('PCS'), ('ROLL'), ('CONE'), ('GROSS'), ('MTR');

-- Backfill any units already present in inventory so nothing is lost.
INSERT IGNORE INTO units (name)
SELECT DISTINCT UPPER(TRIM(unit))
FROM goods_inventory
WHERE unit IS NOT NULL AND TRIM(unit) <> '';
