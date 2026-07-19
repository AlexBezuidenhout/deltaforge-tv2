'use strict';

/**
 * Structured Polymarket × Kalshi game pairing.
 *
 * Polymarket game markets carry a fully machine-readable slug —
 * `fifwc-esp-arg-2026-07-19-esp` (league, teams, ISO date, leg, with `draw`
 * as the draw leg) — and Kalshi game events encode the same facts in the
 * event ticker (`KXWCGAME-26JUL19ESPARG`) with the leg team in the market
 * ticker suffix (`-ESP`, `-TIE`). That permits deterministic pairing on
 * (league, date, team pair, leg) with zero text similarity — the mechanism
 * that produced the MLB-vs-Galaxy false matches.
 *
 * Kalshi "Regulation Time Moneyline" legs share Polymarket's 90-minutes-plus-
 * stoppage predicate, so the headline payoff matches. The venues still
 * diverge in tail states (canceled game: Polymarket resolves No, Kalshi
 * resolves at fair price — the frozen family-review finding), so every pair
 * carries CANCELLATION_RESCHEDULE_RULES_DIFFER and is NEVER auto-approved:
 * these are capture targets for basis and settlement scoring, and approval
 * stays a frozen manual act.
 */

const SERIES = Object.freeze([
  // league = Polymarket slug prefix; ticker = Kalshi series.
  { ticker: 'KXWCGAME', league: 'fifwc', teamCodeLen: 3 },
  { ticker: 'KXMLSGAME', league: 'mls', teamCodeLen: null },
  { ticker: 'KXNWSLGAME', league: 'nwsl', teamCodeLen: null },
  { ticker: 'KXEPLGAME', league: 'epl', teamCodeLen: 3 },
  { ticker: 'KXLIGAMXGAME', league: 'ligamx', teamCodeLen: null },
  { ticker: 'KXBRASILEIROGAME', league: 'bra', teamCodeLen: null },
  { ticker: 'KXMLBGAME', league: 'mlb', teamCodeLen: null },
]);

const MONTHS = Object.freeze({
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
});

const POLY_SLUG = /^([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})-([a-z0-9]+)$/;
// Event segment: date, optional HHMM start time, then concatenated team codes.
const KALSHI_EVENT = /^(\d{2})([A-Z]{3})(\d{2})(\d{4})?([A-Z]+)$/;

function parsePolyGameSlug(slug) {
  const match = POLY_SLUG.exec(String(slug || ''));
  if (!match) return null;
  const [, league, teamA, teamB, date, leg] = match;
  if (teamA === teamB) return null;
  const isDraw = leg === 'draw';
  if (!isDraw && leg !== teamA && leg !== teamB) return null;
  return { league, teamA, teamB, date, leg: isDraw ? 'draw' : leg };
}

function parseKalshiGameEvent(eventTicker, seriesTicker) {
  const segment = String(eventTicker || '').split('-')[1] || '';
  const prefix = String(seriesTicker || '');
  if (!String(eventTicker || '').startsWith(`${prefix}-`)) return null;
  const match = KALSHI_EVENT.exec(segment);
  if (!match) return null;
  const [, yy, mon, dd, time, teams] = match;
  const month = MONTHS[mon];
  if (!month) return null;
  const date = `20${yy}-${String(month).padStart(2, '0')}-${dd}`;
  return { date, startTime: time || null, teamBlob: teams };
}

function legFromTicker(ticker) {
  const parts = String(ticker || '').split('-');
  return parts.length >= 3 ? parts[parts.length - 1].toLowerCase() : null;
}

function isTieLeg(market) {
  const leg = legFromTicker(market.ticker);
  const sub = String(market.yesSubTitle || '').toLowerCase();
  return leg === 'tie' || /\b(tie|draw)\b/.test(sub);
}

/**
 * The Kalshi team blob is the two venue team codes concatenated
 * (`ESPARG`). Accept a Polymarket pair when uppercase concatenation in
 * either order reproduces the blob exactly. Codes that don't align between
 * venues starve capture rather than guessing.
 */
function teamsMatchBlob(teamA, teamB, blob) {
  const a = teamA.toUpperCase();
  const b = teamB.toUpperCase();
  return blob === `${a}${b}` || blob === `${b}${a}`;
}

function datesAdjacent(left, right) {
  const gap = Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`));
  return gap <= 86_400_000;
}

/**
 * Deterministic pairing on (league, date, team pair, leg). Kalshi tickers
 * date games in US Eastern time while Polymarket slugs use the local game
 * date, so a one-day skew is tolerated only when the (league, team pair)
 * fixture is unique in the window — doubleheaders stay unmatched.
 */
function buildStructuredSportsPairs(polyMarkets, kalshiMarkets) {
  const seriesByTicker = new Map(SERIES.map((row) => [row.ticker, row]));
  const kalshiLegs = [];
  for (const kalshi of kalshiMarkets) {
    const series = seriesByTicker.get(kalshi.seriesTicker);
    if (!series) continue;
    const event = parseKalshiGameEvent(kalshi.eventTicker, kalshi.seriesTicker);
    if (!event) continue;
    kalshiLegs.push({
      kalshi, series, event,
      leg: isTieLeg(kalshi) ? 'draw' : legFromTicker(kalshi.ticker),
    });
  }
  const pairs = [];
  for (const poly of polyMarkets) {
    const parsed = parsePolyGameSlug(poly.slug);
    if (!parsed) continue;
    const candidates = kalshiLegs.filter((row) =>
      row.series.league === parsed.league
      && row.leg === parsed.leg
      && teamsMatchBlob(parsed.teamA, parsed.teamB, row.event.teamBlob)
      && datesAdjacent(parsed.date, row.event.date));
    const exact = candidates.filter((row) => row.event.date === parsed.date);
    const chosen = exact.length ? exact : candidates;
    // Two Kalshi games for one (league, teams, leg) window is a
    // doubleheader or a rescheduled fixture — ambiguous, skip.
    if (chosen.length !== 1) continue;
    const [row] = chosen;
    pairs.push({
      poly, kalshi: row.kalshi,
      structuredEvidence: {
        version: 'crossvenue-sports-structured-v1',
        form: parsed.leg === 'draw' ? 'game_draw_reg_time' : 'game_winner_reg_time',
        league: parsed.league, date: parsed.date,
        teams: [parsed.teamA, parsed.teamB], leg: parsed.leg,
        polyParsed: parsed,
        kalshiParsed: { eventTicker: row.kalshi.eventTicker, ...row.event, leg: row.leg },
        reasons: [
          'CANCELLATION_RESCHEDULE_RULES_DIFFER',
          ...(row.event.date !== parsed.date ? ['DATE_TIMEZONE_SKEW_TOLERATED'] : []),
        ],
      },
    });
  }
  return pairs;
}

module.exports = {
  SERIES, buildStructuredSportsPairs, isTieLeg, legFromTicker,
  parseKalshiGameEvent, parsePolyGameSlug, teamsMatchBlob,
};
