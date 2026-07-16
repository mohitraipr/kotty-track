// Lot-level dispatch allocation — pure helpers (no DB) for the one-card-per-lot
// dispatch flow. The route supplies the operator's finishing batches (FIFO by
// created_at) with per-size availability; these helpers aggregate them for the
// card and split a lot-level dispatch request back across the batches.
//
// A "size key" is the normalized label (trim+uppercase — same rule as
// utils/stageEvents.normalizeSizeLabel); display labels keep their first-seen form.

function normalize(label) {
  return String(label || '').trim().toUpperCase();
}

// batches: [{ finishing_data_id, sizes: [{ size_label, produced, dispatched, available }] }]
// → lot-level rows, FIFO first-seen order: [{ size_label, produced, dispatched, available }]
function aggregateLotSizes(batches) {
  const byKey = new Map();
  for (const b of batches || []) {
    for (const s of b.sizes || []) {
      const k = normalize(s.size_label);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, { size_label: String(s.size_label).trim(), produced: 0, dispatched: 0, available: 0 });
      const agg = byKey.get(k);
      agg.produced += Number(s.produced) || 0;
      agg.dispatched += Number(s.dispatched) || 0;
      agg.available += Number(s.available) || 0;
    }
  }
  return [...byKey.values()];
}

// Split a lot-level request across batches, oldest batch first (FIFO).
//   requested: [{ size_label, pieces }]
//   batches:   [{ finishing_data_id, sizes: [{ size_label, available }] }] in FIFO order
// Returns { rows: [{ finishing_data_id, size_label, pieces }] } — size_label is the
// batch's own display label (finishing_dispatches stores it as produced).
// Returns { error } if any size is unknown or asks for more than the lot has.
function allocateAcrossBatches(requested, batches) {
  const req = (Array.isArray(requested) ? requested : [])
    .map((s) => ({ key: normalize(s.size_label), label: String(s.size_label || '').trim(), pieces: Math.trunc(Number(s.pieces)) || 0 }))
    .filter((s) => s.key && s.pieces > 0);
  if (!req.length) return { error: 'No positive size quantities provided' };
  // Reject duplicate size labels in the request — ambiguity, not a merge.
  const seen = new Set();
  for (const s of req) {
    if (seen.has(s.key)) return { error: `Size ${s.label} appears more than once in the request` };
    seen.add(s.key);
  }

  const rows = [];
  for (const s of req) {
    let remaining = s.pieces;
    let lotAvailable = 0;
    for (const b of batches || []) {
      for (const bs of b.sizes || []) {
        if (normalize(bs.size_label) !== s.key) continue;
        const avail = Number(bs.available) || 0;
        lotAvailable += avail;
        if (remaining <= 0 || avail <= 0) continue;
        const take = Math.min(remaining, avail);
        rows.push({ finishing_data_id: b.finishing_data_id, size_label: String(bs.size_label).trim(), pieces: take });
        remaining -= take;
      }
    }
    if (lotAvailable === 0 && remaining > 0) return { error: `Size ${s.label} has nothing available to dispatch` };
    if (remaining > 0) return { error: `Size ${s.label}: only ${lotAvailable} pieces available to dispatch (requested ${s.pieces})` };
  }
  return { rows };
}

module.exports = { aggregateLotSizes, allocateAcrossBatches, normalize };
