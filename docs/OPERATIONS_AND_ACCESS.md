# Operations and access

## Live read-only dashboards

The production research host exposes two HTTPS dashboards:

- TV2: `https://tv2.107.174.203.197.sslip.io`
- DF2: `https://df2.107.174.203.197.sslip.io`

Use the separately supplied access sheet. Do not send that sheet in the same
message as a public source archive. TV2 uses an application-level `viewer`
account; DF2 is protected at the HTTPS proxy and permits only GET, HEAD and
OPTIONS. Neither credential grants VPS, PostgreSQL, wallet or admin access.

The TV2 viewer sees the operator's research rows through
`VIEWER_TARGET_USER_ID`, but authorization continues to use the viewer's own
identity. Server middleware rejects every state-changing request with HTTP 403.
Registration is closed on the network deployment.

## Safe local setup

Requirements:

- Node.js 20 or newer;
- PostgreSQL 16 or newer;
- enough local disk for the desired WAL/Parquet retention;
- no live wallet credentials for ordinary development.

```bash
git clone <private-repository-url> deltaforge
cd deltaforge
cp .env.example .env
npm ci
npm test
npm start
```

Create a dedicated local PostgreSQL database and replace only the placeholder
database fields in `.env`. Generate independent secrets:

```bash
openssl rand -hex 32  # JWT_SECRET
openssl rand -hex 32  # ENCRYPTION_KEY
```

For first-user bootstrap only, temporarily set `ALLOW_REGISTRATION=true`,
register through the local UI, then set it back to `false` and restart. Keep
`DISABLE_AUTH=false` on any host reachable by another person.

The development UI defaults to `http://localhost:3004`. Paper trading remains
the default. Do not copy production `.env` files or database dumps into a clone.

## Verification

Before accepting a build:

```bash
npm test
node scripts/research-platform-check.js
node scripts/runtime-audit.js
```

For the supervised host, also verify:

- TV2, DF2 and all BORG services are active;
- collector heartbeats and source freshness are green;
- PostgreSQL is writable;
- WAL free-space guard is healthy;
- no stale connection epoch or out-of-sequence book is being scored;
- paper/shadow mode is explicit on every research bot.

The principal Linux units are:

```text
deltaforge-tv2.service
deltaforge-df2.service
borg-collector.service
borg-allmarket.service
borg-crossvenue.service
borg-paired-maker.service
borg-structural-scanner.service
borg-score.timer
deltaforge-health.timer
deltaforge-hot-retention.timer
deltaforge-db-snapshot.timer
```

## Data layout

Local PostgreSQL is the hot dashboard and scoring tier. Raw events are first
written to a durable local WAL. Immutable Parquet and database snapshots are
copied off-host. The VPS SSD is a rolling hot tier, not the sole permanent copy.

CSV and text are usually larger and slower than compressed Parquet for this
workload. Parquet preserves typed columns, compresses repeated market metadata
well and supports selective analytical reads. Git is not a data archive.

See [`../DATA_BACKTEST_CATALOG_2026-07-17.md`](../DATA_BACKTEST_CATALOG_2026-07-17.md)
for table-level coverage and replay limits.

## Making changes

1. Create a branch.
2. Write or update a frozen experiment manifest before collecting the test cohort.
3. Reuse the shared strategy and execution kernel for replay, paper and shadow operation.
4. Add tests for price scale, DECIMAL parsing, staleness, depth and non-fill behavior.
5. Run the full suite.
6. Review the diff for live-order call sites and secret-bearing files.
7. Merge through a pull request.

Never commit `.env`, private keys, exchange credentials, production database
URLs, access sheets, WAL, Parquet, database dumps or VPS login details.

## Revoking collaborator access

Remove the friend from the private GitHub repository and delete or disable the
TV2 viewer user. Rotate the DF2 proxy credential. This does not require changing
the operator account, bot settings or wallet credentials.

If a credential is ever pasted into source, an issue or chat, rotate it; deleting
the visible text is not sufficient because caches and history may retain it.
