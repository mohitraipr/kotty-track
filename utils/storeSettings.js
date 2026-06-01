// Shared access to the key/value `store_settings` table + the ad-hoc cutting switch.
// The DB pool is required lazily inside getStoreSetting so that importing the pure
// helpers (resolveAllowAdhoc/isKnownFabricType) for unit tests does not load config/db.

const ADHOC_KEY = 'allow_adhoc_cutting_entry';

// Reads a store_settings value; returns defaultValue on miss or error.
async function getStoreSetting(key, defaultValue = null) {
  try {
    const { pool } = require('../config/db');
    const [[row]] = await pool.query(
      'SELECT setting_value FROM store_settings WHERE setting_key = ?',
      [key]
    );
    return row ? row.setting_value : defaultValue;
  } catch {
    return defaultValue;
  }
}

// Coerce a stored string to a boolean. Fail-safe: only the literal 'true'
// (case-insensitive, trimmed) is true; everything else (incl. missing) is false.
function resolveAllowAdhoc(value) {
  return String(value == null ? '' : value).trim().toLowerCase() === 'true';
}

// Resolves the ad-hoc cutting switch to a boolean. Default OFF (false).
async function allowAdhocCuttingEntry() {
  const v = await getStoreSetting(ADHOC_KEY, 'false');
  return resolveAllowAdhoc(v);
}

function normalize(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// True if `type` matches one of knownTypes (case-insensitive, trimmed).
function isKnownFabricType(type, knownTypes) {
  const t = normalize(type);
  if (!t) return false;
  return (knownTypes || []).some((k) => normalize(k) === t);
}

module.exports = {
  ADHOC_KEY,
  getStoreSetting,
  resolveAllowAdhoc,
  allowAdhocCuttingEntry,
  isKnownFabricType,
};
