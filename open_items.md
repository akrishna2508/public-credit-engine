# open_items.md — Open Items Registry (2026-08-15 sweep, session 27)

> Keep this file current: **every run, live verification, or code change
> updates this registry in the same pass** (rule in CONTEXT.md §11.6). Items
> are either BUGS (must be fixed), TO BUILD (yet to be built), TO COMPLETE
> (tasks not finished), or QUEUED (need something else first). This file is
> documentation-only — it does not drive code.

## 0. Currently open (awaiting user input)

- **Global git identity still has smart quotes** (open, 2026-08-15). The
  machine-level `user.email` is stored as `“krishnalalagarwal2508@gmail.com”`
  — curly quotes, bytes `e2 80 9c` / `e2 80 9d`, part of the value rather
  than shell syntax. GitHub could not verify the author, `author.login` came
  back NULL on every commit and Vercel refused to build. This repo works only
  because of a repo-local override
  (`git config user.email "112699859+akrishna2508@users.noreply.github.com"`);
  any OTHER repo on this machine will hit the same wall. Fix:
  `git config --global user.email "..."` with straight quotes.
- FRED key in `.env` and Vercel env vars: **done** (2026-08-13).
- Everything else below is resolved, data-existence-gated (auto-resolves), or
  documented as kept-by-design.

## 1. Bugs — status board

