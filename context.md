# context.md — Public Credit Opportunity Engine (READ FIRST, EVERY SESSION)

> Session protocol: the first instruction every new session is to read this
> file in full before touching any code. It is the canonical project spec:
> objective, architecture, data sources, secrets, calibration audit log, and
> known gaps.

## 1. Project

A modular Python system that **evaluates and surfaces opportunities in public
debt markets**. It ingests live ICE BofA yield/spread series from the Federal
Reserve Economic Data (FRED) API and ETF-traded proxies via yfinance,
estimates default rates and expected losses by rating grade, forecasts
term-structure shifts (VAR / VECM with Johansen cointegration), simulates
volatility-band straddle strategies across shock percentiles, and produces a
liquid ML credit scorecard (XGBoost + LightGBM + CatBoost stacked, SHAP
explanations).

The system answers: *where is compensation in public credit markets right now,
and what is the expected payoff of trading volatility in those segments?*

## 2. What this project is NOT

The **private credit pipeline has been completely removed** and must never be
reintroduced:

- Removed: `private_credit_data.py`, `credit_ratios.py`, `private_credit.py`,
  `global_private_credit.py`, `ml_credit_engine.py` (NeuralCox private-deal
  super-learner), `risk_simulation_engine.py` (deal-level EV/CVaR with
  hardcoded cash flows / PD curves / LGD), and notebook markets 3 & 6.
- No MOIC, IRR, NAV unsmoothing, all-in-yield, covenants, private deal
  cash-flow modeling, or synthetic random deal data exists anywhere.
- Do not copy private-credit code back in. If a request asks for it, decline
  and point at this file.

## 3. Architecture

```
Public Credit/
  cli.py                 # argparse entry: markets us | eu | em | ml | global | backtest
  config.py              # secrets loader, FRED series maps, calibrated constants, GCO maps
  engine/                # pure logic + data layers (no I/O prompts)
    data_engine.py        # FRED session + ETF yields + feature engineering
    spreads.py            # US ICE BofA yield spreads (FRED) + ANGL proxy
    default_rates.py      # DR/OAS/LGD -> expected loss by grade (public)
    analysis.py           # spread-minus-EL composite + forecast dispatch
    forecast.py           # Johansen-augmented VAR/VECM + IRF + Granger
    pure_yield_forecast.py# VAR forecast of pure bond yields (bps)
    volatility.py         # straddle pricing, empirical |T-day move| fee, GARCH,
                          #   shock/normal P&L
    volatility_matrix.py  # heatmaps (gross / HF net / retail net)
    dealer_markup.py      # MOVE/TNX -> dealer markup series
    ml_engine.py          # ETF super-learner + SHAP + anomaly gate
    main_alpha.py         # scorecard/asset-profile/vol-regime charts
    bonds_EUR_data.py, bonds_EM_data.py  # regional public proxies
    treasury_curve.py     # slope/curvature/forwards, rolling 252d z (GCO)
    futures_layer.py      # SOFR-strip implied forward rates only (GCO)
    options_surface.py    # IV-RV premium z, IV history accrual (GCO)
    cot_positioning.py    # rolling lev-money/dealer z, >=2y gate (GCO)
    trace_liquidity.py    # FINRA-gated liquidity breadth (GCO)
    sovereign_screen.py   # World Bank debt CAGR + unhedged FX overlay (GCO)
    eur_panel.py          # Bund-based EUR risk-free, no US substitution (GCO)
    eur_country.py        # EUR country-level panel: ECB LTIR 10Y yields per
                          #   country + Bund spreads + shared straddle
                          #   machinery (monthly hold units) + 3-view curves
    global_board.py       # threshold-only conviction board (GCO)
    atlas.py              # country map logic: yield changes, price proxies, heat, CDS proxy,
                          #   spec legs: straddle yield, futures basis, real yield, term
                          #   spread, GeoJSON FeatureCollection + DB-row builders
    backtest.py           # hit-rate / IC / Sharpe / Sortino / maxDD + leg-validation
                          #   gate (persist_leg_validation / leg_validation_status, GCO)
    volatility.py         # straddle pricing, empirical |T-day move| fee, GARCH,
                          #   shock/normal P&L, hold-horizon RETURN CURVES
                          #   (Gross_bps / HF_net_bps / Ret_net_bps three views)
    volatility_matrix.py  # heatmaps (gross / HF net / retail net) + 3-view
                          #   return-curve plots (one PNG per view)
  sources/                # GCO data layer: registry + probe + 10 source modules
    registry.py           # SourceUnavailable, SourceStatus, cache_json TTL, IV accrual
    probe.py              # 16-source probe -> data/source_probe.json
    fred_ext.py  treasury_api.py  cftc.py  ecb.py  finra.py
    world_bank.py  yf_futures.py  yf_options.py  yf_fx.py  optional.py
  scripts/                # accrue_iv_daily.sh + launchd plist (IV-RV accrual)
  pipelines/
    us_public.py  eur_public.py  em_public.py  ml_scorecard.py
    volatility_strategy.py  # shared spectrum runner + 3-view return-curve plots
    global_credit.py    # GCO Opportunity Board assembly (validation-gated votes)
    backtest.py         # walk-forward OOS battery (CURVE/COT/strategies)
    heatmap_db.py       # Postgres export of atlas rows (spec §4, DATABASE_URL-gated)
  api/
    server.py           # FastAPI heatmap portal (spec §6): /api/v1/heatmap GeoJSON,
                        #   /api/v1/countries/{iso} drill-down, /api/v1/regions
                        #   (NaN-sanitized; Redis parse-cache when REDIS_URL set)
  sql/
    heatmap_schema.sql  # heatmap portal DDL (spec §4): countries + country_financial_metrics
  docker-compose.yml    # local postgis + redis for the portal (spec §4/§1)
  web/                  # public opportunity site (Vite + ECharts SPA, deployed)
    index.html  vite.config.js  package.json  vercel.json
    src/                  # store (API-first + bundle fallback), router (main.js),
                          #   charts (map / projection / history), custom legend,
                          #   period/zoom controls, pages (map/returns/history/
                          #   country/signals — the map page carries the region
                          #   heat card with its per-region country dropdown;
                          #   signals = the gated-feature
                          #   registry with auto-go-live cards per §10, driven
                          #   by /api/status)
    api/                  # Vercel-compatible serverless handlers on web/api/_shared.js:
                          #   atlas.js (opportunity map), returns.js (projected
                          #   return curves), history.js (real 15y+ series),
                          #   status.js (gated-feature registry for the Signals
                          #   page: honest state + progress + auto-go-live dates,
                          #   driven by the committed api/iv_history.json snapshot)
    scripts/              # serve.mjs (local dist+API server, .env loader),
                          #   web_seed.mjs (seed bundle generator + IV-history
                          #   snapshot copy api/iv_history.json + status.json;
                          #   re-run automatically by scripts/accrue_iv_daily.sh
                          #   after every daily accrual so the Signals cards
                          #   auto-go-live on schedule)
    public/
      data/
        cache/          # rate-limit defense layer (§4): per-series JSON files
                          #   for FRED/ECB/Yahoo/ATM-IV with TTL reads, append-
                          #   merge refresh, stale fallback on rate-limit/error.
    public/data/          # world.json (vendored echarts@4.9.0 basemap — China
                          #   split into China/Hong Kong/Taiwan, see §9.19) +
                          #   bundle.json (156-market seed snapshot — offline fallback)
  data/                    # dealer_markup.json, expected_loss_by_grade.json,
                           # cache/, iv_history.json, source_probe.json, atlas.json,
                           # backtest_legs.json (walk-forward sign fits, board vote gate)
  notebooks/               # original Credit_engine.ipynb (archived, read-only)
  tests/                   # pure-logic unit tests (no network)
```

