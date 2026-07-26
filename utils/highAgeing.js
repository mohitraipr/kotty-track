// High-ageing cutting block — the single source of truth used by BOTH the
// /pm High Ageing tab and the cut-time block on create-lot.
// Design: docs/superpowers/specs/2026-07-26-high-ageing-cutting-block-design.md
//
// "High ageing" (style level): stock will take > THRESHOLD_DOC days to sell at the
// current rate (days-of-cover = SOH / DRR), or it has stock with ~no sales (dead).
// Auto-flagged styles are computed LIVE from the (cached) cut-recs — never persisted.
// The pm_cutting_blocklist table holds only human decisions: manual blocks + allow
// exceptions. Effective enforced set = (auto ∪ manual_block) − allow.

const { getStoreSetting, setStoreSetting } = require('./storeSettings');

const THRESHOLD_DOC = 90;                       // days of cover
const SETTING_KEY = 'high_ageing_block_enabled';

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────
// Aggregate per-size cut-rec rows (each { style, soh, drr, doh }) to per-style and
// flag the high-ageing ones. Returns [{ style, soh, drr, days_of_cover, dead }].
function flagHighAgeingStyles(rows, threshold = THRESHOLD_DOC) {
  const byStyle = new Map();
  for (const r of rows || []) {
    const style = String(r.style || '').trim().toUpperCase();
    if (!style) continue;
    let a = byStyle.get(style);
    if (!a) { a = { style, soh: 0, drr: 0 }; byStyle.set(style, a); }
    a.soh += Number(r.soh) || 0;
    a.drr += Number(r.drr) || 0;
  }
  const out = [];
  for (const a of byStyle.values()) {
    if (a.soh <= 0) continue;                    // nothing in stock → nothing to age
    const dead = a.drr <= 1e-9;                  // stock but ~zero sales
    const days_of_cover = dead ? Infinity : a.soh / a.drr;
    if (dead || days_of_cover > threshold) {
      out.push({ style: a.style, soh: a.soh, drr: a.drr, days_of_cover, dead });
    }
  }
  out.sort((x, y) => {
    const dx = x.days_of_cover === Infinity ? Number.MAX_VALUE : x.days_of_cover;
    const dy = y.days_of_cover === Infinity ? Number.MAX_VALUE : y.days_of_cover;
    return dy - dx;
  });
  return out;
}

// Split blocklist rows into manual-block and allow maps (keyed by upper style).
function partitionBlocklist(rows) {
  const manual = new Map();
  const allow = new Map();
  for (const r of rows || []) {
    const s = String(r.style || '').trim().toUpperCase();
    if (!s) continue;
    if (r.mode === 'manual_block') manual.set(s, r);
    else if (r.mode === 'allow') allow.set(s, r);
  }
  return { manual, allow };
}

// Human-readable reason for an auto-flagged style.
function autoReason(a) {
  return a.dead
    ? 'high-ageing (stock on hand with no recent sales)'
    : `high-ageing (${Math.round(a.days_of_cover)} days of cover)`;
}

// Compose the effective enforced set from the flagged styles + blocklist rows.
// Returns Map<style, { reason, source }>.
function computeEffective(flagged, rows) {
  const { manual, allow } = partitionBlocklist(rows);
  const map = new Map();
  for (const a of flagged) {
    if (!allow.has(a.style)) map.set(a.style, { reason: autoReason(a), source: 'Auto' });
  }
  for (const [s, r] of manual) {
    if (!allow.has(s)) map.set(s, { reason: r.reason || 'manually blocked from cutting', source: 'Manual' });
  }
  return map;
}

// ── DB-touching functions ───────────────────────────────────────────────────
async function computeHighAgeingStyles(pool) {
  const analytics = require('./easyecomAnalytics');
  const rows = await analytics.getCuttingRecommendations(pool, { periodKey: '30d' });
  return flagHighAgeingStyles(rows);
}

async function loadBlocklistRows(pool) {
  const [rows] = await pool.query(
    'SELECT style, mode, reason, created_by_name, updated_at FROM pm_cutting_blocklist');
  return rows;
}

async function isBlockEnforced(pool) {
  const v = await getStoreSetting(SETTING_KEY, 'true');
  return String(v == null ? '' : v).trim().toLowerCase() === 'true';
}

async function setBlockEnforced(pool, enabled) {
  await setStoreSetting(SETTING_KEY, enabled ? 'true' : 'false');
}

// The cut-time gate. Blocked only when enforcement is ON and the style is in the
// effective set. Returns { blocked, reason }.
async function isStyleBlocked(pool, style) {
  const s = String(style || '').trim().toUpperCase();
  if (!s) return { blocked: false };
  if (!(await isBlockEnforced(pool))) return { blocked: false };
  const [flagged, rows] = await Promise.all([computeHighAgeingStyles(pool), loadBlocklistRows(pool)]);
  const hit = computeEffective(flagged, rows).get(s);
  if (!hit) return { blocked: false };
  return {
    blocked: true,
    reason: `${s} is ${hit.reason} and is blocked from cutting. Ask production planning to allow it.`,
  };
}

// The tab view: every style that is auto-flagged or manually blocked, with status.
async function getHighAgeingView(pool) {
  const [flagged, rows, enforced] = await Promise.all([
    computeHighAgeingStyles(pool), loadBlocklistRows(pool), isBlockEnforced(pool),
  ]);
  const { manual, allow } = partitionBlocklist(rows);
  const byStyle = new Map();
  for (const a of flagged) {
    byStyle.set(a.style, {
      style: a.style, soh: a.soh, drr: Number(a.drr.toFixed(2)),
      days_of_cover: a.days_of_cover === Infinity ? null : Math.round(a.days_of_cover),
      dead: a.dead, source: 'Auto', reason: autoReason(a),
    });
  }
  for (const [s, r] of manual) {
    if (!byStyle.has(s)) {
      byStyle.set(s, {
        style: s, soh: null, drr: null, days_of_cover: null, dead: false,
        source: 'Manual', reason: r.reason || 'manually blocked',
      });
    }
  }
  const styles = [...byStyle.values()].map((x) => ({
    ...x, status: allow.has(x.style) ? 'Allowed' : 'Blocked',
  }));
  return { enforced, threshold: THRESHOLD_DOC, styles };
}

// Mutations (used by the tab endpoints).
async function upsertDecision(pool, style, mode, reason, user) {
  const s = String(style || '').trim().toUpperCase();
  if (!s) throw new Error('Style is required.');
  if (mode !== 'manual_block' && mode !== 'allow') throw new Error('Invalid mode.');
  await pool.query(
    `INSERT INTO pm_cutting_blocklist (style, mode, reason, created_by, created_by_name)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE mode=VALUES(mode), reason=VALUES(reason),
       created_by=VALUES(created_by), created_by_name=VALUES(created_by_name),
       updated_at=CURRENT_TIMESTAMP`,
    [s, mode, reason || null, user?.id || null, user?.username || null]);
  return s;
}

async function removeDecision(pool, style, mode) {
  const s = String(style || '').trim().toUpperCase();
  await pool.query('DELETE FROM pm_cutting_blocklist WHERE style=? AND mode=?', [s, mode]);
  return s;
}

module.exports = {
  THRESHOLD_DOC,
  // pure
  flagHighAgeingStyles, partitionBlocklist, computeEffective, autoReason,
  // db
  computeHighAgeingStyles, getHighAgeingView, isStyleBlocked,
  isBlockEnforced, setBlockEnforced, upsertDecision, removeDecision,
};
