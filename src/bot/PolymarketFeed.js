const axios = require('axios');

// Per-relay-URL mutex — serializes concurrent POSTs through the same tunnel.
// Free tunnels (ngrok/localtunnel) corrupt concurrent HTTP bodies → HMAC failure.
// Map<relayBaseUrl, Promise> — different tunnels don't block each other.
const _relayLocks = new Map();
function withRelayLock(relayBase, fn) {
  const current = _relayLocks.get(relayBase) || Promise.resolve();
  const next = current.then(fn, fn);
  _relayLocks.set(relayBase, next.then(() => {}, () => {}));
  return next;
}

function buildMarketBuyOrder(tokenId, dollarAmountUSDC, worstPrice, Side, OrderType) {
  const parsedWorstPrice = worstPrice == null ? null : parseFloat(worstPrice);
  if (parsedWorstPrice != null && (!Number.isFinite(parsedWorstPrice)
    || parsedWorstPrice <= 0 || parsedWorstPrice >= 1)) {
    throw new Error(`Invalid FAK worst price: ${worstPrice}`);
  }
  return {
    tokenID: tokenId,
    side: Side.BUY,
    amount: dollarAmountUSDC,
    orderType: OrderType.FAK,
    ...(parsedWorstPrice == null ? {} : { price: parsedWorstPrice }),
  };
}

// ClobClient is ESM-only — must be loaded with dynamic import()
let _ClobClient = null;
let _Side = null;
let _OrderType = null;
let _Chain = null;
let _SignatureType = null;
let _AssetType = null;
let _orderToJsonV2 = null;
let _createL2Headers = null;
async function getClobClient() {
  if (!_ClobClient) {
    const mod = await import('@polymarket/clob-client-v2');
    _ClobClient = mod.ClobClient;
    _Side = mod.Side; // Side.BUY, Side.SELL
    _OrderType = mod.OrderType; // OrderType.GTC, OrderType.FOK, etc.
    _Chain = mod.Chain;
    _SignatureType = mod.SignatureTypeV2;
    _AssetType = mod.AssetType;
    _orderToJsonV2 = mod.orderToJsonV2;
    _createL2Headers = mod.createL2Headers;
  }
  return _ClobClient;
}

// ethers v6 Wallet signer — required by CLOB SDK v2 (raw private key string is rejected)
// The CLOB SDK signer detection checks `_signTypedData` (ethers v5 API).
// ethers v6 renamed this to `signTypedData`, so the SDK falls through to the viem
// walletClient branch and fails with "wallet client is missing account address".
// Fix: wrap ethers v6 Wallet and expose `_signTypedData` as an alias.
let _ethers = null;
async function getEthersSigner(privateKey) {
  if (!_ethers) _ethers = require('ethers');
  const wallet = new _ethers.Wallet(privateKey);
  // Polyfill ethers v5 API so SDK detects this as an ethers TypedDataSigner
  if (typeof wallet._signTypedData !== 'function' && typeof wallet.signTypedData === 'function') {
    wallet._signTypedData = (domain, types, value) => wallet.signTypedData(domain, types, value);
  }
  return wallet;
}

// Multi-asset (2026-07-12): question keywords + slug prefix per updown-5m
// asset. The authoritative enable/disable switchboard is the asset_config
// table; BotInstance passes the enabled subset via setAssets(). Default is
// btc-only for backward compatibility.
const ASSET_DEFS = {
  btc:  { prefix: 'btc-updown-5m',  words: ['bitcoin', 'btc'] },
  eth:  { prefix: 'eth-updown-5m',  words: ['ethereum', 'eth'] },
  sol:  { prefix: 'sol-updown-5m',  words: ['solana', 'sol'] },
  doge: { prefix: 'doge-updown-5m', words: ['dogecoin', 'doge'] },
  xrp:  { prefix: 'xrp-updown-5m',  words: ['xrp'] },
  bnb:  { prefix: 'bnb-updown-5m',  words: ['bnb'] },
  hype: { prefix: 'hype-updown-5m', words: ['hyperliquid', 'hype'] },
};

function assetFromSlugOrQuestion(slug, question) {
  const sl = (slug || '').toLowerCase();
  const q = (question || '').toLowerCase();
  for (const [asset, def] of Object.entries(ASSET_DEFS)) {
    if (sl.startsWith(def.prefix + '-')) return asset;
  }
  for (const [asset, def] of Object.entries(ASSET_DEFS)) {
    if (def.words.some((w) => q.includes(w))) return asset;
  }
  return null;
}

class PolymarketFeed {
  constructor(
    privateKey,
    walletAddress,
    geoBlockToken = null,
    clobProxyUrl = null,
    builderCode = null,
    signatureType = 'EOA',
    funderAddress = null
  ) {
    this.privateKey = privateKey;
    this.walletAddress = walletAddress;
    this.signatureType = signatureType || 'EOA';
    this.funderAddress = funderAddress || walletAddress || null;
    this.geoBlockToken = geoBlockToken || process.env.POLYMARKET_GEO_TOKEN || null;
    this.builderCode = builderCode || process.env.POLYMARKET_BUILDER_CODE || null;
    // When set, order POSTs are sent through this HTTP proxy instead of the SDK's
    // internal axios call — bypasses Render Frankfurt geo-block.
    // Format: "http://host:port" — must be accessible from Render (e.g. via ngrok tunnel).
    this.clobProxyUrl = clobProxyUrl || process.env.CLOB_PROXY_URL || null;
    this._signer = null;  // kept for proxy-mode order signing
    this._creds = null;   // kept for proxy-mode L2 header generation
    this.clobClient = null;
    this._clockSkew = 0;          // cached server-vs-local skew (seconds)
    this._clockSkewFetchedAt = 0; // timestamp of last skew fetch
    this.marketsCache = [];
    this.lastMarketFetch = null;
    this.marketCacheTTL = 10000; // 10s
    // Track last known order book per token for high-frequency reads
    this.orderBookCache = {}; // tokenId -> { book, ts }
    this.orderBookCacheTTL = 500; // 500ms — sub-second freshness
    this._depositFlowFailoverTried = false;
  }