Data flow (US): FRED fetch -> merge -> spread bps -> tables -> default/EL ->
spread-EL composite -> VAR/VECM forecast -> volatility spectrum simulation ->
GARCH shock vs normal P&L -> heatmaps. EUR/EM short-circuit at the volatility
spectrum. ML uses ETF OHLCV + FRED macro anchors -> engineered ratios -> stack.

Data flow (GCO): probe every free source -> gate each (real data or
UNAVAILABLE + fix) -> board legs (COT positioning z, options IV-RV premium z,
2s10s curve z, sovereign debt trend, FX overlay) -> conviction from
threshold-only agreement (no magic weights) -> backtest battery validates
each leg walk-forward (publication lag + 1-day execution delay, no
look-ahead).

## 4. Data sources

- **FRED (key in `.env`)**: ICE BofA option-adjusted spreads per grade
  (`BAMLC0A*` IG, `BAMLH0A*` HY), default rates (`DRBLACBS`, `DRCCLACBS`),
  Treasury yields (`DGS10`, `DGS2`), Moody's seasoned yields (`AAA`, `BAA`,
  `BAA10Y` — the `MoodyAAA`/`MoodyBAA` ids returned HTTP 400; fixed via FRED
  search), German Bund 10Y (`IRLTLT01DEM156N`). Series IDs in
  `config.US_BOND_SERIES`, `FRED_OAS_SERIES`, `FRED_DR_SERIES`. OECD
  long-term rates per country (`IRLTLT01{CC}M156N`) in
  `config.GLOBAL_SOVEREIGN_COUNTRIES` — **2026-08-11 fix**: the dict
  previously held suffix fragments ("USM"), so the GCO sovereign leg built
  `IRLTLT01USMM156N` and every key 400'd; it now holds full series IDs and
  the leg is live (KR LONG_DURATION vote). The FRED key is redacted from
  fetch-error logs (2026-08-11; polygon + NDL keys scrubbed the same way).
  **2026-08-12 (web API layer)**: FRED decommissioned
  `api.stlouisfed.org/fredgraph.csv` — every request (both `id=` and
  `series_id=` forms) now 404s with 0 redirects; the keyed
  `fred/series/observations` JSON API is the live path.
  `web/api/_shared.js` `fredCsv` was ported to it (verified live:
  DGS10/BAMLC0A1CAAA/IRLTLT01DEM156N all stream). The Python engine
  already uses the JSON API (`config.FRED_BASE_URL` +
  `engine/data_engine.py` `fetch_fred_series`; re-verified live
  2026-08-12 — zero `fredgraph` references in the Python tree, §9.18).
- **ECB Data Portal (keyless)**: euro-area GOVERNMENT yield curves
  (`YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y` AAA 10Y and `G_N_C` all-ratings
  10Y, `?format=csvdata`; 5603 obs, verified live 2026-08-10). Two fixes
  landed that day: the URL must be `data/YC/B.U2...` (flow as a path
  component — the dotted `data/YC.B.U2...` form 400s), and the YC dataflow
  publishes government keys only — every corporate key (`C_N_*`) 404s.
  Euro corporate compensation comes from FRED `BAMLHE00EHYIOAS` + UCITS
  ETFs. **Per-country 10Y benchmark yields (verified live 2026-08-11)**: the
  YC dataflow is euro-area aggregate only — every per-country YC key
  (`YC.B.DE...`) 404s — so the country panel uses the ECB long-term interest
  rate dataflow instead: `IRS/M.{CC}.L.L40.CI.0000.EUR.N.Z` (same
  flow/series URL split), monthly, ~35y history, all 11 keys in
  `config.ECB_LTIR_COUNTRY_KEYS` live (DE/FR/IT/ES/NL/BE/AT/PT/IE/FI/GR,
  396-486 obs each, latest 2026-06-01; `engine/eur_country.py`).
- **US Treasury Fiscal Data API (keyless)**: auctions + debt-to-penny. The
  debt dataset moved to `/v2/` and renamed the amount field
  (`tot_pub_debt_out_amt`).
- **yfinance**: ANGL (fallen angels), EUR UCITS IEAC.L/IHYG.L, EM ETFs
  EMB/CEMB/EMHY/LEMB, ^IRX 13-week T-bill, ^MOVE/^TNX for dealer markup,
  and ML screen ETFs SHY/TLT/LQD/HYG/ANGL/PFF.
  **Atlas fallen-angel leg (2026-08-18)**: the map's `fallen_angel`
  instrument/heat leg uses ANGL (US), EM1A.DE (VanEck US Fallen Angel UCITS,
  EUR-quoted on Xetra — converted to USD via EURUSD) and GFA.L (VanEck
  Global Fallen Angel UCITS, GBp — converted via GBPUSD); all three verified
  live 2026-08-18. No EM fallen-angel ETF exists (EMHY is ordinary HY) —
  EM countries report the leg honestly UNAVAILABLE. Universe expanded
  85 → 99 markets (2026-08-18, §9.19): HK (EWH), UY/DO/GT/HN/PY (FX
  crosses), PA/EC/SV (dollarised — credit leg only), IS (ISK only),
  KW/OM/BH/JO (pegged FX + EMEA credit); every new leg live-verified. RSX
  (Russia) excluded — dead tape on yfinance (1 obs).
  **Africa + Central Asia pass (2026-08-18, second sweep)**: universe
  99 → 133. +32 African markets (DZ/LY/SD/MR/ML/BF/NE/BJ/TG/GW/GM/GN/LR/CM/
  GA/CG/CD/TD/CF/GQ/BI/RW/SO/DJ/KM/MG/MW/MZ/SC/CV/SZ — every FX cross
  live-verified n=260; CFA countries share the XOF/XAF union-peg crosses).
  New **centralasia** region (KZ moved from Emerging Europe, + UZ/TM/AF).
  Honest exclusions: AOA/ERN/STN/AMD/AZN/GEL/MNT/TJS (single placeholder
  quote, no history), KG/SS/ZW/SL (dead or single-obs chart), NGE/EGPT
  (delisted). Map aliases added for the basemap's pre-2019 forms (Congo,
  Dem. Rep. Congo, Central African Rep., Eq. Guinea, Swaziland).
  **Third sweep (2026-08-18): Russia + 21 more — universe 133 → 156.**
  RU back via a LIVE USDRUB=X series (n=517; RSX/ERUS dead tapes — 1 stale
  2026-07-17 obs — and RUSL stopped 2022, so the equity leg stays honestly
  UNAVAILABLE; Russian corporates are in the ICE BofA EMEA index). Also:
  BY, ME (euroised, EUR), CY/MT (EU periphery — EMEA credit, the one case
  where a europe-region country carries the regional index), IQ/YE/LB
  (EMEA credit), IR (fx-only — not in any ICE index), BO/VE (LatAm
  credit), NI + Caribbean JM/TT/BS/BB/BZ/GY/HT (fx-only — no index
  covers them), FJ/PG (fx-only, Pacific), NP/MV (fx-only; Maldives has no
  basemap feature — table + drill-down only, the note says so). Probed
  and excluded: BA/SR/SB/WS/TO (single obs), VU/SY (2y-range chart 1 obs
  — Sierra Leone class), BT (stale 2024).
