/**
 * SlippageEngine — walk the order book to estimate fill price for a USD order.
 *
 * Polymarket books are thin: a $5 BUY on an ask of 0.50 often fills at 0.55+
 * after eating the first level. The CLOB book layer in PolymarketFeed only
 * exposes `totalDepth`, which is too coarse to decide when to skip an entry.
 *
 * Usage:
 *   const result = SlippageEngine.estimate(bookAsks, 5, 'buy');
 *   //   bookAsks = [{ price: 0.50, size: 3 }, { price: 0.52, size: 8 }, ...]
 *   //   amountUsd = 5
 *   //   side = 'buy' (consumes asks) or 'sell' (consumes bids)
 *   // → { avgFillPrice: 0.508, slipBps: 16, fillable: true, sharesFilled: 9.8 }
 *
 * Output:
 *   avgFillPrice   USD-weighted average fill price (token units 0–1)
 *   slipBps        basis points away from best price (0 = no slip, 100 = +1%)
 *   fillable       true if the book had enough size to consume the order
 *   sharesFilled   number of shares (tokens) that would fill
 */

const BPS_MULTIPLIER = 10000;

class SlippageEngine {
  /**
   * @param {Array<{price:number, size:number}>} bookLevels — book side, any order
   * @param {number} amountUsd — order size in USD
   * @param {'buy'|'sell'} side
   */
  static estimate(bookLevels, amountUsd, side = 'buy') {
    if (!Array.isArray(bookLevels) || bookLevels.length === 0) {
      return { avgFillPrice: null, slipBps: null, fillable: false, sharesFilled: 0, levelsConsumed: 0 };
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return { avgFillPrice: null, slipBps: null, fillable: false, sharesFilled: 0, levelsConsumed: 0 };
    }

    // For BUY we consume asks ascending; for SELL we consume bids descending.
    const sorted = [...bookLevels]
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
      .sort((a, b) => (side === 'buy' ? a.price - b.price : b.price - a.price));

    if (sorted.length === 0) {
      return { avgFillPrice: null, slipBps: null, fillable: false, sharesFilled: 0, levelsConsumed: 0 };
    }

    const bestPrice = sorted[0].price;
    let remainingUsd = amountUsd;
    let totalCostUsd = 0;
    let totalShares = 0;
    let levelsConsumed = 0;

    for (const level of sorted) {
      const levelUsd = level.price * level.size;
      if (remainingUsd <= levelUsd) {
        const shares = remainingUsd / level.price;
        totalShares += shares;
        totalCostUsd += remainingUsd;
        remainingUsd = 0;
        levelsConsumed += 1;
        break;
      }
      totalShares += level.size;
      totalCostUsd += levelUsd;
      remainingUsd -= levelUsd;
      levelsConsumed += 1;
    }

    if (totalShares <= 0) {
      return { avgFillPrice: bestPrice, slipBps: 0, fillable: false, sharesFilled: 0, levelsConsumed: 0 };
    }

    const avgFillPrice = totalCostUsd / totalShares;
    const slipBps = bestPrice > 0 ? (Math.abs(avgFillPrice - bestPrice) / bestPrice) * BPS_MULTIPLIER : 0;
    const fillable = remainingUsd <= 1e-6;

    return {
      avgFillPrice,
      slipBps,
      fillable,
      sharesFilled: totalShares,
      levelsConsumed,
      bestPrice,
    };
  }

  /**
   * Liquidity depth in USD at top of book per side.
   * Accepts `book = { bids: [...], asks: [...] }` with `{ price, size }` entries.
   */
  static topOfBookDepthUsd(book) {
    const result = { bidUsd: 0, askUsd: 0 };
    if (!book) return result;
    const bestBid = (book.bids || [])
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
      .sort((a, b) => b.price - a.price)[0];
    const bestAsk = (book.asks || [])
      .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.size > 0)
      .sort((a, b) => a.price - b.price)[0];
    if (bestBid) result.bidUsd = bestBid.price * bestBid.size;
    if (bestAsk) result.askUsd = bestAsk.price * bestAsk.size;
    return result;
  }
}

module.exports = SlippageEngine;
module.exports.BPS_MULTIPLIER = BPS_MULTIPLIER;
