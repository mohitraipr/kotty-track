// Pure weight math shared by the cutting-entry forms (browser) and tests (node).
// UMD wrapper: attaches `CuttingWeight` to the browser global and also exports
// for CommonJS so `node:test` can require it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CuttingWeight = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function num(v) {
    const n = parseFloat(v);
    return Number.isNaN(n) ? null : n;
  }

  // mode: 'denim' | 'hosiery'
  // inputs: { tableLength, layers, full, remaining }
  // returns: { used, remaining, over }  (used/remaining are numbers or null)
  function computeRollWeights(mode, inputs) {
    const full = num(inputs.full);

    if (mode === 'denim') {
      const tableLength = num(inputs.tableLength);
      const layers = num(inputs.layers);
      if (tableLength === null || layers === null) {
        return { used: null, remaining: null, over: false };
      }
      const used = tableLength * layers;
      const remaining = full === null ? null : Math.max(full - used, 0);
      const over = full !== null && used > full;
      return { used, remaining, over };
    }

    // hosiery: operator enters remaining (default 0); used = full - remaining
    const remaining = num(inputs.remaining) ?? 0;
    if (full === null) {
      return { used: null, remaining, over: false };
    }
    const rawUsed = full - remaining;
    const over = remaining > full;
    return { used: Math.max(rawUsed, 0), remaining, over };
  }

  return { computeRollWeights };
});
