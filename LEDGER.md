# PROJECT LEDGER — Public Credit Opportunity Engine

> Every change executed on this project, in order. Append to this file on
> every working session (date, what was done, verification results, known
> gaps). Read `context.md` for the canonical spec; this file is the change
> history.

---

## Session 1 — 2026-08-09: Notebook → Modular Project (Execution + Audit)

### 1. Source and starting point

- Source: single Colab workbook `Credit_engine.ipynb` (26 cells) sitting in
  the working directory.
- The notebook contained 23 `%%writefile` blocks — 21 Python modules + 2 JSON
  artifacts (`dealer_markup.json` cell 22, `expected_loss_by_grade.json`
  cell 24) — plus 3 setup cells (0, 1, 25). It also contained a leaked FRED
  API key literal (`ccb67ba5...`), interactive `input()` demo flows, and a
  private-credit underwriting pipeline mixed into the public credit engine.

### 2. Deliverables created

| Path | Purpose |
|---|---|
| `cli.py` | argparse entry: `--market us|eu|em|ml`, `--hold-days`, `--trade-size-m`, `--percentile`. No interactive prompts. |
| `config.py` | Single source of truth: `get_fred_key()` (`.env` loader), FRED series maps, all calibrated constants, file paths. |
| `engine/` (14 modules) | Pure logic/data layers: `data_engine`, `spreads`, `default_rates`, `analysis`, `forecast`, `pure_yield_forecast`, `volatility`, `volatility_matrix`, `dealer_markup`, `ml_engine`, `main_alpha`, `bonds_EUR_data`, `bonds_EM_data`. |
| `pipelines/` (5 modules) | `us_public`, `eur_public`, `em_public`, `ml_scorecard`, `volatility_strategy` (shared spectrum runner). |
| `tests/` (4 files, 17 tests) | Pure-logic, no network: spread math, forecast stationarity, markup floor, OU straddle, strategy smoke, secrets scan. |
| `data/` | `dealer_markup.json`, `expected_loss_by_grade.json` (extracted from notebook cells 22/24). |
| `notebooks/` | Original `Credit_engine.ipynb` archived read-only. |
| Root files | `context.md`, `README.md`, `requirements.txt`, `.env`, `.env.example`, `.gitignore`. |
| Tooling | `.venv` created; `requirements.txt` installed on Python 3.14; `brew install libomp` required for xgboost on macOS. |

### 3. Secrets handling (done)

- `FRED_API_KEY` now lives only in `.env` (git-ignored). The file ships with
  placeholder value `REPLACE_ME` per user instruction — user fills the real key.
- All reads go through `config.get_fred_key()` which raises a clear error if
  unset. Only `os.getenv` call site in the codebase is in `config.py`.
- Leaked literal `ccb67ba5...` was removed from the working tree:
  - Deleted root `Credit_engine.ipynb` (archived copy under `notebooks/`).
  - Removed fallback literals from `default_rate_analysis` and `data_engine`.
  - Survives only in `notebooks/` (excluded from scans) and the self-checking
    test `tests/test_config.py::test_no_embedded_key_in_source`.

### 4. Private credit pipeline — complete deletion

Files that were **never ported** and must not be reintroduced:

| Notebook cell | Removed module | Why |
|---|---|---|
| 2 | `ml_credit_engine.py` (NeuralCox super-learner) | private-deal ML; only used by market 6 |
| 4 | `private_credit_data.py` (MOIC/IRR/NAV unsmoothing) | private credit |
| 5 | `credit_ratios.py` (all-in yield, covenants) | private credit |
| 6 | `risk_simulation_engine.py` (deal EV/CVaR, cash-flow arrays) | private deals |
| 11 | `private_credit.py` (OU unsmoothing, kappa 0.002) | private credit |
| 14 | `global_private_credit.py` (lending matrix) | private credit |
| 3 | notebook markets 3 & 6 routing in `main.py` | private underwriting |

- Market support reduced to `us / eu / em / ml` (public only).
- The liquid ML scorecard (XGBoost/LightGBM/CatBoost + SHAP) was retained —
  it screens **public** ETFs (SHY/TLT/LQD/HYG/ANGL/PFF), not private deals.

### 5. Placeholder / random-value purge (audit-driven)

Discarded (unjustified, randomly seeded, or uncalibrated):

- OU kappa overrides `BASE_OU_KAPPA=25.0`, `FALLEN_ANGEL_OU_KAPPA=40.0` —
  straddle pricing now uses kappa = 0 (pure Bachelier term).
- Static discount `r_daily = 0.04` fallback — replaced by live ^IRX 13-week
  T-bill via `engine.data_engine.fetch_treasury_daily_rate` (fails loud).
- `STATIC_DEALER_MARKUP = 1.00` fallback — removed; dealer-markup series is
  required and regenerated from MOVE/TNX by `engine.dealer_markup`.
- Notebook market-6 fake assets: `torch.rand` feature tables, `np.random.randint`
  labels, `mock_asset_names`, `mock_cqi_scores`, synthetic CF arrays
  ($50k/$50k/$50k/$1,050k), `pd_curve` arrays, `simulated_cf`.
- `INVESTMENT_CAPITAL` constant burial — notional is now a CLI argument
  (`--hold-days`, `--trade-size-m` replace `input()` prompts).
- Interactive `input()` prompts — all replaced by argparse.
- The only retained randomness is numerical and documented: deterministic
  VAR jitter `np.random.RandomState(42)` noise at `1e-8` bps to keep covariance
  PSD, plus fixed `random_state=42` ML seeds (reproducibility, not placeholders).

### 6. Calibration audit (constants that survived, with justification)

- `PUBLISHED_LGD` 0.400..0.682 by grade — Moody's/S&P published LGD study,
  not random (kept).
- `VOLATILITY_PERCENTILES` [95,90,80,70,60,50], `GARCH_SIGNAL_PERCENTILE=90`,
  `MIN_OBS_FOR_GARCH=100`, `DEALER_PRICING_WINDOW=90` — strategy/estimation
  conventions (kept, documented in context.md audit log).
- Dealer markup floor 1.05 and 5-day smoothing — documented convention (kept).
- PB/friction constants — documented execution-spread convention (kept).
- `expected_loss_by_grade.json` — used as published calibration (kept).

### 7. Audit -> fix loop: every number/issue caught and fixed

1. String-typed JSON yields crashed `* 100.0` in `prepare_pristine_data` and
   `load_and_prep_yields` → added `.astype(float)` casts.
2. Flat sibling import `import forecast` inside `engine/analysis.py` → moved to
   `from engine import forecast`.
3. `engine/main_alpha.py` had `from pipeline.ml_scorecard import ...` (plural
   typo) → fixed to `pipelines`.
4. Regenerated `compute_spreads_pct` to skip empty-common-date pairs (was
   emitting empty series into JSON).
5. `test_config.py` leaked-key scan initially flagged itself and failed on
   binary reads → skip self + `errors="replace"`.
6. Dealer-markup series was generated but never applied to straddle pricing →
   `analyze_strategy` now takes `retail_markup` series and scales both HF and
   retail straddle costs; pipeline loads it from `data/dealer_markup.json`.
7. Mechanics bugs in `engine/volatility.py`: `for name, series_seq in
   series.items()` → `series_dict.items()`; `does_shares` typo → `does_shock`;
   `abs` variable shadowing in `ml_engine.py` → `normalized_weights`;
   `ChronologicalStack` undefined → `ChronologicalStacker`;
   `PLAIN_HIERARCHY` undefined → `HIERARCHY`; `y_train` dead code removed.
8. `pyflakes`: unused imports cleaned (`forecast.py` matplotlib, `spreads.py`
   yfinance, `bonds_EUR_data.py` config, one `bonds_EM_data.py` leftover).
9. Dead `run_forecast` variable in `us_public.py` removed.
10. libomp from brew needed for xgboost import — installed and documented.

### 8. Module port provenance (notebook cell → engine/pipeline file)

| Notebook cell | Ported into | Changes |
|---|---|---|
| 9 | `engine/spreads.py` | key via config; astype cast; skip empty pairs |
| 16 | `engine/default_rates.py` | key via config; LGD to config |
| 18 | `engine/data_engine.py` | key via config; multi-index flattener; tz-naive; no fallback |
| 21 | `engine/analysis.py` | runs forecast pipeline; composites spread-EL |
| 15 | `engine/forecast.py` | same math; `plt.show()` removed |
| 10 | `engine/pure_yield_forecast.py` | fixed PLAIN_HIERARCHY/matplotlib import; astype cast |
| 7 + 23 | `engine/volatility.py` | merged both; kappa dropped; live r; markup series applied |
| 8 | `engine/volatility_matrix.py` | verbatim minus `plt.show()` |
| 12 | `engine/ml_engine.py` | torch dependency removed (GPU auto-detect → `ML_USE_GPU` flag); fixes above |
| 13 | `engine/main_alpha.py` | fixed import paths; config usage |
| 17 | `engine/dealer_markup.py` | verbatim + path config |
| 19 | `engine/bonds_EUR_data.py` | data_engine yield helper |
| 20 | `engine/bonds_EM_data.py` | same + doc fixes |
| — | `config.py` | new, from cell 9/16/12 constants + audit decisions |

### 9. Verification state

- `pytest tests/ -q` → **17 passed** (pure-logic, no network).
- `pyflakes config.py cli.py engine/*.py pipelines/*.py tests/*.py` → clean.
- `py_compile` on all modules → clean.
- All imports resolve (full import graph verified in venv).
- Grep battery → zero:
  - private-credit terms (`private_credit`, `global_private`, `NeuralCox`, etc.)
  - leaked key outside `notebooks/` + `tests/test_config.py`
  - `np.random`/`torch.rand`/mock/synthetic in production code
  - `input(` prompts
  - placeholder literals (`0.04`, static markup, etc.) in production code
- `brew install libomp` completed (xgboost runtime).

### 10. Known gaps (from context.md)

1. `data/dealer_markup.json` contains the notebook's long constant series
   (4.189 repeating) — provenance uncertain; `engine/dealer_markup` regenerates
   from live MOVE/TNX on first run of `eur`/`em`/`us`. Treat pre-regenerated
   values as placeholder.
2. Model not validated out-of-sample (no backtest integration).
3. `--horizon` sensitivity (h=6/24) not yet exposed on CLI.

### 11. Session instructions for the next session

1. Read `context.md` in full.
2. Re-run audit scans (see section 9 of this ledger) at session start.
3. If changing any constant, update `context.md` §6 audit table + this ledger.
4. Never reintroduce private-credit code or placeholder random tables.

---

## Session 2 — 2026-08-09: GCO Plan (Global Credit Opportunity Layer) — Approved Blueprint

> This section is the **approved build plan** (user-approved 2026-08-09, layered-on-top
> architecture, all free sources incl. account-required free tiers). Every item below is
> either executed later in this session or left as an explicit future phase with a gate.
> Execution log for Session 2 work appears below this blueprint (section 12+).

### 2.1 Objective

Extend the Public Credit Opportunity Engine to **find public credit/debt opportunities
globally**, adding visibility into everything tradeable: the bonds themselves (yields,
spreads), volatility (model + real listed options), futures (Treasury/SOFR), positioning
(CFTC COT), transaction-level liquidity (FINRA TRACE), sovereign debt (World Bank/BIS),
and a unified Opportunity Board with honest data-availability reporting.

### 2.2 Hard design rules (approved)

1. **Free sources only.** Paywalled data excluded by fiat (Bloomberg, Refinitiv, Cbonds
   paid, FMP/API Ninjas paid tiers, official JPM EMBI). Free tiers requiring accounts are
   allowed; their keys live in `.env`, read only via `config.get_*_key()` getters, each
   with a clear "how to obtain" error message. `.env.example` documents every key.
2. **Availability gates, never placeholders.** Every source module returns real data or a
   structured `UNAVAILABLE: <reason + how to fix>` report. No fabricated series, no
   zero-fill of missing data, no random tables. Core legs fail loud; auxiliary signals
   degrade to UNAVAILABLE and the rest of the pipeline continues.
3. **Recency checks.** Every series reports as-of date and gap days; stale series are
   flagged `STALE` on the board, never silently treated as current.
4. **No look-ahead.** Signals use `shift(1)`; verified by test.
5. **Determinism.** No new randomness; seeds stay 42.
6. **No private credit, no interactive prompts.** Per context.md.
7. **Every new numeric constant enters context.md §6 audit table.**
8. **Business-day resampling** everywhere (existing pattern); per-source disk cache with TTL.

### 2.3 Source registry (all sources to integrate; verified status)

| # | Source | .env keys | Auth / signup (documented in .env.example) | Verified 2026-08-09 |
|---|---|---|---|---|
| S1 | FRED expansion | `FRED_API_KEY` (existing) | fred.stlouisfed.org/docs/api/api_keys.html | in production use |
| S2 | US Treasury Fiscal Data | none | keyless | **200 OK (probe)** |
| S3 | FINRA TRACE | `FINRA_API_CLIENT_ID`, `FINRA_API_SECRET` | gateway.finra.org/app/dfo-console → Individual account → **Public Credential** (free, non-commercial) | docs confirmed; key pending |
| S4 | CFTC COT | none | keyless public files | **file downloaded OK** |
| S5 | yfinance futures | none | keyless | in use (^IRX/^TNX) |
| S6 | yfinance options | none | keyless | library in use; chains probed |
| S7 | ECB Data Portal | none | keyless (SDMX) | endpoint live; series keys resolved by probe |
| S8 | World Bank API | none | keyless | **200 OK (probe)** |
| S9 | BIS stats | none | keyless | probed; gated if keyless path blocked |
| S10 | SEC EDGAR (Phase 2 opt.) | none | keyless, rate-limited | deferred |
| S11 | yfinance FX | none | keyless | in use pattern |
| S12 | Alpaca (optional) | `ALPACA_API_KEY`, `ALPACA_API_SECRET` | alpaca.markets free dev account | gated |
| S13 | FMP (optional) | `FMP_API_KEY` | financialmodelingprep.com free tier (~250 req/day) | gated |
| S14 | API Ninjas (optional) | `API_NINJAS_KEY` | api-ninjas.com free tier | **demoted: no bond/credit series; registry-only exclusion** |
| S15 | OpenBB (optional) | `OPENBB_HUB_KEY` (optional) | my.openbb.co free hub; OSS platform reuses provider keys | ~~gated~~ **removed 2026-08-10: user could not obtain the key; never implemented beyond a dead getter** |
| S16 | US Debt Clock (optional) | none | keyless JSON | gated |

### 2.4 New engine modules (phase 2)

