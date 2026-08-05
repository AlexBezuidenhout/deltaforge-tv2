# Public-information paper lane deployment — 5 August 2026

## Deployed component

- Service: `borg-public-info.service`
- Strategy: `N01_xtracker_count_barrier_v1`
- Experiment: `xtracker-resolver-count-barrier-v1`
- Code release: `82199f3`
- VPS start: `2026-08-05T15:03:47Z`
- Runtime path: `/opt/deltaforge/tv2/public-info-current` ->
  `/opt/deltaforge/tv2/releases/82199f3`
- Mode: public-data paper collection and simulation only
- Wallet loaded: false
- Authenticated or live order path: absent

The shared application pointer remained on release `af33450`. Existing BORG
collectors were not restarted or moved to the new release. This prevents a
mid-cohort code substitution under the existing evidence-epoch identity.

## Initial domain verification

After startup, the collector reported one XTracker source, three active Truth
Social tracking windows, 23 certified markets and 46 subscribed outcome
tokens. Both CLOB shards were connected, with zero connection gaps and zero
book-state gaps. PostgreSQL writes were current, the persistence queue was
empty, source polling had zero errors and all four local WAL streams were
healthy with more than 70 GiB free.

Zero initial paper intents is the correct state: bootstrap posts are stored but
cannot create a causal decision. Only a post imported after collector startup
may trigger an irreversible boundary evaluation.

## Archive and fleet verification

The direct Google Drive archive completed successfully after deployment with
zero closed raw files pending. Open WAL segments become archive-eligible only
after sealing. The core BORG services remained active with zero restarts and
their original `2026-08-04T08:55:05Z` activation time.

## Rollback

Rollback stops and disables only `borg-public-info.service`; it does not touch
TV2, BORG, the database schema or the immutable WAL. Preserve the database and
WAL rows for audit. The dedicated `public-info-current` pointer can then be
returned to a prior tested release before the service is re-enabled. Do not
delete experiment, event or paper-intent evidence during rollback.

