# Next Man — NFL Pregame Injury Model

**Project handoff · 20 October 2026 · local version 0.4.0**

This project asks: **when an important NFL player is absent, which teammates inherit his workload, what production might follow, and how does that compare with an actual sportsbook quote?** It supports QB, RB, WR and TE before kickoff. In-game modeling is outside this project.

The application and data pipeline work, but **the model has not established a reliable predictive or betting edge**. No market is approved for betting signals. Real observations are distinguished from estimated outputs, unavailable prices remain blank, and future results are never invented.

## Run the project

Extract the entire ZIP, including `.cache`. Open a terminal inside `next-man`, beside `package.json`. Install **Node.js 22 or newer** if needed. There are no third-party npm dependencies and no npm install step is required.

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Open **http://127.0.0.1:4173** and stop the server with Ctrl+C. On macOS/Linux use `npm` instead of `npm.cmd`. Do not open `index.html` directly: the browser needs HTTP to load modules and JSON. Included data and the local dashboard work offline; optional Google Fonts, external source links, fresh data retrieval and future grading need internet access.

**Verified at handoff:** the build succeeds, JavaScript syntax checks pass, and **46 automated software tests pass**. Latest watchlist, candidate-selector and quote-import interface changes still need a complete browser interaction, accessibility and mobile QA pass. Software tests do not establish predictive accuracy.

## What is included and what is published

This archive contains the latest local source code, generated dashboard, data snapshots, fitted models, tests, evaluation reports, historical training inputs and locally saved prospective forecasts. Raw public-data captures are included so another developer can reproduce the research without depending on changing downloads.

It excludes Git internals, credentials, real environment secrets, machine-specific runtime state, older release archives and disposable smoke/test outputs. `.env.example` is empty. Synthetic inputs under `test/fixtures` are deliberate unit-test fixtures, excluded from the product build. They are not actual players, prices or product recommendations.

The hosted site is https://next-man-pregame-lab.cocoafield9.chatgpt.site . The last confirmed published source is v0.3, commit `836a95ac48df4dc8af0f370f53913e4af4db7a07`. **The newer v0.4 work in this ZIP is local and has not been deployed.** Running the archive does not modify the hosted site. `.openai/hosting.json` identifies that existing Site and contains no deployment credential. A new owner should register a separate hosting destination rather than blindly deploy to this identity.

## How it was built

The initial implementation established a transparent projection engine, import schema and table-based dashboard inspired by the supplied reference. Product examples were then replaced with linked NFL records, historical evaluations and explicit validation gates. Current data retrieval, historical reconstruction and prospective grading were implemented separately so that a usable interface could not be mistaken for a proven model.

Latest local work adds a broader injury watchlist, isolated conditional-absence scenarios, CSV quote imports and a competing research model. That candidate was not promoted because its results are mixed.

The stack is intentionally small:

- **Node.js ES modules and built-in APIs** handle data retrieval, regression, evaluation, testing, serving and builds.
- **HTML, CSS and browser JavaScript** implement the dashboard. There is no React application, database or server-side application backend.
- **JSON and CSV** form explicit input/output contracts; stable provider IDs connect players and events.
- **Static hosting** serves the dashboard. Browser imports are processed in memory and are not uploaded or saved automatically.
- **SHA-256 fingerprints** identify source captures, fitted artifacts and saved prediction files.

No LLM generates player projections. The statistical forecast implementation is in the included JavaScript.

## Core statistical foundation

### Pregame information only

Each scenario has an `asOf` cutoff before kickoff. Injury information and quotes cannot be newer than that cutoff. Fitted-model information must also be available by then. Historical inputs use earlier team games, never current-game outcomes as features.

### Baseline workload and efficiency

Recent workload comes from the previous three or four completed **team games**, retaining zero recorded usage. A weighted mean uses a 0.7 decay factor so recent games count more heavily.

| Market | Workload input |
|---|---|
| Passing yards | Pass attempts |
| Rushing yards | Carries |
| Receiving yards | Targets |
| Receptions | Targets |

Efficiency is production per opportunity, shrunk toward historical position/market averages to reduce extreme estimates from small samples. Production priors are frozen in the injury-model artifact. A separate calibration artifact supplies experimental residual uncertainty.