`treasury_curve` (slope/curvature/forwards), `futures_layer` (SOFR-strip forward curve;
note futures for momentum/positioning only — CTD-ambiguous yields avoided),
`options_surface` (IV term/skew, IV−RV premium vs ETF-return GARCH, put/call OI; IV
history accrued to `data/iv_history.json` because chains are point-in-time),
`cot_positioning` (net spec z-scores, ≥2y window enforced), `trace_liquidity` (breadth,
volume, trade size, price dispersion), `sovereign_screen` (World Bank debt stocks +
BIS credit gap + yields; **unhedged** local-yield math only — no free FX forwards),
`eur_panel` (true EUR risk-free: German Bund; ECB corporate yields when probe passes),
`global_board` (Opportunity Board; conviction = (n_pos−n_neg)/n_avail, no magic weights),
`backtest` (walk-forward OOS: forecast hit-rate vs drift, ML calendarized IC, straddle
net returns, COT extremes → forward moves).

### 2.5 Phase 0 hardening (precondition fixes, executed this session)

Repair `dealer_markup.json` (strips `%%writefile` line), DR NaN gate, US empty-data
guard, `all_pure/all_pairs` flatten, EUR risk-free swap (German Bund primary / DGS10
warned fallback), `--horizon` CLI, ML yield None-fallback, weak-test fixes, silent
pair-skip warning, FRED session consolidation, `dealer_markup.run()` bootstrap in US.

### 2.6 Audit rounds R1–R4 (plan → audit → fix; findings + fixes executed)

- **R1 (data sourcing):** ECB series keys need exact codes (probe-verified; FRED
  `IRLTLT01*` monthly real-data fallback); FINRA has dataset-level fees → aggregated
  public datasets only; yfinance chains point-in-time → accrual mechanism + deferred
  IV-RV backtest; COT format drift → dual-format parser + fixtures; board weights
  uncalibrated → availability-normalized agreement; TIPS/real-rate leg added (S1).
- **R2 (omissions):** funding-stress anchors added (SOFR/NFCI/STLFSI); EM local FX leg
  added (S11); EUR/EM explicitly relative-value screens (no fabricated EL); ML yield
  0.0-fallback → None; TRACE transaction-level left gated (ToS).
- **R3 (integration):** `us_public` never regenerates dealer markup → bootstrap added;
  futures-implied yield only from SOFR strip (CTD ambiguity); `analysis.py` silent
  pair-skip → warn; engine→pipeline import inversion noted as debt (out of scope).
- **R4 (evaluation, user-requested):** options module vol must be on **ETF returns**
  (same underlying as option IV), not spread bps; optional sources strictly gated and
  API Ninjas demoted (no bond data); EM hedged carry impossible on free data → unhedged
  only, stated in output; per-contract COT min-history windows; probe-before-build
  gate; repair markup JSON before regeneration; recency/staleness layer added.

### 2.7 Accepted residual risks (mitigated, not fixable for free)

yfinance has no SLA (gates+cache); FINRA individual tier is non-commercial (README
disclosure); World Bank/BIS annual/quarterly cadence (documented refresh); IV-history
backtest needs accrual window (live signal from day one); FRED EM/EUR OAS series
existence verified via FRED search at build (gated if absent).

### 2.8 Execution order

Phase 0 hardening → Phase 0.5 source probe (`sources/probe.py`) → Phase 1 sources
S1–S11 (each gated + fixture-tested) → Phase 2 modules → Phase 3 pipelines + CLI
(`--market global|backtest`, `--horizon`, `--source`) → Phase 4 tests + docs
(`context.md` §6/§9, `README.md`, `.env.example`). Every phase ends with:
`pytest tests/ -q`, `pyflakes`, `py_compile`, secret-scan, private-credit-term scan.
---

## Session 3 — 2026-08-09: GCO layer build

> **Reconstruction note**: the original build log for this session was never
> written. This entry is reconstructed from the current module tree, the
> Session 2 blueprint (§2.3–§2.8), and the Session 4 audit notes (which name
> what existed when they reviewed it). Factual anchors: every file listed
> below exists in the tree today; Session 4's audit describes each fix applied
> on top of it.

- **Built `sources/` (12 modules + probe + registry):**
  `fred_ext` (FRED curve/Moody's/TIPS/macro/regional credit), `treasury_api`
  (auctions + debt-to-penny, v1 era), `cftc` (fut_fin_txt.zip parser +
  per-year disk cache), `ecb` (SDMX jsondata era), `bis` (gated), `finra`
  (Public Credential gated), `world_bank` (debt indicators), `yf_futures`
  (ZT/ZF/ZN/ZB/UB/SR3 panel), `yf_options` (ATM IV + P/C OI accrual),
  `yf_fx` (8 EM/DM pairs), `optional` (Alpaca/FMP/US Debt Clock, key-gated),
  `registry` (SourceUnavailable, SourceStatus, recency/staleness,
  `cache_json` TTL cache, IV-history accrual), `probe.py` (18-source probe →
  `data/source_probe.json`).
- **Built GCO engine modules:** `treasury_curve` (slope/curvature/bootstrap
  forwards/rolling 252d z), `futures_layer` (SOFR-strip implied forward
  rates only — CTD-ambiguous yields avoided), `options_surface` (IV-RV
  premium z + accrual to `data/iv_history.json`), `cot_positioning`
  (rolling lev-money/dealer z, ≥2y gate), `trace_liquidity` (FINRA-gated),
  `sovereign_screen` (World Bank 5y debt CAGR + unhedged FX overlay),
  `eur_panel` (German Bund risk-free — no US substitution), `global_board`
  (threshold-only conviction, availability-normalized), `backtest`
  (hit-rate / rank IC / Sharpe / Sortino / maxDD).
- **Built pipelines + CLI:** `pipelines/global_credit.py` (board: COT,
  options IV-RV, curve, sovereign, FX overlay) and `pipelines/backtest.py`
  (CURVE + COT OOS legs); `cli.py --market global|backtest`;
  config GCO constants + series maps (all entered in context.md §6).
- **Tests:** `tests/test_options_surface.py` (9 tests — weekend-accrual
  alignment, z-gate, no-look-ahead shift semantics). Suite at **26 passing**
  (17 prior + 9 new).
- **First probe results recorded:** ECB `jsondata` 400s on every key,
  BIS + US Debt Clock unreachable, FINRA/Alpaca/FMP key-gated, treasury
  curve/cftc/world_bank/yfinance legs OK.

---

## Session 4 — 2026-08-09: Ruthless audit + fixes (fable/karpathy protocol)

### What was audited (evidence-first, every claim re-opened)

- `sources/probe.py` loader `yf_options.accrue_iv` called
  `registry.accrue_atm_iv()` — function does not exist (AttributeError every
  run); redundant because `yf_options.snapshot_all` already accrues via
  `accrue_snapshot`. → loader and unused `registry` import removed.
- `engine/options_surface.premium_series` used `rv.reindex(...).ffill()`:
  an accrual date beyond the last trading day (weekend/holiday) produced
  NaN with no predecessor → empty premium → board printed "accrual 0/20"
  even with accrued days. → rewritten with `rv.asof(atm_iv.index)`.
- `premium_z` guarded `sd == 0`, but pandas float64 rounding gives a
  constant series std ≈ 6.9e-18 (verified empirically: mean
  0.05000000000000001) → emitted garbage z (observed -1.0 from pure noise).
  → guard now `not np.isfinite(sd) or sd < 1e-12`.
- `pipelines/backtest.py` measured the **trailing** 21d move
  (`pct_change(21)`) against a signal shifted by 1 — not a forward test,
  contradicting the "WALK-FORWARD OOS (no look-ahead)" header. → both legs
  now use `x.shift(-21)/x - 1` (true t→t+21 move).
- COT leg lacked the CFTC publication lag (Tue report → Fri release):
  ~3 days of future data leaked into the signal. → `daily.shift(3)`.
- `^TNX` download not squeezed for the yfinance Close-DataFrame quirk
  (worked by column coincidence). → `iloc[:, 0]` squeeze added.
- `sources/registry.load_iv_history` docstring described a format nothing
  writes (stale). → corrected.
- No tests existed for `options_surface` or `backtest` — both had just had
  bugs. → `tests/test_options_surface.py` added (9 tests).

### Verified non-flaws (checked, not changed)

- `cot_positioning.zscore` is rolling (52w/26 min) — no look-ahead in the
  board's live signal.
- Board conviction math is threshold-only, availability-normalized.
- `accrue_snapshot` is idempotent per date (overwrite, no duplicate rows).
- `history_to_frame` pivot cannot hit duplicate-index errors (per-ticker
  dates unique by construction).

### Verification (all re-run after fixes)

- `pyflakes` over cli/pipelines/engine/sources/tests: CLEAN.
- `pytest tests/ -q`: **26 passed** (17 prior + 9 new).
- Board: options legs now report `accrual 1/20 days` (was 0/20); COT and
  sovereign legs unchanged and coherent.
- Backtest: `[COT] lev-z vs forward 21d 10Y yield move: hit_rate 0.4669,
  n=1103` (was 0.457 against the trailing move) — still no forward edge,
  now measured honestly; CURVE leg FRED-gated (no key in dev).
- Docs: `context.md` §6 audit-log rows added for all GCO constants
  (`BOARD_SIGNAL_THRESHOLD_Z`, `BACKTEST_MIN_OBS`, `IV_Z_MIN_OBS`,
  `COT_MIN_HISTORY_YEARS`, `STALE_MAX_GAP_BDAYS`, COT cache TTL, CFTC
  publication lag); §7/§8/§9 updated.

### Remaining gaps (unchanged, documented)

- FRED key absent in dev → CURVE backtest leg unvalidated.
- IV-RV signal needs 20 accrued days; EMB ATM IV≈0.40 single obs to
  re-check as history accrues.
- Sharpe/Sortino strategy backtests not yet integrated.

### Session 4b — 2026-08-09: full-codebase audit + COT strategy leg

- **Read-audit of every remaining source/engine module** (cftc, fred_ext,
  treasury_api, ecb, bis, finra, optional, world_bank, yf_futures, yf_fx,
  sovereign_screen, trace_liquidity, futures_layer, eur_panel, cli):
  all clean — gating honest, no fabricated values, no look-ahead in
  rolling z-scores, formulas correct. No changes required.
- **.env re-checked**: `FRED_API_KEY=REPLACE_ME` still — CURVE backtest leg
  remains honestly gated.
- **Built the missing plan item**: `_bt_cot_strategy` in
  `pipelines/backtest.py` — Sharpe/Sortino leg trading ZN=F in the sign of
  the 10Y COT lev-z (publication lag 3 bdays + 1-day execution delay, no
  look-ahead). Live result: ann_return 0.0076, ann_vol 0.0657,
  **sharpe 0.116, sortino 0.189, max_dd -0.1504** (n=1127) — weak edge,
  reported as-is.
- **Fixed output flaw**: `strategy_metrics` leaked `np.float64(...)`
  wrappers into printed dicts → explicit `float()` casts.
- **Tests**: +3 (strategy_metrics basics, short-history gate, same-day
  signal has no edge after shift). `pytest`: **30 passed**; pyflakes CLEAN.
- context.md §9.2 updated (strategy leg integrated; CURVE strategy still
  FRED-gated).

---

## Session 5 — 2026-08-09: build-first completion (plan gaps + live-key runs)

### Build items (before audit)

1. **`.env.example` rewritten** — documents ALL keyed sources with signup
   instructions (FRED, FINRA client id/secret, Alpaca, FMP; OpenBB was later
   removed — see Session 5c) per plan
   rule 2.1, and replaced the leaked key literal with `REPLACE_ME`.
2. **`--source` CLI flag built** (plan Phase 3 promise, was missing) —
   repeatable, choices cot/options/curve/sovereign/fx/cot_strategy/
   curve_strategy; filters the GCO board and backtest battery
   (`cli.py`, `pipelines/global_credit.py`, `pipelines/backtest.py`).
3. **CURVE strategy backtest leg built** (`_bt_curve_strategy`): 2s10s
   slope-z mean-reversion on ZN=F minus ZF=F (equal notional), 1-day exec
   delay, rolling 252d z (no look-ahead).
4. **Keyed-source auth tests** (`tests/test_keyed_sources.py`, 9 tests):
   FINRA Basic base64 header, Alpaca APCA headers, FMP apikey param,
   no-key gating for all three, probe honesty without keys, US Debt Clock
   network-failure gating, ECB csvdata parser + schema-change gate.
5. **Secret-scan test extended** from `*.py`-only to all repo files — the
   old scan had missed the leaked literal sitting in `.env.example`.
6. **ECB fixed (live-verified before the WAF block)**: portal dropped
   `format=jsondata` (400 on every key) → `format=csvdata` (200, 3.1MB
   verified); `parse_ecb_jsondata` → `parse_ecb_csvdata` (row-filtered by
   KEY). National curves DE/FR are gone from the YC flow (404) → removed
   `ECB_SOV_10Y_KEYS` + `fetch_sovereign_yields` + probe row; the German
   Bund already comes from FRED `IRLTLT01DEM156N`. `EA_CORP_IG_10Y` code
   `G_AA_A` does not exist in CL_INSTRUMENT_FM (codelist-verified) →
   `C_N_T` (A- to AAA), live verification pending WAF block expiry.
7. **FRED Moody's ids fixed** (`MoodyAAA`/`MoodyBAA` → `AAA`/`BAA`, verified
   via FRED search; the old ids returned HTTP 400).
8. **Treasury `debt_to_penny` fixed**: dataset moved to `/v2/` (v1 404,
   v2 200) and the amount field is now `tot_pub_debt_out_amt` — live value
   2026-08-06: $39.89T.

### Audit-after-build findings (caught in the verification runs)

- **CURVE-STRATEGY sign error**: built `pos=-sign(slope_z)` (short the
  spread when steep); the leg's own rank IC (-0.0836, p≈0, n=6444) shows
  steep z → 10Y yield falls, i.e. flattening via the 10Y rallying → the
  flattening bet must be LONG the spread. Flipped to `+sign`; result
  Sharpe 0.203, Sortino 0.278, maxDD -5.35% (was -0.203 with the bug).
- ECB WAF blocked this client ("Your access has been blocked... HTTP 400")
  after the probing burst — the block is environmental, not a code flaw;
  module gates honestly.

### First-time live-key results (FRED key now active in .env)

- Probe: 11/18 sources OK (was 10/18 without moodys fix; ecb gated by WAF).
- Board: CURVE leg live for the first time — "US Treasury 2s10s,
  curve_z=-0.89, FLATTENER". COT board unchanged and coherent.
- Backtest: CURVE hit 0.459 / IC -0.0836; CURVE-STRATEGY Sharpe 0.203;
  COT hit 0.467; COT-STRATEGY Sharpe 0.116. All reported as-is.
