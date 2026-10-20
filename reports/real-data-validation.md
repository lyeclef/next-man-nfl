# Real-data model validation

Source snapshot: 2026-10-20T17:08:39.379Z.

The product contains real source records and estimated forecasts. No fictional slate or invented sportsbook quote is distributed. Current coverage is partial: 1 verified injury case, 20 forecasts, and 0 paired sportsbook quotes. The league injury file covers Week 6; statuses are not extended to later weeks.

## Validation result

**Not passed. No market is approved for betting signals or qualified EV.**

Rolling tests cover 190 test team-game injury cases across 2022, 2023, 2024. Each fold fits and selects using earlier seasons only. There are 5404 market observations, not independent games. All metrics include zero-production candidate outcomes.

| Market | Observations | Baseline MAE | Injury MAE | Adjusted error-improvement CI | Accuracy gate |
|---|---:|---:|---:|---|---|
| QB:passing_yards | 440 | 57.466 | 57.804 | -2.199 to 0.739 | Not passed |
| QB:rushing_yards | 440 | 7.596 | 7.710 | -0.210 to -0.019 | Not passed |
| RB:rushing_yards | 546 | 19.282 | 19.414 | -1.073 to 0.860 | Not passed |
| RB:receiving_yards | 546 | 9.103 | 9.115 | -0.174 to 0.153 | Not passed |
| RB:receptions | 546 | 1.039 | 1.040 | -0.019 to 0.017 | Not passed |
| WR:receiving_yards | 892 | 19.744 | 19.733 | -0.094 to 0.136 | Not passed |
| WR:receptions | 892 | 1.369 | 1.373 | -0.009 to 0.002 | Not passed |
| TE:receiving_yards | 551 | 12.929 | 12.846 | -0.019 to 0.201 | Not passed |
| TE:receptions | 551 | 1.087 | 1.087 | -0.004 to 0.003 | Not passed |

Intervals are game-cluster bootstrap intervals adjusted with Bonferroni correction across evaluated markets. Positive improvement favors the injury model.

## Prospective evaluation

20 predictions are frozen before kickoff; 0 games are graded. The evaluator checks hashes and source chronology and uses the earliest valid snapshot. Records rejected for invalid chronology are reported rather than graded. No future outcomes are assumed.

## What remains

- Improve the injury-response model until it beats baseline on predeclared time-separated tests.
- Acquire real paired pregame prop quotes with snapshot timestamps; no odds account is connected.
- Calibrate outcome probabilities and account for sportsbook-specific settlement/void rules.
- Accumulate and grade prospective snapshots after games complete.

- These are retrospective archives, not guaranteed publication-time snapshots.
- The previously examined 2024 results are not a new untouched test; rolling folds test time consistency, not prospective performance.
- Candidate zero-production outcomes are included. Final-week resting and roster changes may confound injury effects.
- No timestamped historical player-prop odds were supplied; win probability calibration, closing-line value and betting ROI are untested.

Full metrics: data/walk-forward-validation.json. Qualification policy: data/validation-policy.json. Source capture times and hashes: data/source-status.json. The dashboard’s historical board contains all 66 2024 cases and 1,814 forecasts with actual production.
