// Parse an uploaded CAD per-size consumption sheet into normalized rows for
// pm_style_consumption. CAD per-size consumption is the fabric truth (owner, 2026-06-18).
//
// Expected (already header-normalized) row keys: style, fabric_type, size, consumption, unit.
// `size` may be a combined CAD label like "S / 26" — we keep the letter size (ecom space).

const LETTER_SIZES = ['XXXL', '4XL', '3XL', 'XXL', 'XS', 'XL', 'S', 'M', 'L'];

// Pull the canonical letter size out of a raw CAD label ("S / 26" -> "S"); if there's no
// recognizable letter size, fall back to the trimmed raw token.
function normalizeSize(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  const tokens = s.split(/[\/,|]/).map((t) => t.trim().toUpperCase()).filter(Boolean);
  for (const t of tokens) {
    if (LETTER_SIZES.includes(t)) return t;
  }
  // single token already a letter size?
  const up = s.toUpperCase();
  if (LETTER_SIZES.includes(up)) return up;
  return tokens[0] || up;
}

function parseConsumptionSheet(rawRows) {
  const rows = [];
  const errors = [];
  (rawRows || []).forEach((r, i) => {
    const style = String(r.style == null ? '' : r.style).trim();
    const size_label = normalizeSize(r.size);
    const consumption_per_piece = Number(r.consumption);
    const unit = String(r.unit == null ? '' : r.unit).trim().toUpperCase();
    const consumption_unit = unit === 'KG' ? 'KG' : 'METER';
    if (!style) { errors.push({ row: i + 1, error: 'missing style' }); return; }
    if (!size_label) { errors.push({ row: i + 1, error: 'missing size' }); return; }
    if (!isFinite(consumption_per_piece) || consumption_per_piece <= 0) {
      errors.push({ row: i + 1, error: 'invalid consumption' });
      return;
    }
    rows.push({
      style,
      fabric_type: String(r.fabric_type == null ? '' : r.fabric_type).trim() || null,
      size_label,
      consumption_per_piece,
      consumption_unit,
    });
  });
  return { rows, errors };
}

module.exports = { normalizeSize, parseConsumptionSheet, LETTER_SIZES };
