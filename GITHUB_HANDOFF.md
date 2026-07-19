# DeltaForge TV2 — GitHub handoff

Prepared: **19 July 2026**  
Active-source baseline: `22c999701b1ef9a76a4d026a1c47f4b64175fd0e`

This repository is a sanitized collaborator snapshot of the current TV2 source.
It starts from a new root commit because the operator's historical local Git
objects once contained a credential-bearing local permissions command. The new
root preserves the current application source without publishing unsafe history.

## Start here

Read these documents in order:

1. [`docs/FRIEND_HANDOFF.md`](docs/FRIEND_HANDOFF.md)
2. [`docs/THEORY_PRIMER.md`](docs/THEORY_PRIMER.md)
3. [`EDGE_TERRITORY_MAP_2026-07-18.md`](EDGE_TERRITORY_MAP_2026-07-18.md)
4. [`BOARD_STRATEGY_REVIEW_2026-07-17.md`](BOARD_STRATEGY_REVIEW_2026-07-17.md)
5. [`DATA_BACKTEST_CATALOG_2026-07-17.md`](DATA_BACKTEST_CATALOG_2026-07-17.md)
6. [`CLAUDE.md`](CLAUDE.md)
7. [`docs/OPERATIONS_AND_ACCESS.md`](docs/OPERATIONS_AND_ACCESS.md)

Each research report retains its own evidence cutoff. A positive dashboard row,
paper PnL or discovery backtest is not a claim of deployable profitability.

## Safe local setup

```bash
git clone <private-github-url> deltaforge-tv2
cd deltaforge-tv2
cp .env.example .env
npm ci
npm test
npm start
```

Use Node.js 20+ and a dedicated development PostgreSQL database. Paper trading
and live-order locks remain the defaults. Never copy production wallet, database
or exchange credentials into a collaborator checkout.

## Live read-only dashboard

TV2 is available at <https://tv2.107.174.203.197.sslip.io/>. Viewer credentials
must be sent separately from this repository. The viewer account cannot mutate
settings, start or stop bots, access admin routes, or authorize live orders.

## Deliberately excluded

- `.env` files, wallet keys, API credentials and database URLs;
- VPS/RDP/SSH credentials and dashboard access sheets;
- local Claude/Codex/MCP settings;
- raw WAL, Parquet, PostgreSQL dumps and large generated CSV datasets;
- live executor confirmation/kill files;
- the unsafe historical Git object graph.

Grant access by inviting the collaborator's GitHub username to this **private**
repository. Never share the owner's GitHub token or production credentials.

## Snapshot verification

- `npm ci` completed from the committed lockfile.
- `npm test`: **337/337 tests passed** on 19 July 2026.
- The source/secret scan found no production credential, private-key file,
  access sheet, WAL, Parquet file or database dump. Placeholder PostgreSQL URLs
  in `.env.example` and public 64-hex market identifiers are intentional.
- `npm audit` reports 3 high, 9 moderate and 10 low findings in the existing
  dependency graph, with no critical findings. Dependency remediation requires
  a separately tested upgrade; this handoff does not silently change the
  execution stack merely to alter the audit count.