### Injury-related workload transfer

The injured player's recent usage is the vacated workload. Eligible teammates come from prior depth-chart records. Players without quotes still belong in the allocation pool, avoiding excessive transfers to the few priced players.

The original model uses **ridge regression** to estimate shares of vacated carries, targets and pass attempts. Features include teammate position, prior usage rank, workload relative to the injured player, and recent usage trend. Regularization and transfer scales are selected using an earlier season. Unsupported effects retain baseline. Nonnegative shares are normalized so their combined allocation cannot exceed 100% of vacated workload.

Conceptually:

```text
active baseline = normal opportunities × shrunk efficiency
absent workload = normal opportunities + vacated workload × allocated share
absent forecast = absent workload × efficiency × enabled context adjustments
```

QB-related receiving-efficiency effects can also be fitted and selected. Current inputs do not invent matchup, weather or coaching adjustments: those multipliers are neutral. Receptions cannot exceed one catch per target.

This is an observational forecast, not a causal estimate of the injury's isolated effect. It can miss changes in team volume, play calling, quarterback quality, roster membership and simultaneous injuries. The current evaluated population is narrow: one newly confirmed Out, high-usage player with recent participation.

### Uncertain availability

The engine can mix active and absent distributions using an explicit user-supplied absence probability. It does **not** infer medical probabilities from labels such as Questionable. Watchlist scenarios fix absence at 100% solely to answer **“what if he is absent?”** They are not assertions that the player will miss the game. Do not add overlapping individual scenarios together.

### Prices and expected value

A projected statistic minus a sportsbook line is a **projection gap**, not expected betting return. EV requires outcome probabilities, actual paired prices, pushes and bookmaker settlement rules.

The code contains experimental rounded-normal yardage and count-distribution calculations. Those probabilities have not passed priced calibration. Public EV and actionable betting signals remain disabled unless model-specific accuracy, probability, price and prospective checks all pass. Conditional what-if cases cannot qualify.

## Data and current coverage

Counts describe the included **20 October 2026 snapshot**, not a continuously updating service. Exact capture times, source URLs, hashes and failures are in `data/source-status.json`.

| Data | Source | Purpose |
|---|---|---|
| Player statistics | nflverse GitHub releases | Historical usage, efficiency and observed production |
| Injury archives | nflverse GitHub releases | Matched-week Out reports and historical cohorts |
| Depth charts | nflverse GitHub releases | Prior roles, teammate pools and exact ID crosswalks |
| Schedule/results | nflverse nfldata | Upcoming games, kickoff and completed-game checks |
| Verified announcements | Linked official team articles | Reviewed current absence evidence |
| Injury watchlist | ESPN public injury feed | Reported offensive-player injuries, separate from official game status |
| Sportsbook props | User CSV/offline export; optional local API adapter | Actual paired quotes only; no account connected |

Included snapshot:

- **Confirmed-source slate:** 1 verified injury case, 20 projections, 0 sportsbook quotes. Coverage remains partial.
- **Watchlist:** 65 reported QB/RB/WR/TE injury listings from a feed containing 32 teams. This does not establish complete injury coverage.
- **Conditional slate:** 4 eligible if-absent cases and 84 player-market forecasts. Other records show reasons why no scenario is produced.
- **2024 historical board:** 66 injury cases and 1,814 forecasts with actual production.
- **Rolling historical tests:** 190 team-game injury cases and 5,404 market observations across 2022–2024. These observations are not independent games.

The captured league injury file covers Week 6; its statuses are not extended silently into Week 7. ESPN listings are secondary watch records, not final official game designations. Exact severity and return dates are not medically inferred. Individually verified team announcements are rechecked against reviewed text and publication/modification timestamps; changed claims are quarantined.

Public endpoints can change, disappear, lag or correct their data. Review upstream redistribution rights before distributing outside private research. A timestamped raw archive helps audit a source but does not prove that every historical archive was publicly available before its reconstructed forecast.

## Validation results

The original default model fits 2018, 2019, 2021 and 2022, selects effects on 2023, and reports 2024 outcomes. Additional chronological folds test 2022 and 2023 using earlier fitting/selection seasons. Zero-production candidate outcomes are retained.

