// Units master: the canonical unit-of-measure list for item types.
// Names are stored normalized (trimmed + uppercased) so 'pcs' and 'PCS' collapse to one.

function normalizeUnit(name) {
  return String(name == null ? '' : name).trim().toUpperCase();
}

// Creates + seeds the units table once per process (idempotent). Safe to call
// from any route so the table exists regardless of which page loads first.
let tableEnsured = false;
async function ensureUnitsTable(pool) {
  if (tableEnsured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS units (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`INSERT IGNORE INTO units (name) VALUES ('PCS'),('ROLL'),('CONE'),('GROSS'),('MTR')`);
  // Backfill any units already used in inventory (best-effort).
  try {
    await pool.query(`INSERT IGNORE INTO units (name)
      SELECT DISTINCT UPPER(TRIM(unit)) FROM goods_inventory
      WHERE unit IS NOT NULL AND TRIM(unit) <> ''`);
  } catch (_) { /* goods_inventory may be absent in some contexts */ }
  tableEnsured = true;
}

// Returns the list of known unit names, sorted.
async function getUnits(pool) {
  const [rows] = await pool.query('SELECT name FROM units ORDER BY name');
  return rows.map(r => r.name);
}

// Normalizes a unit and persists it (INSERT IGNORE) if non-empty.
// Returns the canonical (normalized) name, or '' for blank input.
async function ensureUnit(pool, name) {
  const u = normalizeUnit(name);
  if (!u) return '';
  await pool.query('INSERT IGNORE INTO units (name) VALUES (?)', [u]);
  return u;
}

module.exports = { normalizeUnit, getUnits, ensureUnit, ensureUnitsTable };