  _resolveSignatureType() {
    // Accept numeric or string values from settings.
    if (typeof this.signatureType === 'number') return this.signatureType;
    const key = String(this.signatureType || 'EOA').trim().toUpperCase();
    if (_SignatureType?.[key] !== undefined) return _SignatureType[key];
    // Common aliases
    if (key === 'PROXY' && _SignatureType?.POLY_PROXY !== undefined) return _SignatureType.POLY_PROXY;
    if ((key === 'SAFE' || key === 'GNOSIS') && _SignatureType?.GNOSIS_SAFE !== undefined) return _SignatureType.GNOSIS_SAFE;
    if ((key === '1271' || key === 'POLY1271') && _SignatureType?.POLY_1271 !== undefined) return _SignatureType.POLY_1271;
    return _SignatureType.EOA;
  }

  async _resolveProxyWalletFromProfile() {
    if (!this.walletAddress) return null;
    try {
      const url = `https://gamma-api.polymarket.com/public-profile?address=${encodeURIComponent(this.walletAddress)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      const proxy = data?.proxyWallet || null;
      if (proxy && /^0x[a-fA-F0-9]{40}$/.test(proxy)) return proxy;
      return null;
    } catch (_) {
      return null;
    }
  }

  async initialize() {
    try {
      const ClobClient = await getClobClient();
      const chain = _Chain.POLYGON;
      const host = 'https://clob.polymarket.com';
      if (this.privateKey && this.walletAddress) {
        // SDK v2 requires an ethers.js Wallet signer — raw private key string is rejected
        // with "unsupported signer type". Wrap the key in an ethers v6 Wallet first.
        const signer = await getEthersSigner(this.privateKey);

        const resolvedSignatureType = this._resolveSignatureType();
        const profileProxy = await this._resolveProxyWalletFromProfile();
        const isDepositFlow =
          String(this.signatureType || '').toUpperCase() === 'POLY_1271' ||
          resolvedSignatureType === _SignatureType.POLY_1271;
        // For deposit flow, prefer proxy/deposit wallet as funder.
        const resolvedFunder = this.funderAddress || (isDepositFlow ? profileProxy : null) || this.walletAddress;

        // Step 1: Create a temporary L1-only client to derive API key credentials.
        // createAndPostOrder requires L2 (HMAC) auth using API key creds, in addition
        // to the wallet signer. Derive them from the private key via the CLOB API.
        const l1Client = new ClobClient({
          host,
          chain,
          signer,
          signatureType: resolvedSignatureType,
          funderAddress: resolvedFunder,
          throwOnError: true,
        });

        let creds;
        try {
          creds = await l1Client.deriveApiKey();
          console.log('[PolymarketFeed] API key derived successfully');
        } catch (e) {
          console.warn('[PolymarketFeed] deriveApiKey failed, trying createApiKey:', e.message);
          try {
            creds = await l1Client.createApiKey();
            console.log('[PolymarketFeed] API key created successfully');
          } catch (e2) {
            console.error('[PolymarketFeed] Could not get API key credentials:', e2.message);
            throw new Error(`Failed to obtain CLOB API credentials: ${e2.message}`);
          }
        }

        // Step 2: Create the fully-authenticated client with both signer + API key creds.
        const geoToken = this.geoBlockToken || undefined;
        const builderConfig = this.builderCode ? { builderCode: this.builderCode } : undefined;
        if (this.clobProxyUrl) {
          console.log(`[PolymarketFeed] Proxy mode: order POSTs will route through ${this.clobProxyUrl}`);
        } else if (geoToken) {
          console.log('[PolymarketFeed] Using geo_block_token');
        } else {
          console.warn('[PolymarketFeed] No geo_block_token or proxy set — orders may 403 from geo-blocked regions');
        }
        // Store signer + creds for proxy-mode order posting (bypasses SDK's internal axios)
        this._signer = signer;
        this._creds = creds;
        this.clobClient = new ClobClient({
          host,
          chain,
          signer,
          creds, // { key, secret, passphrase } — required for L2 (order placement)
          signatureType: resolvedSignatureType,
          funderAddress: resolvedFunder, // wallet that funds the orders
          builderConfig,
          throwOnError: true,
        });
        this._geoToken = geoToken;
        console.log(`[PolymarketFeed] CLOB client initialized (authenticated ${this.signatureType} + API key, funder=${resolvedFunder})`);
      } else {
        this.clobClient = new ClobClient({ host, chain });
        console.log('[PolymarketFeed] CLOB client initialized (read-only)');
      }
    } catch (err) {
      console.error('[PolymarketFeed] Failed to initialize CLOB client:', err.message);
      throw err;
    }
  }

  async fetchActiveBTCMarkets() {
    const nowUTC = Date.now();
    if (this.marketsCache.length > 0 && this.lastMarketFetch &&
        (nowUTC - this.lastMarketFetch) < this.marketCacheTTL) {
      return this.marketsCache;
    }

    // Primary: CLOB getMarkets — filter by time remaining (290–610s = 5-min window)
    const fromCLOB = await this._getActiveBTCMarkets();
    if (fromCLOB.length > 0) {
      this.marketsCache = fromCLOB;
      this.lastMarketFetch = nowUTC;
      this.marketCacheTTL = 30000;
      return fromCLOB;
    }

    // Fallback: Gamma /markets sorted by end_date ascending (no 422 on /markets endpoint)
    const fromGamma = await this._fetchGammaShortWindow();
    if (fromGamma.length > 0) {
      this.marketsCache = fromGamma;
      this.lastMarketFetch = nowUTC;
      this.marketCacheTTL = 15000; // 15s — re-check frequently so new windows are picked up fast
      return fromGamma;
    }

    this.marketCacheTTL = 10000;
    this.lastMarketFetch = nowUTC;
    this.marketsCache = [];
    console.log('[PolymarketFeed] No active BTC markets found');
    return [];
  }

  /**
   * CLOB getMarkets — paginate and filter by time remaining.
   * 5-min windows: MIN_5MIN_DURATION (290s) to MAX_5MIN_DURATION (615s) remaining.
   */
  async _getActiveBTCMarkets() {
    // CLOB getMarkets() only returns historical markets (2023) — skip entirely.
    // 5-min BTC markets are found via slug lookup in _fetchGammaShortWindow.
    return [];
  }

  /**
   * Gamma market discovery — no order= params (causes 422).
   * S0: slug lookup — btc-updown-5m-<epochSec> for current + adjacent windows
   * S1: end_date_min/max — directly query markets ending in next 10 min
   * S2: accepting_orders=true — markets currently open for trading
   * S3: paginated plain active scan — log everything ending <1h
   */
  async _fetchGammaShortWindow() {
    const nowUTC = Date.now();
    const nowSec = Math.floor(nowUTC / 1000);

    const _endMs = (m) => {
      // Gamma list uses endDate (full ISO) and endDateIso (date-only "2026-04-03" — useless).
      // Must check endDate BEFORE endDateIso to avoid parsing date-only as midnight UTC.
      const raw = m.end_date_iso || m.endDate || m.endDateIso;
      if (!raw) return 0;
      const s = typeof raw === 'string' ? raw : String(raw);
      // Skip if date-only string (no time component) — would resolve to midnight UTC
      if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return 0;
      return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime();
    };

    const _normalise = (m) => this._normaliseMarket(m, nowSec, false, true);

    // ── Strategy 0 + 1 combined: collect ALL active BTC markets ─────────────────
    // S0: slug-based lookup for exactly-aligned 5-min windows
    // S1: end_date_min/max sweep for all markets ending in next 30 min
    // Both run always — S0 alone misses markets with non-slug-aligned windows
    // (e.g. 1:30-1:45, 1:35-1:40 that exist alongside the boundary-only slug market)
    const seenIds = new Set();
    const collected = [];

    const windowBase = Math.floor(nowSec / 300) * 300;
    const assetList = this._assets || ['btc'];
    const slugProbes = [];
    for (const asset of assetList) {
      const def = ASSET_DEFS[asset];
      if (!def) continue;
      for (const t of [windowBase, windowBase + 300, windowBase - 300]) {
        slugProbes.push(`${def.prefix}-${t}`);
      }
    }
    for (const slug of slugProbes) {
      try {
        const res = await fetch(`https://gamma-api.polymarket.com/markets/slug/${slug}`,
          { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const m = await res.json();
          const endMs = _endMs(m);
          console.log(`[PolymarketFeed] Slug ${slug} → "${(m.question||'').trim().slice(0,55)}" | ends in ${endMs ? ((endMs-nowUTC)/1000).toFixed(0)+'s' : '?'}`);
          if (endMs > nowUTC) {
            const norm = _normalise(m);
            if (norm) {
              const id = norm.id || norm.conditionId;
              if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(norm); }
            }
          }
        } else if (res.status !== 404) {
          console.warn(`[PolymarketFeed] Slug ${slug} HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn(`[PolymarketFeed] Slug ${slug} failed: ${e.message}`);
      }
    }

    // ── Strategy 1: end_date_min/max — 30-min window to catch all active markets ─
    const endMin = new Date(nowUTC).toISOString();
    const endMax = new Date(nowUTC + 30 * 60 * 1000).toISOString();
    try {
      const url = `https://gamma-api.polymarket.com/markets?end_date_min=${endMin}&end_date_max=${endMax}&active=true&closed=false&limit=100`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const markets = await res.json();
        if (Array.isArray(markets) && markets.length > 0) {
          // Accept: true 5-min BTC markets (btc-updown-5m-* slug) OR short-window BTC
          // up/down markets (≤15 min duration) in their last 5 min before expiry.
          // Reject: hourly/daily markets — wrong timeframe, no edge.
          const btc = markets.filter(m => {
            const q = (m.question || '').toLowerCase();
            const slug = (m.slug || '').toLowerCase();
            const asset = assetFromSlugOrQuestion(slug, q);
            const isUpDown = asset != null && (this._assets || ['btc']).includes(asset) && q.includes('up or down');
            if (!isUpDown) return false;
            // True 5-min slug: always accept
            if (Object.values(ASSET_DEFS).some((d) => slug.startsWith(d.prefix + '-'))) return true;
            // Non-slug BTC up/down: must verify it's a short-window market.
            // Compute actual duration from startDate/endDate if available.
            const endMs = _endMs(m);
            if (!endMs || endMs <= nowUTC) return false;
            const secsRemaining = (endMs - nowUTC) / 1000;
            // Check duration: only accept if market is ≤15 min total (900s).
            // Use startDate if available; otherwise infer from question time range.
            const startRaw = m.startDate || m.start_date_iso || m.startDateIso;
            if (startRaw && !/^\d{4}-\d{2}-\d{2}$/.test(String(startRaw).trim())) {
              const startMs = new Date(String(startRaw).includes('Z') || String(startRaw).includes('+') ? startRaw : startRaw + 'Z').getTime();
              const durationSec = (endMs - startMs) / 1000;
              if (durationSec > 900) return false; // reject hourly/daily markets
            } else {
              // No reliable start date — check question for time-range pattern (e.g. "4:45PM-5:00PM")
              // If question only has a single time (e.g. "4PM ET") it's likely hourly — reject.
              const hasTimeRange = /\d{1,2}:\d{2}(am|pm).{0,5}\d{1,2}:\d{2}(am|pm)/i.test(m.question || '');
              if (!hasTimeRange) return false;
            }
            // Short-window market: only trade in the last 5 min
            return secsRemaining <= 300;
          });
          console.log(`[PolymarketFeed] S1 found ${btc.length} BTC market(s) in next 30 min (5-min or last-5-min-of-longer)`);
          for (const m of btc) {
            const norm = _normalise(m);
            if (norm) {
              const id = norm.id || norm.conditionId;
              if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(norm); }
              continue;
            }
            // _normalise rejected it — build directly from Gamma data
            const endMs = _endMs(m);
            if (!endMs || endMs <= nowUTC) continue;
            const tokens = m.tokens || [];
            let clobIds = m.clobTokenIds || m.clob_token_ids;
            if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(e) { clobIds = []; } }
            if (!clobIds || !clobIds.length) clobIds = tokens.map(t => t.token_id || t.tokenId).filter(Boolean);
            const direct = {
              ...m,
              id: m.id || m.conditionId || m.condition_id,
              question: m.question || m.title || '',
              tokens,
              clobTokenIds: clobIds || [],
              end_date_iso: new Date(endMs).toISOString(),
              start_date_iso: new Date(endMs - 300000).toISOString(),
            };
            const id = direct.id;
            if (id && !seenIds.has(id)) { seenIds.add(id); collected.push(direct); }
          }
        }
      } else {
        console.warn(`[PolymarketFeed] S1 end_date HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn('[PolymarketFeed] S1 failed:', e.message);
    }

    if (collected.length > 0) {
      console.log(`[PolymarketFeed] Discovery complete: ${collected.length} BTC market(s) — ${collected.map(m=>(m.question||'').slice(20,45)).join(' | ')}`);
    }
    return collected;
  }

  /**
   * Normalise a raw market object from any API into a consistent shape.
   * Returns null if the market doesn't match our 5-min BTC criteria.
   * @param {boolean} isBTCParent - skip BTC keyword check when parent event is known-BTC
   * @param {boolean} skipDurationCheck - skip duration filter (for accepting_orders=true results)
   */
  _normaliseMarket(m, nowSec, isBTCParent = false, skipDurationCheck = false) {
    const _asset = assetFromSlugOrQuestion(m.slug, m.question || m.title);
    if (!isBTCParent) {
      if (_asset == null || !(this._assets || ['btc']).includes(_asset)) return null;
    }
    m._asset = _asset || 'btc';

    // Accept active, accepting_orders, or just not-closed markets
    if (m.archived) return null;

    // Parse end date — Gamma uses endDate (full ISO) + endDateIso (date-only, useless for time).
    // Must check endDate BEFORE endDateIso. CLOB uses end_date_iso (snake_case).
    const _ts = (v) => {
      if (!v) return 0;
      if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 0; // date-only → skip
      return new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z').getTime();
    };
    const rawEnd = m.end_date_iso || m.endDate || m.endDateIso || m.resolution_time || m.end_time;
    if (!rawEnd) return null;
    const endMs = _ts(rawEnd);
    if (isNaN(endMs)) return null;
    const endSec = Math.floor(endMs / 1000);

    // Must still be open
    if (endSec <= nowSec) return null;
    // Must end within 2 hours (wide enough for "next window" pre-loading)
    if ((endSec - nowSec) > 7200) return null;

    // Parse start date
    // For Gamma markets (skipDurationCheck=true): Gamma's startDate = market CREATION time (can be
    // days before the 5-min window), NOT the window start. Force startSec = endSec - 300.
    // For CLOB markets: use the actual start field if valid and within a 10-min window.
    let startSec;
    if (skipDurationCheck) {
      startSec = endSec - 300; // Always 5-min window for slug/Gamma results
    } else {
      const rawStart = m.start_date_iso || m.startDate || m.startDateIso || m.start_time;
      startSec = rawStart ? Math.floor(_ts(rawStart) / 1000) : endSec - 300;
      if (!startSec || isNaN(startSec)) startSec = endSec - 300;
    }

    const durationSec = endSec - startSec;
    if (!skipDurationCheck && (durationSec <= 0 || durationSec > 600)) return null;

    // Normalise token IDs
    const tokens = m.tokens || [];
    let clobIds = m.clobTokenIds || m.clob_token_ids || tokens.map(t => t.token_id);
    if (typeof clobIds === 'string') {
      try { clobIds = JSON.parse(clobIds); } catch (e) { clobIds = []; }
    }

    return {
      ...m,
      id: m.id || m.conditionId || m.condition_id,
      asset: m._asset || 'btc',
      question: m.question || m.title || '',
      tokens,
      clobTokenIds: clobIds,
      end_date_iso: new Date(endMs).toISOString(),
      start_date_iso: new Date(startSec * 1000).toISOString(),
    };
  }

  /** Multi-asset switchboard — array of asset keys ('btc','eth',…) from asset_config. */
  setAssets(assets) {
    this._assets = Array.isArray(assets) && assets.length ? assets : ['btc'];
  }

  /**
   * Fetch REAL order book data from Polymarket CLOB with short-TTL cache.
   * Returns: { bestBid, bestAsk, bidDepth, askDepth, largestBid, largestAsk, totalDepth, spread, midPrice }
   * All prices are 0-1 (token probability scale)
   */
  async getOrderBook(tokenId) {
    if (!this.clobClient) {
      console.error('[PolymarketFeed] CLOB client not initialized');
      return null;
    }

    // Sub-second cache for high-frequency reads
    const cached = this.orderBookCache[tokenId];
    if (cached && (Date.now() - cached.ts) < this.orderBookCacheTTL) {
      return cached.book;
    }

    try {
      const book = await this.clobClient.getOrderBook(tokenId);
      const bids = book.bids || [];
      const asks = book.asks || [];

      if (bids.length === 0 && asks.length === 0) {
        console.warn(`[PolymarketFeed] Empty order book for token ${tokenId}`);
        return null;
      }

      // The CLOB API does not guarantee best-first arrays. In practice it can
      // return bids ascending and asks descending, placing 0.01/0.99 boundary
      // orders first. Taking index 0 manufactured a 98-cent spread and made
      // otherwise executable paper signals appear unfillable.
      const normalizeLevels = (levels, descending) => levels
        .map((level) => ({ price: parseFloat(level.price), size: parseFloat(level.size) }))
        .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size)
          && level.price > 0 && level.price <= 1 && level.size > 0)
        .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
      const bidLevels = normalizeLevels(bids, true);
      const askLevels = normalizeLevels(asks, false);
      const bidDepth = bidLevels.reduce((sum, level) => sum + level.size, 0);
      const askDepth = askLevels.reduce((sum, level) => sum + level.size, 0);
      const bestBid = bidLevels[0]?.price ?? null;
      const bestAsk = askLevels[0]?.price ?? null;
      const largestBid = bidLevels.length > 0 ? Math.max(...bidLevels.map((level) => level.size)) : 0;
      const largestAsk = askLevels.length > 0 ? Math.max(...askLevels.map((level) => level.size)) : 0;
      const bestBidUsd = bidLevels[0] ? bidLevels[0].price * bidLevels[0].size : 0;
      const bestAskUsd = askLevels[0] ? askLevels[0].price * askLevels[0].size : 0;

      const result = {
        bestBid,
        bestAsk,
        bidDepth,
        askDepth,
        bestBidUsd,
        bestAskUsd,
        bidLevels,
        askLevels,
        largestBid,
        largestAsk,
        totalDepth: bidDepth + askDepth,
        bidCount: bidLevels.length,
        askCount: askLevels.length,
        spread: bestAsk != null && bestBid != null ? bestAsk - bestBid : null,
        midPrice: bestAsk != null && bestBid != null ? (bestAsk + bestBid) / 2 : null,
      };

      this.orderBookCache[tokenId] = { book: result, ts: Date.now() };
      return result;
    } catch (err) {
      console.error(`[PolymarketFeed] getOrderBook failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /** Get live token price from CLOB order book.
   * Returns null if the book has only boundary orders (bid=0.01/ask=0.99)
   * so callers can fall back to Gamma API outcomePrices. */
  async getLiveTokenPrice(tokenId) {
    try {
      const book = await this.getOrderBook(tokenId);
      if (!book || book.midPrice == null) return null;
      // Boundary-only books (spread > 90%) yield a meaningless midPrice of 0.5.
      // Return null so the caller uses a better source (Gamma outcomePrices).
      const spread = book.spread ?? (book.bestAsk - book.bestBid);
      if (spread != null && spread > 0.90) return null;
      return book.midPrice;
    } catch (err) {
      console.error(`[PolymarketFeed] getLiveTokenPrice failed for ${tokenId}:`, err.message);
      return null;
    }
  }

  /** Fetch current YES token price from Gamma API outcomePrices.
   * Use when CLOB book is boundary-only. clobTokenIds[0] = YES token.
   * If Gamma returns exactly 0.5/0.5 (stale/ambiguous), falls back to
   * the CLOB lastTradePrice which reflects actual fills. */
  async getLivePriceFromGamma(marketId, tokenId) {
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/markets/${marketId}`,
        { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return null;
      const m = await r.json();
      let op = m.outcomePrices;
      if (typeof op === 'string') { try { op = JSON.parse(op); } catch(_) { return null; } }
      if (!Array.isArray(op) || op.length < 2) return null;
      // Match tokenId to clobTokenIds to find which index is ours
      let clobIds = m.clobTokenIds;
      if (typeof clobIds === 'string') { try { clobIds = JSON.parse(clobIds); } catch(_) { clobIds = []; } }
      const idx = clobIds?.indexOf(tokenId);
      const price = idx >= 0 ? parseFloat(op[idx]) : parseFloat(op[0]);
      if (!isNaN(price) && price > 0.02 && price < 0.98) {
        // Gamma sometimes returns exactly 0.5 for both outcomes — this is stale/ambiguous.
        // Fall through to CLOB lastTradePrice in that case.
        const p0 = parseFloat(op[0]), p1 = parseFloat(op[1]);
        const isAmbiguous = Math.abs(p0 - 0.5) < 0.002 && Math.abs(p1 - 0.5) < 0.002;
        if (!isAmbiguous) return price;
      }
      // Gamma price ambiguous or out of range — try CLOB lastTradePrice
      if (tokenId) {
        try {
          const lr = await fetch(`https://clob.polymarket.com/last-trade-price?token_id=${tokenId}`,
            { signal: AbortSignal.timeout(3000) });
          if (lr.ok) {
            const ld = await lr.json();
            const lp = parseFloat(ld?.price);
            if (!isNaN(lp) && lp >= 0 && lp <= 1) {
              console.log(`[PolymarketFeed] Gamma ambiguous — CLOB lastTrade: ${lp.toFixed(3)}`);
              return lp;
            }
          }
        } catch (_) {}
      }
      return null;
    } catch (_) { return null; }
  }

  /**
   * Fetch the last traded price for a token from the CLOB.
   * This is the REAL execution price for 5-min BTC markets — the order book
   * shows boundary orders (0.01/0.99) but trades happen at the last traded price (~0.505).
   * Returns price as 0–1 float, or null if unavailable/invalid.
   */
  async getLastTradePrice(tokenId) {
    try {
      const res = await fetch(
        `https://clob.polymarket.com/lastTradePrice?token_id=${tokenId}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) {
        console.warn(`[PolymarketFeed] lastTradePrice HTTP ${res.status} for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      let data;
      try { data = await res.json(); } catch (_) {
        console.warn(`[PolymarketFeed] lastTradePrice non-JSON response for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      const p = parseFloat(data?.price);
      if (!isFinite(p) || p < 0 || p > 1) {
        console.warn(`[PolymarketFeed] lastTradePrice invalid: ${data?.price} for ${tokenId?.slice(0,12)}...`);
        return null;
      }
      return p;
    } catch (err) {
      console.warn(`[PolymarketFeed] getLastTradePrice failed for ${tokenId?.slice(0,12)}...: ${err.message}`);
      return null;
    }
  }

  /** Fetch USDC balance for a wallet */
  static async fetchBalance(privateKey, walletAddress, signatureType = 'EOA', funderAddress = null) {
    try {
      const ClobClient = await getClobClient();
      const signer = await getEthersSigner(privateKey);
      const resolvedFunder = funderAddress || walletAddress;
      const resolveSig = () => {
        if (typeof signatureType === 'number') return signatureType;
        const key = String(signatureType || 'EOA').trim().toUpperCase();
        if (_SignatureType?.[key] !== undefined) return _SignatureType[key];
        if (key === 'PROXY' && _SignatureType?.POLY_PROXY !== undefined) return _SignatureType.POLY_PROXY;
        if ((key === 'SAFE' || key === 'GNOSIS') && _SignatureType?.GNOSIS_SAFE !== undefined) return _SignatureType.GNOSIS_SAFE;
        if ((key === '1271' || key === 'POLY1271') && _SignatureType?.POLY_1271 !== undefined) return _SignatureType.POLY_1271;
        return _SignatureType.EOA;
      };
      const resolvedSignatureType = resolveSig();
      const l1Client = new ClobClient({
        host: 'https://clob.polymarket.com',
        chain: _Chain.POLYGON,
        signer,
        signatureType: resolvedSignatureType,
        funderAddress: resolvedFunder,
        throwOnError: true,
      });
      let creds;
      try {
        creds = await l1Client.deriveApiKey();
      } catch (_) {
        creds = await l1Client.createApiKey();
      }
      const client = new ClobClient({
        host: 'https://clob.polymarket.com',
        chain: _Chain.POLYGON,
        signer,
        creds,
        signatureType: resolvedSignatureType,
        funderAddress: resolvedFunder,
        throwOnError: true,
      });
      const result = await client.getBalanceAllowance({ asset_type: _AssetType.COLLATERAL });
      const raw = result?.balance ?? result?.usdc_balance ?? result;
      let usdc = parseFloat(raw);
      // Some CLOB responses return collateral in base units (6 decimals),
      // e.g. "15000000" for 15.00 USDC/pUSD.
      if (Number.isFinite(usdc) && Number.isInteger(usdc) && usdc >= 1000000) {
        usdc = usdc / 1e6;
      }
      if (!Number.isFinite(usdc)) {
        throw new Error(`Invalid balance payload: ${JSON.stringify(result)}`);
      }
      return { usdc, wallet: walletAddress };
    } catch (err) {
      console.error('[PolymarketFeed] fetchBalance failed:', err.message);
      return { usdc: null, wallet: walletAddress };
    }
  }

  /**
   * Place a GTC limit order at the last traded price.
   *
   * Polymarket 5-min BTC markets always show a 98% book spread (boundary orders at
   * 0.01/0.99). Real fills happen at the lastTradePrice (~0.505). Submitting a limit
   * order at lastTradePrice + 0.01 (buy) rests on the book at fair value and gets
   * filled by counter-parties — exactly how the UI works.
   *
   * A FOK "market order" at 0.99 would fill at 0.99 (terrible).
   * A FOK at 0.55 would return FOK_ORDER_NOT_FILLED_ERROR (nothing between 0.55-0.99).
   * GTC at lastTradePrice is the correct approach.
   *
   * @param {string} tokenId    - Conditional token ID
   * @param {string} side       - 'BUY' or 'SELL'
   * @param {number} dollarSize - BUY: USDC to spend. SELL: USDC notional at fairPrice (e.g. shares×fairPrice);
   *                               token qty = dollarSize/fairPrice — must NOT be recomputed from limitPrice
   *                               when SELL limit is tick-floored below fairPrice or balance errors occur.
   * @param {number} fairPrice  - Reference price (0–1) for sizing; limit tick is derived from this separately.
   */
  async placeOrder(tokenId, side, dollarSize, fairPrice) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for trading');

    await getClobClient();
    const Side = _Side;
    const OrderType = _OrderType;

    // Snap to 0.01 tick grid — caller (_executeTrade) already applied directional tick offset.
    // For SELL: floor to tick. For BUY: ceil to tick (no extra +1 — caller added it already).
    const TICK = 0.01;
    let limitPrice;
    if (side === 'SELL') {
      limitPrice = Math.max(0.01, parseFloat((Math.floor(fairPrice / TICK) * TICK).toFixed(2)));
    } else {
      limitPrice = Math.min(0.99, parseFloat((Math.ceil(fairPrice / TICK) * TICK).toFixed(2)));
    }

    // size = token quantity (CLOB limit orders use token qty, not dollar amount)
    // Polymarket enforces a minimum of 5 tokens per order.
    const MIN_TOKEN_SIZE = 5;
    let tokenSize;
    if (side === 'SELL') {
      // Token amount must match wallet: callers pass dollarSize ≈ shares×fairPrice.
      // limitPrice is tick-floored ≤ fairPrice → dollarSize/limitPrice would over-count tokens.
      const refPx =
        Number.isFinite(fairPrice) && fairPrice > 0 ? fairPrice : limitPrice;
      tokenSize = parseFloat((dollarSize / refPx).toFixed(2));
    } else {
      tokenSize = parseFloat((dollarSize / limitPrice).toFixed(2));
    }
    if (!isFinite(tokenSize) || tokenSize <= 0) {
      throw new Error(`Invalid token size: dollarSize=${dollarSize} limitPrice=${limitPrice} → tokenSize=${tokenSize}`);
    }
    if (tokenSize < MIN_TOKEN_SIZE) {
      const was = tokenSize;
      tokenSize = MIN_TOKEN_SIZE;
      console.log(`[PolymarketFeed] tokenSize floored to minimum ${MIN_TOKEN_SIZE} (was ${was})`);
    }

    const sideEnum = side === 'SELL' ? Side.SELL : Side.BUY;

    console.log(`[PolymarketFeed] Placing GTC limit: ${side} ${tokenSize} tokens @ ${limitPrice} (fairPrice=${fairPrice}, ~$${dollarSize}) token=${tokenId?.slice(0,12)}...`);

    try {
      let resp;

      if (this.clobProxyUrl && this._signer && this._creds && _orderToJsonV2 && _createL2Headers) {
        // Relay mode: sign the order locally (L1, no network), then POST the signed
        // payload to clob-relay.js running on the user's local VPN machine.
        // The relay forwards it verbatim to clob.polymarket.com — bypassing the
        // Render Frankfurt geo-block without needing an HTTP CONNECT proxy.
        const signedOrder = await this.clobClient.createOrder(
          { tokenID: tokenId, side: sideEnum, price: limitPrice, size: tokenSize },
          { tickSize: '0.01', negRisk: false }
        );
        const orderPayload = _orderToJsonV2(signedOrder, this._creds.key || '', OrderType.GTC, false, false);
        // Stringify ONCE — use the same string for both HMAC signing and the HTTP body.
        // Re-stringifying the parsed object may produce different key order → HMAC mismatch.
        const bodyStr = JSON.stringify(orderPayload);
        // Sign over the exact path the CLOB server will see — including geo_block_token query param if present.
        // HMAC mismatch ("incorrect header check") happens when signed path ≠ actual request path.
        const signedPath = this._geoToken ? `/order?geo_block_token=${this._geoToken}` : '/order';
        const l2HeaderArgs = { method: 'POST', requestPath: signedPath, body: bodyStr };
        // Use cached clock skew to avoid a round-trip to getServerTime() on every order.
        // Skew is refreshed every 5 minutes — Render's NTP-synced clock is stable.
        const nowMs = Date.now();
        if (nowMs - this._clockSkewFetchedAt > 5 * 60 * 1000) {
          try {
            const raw = await this.clobClient.getServerTime();
            const serverTs = typeof raw === 'number' ? raw : parseInt(raw, 10);
            if (!isNaN(serverTs)) {
              this._clockSkew = serverTs - Math.floor(nowMs / 1000);
              this._clockSkewFetchedAt = nowMs;
              if (Math.abs(this._clockSkew) > 2) {
                console.log(`[PolymarketFeed] Clock skew updated: ${this._clockSkew}s`);
              }
            }
          } catch (_) { /* keep previous skew */ }
        }
        const serverTs = Math.floor(nowMs / 1000) + this._clockSkew;
        const headers = await _createL2Headers(this._signer, this._creds, l2HeaderArgs, serverTs);
        console.log(`[PolymarketFeed] L2 headers: POLY_TIMESTAMP=${headers.POLY_TIMESTAMP} key=${headers.POLY_API_KEY?.slice(0,8)}...`);
        headers['Content-Type'] = 'application/json';
        headers['Accept'] = '*/*';
        headers['User-Agent'] = '@polymarket/clob-client-v2';
        // localtunnel requires this header to bypass the browser-password interstitial
        headers['bypass-tunnel-reminder'] = 'true';

        // POST to relay — relay URL is e.g. https://polybot-relay.loca.lt
        // Path includes /order and optional geo_block_token query param
        const relayBase = this.clobProxyUrl.replace(/\/$/, '');
        const relayUrl = `${relayBase}/order${this._geoToken ? `?geo_block_token=${this._geoToken}` : ''}`;
        console.log(`[PolymarketFeed] Relay POST → ${relayUrl}`);
        const axiosResp = await withRelayLock(relayBase, () =>
          axios.post(relayUrl, bodyStr, { headers, timeout: 15000 })
        );
        resp = axiosResp.data;
        console.log(`[PolymarketFeed] Relay order response: ${JSON.stringify(resp)}`);
      } else {
        // Direct mode: use the SDK's built-in axios (works when not geo-blocked)
        resp = await this.clobClient.createAndPostOrder(
          { tokenID: tokenId, side: sideEnum, price: limitPrice, size: tokenSize },
          { tickSize: '0.01', negRisk: false },
          OrderType.GTC
        );
        console.log(`[PolymarketFeed] Order response: ${JSON.stringify(resp)}`);
      }

      if (resp?.status === 403 || resp?.errorMsg || resp?.error) {
        throw new Error(`CLOB rejected order: ${JSON.stringify(resp)}`);
      }
      console.log(`[PolymarketFeed] Order placed: orderId=${resp?.orderID ?? resp?.order_id} status=${resp?.status}`);
      return { ...resp, price: limitPrice };
    } catch (err) {
      // Log full response body for 4xx errors — the message alone is not enough
      if (err.response) {
        console.error(`[PolymarketFeed] placeOrder failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      } else {
        console.error(`[PolymarketFeed] placeOrder failed:`, err.message);
      }
      const errBody = JSON.stringify(err?.response?.data || err?.message || err);
      const makerNotAllowed = /maker address not allowed|deposit wallet flow/i.test(errBody);
      const usingEOA =
        String(this.signatureType || '').toUpperCase() === 'EOA' ||
        this._resolveSignatureType() === _SignatureType.EOA;
      if (makerNotAllowed && usingEOA && !this._depositFlowFailoverTried) {
        this._depositFlowFailoverTried = true;
        console.warn('[PolymarketFeed] EOA maker rejected — attempting one-time deposit-wallet failover (POLY_1271)');
        // Switch to deposit-wallet flow and reinitialize client once.
        this.signatureType = 'POLY_1271';
        this.funderAddress = await this._resolveProxyWalletFromProfile() || this.funderAddress || this.walletAddress;
        await this.initialize();
        return await this.placeOrder(tokenId, side, dollarSize, fairPrice);
      }
      throw err;
    }
  }

  /**
   * Market-style BUY: spend up to `dollarAmountUSDC` USDC at the current book (FAK).
   * FAK fills everything immediately available; unfilled remainder is cancelled (no resting order).
   */
  async placeMarketBuyOrder(tokenId, dollarAmountUSDC, worstPrice = null, executionInfo = null) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for trading');

    await getClobClient();
    const Side = _Side;
    const OrderType = _OrderType;

    const userMarketOrder = buildMarketBuyOrder(
      tokenId, dollarAmountUSDC, worstPrice, Side, OrderType,
    );
    const parsedWorstPrice = userMarketOrder.price ?? null;
    // H53 supplies freshly verified market metadata. Preserve the established
    // options for legacy callers so this hardening cannot alter other live
    // order paths as a side effect.
    const options = executionInfo
      ? { tickSize: String(executionInfo.tickSize), negRisk: Boolean(executionInfo.negRisk) }
      : { tickSize: '0.01', negRisk: false };

    console.log(
      `[PolymarketFeed] Placing FAK market BUY: ~$${dollarAmountUSDC} USDC` +
      `${parsedWorstPrice == null ? '' : ` worst=${parsedWorstPrice}`} token=${tokenId?.slice(0, 12)}...`
    );

    try {
      let resp;

      if (this.clobProxyUrl && this._signer && this._creds && _orderToJsonV2 && _createL2Headers) {
        const signedOrder = await this.clobClient.createMarketOrder(userMarketOrder, options);
        const orderPayload = _orderToJsonV2(signedOrder, this._creds.key || '', OrderType.FAK, false, false);
        const bodyStr = JSON.stringify(orderPayload);
        const signedPath = this._geoToken ? `/order?geo_block_token=${this._geoToken}` : '/order';
        const l2HeaderArgs = { method: 'POST', requestPath: signedPath, body: bodyStr };
        const nowMs = Date.now();
        if (nowMs - this._clockSkewFetchedAt > 5 * 60 * 1000) {
          try {
            const raw = await this.clobClient.getServerTime();
            const serverTs = typeof raw === 'number' ? raw : parseInt(raw, 10);
            if (!isNaN(serverTs)) {
              this._clockSkew = serverTs - Math.floor(nowMs / 1000);
              this._clockSkewFetchedAt = nowMs;
            }
          } catch (_) { /* keep */ }
        }
        const serverTs = Math.floor(nowMs / 1000) + this._clockSkew;
        const headers = await _createL2Headers(this._signer, this._creds, l2HeaderArgs, serverTs);
        headers['Content-Type'] = 'application/json';
        headers['Accept'] = '*/*';
        headers['User-Agent'] = '@polymarket/clob-client-v2';
        headers['bypass-tunnel-reminder'] = 'true';

        const relayBase = this.clobProxyUrl.replace(/\/$/, '');
        const relayUrl = `${relayBase}/order${this._geoToken ? `?geo_block_token=${this._geoToken}` : ''}`;
        const axiosResp = await withRelayLock(relayBase, () =>
          axios.post(relayUrl, bodyStr, { headers, timeout: 15000 })
        );
        resp = axiosResp.data;
        console.log(`[PolymarketFeed] Relay market order response: ${JSON.stringify(resp)}`);
      } else {
        resp = await this.clobClient.createAndPostMarketOrder(userMarketOrder, options, OrderType.FAK);
        console.log(`[PolymarketFeed] Market order response: ${JSON.stringify(resp)}`);
      }

      if (resp?.status === 403 || resp?.success === false || resp?.errorMsg || resp?.error) {
        throw new Error(`CLOB rejected market order: ${JSON.stringify(resp)}`);
      }
      return resp;
    } catch (err) {
      if (err.response) {
        console.error(
          `[PolymarketFeed] placeMarketBuyOrder failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
        );
      } else {
        console.error(`[PolymarketFeed] placeMarketBuyOrder failed:`, err.message);
      }
      throw err;
    }
  }

  /**
   * Fetch authoritative execution metadata and verify the token belongs to the
   * requested condition. Besides protecting fee/tick assumptions, supplying
   * the condition directly primes the SDK cache without its extra
   * markets-by-token lookup on the order path.
   */
  async fetchMarketExecutionInfo(conditionId, tokenId) {
    if (!this.clobClient) throw new Error('CLOB client not initialized for market metadata');
    if (!conditionId || !tokenId) throw new Error('conditionId and tokenId are required');
    const info = await this.clobClient.getClobMarketInfo(conditionId);
    const tokens = Array.isArray(info?.t) ? info.t : [];
    const tokenVerified = tokens.some((token) => String(token?.t) === String(tokenId));
    if (!tokenVerified) {
      throw new Error(`Token ${String(tokenId).slice(0, 12)} does not belong to condition ${conditionId}`);
    }
    return {
      conditionId,
      tokenId,
      tokenVerified,
      tickSize: String(info.mts),
      negRisk: info.nr === true,
      feeRate: parseFloat(info.fd?.r ?? 0),
      feeExponent: parseFloat(info.fd?.e ?? 0),
      feesEnabled: info.fd?.to === true,
      minOrderSize: info.mos == null ? null : parseFloat(info.mos),
      acceptingOrders: info.ao !== false,
    };
  }

  /** Raw CLOB order row (for avg fill / matched size after market buy). */
  async fetchOrder(orderId) {
    try {
      if (!this.clobClient) return null;
      return await this.clobClient.getOrder(orderId);
    } catch (err) {
      console.error(`[PolymarketFeed] fetchOrder failed for ${orderId}: ${err.message}`);
      return null;
    }
  }

  /**
   * Cancel a resting GTC limit order.
   * Returns true if the cancel request was accepted, false on error.
   */
  async cancelOrder(orderId) {
    try {
      if (!this.clobClient) throw new Error('CLOB client not initialized');
      await this.clobClient.cancelOrder({ orderID: orderId });
      console.log(`[PolymarketFeed] Order ${orderId} cancelled`);
      return true;
    } catch (err) {
      console.error(`[PolymarketFeed] cancelOrder failed for ${orderId}: ${err.message}`);
      return false;
    }
  }

  /**
   * Poll the status of a placed order.
   * Returns { status, sizeMatched, sizeTotal, isFilled, isPartial } or null on error.
   * status values: 'LIVE' (resting), 'MATCHED' (fully filled), 'CANCELLED'
   */
  async getOrderStatus(orderId) {
    try {
      if (!this.clobClient) throw new Error('CLOB client not initialized');
      const order = await this.clobClient.getOrder(orderId);
      if (!order) return null;
      const sizeMatched = parseFloat(order.size_matched ?? order.sizeMatched ?? 0);
      const sizeTotal   = parseFloat(order.size ?? order.original_size ?? 0);
      return {
        status:     order.status || 'UNKNOWN',
        sizeMatched,
        sizeTotal,
        isFilled:  order.status === 'MATCHED',
        isPartial: sizeMatched > 0 && sizeMatched < sizeTotal
      };
    } catch (err) {
      console.error(`[PolymarketFeed] getOrderStatus failed for ${orderId}: ${err.message}`);
      return null;
    }
  }
}

module.exports = PolymarketFeed;
module.exports.buildMarketBuyOrder = buildMarketBuyOrder;