| Bug | Status | Resolution / evidence |
|---|---|---|
| 1.1 Fallen_Angel straddle fee overshoot (~2.3x) | **RESOLVED 2026-08-11** | Fee = empirical expected \|T-day move\| (`get_empirical_move_fee`, rolling realized \|ΔT\|, look-ahead-shifted) replacing the raw-vol Bachelier term. FA daily diffs AR(1) ≈ −0.32 (whipsaw): fee 36.5→14.2, net −18.3→+1.4. `calc_ou_straddle` kept as analytic reference (unwired) |
| 1.2 Friction pinning retail at −1 bp | **RESOLVED 2026-08-11** | `FRICTION_BASE_SPREAD_BPS` 1.0 → 0.5 (single execution half-spread); retail nets now ≈ −0.4..+1.2 |
| 1.3 Pair-leg retail sum → netting | **RESOLVED 2026-08-11** | Retail fee = ONE netted straddle on the traded pair series (the long-short unit), not the sum of both legs; `raw_df`/`is_pair_mode` params removed from `analyze_strategy` |
| 1.4 Percent-vs-bps file convention | **KEPT (documented)** | `USA_bond_returns_by_grade.json` stores FRED percent; the single loader (`prepare_pristine_data`) ×100 → bps. Convention noted in §5; no migration (risky, zero benefit) |
| 1.5 APPETITE 0-obs | **RESOLVED 2026-08-11** | Root cause: DRCCLACBS quarterly dates + `asfreq("ME")` → all-NaN → concat `.dropna()` wiped the composite. Fixed with `resample("MS")` + ffill(limit=21) (no frozen stale tail) + `DR_STALE_MAX_AGE_DAYS` staleness gate in the board component. Live: 654 daily obs |
| 1.6 FA width premium on BB/BBB | **RESOLVED 2026-08-11** | `any(g in name for g in DISTRESSED_GRADES)` matched "B" ⊂ "BB"/"BBB"/pairs → they paid the 1.05 Fallen_Angel premium. Fixed: exact membership `name in config.DISTRESSED_GRADES` in `_trade_cost_basis` (engine/volatility.py). Live: BB retail@5 +0.49→+1.15, BBB −0.40→−0.21, HF BB +1.91→+2.50. Regression: `test_fallen_angel_premium_exact_grade_only` |
| 1.7 psycopg3 execute(list) | **RESOLVED 2026-08-11** | `heatmap_db.py` upserts failed live ("query has 2 placeholders but 15 parameters") → `executemany` for both country + metrics upserts; `--market atlas --db` verified writing 15+15 rows |
| 1.8 atlas NaN 500 on drill-down | **RESOLVED 2026-08-11** | Legacy `mom_21d` NaN in data/atlas.json crashed the strict JSON serializer → `futures_layer.py` sets `mom_21d` only when finite + defensive `_clean_for_json` in `api/server.py`; /api/v1/countries/{iso} now 200 |
| 1.9 em_carry permanently UNAVAILABLE | **RESOLVED 2026-08-11** | `_etf_fund_data` lambda captured the `yf.Ticker` object ("'Ticker' object has no attribute 'replace'") → lambda rebinds the symbol string; EM-CARRY board leg now live, VALIDATED (fitted +1, OOS Sharpe 0.060) |
| 1.10 GCO sovereign leg dead | **RESOLVED 2026-08-11** | `GLOBAL_SOVEREIGN_COUNTRIES` held suffix fragments ("USM") → `fetch_global_sovereign` built `IRLTLT01USMM156N` and every key 400'd. Now full series IDs in the dict; the leg votes (KR LONG_DURATION live) |
| 1.11 API keys leaked in error logs | **RESOLVED 2026-08-11** | FRED key appeared in `data_engine.fetch_fred_series` error lines (URL carries `api_key=`); polygon/NDL keys leaked in their SourceUnavailable messages. All three scrub via `.replace(key, "***")`; regressions `test_ndl_error_redacts_api_key` / `test_polygon_error_redacts_api_key` |
| 1.12 FINRA breadth column mismatch | **RESOLVED 2026-08-11** | Live FINRA date column is `tradeReportDate`; the appetite matcher missed it → breadth_z always None, composite 1/2. Matcher now includes `tradereportdate`; appetite 2/2 and correctly REJECTED by the validation gate (fitted −1, OOS Sharpe −0.198) |
| 1.13 Cost-basis index anchor | **RESOLVED 2026-08-11** | `_trade_cost_basis` components were indexed on the retail-markup index (DE long history); an ECB LTIR country with a later start misaligned the boolean indexers ("Unalignable boolean Series"). All components reindexed to the series' own index (engine/volatility.py) — daily path unchanged, monthly country path works |
| 1.14 FRED fredgraph.csv decommissioned | **RESOLVED 2026-08-12 (both layers)** | On `api.stlouisfed.org`, EVERY `fredgraph.csv` request (both `id=` and `series_id=` forms) now 404s with 0 redirects (verified for DGS10, BAMLC0A1CAAA, IRLTLT01DEM156N); the keyed `fred/series/observations` JSON API works. `web/api/_shared.js` `fredCsv` rewritten onto the JSON API (asc sort, `.`-skip, retries). **Python engine re-verified 2026-08-12 (session 18)**: `config.FRED_BASE_URL` already points at the JSON endpoint and `engine/data_engine.py` `fetch_fred_series` builds the JSON URL — zero `fredgraph` references anywhere in the Python tree. Live proof: 6-series fetch (DGS10 16,855 obs → 4.720% 2026-08-10; Bund 842 obs → 2.97% 2026-06; DRCCLACBS 141 obs quarterly as designed) + two real board runs (`--market global --source curve` → CURVE leg live z=−0.6 VALIDATED; `--source sovereign` → RISING_DEBT Uzbekistan). §9.18's "open item" is closed |
| 1.15 ECB csvdata positional parse (web API layer) | **RESOLVED 2026-08-12** | `web/api/_shared.js` `ecbCsv` read `cols[1]/cols[3]` (FREQ/IR_TYPE) as date/value → every row silently skipped → countries market empty. Now header-driven (TIME_PERIOD/OBS_VALUE column indexes). Live: 11/11 ECB LTIR countries stream |
| 1.17 Blank dashboard: data files never committed | **RESOLVED 2026-08-13** | `web/public/data/**` was untracked, and the SPA rewrite returned `index.html` at HTTP 200 for every missing `/data/*.json`, so the fetch parsed HTML as JSON and every page silently emptied. 151 data files committed; rewrite now excludes `/data/`, `/assets/`, `favicon`; content-type guards in `store.js` and `charts/map.js`; `serve.mjs` 404s honestly |
| 1.18 Vercel "deployment blocked" | **RESOLVED 2026-08-13** | Two wrong diagnoses first (account/billing, then `maxDuration: 60`). Real cause: GitHub could not verify the commit author because the git identity carried smart quotes — see §0 |
| 1.19 Charts built series and never attached them | **RESOLVED 2026-08-14** | `buildProjectionChart` and `buildHistoryChart` assembled their series arrays and omitted `series` from the option passed to `setOption`; every chart but Forecast drew empty axes |
| 1.20 Legend toggles inert | **RESOLVED 2026-08-14** | `hidden: !show` is not an ECharts series property and was silently ignored; hidden series are now omitted from the option |
| 1.21 Period pickers dead (three causes) | **RESOLVED 2026-08-14** | (a) a time axis windowed with numeric `startValue: 1, endValue: 180` asked for a 179-millisecond window in January 1970; (b) the window was set on the slider only, so the linked `inside` component's full range won; (c) projection presets windowed the FAR end of a forward horizon, collapsing "1M" onto one point |
| 1.22 Units: duration never applied | **RESOLVED 2026-08-14** | A spread level, a yield level and price-times-100 were all read as basis points of return. Each market was wrong by a different factor. Series now enter quoted (prices as 10000*ln P) with `pnlScale` applied after the cost model |
| 1.23 Execution friction exploded on price series | **RESOLVED 2026-08-14** | `base*exp(0.08*(v-p90))` states its growth rate in absolute bps, so it only holds at the scale it was fitted on. A log-price index peaks 140 bps above its own 90th percentile, reaching e^11 — ANGL at 44,000 bps of execution cost, EM high yield at 477,000. Excess is now measured in units of the series' own dispersion; on BBB the implied absolute rate is 0.080, the config value |
| 1.24 Day-calibrated windows on monthly series | **RESOLVED 2026-08-14** | `RV_LOOKBACK=21` / `DEALER_WINDOW=90` are observation counts; the euro country book is monthly, so it priced a 7.5-year fee window against one-year shocks and every euro sovereign read as a guaranteed loss. Monthly panels now use 12/48 and annualise by sqrt(12). **The same bug exists in `engine/eur_country.py`** — see §6.1 |
| 1.25 Missing ffill/bfill on vol series | **RESOLVED 2026-08-14** | The engine ends every vol series with `.ffill().bfill()`; the port left leading NaNs, and `returnCurve` skips any shock period with a NaN fee or friction. Portugal and Ireland have their whole volatility history inside the first 48 monthly observations, so both returned all-nulls that read as missing data |
| 1.26 `alignPanel` applied to monthly panels | **RESOLVED 2026-08-15** | It ports pandas `resample("B")` — business-day grid plus forward fill. Feeding it 258 monthly observations produced 5,586 daily rows of a step function whose lag-1 autocorrelation is ~1 by construction; the VAR reported rho 0.9993 at lag 1 and a "ten year" horizon that was really 120 business days. Monthly panels now bin at their own frequency |
| 1.27 Lag selection uncapped vs panel width | **RESOLVED 2026-08-15** | An 11-variable monthly panel with 246 observations selected lag 12 — 133 parameters per equation — and the overfit returned a spurious spectral radius of 1.0123. Parameters now held to a fifth of the sample |
| 1.28 Currency leg double-counted | **RESOLVED 2026-08-15** | The new FX heat leg checked `legs.some(l => l.leg === "equity")` BEFORE the equity leg was pushed, so it always saw an empty list; Brazil, Peru, Argentina and Turkey got an FX leg on top of a USD-denominated ETF already carrying the currency. Check moved after |
| 1.29 Derived cache never hit in production | **RESOLVED 2026-08-15** | Two faults: `/tmp` is per-instance on Vercel and the computed documents had no bundled seed (five consecutive requests all missed); and freshness was judged by file mtime, which for a bundled file is whatever the build assigned, so every seeded document arrived already stale. `npm run seed` now warms all eight books, and `cachedJson` judges age from the document's own `updated` stamp |
| 1.30 Volatility book could not change direction | **RESOLVED 2026-08-15** | `gross - move*markup - friction` reduces to `move*(kappa - markup) - friction`; `move` rises with the horizon and the rest are constants, so the net was monotone in sigma_m by construction — all twelve live series monotone, zero sign changes. It was also not a position: pricing a NEW straddle at each maturity is a term structure of separate trades, with no strike, no theta and no financing |
| 1.16 `angRows` undefined (web API layer) | **RESOLVED 2026-08-12** | `api/returns.js:137` referenced `angRows` (declared `anglRows`) → US mode 500'd. Renamed; US pure now 8 assets |

