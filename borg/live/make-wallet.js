#!/usr/bin/env node
/**
 * Generates a fresh Polygon EOA wallet for the G_late_arb live executor
 * (option B in RUNBOOK.md — only needed if NOT using an existing Polymarket
 * account). The private key is written to ~/.deltaforge-live/wallet.json
 * (chmod 600, OUTSIDE the repo) and is never printed — only the public
 * address is shown, which is what you load funds into.
 *
 * Refuses to overwrite an existing wallet file: if a wallet already holds
 * funds, silently replacing its key would strand them.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Wallet } = require('ethers');

const dir = path.join(os.homedir(), '.deltaforge-live');
const file = path.join(dir, 'wallet.json');

if (fs.existsSync(file)) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Wallet already exists — NOT overwriting (it may hold funds).`);
  console.log(`Address: ${existing.address}`);
  console.log(`File:    ${file}`);
  process.exit(0);
}

const w = Wallet.createRandom();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify({
  address: w.address,
  privateKey: w.privateKey,
  signatureType: 0,
  createdAt: new Date().toISOString(),
  note: 'G_late_arb live executor wallet. Fund with USDC.e + a little POL on POLYGON network only.',
}, null, 2), { mode: 0o600 });

console.log('New wallet created.');
console.log(`Address (load funds here, POLYGON network): ${w.address}`);
console.log(`Key stored (never printed): ${file}  [chmod 600]`);
console.log('');
console.log('IMPORTANT: back up that file somewhere safe (e.g. a password');
console.log('manager) — if it is lost, any funds at the address are lost.');
