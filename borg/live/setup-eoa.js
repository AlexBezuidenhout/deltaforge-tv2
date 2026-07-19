#!/usr/bin/env node
/**
 * EOA trading-wallet auto-setup (2026-07-13).
 *
 * Polls the active EOA until it holds USDC (either variant) AND ≥0.1 POL,
 * then submits approve(max) for both USDC tokens to the three Polymarket
 * exchange/adapter spenders (taken from the CLOB's own allowance response),
 * verifies them, and exits. Safe to re-run: skips approvals already set.
 * Gas cost: ~6 approvals ≈ well under 0.05 POL.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { JsonRpcProvider, Wallet, Contract, formatUnits, MaxUint256 } = require('ethers');

const acct = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.deltaforge-live/active-account.json'), 'utf8'));
const RPCS = ['https://polygon-bor-rpc.publicnode.com', 'https://1rpc.io/matic'];
const USDCS = {
  'USDC.e': '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  'USDC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
};
// Spenders exactly as reported by CLOB /balance-allowance for this account class.
const SPENDERS = [
  '0xE111180000d2663C0091e4f400237545B87B996B',
  '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  '0xe2222d279d744050d28e00520010520000310F59',
];
const ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function provider() {
  for (const url of RPCS) {
    try {
      const p = new JsonRpcProvider(url, 137, { staticNetwork: true });
      await p.getBlockNumber();
      return p;
    } catch (_) { /* next */ }
  }
  throw new Error('no RPC reachable');
}

async function main() {
  log(`watching ${acct.address} for funding (USDC + ≥0.1 POL)…`);
  for (let i = 0; i < 720; i++) { // up to ~6h
    try {
      const p = await provider();
      const pol = parseFloat(formatUnits(await p.getBalance(acct.address), 18));
      const bals = {};
      for (const [name, addr] of Object.entries(USDCS)) {
        bals[name] = parseFloat(formatUnits(await new Contract(addr, ABI, p).balanceOf(acct.address), 6));
      }
      const usd = bals['USDC.e'] + bals['USDC'];
      if (i % 10 === 0) log(`balance: $${usd.toFixed(2)} USDC (${bals['USDC.e']} e / ${bals['USDC']} native), ${pol.toFixed(4)} POL`);
      if (usd > 1 && pol >= 0.1) {
        log('FUNDED — setting approvals…');
        const wallet = new Wallet(acct.privateKey, p);
        for (const [name, addr] of Object.entries(USDCS)) {
          if (bals[name] <= 0) continue; // only approve the token we actually hold
          const c = new Contract(addr, ABI, wallet);
          for (const sp of SPENDERS) {
            const cur = await c.allowance(acct.address, sp);
            if (cur > 0n) { log(`${name} → ${sp.slice(0, 10)}… already approved`); continue; }
            const tx = await c.approve(sp, MaxUint256);
            log(`${name} → ${sp.slice(0, 10)}… approve tx ${tx.hash}`);
            await tx.wait();
          }
        }
        log('APPROVALS COMPLETE — the live executor can now trade from this wallet.');
        log('RESULT:READY');
        return;
      }
    } catch (e) { log('poll error:', e.message.slice(0, 120)); }
    await new Promise((r) => setTimeout(r, 30000));
  }
  log('RESULT:TIMEOUT (no funding seen in 6h)');
}

main().catch((e) => { console.error(e); process.exit(1); });