## 2. Things yet to be built

- **2.1** ~~Fee-model calibration~~ **DONE 2026-08-11** — empirical |T-day move| fee (see 1.1).
- **2.2** ~~Retail pair-leg netting~~ **DONE 2026-08-11** (see 1.3).
- **2.3** ~~Atlas options section "straddle_yield_ann"~~ **DONE 2026-08-12** —
  real ATM-straddle snapshots landed (§4.1, 08-11) and the regenerated
  atlas (data/atlas.json, generated 2026-08-12 01:04) carries live values:
  HYG 0.0319, LQD 0.0593, TLT 0.1073, EMB 0.0866, JNK 0.0738; ANGL has no
  straddle quote (thin chain) — honest empty.
- **2.4** ~~IV-RV backtest battery leg~~ **BUILT 2026-08-11** — `_bt_ivrv`
  (pipelines/backtest.py) + `options_surface.premium_z_series` walk-forward
  z; reports "2/20 accrued" honestly; auto-unlocks at 20.
- **2.5** COT BBG IG/HY credit-futures legs: real history gate ≈ 2028 — no code
  can accelerate; report stays honest UNAVAILABLE. **Site-facing (2026-08-12,
  session 19)**: surfaced on the new Signals page with auto-go-live dates
  (HY 2028-03-31, IG 2028-05-31 — contract listing + COT_MIN_HISTORY_YEARS);
  the cards flip to live on their own when the calendar date arrives
  (`web/api/status.js`).
- **2.10** ~~Web gated-feature registry~~ **DONE 2026-08-12 (session 19)** — *(was mis-numbered 2.7, colliding with the three-view curve item below; renumbered 2026-08-15)*
  `/api/status` + Signals page (`#/signals`): six auto-go-live cards —
  IV-RV premium (3/20, auto 2026-09-03 weekday estimate), COT BBG HY
  (2028-03-31), COT BBG IG (2028-05-31), per-country straddle/VRP,
  EMHY chain, ANGL straddle quote (the latter three flip to live the first
  day the gate data exists; no date can be promised — thin markets).
  Snapshot chain: `scripts/accrue_iv_daily.sh` → `npm run seed` →
  `api/iv_history.json` + `public/data/status.json` — a feature goes live
  with zero code change when its gate flips.
- **2.6** ~~Hold-horizon return curves~~ **BUILT 2026-08-11** — `return_curve()`
  + `first_positive_hold()` (engine/volatility.py, hold days 1..21,
  HF/retail net), `plot_return_curves()` (engine/volatility_matrix.py,
  solid=dashed legend + zero line, PNG), wired into
  `pipelines/volatility_strategy.py` for US/EU/EM pure + spread pairs at
  `GARCH_SIGNAL_PERCENTILE`; per-item table: net@CLI-hold + first positive T.
  Net is no longer a single fixed-period metric.
- **2.7** ~~Three-view curve graphs~~ **BUILT 2026-08-11** — `return_curve`
  gains `Gross_bps` (Tier 1); `plot_return_curve_view()` renders ONE view
  per PNG; every run emits `{region}_{tag}_{gross,hf_net,retail_net}
  _return_curves.png` (24 files for us/eu/em pure+spread+country); summary
  table gains `gross@T`.
- **2.8** ~~EUR country-level panel~~ **BUILT 2026-08-11** — ECB LTIR 10Y
  per country (11 keys, all live), Bund-spread table (1M/3M/12M changes),
  country level + spread straddle curves on the shared machinery with
  monthly hold units (`europe_country_{level,spread}_{view}_return_curves.png`,
  engine/eur_country.py, config.ECB_LTIR_COUNTRY_KEYS).
- **2.9** ~~Public web frontend (opportunity site)~~ **BUILT 2026-08-12**
  (session 17) — `web/`: Vite + ECharts SPA (map / returns / history /
  country drill-downs) + Vercel-compatible serverless API layer
  (`web/api/{atlas,returns,history}.js` on `web/api/_shared.js`: FRED JSON
  API, ECB SDW, Yahoo v8/v7, retry+backoff, honest UNAVAILABLE), committed
  seed bundle fallback (`web/public/data/bundle.json` from
  `scripts/web_seed.mjs`), vendored world.json (echarts@5 ships no maps;
  pinned echarts@4.9.0 jsdelivr copy, "South Korea"→"Korea" alias),
  custom full-name legends + period/zoom controls, `window.__pc` audit
  handle, `scripts/serve.mjs` local dist+API server with dependency-free
  `.env` loader (Vercel injects env vars in production). Live-findings
  fixes in the API layer: §1.14 (FRED CSV→JSON), §1.15 (ECB header-driven
  parse), §1.16 (`angRows`). Verify: `npm run build`; headless-Chrome
  smoke on all routes (canvases render, 0 console errors, honest empties).

