/**
 * Auto-redeem resolved Polymarket positions via Polygon.
 * Uses the same proxy-wallet pattern as Polymarket deposit flow (ProxyWalletFactory + CTF redeemPositions).
 * Collateral address comes from @polymarket/clob-client-v2 (pUSD on Polygon mainnet).
 */

const axios = require('axios');
const { ethers } = require('ethers');
const { pool } = require('../models/db');

const PROXY_WALLET_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const REDEEM_CLOSE_REASONS = ['MARKET_RESOLVED', 'MARKET_RESOLVED_TIMEOUT', 'SESSION_RESET_RESOLVED'];

const POLYGON_RPC_CANDIDATES = [
  process.env.POLYGON_RPC_URL,
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.drpc.org',
].filter(Boolean);

const CTF_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const PROXY_FACTORY_ABI = [
  'function proxy(tuple(address to, uint8 typeCode, bytes data, uint256 value)[] transactions) external',
];

function toConditionBytes32(conditionId) {
  const s = String(conditionId).trim();
  if (s.startsWith('0x')) {
    if (s.length !== 66) {
      return ethers.zeroPadValue(s, 32);
    }
    return ethers.zeroPadValue(s, 32);
  }
  try {
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(s)), 32);
  } catch {
    throw new Error(`Invalid condition id: ${conditionId}`);
  }
}

async function getWorkingProvider() {
  let lastErr;
  for (const url of POLYGON_RPC_CANDIDATES) {
    try {
      const provider = new ethers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      return { provider, rpcUrl: url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr ? lastErr.message : 'No Polygon RPC available');
}

async function loadContractConfig() {
  const { getContractConfig, Chain } = await import('@polymarket/clob-client-v2');
  return getContractConfig(Chain.POLYGON);
}

function encodeStandardRedeem(collateralAddress, conditionBytes32) {
  const iface = new ethers.Interface([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ]);
  return iface.encodeFunctionData('redeemPositions', [
    collateralAddress,
    ethers.ZeroHash,
    conditionBytes32,
    [1n, 2n],
  ]);
}

/**
 * Returns true if condition is finalized on-chain (payoutDenominator > 0).
 */
async function isConditionResolved(provider, ctfAddress, conditionBytes32) {
  const ctf = new ethers.Contract(ctfAddress, CTF_ABI, provider);
  const d = await ctf.payoutDenominator(conditionBytes32);
  return d > 0n;
}

async function fetchGammaNegRisk(marketId) {
  try {
    const { data } = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 8000 });
    return !!(data?.negRisk ?? data?.neg_risk ?? data?.enableNegRisk);
  } catch {
    return false;
  }
}

/**
 * Redeem via Polymarket ProxyWalletFactory (matches deposit / POLY_1271 flow).
 */
async function redeemViaProxy(privateKey, { conditionBytes32, cfg }) {
  const { provider } = await getWorkingProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const factory = new ethers.Contract(PROXY_WALLET_FACTORY, PROXY_FACTORY_ABI, wallet);

  const collateral = cfg.collateral;
  const data = encodeStandardRedeem(collateral, conditionBytes32);

  const target = cfg.conditionalTokens;

  const txs = [
    {
      to: target,
      typeCode: 1,
      data,
      value: 0n,
    },
  ];

  const fee = await provider.getFeeData();
  let opts = { gasLimit: 800000n };
  if (fee.maxFeePerGas != null) {
    opts.maxFeePerGas = (fee.maxFeePerGas * 120n) / 100n;
    if (fee.maxPriorityFeePerGas != null) {
      opts.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * 120n) / 100n;
    }
  } else if (fee.gasPrice != null) {
    opts.gasPrice = (fee.gasPrice * 120n) / 100n;
  }
  const tx = await factory.proxy(txs, opts);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

/**
 * Fallback: direct CTF call from EOA (some wallets hold tokens directly).
 */
async function redeemDirectCtf(privateKey, { conditionBytes32, cfg }) {
  const { provider } = await getWorkingProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  const ctf = new ethers.Contract(cfg.conditionalTokens, CTF_ABI, wallet);
  const fee = await provider.getFeeData();
  let txOpts = { gasLimit: 600000n };
  if (fee.maxFeePerGas != null) {
    txOpts.maxFeePerGas = (fee.maxFeePerGas * 120n) / 100n;
    if (fee.maxPriorityFeePerGas != null) {
      txOpts.maxPriorityFeePerGas = (fee.maxPriorityFeePerGas * 120n) / 100n;
    }
  } else if (fee.gasPrice != null) {
    txOpts.gasPrice = (fee.gasPrice * 120n) / 100n;
  }
  const tx = await ctf.redeemPositions(cfg.collateral, ethers.ZeroHash, conditionBytes32, [1n, 2n], txOpts);
  const receipt = await tx.wait();
  return { hash: receipt.hash, blockNumber: receipt.blockNumber };
}