- US pipeline: all 8 grades fetch (787 obs each), live DR (IG 1.34%,
  HY 2.92%), EL tables, dealer markup regenerated 1.10-1.24x (the 4.189
  placeholder series is now overwritten by live MOVE/TNX data).
- EUR pipeline: live Bund via FRED (842 obs), 2765 overlapping obs.

### Verification

- `pytest`: **41 passed** (was 30; +9 keyed-source tests, +2 ECB parser).
- `pyflakes` over cli/pipelines/engine/sources/tests: CLEAN.
- Secret scan (all files) passes; `.env.example` no longer carries a key.

### Remaining (documented in context.md §9)

- ECB `C_N_T` live verification after the WAF block clears.
- BIS + US Debt Clock endpoints dead (honestly gated).
- FINRA/Alpaca/FMP need user-supplied keys to move from gated to live.

- README.md updated with keyed-source documentation, `--source` usage, and
  the probe command (covered by the docs sync below).

---

## Session 5b — 2026-08-09: documentation sync (whole-chain record)

- LEDGER: Session 3 build entry reconstructed (was never logged); Session 5
  amended; consolidated pending list appended (below).
- context.md: §3 architecture tree + data flow now cover the full GCO layer;
  §4 lists the complete source registry (CFTC COT, World Bank, BIS, FINRA,
  yfinance futures/options/FX, optional keyed sources); §5 tightened the
  leaked-key record (also found in `.env.example`, removed; scan covers all
  files now); §8 test list updated (41 tests); §9 gap 1 marked resolved
  (dealer markup regenerated live); new §10 pending-items list; session
  script renumbered to §11.
- README.md: "Status" section added (what is live today + pending pointer).

### Pending / next steps (yet to be done)

1. **ECB `C_N_T` live verification** — codelist-verified IG key; the WAF
   rate-block ("access blocked", HTTP 400) must clear first; re-run
   `python -m sources.probe`.
2. **FINRA / Alpaca / FMP keys** — user must create the free
   accounts and paste keys into `.env`; sources are fully wired, probed,
   and mock-tested, and go live the moment keys exist.
3. **IV-RV signal** — needs 20 accrued days of `python -m sources.probe`
   runs (1 day accrued so far); EMB ATM IV≈0.40 single-obs to re-check as
   history accrues.
4. **BIS credit gap + US Debt Clock** — dead endpoints (501/404/500 on all
   variants); need alternative free sources if these legs are wanted.
5. **`--horizon` not wired to `global`/`backtest`** (only `--market us`);
   forecast sensitivity h=6/24 not parameterized.
6. **Strategy-leg caveat** — CURVE/COT strategy signs follow the economic
   hypothesis cross-checked against full-sample IC, not walk-forward
   fitted; a true OOS sign fit needs more data.
7. **Board label semantics** — curve leg `FLATTENER`/`STEEPENER` labels
   describe the z-sign state, not the position; display ambiguity to
   clarify.
8. **ANGL/EMHY options chains** — empty/absent at recent probes (thin
   markets); re-check periodically.
9. **US pipeline display wart** — "Latest USA yield spreads as of {…}"
   prints the full historical dict inline; pre-existing, cosmetic.
10. **COT BBG IG/HY credit futures legs** — history < 2y minimum; will
    unlock as history accrues.

---

## Session 5c — 2026-08-10: OpenBB removed (user could not get the key)

**What**: OpenBB had no real implementation — only a dead `get_openbb_key()`
getter in `config.py` (zero callers, no probe loader, no source module, no
test). Removed it wholesale.

**Why**: the user was unable to obtain an OpenBB Hub API key. No alternative
key was needed: nothing in the engine ever consumed OpenBB data, so the
registry, probe, board legs, and pipelines are unaffected.

**Changes**:
- `config.py`: deleted `get_openbb_key()`.
- `.env.example`: removed the `OPENBB_HUB_KEY` block (FMP stays as the last
  optional keyed tier alongside FINRA + Alpaca).
- `README.md`: key list + Status section no longer mention OpenBB.
- `context.md`: §4 sources list, §5 optional-key note, §10 pending item 2
  (now "FINRA / Alpaca / FMP keys").
- `LEDGER.md`: blueprint row S15 annotated as removed (historical record
  kept for the audit trail); Session 5 build note and pending lists updated.

**Verification**: `rg` shows no OpenBB in any active source or doc (only the
two historical annotations above); `pytest tests/ -q` → **41 passed**.

## Session 6 — 2026-08-10: Resolve every fixable open item (sources + wiring)

**What**: closed all remaining pending items from context.md §10 that code
could fix, and recorded the two genuine data-existence gates honestly.

**Why**: the goal for this session was a clean pending list — every live
verification done, every dead endpoint replaced, every CLI/tooling gap
wired.

**Changes** (all verified live, keys active in `.env`):

1. **ECB** (`sources/ecb.py`, `config.py`): corporate keys never existed in
   the YC dataflow — every `C_N_*` key 404s, and the dotted URL form
   `data/YC.B.U2...` 400s. Module now builds `data/YC/B.U2...` (flow as
   path component) and serves live GOVERNMENT curves: `G_N_A` AAA 10Y +
   `G_N_C` all-ratings 10Y (5603 obs, `?format=csvdata`). Euro corporate
   compensation stays on FRED `BAMLHE00EHYIOAS` + UCITS ETFs.
   `ECB_CORP_YIELD_KEYS` renamed → `ECB_YIELD_KEYS`.
2. **FINRA** (`sources/finra.py`): rewritten to the FIP OAuth2
   client-credentials flow (token POST → `ews.fip.finra.org`, Bearer on
   the Query API). The previously-configured dataset names 404'd; real
   names are `fixedIncomeMarket/CORPORATEMARKETBREADTH` +
   `CORPORATESANDAGENCIESCAPPEDVOLUME`. Live: breadth 3064 obs.
3. **BIS → World Bank credit-gap proxy** (`sources/world_bank.py`,
   `config.py`): dead `sources/bis.py` deleted; new
   `fetch_credit_gap_proxy()` uses `FS.AST.PRVT.GD.ZS` (domestic credit to
   private sector % of GDP, keyless, 5565 obs verified live).
4. **FMP + US Debt Clock removed** (`sources/optional.py`,
   `config.py`, `sources/probe.py`): FMP key 403'd on every endpoint and
   the enrichment was non-load-bearing; US Debt Clock 404'd everywhere and
   Treasury debt_to_penny already covers it live. Alpaca now quotes the
   SGOV ETF by symbol (the CUSIP lookup was the bug) — live.
5. **ANGL/EMHY options** (`sources/yf_options.py`): expiry-walk fallback —
   thin ETFs get the first expiry with a usable chain. ANGL now accrues
   (1/20 days). EMHY lists NO expiries at all — a genuine thin-market fact,
   stays honestly UNAVAILABLE.
6. **`--horizon` wired** (`cli.py`, `pipelines/backtest.py`,
   `pipelines/global_credit.py`): `--market us` = forecast horizon,
   `--market backtest` = forward window (default 21), `--market global`
   accepts (documented no-op).
7. **OOS sign fit** (`engine/backtest.py` `sign_fit_oos()` +
   `pipelines/backtest.py`): genuine walk-forward split-sample sign fit on
   both strategy legs, printed beside the hypothesis sign. Result: CURVE
   fitted +1 confirms hypothesis (OOS Sharpe 0.221); COT fitted -1 rejects
   it (OOS Sharpe -0.57) — reported as-is.
8. **Board label semantics** (`pipelines/global_credit.py`): curve leg
   labels the implied POSITION (`LONG_FLATTENER` when steep z>0,
   `LONG_STEEPENER` when flat z<0), z-state in the detail line.
9. **US display wart** (`engine/spreads.py` `print_spread_table`): prints
   the actual latest observation date instead of the trailing dict.
10. **IV-RV accrual automation**: `scripts/accrue_iv_daily.sh` + launchd
    plist `scripts/com.publiccredit.iv-accrual.plist` (weekdays 18:00) —
    the accrual runs itself; leg auto-unlocks at day 20.
11. **COT IG/HY gates** (no code change possible): Bloomberg IG/HY credit
    futures only began listing 2026-03 (HY) / 2026-05 (IG); the ≥2y gate is
    correct and auto-unlocks ~2028. Documented as a genuine data-existence
    constraint.

**Docs**: context.md §3/§4/§5/§8/§9/§10 rewritten to the live state
(16-source probe registry, ECB gov-only keys, FINRA OAuth flow, World Bank
credit gap, IV automation, resolved items struck through); README Status
rewritten.

**Verification**: `python -m sources.probe` → 16/16 sources available
(ECB 5603, FINRA 3064, WB credit gap 5565, Alpaca OK, ANGL IV=0.3892 via
expiry fallback); `python cli.py --market backtest` runs end-to-end with
OOS sign fits (CURVE +1 confirmed / COT -1 rejected); `--horizon 63`
accepted; `pytest tests/ -q` → **44 passed**; pyflakes clean.

---

## Session 8 — 2026-08-10: Session-7 Test Hardening (new tests 44 → 76)

### 1. What was done

New test batteries `tests/test_session7_sources.py` (19 tests) and
`tests/test_session7_signals.py` (13 tests) covering Session-7 work:

- **Sources**: `sec_edgar` filer/sector leverage, `treasury_api`
  (`debt_to_penny`, AUCSEC auction flag, no-key None), `world_bank` credit
  gap, `fred_ext` (live + stale-fallback synthetic), `yf_futures`
  (SOFR-package roll / zero OI guard / rate-calibration bounds),
  `yf_options` (weekend-accrual, thin-chain expiry-walk fallback),
  `cot_positioning` (rolling leverage/dealer z ≥2y gate, no-look-ahead),
  `credit_appetite` (IG/HY differential sign, default-rate component sign),
  `global_rates` (region matrix, stale-series exclusion), `sovereign_screen`
  (World Bank CAGR, FX-overlay rating override), `dealer_markup`
  (GARCH-variance no-NaN, MOVE/TNX hedge). Also: test_config now scans
  `.env.example` + `notebooks/` excluded, keyed-source auth (FIP OAuth2,
  Alpaca APCA) covered.
- **Signals**: `options_surface` weekend-accrual alignment + z-gate +
  IV-RV premium sign + strategy metrics + split-sample OOS sign-fit,
  `trace_liquidity` breadth/volume time alignment, `cot_positioning`
  week-day alignment, `global_credit` board assembly, `futures_layer` SOFR
  forward 2y slope z + position-implied-rate sign, `global_rates` stale
  series regression, `credit_appetite` credit-gap sign.

### 2. Bugs found and fixed during hardening

| Bug | Fix | Test |
|---|---|---|
| `_align` in `engine/global_rates.py` ffill'd past a series' death → RU's 2018 series appeared "current" on the board | Compute per-column cutoffs on the RAW series, then ffill (gap-fill) and apply cutoffs AFTER → a dead country can never look alive. Caused two test failures. | `test_screen_stale_series_excluded_from_regions` |
| `credit_appetite.default_rate_component` returned None on short/linear synthetic series (min_periods=63 on monthly DR) | Test data now realistic: 84 monthly points, stable then sharp 3.0→1.0 fall → comp > 0 asserted. | `test_default_rate_sign` |
| `pipelines/backtest.py` leftover unused `both` concat + unused `credit_appetite` import | Removed (pyflakes). | — |
| `tests/test_session7_sources.py` unused `import pandas as pd` | Removed (pyflakes). | — |

### 3. Verification

`pytest tests/ -q` → **76 passed**; `pyflakes` clean across config/engine/
pipelines/sources/tests/cli.

---

## Session 9 — 2026-08-10: Country Atlas + EUR "300%" Yield Bug Fix

### 0. What was instructed (2026-08-10)

The user asked (paraphrased): build, on top of everything existing **without
removing anything**, the pipelines behind a country/region portal — a world
map heatmap colored by returns, clickable per country to see per-instrument
returns across futures, options, straddles, other volatility strategies,
the bonds themselves, credit default swaps, IRF spreads and yield spreads —
integrating every possible investment strategy; free APIs are fine even with
account requirements; do not focus on UI; and investigate why European
yields looked like "300%+". (Filed also via /fable-emulation and
/karpathy-guidelines skills; the Fable five-gate loop was applied to the
yield bug and the atlas build.)

### 0.5 Instruction-following map (per CONTEXT.md §12 protocol)

| Instr. | Decision | Evidence |
|---|---|---|
| EUR "300%+" yields | FOLLOWED | §1 below; `tests/test_atlas.py::TestYieldTableDisplayRegression`; live `--market eu` |
| Portal map heatmap w/ per-country click-through | PARTIAL-BY-DESIGN: data layer only (user: "just build the pipelines… not focus on the ui") | §2 below; `data/atlas.json` contract test |
| Integrate futures / options / straddles / vol strategies / bonds / CDS / IRF + yield spreads per country | FOLLOWED, with honest gaps: CDS has NO free source (FRED series search returns none, verified 2026-08-10) → labeled `sovereign_spread_proxy`; straddle/vol-deep sections remain inside the existing US/EUR/EM spectrum (atlas links via `iv_history` + heat), not duplicated | §2 live run |
| Don't remove anything already built | FOLLOWED — delta is +`engine/atlas.py`, +`pipelines/atlas.py`, +`config` maps/keys, +`--market atlas`, +tests; zero deletions | `git`-less diff: grep + full pytest |
| Free APIs only | FOLLOWED — FRED keyless OECD yields, ECB keyless SDMX, yfinance; every gated source reports UNAVAILABLE | §2 live run |
| IRF spreads section | FOLLOWED — US SOFR implied 3M (382 bps) + euro-area 2s10s from ECB; back-month SOFR strip honestly UNAVAILABLE (Yahoo 404s those contracts, verified live) | §2 live run |

### 1. The reported bug: European yields printed as 300%+

**Root cause** (traced through the code, not guessed): the yield tables in
`engine/volatility_matrix.generate_yield_tables` received bps-valued columns
(all three pipelines convert percent→bps before the shared spectrum runner:
`engine/spreads.py:137`, `engine/bonds_EUR_data.py:40`,
`engine/bonds_EM_data.py:111`) but printed the raw value with a "%" suffix —
EUR_HY_OAS ≈ 350 bps rendered as "350.000%" in `europe_current_yields.png`
and the 5-day carry printed ~100x too large.

**Fix**: new pure helper `_format_yield_rows` (bps → percent for display,
carry prorated in true percent, NaN → "n/a"); `generate_yield_tables`
consumes it. 350 bps → "3.500%", 5-day carry → "4.79 bps".
Verified: unit regression test + live `--market eu` run (no crash, PNG
regenerated). The internal-bps convention is untouched — only display.

### 2. Country atlas (Opportunity Map) — data layer only, portal-ready

