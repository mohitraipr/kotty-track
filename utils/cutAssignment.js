// Build the record for a PM-approved cut assigned to a specific cutting master.
//
// Flow: PM views a style's suggested cut (utils/cutPlanner.planCut) -> picks a cutting
// master -> approves. This turns the demand + plan into a pm_cut_assignment header plus
// per-size lines the master will cut. CAD owns the marker; the master just cuts to these
// quantities. Pure (no DB) so the assembly/validation is unit-tested.

function buildAssignmentPayload({ style, fabricType, masterId, masterName, demand, plan, createdBy }) {
  if (!masterId) throw new Error('A cutting master must be selected (master required).');
  const sizes = Object.entries(demand || {})
    .map(([size_label, qty]) => ({ size_label, qty: Number(qty) || 0 }))
    .filter((s) => s.qty > 0)
    .sort((a, b) => b.qty - a.qty);
  if (!sizes.length) throw new Error('Nothing to cut — demand is empty.');

  const totalPieces = sizes.reduce((s, x) => s + x.qty, 0);
  const p = plan || {};
  return {
    header: {
      style: String(style || '').trim(),
      fabric_type: fabricType || null,
      assigned_master_id: masterId,
      assigned_master_name: masterName || null,
      total_pieces: totalPieces,
      lot_count: Number(p.lotCount) || 0,
      total_fabric_meters: p.totalFabricMeters == null ? null : Number(p.totalFabricMeters),
      fabric_complete: !!p.fabricComplete,
      created_by: createdBy || null,
      status: 'assigned',
    },
    sizes,
  };
}

module.exports = { buildAssignmentPayload };
