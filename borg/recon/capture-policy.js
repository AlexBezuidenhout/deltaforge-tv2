'use strict';

function csvSet(value) {
  const values = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return values.length ? new Set(values) : null;
}

function createCapturePolicy(env = process.env) {
  const assets = csvSet(env.BORG_CAPTURE_ASSETS);
  const marketTypes = csvSet(env.BORG_CAPTURE_MARKET_TYPES);
  const allowsAsset = (asset) => !assets || assets.has(String(asset || '').toLowerCase());
  const allowsMarket = (market) => allowsAsset(market?.asset)
    && (!marketTypes
      || marketTypes.has(String(market?.market_type || 'direction_5m').toLowerCase()));
  return {
    assets,
    marketTypes,
    allowsAsset,
    allowsMarket,
    filterAssets: (rows) => (rows || []).filter((row) => allowsAsset(row?.asset)),
    filterMarkets: (rows) => (rows || []).filter(allowsMarket),
    describe: () => ({
      assets: assets ? [...assets].sort() : ['*'],
      marketTypes: marketTypes ? [...marketTypes].sort() : ['*'],
    }),
  };
}

module.exports = { createCapturePolicy, csvSet };