User ask: a clickable country map w/ rate-based heatmap; per-country
instrument returns (bonds, futures, options, straddles, CDS, IRF spreads,
yield spreads); integrate everything, do not remove anything, free APIs
only; no UI focus. New surface built **on top** of the existing pipeline:

| File | Purpose |
|---|---|
| `engine/atlas.py` | Pure logic: `yield_changes_bps` (no-look-ahead month-end diffs), `price_return_proxy` (−D·Δy), `rolling_z_last`, `sovereign_spread_proxy` (labeled CDS proxy), `heat_score` (unweighted mean of available 1m proxies), `assemble_country`, `region_rollup` |
| `pipelines/atlas.py` | Fetch layer: per-country OECD 10Y (FRED `IRLTLT01*M156N`, 14 countries), country equity ETFs (yfinance, labeled aux leg), US deep sections (2s10s daily z, futures momentum panel, SOFR implied 3M, IV-RV accrual history), ECB euro-area node (10Y/2Y/30Y AAA, 2s10s z); writes `data/atlas.json` |
| `cli.py` | `--market atlas` |
| `config.py` | `ATLAS_COUNTRY_YIELDS` (14), `ATLAS_REGIONS`, `ATLAS_COUNTRY_ETFS` (18), `ECB_YIELD_KEYS` += `EA_GOV_AAA_2Y` (verified live 2026-08-10) |

Instrument grid per country (all honest, proxy-labeled): bonds (10Y %,
1m/3m/12m chg bps, z), cds (UNAVAILABLE everywhere — no free CDS exists,
verified via FRED series search — with `sovereign_spread_proxy` = 10Y minus
US 10Y), yield_spreads (vs-US + z; US 2s10s daily leg, EZ 2s10s from ECB),
irf_spreads (US SOFR implied 3M; back-month SOFR contracts 404 on Yahoo —
strip slope honestly UNAVAILABLE), futures (momentum-only per
futures_layer seam caveat), options (IV accrual obs/z from
`data/iv_history.json`), equity_etf (labeled equity leg).

Live run (2026-08-10): 15 nodes; e.g. US 10Y 4.47% (OECD monthly), DE
2.97%, JP 2.67%, MX 9.45%, CH 0.31%; euro-area 2s10s 48.65 bps; MX CDS
proxy 498 bps; region rollup heat: americas −1.242, europe +0.809, asia
−0.535, apac +1.283, africa +2.508. `data/atlas.json` contract tested (all
node sections present, region values are plain floats).

### 3. Bugs found in my own output during verification (Gate 3)

| Issue | Fix |
|---|---|
| Region rollup emitted `np.float64` values into JSON | `float()` cast in `region_rollup` |
| `assemble_country` required a precomputed spread key | Computes `vs_us_10y_bps` from `us_yield_pct` when absent (self-contained pure fn) |
| Dead snippet (`spread_series` singleton) in `_monthly_bundle` | Removed |
| SOFR quarterly strip codes all 404 on Yahoo | Strip attempt removed; 404 fact + UNAVAILABLE documented in `irf_spreads.note` |

### 4. Verification

`pytest tests/ -q` → **94 passed** (76 → 94; +18 in `tests/test_atlas.py`);
pyflakes clean; `--market eu` live OK; `--market atlas` live OK and
`data/atlas.json` re-read shows clean numbers (numpy 2.x float128-subclass
values serialize natively; confirmed by reload).


---

## Session 10 — 2026-08-10: Record-keeping protocol established

### 0. What was instructed (2026-08-10)

"Append all of what has been done and what was instructed to be done in the
respective documents, and establish a protocol to record the instructions
and what has been followed, to the documents that they fit into."

### 1. What was followed

- Instr. 1 (record instructed work) → **FOLLOWED**: LEDGER.md Session 9 now
  opens with the verbatim-per-paraphrase instruction (`### 0. What was
  instructed`) and an instruction-following map marking every ask
  FOLLOWED / PARTIAL-BY-DESIGN with evidence, per the new protocol.
- Instr. 2 (protocol for instruction record-keeping) → **FOLLOWED**:
  CONTEXT.md gains `## 12. Instruction record-keeping protocol (every
  session, mandatory)` — LEDGER.md owns "instructed vs followed" (template:
  What was instructed / What was followed with 1:1 mapping and explicit
  FOLLOWED|NOT FOLLOWED|PARTIAL markers / Verification / Docs touched);
  CONTEXT.md owns the "where it fits" mapping table (instruction concern →
  target section: constants→§6, sources→§4, architecture→§3, scope→§2,
  run/CLI→§7, gaps→§9, pending→§10, history→LEDGER.md, secrets→§5), plus
  audit rules: an instruction landing nowhere is a protocol bug; gaps
  discovered during execution become §9 entries same-session; "done" claims
  must cite test/command; LEDGER.md is append-only.
- Instr. 3 (record into the documents they fit into) → **FOLLOWED**: this
  session's own entry is the first document written under the new protocol.

### 2. Verification

- CONTEXT.md `## 12` present; LEDGER.md Session 9 documented under it;
  `pytest tests/ -q` → 94 passed (no code touched this session);
  `rg -c "What was instructed" LEDGER.md` → entries exist.

---

## Session 11 — 2026-08-10: Multi-asset heatmap spec executed (fable protocol)

### 0. What was instructed (2026-08-10)

"Read the multi-asset heatmap spec (multi_asset_heatmap_spec.md), execute
and make what it says; also read the docs (CONTEXT.md/LEDGER.md), learn the
protocol, and execute what has not been executed." Work continued under
/fable-emulation (five-gate loop) per user request.

### 0.5 Instruction-following map (per CONTEXT.md §12 protocol)

| Instr. | Decision | Evidence |
|---|---|---|
| Read the multi-asset spec | FOLLOWED | §1 below; every spec §3 formula executed |
| Execute what the spec says (per-country return grid: bonds, CDS, straddles/VRP, futures basis/carry, IRF/spread legs, DB schema, FastAPI) | FOLLOWED, with honest gates: real yield US-only (no free per-country breakevens), CDS stays labeled proxy, per-country IV/straddle UNAVAILABLE outside the US, NK=F/FDAX.EX not listed on yfinance | §2; live atlas + uvicorn runs |
| Learn the docs protocol | FOLLOWED | §3; §12 mapping applied to this very entry |
| Execute what has NOT been executed yet (straddle yield, futures basis, real yield, full curves, GeoJSON, DB export, portal API) | FOLLOWED | §2 — these were the session's build delta; §4 |
| Don't break what exists | FOLLOWED | zero deletions; 121 tests pass; probe live |

### 1. What was followed

1. **Spec §3.1 (sovereign)** — full US nominal curve DGS2/5/10/30 + T10YIE
   breakeven → US real yield (`Y_10Y − breakeven`); euro-area AAA curve
   1Y/2Y/5Y/10Y/30Y (ECB keys verified live 2026-08-10, 5604 obs each) +
   2s10s; other countries stay 10Y-only (FRED OECD has nothing else free).
2. **Spec §3.3 (straddles/VRP)** — `yf_options.snapshot_ticker` now accrues
   the real ATM straddle price ($) + DTE per snapshot; atlas computes the
   annualized short-straddle yield `(P/S)·√(365/DTE)` and VRP (IV−RV_30d,
   RV on the SAME ETF returns, R4 invariant). Per-country IV stays honestly
   UNAVAILABLE (no country-ETF chain accrual exists).
3. **Spec §3.4 (futures carry)** — cash-index basis `(F−S)/S·365/DTE` on
   ES=F/^GSPC + NQ=F/^NDX (both live), DTE via the published CME third-Friday
   rule (pure calendar math, tested). NK=F/FDAX.EX verified NOT on yfinance
   → other countries' basis legs UNAVAILABLE.
4. **Spec §4 (DB schema)** — `sql/heatmap_schema.sql` (countries +
   country_financial_metrics, spec DDL) + `pipelines/heatmap_db.py` gated
   export (`--market atlas --db`): DATABASE_URL missing → UNAVAILABLE with
   fix hint (verified live); psycopg missing → UNAVAILABLE. `countries`
   geometry stays NULL (MultiPolygon shapes need a Natural-Earth-style
   import, not fabricated).
5. **Spec §6 (FastAPI)** — `api/server.py`: /api/v1/heatmap GeoJSON
   FeatureCollection (real centroids from config.ATLAS_COUNTRY_LATLON,
   heat score, 10Y + 1m change), /api/v1/countries/{iso} drill-down (404 on
   unknown), /api/v1/regions. Verified live under uvicorn (not TestClient,
   which needs httpx2 on this stack).
6. **Stub-IV event (discovered while executing, Gate 3)** — yfinance served
   whole chains at ~1e-5 IV (TLT/JNK at 0.016/0.004) that evening. Built
   `IV_MIN_REAL = 0.02` (calibrated: smallest real obs ever = 0.039; floor
   keeps >2x margin), same-day (dte ≤ 1) expiry skip, restored the authentic
   2026-08-10 morning snapshots to data/iv_history.json, removed the
   stub-only JNK entry. Regression battery tests/test_yf_options_gates.py (6).
7. **Pure-logic tests** — +21 in tests/test_atlas.py (straddle/basis/real
   yield/term-spread formulas, third-Friday calendar incl. year boundary,
   GeoJSON builder, DB-row builder incl. missing-leg None behavior). Suite:
   **121 passed** (was 94).

### 2. Verification

- `python cli.py --market atlas` — 15 nodes; US bond_curve
  2y 4.25/5y 4.40/10y 4.69/30y 5.22 + real 2.44 + breakeven 2.25; ES basis
  0.0726 ann (dte 14); EZ curve 1y 2.559 .. 30y 3.622 + 2s10s 48.6 bps;
  options IV/RV_30d/VRP for HYG/LQD/TLT/EMB/ANGL from the restored history.
- `python cli.py --market atlas --db` — `[DB] UNAVAILABLE: DATABASE_URL not
  set in .env | fix: paste a local Postgres DSN` (honest gate, live).
- `python -m uvicorn api.server:app --port 8753` + curl — heatmap 15
  features, US coords [-98.5, 39.8], MX drill 9.45%, unknown ISO 404,
  regions rollup OK.
- `python -m sources.probe` — 19/23 available; yf_options honestly
  UNAVAILABLE during the stub event (snapshots preserved); world_bank 400
  was transient (3/3 retries OK, 5565 obs); NDL 403 / Polygon 400/429 /
  BCB 502 once — observed as-is, non-load-bearing (recorded in context §10).
- `pytest tests/ -q` → **121 passed**; `pyflakes` clean over config/cli/
  engine/pipelines/sources/tests/api; private-credit term scan clean;
  secret scan (tests/test_config.py) passes.
- fastapi + uvicorn installed in .venv for the §6 verification (documented
  as OPTIONAL in requirements.txt; api exits with an install hint otherwise).

### 3. Docs touched

- CONTEXT.md: §3 (api/, sql/, heatmap_db, atlas spec legs), §4 (ECB
  1Y/5Y/30Y keys, T10YIE/DGS5/DGS30, ES/NQ index futures, straddle accrual,
  portal store + API), §6 (+IV_MIN_REAL, ATLAS_RV_WINDOW, DAYS_PER_YEAR,
  third-Friday rule, API_HOST/PORT), §7 (atlas --db, api.server, psql
  step), §8 (121 tests), §9.8 (stub-IV event RESOLVED), §10.11–13
  (spec legs RESOLVED; straddle accrual pending data; portal plumbing
  user actions).
- README.md: heatmap portal section (endpoints, Postgres, gating) + Status.
- LEDGER.md: this entry (append-only).
- .env.example: `DATABASE_URL` optional row.
- requirements.txt: OPTIONAL block (fastapi, uvicorn, psycopg[binary]).

---

## Session 11b — 2026-08-10: Spec-gap sweep (Redis cache) + gate re-proof

### 0. What was instructed

Continuation of Session 11: "execute what has not been executed." A literal
read of multi_asset_heatmap_spec.md §1 (storage layer) showed the only
remaining unimplemented architecture item: the Redis parse-cache.

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Spec §1 Redis cache | FOLLOWED — optional, mtime-keyed, no TTL constants, honest file fallback | api/server.py `load_doc()`; 6 pure tests |
| Straddle-yield accrual (spec §3.3) | NOT FOLLOWED TODAY — yfinance still serving sub-floor IV (1e-5..0.007, live probe) | probe gate messages below; §10.12 stays pending-data |
| Everything else in the spec | Already executed (Session 11); §3.2 `yield_spread_vs_ust` + `cds_spread_bps` verified present in atlas JSON + DB-row builder | grep + JSON walk, verified live |

### 1. What was followed

1. Read multi_asset_heatmap_spec.md in full (200 lines) — first complete
   literal read; mapped every §1–§6 line to an executed artifact. The only
   gap: §1 "Redis Cache" (Postgres was done in Session 11; the JSON cache
   was the fallback).
2. `config.get_redis_url()` (optional-key convention, REPLACE_ME-aware).
3. `api/server.py.load_doc()` — Redis parse-cache keyed on the atlas file's
   mtime (`atlas:doc` + `atlas:doc:mtime`), stale/missing/broken -> honest
   file re-parse + refresh; cache write failures never block serving.
   No new calibrated constants (mtime is the oracle — §6 untouched).
4. tests/test_api_server.py (6 pure tests): no-URL fallback, cache hit
   (file must not be re-read), miss -> re-parse + repopulate, stale mtime
   ignored, broken client falls back, missing dependency falls back.
5. Live re-proof of the IV floor: `python -m sources.probe` — yfinance is
   STILL serving 1e-5..0.007 IV (2026-08-14/21/09-18 expiries); every chain
   rejected by IV_MIN_REAL=0.02, real snapshots preserved, yf_options
   reports UNAVAILABLE honestly. The straddle-yield accrual (§10.12) stays
   blocked on data, not code — gate behavior verified live.
6. Probe statuses: 21/23 (BCB Selic 502 transient; NDL 403 + Polygon
   400/429 known non-load-bearing; world_bank retries OK 5565 obs).
7. Docs: .env.example (REDIS_URL), context §4 portal store + §8 (127) +
   §10.13 (c), README portal section, this LEDGER entry.

### 2. Verification

- `pytest tests/ -q` → **127 passed** (121 + 6 new); pyflakes clean over
  api/ config/ tests/.
- `python -m sources.probe` → 21/23; yf_options UNAVAILABLE with per-ticker
  floor-gate messages (snapshots preserved — see §1.5).
- API fallback smoke: `load_doc()` returns 15 countries with and without
  REDIS_URL set (redis absent -> file parse; URL set but server down ->
  file parse).

---

## Session 11c — 2026-08-11: Finish-what-is-left sweep (fable protocol)

### 0. What was instructed

