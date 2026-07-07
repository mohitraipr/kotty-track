// Pure safety guard: is it safe to change a lot's denim/hosiery flow_type given how far it
// has already progressed?
//
// Denim and hosiery share cutting + stitching, then diverge:
//   denim:   … stitching → jeans_assembly → washing → washing_in → finishing
//   hosiery: … stitching → finishing
// Once a lot has events in a divergent stage (jeans_assembly / washing / washing_in), or in
// finishing (whose UPSTREAM differs by flow), switching flow_type would orphan that stage's
// data and flip which worker gets paid at the next hand-off. So we only allow the change while
// the lot has progressed no further than stitching (cutting/stitching events are fine — both
// flows share them). No DB here so it's unit-tested.

const BLOCKING_STAGES = ['jeans_assembly', 'washing', 'washing_in', 'finishing'];

// eventCounts: { stitching, jeans_assembly, washing, washing_in, finishing } row counts.
function canChangeFlow(eventCounts) {
  const counts = eventCounts || {};
  const blockedStages = BLOCKING_STAGES.filter((s) => (Number(counts[s]) || 0) > 0);
  if (blockedStages.length) {
    return {
      ok: false,
      blockedStages,
      reason: `This lot has already moved into ${blockedStages.join(', ')}. Changing denim/hosiery now would orphan that stage's data and mis-pay a worker — reverse the lot back to stitching first.`,
    };
  }
  return { ok: true, blockedStages: [] };
}

module.exports = { canChangeFlow, BLOCKING_STAGES };
