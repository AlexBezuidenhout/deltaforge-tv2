'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildResearchEventsUrl } = require('../borg/recon/markets');

test('Gamma research discovery uses its validated order name and frozen seven-day horizon', () => {
  const now = Date.UTC(2026, 6, 16, 21, 0, 0);
  const url = buildResearchEventsUrl(now);

  assert.equal(url.pathname, '/events');
  assert.equal(url.searchParams.get('order'), 'endDate');
  assert.equal(url.searchParams.get('end_date_min'), '2026-07-16T19:00:00.000Z');
  assert.equal(url.searchParams.get('end_date_max'), '2026-07-23T21:00:00.000Z');
});