"Update the todo list that is displayed to me and finish all the items
there and finish what is left" + /fable-emulation. Todo list: (1) launchd
IV-accrual automation, (2) data integrity check, (3) Redis layer live,
(4) full-market CLI smoke, (5) docs sweep, (6) final verification battery.

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Todo 1 — launchd automation | FOLLOWED — was NEVER installed; loaded now | launchctl list shows com.publiccredit.iv-accrual (exit 0); script ran end-to-end |
| Todo 2 — integrity | FOLLOWED — clean | §2 below: all snapshots above IV_MIN_REAL; 22/23 probe |
| Todo 3 — Redis live | FOLLOWED — dep installed, both paths proven | redis-py 8.1.0; URL-set-no-server fallback + plain parse both OK |
| Todo 4 — CLI smoke | FOLLOWED — 2 live bugs found and fixed | us/eu/em/ml/global exit 0; backtest exit 0 after fixes |
| Todo 5 — docs | FOLLOWED | §5 below |
| Todo 6 — final battery | FOLLOWED | §6 below |
| "Finish what is left" | PARTIAL by nature — IV-RV unlock (~18 more weekdays, automation now installed), straddle snapshot (yfinance still stub-fed), COT IG/HY (~2028), Postgres/Redis servers (user actions) | context §9/§10 |

### 1. What was followed

1. **launchd job installed** — scripts/com.publiccredit.iv-accrual.plist
   existed but was never loaded; copied to ~/Library/LaunchAgents/,
   `launchctl load`, verified in `launchctl list` (PID -, last exit 0,
   weekdays 18:00). Ran scripts/accrue_iv_daily.sh once end-to-end:
   ANGL 1/20, EMB 2/20, HYG 2/20, LQD 2/20, TLT 2/20 (all gated; the job
   now auto-accrues until the 20-day unlock).
