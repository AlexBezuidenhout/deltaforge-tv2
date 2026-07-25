# Staged experiments

Files in this directory are deliberately outside the active experiment
registry. They are design specifications only: no trial clock is running, no
observation is evidence, and no live-order authority exists.

Activation requires all of the following:

1. the current evidence epoch has completed at least 24 clean hours;
2. the manifest receives immutable `frozen_at` and `evidence_started_at`
   timestamps;
3. the file is copied into `borg/experiments/` under a new evidence epoch;
4. the collector starts with the matching frozen cohort and paper-only flags;
5. platform preflight and the experiment registry both pass.

