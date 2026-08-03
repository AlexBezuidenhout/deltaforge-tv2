'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Readable } = require('node:stream');
const { lfDelimitedLines } = require('../borg/research/strict-ndjson');

test('strict NDJSON framing uses LF only and preserves split UTF-8 code points', async () => {
  const text = '{"rule":"alpha\u2028beta\u2029gamma"}\r\n{"value":"€"}\n{"tail":true}';
  const bytes = Buffer.from(text);
  const euro = bytes.indexOf(Buffer.from('€'));
  const chunks = [
    bytes.subarray(0, 7),
    bytes.subarray(7, euro + 1),
    bytes.subarray(euro + 1, euro + 2),
    bytes.subarray(euro + 2),
  ];
  const lines = [];
  for await (const line of lfDelimitedLines(Readable.from(chunks))) lines.push(line);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).rule, 'alpha\u2028beta\u2029gamma');
  assert.equal(JSON.parse(lines[1]).value, '€');
  assert.deepEqual(JSON.parse(lines[2]), { tail: true });
});