## 3. Tasks yet to be completed

- **3.1** ~~Re-check EMB ATM IV ≈ 0.42~~ **RESOLVED 2026-08-11**: live
  measurement 0.1604 (expiry moved 08-14 → 08-21, IV fell); ratio vs HYG
  4x, not 8x. Single-chain real value; gate stays.
- **3.2** ~~Backtest sign re-examination / board vote semantics~~ **RESOLVED
  2026-08-11**: COT leg fits −1 (OOS Sharpe −0.574) and APPETITE −1 (−0.198)
  → both REJECTED → board abstains (no vote without demonstrated edge, Q1).
  CURVE VALIDATED (+1, 0.215), REAL-RATES VALIDATED (+1, 0.737), EM-CARRY
  VALIDATED (+1, 0.060). Battery persistence in `data/backtest_legs.json`.
- **3.3** ~~EUR/EM spectrum legs~~ **RESOLVED 2026-08-11**: EUR/EM now run
  the full shared machinery — adjacent-tier spread pairs added
  (EUR_HY−EUR_IG; EM_Corporate−EM_USD_Sovereign, EM_High_Yield−EM_Corporate,
  EM_Local_Currency−EM_High_Yield) + three-view curves for pure and pairs
  on both markets + the EUR country panel (§2.8). EMHY's missing options
  expiries stay honestly UNAVAILABLE (data-existence).

## 4. Queued (blocked on something else first)

- **4.1** ~~Straddle-yield accrual~~ **DONE 2026-08-11** — first REAL ATM
  straddle snapshots accrued (HYG 0.22/DTE3, LQD 0.57, TLT 0.75, EMB
  1.36/DTE10, JNK 1.17/DTE10); atlas options now show `straddle_yield_ann`
  live (HYG 0.0305 … JNK 0.0738). ANGL has no straddle quote (thin chain,
  P/C OI 0.0) — honest None.
- **4.2** IV-RV signal: **still gated, re-verified live 2026-08-15** — `/api/status`
  reports `accruing`, auto-go-live **2026-09-03**. Nothing in code can
  accelerate it; the daemon adds one weekday snapshot at a time and
  `IV_MIN_REAL = 0.02` rejects degraded feeds. Historical detail below.
  (2026-08-12 session-18 re-verified:
  HYG/LQD/TLT/EMB 3, ANGL 2, JNK 1 — last snapshots 2026-08-11); needs 20
  days → auto-unlocks the board leg AND the `_bt_ivrv` battery leg.
  Launchd accrual healthy (com.publiccredit.iv-accrual loaded, exit 0;
  22/23 sources — polygon redacted 400/429 as documented, non-load-bearing).
  **Gate held live 2026-08-12**: the midday feed served stub implied vols
  (1e-05…0.008) and `IV_MIN_REAL = 0.02` rejected every snapshot —
  `data/iv_history.json` untouched (mtime 08-11 22:58) — proof the guard
  protects real history against degraded feeds. ~17 more weekday snapshots
  ≈ early September. **Build-completeness proven 2026-08-11 (session 16b)**:
  `test_ivrv_battery_leg_unlocks_and_runs_end_to_end` fast-forwards the
  accrual and shows the battery leg flips UNAVAILABLE → full metrics +
  OOS sign-fit + persisted validation; `test_premium_z_unlocks_exactly_at_min_obs`
  pins the 19/20 boundary. Live-shaped demo on the REAL history copy +22
  days: n 3→25, z −0.694, walk-forward z active, board votes as designed.
- **4.3** ~~Portal activation~~ **DONE 2026-08-11 (local Docker, Q2)**:
  `docker-compose.yml` (postgis/postgis:16-3.4 → 5432, redis:7-alpine →
  6379, healthchecks, named volumes); `DATABASE_URL`/`REDIS_URL` in .env +
  `.env.example`; `psycopg[binary]` installed; `psql "$DATABASE_URL"
  -f sql/heatmap_schema.sql` applied once; `--market atlas --db` writes
  15+15 rows; Redis mtime-keyed parse-cache verified (atlas:doc +
  atlas:doc:mtime keys); API smoke 200 on /api/v1/regions, /countries/{US,DE},
  /heatmap. Docker daemon needs `open -a Docker` after reboot.
- **4.4** ~~Backtest re-run after fee fairness~~ **DONE 2026-08-11** — battery
  exits 0; APPETITE 654 obs (fitted −1), EM-CARRY 1010 obs (fitted +1
  confirmed), IVRV gated.

## 5. Known limitations and engine parity

5.1 was a real bug and is now fixed. 5.2-5.6 are constraints found by probing
live sources — none is a bug; each bounds what the site can honestly claim,
and each is surfaced in the payload or on the page rather than hidden.

- **5.1** ~~The monthly-window bug also exists in the Python engine~~
  **RESOLVED 2026-08-15 (session 27)**. `engine/eur_country.py` fed monthly
  ECB LTIR series into `engine.volatility.return_curve`, which used
  `DEALER_PRICING_WINDOW = 90` and `REALIZED_VOL_LOOKBACK = 21` as observation
  counts — a 7.5-year fee window against 21-month shocks. Fixed the same way
  as the web layer: `config.FREQ_PROFILES` / `config.freq_profile()` (days
  21/90/252, months 12/48/12), threaded as a `freq` parameter through
  `get_dealer_volatility`, `fit_garch_volatility`, `get_empirical_move_fee`,
  `calculate_dynamic_pb_markup`, `_trade_cost_basis` and `return_curve`;
  `eur_country.py` passes `freq="months"`. `calculate_dynamic_pb_markup` also
  annualises at the series' own frequency now — `PB_VOL_THRESHOLD_BPS` is
  absolute annual bps, and sqrt(252) on monthly data inflated the vol ~4.6x.
  Default is `freq="days"`, so the daily path is bit-identical. Regressions in
  `tests/test_freq_profiles.py` (8 tests) pin both halves; full battery
  **157 passed**, pyflakes clean.

