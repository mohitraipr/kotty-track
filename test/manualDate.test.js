const { test } = require('node:test');
const assert = require('node:assert');
const { resolveManualDate, assertManualDateNotFuture } = require('../utils/stageEvents.js');

// Stub a mysql2 connection: dispatch each of resolveManualDate's queries by its
// SQL shape. `data` controls what each shape returns; `seen` records the order.
function stubConn(data) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      seen.push({ sql: flat, params });
      if (/AS is_future/.test(flat)) return [[{ is_future: data.isFuture ? 1 : 0 }]];
      if (/FROM \w+_events WHERE id = \?/.test(flat)) return [[data.parent]];
      if (/SELECT MIN\(COALESCE\(manual_date/.test(flat)) {
        const table = flat.match(/FROM (\w+_events)/)[1];
        return [[{ eff: (data.stageEff || {})[table] ?? null }]];
      }
      if (/SELECT \(CAST\(\? AS DATE\) < CAST\(\? AS DATE\)\) AS too_early/.test(flat)) {
        // Mirror MySQL: mysql2 serializes Date params in the +05:30 session tz,
        // then CAST(... AS DATE) keeps only the date part of each side.
        const day = v => v instanceof Date
          ? v.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
          : String(v).slice(0, 10);
        return [[{ too_early: day(params[0]) < day(params[1]) ? 1 : 0 }]];
      }
      if (/FROM cutting_lots WHERE id = \?/.test(flat)) {
        return [[{ too_early: data.cuttingTooEarly ? 1 : 0 }]];
      }
      throw new Error('unexpected query: ' + flat);
    },
  };
}

test('resolveManualDate: blank/null/whitespace input resolves to null without touching the DB', async () => {
  const conn = stubConn({});
  assert.strictEqual(await resolveManualDate(conn, { stage: 'stitching', cuttingLotId: 1, manualDate: null }), null);
  assert.strictEqual(await resolveManualDate(conn, { stage: 'stitching', cuttingLotId: 1, manualDate: '' }), null);
  assert.strictEqual(await resolveManualDate(conn, { stage: 'stitching', cuttingLotId: 1, manualDate: '   ' }), null);
  assert.strictEqual(conn.seen.length, 0);
});

test('resolveManualDate: malformed date throws before any query', async () => {
  const conn = stubConn({});
  await assert.rejects(
    () => resolveManualDate(conn, { stage: 'stitching', cuttingLotId: 1, manualDate: '05-08-2026' }),
    /Invalid manual date/
  );
  assert.strictEqual(conn.seen.length, 0);
});

test('resolveManualDate: future date rejected', async () => {
  const conn = stubConn({ isFuture: true });
  await assert.rejects(
    () => resolveManualDate(conn, { stage: 'stitching', cuttingLotId: 1, manualDate: '2030-01-01' }),
    /future/
  );
});

test('assertManualDateNotFuture: passes for non-future', async () => {
  const conn = stubConn({ isFuture: false });
  await assert.doesNotReject(() => assertManualDateNotFuture(conn, '2026-08-01'));
});

test('resolveManualDate: complete path bounds against the parent approve effective date', async () => {
  const tooEarly = stubConn({ parent: { too_early: 1, eff: '05-08-2026' } });
  await assert.rejects(
    () => resolveManualDate(tooEarly, { stage: 'washing', cuttingLotId: 1, manualDate: '2026-08-01', parentEventId: 42 }),
    /before this batch was taken \(05-08-2026\)/
  );

  const ok = stubConn({ parent: { too_early: 0, eff: '01-08-2026' } });
  const v = await resolveManualDate(ok, { stage: 'washing', cuttingLotId: 1, manualDate: '2026-08-05', parentEventId: 42 });
  assert.strictEqual(v, '2026-08-05');
  // complete path never walks upstream stages
  assert.ok(!ok.seen.some(x => /SELECT MIN/.test(x.sql)));
});

test('resolveManualDate: approve path bounds against the nearest upstream stage with events', async () => {
  // washing → checks jeans_assembly first; it has events starting 2026-08-03
  const conn = stubConn({ stageEff: { jeans_assembly_events: '2026-08-03' } });
  await assert.rejects(
    () => resolveManualDate(conn, { stage: 'washing', cuttingLotId: 1, manualDate: '2026-08-01' }),
    /before the jeans assembly stage started/
  );

  const ok = stubConn({ stageEff: { jeans_assembly_events: '2026-08-03' } });
  const v = await resolveManualDate(ok, { stage: 'washing', cuttingLotId: 1, manualDate: '2026-08-03' });
  assert.strictEqual(v, '2026-08-03');
  // stops at the first upstream stage that has events — never reaches stitching or cutting
  assert.ok(!ok.seen.some(x => /stitching_events/.test(x.sql)));
  assert.ok(!ok.seen.some(x => /cutting_lots/.test(x.sql)));
});

test('resolveManualDate: hosiery-style walk skips empty stages and falls through to stitching', async () => {
  // finishing on a hosiery lot: washing_in/washing/jeans_assembly empty, stitching has events
  const conn = stubConn({ stageEff: { stitching_events: '2026-08-02' } });
  await assert.rejects(
    () => resolveManualDate(conn, { stage: 'finishing', cuttingLotId: 1, manualDate: '2026-08-01' }),
    /before the stitching stage started/
  );
  assert.ok(conn.seen.some(x => /washing_in_events/.test(x.sql)));
  assert.ok(conn.seen.some(x => /washing_events/.test(x.sql)));
  assert.ok(conn.seen.some(x => /jeans_assembly_events/.test(x.sql)));
});

test('resolveManualDate: all upstream stages empty falls back to the cutting effective date', async () => {
  const ok = stubConn({ stageEff: {}, cuttingTooEarly: false });
  const v = await resolveManualDate(ok, { stage: 'stitching', cuttingLotId: 1, manualDate: '2026-08-05' });
  assert.strictEqual(v, '2026-08-05');
  assert.ok(ok.seen.some(x => /cutting_lots/.test(x.sql)));

  const bad = stubConn({ stageEff: {}, cuttingTooEarly: true });
  await assert.rejects(
    () => resolveManualDate(bad, { stage: 'stitching', cuttingLotId: 1, manualDate: '2026-08-01' }),
    /before the lot was cut/
  );
});

test('resolveManualDate: date equal to the upstream stage start day is accepted (Date-param serialization)', async () => {
  // The upstream MIN() arrives as a JS Date; mysql2 sends it as a datetime string.
  // Regression: '2026-08-03' < '2026-08-03 00:00:00' compares true as strings.
  const conn = stubConn({ stageEff: { jeans_assembly_events: new Date('2026-08-03T00:00:00+05:30') } });
  const v = await resolveManualDate(conn, { stage: 'washing', cuttingLotId: 1, manualDate: '2026-08-03' });
  assert.strictEqual(v, '2026-08-03');
});