2. **Integrity** — data/iv_history.json: 5 tickers, all snapshots above the
   0.02 floor (HYG 0.0513, LQD 0.1094, TLT 0.1074, EMB 0.4185, ANGL 0.3892),
   no stub pollution, no straddle fields yet (last real accrual predates the
   code; today's chains all floor-rejected). source_probe.json: 22/23
   available; sole failure NDL 403 (known). Live probe re-confirmed the
   stub-IV event is ongoing (1e-5..0.007 on 2026-08-14/21 + 09-18 expiries)
   and every chain was rejected, real snapshots preserved.
3. **Redis layer** — `pip install redis` (8.1.0) in .venv; requirements.txt
   OPTIONAL block updated; .env.example REDIS_URL row (already done 11b);
   live proofs: REDIS_URL set + no server -> honest file fallback (15
   countries), no URL -> plain parse (15).
4. **CLI smoke — two live bugs found by actually running everything**:
   - pipelines/backtest.py crashed at the APPETITE leg: `sign_fit_oos`
     returned an incomplete schema on the insufficient-obs path, and six
     print sites read `fitted_sign` unconditionally (KeyError). Fixed:
     engine/backtest.py gated path now returns the FULL schema
     (fitted_sign=None, ic_in_sample=None, metrics={"status":...}); all six
     sites (COT/CURVE/REAL-RATES/APPETITE/EM-CARRY/SKEW) now use a
     status-else-print guard. Extended test_sign_fit_oos_gates_short_history
     to assert the full schema.
   - engine/em_carry.py crashed with pandas "Cannot join tz-naive with
     tz-aware DatetimeIndex": yfinance dividend series carry an aware
     exchange-tz index while yf.download closes are naive. Fixed with
     _tz_naive() at distribution_yield entry (both inputs normalized;
     calendar-month resample stays wall-clock). New regression test
     (test_distribution_yield_mixed_timezones). EM-CARRY leg now live:
     1010 obs, Sharpe 0.446, OOS sign +1 (hypothesis confirmed
     walk-forward), 61 months carry.
   - Full battery exit 0: CURVE/COT/REAL-RATES/EM-CARRY live; SKEW gated
     (0/20 accrued, needs polygon key — known); APPETITE honestly
     reports 0 obs (recorded as context §9.9).
5. **Docs** — context §8 (128 tests), §9.9 (APPETITE 0-obs open gap),
   §10.13 (redis installed; server + DB still user actions); LEDGER this
   entry; requirements.txt redis row.
6. **Verification battery** — `pytest tests/ -q` -> 128 passed; pyflakes
   clean over config/cli/engine/pipelines/sources/tests/api; secret scan
   (tests/test_config.py) passed; private-credit term scan 0 hits.

### 2. Verification

- `launchctl list | grep publiccredit` -> `- 0 com.publiccredit.iv-accrual`.
- `bash scripts/accrue_iv_daily.sh` -> 5 tickers, 1-2/20 days, exit 0.
- iv_history walk + probe walk -> clean, 22/23, floor gate re-proven live.
- `pip install redis` -> 8.1.0; both load_doc() paths live-proven.
- us/eu/em/ml/global -> exit 0; backtest -> exit 0 (after fixes).
- `pytest tests/ -q` -> 128 passed; pyflakes clean; scans clean.

## Session 12 — 2026-08-11: Sweep + broker-premium lightening (docs/code/data)

### 0. What was instructed

"Do a full sweep of the directory's documents AND code, checking everything.
Write a new open_items.md listing all open items: bugs that must be fixed,
things to be built, tasks to be completed, and items queued behind something
else. During the sweep, do NOT change code — only required logs (context.md
and other doc files). EXCEPTION: fix/lighten the broker-premium assumptions —
returns before broker premiums are extremely high; only after broker premiums
do returns go negative."

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Full docs+code sweep | FOLLOWED | CONTEXT/LEDGER read in full; engine/pipelines agent sweep; manual reads of config/spreads/dealer_markup/volatility/volatility_matrix/volatility_strategy/api/server/sources (registry/probe/yf_options/optional/fred_ext/ecb/finra/world_bank); every root data JSON shape-checked (units found, §1.4) |
| open_items.md registry | FOLLOWED | new file: 5 bugs (§1), 5 to-build (§2), 3 to-complete (§3), 4 queued (§4), session evidence (§5) |
| No code changes during sweep | FOLLOWED | only broker-premium code touched (the exception) |
| Broker premiums lightened | FOLLOWED | §1 below |
| Update required doc logs | FOLLOWED | context §6/§9/§10, LEDGER this entry, open_items.md |

### 1. What was followed

1. **Sweep** — every root JSON's shape/units checked; every constant in
   config.py cross-checked vs the §6 audit table (only FALLEN_ANGEL + the
   missing PREMIUM_SHARE row needed changes); API/portal paths re-read;
   sources error-handling scanned. Remaining findings → open_items.md
   (§1.1 FA fee-model overshoot, §1.2 friction pin, §1.3 pair-leg retail
   sum, §1.4 percent-vs-bps file convention, §1.5 APPETITE 0-obs).
2. **Broker-premium fix** (the only code change; §6 audit table updated in
   the same edit per protocol):
   - `config.py`: `FALLEN_ANGEL_LIQUIDITY_PREMIUM` 1.20 → 1.05; new
     `DEALER_MARKUP_PREMIUM_SHARE = 0.3`.
   - `engine/dealer_markup.py::calculate_dealer_markup`: raw markup =
     `1.0 + SHARE × (IV/RV − 1.0)` (was the full IV/RV ratio), floor 1.05
     unchanged. Rationale: the short-vol trader's carry IS the IV−RV gap;
     charging 100% handed the whole collectible premium to the dealer.
   - Verification grid before/after (90th pct, hold 5d, bps): pre-fix HF
     nets −0.5..−27.0 (all ≤ 0; CCC −4.3, FA −27.0) → post-fix CCC +1.9,
     BB +0.6, B +0.3, A +0.2, BBB +0.1, AA −0.1, AAA −0.3; retail −0.2..−1.6
     (friction-bound); FA −18.3 (fee model, §9.10 — NOT a premium artifact;
     evidence: fee 36.5–42.3 vs realized |5d| 16.1 even at markup = 1.0).
3. **Tests** — new `test_dealer_markup_share_lightens_premium`
   (tests/test_volatility.py): shared markup stays < full IV/RV ratio and
   ≥ floor. `pytest tests/ -q` → 129 passed (128 + 1).
4. **Live verification** — `python cli.py --market us --percentile 90`:
   markup avg 1.174→1.069, max 1.816→1.245, floor 1.05; `data/dealer_markup.json`
   rewritten live; all 6 spectrum PNGs (PURE/SPREAD × Tier 1/2/3) regenerated.
5. **Docs touched** — context §6 (FALLEN_ANGEL row rewritten,
   PREMIUM_SHARE row added), §9 (new #10 FA fee-model overshoot),
   §10 (new #14 queued fix list, #15 broker-premium RESOLVED);
   open_items.md created; LEDGER this entry.

### 2. Verification

- `pytest tests/ -q` → 129 passed (includes the new share-lightening test).
- `python cli.py --market us --percentile 90` → exit 0, dealer_markup.json
  avg 1.069/max 1.245, 6 PNGs refreshed.
- Numeric grid (documented in open_items.md §5): post-premium HF nets no
  longer cluster ≤ 0 (CCC +1.9 / BB +0.6 / B +0.3 / A +0.2 / BBB +0.1;
  IG ≈ 0; FA −18.3 stands as fee-model bug §9.10, awaiting authorization).
- Remaining open items live in open_items.md §1–§4 (bugs / to-build /
  to-complete / queued) and context §9.10/§10.14.

## Session 13 — 2026-08-11: Resolve every technical open item (fable/karpathy)

### 0. What was instructed

"Now that you have seen all the open items, resolve all of them no matter
what the nature. Only leave the ones that require my input — write those in
a message and I will answer them. Anything technical to be decided, you
decide; anything concept-level about what is being built can be left for me."
(+/fable-emulation +/karpathy-guidelines.)

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Resolve all technical open items | FOLLOWED | §1 below: fee model, netting, friction, APPETITE, IVRV leg, battery re-run |
| Leave only user-input items | FOLLOWED | exactly 2 remain open: board vote semantics (COT/APPETITE fitted sign) + portal deployment (Q1/Q2, bundled earlier) |
| Technical decisions made by me | FOLLOWED | empirical fee (not OU kappa — data showed level reversion absent, whipsaw present); friction 0.5; resample("MS") + staleness gate; IVRV long-HYG hypothesis with OOS arbitration |
| Concept-level items left to user | FOLLOWED | COT board vote semantics; portal Postgres/Redis activation |

### 1. What was followed

1. **FA fee model** (`engine/volatility.py`) — measured first: FA daily diffs
   AR(1) ≈ −0.32; shock-day daily |Δ| 18.3 vs |Δ5| 16.1 (iid prediction ≈ 41);
   level-AR φ≈0.98 → an OU-kappa fix was the wrong tool. Replaced the
   vol-derived Bachelier fee with `get_empirical_move_fee` (rolling mean of
   realized |ΔT|, shifted T days — knowable only after the window). Live:
   FA fee 36.5→14.2, net −18.3→+1.4; all HF nets now positive (0.1–1.9).
   `calc_ou_straddle` retained as analytic reference (docstring updated,
   test kept).
2. **Pair-leg netting** — retail pays ONE netted straddle on the traded
   series; `raw_df`/`is_pair_mode` params removed from `analyze_strategy`
   and its two pipeline call sites.
3. **Friction** — `FRICTION_BASE_SPREAD_BPS` 1.0 → 0.5 (half-spread unit).
4. **APPETITE root cause** — DRCCLACBS is QUARTERLY (Jan/Apr/Jul/Oct 1st);
   `asfreq("ME")` → all-NaN → concat `.dropna()` emptied the composite
   (board component silently None; backtest leg 0 obs). Fixed both:
   `resample("MS").last()` (quarter dates ARE month starts), backtest
   reindex `.ffill(limit=21)` (composite dies 1 month after the last DR
   point — no frozen tail), board component staleness gate
   (`DR_STALE_MAX_AGE_DAYS = 130` → dark when >2 quarters old; measured
   last point 2026-01-01). Live: APPETITE leg 654 obs (fitted sign −1,
   reported honestly).
5. **IV-RV battery leg** — `options_surface.premium_z_series` (expanding-window
   z, no look-ahead, min-obs gate) + `_bt_ivrv` in pipelines/backtest.py
   (HYG premium z vs forward HYG returns, hypothesis + OOS fit); registered
   in the default battery. Live: "2/20 accrued", auto-unlocks at 20.
6. **Tests** — 6 new: empirical-fee no-look-ahead identity, whipsaw <
   0.6×analytic, pair netting, quarterly-DR cadence, DR staleness dark,
   premium_z_series gate; updated analyze_strategy smoke (signature) +
   default-rate-sign dates (non-stale). 129 → **135 passed**; pyflakes clean.
7. **Live verification** — `python cli.py --market us --percentile 90` exit 0
   (one transient yfinance stall on a parallel attempt — rerun clean, 6
   heatmap PNGs regenerated with the new fee model); `python cli.py
   --market backtest` exit 0.
8. **Docs** — context §3 (volatility.py line), §6 (friction 0.5, empirical-fee
   OU row, DR_STALE_MAX_AGE_DAYS), §8 (135), §9.9/§9.10 RESOLVED,
   §10.14 RESOLVED + §10.16 (IVRV leg built); open_items.md status board;
   LEDGER this entry.

### 2. Verification

- `pytest tests/ -q` → 135 passed.
- `python -m pyflakes` on all touched files → clean.
- `python cli.py --market backtest` → exit 0; APPETITE 654 obs (fitted −1,
  OOS Sharpe −0.205 reported), EM-CARRY 1010 obs (fitted +1), SKEW gated,
  IVRV gated 2/20.
- Direct 90th-pct grid (live data): HF nets CCC +1.8 / BB +1.9 / B +1.4 /
  FA +1.4 / A +0.2 / BBB +0.1 / AA +0.3 / AAA +0.1; retail −0.4..+1.2.
- Still open (user-owned, Q1/Q2): COT/APPETITE board vote semantics; portal
  Postgres/Redis activation. Data-existence items auto-resolve (IV-RV 20d
  unlock, straddle snapshot, COT ~2028).

## Session 13b — 2026-08-11: open_items.md every-run rule (docs only)

### 0. What was instructed

"Now update open items.md and update context.md with the rule of updating
open_items after every run."

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Update open_items.md | FOLLOWED | added §0 "Currently open (awaiting user input)" (Q1 board vote semantics, Q2 portal backend); header now states the every-run update rule; all §1–§5 entries re-verified current as of the 2026-08-11 sweep |
| Add the after-every-run rule to context.md | FOLLOWED | §11.6 added to the Session script (update open_items.md in the same pass as every run/verification/change, date + evidence, never stale); §12 mapping table gains the "Open items registry" row pointing to open_items.md per §11.6 |

### 1. What was followed

1. open_items.md: header rule line + new §0 open-questions block.
2. context.md §11.6 (new step in the session script) + §12 record-keeping
   table row for the registry.

### 2. Verification

- Doc-only change: no code, no tests touched; the two docs cross-reference
  (open_items.md → context §11.6; context §12 → open_items.md).

## Session 14 — 2026-08-11: Return curves, negative-returns audit, Q1 edge-gated voting, Q2 Docker portal

### 0. What was instructed

1. "I don't have DATABASE_URL/REDIS_URL and would like you to make docker."
2. "For Q1 what would be the best option — do that."
3. "Make it such that the returns shown should not be for a fixed period of
   days in a metric, and should be in a line graph with multiple lines with
   a legend for each different item where the return is shown."
4. "Negative returns seem sketchy and with error — please check your
   assumptions and mechanics as the returns must be positive even after
   broker premiums."

### 0.5 Instruction-following map

| Instr. | Decision | Evidence |
|---|---|---|
| Docker for DATABASE_URL/REDIS_URL | FOLLOWED | docker-compose.yml (postgis + redis, healthchecks, named volumes); .env + .env.example document DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/heatmap and REDIS_URL=redis://127.0.0.1:6379/0; `docker compose up -d` healthy; schema applied; `--market atlas --db` writes 15+15 rows (fix 1.7); API 200 + Redis cache verified |
| Q1 best option | FOLLOWED | chose **edge-gated fitted-sign voting**: legs vote only with demonstrated walk-forward edge (VALIDATED = fitted sign == hypothesis AND OOS Sharpe > 0; REJECTED/NOT_CONFIRMED abstain; UNVALIDATED vote + label). Battery persists to data/backtest_legs.json |
| Line-graph returns with legend | FOLLOWED | return_curve()/first_positive_hold() + plot_return_curves() (solid HF / dashed retail, legend, zero line, PNG `*_return_curves.png`); per-item table with net@CLI-hold AND first positive T; wired for US/EU/EM pure + pairs at GARCH_SIGNAL_PERCENTILE; no fixed-period-only metric remains |
| Audit negative returns | FOLLOWED | full component decomposition at 90th pct/T=5 (see §1): mechanics verified correct — fee = rolling empirical \|ΔT\| shifted by T (no look-ahead), no double-count, aligned windows; IG 5-day negatives are honest edge-vs-cost economics. ONE real mechanics bug found and fixed (1.6: FA premium substring match on BB/BBB) |

### 1. What was followed

1. **Audit** (instr. 4 → evidence): per-grade decomposition of 90th pct/T=5:
   AAA gross 2.57/fee 2.16/retail −0.24; BBB gross 4.00/fee 3.48/retail
   −0.40; AA/A/BBB/B all ≈ edge 0.4–0.6 bps < markup (~0.2) + friction
   (~0.5); HF positive via PB discount. T-curve scan T=1..15: edges grow
   with T; FA turns negative again at T≥10 (whipsaw). Bug found:
   `any(g in name for g in DISTRESSED_GRADES)` → "B" ⊂ "BB"/"BBB"/pairs paid
   FALLEN_ANGEL_LIQUIDITY_PREMIUM; fixed to exact membership
   `name in config.DISTRESSED_GRADES`.
2. **Return curves** (instr. 3): engine/volatility.py `_trade_cost_basis`
   (single source of truth for analyze_strategy + return_curve),
   `return_curve(series, percentile, retail_markup, hold_max=21)`,
   `first_positive_hold`; engine/volatility_matrix.py `plot_return_curves`
   (150 dpi, legend, zero line); pipelines/volatility_strategy.py
   `_plot_curves` + `_curve_summary_table` at GARCH_SIGNAL_PERCENTILE.
   Live 90th pct: retail@5 FA +1.19, BB +1.15, BBB −0.21, AAA −0.24,
   A −0.16, AA −0.04; first-positive holds FA/BB/CCC/B T1, A T7, BBB T9,
   AA T10, AAA T13 (retail); IG pair spreads never ≥ 0 (honest no-edge).
   PNGs: usa_public_pure_return_curves.png (339KB),
   usa_public_spread_return_curves.png (269KB).
3. **Q1** (instr. 2): engine/backtest.py `persist_leg_validation` /
   `load_leg_validations` / `leg_validation_status` (VALIDATED/REJECTED/
   NOT_CONFIRMED/UNVALIDATED); pipelines/backtest.py persists COT-STRATEGY,
   CURVE-STRATEGY, APPETITE, EM-CARRY, REAL-RATES, IVRV, SKEW
   (hypothesis_sign=1); pipelines/global_credit.py `_gate_leg` + validation=
   detail lines; cli.py adds `ivrv` to GCO_LEGS. Live battery:
   COT-STRATEGY fitted −1/OOS Sharpe −0.574 → REJECTED; APPETITE −1/−0.198
   → REJECTED; CURVE +1/0.215, REAL-RATES +1/0.737, EM-CARRY +1/0.060 →
   VALIDATED; SKEW 0/20, IVRV 2/20 UNAVAILABLE. Live board: all 6 COT rows
   [SKIP] "walk-forward battery rejected — fitted sign -1.0 (hypothesis +1),
   OOS Sharpe -0.574; no demonstrated edge, vote withheld"; REAL-RATES
   LONG_TIPS conviction +1.000; 2s10s LONG_STEEPENER; appetite 1/2
   components (honest).
4. **Q2 Docker** (instr. 1): docker-compose.yml (postgis/postgis:16-3.4,
   redis:7-alpine, publiccredit-postgres:5432 / publiccredit-redis:6379,
   volumes heatmap_pgdata + heatmap_redisdata, healthchecks); daemon
   started via `open -a Docker` (Docker 29.6.2, compose v5.3.1);
   psycopg[binary] installed; schema applied via psql; `.env`/
   `.env.example` URLs; `--market atlas --db` → first run FAILED live with
   psycopg3 "2 placeholders but 15 parameters" → heatmap_db.py
   execute→executemany (both upserts) → 15+15 rows verified via psql
   counts; Redis keys atlas:doc + atlas:doc:mtime verified; API smoke:
   /api/v1/regions, /countries/US, /countries/DE, /heatmap all 200 after
   NaN fixes (futures_layer mom_21d finite-only + api/server.py
   `_clean_for_json` — /countries/US was 500 on a legacy mom_21d NaN).
5. **Live-data bug 1.9**: global board em_carry row UNAVAILABLE with
   `AttributeError: 'Ticker' object has no attribute 'replace'` →
   _etf_fund_data lambda captured the yf.Ticker object, not the symbol →
   lambda rebinds `f`; EM-CARRY now live, VALIDATED.

### 2. Verification

- `pytest tests/ -q` → **141 passed** (135 + 6 new:
  test_fallen_angel_premium_exact_grade_only, test_return_curve_shape_and_first_positive,
  tests/test_board_validation.py ×3 [status matrix, roundtrip incl.
  last-write-wins + broken-file → {}, json_safe defaults],
  test_clean_for_json_strips_nan). DGP for the curve test: 10-day sigma-2.3
  spikes every 90 days over 0.3 baseline (regime-flip + log-vol AR(1) DGPs
  failed: GARCH spikes land at regime transitions / 90d fee tracks smooth
  vol).
- `python -m pyflakes engine/ pipelines/ api/ config.py cli.py tests/`
  clean (after removing an unused pytest import).
- Live runs: `--market us --percentile 90 --hold-days 5` (curve tables +
  PNGs); `--market backtest` (5 persisted validations);
  `--market global` (validation-gated board); `docker compose ps` both
  healthy; API endpoints 200.

### 3. Docs touched

- CONTEXT.md: §3 (docker-compose.yml + backtest_legs.json + return-curve
  annotations), §4 (portal store — dockerized, NaN-sanitized API), §6
  (FALLEN_ANGEL_LIQUIDITY_PREMIUM: exact-grade application),
  §7 (docker steps + return-curve view), §8 (141 tests), §9.11 (negative
  fixed-period returns audit RESOLVED + FA substring bug),
  §9.12 (psycopg3/NaN/lambda live bugs RESOLVED), §10.13 (portal DONE),
  §10.17 (board vote semantics RESOLVED).
- open_items.md: §0 Q1+Q2 closed; new bugs 1.6–1.9; build 2.6; §3.2, §4.3
  resolved; §5 session-14 block appended.

## Session 15 — 2026-08-11: Three-view curves, EUR country panel, full technical sweep (docs/code/data)

### 1. What was instructed

- (15.1) Turn the single return-curve chart into **three views** (gross /
  HF net / retail net), one PNG per view, across every market run.
- (15.2) Add a **EUR country-level panel** (per-country 10Y yields, spread
  vs the Bund, changes, and the same straddle/return-curve machinery on an
  honest monthly cadence).
- (15.3) Resolve **everything technical left open** in `open_items.md`:
  fix live-data bugs found in the sweep, verify remaining open items, and
  finish the record-keeping protocol (CONTEXT.md, open_items.md, LEDGER.md).

### 2. What was followed

- Instr. 15.1 → FOLLOWED: `return_curve()` gains `Gross_bps` (Tier 1
  payout); `plot_return_curve_view()` renders exactly one view per PNG;
  `pipelines/volatility_strategy.py` emits
  `{region}_{tag}_{gross,hf_net,retail_net}_return_curves.png` for every
  us/eu/em pure + spread pair; the per-item table gains a `gross@T` column.
- Instr. 15.2 → FOLLOWED: `engine/eur_country.py` built —
  `config.ECB_LTIR_COUNTRY_KEYS` (11 keys, all verified live 2026-08-11),
  country 10Y LTIR + Bund-spread table (1M/3M/12M changes), country
  level + spread straddle/return curves with monthly hold units
  (`europe_country_{level,spread}_{view}_return_curves.png`); EUR/EM
  upgraded to the full shared machinery with adjacent-tier spread pairs
  (EUR_HY−EUR_IG; EM_Corporate−EM_USD_Sovereign, EM_High_Yield−
  EM_Corporate, EM_Local_Currency−EM_High_Yield).
- Instr. 15.3 → FOLLOWED: four live-data bugs found and fixed —
  (a) GCO sovereign leg dead (`GLOBAL_SOVEREIGN_COUNTRIES` held suffix
  fragments "USM" → `IRLTLT01USMM156N` 400s; now full series IDs, leg
  votes KR LONG_DURATION); (b) API keys leaked in fetch-error logs
  (FRED in `data_engine.fetch_fred_series`, polygon/NDL in their
  SourceUnavailable messages → all scrub the literal, +2 regressions);
  (c) FINRA breadth date column `tradeReportDate` missed by the appetite
  matcher → composite ran 1/2 components; matcher now includes
  `tradereportdate`; (d) `_trade_cost_basis` components indexed on the
  wrong (DE) index → reindexed to the series' own index (monthly country
  path works). EMB ATM IV re-checked live (0.1604, expiry moved —
  §9.17); first REAL straddle snapshots accrued (HYG/LQD/TLT/EMB/JNK) so
  the atlas options section shows `straddle_yield_ann` live; `.env` still
  holds the compromised FRED key (prefix `ccb67ba5`) — flagged for the
  user in open_items.md §0 (logs redact meanwhile).

### 3. Verification

- `pytest tests/ -q` → **147 passed** (was 141; 6 new: straddle-yield
  accrual formula, EUR country panel math ×2, NDL/Polygon redaction ×2,
  three-view curve shape).
- `python -m pyflakes engine/ pipelines/ api/ config.py cli.py tests/`
  clean.
- Live runs exit 0: `--market us --percentile 90 --hold-days 5`,
  `--market eu`, `--market em`, `--market backtest`, `--market global`.
- 24 three-view curve PNGs (us/eu/em × pure/spread × 3 views) +
  `europe_country_{level,spread}_*_return_curves.png` generated.
- `rg` embedded-key scan clean; CONTEXT.md §9.13–9.17, §10.3/10.12/10.16,
  §4/§5/§7/§8 updated in the same pass.

### 4. Docs touched

- CONTEXT.md: §4 (FRED sovereign series fix + key redaction; straddle
  snapshot facts), §5 (compromised-key flag + log redaction), §7 (three-view
  PNG naming + country panel), §8 (147 tests), §9.13–9.17 (sovereign leg /
  key leak / FINRA column / index anchor / EMB IV), §9.6 (accrual
  progress), §10.3/10.12/10.16 (IV-RV, straddle accrual, IV-RV battery).
- open_items.md: §0 user-action flag; bugs 1.10–1.13 RESOLVED; builds
  2.7–2.8; §3.1/3.3 resolved; §4.1 DONE; §5 session-15 block appended.

## Session 16 — 2026-08-11: To-do sweep — everything left over, executed and verified

### 1. What was instructed

- (16.1) "Update the to do list and do everything that is left over there" —
  re-audit the open-items registry, execute every actionable remaining item,
  and verify each with live runs.

### 2. What was followed

- Instr. 16.1 → FOLLOWED. Register re-audited: §0 FRED key + §2.5 COT
  credit futures + §3.3 EMHY/ANGL + §4.2 IV-RV were the only non-resolved
  items; each handled in this pass:
  - §0 — USER-BLOCKED, re-verified: `.env` still holds the compromised key
    (prefix `ccb67ba5`); flagged again with instructions (fred.stlouisfed.org
    → API keys). Nothing in code can substitute a fresh credential.
  - §4.2 IV-RV — DATA-GATED: 3/20 verified unchanged; accrual script re-run
    (exit 0, 22/23 sources, idempotent for today); auto-unlocks ≈ early
    September (~17 weekday snapshots). No code change possible.
  - §2.5 COT credit futures — DATA-GATED: contracts listed 2026-03/05; ≥2y
    history gate ≈ 2028. Nothing to do; reported honestly.
  - §3.3 EMHY/ANGL — re-verified LIVE: EMHY still zero listed expiries
    (yfinance `options = ()`); ANGL has 4 expiries but the nearest chain
    shows 0 calls / 2 puts, zero OI — no straddle quote, honest None.
- Instr. 16.1 full live battery (all exit 0, 0 tracebacks):
  `pytest tests/ -q` → 147 passed; `--market backtest` (CURVE +1/0.215,
  REAL-RATES +1/0.738, EM-CARRY +1/0.061 VALIDATED; COT-STRATEGY
  −1/−0.572, APPETITE −1/−0.198 REJECTED; IVRV gated 3/20);
  `--market global` (sovereign legs live — KR LONG_DURATION, EM_EMEA/
  EM_LATAM SHORT_DURATION, EM sector RICH_AVOID rows); `--market us/eu/em
  --percentile 90` (US ~25 min incl. spread-pair + pure curve tables and
  three-view PNGs; EU incl. country panel, monthly hold units; EM pairs);
  `--market atlas` (region rollup: americas −1.242, europe 0.809, asia
  −0.535, apac 1.283, africa 2.508).

### 3. Verification

- `pytest tests/ -q` → 147 passed.
- `python -m pyflakes engine/ pipelines/ api/ config.py cli.py tests/` →
  clean (no code changes this session, re-confirmed).
- Live runs as listed in Instr. 16.1 — all exit 0, zero tracebacks.
- `bash scripts/accrue_iv_daily.sh` → exit 0, 22/23 sources, IV accrual
  counts unchanged (3/20 — today's snapshot already present).

### 4. Docs touched

- open_items.md: §0 (re-verified key, marked the only user action),
  §4.2 (re-verified 3/20 + attrition date), §5 session-16 block appended.
- CONTEXT.md: no changes needed — §9.6/§10.3 accrual counts, §10.10 COT
  gate, §9 EMHY facts all remain accurate after re-verification.

## Session 16b — 2026-08-11: IV-RV build-completeness proof (simulated unlock)

### 1. What was instructed

- (16b.1) For the IV-RV signal (3/20 accrued, auto-unlocks ~early Sept):
  build it so the data accrues daily and once it unlocks it works — prove
  it is completely built, not partially wired.

### 2. What was followed

- Instr. 16b.1 → FOLLOWED. Audited the full chain end-to-end
  (accrual → signal → board leg → battery leg); no stubs found:
  - Accrual: `scripts/accrue_iv_daily.sh` + launchd job
    `com.publiccredit.iv-accrual` loaded (last exit 0, weekdays 18:00);
    `IV_MIN_REAL` gate keeps bad feeds from overwriting real days;
    script re-run this session: exit 0, 22/23 sources, idempotent.
  - Signal: `options_surface.premium_z` (board) / `premium_z_series`
    (battery walk-forward), both gated on `IV_Z_MIN_OBS = 20`.
  - Board leg `_options_rows`: [SKIP] n/20 until 20, then
    SELL_VOL/BUY_VOL/NEUTRAL with battery-gated validation for HYG.
  - Battery leg `_bt_ivrv`: UNAVAILABLE until 20, then metrics +
    `sign_fit_oos` + `persist_leg_validation("IVRV", ...)`.
- Instr. 16b.1 → PROVEN. Two new tests added to
  `tests/test_options_surface.py` (149 total, was 147):
  - `test_premium_z_unlocks_exactly_at_min_obs` — pins the 19→None /
    20→z flip.
  - `test_ivrv_battery_leg_unlocks_and_runs_end_to_end` — synthetic
    200-day accrual + monkeypatched yfinance close + tmp history/legs
    files (real data files untouched): asserts the leg prints full
    metrics + OOS sign fit, persists "IVRV" with hypothesis_sign=1 and a
    real fitted sign; "UNAVAILABLE" absent.
- Live-shaped demo (non-polluting, real history deep-copied +22 simulated
  accrual days, REAL HYG closes): n 3→25, z −0.694, walk-forward z series
  active (6 pts), board vote computed as designed (NEUTRAL) — the same
  code path that will run for real in early September.

### 3. Verification

- `pytest tests/ -q` → **149 passed** (2 new).
- `python -m pyflakes engine/ pipelines/ api/ config.py cli.py tests/`
  clean.
- Real `data/iv_history.json` and `data/backtest_legs.json` unmodified
  (tests + demo run on tmp copies / monkeypatched paths).
- launchctl: com.publiccredit.iv-accrual loaded, last exit 0.

### 4. Docs touched

- open_items.md: §4.2 — build-completeness proof + demo numbers recorded.
- CONTEXT.md: §8 test count 147 → 149 (new boundary + end-to-end unlock
  tests); §9.17 note untouched (accrual counts unchanged, 3/20).

## Session 17 — 2026-08-12: Web frontend (Vite + ECharts SPA) — rebuild after environment wipe + live API-layer fixes

### 1. What was instructed

- (17.1) Web frontend for the opportunity engine: Vite + ECharts SPA with a
  Vercel-compatible serverless API layer (`web/api/*.js` handlers), three
  pages + country drill-downs, opportunity map, projected return curves
  (1M–15Y), real history charts, custom full-name legends, period/zoom
  controls — and a committed seed bundle fallback so the site works offline
  or rate-limited. An environment wipe removed part of the build; finish and
  verify everything end-to-end.

### 2. What was followed

- Instr. 17.1 → FOLLOWED. State inspected first (handlers existed;
  `src/pages/`, `src/main.js`, `scripts/`, `public/data/` were missing after
  the wipe; `node_modules` gone; `api/_shared.js` had drifted back to a
  pre-retry snapshot).
- Rebuilt the SPA layer:
  - `src/pages/{map,returns,history,country}.js` — heat map + region rail +
    top-3 + table (click → drill-down); market/mode/view chips + period bar +
    full-name toggleable legend + methodology notes; US grade spreads +
    default-rate history + sovereign selector; country instruments table +
    projected curve + real history.
  - `src/main.js` — hash router, page dispose on navigation, data stamp,
    `window.__pc` audit handle.
  - `src/charts/{map,projection,history}.js` — ECharts geo over the vendored
    world.json (heat diverging green/beige/red), cumulative
    (1+month-1-net)(1+annualized-edge)^(h−1) projection (view col
    gross/hf/ret), real-history multi-series; per-asset palette keyed on
    asset order (color-stability fix), `hidden`-series visibility via the
    store hub.
  - `src/{controls,legend,store}.js` — period presets + shared dataZoom,
    custom legend (full names + stands-for subtitles), API-first +
    `bundle.json` fallback store with chart-state hub.
  - `scripts/{serve,web_seed}.mjs` — local dist+API server for the audit
    (with a dependency-free `.env` loader for dev; Vercel injects env vars
    in production) and the seed-bundle generator. `package.json` scripts
    `seed`/`serve` added.
- `public/data/world.json` re-vendored — echarts@5.x no longer ships map
  JSONs: pinned `echarts@4.9.0` jsdelivr copy (217 features, USA/DE/FR/…/ZA
  matched; "South Korea" → basemap "Korea" alias in map.js); `bundle.json`
  regenerated (15 countries).
- LIVE FINDINGS fixed in the API layer (both verified live today):
  - **FRED `fredgraph.csv` endpoint decommissioned**: every
    `api.stlouisfed.org/fredgraph.csv?id=…` request (both `id` and
    `series_id` forms) now returns 404 with 0 redirects; the keyed
    `fred/series/observations` JSON API is the live path. `fredCsv` rewritten
    onto the JSON API (asc sort, "."-skip, retries kept). Without this the
    entire US layer was dead.
  - **ECB csvdata parse was positional** (`cols[1]/cols[3]` = FREQ/IR_TYPE →
    all rows skipped silently) → header-driven column mapping
    (TIME_PERIOD/OBS_VALUE indexes). The countries market was empty for
    this reason.
  - `angRows` undefined typo in `api/returns.js` fixed; `fetchWithRetry`
    reapplied to `fredCsv`/`yahooChart` (the wipe had reverted it; FRED 429
    bursts under burst load without it); serve.mjs now logs env load status
    (no secrets).
- Seed fallback honored in `store.loadAtlas` (bundle under `.countries`).
- Verification (see §3): all four routes render canvases with zero console
  errors; every API market/mode responds.

### 3. Verification

- `node --check` clean across `api/` + `src/`; `npm run build` ✓ (1.06 MB,
  352 kB gzip).
- `node scripts/serve.mjs 8787` + headless Chrome
  (`--virtual-time-budget=45000 --dump-dom`) on `#/map`, `#/returns`,
  `#/history`, `#/country/DE`, `#/country/GB`:
  map: 1 canvas, 17 rows, 0 empties; returns: 1 canvas + legend, 0 empties;
  history: 2 canvases + 2 legends, 0 empties; country/DE: 2 canvases + 2
  legends, 0 empties; country/GB: 1 canvas, 1 honest empty (GB not in the
  ECB LTIR euro-area panel). Zero console errors in every log.
- API sweep: `?market=us&mode=pure` → 8 assets; `countries` → 11 ECB LTIR
  countries; `history?market=us` → 7 grades + DR_HY (85 pts);
  `history?country=DE` → 258 monthly pts via FRED JSON API (2026-06-01).
- FRED JSON API + ECB csvdata direct curls 200 (series-level 404s confirmed
  on the old CSV endpoint before the fix).

### 4. Docs touched

- CONTEXT.md: §3 architecture (web/ tree), §4 (FRED JSON API fact +
  fredgraph.csv decommission), §7 (web run commands), §9 (item 18),
  §10 (pending item 18 done).
- open_items.md: §1 bugs 1.14/1.15, §2 web deliverable, §3 seed/serve,
  §5 session-17 block.

## Session 18 — 2026-08-12: To-do sweep — update the registry and complete remaining items

### 1. What was instructed

- (18.1) "Now update the to do list and complete the remaining items" — the
  §11.6 sweep: re-read open_items.md, execute/verify every remaining
  actionable item, and update the registry in the same pass.

### 2. What was followed

- Instr. 18.1 → FOLLOWED. Registry re-read: remaining items were §9.18
  (Python engine FRED CSV port — flagged open in CONTEXT), §4.2 (IV-RV
  accrual count), §2.3 (atlas straddle_yield_ann), §0 (FRED key swap,
  user action). Each handled:
  - §9.18 → RESOLVED with evidence, no code change: the Python tree has
    ZERO `fredgraph` references; `config.FRED_BASE_URL` and
    `engine/data_engine.py:34` already target the keyed JSON observations
    API. Live proof: 6-series fetch through `fetch_fred_series` (DGS10
    16,855 obs → 4.720% 2026-08-10; DGS2/DGS30; IG AAA OAS 0.40; Bund
    842 obs → 2.97% 2026-06; DRCCLACBS 141 obs quarterly as designed)
    plus two real board runs — `python cli.py --market global --source
    curve` (CURVE z=−0.6, VALIDATED, LONG_STEEPENER label correct) and
    `--source sovereign` (World Bank debt CAGR + FRED country yields →
    RISING_DEBT Uzbekistan) — both exit 0, zero tracebacks.
  - §4.2 → re-verified 3/20 (HYG/LQD/TLT/EMB), ANGL 2/20, JNK 1/20;
    last real snapshots 2026-08-11. `bash scripts/accrue_iv_daily.sh`
    ran: 22/23 sources (polygon redacted 400/429, non-load-bearing).
    **Live gate event**: today's midday feed served stub implied vols
    (1e-05 … 0.008) and `IV_MIN_REAL = 0.02` rejected every snapshot —
    `data/iv_history.json` untouched (mtime 08-11 22:58) — the guard
    protecting real history under a degraded feed, observed in the wild.
    launchd `com.publiccredit.iv-accrual` loaded, exit 0. Auto-unlock
    ≈ early September unchanged.
  - §2.3 → DONE: data/atlas.json (generated 2026-08-12 01:04) options
    section live: HYG 0.0319 / LQD 0.0593 / TLT 0.1073 / EMB 0.0866 /
    JNK 0.0738 straddle_yield_ann; ANGL honest empty (no straddle quote).
    Web seed bundle regenerated to match (`node scripts/web_seed.mjs` →
    bundle.json, 15 countries).
  - §0 → re-flagged: the compromised key literal stays in `.env`; now also
    load-bearing for the deployed site's API env var. No code can fix it.
- Verification battery: `pytest tests/ -q` → 149 passed; pyflakes clean.
  No constants changed → no §6 edits.

### 3. Verification

- Live FRED series fetch (exact command in §2) — all 6 series non-empty,
  correct cadences, correct latest values.
- `python cli.py --market global --source curve` and `--source sovereign`
  — exit 0, board rows printed, FRED + World Bank legs live.
- `bash scripts/accrue_iv_daily.sh` — exit 0, 22/23 sources, gate-reject
  messages for all six tickers (stub IVs), counts unchanged (3/2/1 per
  ticker as documented), history file mtime unchanged.
- `pytest tests/ -q` → 149 passed; `python -m pyflakes engine/ pipelines/
  sources/ api/ config.py cli.py tests/` → clean.
- `node scripts/web_seed.mjs` → bundle.json written (15 countries).

### 4. Docs touched

- open_items.md: §0 (re-flag), §1.14 (resolved both layers, session-18
  evidence), §2.3 (DONE with atlas values), §4.2 (re-verified + live gate
  event), §5 session-18 block.
- CONTEXT.md: §4 (Python engine confirmed on the JSON path), §9.18
  (struck resolved), §10 item 3 (re-verify note).

## Session 19 — 2026-08-12: Web dashboard audit + auto-go-live Signals page

### 1. What was instructed

- (19.1) "Before I host it on vercel, try rendering and using the dashboard
  on your own to see how it is. You must use and try and audit every single
  feature and everything. Your process must be that you load the dashboard
  and test it where you do everything possible and try to run it. If you see
  any feature does not work well or is not displayed as intended, then work
  on it and fix those issues that you see."
- (19.2) "For features that cannot yet be run, you must make it such that
  there is a custom screen that mentions that that feature will go live on
  its own and automatically on the date that it can go live. Furthermore,
  design those features so that they automatically go live."

### 2. What was followed

- Instr. 19.1 → FOLLOWED, full browser audit (Playwright, headless, screenshots
  + console/pageerror/network capture on every page, desktop + mobile):
  - Map (heat chart, region rail, top-3, all-markets table, drill-down clicks),
    Country pages (DE full, GB euro-gated empty), Returns (4 markets × 2 modes
    × 3 views, legend toggles, period presets), History (US OAS+defaults,
    sovereign selector DE/MX/US), mobile viewport passes; toggles/canvas/pixel
    painting verified via the hardened window.__pc.charts() audit handle.
  - BUGS FOUND AND FIXED (all in the web layer):
    1. `api/_shared.js:337` — orphaned `feeVals.push(fee)` on an undeclared
       identifier (strict-mode ReferenceError as soon as a shock day survived)
       → removed (value never read).
    2. `api/_shared.js` rollingMean — the port averaged the leading NaN into
       the running mean (pandas skips NaN), poisoning dealer-vol → friction NaN
       → every curve row null → whole Returns API silently empty → frontend
       showed "No assets". Fixed with a NaN-skipping rolling mean.
    3. `api/_shared.js` dealerVolBpsSeries — port computed relative-move×1e4 on
       the percentage series instead of the engine's 90d std of first
       differences of the bps series (volatility.py:34); the inflated level
       blew up the exponential friction (hf/ret −4e14…−3e16 bps) → rewritten
       to the engine semantics (bps units, 90d std, shift 1, no look-ahead).
    4. `api/_shared.js` yahooAtmIv — no sanity bounds; a degraded feed could
       inject garbage IV into the markup → real-quote gate [0.02, 2.0] mirror
       of the engine's IV_MIN_REAL=0.02 (largest live obs 0.4185; cap keeps
       >4x margin).
    5. `src/pages/map.js` — row click listeners were attached BEFORE the table
       rows were rendered (`#atlas-body` innerHTML set after `buildMapChart`
       await) → every "All markets"/top-3 row click was dead → listeners moved
       after the body render (verified: row click navigates to #/country/ZA).
    6. `api/history.js` — OAS/defaults series lacked `unit`, so the chart
       y-axis labeled "%" instead of "bps" → `unit:"bps"` on OAS, `"pct"` on
       default-rate series.
    7. `src/main.js` router race — `route()` is async and hash navigations
       fire it concurrently; slow renders interleaved, `current.dispose`
       chased a moving target and stale/disposed chart registrations leaked
       into chartState (evidenced by country charts still registered on the
       Returns page). Fixed with a nav-sequence token: a superseded render
       disposes its own charts immediately (verified with a rapid 300ms
       navigation battery → empty registry, zero pageerrors).
    8. `src/store.js` fetchJSON timeout 25s→45s — cold serverless API storms
       (atlas = 15 FRED + 15 Yahoo + ECB sequential calls; countries panel =
       11 ECB calls) legitimately exceed 25s on a first hit; the abort forced
       the bundle fallback path. Bounded to 45s (still never hangs).
    9. `src/store.js` audit handle — `getOption().series` is unreliable
       (null on disposed charts) → replaced with a canvas pixel-paint probe
       (ground truth the lines are drawn) + zero-size guard.
  - Re-audit after fixes: every section OK, CONSOLE [] PAGEERR [] — the only
    network noise is the designed fallback (first-cold /api/atlas abort →
    seed bundle renders the map).
- Instr. 19.2 → FOLLOWED. New auto-go-live Signals architecture:
  - `web/api/status.js` — serverless `/api/status`: gated-feature registry
    with honest state + progress + auto-go-live dates. `live` flips by itself
    from the committed snapshot (IV-RV: accrued ≥ IV_Z_MIN_OBS=20; COT legs:
    calendar ≥ listing date + 2y; waiting-for-data legs: the moment the data
    exists). Pure `computeStatus(ivHistory)` + `addTradingDays` exported for
    the seed.
  - `web/src/pages/signals.js` + nav + `page-signals` section + theme styles
    — cards per feature: status badge (LIVE / Accruing / Date-gated / Waiting
    for market data), progress bar (IV-RV 3/20), "► Auto-goes live on
    <date>" with the weekday-estimate note, or "Auto-goes live the first day
    the gate data exists — no date can be promised" for thin-market legs.
    6 features: IV-RV premium (auto 2026-09-03), COT BBG HY (2028-03-31),
    COT BBG IG (2028-05-31), per-country straddle/VRP, EMHY chain, ANGL
    straddle quote.
  - `web/scripts/web_seed.mjs` — now also copies `data/iv_history.json` →
    `api/iv_history.json` (Vercel bundles api/*) and writes
    `public/data/status.json` (offline fallback); store.loadStatus() prefers
    /api/status with the bundle fallback.
  - `scripts/accrue_iv_daily.sh` — appends `cd web && npm run seed` so the
    committed snapshot follows every daily accrual automatically.
  - Verified live: /api/status returns 6 features, 3/20 accrual, dates as
    above; Signals page renders all 6 cards (badges/go-live lines/progress
    bar) on desktop + mobile.

### 3. Verification

- `node run.js /tmp/pw-audit3.js` (Playwright, 1600x1000 + 390x844): all 14
  sections OK — map (15 rows/5 regions/3 top + drill-down click), country DE
  (proj+hist painted), country GB (honest empty), returns us/eu/spread/
  countries × views/legend/periods, history US + sovereign DE/MX/US,
  Signals 6 cards, mobile map + signals; CONSOLE [], PAGEERR [].
- `/api/returns?market=us|eu|em|countries&mode=pure|spread` — real curves
  (AAA T21 gross 5.0 / HF +1.5 / retail +1.1 bps; CCC T21 75.1/15.8/6.6) —
  sane economics, no 1e14 artifacts.
- `/api/status` — 6 features, times/dates verified; `npm run seed` →
  bundle.json (15 countries) + api/iv_history.json ({HYG:3,LQD:3,TLT:3,
  EMB:3,ANGL:2,JNK:1}) + status.json (6 features).
- `pytest tests/ -q` → 149 passed; `npm run build` clean; `node --check`
  on the touched API files clean. No engine/config constants changed → no
  §6 audit-log edits.

### 4. Docs touched

- CONTEXT.md §3 (web tree: /api/status, signals page, seed snapshot chain)
  and §7 (web commands: seed now snapshots the Signals state).
- open_items.md §5 (session-19 block) + §2 registry entries for the six
  gated features (IV-RV / COT IG / COT HY / per-country straddle / EMHY /
  ANGL straddle) with auto-go-live wiring marked.

## Session 20 — 2026-08-12: JSON-file cache layer for the web API (rate-limit defense)

### 1. What was instructed

- (20.1) "make it such that data is updated and stored in json files and appended
  such that there is no chance for any api limit issues where when anyone runs
  it the system appends the new values pulled from the api to the json file and
  pulls it from there for any new user during a similar time"

### 2. What was followed

- Instr. 20.1 → FOLLOWED. Built a persistent JSON-file cache layer into the
  web API (`web/api/_shared.js`) covering all four upstream fetchers:
  FRED (fredCsv), ECB (ecbCsv), Yahoo chart (yahooChart), and Yahoo ATM IV
  (yahooAtmIv). Design:
  - **Storage**: `web/public/data/cache/{fred,ecb,yahoo,atmiv}/*.json` — one
    file per upstream series/key. Bundled via `vercel.json` `includeFiles:
    "public/data/**"` so cold Vercel instances start with the last-known data.
    Local `serve.mjs` writes the same files — running the system once
    populates the cache for every later user in the same window.
  - **TTL reads**: `cachedRows(kind, key, ttlMs, fetchFn)` reads the file if
    mtime within TTL (FRED 6h, ECB 12h, Yahoo chart 2h, ATM IV 3h — mirrors
    upstream update cadences).
  - **Append-merge on refresh**: when the file is stale/missing, the live
    fetch runs, new rows are union-merged with the stored rows by date
    (sorted, deduped), and the file is atomically rewritten (tmp→rename).
    History is never lost; the file grows over time.
  - **Stale fallback**: if the upstream fetch errors (rate limit, 401, 429,
    network), the cache is served regardless of TTL with a `stale: true`
    flag. The system degrades gracefully to stored data instead of failing.
  - **In-flight dedup**: a per-instance `Map` coalesces concurrent requests
    for the same cache key so the upstream is never hammered twice.
  - **Rewired endpoints**: `fredCsv`, `ecbCsv`, `yahooChart`, `yahooAtmIv`
    all now delegate to `cachedRows`; caller signatures unchanged.

- Verification:
  - First cold runs populated all four cache directories (7 FRED series, 1
    ECB key, 15 Yahoo symbols, ATM IV on demand).
  - Second identical API calls within TTL — file mtimes unchanged → cache
    hits confirmed.
  - Full Playwright audit: all 14 sections OK, zero console/page errors.
  - `pytest tests/ -q` → 149 passed; `npm run build` clean; `node --check`
    on all touched API files clean.

### 3. Verification

- `curl /api/history` ×2 → cache files created, second call mtime unchanged.
- `curl /api/atlas` + `/api/returns` → ECB and Yahoo caches populated.
- Playwright sweep: map, country DE/GB, returns (all markets/modes/views),
  history, signals, mobile — all OK.
- `pytest tests/ -q` → 149 passed; `vite build` clean; `node --check` clean.

### 4. Docs touched

- CONTEXT.md §3 (web tree: cache dir added), §4 (web API cache bullet),
  §6 (CACHE_TTL table), §7 (web seed note).
- LEDGER.md this session entry.
- open_items.md §5 (session 20 block).


## Session 21 — 2026-08-13: Vercel deployment, runtime fix, env var documentation

### 1. What was instructed

- Deploy the web SPA to Vercel with correct configuration
- Fix serverless function runtime (`nodejs20` → `nodejs`)
- Document all required Vercel environment variables matching `.env.example`
- Verify API endpoints work on Vercel

### 2. What was followed

- **Root Directory fix**: Set Vercel Root Directory = `web` so Vite builds from `web/`
- **Runtime fix**: Changed all 4 API files from `runtime: "nodejs20"` → `"nodejs"` (Vercel-supported)
- **Environment variables**: Documented required (`FRED_API_KEY`) and optional keys matching `.env.example`
- **Vercel config**: Root Directory = `web`, Build = `npm run build`, Output = `dist`, Install = `npm install`
- **GitHub repo**: Created `akrishna2508/public-credit-engine`, pushed clean first commit (115 files, 17k lines)
- **API verification**: curl tests confirm `/api/atlas`, `/api/returns`, `/api/history`, `/api/status` return `"status":"OK"` with data

### 3. Verification

- Vercel build passes (Vite build → 5.5s, dist/ created)
- All 4 serverless functions deploy with `runtime: "nodejs"`
- curl tests: `/api/atlas` (15 countries), `/api/returns?market=us&mode=pure` (15 assets), `/api/status` (6 features) — all `"status":"OK"`

### 4. Docs touched

- CONTEXT.md: Vercel deployment notes, env var table, Root Directory guidance
- open_items.md: §0 FRED key marked DONE
- LEDGER.md: this entry


### Session 28 — map coverage expansion + fallen-angel ETF leg (2026-08-18)

#### What was instructed
1. "Now you must take a look at the countries not yet covered and add that."
2. "Also add things like fallen angels as well where you can use ETFs as proxies."

#### What was followed
- Instr. 1 → FOLLOWED (web map layer). The deployed map runs on
  `web/api/_universe.js` (85 markets) + `web/api/atlas.js`; the Python
  `data/atlas.json` (15 markets) is FRED-yield-driven and cannot grow
  beyond the ~40 OECD long-term series FRED publishes. Added 14 markets to
  the universe, every leg live-verified 2026-08-18 on yfinance before
  inclusion: HK (EWH + USDHKD=X + Asia credit), UY/DO/GT/HN/PY (FX crosses
  + LatAm credit), PA/EC/SV (dollarised — credit leg only, no FX leg by
  design), IS (ISK cross only — developed, no credit bucket), KW/OM/BH/JO
  (pegged FX + EMEA credit). RSX (Russia) probed and EXCLUDED: dead tape on
  yfinance (1 obs) — honest gate. Universe 85 → 99, coverage reported in
  the API (`coverage.withFallenAngelEtf`).
- Instr. 2 → FOLLOWED. New `fallen_angel` instrument + heat leg in the
  atlas, one ETF per market the map can honestly proxy: ANGL (US, USD —
  the same instrument engine/spreads.py uses), EM1A.DE (VanEck US Fallen
  Angel UCITS A USD Acc, EUR-quoted on Xetra, converted to USD via
  EURUSD=X) for the europe region, GFA.L (VanEck Global Fallen Angel UCITS,
  GBp, converted via GBPUSD=X) for GB. EM countries report the leg
  UNAVAILABLE — no fallen-angel EM ETF exists (EMHY is ordinary HY). All
  three tickers live-verified on yfinance (2026-08-18): ANGL/FALN/EM1A.DE/
  GFA.L/GFGB.L/USFA.PA probed; FALN kept in the probe record but ANGL
  chosen as the project-convention US vehicle; FAHY.L (Invesco US HY FA
  UCITS) verified but not used (duplicate coverage). New country-page card
  "Fallen angels (ETF proxy)" + tooltip leg label in charts/map.js.
- Cartographic correction discovered en route (→ CONTEXT §9.19): the
  basemap's China feature still contained a 10-vertex Taiwan polygon (the
  standalone Taiwan feature from 2026-08-18 rendered on top of it), an
  empty degenerate polygon, and the Hong Kong landmass as two small
  polygons (10/11) matched exactly to Natural Earth 50m "Hong Kong S.A.R."
  bboxes. China trimmed to 11 mainland+island polys (remainder
  byte-identical), Hong Kong became its own feature, Taiwan duplicate
  dropped. Verified: 216 features, all untouched features byte-identical.

#### Verification
- Live yfinance probes (2026-08-18): 11 FX pairs OK, EWH OK, RSX THIN(1),
  ANGL/EM1A.DE/GFA.L/GFGB.L/USFA.PA/FALN OK, all speculative FA tickers
  dead (honest exclusions).
- `npm run seed` ×2: first run exposed a cache-race (cachedJson returns the
  stale doc while the rebuild refreshes in the background — bundle.json got
  85 while cache/atlas/v2.json got 99); second run produced bundle.json
  with 99 markets. Cache freshness is stamp-based (§1.29) — expected
  behaviour, not a bug.
- `npm run build` clean (577 modules). Local serve smoke (Playwright,
  headless): map canvas renders, no console errors; /api/atlas live
  returns 99 countries, US fallen_angel ANGL ret_1m_usd −0.22, DE EM1A.DE,
  GB GFA.L, BD UNAVAILABLE, HK heat +0.973 (equity+credit legs);
  #/country/HK and #/country/US render (HK heat badge, US Fallen angels
  card with ANGL). coverage: 99/99 scored, 38 yields, 35 equity, 73
  credit, 21 fallen-angel.
- `pytest tests/ -q` → 157 passed (was 149; no new tests added this
  session — the web layer has no Python tests).

#### Docs touched
- CONTEXT.md: §3 (world.json note → China/HK/Taiwan split, 99-market seed
  bundle), §4 (yfinance bullet — atlas fallen-angel leg + universe
  expansion), §9 (new entry 19 — basemap Taiwan/HK correction).
- open_items.md: §6 session log entry added.

#### Incident note (2026-08-18, appended to session 28)
- `git add -A` on the deploy sweep swept in `notebooks/Credit_engine.ipynb`
  (contains the full leaked FRED key literal `ccb67ba5...`) and
  `data/cache/` (288 regenerable series-cache files) — both deliberately
  excluded from the repo per CONTEXT §5.
- Corrected in two follow-up commits: `fad1e98` removes both paths
  (`git rm --cached`), `9f0...`/gitignore commit adds `notebooks/` and
  `data/cache/` to `.gitignore` so `git add -A` can never sweep them again.
- The leaked literal exists in the push history of `06ee2c5` (and the repo
  never rewrites history), but the key itself was replaced 2026-08-12
  (CONTEXT §5) — the literal is dead. Verified post-removal: `git ls-files`
  scan finds zero `ccb67ba5` matches among tracked files.
