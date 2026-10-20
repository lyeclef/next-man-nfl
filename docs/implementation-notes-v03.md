# Next Man — Sourced NFL Injury Research

An import-based pregame projection engine for QB, RB, WR and TE, with a dashboard containing **real sourced records only**. The product no longer ships invented players, injuries, sportsbook lines or edge percentages. Synthetic inputs exist only in isolated software test fixtures and are excluded from the static build.

**The model is evaluated, but it has not passed predictive/betting validation.** No market is approved for betting signals. Real data alone does not make a forecast reliable.

## Open and run

Node.js 22+ is required. No third-party runtime packages or API subscriptions are required for the current public-data workflow.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Open http://127.0.0.1:4173. The dashboard defaults to the current sourced slate. Select **2024 holdout · real outcomes** to compare historical forecasts with actual player production. Use the validation page for rolling test results and the sources page for source URLs, capture times and hashes.

## What is real and what is estimated

- Player identities, past usage, injury reports, depth charts and observed historical production are sourced records.
- Workload allocation, production forecasts, and uncertainty are model estimates. They are labeled research-only.
- Unavailable sportsbook quotes remain null. A projection can exist without a betting line. The UI never turns missing prices or missing outcomes into zeros.
- Zero **historical production** is retained for candidates with no recorded stats in an otherwise populated completed team game. It does not establish whether a player was active.
- Current coverage is partial and disclosed. The published snapshot currently contains one verified Week 7 injury case; it does not represent the complete NFL slate.

## Current source workflow

```powershell
npm.cmd run refresh:real
```

The refresh retrieves 2026 weekly player statistics, timestamped depth charts, injury records and the schedule from official nflverse GitHub releases. It also rechecks the primary team article for each individually verified announcement in `data/verified-injuries.json`. A changed article publication/modification time or missing reviewed text quarantines that case pending review. It never substitutes a made-up case.

As of the source snapshot, the league injury file covers Week 6. Its statuses are not carried forward to Week 7. Only Out reports matching an upcoming game's week are ingested automatically. Individually verified team announcements can add a current case. The Rams' announcement about Davante Adams is the current example; the UI distinguishes a coach's absence announcement from a final NFL game-status designation. Severity and exact return dates are not medically inferred.

The refresh builds the complete eligible teammate pool from a timestamped depth snapshot before the team's most recent game, derives usage from the previous three or four completed team games, and computes player efficiency using frozen training priors. Full candidate pools include players without sportsbook quotes. There are no automatic opponent, weather or coaching adjustments.

Outputs:

| Artifact | Purpose |
|---|---|
| `data/current-slate.json` | Current sourced pregame inputs; no invented odds or outcomes. |
| `data/historical-slate.json` | All 66 archived 2024 injury cases, forecast inputs and actual outcomes. |
| `data/source-status.json` | Retrieval times, source hashes, coverage and source failures. |
| `data/validation-policy.json` | Qualification criteria and the empty approved-market list. |
| `data/forward-status.json` | Prospective validation status; pending until games finish. |

Raw downloads and immutable forecast snapshots are stored in ignored `.cache/`. Refreshing local files does not automatically publish the site or schedule recurring refreshes.

## Historical validation

```powershell
npm.cmd run train:injuries
npm.cmd run validate:model
```

The injury model learns carry/target/attempt transfers using ridge regression, beneficiary position, role rank, relative baseline usage and usage trend. Combined allocations cannot exceed the vacated workload. QB-related receiving efficiency is fitted separately. Transfer scales and regularization are selected using an earlier validation season; unsupported transfers retain baseline.

The default artifact fits 2018, 2019, 2021 and 2022, selects effects using 2023, and tests on 2024. Rolling validation additionally reconstructs 2022 and 2023 tests with only earlier fit/selection seasons. There are 190 test team-game injury cases across the three years. These are retrospective diagnostics, not newly untouched prospective seasons.

Validation retains candidate zero-production outcomes, reports baseline and model MAE, and bootstraps paired error differences by NFL game. The accuracy gate requires at least 30 game clusters and a positive improvement interval adjusted for multiple markets using Bonferroni correction. No market currently passes that gate. Probability calibration and price-based betting performance remain unevaluated, so the approval list is empty independently of the accuracy result.

