const { ethers } = require('ethers');

const CHAINLINK_BTC_USD = '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c';
const CHAINLINK_ABI = [
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)'
];

class ChainlinkFeed {
  /** @param feedAddress ETH-mainnet aggregator (default BTC/USD) — multi-asset 2026-07-12 */
  constructor(feedAddress = CHAINLINK_BTC_USD) {
    this.feedAddress = feedAddress;
    this.price = null;
    this.lastUpdate = null;
    this.updateInterval = null;
    // Observed on-chain rounds, oldest first: { roundId, price, updatedAtMs, seenAtMs }.
    // Deduped by roundId — a poll that sees the same round twice records it once.
    // Used by GeorgeSignalEngine to anchor Φ at the Chainlink price in force when a
    // market window opened (the value the market actually resolves against).
    this.roundHistory = [];
    this.maxRounds = 200;
  }

  async start(intervalMs = 30000) {
    await this.fetchPrice();
    this.updateInterval = setInterval(() => this.fetchPrice(), intervalMs);
    console.log(`[ChainlinkFeed] Started with ${intervalMs}ms interval`);
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    console.log('[ChainlinkFeed] Stopped');
  }

  async fetchPrice() {
    const rpcUrls = [
      process.env.ETH_RPC_URL,
      'https://ethereum.publicnode.com',
      'https://cloudflare-eth.com',
    ].filter(Boolean);

    for (const rpc of rpcUrls) {
      try {
        // ethers v6 API
        const provider = new ethers.JsonRpcProvider(rpc);
        const contract = new ethers.Contract(this.feedAddress, CHAINLINK_ABI, provider);
        const [roundId, answer, , updatedAt] = await contract.latestRoundData();

        // ethers v6: formatUnits is a top-level function
        this.price = parseFloat(ethers.formatUnits(answer, 8));
        this.lastUpdate = new Date(Number(updatedAt) * 1000);
        this._recordRound(roundId?.toString?.() ?? String(roundId), this.price, Number(updatedAt) * 1000);

        return this.price;
      } catch (err) {
        console.warn(`[ChainlinkFeed] RPC ${rpc} failed:`, err.message);
        continue;
      }
    }

    console.error('[ChainlinkFeed] All RPC endpoints failed');
    return null;
  }

  getPrice() {
    return this.price;
  }

  getLastUpdate() {
    return this.lastUpdate;
  }

  // Check if price is stale (older than maxAgeSeconds)
  isStale(maxAgeSeconds = 120) {
    if (!this.lastUpdate) return true;
    return (Date.now() - this.lastUpdate.getTime()) > (maxAgeSeconds * 1000);
  }

  /**
   * Lag (ms) between the Chainlink oracle's `updatedAt` and a reference CEX
   * timestamp (the latest Binance tick). Polymarket settles on Chainlink, so
   * when Chainlink is materially behind the CEX, our Φ-model and EV are
   * computed on a stale anchor.
   *
   * Returns null if either timestamp is missing.
   */
  getOracleLagMs(cexTimestampMs) {
    if (!this.lastUpdate || !Number.isFinite(cexTimestampMs)) return null;
    return Math.max(0, cexTimestampMs - this.lastUpdate.getTime());
  }

  _recordRound(roundId, price, updatedAtMs) {
    if (!Number.isFinite(price) || !Number.isFinite(updatedAtMs)) return;
    const last = this.roundHistory[this.roundHistory.length - 1];
    if (last && last.roundId === roundId) return; // same round observed again
    this.roundHistory.push({ roundId, price, updatedAtMs, seenAtMs: Date.now() });
    if (this.roundHistory.length > this.maxRounds) this.roundHistory.shift();
  }

  /**
   * The Chainlink price in force at timestamp `tsMs`: the latest observed round with
   * updatedAt ≤ tsMs. Returns null when our observation window doesn't cover tsMs
   * (feed started after tsMs, or tsMs predates the oldest retained round) — callers
   * must treat null as "unknown", never guess.
   */
  getPriceAtMs(tsMs) {
    if (!Number.isFinite(tsMs) || this.roundHistory.length === 0) return null;
    let candidate = null;
    for (const r of this.roundHistory) {
      if (r.updatedAtMs <= tsMs) candidate = r;
      else break;
    }
    if (!candidate) return null;
    // Guard: if our FIRST observed round is already newer than tsMs we returned null
    // above; if candidate is the first round but we only started watching after tsMs,
    // a newer round could have existed between candidate and tsMs that we never saw.
    // seenAtMs check keeps us honest: we must have been polling before tsMs.
    const firstSeen = this.roundHistory[0].seenAtMs;
    if (firstSeen > tsMs && candidate === this.roundHistory[0]) {
      // We were not watching at tsMs — candidate.updatedAt ≤ tsMs makes it PROBABLY
      // right (rounds are append-only), but an intermediate round may have been missed
      // if the gap exceeds our poll cadence. Accept only if the candidate was updated
      // within the plausible no-update window (heartbeat 3600s).
      if (tsMs - candidate.updatedAtMs > 3600 * 1000) return null;
    }
    return candidate.price;
  }
}

module.exports = ChainlinkFeed;
