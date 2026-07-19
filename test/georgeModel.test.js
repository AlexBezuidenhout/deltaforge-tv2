const test = require('node:test');
const assert = require('node:assert');
const GeorgeSignalEngine = require('../src/bot/GeorgeSignalEngine');

const base = {
  sigma5min: 0.0028,
  remainingSec: 150,
  deviationPct: 0.5,
  heartbeatSec: 3600,
};

test('inside band, CL above open, low vol → outcome dominated by frozen CL print', () => {
  // Spot sits exactly on CL(now) (no pressure toward an update), CL already above open.
  const r = GeorgeSignalEngine.computeProbability({
    ...base,
    spotNow: 100000,
    clNow: 100000,
    clOpen: 99500, // CL(now) > CL(open): no-update branch says UP wins
    sigma5min: 0.0008, // calm: band (0.5%) is ~6σ away → update very unlikely
  });
  assert.ok(r.pUpdate < 0.15, `pUpdate should be small, got ${r.pUpdate}`);
  assert.ok(r.pUp > 0.85, `pUp should be near 1 (frozen print wins), got ${r.pUp}`);
});

test('spot beyond deviation band → update certain, model follows spot vs CL(open)', () => {
  const r = GeorgeSignalEngine.computeProbability({
    ...base,
    spotNow: 100600, // +0.6% above clNow → outside 0.5% band
    clNow: 100000,
    clOpen: 100000,
  });
  assert.strictEqual(r.pUpdate, 1);
  // spot is 0.6% above CL(open) with σ_rem ≈ 0.2% → strongly UP
  assert.ok(r.pUp > 0.95, `pUp should be high, got ${r.pUp}`);
});

test('frozen CL below open beats a slightly bullish spot when update is unlikely', () => {
  // The asymmetry George exploits: spot marginally above open says "UP", but the
  // print that actually resolves is CL(now), which is below CL(open).
  const r = GeorgeSignalEngine.computeProbability({
    ...base,
    spotNow: 100050,  // spot marginally above CL open
    clNow: 99900,     // but the oracle print is BELOW open
    clOpen: 100000,
    sigma5min: 0.0006, // calm → update unlikely
    remainingSec: 90,
  });
  assert.ok(r.pUp < 0.5, `pUp should lean DOWN via frozen print, got ${r.pUp}`);
});

test('heartbeat floors pUpdate for long windows', () => {
  const r = GeorgeSignalEngine.computeProbability({
    ...base,
    spotNow: 100000, clNow: 100000, clOpen: 100000,
    sigma5min: 0.0004,
    remainingSec: 300,
  });
  assert.ok(r.pUpdate >= 300 / 3600 - 1e-9, `heartbeat floor missing: ${r.pUpdate}`);
});

test('probabilities clamped and null on bad inputs', () => {
  assert.strictEqual(GeorgeSignalEngine.computeProbability({ ...base, spotNow: NaN, clNow: 1, clOpen: 1 }), null);
  assert.strictEqual(GeorgeSignalEngine.computeProbability({ ...base, spotNow: 1, clNow: 1, clOpen: 1, remainingSec: -5 }), null);
  const r = GeorgeSignalEngine.computeProbability({ ...base, spotNow: 120000, clNow: 100000, clOpen: 100000 });
  assert.ok(r.pUp <= 0.999 && r.pUp >= 0.001);
});