- **CFTC COT (keyless)**: `fut_fin_txt_{year}.zip` per-year files -> net
  leveraged-money / dealer positioning z-scores for UST 2Y/5Y/10Y/BOND/
  ULTRA/SOFR-3M and BBG IG/HY credit futures (≥2y history gate; the IG/HY
  contracts only listed 2026-03/05, so those two legs stay gated until
  ~2028).
- **World Bank (keyless)**: external debt stock / service / debt-to-GNI
  indicators -> 5y CAGR sovereign screen, plus the credit-gap proxy
  (`FS.AST.PRVT.GD.ZS`, domestic credit to private sector % of GDP — the
  BIS replacement, 5565 obs verified live 2026-08-10).
- **FINRA TRACE (free Public Credential)**: `fixedIncomeMarket/
  CORPORATEMARKETBREADTH` + `CORPORATESANDAGENCIESCAPPEDVOLUME` (the
  previously-configured names 404'd; real names verified live 2026-08-10).
  Auth is the FIP OAuth2 client-credentials flow (token POST ->
  `ews.fip.finra.org`, Bearer on the Query API) — the earlier Basic-on-data
  approach 401'd. Aggregated public datasets only; the paid
  transaction-level tier is never touched.
- **yfinance futures/options/FX**: Treasury/SOFR futures panel
  (ZT/ZF/ZN/ZB/UB/SR3), ATM IV + put/call OI chains accrued daily to
  `data/iv_history.json` (expiry-walk fallback: thin ETFs like ANGL get the
  first expiry with a usable chain; EMHY lists no expiries at all and stays
  honestly UNAVAILABLE), 8 DM/EM FX pairs for the unhedged overlay. Since
  2026-08-10 each snapshot also accrues the **ATM straddle price ($) + DTE**
  (heatmap spec §3.3) — the FIRST REAL straddle snapshots landed 2026-08-11
  (HYG 0.22/DTE3, LQD 0.57, TLT 0.75, EMB 1.36/DTE10, JNK 1.17/DTE10; ANGL's
  thin chain has no straddle quote yet) and the atlas options section now
  shows `straddle_yield_ann` live. The stub-IV rejection gates stay
  (IV_MIN_REAL = 0.02) — a bad feed can never overwrite a real day. Cash-
  **index** futures basis/carry (spec §3.4) is computed
  on ES=F/^GSPC + NQ=F/^NDX (same-underlying; CME third-Friday DTE rule);
  NK=F / FDAX.EX are NOT listed on yfinance (verified live 2026-08-10) so
  other countries' basis legs stay honestly UNAVAILABLE.
- **Web API cache (NEW 2026-08-12, session 20)**: every upstream series
  (FRED, ECB, Yahoo chart, Yahoo ATM IV) is persisted to
  `web/public/data/cache/{fred,ecb,yahoo,atmiv}/*.json` with TTL reads
  (FRED 6h, ECB 12h, Yahoo chart 2h, ATM IV 3h), append-merge refresh,
  stale fallback on rate-limit/error, and in-flight dedup. Bundled via
  `vercel.json` `includeFiles: "public/data/**"` so cold instances start
  with the last-known data. Local runs persist the same files — running the
  system once populates the cache for every later user in the same window.
- **Optional keyed free tiers (all availability-gated)**: Alpaca (SGOV
  0-3-month T-bill ETF last-trade quote — symbol-based; the CUSIP lookup
  was the bug). FMP and the US Debt Clock were REMOVED 2026-08-10 (FMP key
  403'd everywhere; Debt Clock 404'd everywhere — Treasury debt_to_penny
  already covers it live). Nasdaq Data Link + Polygon optional keys exist in
  .env; 2026-08-10 probe: NDL USTREASURY/YIELD 403'd and Polygon
  options/contracts 400'd on this client's free tiers — reported honestly
  by the probe, non-load-bearing.
- **Heatmap term structure + real yield (FRED)**: full US nominal curve
  DGS2/DGS5/DGS10/DGS30 and the T10YIE 10Y breakeven → US real yield
  (`Y_10Y − breakeven`, spec §3.1; no free per-country breakevens exist, so
  only the US leg is real). ECB euro-area AAA curve extended to
  1Y/5Y/10Y/30Y (all verified live 2026-08-10, 5604 obs).
- `data/expected_loss_by_grade.json`: Moody's/S&P long-run calibration values
  (AAA 0.40 LGD .. CCC 0.682). Published, not random — see audit log.
- **Heatmap portal store (spec §4/§6)**: `data/atlas.json` is the live store;
  `sql/heatmap_schema.sql` is the documented PostgreSQL/PostGIS DDL (applied
  by the user; export via `--market atlas --db`, gated on DATABASE_URL +
  psycopg). The local stack is **dockerized since 2026-08-11**:
  `docker compose up -d` runs postgis (publiccredit-postgres, port 5432) +
  redis (publiccredit-redis, port 6379); .env.example documents the two URLs
  (psql apply once). `api/server.py` (FastAPI, installed) serves
  `/api/v1/heatmap` GeoJSON + `/api/v1/countries/{iso}` drill-downs (NaN-
  sanitized — a legacy NaN in the store 500'd the strict JSON serializer,
  fixed 2026-08-11); the Redis parse-cache is mtime-keyed (no TTL
  constants), falling back to the JSON-file parse when unset or broken.

## 5. Secrets

- `FRED_API_KEY` lives **only** in `.env` (class placeholder name as per user
  instruction; user fills it in). `.env` is git-ignored.
- All code reads the key through `config.get_fred_key()`, which raises a clear
  error when unset. **Never** embed a key literal in source.
- Optional free-tier keys (FINRA Public Credential, Alpaca) are
  read through `config.get_*_key()` getters that return `None` when absent;
  their sources report UNAVAILABLE with signup instructions. `.env.example`
  documents every key with a "how to obtain" comment.
- The original notebook's leaked key (`ccb67ba5...`) was removed from the
  working tree: the literal was found not only in the archived notebook but
  also sitting in `.env.example` (removed 2026-08-09, replaced with
  `REPLACE_ME`); it now survives only inside the archived notebook under
  `notebooks/` (excluded from the repo audit scan) and in the self-checking
  test `tests/test_config.py`. The scan covers **all** repo files (not just
  `*.py`) and passes.
- **2026-08-11 live finding**: `.env` still holds the compromised key
  (prefix `ccb67ba5` — the archived-notebook literal). The codebase scan
  deliberately excludes `.env` (the user's key file), so it passes, but the
  user MUST replace `FRED_API_KEY` with a freshly-issued key (the old one is
  public in the notebook). Fetch-error logs now redact the key literal
  (`data_engine.fetch_fred_series`; polygon + NDL scrubbed the same way in
  `sources/polygon.py` / `sources/ndl.py`). **RESOLVED 2026-08-12**: user
  replaced the key in `.env` and the Vercel env var.

## 6. Calibration audit log (every surviving number, its justification)

| Constant | Value | Source / justification | Live override |
|---|---|---|---|
| `PUBLISHED_LGD` | 0.400..0.682 by grade | Moody's Historical LGD study; not random | no |
| `VOLATILITY_PERCENTILES` | [95,90,80,70,60,50] | Strategy convention (trade shock bands) | CLI `--percentile` |
| `GARCH_SIGNAL_PERCENTILE` | 90 | Peak distress detection convention | CLI |
| `MIN_OBS_FOR_GARCH` | 100 | arch min-sample fineness | — |
| `DEALER_PRICING_WINDOW` | 90 | 1-quarter vol estimation window | — |
| `DEALER_MARKUP_FLOOR` | 1.05 | upstream code documented | markdown parking data/ |
| `REALIZED_VOL_LOOKBACK` | 21 | one-month vol | — |
| `PB_BASE_DISCOUNT / VOLUME_FACTOR` | 0.05 / 0.05 | simple PB execution discount convention | — |
| `PB_VOL_THRESHOLD_BPS` | 100.0 | vol above which illiquidity penalizes | — |
| `FRICTION_BASE_SPREAD_BPS` | 0.5 | base friction units (halved 2026-08-11: 1.0 pinned every retail net ≈ −1 bp on a fair-priced strategy; 0.5 = single execution half-spread) | — |
| `FRICTION_GROWTH_RATE` | 0.08 | per-unit exponential friction growth | — |
| `FRICTION_PERCENTILE` | 90 | friction kicks above 90th vol percentile | — |
| `FALLEN_ANGEL_LIQUIDITY_PREMIUM` | 1.05 | distressed dealer width lightened +20% → +5% (2026-08-11 sweep: the 1.20 no longer has live support and, stacked on the markup, pushed every net negative; +5% keeps a modest width penalty). Applies to the **exact** Fallen_Angel asset only — 2026-08-11 bug fix: the legacy substring match charged BB/BBB/pair names the premium ("B" ⊂ "BB") | — |
| `DEALER_MARKUP_PREMIUM_SHARE` | 0.3 | dealer comp = 30% of the IV−RV premium over parity, not the full ratio — charging 100% handed the whole short-vol carry to the dealer. Live effect (2026-08-11, MOVE/TNX): avg 1.174→1.069, max 1.816→1.245, floor 1.05 | live MOVE/TNX |
| `VAR_JITTER_SCALE/SEED` | 1e-8 / 42 | numerical: keeps VAR covariance PSD; immaterial 1e-8 bps | — |
| `DEFAULT_NOTIONAL_USD` | 100,000 | display/portfolio notional (CLI-overridable) | CLI |
| `DEFAULT_TRADE_SIZE_M` | 50.0 | per-trade size ($M) | CLI |
| `DEFAULT_HOLD_DAYS` | 5 | holding horizon | CLI |
| `ML_*` random seeds / timers | 42 | deterministic training | — |
| Treasury T-bill rate | live ^IRX | no hardcoded 0.04 fallback | live |
| OU kappa | 0.0 | dropped 25/40 overrides; the fee is now the EMPIRICAL expected \|T-day move\| (rolling realized \|ΔT\|, look-ahead-shifted) — mean-reversion aware by construction, no assumed constants (2026-08-11; see §9.10) | — |
| `DR_STALE_MAX_AGE_DAYS` | 130 | DR-momentum component goes dark when the last default-rate observation is older than ~2 quarters (DRCCLACBS is quarterly; measured stale 2026-01-01 → 2026-08) | — |
| `BOARD_SIGNAL_THRESHOLD_Z` | 1.5 | every board signal is a z-score; \|z\|≥1.5 = +1/-1 vote (no magic weights) | — |
| `BACKTEST_MIN_OBS` | 60 | minimum obs before a backtest leg reports a metric | — |
| `IV_Z_MIN_OBS` | 20 | IV-RV z-score gate ≈ 1 month of daily IV accrual (R4 history gate) | — |
| `COT_MIN_HISTORY_YEARS` | 2.0 | COT z-scores need ≥2y of weekly observations (R4) | — |
| `STALE_MAX_GAP_BDAYS` | 10 | daily series older than 10 business days flags STALE | — |
| COT cache TTL | 7 days | per-year fut_fin_txt download cached via `cache_json` | — |
| CFTC publication lag | 3 bdays | Tue report → Fri release; backtest signal shifted 3 bdays | — |
| `IV_MIN_REAL` | 0.02 | real-quote floor for credit-ETF ATM IV (calibrated 2026-08-10: worst real observation 0.039 — HYG 0.051/LQD 0.109/TLT 0.107/EMB 0.418/ANGL 0.389 — while a degraded yfinance feed served 1e-5..0.016; floor = >2x margin below the smallest real value; sub-floor quotes are not accrued, so history survives) | — |
| `ATLAS_RV_WINDOW` | 30 | heatmap spec §3.3 `RV_30d` convention (distinct from the 21-day GCO `REALIZED_VOL_LOOKBACK`; atlas equity leg only) | — |
| `DAYS_PER_YEAR` (atlas) | 365 | heatmap spec §3.3/§3.4 annualization formulas (straddle yield, basis carry) | — |
| index-futures DTE rule | CME third Friday | published CME expiry rule; pure calendar math in `engine.futures_layer` | — |
| `API_HOST` / `API_PORT` | 127.0.0.1 / 8000 | local API run config (spec §6), not calibration | CLI-less `api.server` |
|---------------------------|------------------|--------------------------------------------------|------------------------|
| `CACHE_TTL.FRED`          | 6h               | FRED daily close; 6h > one update cycle          | —                      |
| `CACHE_TTL.ECB`           | 12h              | ECB monthly dataflow                             | —                      |
| `CACHE_TTL.YAHOO_CHART`   | 2h               | Yahoo daily closes (intraday tolerance)          | —                      |
| `CACHE_TTL.YAHOO_ATMIV`   | 3h               | Option chains move intraday                      | —                      |

**Removed / dropped because they were unjustified placeholders**: OU kappa
25/40, static `0.04` risk-free, `STATIC_DEALER_MARKUP=1.00` fallback,
`INVESTMENT_CAPITAL` burying, NeuralCox torch.rand fake deal tables, mock
asset names, synthetic cash-flow/pd_curve arrays, all interactive
`input()` prompts.

## 7. How to run

```bash
cp .env.example .env   # paste FRED_API_KEY
source .venv/bin/activate
pip install -r requirements.txt   # brew install libomp on macOS
docker compose up -d              # local postgis (5432) + redis (6379) for the portal
psql "$DATABASE_URL" -f sql/heatmap_schema.sql   # once, if DATABASE_URL set in .env

python cli.py --market us --hold-days 5 --trade-size-m 50
python cli.py --market eu --percentile 90
python cli.py --market em
python cli.py --market ml
python cli.py --market global          # GCO board (free sources, gated)
python cli.py --market global --source cot,curve   # restrict board legs
python cli.py --market backtest        # OOS battery (no-look-ahead)
python cli.py --market atlas           # country map -> data/atlas.json (portal-ready)
python cli.py --market atlas --db      # + Postgres export (spec §4; DATABASE_URL set)
python -m api.server                   # FastAPI heatmap portal (spec §6; fastapi+uvicorn
                                       #   installed; serves /api/v1/heatmap GeoJSON
                                       #   + /api/v1/countries/{iso} drill-downs;
                                       #   Redis parse-cache active when REDIS_URL set)
python -m sources.probe                # daily IV-RV accrual + source truth
pytest tests/ -q
```

Web site (opportunity SPA, `web/`):

```bash
cd web
npm install
npm run seed          # regenerate public/data/bundle.json from data/atlas.json
                      #   + snapshot data/iv_history.json -> api/iv_history.json
                      #   + public/data/status.json (Signals page; re-run
                      #   automatically by scripts/accrue_iv_daily.sh)
npm run build         # vite build -> dist/
npm run serve         # node scripts/serve.mjs 8787 (dist + API handlers; loads
                      #   ../.env for the FRED key in local dev — Vercel injects
                      #   env vars in production). First run auto-populates
                      #   web/public/data/cache/** for all upstream series.
npm run dev           # vite dev server (proxies /api to 127.0.0.1:8787)
```

**Vercel Deployment** (production):
- **Root Directory**: `web` (Vite app lives in `web/`)
- **Framework Preset**: Vite
- **Build Command**: `npm run build`
- **Output Directory**: `dist`
- **Install Command**: `npm install`
- **Environment Variables** (Settings → Environment Variables):
  - Required: `FRED_API_KEY` (fred.stlouisfed.org → API Keys)
  - Optional free-tier: `FINRA_API_CLIENT_ID`, `FINRA_API_SECRET`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `NASDAQ_DATA_LINK_API_KEY`, `POLYGON_API_KEY`
  - NOT needed on Vercel: `DATABASE_URL`, `REDIS_URL` (local Docker only)
- **Serverless Runtime**: all `web/api/*.js` use `runtime: "nodejs"` (not `nodejs20`)
- **Auto-redeploy**: push to `master` triggers build; env var changes require manual redeploy

Every US/EU/EM volatility run now also prints **hold-horizon return curves**
(one line per item over hold days 1..21, solid = HF net, dashed = retail net,
legend + zero line; PNG `*_return_curves.png` next to the heatmaps) plus a
per-item table: net at the CLI hold AND the first hold day each series turns
non-negative.

Since 2026-08-11 each run emits the curves as **three separate views** —
`{region}_{tag}_{gross,hf_net,retail_net}_return_curves.png` (gross = Tier 1
payout, HF net = Tier 2, retail net = Tier 3; each view is its own
multi-line chart with a legend and zero line) and the summary table gains a
`gross@T` column. The EUR run additionally prints the **country panel**
(ECB LTIR 10Y yields per country, spread vs the Bund, 1M/3M/12M changes)
and country level/spread curves (`europe_country_{level,spread}_
{gross,hf_net,retail_net}_return_curves.png`, hold units = months — monthly
LTIR is the honest cadence for per-country yields).

PostgreSQL export (spec §4): `pip install "psycopg[binary]"`, start the
stack with `docker compose up -d`, put
`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/heatmap`
(and optionally `REDIS_URL=redis://127.0.0.1:6379/0`) in .env, apply the
schema once with `psql "$DATABASE_URL" -f sql/heatmap_schema.sql`, then
`--market atlas --db`. The docker daemon is not a launchd service: run
`open -a Docker` after a reboot before `docker compose up -d`.

## 8. Testing

`tests/` are pure-logic (no network): spread math, forecast stationarity
differencing, markup floor, revised prepared-data cast-path, secret
management (all-file source scan + env placeholder), the GCO board legs
(`tests/test_options_surface.py`: weekend-accrual alignment, z-gate,
no-look-ahead shift semantics, strategy-metrics gates, split-sample OOS
sign-fit), the keyed-source auth paths (`tests/test_keyed_sources.py`:
FINRA FIP OAuth2 token flow + Bearer, Alpaca APCA headers, no-key gating,
ECB URL split + csvdata parser), the heatmap-spec legs (`tests/test_atlas.py`:
straddle/basis/real-yield/term-spread formulas, CME third-Friday rule,
GeoJSON + DB-row builders), and the options real-quote gates
(`tests/test_yf_options_gates.py`: stub-IV rejection, same-day expiry skip,
straddle accrual, snapshot-preservation), the portal cache paths
(`tests/test_api_server.py`: file fallback, Redis hit/miss/stale/broken,
NaN sanitizer), the return-curve + distressed-premium regressions
(`tests/test_volatility.py`: exact-grade FA premium only, curve shape +
first-positive hold), and the walk-forward leg-validation gate
(`tests/test_board_validation.py`: VALIDATED/REJECTED/NOT_CONFIRMED/
UNVALIDATED matrix, JSON roundtrip), the tz-mismatch regression
(`test_session7_signals.py`:
mixed-aware dividend vs naive close alignment in the EM carry leg), the
EUR country-panel math + monthly-cadence machinery
(`tests/test_eur_country.py`: 1M/3M/12M changes, name coverage, three-view
consistency on monthly series), the secret-redaction regressions
(`tests/test_keyed_sources.py`: NDL/Polygon error paths never surface the
API key), and the IV-RV unlock proofs (`tests/test_options_surface.py`:
19/20 boundary flip + full end-to-end battery-leg run on a simulated
20+-day accrual — proves the leg works the moment it unlocks).
**149 tests**;
CI-free by design; run `pytest tests/ -q`.

## 9. Known gaps

1. ~~**dealer_markup.json provenance**~~ **RESOLVED 2026-08-09**: the
   committed constant-value series (4.189 repeating) has been overwritten by
   live MOVE/TNX regeneration on the US/EUR runs (values 1.10–1.24x,
   historical avg 1.17x). The generator (`engine.dealer_markup`) rewrites
   the file on every run.
2. **Backtest coverage (live runs 2026-08-09/10, FRED key active)**:
   CURVE leg (2s10s slope z vs forward 21d 10Y move) — hit_rate 0.459,
   rank IC -0.0836 (p≈0, n=6444): no sign-directional edge, but a
   significant contrarian relationship. CURVE-STRATEGY leg (slope-z
   mean-reversion, long ZN=F/short ZF=F, 1-day exec delay) — Sharpe 0.203,
   Sortino 0.278, maxDD -5.4%: weak edge. **OOS sign fit (2026-08-10):
   fitted sign +1 confirms the hypothesis sign (OOS Sharpe 0.221)**.
   COT leg — hit 0.467; COT-STRATEGY (lev-z on ZN=F) — Sharpe 0.116,
   maxDD -15%; **OOS sign fit flips to -1 (OOS Sharpe -0.57): the
   hypothesis sign is NOT confirmed walk-forward — reported as-is**.
3. ~~**ECB corporate keys**~~ **RESOLVED 2026-08-10**: the earlier
   "corporate" keys were wrong twice over: the URL construction
   (data/YC.B.U2... dotted form) 400'd, and the YC dataflow publishes
   GOVERNMENT curves only — every corporate key (C_N_*) returns 404. The
   module now builds data/YC/B.U2... URLs and serves the live government
   curves (G_N_A AAA 10Y, G_N_C all-ratings 10Y — 5603 obs, verified
   live). Euro corporate compensation remains on FRED BAMLHE00EHYIOAS +
   UCITS ETFs.
4. ~~**Dead endpoints**~~ **RESOLVED 2026-08-10**: BIS stats API
   (501/404 on all probe URLs) replaced by a keyless World Bank credit-gap
   proxy (FS.AST.PRVT.GD.ZS — domestic credit to private sector % of GDP,
   verified live, 5565 obs); US Debt Clock (404 on every variant) removed —
   Treasury Fiscal Data API debt_to_penny already covers it live. Both dead
   modules deleted (sources/bis.py, optional US-Debt-Clock + FMP loaders).
5. ~~**Forecast horizon fixed 12**~~ **RESOLVED 2026-08-10**: `--horizon`
   is now wired to `--market us` (forecast horizon), `--market backtest`
   (forward-window; default 21), and accepted by `--market global`
   (documented no-op: the board has no forecast leg).
6. **IV-RV accrual**: the options leg emits no signal until `IV_Z_MIN_OBS`
   (20) daily snapshots accrue. 2026-08-11: HYG/LQD/TLT/EMB at 3/20, JNK
   1/20, ANGL 2/20 (thin-chain expiry fallback; no straddle quote). Automation:
   `scripts/accrue_iv_daily.sh` + launchd plist
   (`scripts/com.publiccredit.iv-accrual.plist`, weekdays 18:00) — the
   accrual runs itself; the leg unlocks automatically at day 20.
   EMB ATM IV re-measured live 2026-08-11 at 0.1604 (was 0.4185 on the
   08-10 chain; expiry moved 08-14 → 08-21) — real single-chain value,
   ratio vs HYG now 4x (see §9.17).
7. **EUR yield display bug (session 9, RESOLVED 2026-08-10)**: the shared
   yield/carry tables printed bps values with a `%` suffix — EUR IG/HY
   ETF yields looked like "300%+". Fixed via `_format_yield_rows`
   (bps→percent display, correct carry units); internal bps convention
   untouched. Regression-tested.
8. ~~**yfinance stub-IV event**~~ **RESOLVED 2026-08-10 (this session)**: one
   evening the feed served whole credit-ETF chains at ~1e-5 implied vol (and
   degraded TLT/JNK at 0.016/0.004). Fixed live with `IV_MIN_REAL = 0.02`
   (see §6): the accrual now rejects sub-floor quotes (SourceUnavailable) so
   a bad snapshot can never overwrite the day's real one — verified with a
   regression battery (`tests/test_yf_options_gates.py`) plus a live event
   replay. Same-day (dte ≤ 1) expiries are skipped in the walk (degenerate
   chains). The authentic 2026-08-10 morning snapshots were restored to
   `data/iv_history.json` after the evening run clobbered them; the file is
    now clean (HYG 0.0513, LQD 0.1094, TLT 0.1074, EMB 0.4185, ANGL 0.3892).
9. ~~**APPETITE composite 0 obs**~~ **RESOLVED 2026-08-11**: root cause found —
   DRCCLACBS publishes on quarter-start dates (Jan/Apr/Jul/Oct 1st) and
   `asfreq("ME")` maps non-month-end timestamps to all-NaN, so the DR
   momentum column was empty and the concat `.dropna()` wiped the whole
   composite (0 obs). Fixed in `pipelines/backtest.py` (resample("MS") +
   ffill limit 21 so the composite honestly ends 1 month after the last DR
   observation — no frozen stale tail) and in `engine/credit_appetite.py`
   (native cadence + `DR_STALE_MAX_AGE_DAYS` staleness gate so the board
   component goes dark rather than voting on 7-month-old data). Live:
   APPETITE leg now reports 654 daily obs (fitted OOS sign −1, reported
   honestly); the board composite currently runs on OAS + breadth.
10. ~~**Fallen_Angel straddle fee model overshoot**~~ **RESOLVED 2026-08-11**:
    the fee is now the empirical expected |T-day move| (rolling realized
    |ΔT|, shifted so it is only knowable after the window — no look-ahead)
    instead of the raw-rolling-vol Bachelier term. Evidence that drove it:
    FA daily diffs carry AR(1) ≈ −0.32 (whipsaw): shock-day daily |Δ| = 18.3
    bps but realized |Δ5| = only 16.1 (iid prediction ≈ 41). The old fee
    (36.5–42.3) overpriced by ~2.3x; live after the fix: FA HF fee 14.2,
    net +1.4 (was −18.3). All HF nets positive (0.1–1.9), retail ≈ 0..+1.2.
    `calc_ou_straddle` retained as the analytic reference (unwired).
11. ~~**Negative fixed-period retail returns**~~ **RESOLVED 2026-08-11
    (session 14 audit)**: user-flagged negatives at 90th pct / T=5 were
    decomposed component-by-component: mechanics verified correct (fee =
    empirical |ΔT| shifted by T — no look-ahead; no double-count; windows
    aligned). The negatives were honest economics: IG edge 0.4–0.6 bps <
    dealer markup (~0.2) + friction (~0.5); HF nets positive via the PB size
    discount (~13.5% of fair cost). ONE real mechanics bug surfaced and
    fixed: `any(g in name for g in DISTRESSED_GRADES)` matched "B" inside
    "BB"/"BBB"/pair names, charging BB/BBB the 1.05 Fallen_Angel width
    premium — now exact membership `name in config.DISTRESSED_GRADES`
    (`engine/volatility.py` `_trade_cost_basis`). Live after fix: BB
    retail@5 +0.49 → +1.15, BBB −0.40 → −0.21, HF BB +1.91 → +2.50. Per the
    user's requirement, net is no longer a single fixed-period metric: every
    run prints hold-horizon return curves (hold days 1..21, HF solid /
    retail dashed, legend + zero line, PNG `*_return_curves.png`) with the
    first-positive hold per grade (FA/BB/CCC/B @T1, AA T10, A T7, BBB T9,
    AAA T13 retail; IG pair spreads stay honestly negative at every T).
12. ~~**Live-data bugs surfaced 2026-08-11**~~ **RESOLVED**: three real
    defects found and fixed during the session-14 verification sweep —
    (a) `pipelines/heatmap_db.py` used `execute(list)` under psycopg3
    ("query has 2 placeholders but 15 parameters") → `executemany` for both
    upserts; (b) a legacy NaN in `data/atlas.json` (`mom_21d`) 500'd
    `/api/v1/countries/{iso}` strict JSON → `engine/futures_layer.py` only
    sets `mom_21d` when finite + defensive `_clean_for_json` sanitizer in
    `api/server.py`; (c) `pipelines/global_credit.py` `_etf_fund_data`
    lambda captured the `yf.Ticker` object instead of the symbol string
    (`'Ticker' object has no attribute 'replace'` — em_carry board leg was
    permanently UNAVAILABLE) → lambda rebinds the symbol; EM-CARRY now live
    and VALIDATED (fitted +1, OOS Sharpe 0.060).
13. ~~**GCO sovereign leg dead (MM156N)**~~ **RESOLVED 2026-08-11**:
    `GLOBAL_SOVEREIGN_COUNTRIES` held suffix fragments ("USM"), so
    `fetch_global_sovereign` built `IRLTLT01USMM156N` and every country key
    400'd — the board's sovereign-debt leg had been silently UNAVAILABLE.
    The dict now holds full series IDs (`IRLTLT01USM156N` etc., all verified
    live) and the leg votes (KR LONG_DURATION).
14. ~~**API keys leaked in fetch-error logs**~~ **RESOLVED 2026-08-11**: the
    FRED key appeared in `data_engine.fetch_fred_series` error lines (the
    URL carries `api_key=`), and the polygon/NDL keys surfaced the same way
    in their SourceUnavailable messages. All three now scrub the literal
    (`.replace(key, "***")`); regression tests
    (`test_ndl_error_redacts_api_key`, `test_polygon_error_redacts_api_key`).
15. ~~**FINRA breadth column mismatch**~~ **RESOLVED 2026-08-11**: the live
    FINRA frame's date column is `tradeReportDate` — the appetite leg's
    date-column matcher missed it, so breadth_z was always None and the
    composite ran 1/2 components. Matcher now includes `tradereportdate`;
    appetite runs 2/2 (hy_oas_z + breadth_z) and abstains via the
    validation gate (APPETITE REJECTED, fitted −1, OOS Sharpe −0.198).
16. ~~**Series-index anchor in the cost basis**~~ **RESOLVED 2026-08-11**:
    `_trade_cost_basis` components were indexed on the retail-markup index
    (the DE long history); a shorter series (ECB LTIR country with a later
    start) misaligned every boolean indexer ("Unalignable boolean Series").
    All components are now reindexed to the series' own index — the US
    daily path is unaffected (shared index), the monthly country path works.
17. **EMB ATM IV re-check (open item 3.1)** — RESOLVED 2026-08-11 by live
    measurement: EMB ATM IV 0.1604 (was 0.4185 on the 2026-08-10 chain;
    expiry moved 08-14 → 08-21, IV fell) vs HYG 0.0400 — the ratio is now
    4x, not 8x. Single-chain values on a real (degraded-free) feed; the
    accrual gate stays.
18. ~~**FRED CSV endpoint dead (web API layer)**~~ **RESOLVED 2026-08-12**:
    `api.stlouisfed.org/fredgraph.csv` now 404s on every form (0 redirects;
    verified live for DGS10, BAMLC0A1CAAA, IRLTLT01DEM156N). The web layer
    was ported to the keyed `fred/series/observations` JSON API
    (`web/api/_shared.js` `fredCsv` — verified streaming live).
    **Python engine verified 2026-08-12 (session 18) — no port needed**:
    `config.FRED_BASE_URL` already targets the JSON endpoint and
    `engine/data_engine.py` `fetch_fred_series` builds the JSON URL; zero
    `fredgraph` references in the Python tree. Live proof: 6-series fetch
    + `--market global --source curve|sovereign` board runs (CURVE
    VALIDATED, sovereign RISING_DEBT rows).
19. ~~**Basemap: Taiwan inside China's polygon + no Hong Kong feature**~~
    **RESOLVED 2026-08-18**: a deep inspection of the vendored echarts
    basemap found the China feature still CONTAINED a 10-vertex Taiwan
    polygon (poly 14) — the standalone Taiwan feature added 2026-08-18
    rendered on top of it — plus an empty degenerate polygon (12) and the
    Hong Kong landmass split across two small polygons (10/11, matched
    exactly to Natural Earth 50m "Hong Kong S.A.R." bboxes). The China
    MultiPolygon was trimmed to its mainland + real islands (11 polys,
    byte-identical remainder), Hong Kong became its own feature, and the
    Taiwan duplicate was dropped so the standalone feature stands alone.
    Verified: all untouched features byte-identical; map renders Taiwan and
    Hong Kong as separate regions from China.

## 10. Pending items (yet to be done)

1. ~~**ECB `C_N_T` live verification**~~ **RESOLVED 2026-08-10**: the
   corporate keys never existed in the YC dataflow; replaced by the live
   government curves (see §9.3).
2. ~~**FINRA / Alpaca keys**~~ **RESOLVED 2026-08-10**: both sources are
   LIVE with the credentials in `.env` (probe: FINRA breadth 3064 obs via
   the FIP OAuth2 token flow + real dataset names; Alpaca SGOV quote via
   symbol — the CUSIP lookup was the bug). FMP was REMOVED: its key
   returned 403 on every endpoint and the enrichment was non-load-bearing.
3. **IV-RV signal** — auto-unlocks at 20 accrued days (3/20 as of
   2026-08-11; session-18 re-verify 2026-08-12: HYG/LQD/TLT/EMB 3, ANGL 2,
   JNK 1 — last real snapshots 08-11; the 08-12 midday feed served stub
   IVs 1e-05..0.008 and the `IV_MIN_REAL` gate rejected every snapshot,
   history untouched — gate working live);
   `scripts/accrue_iv_daily.sh` (+ launchd) accrues automatically.
   EMB ATM IV re-checked live 2026-08-11: 0.1604 (see §9.17).
4. ~~**BIS credit gap + US Debt Clock**~~ **RESOLVED 2026-08-10**: World
   Bank credit-gap proxy replaces BIS; US Debt Clock dropped (Treasury
   debt_to_penny already live).
18. ~~**Public web site (opportunity SPA)**~~ **DONE 2026-08-12 (session 17)**:
   Vite + ECharts SPA + Vercel-compatible API layer in `web/` (map / returns
   / history / country pages, seed-bundle fallback, vendored world.json).
   Live findings fixed in the layer: FRED CSV endpoint decommission →
   JSON observations API (§4); ECB csvdata header-driven parse; `angRows`
   typo. Run + verify per §7. Python engine FRED CSV port is §9.18.
5. ~~**`--horizon` not wired**~~ **RESOLVED 2026-08-10**: wired to
   us/backtest; forecast sensitivity h=6/24 now parameterized via
   `--horizon 6|24` on `--market us`.
6. ~~**Strategy-leg sign caveat**~~ **RESOLVED 2026-08-10**:
   `backtest.sign_fit_oos()` performs a genuine walk-forward split-sample
   sign fit on both strategy legs; results are printed alongside the
   hypothesis sign (CURVE confirmed +1; COT rejected → -1).
7. ~~**Board label semantics**~~ **RESOLVED 2026-08-10**: the curve leg
   now labels the POSITION the board implies (LONG_FLATTENER when the
   state is steep z>0, LONG_STEEPENER when flat z<0), with the z-state in
   the detail line.
8. ~~**ANGL/EMHY options chains**~~ **PARTIAL 2026-08-10**: ANGL fixed via
   an expiry-walk fallback in `yf_options.snapshot_ticker` (nearest expiry
   had an empty call chain; the next one resolved — ANGL now accrues, 1/20
   days). EMHY has NO listed expiries at all — a genuine thin-market fact;
   it stays honestly UNAVAILABLE until the exchange lists chains.
9. ~~**US pipeline display wart**~~ **RESOLVED 2026-08-10**:
   `print_spread_table` now prints the actual latest observation date
   instead of the trailing dict.
10. **COT BBG IG/HY credit futures legs** — genuine data-existence
     constraint: the Bloomberg IG/HY credit futures contracts only began
     listing in 2026-03 (HY) / 2026-05 (IG), so the ≥2y history gate is
     correctly UNAVAILABLE until ~2028. No code change can accelerate real
     history; the board reports the gate honestly (auto-unlocks as the
     weekly reports accrue).
11. ~~**Heatmap spec legs**~~ **RESOLVED 2026-08-10 (this session)**:
     straddle yield (spec §3.3), index-futures basis (spec §3.4), real yield
     (spec §3.1, US-only), per-country term structure (US FRED 2/5/10/30,
     euro-area ECB 1Y-30Y AAA), RV_30d per country ETF, GeoJSON + DB-row
     serializers, sql schema + gated Postgres export + FastAPI portal —
     all live-verified (see LEDGER Session 11); per-country IV/straddle/
     VRP stays honestly UNAVAILABLE outside the US (no country-ETF chain
     accrual exists; the US credit-ETF legs carry the real values).
12. ~~**Straddle-yield accrual**~~ **RESOLVED 2026-08-11**: the first REAL
    ATM-straddle snapshots landed (`atm_straddle_price` + `dte_days` in
    iv_history: HYG 0.22/DTE3, LQD 0.57, TLT 0.75, EMB 1.36/DTE10, JNK
    1.17/DTE10) and the atlas options section now shows
    `straddle_yield_ann` live (HYG 0.0305, LQD 0.0593, TLT 0.1005, EMB
    0.0866, JNK 0.0738). ANGL's thin chain has no straddle quote — reported
    honestly (None).
13. ~~**Optional portal plumbing**~~ **DONE 2026-08-11**: the stack is
    dockerized — `docker-compose.yml` runs postgis (publiccredit-postgres,
    5432) + redis (publiccredit-redis, 6379); `DATABASE_URL` and `REDIS_URL`
    are in `.env` and documented in `.env.example`; `psycopg[binary]`,
    fastapi, uvicorn, redis all installed in .venv; schema applied;
    `--market atlas --db` verified writing 15+15 rows. (d) 2026-08-10 probe
    statuses observed as-is: NDL 403 and Polygon 400/429 on this client's
    free tiers, BCB Selic 502 once (transient) and World Bank 400 once
    (transient — 3/3 retries OK, 5565 obs) — all non-load-bearing, reported
    honestly by the probe.
14. ~~**Fallen_Angel fee-model calibration + pair netting + friction**~~
    **RESOLVED 2026-08-11** (see §9.10): the straddle fee is now the
    empirical expected |T-day move| (`get_empirical_move_fee`,
    look-ahead-shifted rolling realized |ΔT|) — mean-reversion aware with no
    assumed constants; pair-mode retail pays ONE netted straddle on the pair
    series instead of the sum of both legs; `FRICTION_BASE_SPREAD_BPS` halved
    to 0.5. Live (90th pct, HF net, bps): CCC +1.8 / BB +1.9 / B +1.4 /
    Fallen_Angel +1.4 (was −18.3) / A +0.2 / BBB +0.1 / AA +0.3 / AAA +0.1;
    retail ≈ −0.4..+1.2. Full evidence in `open_items.md` §5.
15. ~~**Broker-premium overshoot**~~ **RESOLVED 2026-08-11**: dealer markup
    was charged at the full IV/RV ratio (avg 1.174, max 1.816) plus a
    FALLEN_ANGEL 1.20 — post-premium nets clustered negative everywhere.
    Lightened: `DEALER_MARKUP_PREMIUM_SHARE = 0.3` (dealer comp = 30% of the
    IV−RV premium) and FA 1.20 → 1.05. Live effect (90th pct, HF net, bps):
    −0.5..−27.0 → CCC +1.9 / BB +0.6 / B +0.3 / A +0.2 / BBB +0.1 / AA −0.1 /
    AAA −0.3; retail −0.2..−1.6 (friction-bound); FA −18.3 (fee model,
    §9.10). Full evidence in `open_items.md` §5.
16. **IV-RV backtest battery leg** — BUILT 2026-08-11 (`_bt_ivrv` in
    pipelines/backtest.py, gated on `IV_Z_MIN_OBS` via the new
    `options_surface.premium_z_series` walk-forward z): reports honestly
    "2/20 accrued" today; auto-unlocks as the launchd accrual fills history.
17. ~~**Board vote semantics (Q1)**~~ **RESOLVED 2026-08-11**: legs vote
    ONLY with demonstrated edge — the battery persists each strategy leg's
    fitted sign + OOS Sharpe to `data/backtest_legs.json`
    (`backtest.persist_leg_validation`, hypothesis_sign=1); the board
    `_gate_leg` abstains with `[SKIP] walk-forward battery rejected —
    fitted sign X (hypothesis +1), OOS Sharpe Y; no demonstrated edge, vote
    withheld` when fitted sign ≠ hypothesis (REJECTED) or OOS Sharpe ≤ 0
    (NOT_CONFIRMED); UNVALIDATED legs vote but carry the validation label in
    the detail line. Live: COT-STRATEGY REJECTED (fitted −1, Sharpe −0.574)
    → all 6 COT rows abstain; REAL-RATES VALIDATED (+1, 0.737) → votes
    LONG_TIPS; CURVE VALIDATED (+1, 0.215); APPETITE REJECTED (−1, −0.198);
    EM-CARRY VALIDATED (+1, 0.060) (lambda bug fixed, see §9.12c).

## 11. Session script

1. Read this file.
2. Re-run `git status`-style cleanliness (`rg` scan for embedded keys in
   active source).
3. If changing numeric constants: update this audit log table simultaneously.
4. Never reintroduce private-credit or placeholder logic; if a test fails,
   treat it as a bug, not as an excuse to silence the test.
5. Append every change (what, why, verification) to `LEDGER.md` so the full
   execution history stays in one auditable file.
6. Update `open_items.md` after EVERY run / live verification / code change
   (same pass, same edit): any new finding, fix, build, or completion lands
   in its status board (§1 bugs / §2 to build / §3 to complete / §4 queued)
   with date + evidence, so the registry always reflects the last run —
   never a summary older than the current state.

## 12. Instruction record-keeping protocol (every session, mandatory)

Every user instruction and its execution must be traceable. Two documents
own the record; nothing is recorded anywhere else:

**LEDGER.md — the "instructed vs followed" ledger.** Each session gets:
1. `### What was instructed` — the user's ask, paraphrased faithfully and
   dated (quotation only for short, decision-critical phrasing).
2. `### What was followed` — the executed work, mapped 1:1 to the numbered
   instruction points (e.g. "Instr. 2 → pipeline built"; "Instr. 3 → NOT
   split: [reason]"). Every instruction point is explicitly marked
   FOLLOWED / NOT FOLLOWED or PARTIAL, never silently omitted.
3. `### Verification` — tests, live runs, and the exact commands.
4. `### Docs touched` — which of CONTEXT.md sections changed and why.

**CONTEXT.md — the "where it fits" spec.** Instruction outcomes are mapped
to the section they belong in:

| Instruction concerns… | Recorded in |
|---|---|
| Calibrated constants / thresholds | §6 audit log (update table in the same edit) |
| Data sources, endpoints, series keys, availability facts | §4 |
| Architecture / module responsibilities / data flow | §3 |
| What the system is/not, scope boundary | §2 |
| Run instructions, CLI flags | §7 |
| Known gaps (real, unresolved) | §9 (strike through when resolved) |
| Open items registry: bugs, builds, completions, queue (status board) | open_items.md (updated after every run per §11.6) |
| Pending work | §10 (strike through when done) |
| Execution history, bugs, decisions, verification | LEDGER.md |
| Secrets handling, scan status | §5 |

Rules:
- An instruction that lands nowhere is a bug in the protocol — flag it.
- A gap discovered while executing becomes a §9 entry in the same session.
- "Done" claims must carry the evidence (test name / command) in LEDGER.md.
- Append-only: never rewrite history in LEDGER.md; corrections are new
  entries, not edits to old ones.