The accuracy gate uses paired errors, bootstrap resampling clustered by NFL game, multiple-market adjustment and minimum game clusters. **No market passes the current adjusted accuracy gate.** Price-based returns, probability calibration and prospective performance are unestablished. The approved-market list is empty.

The candidate model uses pooled transfer coefficients, shrinkage toward pooled patterns, position-balanced fitting weights, opportunity-eligible positions and a primary-replacement selection objective. Some historical QB and TE errors improve while RB errors worsen. The original remains the default; the candidate is research only. Previously examined 2022–2024 outcomes are development data, not a new untouched holdout.

Prospective snapshots currently contain **40 distinct model/player/market/game forecasts, covering two models, with 0 graded games**. A malformed early snapshot is explicitly rejected for chronology. Hash-addressed files detect modification; they are not externally notarized timestamps. Conditional what-if cases are not frozen as if absence had already occurred.

Evidence files:

- `reports/real-data-validation.md` — original real-data evaluation summary.
- `reports/injury-evaluation.md` — original injury-model methodology and results.
- `reports/candidate-evaluation.md` — candidate replacement diagnostics, including regressions.
- `data/walk-forward-validation.json` — chronological-fold metrics and limitations.
- `data/validation-policy.json` — qualification gates; no approved markets.
- `reports/forward-predictions.json`, `data/forward-status.json` and `.cache/forward-ledger/` — prospective status and saved inputs/predictions.

Older reports are retained as dated records. This README and current JSON artifacts describe the latest local additions.

## Project map

```text
next-man/
  README.md                    Start here: setup, foundation and readiness
  docs/                        Earlier technical notes and handoff verification
  package.json                 Commands; no third-party dependencies
  public/                      Editable dashboard HTML, CSS and JavaScript
  lib/                         Forecast math, schema, imports and data logic
  scripts/                     Fetch, train, evaluate, build and serve commands
  data/                        Sourced slates, models and machine-readable reports
  reports/                     Human-readable research results
  test/                        Tests and isolated synthetic / real regression fixtures
  dist/                        Generated browser build; rebuild from source
  .cache/injury-history/       Raw historical inputs and reconstructed events
  .cache/walk-forward/         Frozen per-fold models and predictions
  .cache/real-data/            Current source captures
  .cache/validation/           Original paired historical prediction ledger
  .cache/candidate/            Candidate protocol, fold models and predictions
  .cache/forward-ledger/       Hash-addressed pregame snapshots; preserve these
  .openai/hosting.json         Existing Site identity, not a credential
  .env.example                 Empty optional configuration example
```

Important modules: `lib/model.mjs` defines the schema, forecast math and qualification rules; `lib/injury-impact.mjs` applies learned transfers; `lib/injury-history.mjs` reconstructs cohorts; `lib/real-data.mjs` prepares current inputs; `lib/injury-watch.mjs` links watch records; `lib/quote-csv.mjs` and `lib/odds-import.mjs` import prices.

## Commands and reproduction

Inspect included results **before** refreshing or retraining. Current downloads may change and fitting commands overwrite artifacts. Preserve the original ZIP and forward ledger as the handoff record.

| Command | Purpose / side effects |
|---|---|
| `npm.cmd run build` | Validate slates and rebuild the browser directory |
| `npm.cmd test` | Software correctness checks, not predictive qualification |
| `npm.cmd run dev` | Serve the built dashboard on localhost:4173 |
| `npm.cmd run project -- data/current-slate.json` | Print current projections from included fitted artifacts |
| `npm.cmd run refresh:real` | Fetch current sources, rebuild slates and freeze new predictions |
| `npm.cmd run evaluate:forward` | Fetch outcomes and grade saved forecasts after games finish |
| `npm.cmd run update` | Refresh, grade and build in sequence; does not publish |
| `npm.cmd run train:injuries` | Refit default injury artifact from historical cache |
| `npm.cmd run validate:model` | Recreate chronological folds, metrics and policy |
| `npm.cmd run research:candidate` | Recreate candidate using cached fold inputs; not a fresh test |
| `npm.cmd run train` | Refit the separate baseline efficiency/residual calibration |
| `npm.cmd run fetch:odds -- --list` | Optional authenticated provider NFL event export |
| `npm.cmd run fetch:odds -- --event=PROVIDER_EVENT_ID` | Optional supported prop export for one event |

