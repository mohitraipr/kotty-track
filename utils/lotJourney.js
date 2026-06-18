// Assemble a single lot's journey through every production stage, ending at finishing
// dispatch. Pure helpers (no DB) so the ordering/status/dispatch math is unit-tested; the
// route (routes/lotJourneyRoutes.js) supplies the raw per-stage data from *_events via
// utils/stageEvents.getStageAggregates and a finishing_dispatches query.
//
// Stage names match utils/stageEvents.STAGES (plus 'cutting' at the front, which has no
// events table — cutting_lots.created_at is its entry point).

const DAY_MS = 86400000;

const STAGES_BY_FLOW = {
  denim:   ['cutting', 'stitching', 'jeans_assembly', 'washing', 'washing_in', 'finishing'],
  hosiery: ['cutting', 'stitching', 'finishing'],
};

// The ordered stage chain for a lot. Unknown/null flow falls back to the hosiery chain
// (mirrors operatorLotTatRoutes, which treats anything non-denim as the short chain).
function orderedStages(flowType) {
  return flowType === 'denim' ? STAGES_BY_FLOW.denim : STAGES_BY_FLOW.hosiery;
}

// Status + elapsed days for one stage given its entry/exit timestamps.
//   not_started: never entered. in_progress: entered, no exit (days counted to `nowMs`).
//   done: entered and exited (days = the span).
function deriveStageStatus({ entered, exited }, nowMs) {
  if (!entered) return { status: 'not_started', days: null };
  const startMs = new Date(entered).getTime();
  if (!exited) {
    return { status: 'in_progress', days: Math.max(0, Math.round((nowMs - startMs) / DAY_MS)) };
  }
  const endMs = new Date(exited).getTime();
  return { status: 'done', days: Math.max(0, Math.round((endMs - startMs) / DAY_MS)) };
}

// Compare finished pieces (per size) to dispatched pieces (per size) so the journey ends
// with how much of the lot has actually left for the warehouse.
function dispatchSummary(finishedBySize, dispatchedBySize) {
  const fin = finishedBySize || {};
  const disp = dispatchedBySize || {};
  const sizes = new Set([...Object.keys(fin), ...Object.keys(disp)]);
  const bySize = {};
  let totalFinished = 0;
  let totalDispatched = 0;
  for (const s of sizes) {
    const finished = Number(fin[s]) || 0;
    const dispatched = Number(disp[s]) || 0;
    bySize[s] = { finished, dispatched, remaining: finished - dispatched };
    totalFinished += finished;
    totalDispatched += dispatched;
  }
  const remaining = totalFinished - totalDispatched;
  return {
    bySize,
    totalFinished,
    totalDispatched,
    remaining,
    complete: totalFinished > 0 && remaining <= 0,
  };
}

// The stage the lot is sitting at: the first one in progress or not yet started.
// 'Done' when every stage is finished.
function currentStage(timeline) {
  for (const t of timeline || []) {
    if (t.status === 'in_progress' || t.status === 'not_started') return t.stage;
  }
  return 'Done';
}

module.exports = {
  STAGES_BY_FLOW,
  orderedStages,
  deriveStageStatus,
  dispatchSummary,
  currentStage,
  DAY_MS,
};