The full rolling report is `data/walk-forward-validation.json`. The underlying paired prediction ledger is saved in `.cache/validation/predictions.json` with a reported SHA-256 hash. Each fold's model/report/ledger is in `.cache/walk-forward/`. The original single-year report is `reports/injury-evaluation.md`.

Limits: the injury cohort requires one newly confirmed Out high-usage player with recent participation. It does not validate multiple new simultaneous absences, ongoing IR or medical absence probabilities. Archived injury update times must precede kickoff, but final stat corrections and weekly depth archives are not guaranteed publication-time snapshots. Roster movement and late-season resting can confound results. No historical player-prop quote feed was provided.

## Prospective validation

Each real-data refresh freezes inputs, predictions, model fingerprint, source hashes, information cutoff and issue time in a new hash-named snapshot. Inputs must have been retrieved before the forecast cutoff. Snapshots are never overwritten.

```powershell
npm.cmd run evaluate:forward
```

The evaluator verifies snapshot hashes and timing, selects the earliest valid prediction per player/market/game/model, and grades only completed games with available team stats. Draft snapshots with invalid capture chronology are explicitly rejected. It does not rewrite forecasts after seeing outcomes. Results are pending for the current slate; the evaluator cannot manufacture future games or establish accuracy immediately. This command does not run on a schedule.

## Real sportsbook prices

No odds subscription/account is connected. To add a real quote, supply its actual line, paired American over/under prices, bookmaker, source and capture time. A partial quote is rejected. The capture time must be at or before the scenario information cutoff and before kickoff.

An offline The Odds API event export can be merged without placing credentials in the project:

```powershell
node scripts/import-odds.mjs imports/slate.json imports/event-odds.json imports/mapping.json outputs/with-odds.json
```

The mapping file explicitly links scenario ID, player ID, provider event ID and exact provider player description. Kickoff and both sides of the line must match. Supported markets: passing, rushing and receiving yards, plus receptions. Bookmaker-specific DNP/void and early-injury settlement rules are not implemented. Having a quote does not enable signals: the model must also pass qualification, probability calibration and prospective checks. Research EV fields are separate from the public qualified EV fields, which remain null.

## Import and CLI contract

Download a sourced slate from the dashboard as the starting format. `schemaVersion` remains 1. Supported modes are `sourced`, `historical` and `import`; old demonstration-mode files are rejected. User imports are labeled user-supplied, not independently verified.

- Dataset `asOf` is the dataset capture time. Optional scenario `asOf` is its pregame information cutoff; historical scenarios require their own cutoff before kickoff.
- Injuries need an exact player name, QB/RB/WR/TE position, status, source and timestamp, explicit absence probability, and vacated opportunities. OUT/IR requires probability 1. Unknown return dates remain unknown.
- Each player market needs a baseline opportunity count, production per opportunity, and an input source when unpriced. The full `workloadCandidates` pool preserves ranks/shares even when only some players have quotes.
- A quote has all six fields together: `line`, `overOdds`, `underOdds`, `book`, `source`, `updatedAt`. All can instead be null for a projection-only market.
- `actual` and `actualSource` are allowed only in historical datasets captured after the completed-game window. Actual outcomes are never used as projection inputs.
- Learned slates reference the fitted `injuryModelId`; mismatches and fit/selection cutoffs after the scenario timestamp are rejected.

```powershell
npm.cmd run project -- data/current-slate.json outputs/current-projections.json
npm.cmd run project -- data/historical-slate.json outputs/historical-projections.json
```

Create output directories before using these commands. Proprietary imports and outputs belong in ignored `imports/` and `outputs/`, not published `data/`.

## Build boundary and sources

The build deletes only the resolved project `dist/` directory after checking its path, then copies an explicit allowlist of source artifacts. Test fixtures and retired demonstration files are excluded. The browser calculates imported files in memory; there is no upload backend, automated wagering, analytics or recurring job.

Primary data documentation: https://nflreadr.nflverse.com/reference/load_player_stats.html and https://nflreadr.nflverse.com/reference/load_injuries.html. Current injury evidence links directly to team announcements. Source URLs and content hashes are included in the published sources panel. Review upstream data terms before redistributing outside this private research site.
