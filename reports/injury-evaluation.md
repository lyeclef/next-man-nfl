# Historical injury-impact evaluation

Fit seasons: 2018, 2019, 2021, 2022. Model selection: 2023. Holdout: 2024.

207 training, 56 selection, and 66 holdout team-game injury events. All QB/RB/WR/TE beneficiaries on the previous team-game depth chart are candidates; zero recorded production is retained.

**Validation result: the learned model improves out-of-sample MAE across all 9 evaluated markets.**

## Workload prediction in the holdout

| Injury / opportunity | Team games | Baseline MAE | Learned MAE | Selected transfer scale | 95% CI of game-average error improvement |
|---|---:|---:|---:|---:|---|
| QB:carries | 3 | 1.935 | 1.597 | 0.75 | -0.253 to 0.929 |
| QB:attempts | 3 | 14.794 | 14.333 | 0.75 | -9.032 to 9.749 |
| RB:carries | 19 | 4.639 | 4.022 | 0.75 | -0.501 to 1.579 |
| RB:targets | 19 | 1.781 | 1.784 | 0.25 | -0.018 to 0.012 |
| WR:targets | 29 | 1.580 | 1.548 | 0.5 | 0.006 to 0.058 |
| TE:targets | 14 | 1.578 | 1.596 | 0.75 | -0.087 to 0.073 |

Positive improvement favors the learned model. Scale 0 means validation retained baseline. Intervals use a fixed-seed bootstrap clustered by NFL game, not individual players.

## Production prediction in the holdout

| Beneficiary / market | Player-games | Baseline MAE | Learned MAE |
|---|---:|---:|---:|
| QB:passing_yards | 161 | 54.304 | 51.491 |
| QB:rushing_yards | 161 | 7.900 | 7.579 |
| RB:rushing_yards | 178 | 21.739 | 21.322 |
| RB:receiving_yards | 178 | 8.679 | 8.430 |
| RB:receptions | 178 | 0.969 | 0.940 |
| WR:receiving_yards | 288 | 20.411 | 20.430 |
| WR:receptions | 288 | 1.437 | 1.445 |
| TE:receiving_yards | 191 | 12.837 | 12.892 |
| TE:receptions | 191 | 1.181 | 1.187 |

## Limits

- Retrospective observational evaluation across chronological train/selection/test folds.
- Final archived injury reports must have date_modified before kickoff; reports revised after kickoff are excluded rather than reconstructed.
- Candidate selection uses the previous team game’s depth chart, not the realized current-game stat list. Missing candidate stats are zero if team game stats exist; this includes inactive, traded, benched and zero-usage players, not just active players.
- Archived depth charts and final stat corrections are not guaranteed publication-time snapshots. Only weeks strictly before the target game are used.
- Model selection uses 2023 only; 2024 is evaluated with frozen hyperparameters and does not select model effects.

Model fingerprint: 159b0665ce8763950ee66c2932e5c1cfe32c9c27d3cf8229eb34ddb3de46a6a4.

Source URLs and SHA-256 hashes, sample audited injury events, sample counts, and all metrics are in [the JSON report](../data/injury-validation.json).
