/**
 * BORG recon — Chainlink BTC/USD mainnet push feed (CONTROL series only).
 *
 * IMPORTANT (established 2026-07-11, see THESES.md): these markets resolve on
 * Chainlink DATA STREAMS, not this push feed. We record the push feed anyway
 * as a control/sanity series (its rounds are the only freely observable
 * Chainlink prints) and to definitively close the legacy George thesis.
 */
const { ethers } = require('ethers');

const FEED = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c'; // ETH mainnet BTC/USD
const ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];
const RPCS = [
  process.env.ETH_RPC_URL,
  'https://ethereum.publicnode.com',
  'https://cloudflare-eth.com',
].filter(Boolean);

class ChainlinkRecon {
  constructor() {
    this.price = null;
    this.updatedAtMs = null;
    this.rounds = []; // { roundId, price, updatedAtMs, seenAtMs } oldest first
    this._newRounds = [];
    this._rpcIdx = 0;
  }

  async poll() {
    for (let i = 0; i < RPCS.length; i++) {
      const idx = (this._rpcIdx + i) % RPCS.length;
      try {
        const provider = new ethers.JsonRpcProvider(RPCS[idx], undefined, { staticNetwork: true });
        const c = new ethers.Contract(FEED, ABI, provider);
        const [roundId, answer, , updatedAt] = await c.latestRoundData();
        this._rpcIdx = idx;
        const price = parseFloat(ethers.formatUnits(answer, 8));
        const updatedAtMs = Number(updatedAt) * 1000;
        this.price = price;
        this.updatedAtMs = updatedAtMs;
        const rid = String(roundId);
        const last = this.rounds[this.rounds.length - 1];
        if (!last || last.roundId !== rid) {
          const round = { roundId: rid, price, updatedAtMs, seenAtMs: Date.now() };
          this.rounds.push(round);
          this._newRounds.push(round);
          if (this.rounds.length > 500) this.rounds.shift();
        }
        return;
      } catch (_) { /* try next rpc */ }
    }
  }

  /** Rounds not yet persisted (oldest first). */
  drainNewRounds() {
    const out = this._newRounds;
    this._newRounds = [];
    return out;
  }

  /** Price in force at tsMs, or null if our observation doesn't cover it. */
  getPriceAtMs(tsMs) {
    let candidate = null;
    for (const r of this.rounds) {
      if (r.updatedAtMs <= tsMs) candidate = r;
      else break;
    }
    if (!candidate) return null;
    if (this.rounds[0].seenAtMs > tsMs && candidate === this.rounds[0]) {
      if (tsMs - candidate.updatedAtMs > 3600 * 1000) return null;
    }
    return candidate.price;
  }
}

module.exports = ChainlinkRecon;