- **5.2 FRED serves only three years of the ICE BofA credit indices.**
  Verified against the API: `count: 795` for BAMLH0A3HYC with
  `observation_start=2005-01-01`. This is an ICE licensing limit, not a fetch
  fault. It caps every credit forecast horizon at 12-18 months and is why the
  US credit VAR is not stationary (rho 1.0014) while sovereign yields, with
  258 monthly observations back to 2005, are (rho 0.95-0.99).
- **5.3 No free source publishes a 10-year curve for most of Africa, South
  East Asia or Eastern Europe.** FRED's complete OECD long-term-rate family
  is 40 series and was enumerated; the only additions with a real curve were
  Latvia, Lithuania and Costa Rica. The IMF's `MFS_IR` bond-yield indicators
  (`S13BONDSML`, `S13BONDS`, `GSTBILY_L`) return zero observations for every
  African, South East Asian and Eastern European candidate tested. Kenya has
  only a treasury-bill rate, which cannot enter a duration-8.5 calculation.
  Those markets therefore carry a currency and World Bank structural leg only.
- **5.4 Several country ETFs are delisted but still return history.** NGE
  (Nigeria) last printed 2024-03-28, EGPT (Egypt) 2024-04-04, PAK 2024-03-05,
  FM (frontier) 2025-01-08. They are excluded rather than quoted from a dead
  tape — a naive "has enough rows" test passes all four.
