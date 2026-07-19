'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parameterSafeChunks } = require('../borg/recon/db');

test('database batches stay below the PostgreSQL parameter ceiling without dropping rows', async () => {
  const columns = Array.from({ length: 18 }, (_, index) => `c${index}`);
  const rows = Array.from({ length: 11386 }, (_, row) =>
    Array.from({ length: columns.length }, (_, column) => `${row}:${column}`));
  const chunks = parameterSafeChunks(columns, rows);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.flat().length, rows.length);
  assert.ok(chunks.every((chunk) => chunk.length * columns.length <= 60000));
  assert.deepEqual(chunks.flat()[10000], rows[10000]);
});
