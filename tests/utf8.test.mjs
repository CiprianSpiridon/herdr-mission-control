import test from 'node:test';
import assert from 'node:assert/strict';
import {utf8Bytes} from '../src/shared/utf8.js';

test('UTF-8 byte counts match Node for every UTF-16 code unit', () => {
  for (let unit = 0; unit <= 0xffff; unit++) {
    const value = String.fromCharCode(unit);
    assert.equal(utf8Bytes(value), Buffer.byteLength(value), 'code unit ' + unit);
  }
});

test('UTF-8 byte counts preserve valid pairs and lone surrogates in mixed strings', () => {
  const values = ['', 'ASCII\0\x7f', 'café Ā ߿', 'ࠀ漢字￿', '🙂🚀',
    '\ud800', '\udfff', '\ud800\udbff\udc00\udfff', '\udc00\ud800',
    '\ud800A\udc00', '\udbff\udfff', 'aé漢🙂\ud800z\udfff'];
  // Include all boundary pairings, including reversed and adjacent surrogates.
  const units = [0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff];
  for (const first of units) for (const second of units) for (const third of units) {
    values.push(String.fromCharCode(first, second, third));
  }
  for (const value of values) assert.equal(utf8Bytes(value), Buffer.byteLength(value), JSON.stringify(value));
});

test('UTF-8 byte counts stay exact for large ASCII, multibyte and mixed payloads', () => {
  for (const value of ['x'.repeat(1100000), 'é漢🙂'.repeat(200000),
    'ascii é 漢 🙂 \ud800 \udfff\n'.repeat(100000), 'x'.repeat(8 * 1024 * 1024),
    'x'.repeat(8 * 1024 * 1024) + 'é']) {
    assert.equal(utf8Bytes(value), Buffer.byteLength(value));
  }
});