function shouldUseProxyFirst() {
  const v = (process.env.AUTO_REDEEM_USE_PROXY || 'true').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.privateKey
 * @param {(level:string,msg:string)=>void} [opts.log]
 */
async function runAutoRedeemPass(opts) {
  const { userId, privateKey, log = () => {} } = opts;
  if (!privateKey) {
    log('WARN', '[AutoRedeem] skipped — no private key');
    return { attempted: 0, redeemed: 0 };
  }

  const cfg = await loadContractConfig();
  const { provider } = await getWorkingProvider();

  const candidates = await pool.query(
    `SELECT DISTINCT t.market_id
       FROM trades t
      WHERE t.user_id = $1
        AND t.status = 'closed'
        AND t.market_id IS NOT NULL
        AND t.close_reason = ANY($2)
        AND t.closed_at > NOW() - INTERVAL '120 days'
        AND NOT EXISTS (
          SELECT 1 FROM redeem_log rl
           WHERE rl.user_id = $1 AND rl.market_id = t.market_id AND rl.status = 'success'
        )
        AND NOT EXISTS (
          SELECT 1 FROM redeem_log rl2
           WHERE rl2.user_id = $1 AND rl2.market_id = t.market_id AND rl2.status = 'failed'
             AND rl2.created_at > NOW() - INTERVAL '6 hours'
        )`,
    [userId, REDEEM_CLOSE_REASONS]
  );

  let redeemed = 0;
  for (const row of candidates.rows) {
    const marketId = row.market_id;
    let conditionBytes32;
    try {
      conditionBytes32 = toConditionBytes32(marketId);
    } catch (e) {
      log('WARN', `[AutoRedeem] skip bad market_id=${marketId}: ${e.message}`);
      continue;
    }

    try {
      const resolved = await isConditionResolved(provider, cfg.conditionalTokens, conditionBytes32);
      if (!resolved) {
        continue;
      }

      const negRisk = await fetchGammaNegRisk(marketId);
      if (negRisk) {
        log('INFO', `[AutoRedeem] skip neg-risk market ${marketId} — use manual redeem`);
        continue;
      }

      let result;
      if (shouldUseProxyFirst()) {
        try {
          result = await redeemViaProxy(privateKey, { conditionBytes32, cfg });
        } catch (e1) {
          log('INFO', `[AutoRedeem] proxy redeem failed for ${marketId}: ${e1.message} — trying direct CTF`);
          result = await redeemDirectCtf(privateKey, { conditionBytes32, cfg });
        }
      } else {
        try {
          result = await redeemDirectCtf(privateKey, { conditionBytes32, cfg });
        } catch (e2) {
          log('INFO', `[AutoRedeem] direct CTF failed for ${marketId}: ${e2.message} — trying proxy`);
          result = await redeemViaProxy(privateKey, { conditionBytes32, cfg });
        }
      }

      await pool.query(
        `INSERT INTO redeem_log (user_id, market_id, tx_hash, status, error_detail)
         VALUES ($1, $2, $3, 'success', NULL)
         ON CONFLICT (user_id, market_id) DO UPDATE SET tx_hash = EXCLUDED.tx_hash, status = 'success', error_detail = NULL, created_at = NOW()`,
        [userId, marketId, result.hash]
      );
      redeemed++;
      log('INFO', `[AutoRedeem] redeemed market ${marketId} tx=${result.hash}`);
    } catch (err) {
      const msg = err?.message || String(err);
      log('WARN', `[AutoRedeem] failed ${marketId}: ${msg}`);
      await pool.query(
        `INSERT INTO redeem_log (user_id, market_id, tx_hash, status, error_detail)
         VALUES ($1, $2, NULL, 'failed', $3)
         ON CONFLICT (user_id, market_id) DO UPDATE SET status = 'failed', error_detail = EXCLUDED.error_detail, created_at = NOW()`,
        [userId, marketId, msg.slice(0, 2000)]
      );
    }
  }

  return { attempted: candidates.rows.length, redeemed };
}

module.exports = {
  runAutoRedeemPass,
  toConditionBytes32,
  REDEEM_CLOSE_REASONS,
};
