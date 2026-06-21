'use strict';

// Bucket label for a 'YYYY-MM-DD' date. weekly → the Monday (YYYY-MM-DD) of that
// week; monthly → 'YYYY-MM'; daily → the date itself. (Monday-keyed weeks avoid
// ISO week-number edge cases and sort lexically = chronologically.)
function trendBucketKey(ymd, granularity) {
  if (granularity === 'monthly') return String(ymd).slice(0, 7);
  if (granularity === 'weekly') {
    const d = new Date(ymd + 'T00:00:00Z');
    const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
    d.setUTCDate(d.getUTCDate() - offset);
    return d.toISOString().slice(0, 10);
  }
  return String(ymd);
}

// salesDaily/invDaily: [{date:'YYYY-MM-DD', qty}], chronological. Sales summed per
// bucket; inventory = last (latest-date) value per bucket. Both returned sorted by
// bucket label (lexical == chronological for these key formats).
function buildTrendBuckets({ salesDaily, invDaily, granularity }) {
  const gran = ['daily', 'weekly', 'monthly'].includes(granularity) ? granularity : 'daily';
  const salesMap = new Map();
  for (const r of (salesDaily || [])) {
    const k = trendBucketKey(r.date, gran);
    salesMap.set(k, (salesMap.get(k) || 0) + (Number(r.qty) || 0));
  }
  const invMap = new Map();
  for (const r of (invDaily || [])) {
    // input is chronological → later dates overwrite, so the latest value per bucket wins
    invMap.set(trendBucketKey(r.date, gran), Number(r.qty) || 0);
  }
  const toSorted = (m) => [...m.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([bucket, qty]) => ({ bucket, qty }));
  return { sales: toSorted(salesMap), inventory: toSorted(invMap) };
}

module.exports = { trendBucketKey, buildTrendBuckets };