Historical research can run from the included cache. Current refresh and grading require internet. Current-source scripts explicitly target 2026; season rollover still needs implementation. There is no recurring refresh job. Local updates do not automatically publish the site.

## Adding real sportsbook prices

No subscription, API key or paid account is included or connected. Nothing else is needed to inspect or run the included snapshot.

For imports, open **Sources & coverage** in the local dashboard, download the current CSV template, fill actual quotes and select **Import prices CSV**. Required columns:

```text
scenarioId,playerId,market,line,overOdds,underOdds,book,source,capturedAt
```

Use exact template IDs, both American prices for the same line, an HTTPS source URL and the actual ISO capture timestamp. Leave unavailable rows empty. Inputs must be less than 24 hours old. This CSV adapter requires capture after the input snapshot and before import/kickoff; it makes a new user-imported cutoff and preserves the original input timestamp. Source claims remain user supplied. Download imported data to preserve in-browser work.

Offline The Odds API JSON exports can also be merged with explicit mappings:

```powershell
New-Item -ItemType Directory -Path imports, outputs -Force
node scripts/import-odds.mjs imports/slate.json imports/event-odds.json imports/mapping.json outputs/with-odds.json
```

A mapping record contains `scenarioId`, `playerId`, `eventId` and exact provider player `description`. This adapter preserves the original cutoff: exported quotes must already precede it. Both sides, line and kickoff must match.

The optional local fetch adapter reads `NFL_ODDS_API_KEY` from the process environment. It does not auto-load `.env` files. It fetches one event per command to limit quota usage, and has not been authenticated against an actual account. Keep credentials outside published files and browser imports; no key is required for CSV imports. Provider documentation: https://the-odds-api.com/liveapi/guides/v4/ . Verify actual account entitlements and historical prop coverage with the provider.

## What must happen before it is ready

This is a working research prototype and handoff foundation, not a finished validated betting product.

1. **Reliable data coverage:** obtain authorized injury/availability and paired sportsbook data, reconcile player/event IDs, preserve pregame captures, and handle corrections, stale feeds and failures. Keep uncertain labels separate from confirmed status. Add ongoing IR and multiple-absence support only with an appropriate evaluated cohort.
2. **Improved forecast with an honest release test:** compare against strong usage and depth/role baselines, report likely-replacement errors alongside all-candidate errors, and lock the method before genuinely new outcomes. Previously examined seasons cannot become fresh holdouts by renaming an experiment.
3. **Calibrated probabilities and real price evaluation:** validate tails, zeros, pushes, intervals and over/under probabilities; pair actual timestamped prices with outcomes; implement bookmaker-specific DNP/void and injury rules; account for vig/latency and uncertainty in returns. A favorable projection gap is insufficient.
4. **Prospective paper validation:** preserve already-frozen predictions, grade after reliable results arrive, report models and relevant cohorts separately, and accumulate enough independent games. Never edit predictions after outcomes or count multiple quotes as independent outcomes. Zero graded games cannot demonstrate readiness.
5. **Operational product work:** finish browser/mobile/accessibility QA, durable storage/backups, controlled refresh/publication, source-health monitoring, secure server-side provider access, season rollover and licensing review. Decide sharing for the friend; the existing Site remains owner-private. A static snapshot cannot refresh itself.

**Release rule:** keep betting gates disabled until a specific frozen model passes the independent accuracy, probability, priced and prospective requirements. If it cannot beat credible baselines, the dashboard can remain an injury research tool without claiming a betting edge.

## What is needed from the owner

To progress beyond this archive, the owner or friend must supply authorized actual sportsbook exports or arrange a suitable data account, choose target sportsbooks/markets, and allow time for genuine prospective evaluation. Code and interface work cannot substitute for future observed outcomes.

See `docs/implementation-notes-v03.md` for the earlier schema and original workflow. That is preserved v0.3 documentation; this README supersedes its older counts and interface descriptions.
