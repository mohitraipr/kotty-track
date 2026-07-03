// Unit test for the pure CSV serializer. Run:  node --test qcpass_extension/csv.test.js
const test = require('node:test');
const assert = require('node:assert');
const { toCsv, columnsOf, escapeCell } = require('./csv.js');

test('escapeCell quotes cells with commas, quotes and newlines', () => {
  assert.strictEqual(escapeCell('plain'), 'plain');
  assert.strictEqual(escapeCell('a,b'), '"a,b"');
  assert.strictEqual(escapeCell('he said "hi"'), '"he said ""hi"""');
  assert.strictEqual(escapeCell('line1\nline2'), '"line1\nline2"');
  assert.strictEqual(escapeCell(null), '');
  assert.strictEqual(escapeCell(undefined), '');
  assert.strictEqual(escapeCell(0), '0');
});

test('columnsOf is the first-seen union across records', () => {
  const rows = [{ a: 1, b: 2 }, { b: 3, c: 4 }];
  assert.deepStrictEqual(columnsOf(rows), ['a', 'b', 'c']);
});

test('toCsv writes a header row plus one row per record, CRLF separated', () => {
  const rows = [
    { item_barcode: 'X1', size: 'M', note: 'a,b' },
    { item_barcode: 'X2', size: 'L' },
  ];
  const csv = toCsv(rows);
  const lines = csv.split('\r\n');
  assert.strictEqual(lines[0], 'item_barcode,size,note');
  assert.strictEqual(lines[1], 'X1,M,"a,b"');
  assert.strictEqual(lines[2], 'X2,L,'); // missing key -> empty cell
  assert.strictEqual(lines.length, 3);
});

test('toCsv on empty input yields an empty header line', () => {
  assert.strictEqual(toCsv([]), '');
  assert.strictEqual(toCsv(null), '');
});
