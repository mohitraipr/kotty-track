// Pure helpers for reversing a lot to its previous stage (undoing a stage that mistakenly
// took a lot in). No DB, so it's unit-tested.

const { orderedStages } = require('./lotJourney');

const STAGE_LABEL = {
  stitching: 'Stitching', jeans_assembly: 'Jeans Assembly',
  washing: 'Washing', washing_in: 'Washing-In', finishing: 'Finishing',
};

// The ONLY reversible stage is the furthest-along stage that has events: you can't reverse a
// stage while a later stage has already pulled pieces from it (that guarantees no downstream
// event references what we're about to delete). Returns { stage, label } or null.
function reversibleStage(flowType, eventCounts) {
  const counts = eventCounts || {};
  const stages = orderedStages(flowType).filter((s) => s !== 'cutting');
  let last = null;
  for (const s of stages) if ((Number(counts[s]) || 0) > 0) last = s;
  return last ? { stage: last, label: STAGE_LABEL[last] || last } : null;
}

// When stage X approves (takes the lot in), it pays the UPSTREAM worker via stage_payments
// with stage = the payee's stage. Reversing X must void that pending payment. Finishing's
// payee depends on flow (denim pulls from washing_in, hosiery from stitching). Returns the
// stage_payments.stage value to void, or null if the stage pays nobody.
function payStageFor(stage, flowType) {
  const denim = flowType === 'denim';
  return ({
    stitching: 'cutting',
    jeans_assembly: 'stitching',
    washing: 'assembly',
    washing_in: 'washing',
    finishing: denim ? 'washing_in' : 'stitching',
  })[stage] || null;
}

module.exports = { reversibleStage, payStageFor, STAGE_LABEL };