- **5.5 Natural Earth carries no Taiwan polygon at this resolution.** 83 of 84
  markets draw on the basemap; Taiwan is table-only and no alias reaches it.
  North Macedonia, Ivory Coast and Laos WERE fixable and now render (the
  basemap names them Macedonia, Côte d'Ivoire, Lao PDR).
- **5.6 Greece dominates the euro volatility axis.** Its straddle premium is
  ~2,995 bps (30% of notional) because the 2011-12 sovereign crisis sits in
  the 2005-2026 estimation window, implying ~420 bps of annual vol on the
  Greek 10Y. The number is inside its own max-loss bound and is what the
  sample says; it is a regime that arguably no longer applies, and it squashes
  every other line until toggled off in the legend.

## 6. Session log (most recent first)
- **Map coverage expansion + fallen-angel ETF leg** (2026-08-18, session 28 —
  "take a look at the countries not yet covered and add that … add things
  like fallen angels as well where you can use ETFs as proxies"):
  - Universe 85 → 99 markets on the deployed map: HK (EWH + HKD + Asia
    credit), UY/DO/GT/HN/PY (FX + LatAm credit), PA/EC/SV (dollarised —
    credit leg only), IS (ISK-only, developed), KW/OM/BH/JO (pegged FX +
    EMEA credit). Every leg live-verified on yfinance before inclusion;
    RSX (Russia) excluded — dead tape (1 obs).
  - New `fallen_angel` instrument + heat leg: ANGL (US), EM1A.DE (EUR-
    quoted UCITS, →USD via EURUSD), GFA.L (GBp global UCITS, →USD via
    GBPUSD). EM reports UNAVAILABLE (no EM fallen-angel ETF exists).
    Country page gains a "Fallen angels (ETF proxy)" card.
  - Basemap fix (§9.19): China feature still held a Taiwan polygon + empty
    degenerate poly + the HK landmass; China trimmed, HK its own feature,
    Taiwan dup dropped. 216 features, untouched features byte-identical.
  - Verified: 2× seed (cache race → correct on re-run), build clean,
    Playwright smoke (99 countries, FA legs live, HK/US pages render,
    zero console errors), pytest 157 passed.


- **Simulated futures + registry sweep** (2026-08-15, session 27 — "still
  looks too flat and uniform … simulate all the future values forecasted with
  even more possible accuracy"; "go through all of open_items.md"):
  - Both books now run a **residual bootstrap** of the fitted VAR: 1,500
    futures per asset, each iterated step by step with a whole residual ROW
    resampled from the fit's own residuals. Resampling rows rather than
    drawing Gaussians keeps the fat tails, the skew (spreads gap wider far
    more violently than they grind tighter) and the exact cross-sectional
    dependence between grades. `fitVar` now returns `U`.
  - The chart was flat because it drew an EXPECTATION, which is smooth by
    construction — averaging over futures averages the fluctuation away. It
    now draws the median, a 10-90 fan, and one scenario path carried through
    untouched. Measured: scenario paths turn direction 4.1x more often than
    the median on US vol, 45 vs 33 times per sovereign over ten years.
  - Path count set from evidence: at 400 sims the MEDIAN itself wandered ~47
    direction changes per sovereign — sampling noise, not signal. 1,500 sims
    cuts that to 33 and keeps the band readable. Cost 4.7s for 37 sovereign
    VARs, paid once per six-hour cache window.
  - Registry: duplicate item number **2.7** (used for both the web gated-
    feature registry and the three-view curve graphs) renumbered to 2.10;
    §0 rewritten to carry the one genuinely open user action; fourteen bug
    rows added for sessions 22-26; new §5 records six verified limitations.

- **Straddle position model** (2026-08-15, session 26): the volatility book
  priced a NEW straddle at every maturity — a term structure, not a position,
  with no strike, no theta and no financing, and algebraically monotone. Now
  one at-the-money straddle marked to market monthly to expiry: Bachelier
  (the underlying is a spread in bps and goes negative, so not lognormal),
  premium financed at the short rate (USD 3-month bill, euro ECB MRO), and
  23 spread straddles added where the book previously shipped `spread: []`.
  Closed form verified against a 4,000-path Monte Carlo, agreement -1.22% to
  +0.17%. `kappa` removed as unverifiable.

- **VAR forecasts, derived horizons, 84 countries, caching** (2026-08-14/15,
  sessions 23-25): projections became actual forecasts instead of a compounded
  constant edge; horizons derived from spectral radius and sample length
  rather than fixed at fifteen years; universe expanded 49 -> 84 markets with
  a currency heat leg; `cachedJson` added for computed documents and seeded
  into the bundle.

- **Units, buy-and-hold split, basemap** (2026-08-14, session 22): duration
  applied to spreads and yields, friction exponent made dimensionless, monthly
  frequency profile added, `hold` vs `vol` bases split, Jammu & Kashmir,
  Ladakh and the Siachen Glacier merged into India in the basemap
  (`web/scripts/fix_basemap.mjs`, idempotent).


- **JSON-file cache layer for the web API** (2026-08-12, session 20 —
  "no API limit issues; append new values to JSON files and serve from
  there"):
  - `web/api/_shared.js` now has a `cachedRows(kind, key, ttlMs, fetchFn)`
    primitive: per-series JSON files under `web/public/data/cache/`,
    TTL reads (FRED 6h / ECB 12h / Yahoo 2h / ATM IV 3h), append-merge
    refresh (union by date, sorted, deduped), stale fallback on any
    upstream error (rate-limit, 401, 429, network), in-flight dedup map.
    Rewired `fredCsv`, `ecbCsv`, `yahooChart`, `yahooAtmIv` — caller
    signatures unchanged.
  - `web/public/data/cache/` is bundled via `vercel.json` `includeFiles:
    "public/data/**"` so cold Vercel instances start with the last-known
    data. Local `serve.mjs` writes the same files — running the system
    once populates the cache for every later user in the same window.
  - Verification: first cold runs populated 7 FRED / 1 ECB / 15 Yahoo /
    ATM IV files; second identical calls within TTL → mtime unchanged
    (cache hits confirmed); Playwright sweep all 14 sections OK; pytest
    149 passed; build clean.

- **GitHub + Vercel deployment** (2026-08-13, session 21):
  - Clean first-commit repo: `akrishna2508/public-credit-engine` (115 files, 17k LOC)
  - Vercel Root Directory = `web`; Build = `npm run build`; Output = `dist`
  - Serverless runtime fixed: `nodejs20` → `nodejs` (all 4 API files)
  - Env vars documented: required `FRED_API_KEY` + 6 optional free-tier keys
  - API verification: all 4 endpoints return `"status":"OK"` with data

- **Dashboard audit + auto-go-live Signals page** (2026-08-12, session 19 —
  "audit every feature before hosting on Vercel; fix what's broken; custom
  auto-go-live screens for features that cannot run yet"):
  - Playwright sweep of every page/control (map, country DE/GB, returns
    markets×modes×views + legend toggles + period presets, history US +
    sovereign selector, mobile); 9 real bugs found and fixed (all web layer,
    LEDGER Session 19): orphaned `feeVals` ReferenceError; rollingMean NaN
    poisoning (silently empty Returns API); dealer-vol units mismatch
    (hf/ret −4e14…−3e16 explosions → engine-mirror 90d std of bps diffs);
    ATM-IV sanity gate [0.02, 2.0] (mirror of IV_MIN_REAL); map.js dead row
    clicks (listeners attached before rows rendered); history y-axis unit;
    router race leaking stale charts on rapid hash navigation (nav-sequence
    token); fetch timeout 25→45s (cold serverless storms); audit-handle
    paint probe. Re-audit: all 14 sections OK, zero console/page errors.
  - New `/api/status` + Signals page (6 gated features, auto-go-live cards):
    IV-RV premium (3/20, auto 2026-09-03), COT BBG HY (auto 2028-03-31),
    COT BBG IG (auto 2028-05-31), per-country straddle/VRP (data-gated, no
    date promised), EMHY chain (same), ANGL straddle quote (same). `live`
    flips by itself: snapshot-driven (seed copies data/iv_history.json →
    api/iv_history.json after every daily accrual) + calendar-driven (COT
    legs). No code change needed for a feature to go live.
  - Battery: pytest 149 passed; vite build clean; node --check clean.

- **To-do sweep + FRED layer verification** (2026-08-12, session 18 — "update
  the to do list and complete the remaining items"):
  - Registry re-read; remaining actionable items: (a) §9.18 Python-engine
    FRED CSV port check, (b) §4.2 IV-RV accrual re-verify, (c) §2.3 atlas
    straddle_yield_ann, (d) §0 key re-flag.
  - (a) **RESOLVED — no port needed**: the Python engine already uses the
    keyed JSON observations API (`config.FRED_BASE_URL`; `fetch_fred_series`
    builds the JSON URL; zero `fredgraph` references in the whole Python
    tree). Verified LIVE with a 6-series fetch (DGS10 4.720% 2026-08-10,
    DGS2 4.25, DGS30 5.25, IG AAA OAS 0.40, Bund 2.97% 2026-06, HY default
    rate 2.92% 2026-01 quarterly-as-designed) + two real board runs:
    `--market global --source curve` (CURVE z=−0.6, VALIDATED) and
    `--source sovereign` (RISING_DEBT Uzbekistan via World Bank +
    IRLTLT01{CC}M156N). §9.18 closed with evidence.
  - (b) Re-verified 3/20 + ANGL 2 + JNK 1 (last real snapshots 08-11).
    Accrual ran: 22/23 sources; today's feed served STUB IVs (1e-05…0.008)
    and the `IV_MIN_REAL = 0.02` floor rejected every snapshot — history
    file untouched (mtime 08-11 22:58) — the gate working live as designed.
  - (c) **DONE**: data/atlas.json (generated 2026-08-12 01:04) carries
    live `straddle_yield_ann` (HYG 0.0319 / LQD 0.0593 / TLT 0.1073 /
    EMB 0.0866 / JNK 0.0738; ANGL honest empty). Web seed bundle
    regenerated from it (`npm run seed`, 15 countries).
  - (d) §0 unchanged — user must paste a fresh FRED key; now also needed
    for the deployed site's API env var.
  - Full battery: `pytest tests/ -q` → **149 passed**; pyflakes clean.
  - No numeric constants changed — no §6 audit-log edits.

- **Web frontend + live API-layer fixes** (2026-08-12, session 17):
  - Rebuilt the SPA layer the environment wipe removed — `src/pages/*`,
    `src/main.js` router, `src/charts/*` (map/projection/history), custom
    legend + controls, `scripts/{serve,web_seed}.mjs`, `public/data/`
    (world.json vendored from pinned echarts@4.9.0; bundle.json = 15-country
    seed), `node_modules` reinstalled, package scripts `seed`/`serve`.
  - LIVE FINDINGS fixed in `web/api/`: (1) FRED decommissioned
    `fredgraph.csv` on api.stlouisfed.org (404 on every form) → `fredCsv`
    now uses the keyed `fred/series/observations` JSON API — without this
    the US layer was dead; (2) ECB csvdata parsed positionally (FREQ as
    date) → header-driven columns → countries market now 11/11 live;
    (3) `angRows` typo; (4) `fetchWithRetry` reapplied to fredCsv/yahooChart.
  - End-to-end verification: `npm run build` ✓; `scripts/serve.mjs` +
    headless Chrome on `#/map` (canvas + 17 rows), `#/returns` (canvas +
    legend), `#/history` (2 canvases), `#/country/DE` (2 canvases,
    0 empties), `#/country/GB` (honest empty for the non-euro-area
    projection card); zero console errors. API sweep: us/pure 8 assets,
    countries 11, DE history 258 monthly pts.
  - NOTE for the Python engine (not touched this session): the FRED CSV
    endpoint death only affects `web/api/`; `engine/data_engine.py`
    `fetch_fred_series` still calls fredgraph.csv — verify next run whether
    it needs the same JSON-API port (§1.14).

- **Todo-sweep pass** (2026-08-11, session 16 — "update the to do list and do
  everything that is left over"):
  - To-do register updated; every item that CAN be done today was executed
    and verified; the two remaining gaps are data/time-gated, not code:
    §0 FRED key (user must paste a fresh one — re-verified still
    `ccb67ba5...`) and §4.2 IV-RV (3/20, auto-unlocks ≈ early September).
  - Full live verification battery re-run this session, all clean:
    `pytest tests/ -q` → **147 passed**; accrual script exit 0 (22/23
    sources, redacted polygon 400/429 as documented — non-load-bearing);
    `--market backtest` exit 0 (CURVE VALIDATED +1/0.215, REAL-RATES
    VALIDATED +1/0.738, EM-CARRY VALIDATED +1/0.061, COT-STRATEGY REJECTED
    −1/−0.572, APPETITE REJECTED −1/−0.198, IVRV gated 3/20);
    `--market global` exit 0 (sovereign legs live — KR LONG_DURATION,
    EM_EMEA/EM_LATAM SHORT_DURATION, EM sector RICH_AVOID rows);
    `--market us/eu/em --percentile 90` exit 0 with 0 tracebacks each
    (US ~25 min; EU includes the country panel with monthly hold units;
    EM pairs live); `--market atlas` exit 0 (region rollup americas
    −1.242 / europe 0.809 / asia −0.535 / apac 1.283 / africa 2.508).
  - EMHY re-verified live: still ZERO listed expiries (genuine
    thin-market fact, stays honestly UNAVAILABLE). ANGL has expiries
    (2026-08-21/09-18/10-16/2027-01-15) but the near chain shows 0 calls /
    2 puts with zero OI — no straddle quote possible, honest None. COT
    credit futures legs: history gate ≈ 2028, nothing to do (2.5).
- **Verification**: see per-item above; PNGs refreshed
  (usa/eu/em three-view return-curve files, 21:03 timestamps); no code
  changes this session — pure verification + registry update.

- **Three-view curves + EUR country panel + sweep** (2026-08-11, session 15):
  - Three-view curve graphs built (2.7): `return_curve` gains `Gross_bps`
    (Tier 1 payout); `plot_return_curve_view()` renders ONE view per PNG;
    every US/EU/EM run now emits `{region}_{tag}_{gross,hf_net,retail_net}
    _return_curves.png`; summary table gains `gross@T` column.
  - EUR country-level panel built (2.8): `engine/eur_country.py` +
    `config.ECB_LTIR_COUNTRY_KEYS` (11 keys, all live) — 10Y LTIR per
    country, Bund spread, 1M/3M/12M changes, country level + spread
    straddle curves with monthly hold units (honest cadence for monthly
    LTIR); `europe_country_{level,spread}_{view}_return_curves.png`.
  - EUR/EM now run the full shared machinery (3.3): adjacent-tier spread
    pairs added (EUR_HY−EUR_IG; EM_Corporate−EM_USD_Sovereign,
    EM_High_Yield−EM_Corporate, EM_Local_Currency−EM_High_Yield).
  - Live-data bugs fixed: GCO sovereign leg (1.10, dict held suffix
    fragments → 400s), API keys in fetch-error logs (1.11, all three
    scrubbed + regressions), FINRA breadth date column (1.12, matcher now
    includes `tradereportdate`), cost-basis series-index anchor (1.13,
    components reindexed to the series' own index).
  - EMB ATM IV re-checked live (3.1): 0.1604, not 0.42 (expiry moved).
  - First REAL straddle snapshots accrued (4.1): HYG 0.22/DTE3, LQD 0.57,
    TLT 0.75, EMB 1.36/DTE10, JNK 1.17/DTE10 → atlas options show
    `straddle_yield_ann` live.
  - USER ACTION: `.env` still holds the compromised FRED key (prefix
    `ccb67ba5`); user must replace it with a fresh one (see §0).
- **Verification**: `pytest tests/ -q` → 147 passed (6 new: straddle yield,
  eur country panel ×2, secret redaction ×2, curve view) — see
  LEDGER.md Session 15; pyflakes clean; 24 three-view curve PNGs +
  country curve PNGs generated; us/eu/em/global/backtest runs exit 0;
  `rg` key scan clean.

- **Return curves + negative-returns audit** (2026-08-11, session 14):
  - User flagged negative fixed-period nets ("must be positive even after
    broker premiums") and asked for line-chart returns (multiple lines +
    legend per item) instead of a single fixed-day metric.
  - Full component decomposition at 90th pct / T=5 verified mechanics:
    fee = rolling empirical |ΔT| shifted by T (no look-ahead), no
    double-count, aligned windows. Negatives were honest economics:
    IG edge 0.4–0.6 bps < markup (~0.2) + friction (~0.5); HF positive via
    the PB discount (~13.5%). One real mechanics bug found: the FA
    distressed premium substring match charged BB/BBB/pairs (1.6).
  - Return curves implemented (2.6): `return_curve()`/`first_positive_hold()`
    in engine/volatility.py, `plot_return_curves()` in
    engine/volatility_matrix.py, wired through pipelines/volatility_strategy.py
    at GARCH_SIGNAL_PERCENTILE. Live (90th pct, retail@5): FA +1.19,
    BB +1.15, BBB −0.21, AAA −0.24, A −0.16, AA −0.04; first-positive holds
    FA/BB/CCC/B T1, A T7, BBB T9, AA T10, AAA T13; IG pairs honest no-edge.
    PNGs: usa_public_pure_return_curves.png + usa_public_spread_return_curves.png.
  - Q1 edge-gated voting: persist_leg_validation/load_leg_validations/
    leg_validation_status (engine/backtest.py), battery persists all 7
    strategy legs, _gate_leg abstains REJECTED/NOT_CONFIRMED
    (pipelines/global_credit.py). Live board: 6 COT rows [SKIP] (fitted −1,
    OOS Sharpe −0.574), REAL-RATES LONG_TIPS +1.000, 2s10s LONG_STEEPENER.
  - Q2 Docker: compose stack up (healthy), schema applied, atlas --db
    verified, API 200, Redis cache verified (1.7/1.8, §4.3).
  - Live-data bug: em_carry lambda captured the yf.Ticker (1.9) → fixed;
    EM-CARRY board row now VALIDATED.
- **Verification**: `pytest tests/ -q` → 141 passed (6 new:
  test_fallen_angel_premium_exact_grade_only, test_return_curve_shape_and_first_positive,
  test_board_validation ×3, test_clean_for_json_strips_nan); pyflakes clean;
  `python cli.py --market us --percentile 90 --hold-days 5` exit 0 with
  curve tables + PNGs; `python cli.py --market backtest` exit 0 with 5
  persisted validations; `python cli.py --market global` exit 0 with
  validation-gated votes; `docker compose ps` both healthy.

- **Broker-premium lightening** (first instruction, 2026-08-11):
  - `DEALER_MARKUP_PREMIUM_SHARE = 0.3` (config.py + engine/dealer_markup.py):
    dealer comp = 30% of the IV−RV premium over parity, not the full IV/RV
    ratio. Live `data/dealer_markup.json`: avg 1.174→1.069, max 1.816→1.245,
    floor 1.05 unchanged.
  - `FALLEN_ANGEL_LIQUIDITY_PREMIUM`: 1.20 → 1.05 (distressed dealer width
    +20% → +5%).
- **"Resolve everything technical"** (second instruction, 2026-08-11):
  - Empirical |T-day move| fee (`get_empirical_move_fee`) — FA fee 36.5→14.2,
    net −18.3→+1.4; all HF nets positive (0.1–1.9), retail ≈ −0.4..+1.2.
  - Pair-leg netting (one straddle on the traded series; `raw_df`/
    `is_pair_mode` removed from `analyze_strategy`).
  - `FRICTION_BASE_SPREAD_BPS` 1.0 → 0.5.
  - APPETITE root cause fixed (quarterly DR + `asfreq("ME")` all-NaN →
    `resample("MS")` + ffill-limit + staleness gate): 0 → 654 obs.
  - `_bt_ivrv` battery leg built (gated 2/20, auto-unlocks at 20).
- **Verification**: `pytest tests/ -q` → 135 passed (6 new); `python cli.py
  --market us --percentile 90` exit 0, all 6 heatmap PNGs regenerated;
  `python cli.py --market backtest` exit 0 (APPETITE 654 obs fitted −1,
  EM-CARRY 1010 obs fitted +1, IVRV gated).
- Cross-checked during the sweep that the system's other premiums (PB
  discounts, friction, EL) are as documented in CONTEXT §6 — no further
  uncalibrated premium constants found.