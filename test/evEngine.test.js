const test = require('node:test');
const assert = require('node:assert/strict');
const EVEngine = require('../src/bot/EVEngine');

test('adjusted EV charges the crypto taker curve at the bought-token price', () => {
  const ev = new EVEngine();
  // Raw YES EV = q-p = 0.10. At p=.50 the protocol fee is 1.75c/share.
  assert.ok(Math.abs(ev.calculateAdjustedEV(0.60, 0.50, 'YES', {
    spread: 0,
    estimatedSlippage: 0,
    takerFeeRate: 0.07,
  }) - 8.25) < 1e-12);
});

test('zero configured slippage remains zero instead of falling back to 50bp', () => {
  const ev = new EVEngine();
  const withZero = ev.calculateAdjustedEV(0.60, 0.50, 'YES', {
    spread: 0,
    estimatedSlippage: 0,
    takerFeeRate: 0,
  });
  assert.ok(Math.abs(withZero - 10) < 1e-12);
});
