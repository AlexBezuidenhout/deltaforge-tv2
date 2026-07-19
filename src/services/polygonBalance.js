/**
 * Real on-chain USDC balance for LIVE bot cards (2026-07-13).
 *
 * Ground-truth rule: a bot wearing the LIVE badge must never display a
 * simulated balance — its number comes from the actual Polygon wallet, or
 * shows nothing at all. Sums pUSD + USDC.e + native USDC (Polymarket's 2026
 * exchange collateral is pUSD; older proxies held either USDC flavor).
 * 30s cache so dashboard polling never hammers public RPCs;
 * on RPC failure returns the stale cached value (marked) rather than null,
 * so a flaky RPC doesn't flicker the card.
 */
const { JsonRpcProvider, Contract, formatUnits } = require('ethers');

const RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://polygon-rpc.com',
];
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // Polymarket USD — the live collateral
const ABI = ['function balanceOf(address) view returns (uint256)'];

const _cache = new Map(); // address -> { usd, at, stale }

async function getUsdcBalance(address) {
  if (!address) return null;
  const hit = _cache.get(address);
  if (hit && Date.now() - hit.at < 30000) return hit;

  for (const url of RPCS) {
    try {
      const provider = new JsonRpcProvider(url, 137, { staticNetwork: true });
      const [ba, bb, bp] = await Promise.all([
        new Contract(USDC_E, ABI, provider).balanceOf(address),
        new Contract(USDC, ABI, provider).balanceOf(address),
        new Contract(PUSD, ABI, provider).balanceOf(address),
      ]);
      const usd = parseFloat(formatUnits(ba, 6)) + parseFloat(formatUnits(bb, 6)) + parseFloat(formatUnits(bp, 6));
      const entry = { usd: +usd.toFixed(2), at: Date.now(), stale: false };
      _cache.set(address, entry);
      return entry;
    } catch (_) { /* next RPC */ }
  }
  if (hit) return { ...hit, stale: true }; // all RPCs down — serve stale
  return null;
}

/**
 * Exchange-ledger balance — the authoritative "spendable" number for a
 * Polymarket account (deposits show here before/regardless of raw
 * balanceOf reads; this is what order placement checks against).
 * Falls back to the on-chain read when the CLOB is unreachable.
 */
let _clobCache = null; // { usd, at }
let _clobClient = null;
async function getLiveBalance(acct) {
  if (_clobCache && Date.now() - _clobCache.at < 30000) return _clobCache;
  try {
    const mod = await import('@polymarket/clob-client-v2');
    if (!_clobClient) {
      const { Wallet } = require('ethers');
      const signer = new Wallet(acct.privateKey);
      if (!signer._signTypedData) signer._signTypedData = (d, t, v) => signer.signTypedData(d, t, v);
      const sigType = mod.SignatureTypeV2[acct.signatureType] ?? mod.SignatureTypeV2.POLY_PROXY;
      const l1 = new mod.ClobClient({ host: 'https://clob.polymarket.com', chain: mod.Chain.POLYGON,
        signer, signatureType: sigType, funderAddress: acct.funderAddress, throwOnError: true });
      const creds = await l1.deriveApiKey();
      _clobClient = new mod.ClobClient({ host: 'https://clob.polymarket.com', chain: mod.Chain.POLYGON,
        signer, creds, signatureType: sigType, funderAddress: acct.funderAddress, throwOnError: true });
    }
    const bal = await _clobClient.getBalanceAllowance({ asset_type: mod.AssetType.COLLATERAL });
    const usd = +(parseInt(bal.balance, 10) / 1e6).toFixed(2);
    _clobCache = { usd, at: Date.now(), stale: false, source: 'clob' };
    return _clobCache;
  } catch (_) {
    _clobClient = null; // re-init next time
    const chain = await getUsdcBalance(acct.funderAddress);
    return chain ? { ...chain, source: 'chain' } : (_clobCache ? { ..._clobCache, stale: true } : null);
  }
}

/**
 * Open-position value from Polymarket's data-api (no auth). Live cash alone
 * understates equity by (in-flight stake + payouts awaiting auto-redemption,
 * which lags resolution by minutes) — on 2026-07-13 that read as a fake −$50.
 * Returns 0-value worthless losing tokens correctly (currentValue 0).
 */
let _posCache = new Map(); // address -> { usd, at }
async function getPositionsValue(address) {
  if (!address) return null;
  const hit = _posCache.get(address);
  if (hit && Date.now() - hit.at < 30000) return hit;
  try {
    const res = await fetch(`https://data-api.polymarket.com/positions?user=${address}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const positions = await res.json();
    const usd = +positions.reduce((s, p) => s + (parseFloat(p.currentValue) || 0), 0).toFixed(2);
    const entry = { usd, at: Date.now(), stale: false };
    _posCache.set(address, entry);
    return entry;
  } catch (_) {
    return hit ? { ...hit, stale: true } : null;
  }
}

module.exports = { getUsdcBalance, getLiveBalance, getPositionsValue };
