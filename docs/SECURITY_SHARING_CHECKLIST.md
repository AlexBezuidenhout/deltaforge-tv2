# Security and sharing checklist

Use this checklist before every external handoff.

## Repository

- [ ] Repository visibility is private.
- [ ] Collaborator is invited by GitHub username, not given the owner's token.
- [ ] The published branch begins from the audited clean snapshot.
- [ ] `.env`, `.env.*`, credential files and runtime gates are absent.
- [ ] Git history and current tree pass the secret-pattern scan.
- [ ] Raw WAL, Parquet, SQL dumps, logs and caches are absent.
- [ ] Local Claude/Codex/MCP permission state is absent.
- [ ] `npm test` passes from a clean install.

## Dashboard

- [ ] HTTPS is valid before sending credentials.
- [ ] Registration is closed.
- [ ] TV2 account role is `viewer` and points to the intended data owner.
- [ ] Viewer GET works and POST/PUT/PATCH/DELETE return 403.
- [ ] Admin routes reject the mapped viewer identity.
- [ ] Wallet/proxy metadata and credential-presence flags are omitted for viewers.
- [ ] DF2 proxy blocks every method except GET, HEAD and OPTIONS.

## Credentials

- [ ] Access sheet is outside Git and the source archive.
- [ ] Friend never receives wallet, PostgreSQL, RDP, SSH or owner-admin credentials.
- [ ] Dashboard and GitHub invitations are sent through separate channels where practical.
- [ ] A revocation owner and date are recorded.

## Research claims

- [ ] Paper, shadow, backtest and live results are labeled separately.
- [ ] Headline P&L uses executable prices and includes fees.
- [ ] Discovery and forward cohorts are not mixed.
- [ ] Independent markets/days and confidence intervals are reported.
- [ ] Multiple-testing and shared-capital effects are disclosed.
- [ ] No strategy is called profitable merely because it has a high win rate.
