const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv, rowsToRecords } = require('../utils/qcCsv.js');

test('parseCsv handles quoted fields containing commas and quotes', () => {
  const rows = parseCsv('a,"b,c","she said ""hi"""\n1,2,3');
  assert.deepStrictEqual(rows, [
    ['a', 'b,c', 'she said "hi"'],
    ['1', '2', '3'],
  ]);
});

test('parseCsv handles a quoted field spanning newlines', () => {
  const rows = parseCsv('x,y\n"line1\nline2",z');
  assert.deepStrictEqual(rows, [
    ['x', 'y'],
    ['line1\nline2', 'z'],
  ]);
});

test('parseCsv treats CRLF and LF identically and drops a trailing newline', () => {
  const lf = parseCsv('a,b\n1,2\n');
  const crlf = parseCsv('a,b\r\n1,2\r\n');
  assert.deepStrictEqual(lf, [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(crlf, lf);
});

test('parseCsv strips a leading UTF-8 BOM', () => {
  const rows = parseCsv('﻿return_id,item_barcode\nR1,B1');
  assert.strictEqual(rows[0][0], 'return_id');
});

test('rowsToRecords maps header-driven rows and defaults _type to capture', () => {
  const rows = parseCsv('return_id,item_barcode,size\nR1,B1,M');
  const recs = rowsToRecords(rows);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0]._type, 'capture');
  assert.strictEqual(recs[0].return_id, 'R1');
  assert.strictEqual(recs[0].item_barcode, 'B1');
  assert.strictEqual(recs[0].size, 'M');
});

test('rowsToRecords honours an explicit _type column (pass) case-insensitively', () => {
  const rows = parseCsv('_type,item_barcode,oms_release_id\nPASS,B9,OMS9\ncapture,B1,OMS1');
  const recs = rowsToRecords(rows);
  assert.strictEqual(recs[0]._type, 'pass');
  assert.strictEqual(recs[1]._type, 'capture');
});

test('rowsToRecords is header case-insensitive and maps known fields', () => {
  const rows = parseCsv('Return_ID,Item_Barcode\nR1,B1');
  const recs = rowsToRecords(rows);
  assert.strictEqual(recs[0].return_id, 'R1');
  assert.strictEqual(recs[0].item_barcode, 'B1');
});

test('rowsToRecords sets missing known columns to null and empty cells to null', () => {
  const rows = parseCsv('return_id,item_barcode,size\nR1,,');
  const recs = rowsToRecords(rows);
  // present-but-empty cells -> null
  assert.strictEqual(recs[0].item_barcode, null);
  assert.strictEqual(recs[0].size, null);
  // known fields not in the header -> null
  assert.strictEqual(recs[0].qc_action, null);
  assert.strictEqual(recs[0].quality, null);
  assert.strictEqual(recs[0].oms_release_id, null);
  // populated cell survives
  assert.strictEqual(recs[0].return_id, 'R1');
});

test('rowsToRecords skips fully-empty rows (blank lines / all-empty cells)', () => {
  const rows = parseCsv('return_id,item_barcode\nR1,B1\n\n,,\nR2,B2\n');
  const recs = rowsToRecords(rows);
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].return_id, 'R1');
  assert.strictEqual(recs[1].return_id, 'R2');
});

test('rowsToRecords returns [] for empty input or header-only input', () => {
  assert.deepStrictEqual(rowsToRecords([]), []);
  assert.deepStrictEqual(rowsToRecords(parseCsv('')), []);
  assert.deepStrictEqual(rowsToRecords(parseCsv('return_id,item_barcode')), []);
});
