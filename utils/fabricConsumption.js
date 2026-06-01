// Pure transforms for the fabric-manager consumption analysis page.
// Input rows come from SQL (cutting_lot_rolls joined to cutting_lots + users).
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// rows: [{ fabric_type, lot_no, sku, created_at, cutter, cutting_lot_id, roll_no, full_weight, weight_used, remaining_weight }]
function groupConsumptionByFabricType(rows) {
  const byType = new Map();
  for (const r of rows) {
    const ft = r.fabric_type || '(none)';
    if (!byType.has(ft)) byType.set(ft, { fabricType: ft, totalUsed: 0, lots: new Map() });
    const g = byType.get(ft);
    g.totalUsed += Number(r.weight_used) || 0;
    if (!g.lots.has(r.cutting_lot_id)) {
      g.lots.set(r.cutting_lot_id, {
        lotNo: r.lot_no, sku: r.sku, createdAt: r.created_at, cutter: r.cutter, totalUsed: 0, rolls: [],
      });
    }
    const lot = g.lots.get(r.cutting_lot_id);
    lot.totalUsed += Number(r.weight_used) || 0;
    lot.rolls.push({
      rollNo: r.roll_no,
      full: round2(r.full_weight),
      used: round2(r.weight_used),
      remaining: round2(r.remaining_weight),
    });
  }
  return [...byType.values()].map(g => {
    const lots = [...g.lots.values()].map(l => ({ ...l, totalUsed: round2(l.totalUsed) }));
    return {
      fabricType: g.fabricType,
      totalUsed: round2(g.totalUsed),
      lotCount: lots.length,
      rollCount: lots.reduce((n, l) => n + l.rolls.length, 0),
      lots,
    };
  });
}

// masterRows: [{ roll_no, fabric_type, vendor_name, per_roll_weight, unit }]
function buildRollLedger(consumptionRows, masterRows) {
  const master = new Map((masterRows || []).map(m => [m.roll_no, m]));
  const byRoll = new Map();
  for (const r of consumptionRows) {
    if (!byRoll.has(r.roll_no)) {
      const m = master.get(r.roll_no);
      byRoll.set(r.roll_no, {
        rollNo: r.roll_no,
        fabricType: (m && m.fabric_type) || r.fabric_type || '(none)',
        vendor: (m && m.vendor_name) || '(ad-hoc)',
        currentAvailable: m ? round2(m.per_roll_weight) : null,
        unit: (m && m.unit) || '',
        totalUsed: 0,
        lots: [],
      });
    }
    const e = byRoll.get(r.roll_no);
    e.totalUsed += Number(r.weight_used) || 0;
    e.lots.push(r.lot_no);
  }
  return [...byRoll.values()].map(e => ({
    ...e,
    totalUsed: round2(e.totalUsed),
    lots: [...new Set(e.lots)],
  }));
}

function findAdHocRolls(consumptionRows, masterRollNos) {
  const set = new Set(masterRollNos || []);
  const out = new Map();
  for (const r of consumptionRows) {
    if (set.has(r.roll_no)) continue;
    const key = r.roll_no + '|' + r.cutting_lot_id;
    if (!out.has(key)) {
      out.set(key, {
        rollNo: r.roll_no,
        fabricType: r.fabric_type || '(none)',
        full: round2(r.full_weight),
        used: round2(r.weight_used),
        lotNo: r.lot_no,
        cutter: r.cutter,
      });
    }
  }
  return [...out.values()];
}

function findAdHocFabricTypes(lotFabricTypes, masterFabricTypes) {
  const master = new Set((masterFabricTypes || []).map(s => (s || '').toLowerCase().trim()));
  const seen = new Set();
  const out = [];
  for (const ft of lotFabricTypes || []) {
    if (!ft) continue;
    const key = ft.toLowerCase().trim();
    if (master.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(ft);
  }
  return out;
}

module.exports = {
  round2,
  groupConsumptionByFabricType,
  buildRollLedger,
  findAdHocRolls,
  findAdHocFabricTypes,
};
