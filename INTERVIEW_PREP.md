# Public Credit Opportunity Engine — Interview Preparation Document

This document explains the **Public Credit Opportunity Engine** project in basic terms. Everything complex is defined before use. You can read this to prepare for an interview about what the project does, how it works, and what you contributed.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture & Data Flow](#2-architecture--data-flow)
3. [Data Sources](#3-data-sources)
4. [Core Features Explained](#4-core-features-explained)
5. [Complex Terms Dictionary](#5-complex-terms-dictionary)
6. [What You Did (Contributions)](#6-what-you-did-contributions)
7. [Libraries & Math Used](#7-libraries--math-used)
8. [Future Projections Methodology](#8-future-projections-methodology)
9. [Web Portal & API Layer](#9-web-portal--api-layer)
10. [Quick Soundbites for Interview](#10-quick-soundbites-for-interview)

---

## 1. Project Overview

**What it is:** A modular Python system that evaluates and surfaces opportunities in **public debt markets** (government bonds, corporate bonds, ETFs traded on exchanges).

**The core question it answers:** *"Where is compensation in public credit markets right now, and what is the expected payoff of trading volatility in those segments?"*

**Who it's for:** Institutional investors (hedge funds, asset managers) and curious individuals who want to understand credit markets.

**Key distinction:** This is **NOT** about private credit (no deal-level cash flows, no IRR/NAV, no synthetic deal data).

---

## 2. Architecture & Data Flow

Think of this as an assembly line with 3 stages:

```
Stage 1: Data In → FRED API + Yahoo Finance + ECB + CFTC + World Bank
         ↓
Stage 2: Engine → Spreads, default rates, forecasts, volatility models
         ↓
Stage 3: Output → Heatmaps, returns pages, CLI tools, API portal
```

**The data flow for US markets specifically:**

1. **FRED API** (Federal Reserve Economic Data) → Gives us US Treasury yields, corporate bond spreads, default rates
2. **Yahoo Finance** → Gives us ETF prices (ANGL, HYG, LQD, EMB, etc.), options/IV data, FX rates
3. **ECB Data Portal** → Gives us Euro-area government bond yields
4. **CFTC COT** → Gives us trader positioning data (are dealers long or short?)
5. **World Bank** → Gives us sovereign debt metrics per country

**The data flow for the web portal (GCO - Global Credit Opportunity):**
- Probes 16 free data sources
- Gates each source (is the data real or unavailable?)
- Board of "legs" (COT positioning, options premium, yield curve, sovereign debt trend, FX overlay)
- Each leg votes YES/NO (threshold only, no magic weights)
- Board decision requires demonstrated edge (walk-forward sign fit + OOS Sharpe > 0)
- Backtest battery validates each leg

---

## 3. Data Sources

Here are all the data sources the project uses, grouped by type:

### Free (no key needed)
- **FRED** (Federal Reserve Economic Data): ICE BofA yield spreads per grade, Treasury yields, default rates, OECD long-term rates per country
  - *Key series:* `BAMLC0A*IG` (investment grade spreads), `BAMLH0A*HY` (high yield spreads), `DRBLACBS` (default rates), `DGS10` (10Y Treasury), `IRLTLT01DEM156N` (German Bund 10Y)
  - *Python already uses JSON API (not the old CSV form that decommissioned in 2026)*

- **ECB Data Portal**: Euro-area government bond yields (AAA rated), long-term interest rates per country
  - *URL format:* `data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y` (government only, no corporates)
  - *Per-country:* `IRS/M.{CC}.L.L40.CI.0000.EUR.N.Z` (monthly, ~35y history)

- **yfinance** (Yahoo Finance): ETF prices, options chains, FX rates, Treasury bill rates
  - *ETFs used:* ANGL (fallen angels), HYG/LQD/TLT (investment grade), EMB/CEMB (EM), EUR UCITS (IEAC.L, IHYG.L)
  - *FX crosses:* USD/CCY for all major currencies
  - *Treasury:* `^IRX` (13-week T-bill)

- **CFTC COT** (Commitments of Traders): Trader positioning data for UST futures and credit futures
  - *Files:* `fut_fin_txt_{year}.zip` → net leveraged-money / dealer z-scores
  - *Legs:* 2Y/5Y/10Y UST, BBG IG/HY credit futures (≥2y history gate)

- **World Bank**: External debt stocks, service ratios, debt-to-GNI, domestic credit to private sector (% of GDP)
  - *Used for:* Sovereign credit-gap proxy (5565+ observations)

- **FINRA TRACE**: Corporate bond market breadth, capped volume data
  - *Auth:* FIP OAuth2 client-credentials flow (token POST → `ews.fip.finra.org`)

### Optional/Keyed (require signup)
- **Alpaca**: SGOV 0-3-month T-bill ETF last-trade quote
- **FMP**: Removed (key returned 403 everywhere)
- **Nasdaq Data Link + Polygon**: Exist in `.env` but not load-bearing

**Each source has a "probe" that tests if data is available, and reports `UNAVAILABLE` if not.**

---

## 4. Core Features Explained

### 4.1 Spreads (Yield Spreads)
**What:** The difference between a bond's yield and a "risk-free" benchmark yield.

**Simple example:** If a US corporate bond yields 6% and a 10Y Treasury yields 4.5%, the spread is **150 basis points (bps)** = 1.5%.

**Why it matters:** Wider spreads = higher compensation for taking credit risk. Narrowing spreads = prices rising.

**In the code:** `engine/spreads.py` fetches ICE BofA option-adjusted spreads per grade (AAA through CCC) from FRED.

### 4.2 Default Rates & Expected Loss
**What:** How often issuers default (fail to pay), and how much loss investors suffer.

**LGD (Loss Given Default):** If a bond defaults, how much money do you lose? (e.g., 50% LGD = you lose half your investment).

**Expected Loss = Probability of Default × Loss Given Default**

**In the code:** `engine/default_rates.py` uses FRED default rate series (`DRBLACBS`, `DRCCLACBS`) and Moody's/S&P LGD studies by grade. Values stored in `data/expected_loss_by_grade.json`.

### 4.3 Term-Structure Shifts (VAR/VECM & Johansen Cointegration)
**What:** Modeling how yields change over time (the "term structure" or yield curve).

**VAR (Vector Autoregression):** A model where each variable is predicted by its own lags AND other variables' lags. Like a multivariate ARIMA.

**VECM (Vector Error Correction Model):** Like VAR but cointegrated — meaning variables move together long-term even if they deviate short-term.

**Johansen test:** A statistical test for cointegration. Does the yield curve have a stable long-run relationship?

**In the code:** `engine/forecast.py` uses Johansen-augmented VAR/VECM to forecast yield changes. `pure_yield_forecast.py` forecasts pure bond yields (basis points).

### 4.4 Volatility Spectrum (Straddle Pricing, GARCH)
**What:** Modeling how much prices move (volatility) and pricing straddles (bets on big moves).

**Straddle:** Buy both a call and put at the same strike. Profits if price moves significantly in EITHER direction.

**The "fee" (straddle cost):** Not theoretical — **empirical**. Based on what the market ACTUALLY moved on days that "looked like" the current regime (shock vs. calm).

**Why empirical?** Fallen Angel spreads have strong mean-reversion (autocorrelation ≈ −0.32). On a shock day, the 1-day move might be 18 bps, but the 5-day move is only 16 bps — the whipsaw reverses. A theoretical formula would predict ~41 bps. The empirical fee captures the whipsaw and avoids overpricing by 2.3×.

**GARCH:** Generalized Autoregressive Conditional Heteroskedasticity. A model for volatility that clusters (volatility tends to follow volatility).

**In the code:** `engine/volatility.py` — straddle pricing, empirical |T-day move| fee, GARCH, shock vs. normal P&L. Three views: **Gross** (no costs), **HF Net** (hedge fund discount), **Retail Net** (individual investor).

### 4.5 ML Credit Scorecard
**What:** Machine learning model that scores credits (bonds/ETFs) based on fundamentals.

**Ensemble stack:** XGBoost + LightGBM + CatBoost (three models, combined).

**Features (inputs):** ETF OHLCV prices + FRED macro anchors (yield curve, default rates, spreads) → engineered ratios.

**Output:** Credit score + SHAP explanations (which features drive the score).

**In the code:** `engine/ml_engine.py` — ETF super-learner + SHAP + anomaly gate.

### 4.6 Atlas / Country Heatmap
**What:** A world map colored by "heat" — a 1-month total return estimate in USD for each country.

**How heat is calculated:** Simple average of available pieces:
- **Bond:** FRED OECD 10Y gov yield → price change from 1-month yield change
- **Equity:** Yahoo US-listed ETF (e.g., EWZ for Brazil) → 1-month % change (currency already included)
- **Credit:** FRED ICE BofA regional EM corporate index → carry proxy
- **Fallen Angel:** ANGL/EM1A.DE/GFA.L ETFs → distressed credit segment
- **FX only:** Used ONLY when NO bond yield AND NO ETF

**Double-counting avoided:** If a country has a bond leg, we don't add a separate currency leg. Every country's `heatBasis` field tells you exactly which pieces went into its number.

**Three versions of the same trade (costs differ):**
- **Gross:** Theoretical, no costs
- **HF Net:** Hedge fund/prime broker client → dealer markup minus volume discount
- **Retail Net:** Individual investor → full dealer markup plus friction

### 4.7 Board / GCO (Global Credit Opportunity)
**What:** A conviction board that assembles opinions from free data sources.

**How it works:**
1. Probe 16 free sources → gate each (available/unavailable + fix)
2. Board legs: COT positioning z, options IV-RV premium z, 2s10s curve z, sovereign debt trend, FX overlay
3. Each leg votes ONLY with demonstrated edge (fitted sign + OOS Sharpe from walk-forward battery)
4. Threshold: |z| ≥ 1.5 = +1/-1 vote (no magic weights)
5. Board report: which legs validated, which rejected, which abstained

**Key principle:** "Threshold-only agreement — no magic weights. Every signal is a z-score."

### 4.8 Backtest / Walk-Forward
**What:** Out-of-sample validation. Does the strategy work on data the model hasn't seen?

**Walk-forward:** Split data → train on first part → test on second part → repeat rolling forward.

**Metrics:** Hit rate, Information Coefficient (IC), Sharpe ratio, Sortino ratio, Max drawdown.

**In the code:** `pipelines/backtest.py` — walk-forward OOS battery (CURVE/COT/strategies). Leg validation stored in `data/backtest_legs.json`.

---

## 5. Complex Terms Dictionary

Here are all complex terms defined before use. You should be able to explain these in basic terms.

| Term | Definition (basic) |
|------|---------------------|
| **Basis points (bps)** | 1/100 of 1%. 100 bps = 1%. Used for small interest rate/price changes. |
| **LGD (Loss Given Default)** | Percentage lost if a bond defaults. 50% LGD = lose half your money. |
| **OAS (Option-Adjusted Spread)** | Spread on a bond that has options embedded (callable, putable). Removes the option effect. |
| **HY (High Yield)** | "Junk bonds." Bonds with lower credit ratings (BB, B, CCC). Higher yield, higher default risk. |
| **IG (Investment Grade)** | Bonds with higher credit ratings (AAA, AA, A, BBB). Lower yield, lower default risk. |
| **Z-score** | How many standard deviations something is from average. |z| ≥ 1.5 = unusually high/low. |
| **VAR (Vector Autoregression)** | A statistical model that predicts each variable using its own past values AND other variables' past values. |
| **VECM (Vector Error Correction Model)** | Like VAR, but variables that cointegrate (move together long-term) are adjusted for that long-run relationship. |
| **Cointegration** | Two variables that move together over time, even if they deviate short-term. Like two runners staying side-by-side in a race. |
| **Johansen test** | A statistical test to check if variables are cointegrated. |
| **GARCH** | A model that says "volatility follows volatility." When volatility is high today, it's likely high tomorrow too. |
| **Straddle** | Buying a call AND put at the same strike. Profits if price moves a lot in EITHER direction. |
| **Liquid** | Can buy/sell easily without moving the price much. High trading volume. |
| **UNAVAILABLE** | Data source reports no data available. Code handles this gracefully. |
| **Walk-forward** | Re-training a model rolling forward through time, like a moving window. |
| **Sharpe ratio** | Risk-adjusted return. (Return - risk-free) / volatility. Higher = better. |
| **Sortino ratio** | Like Sharpe but only penalizes downside volatility, not all volatility. |
| **Maximum drawdown** | Largest peak-to-trough decline in portfolio value. |
| **Information Coefficient (IC)** | Correlation between predicted and actual returns. Positive = skillful predictions. |
| **Notional** | The "paper" amount you're trading with. $100k notional = acting as if you're trading $100,000. |
| **Duration** | How sensitive a bond's price is to interest rate changes. 8.5-year duration = if rates rise 1%, bond price falls ~8.5%. |
| **OAS change in bps** | Change in option-adjusted spread, in basis points. Used for carry proxy. |
| **Notional USD** | Display/trading notional amount (default $100,000, CLI-overridable). |
| **Trade size M** | Trade size in millions of dollars (default $50M, CLI-overridable). |
| **Hold days** | How long you hold the trade (default 5 days, CLI-overridable). |
| **Friction** | Execution cost for moving the market when you trade. Only kicks in top 10% volatility. |
| **Dealer markup** | What the dealer charges on top of fair price. Based on MOVE/TNX (Treasury volatility index). |
| **PB discount** | Hedge fund gets a discount vs retail. Base 5% + volume discount (log10 trade size × 5%) - illiquidity penalty. |
| **FALLEN_ANGEL_LIQUIDITY_PREMIUM** | 5% extra dealer width for exact grade names "B", "CCC", "Fallen_Angel" (NOT substrings "BB"/"BBB"). |
| **IV (Implied Volatility)** | Market's expectation of future volatility, from options prices. |
| **RV (Realized Volatility)** | Actual historical volatility measured from past price moves. |
| **IV-RV z-score** | (IV - RV) / stddev. Signals when options are expensive (IV > RV) or cheap (IV < RV). |
| **Straddle yield ann** | Annualized straddle price as a yield (premium / spot price). |
| **DTE (Days to Expiry)** | How many days until an options contract expires. |
| **ATM (At-The-Money)** | Option strike price ≈ current underlying price. |
| **GeoJSON** | A format for encoding geographic data structures. |
| **PostGIS** | Spatial database extender for PostgreSQL (adds geometry types). |
| **psycopg** | PostgreSQL driver for Python. |
| **executemany** | SQL command to execute the same query against multiple parameter sets efficiently. |
| **NaN (Not a Number)** | Missing/undefined value. The code sanitizes these so APIs don't crash. |
| **Redis** | In-memory data structure store, used as parse-cache for the API portal. |
| **DATABASE_URL** | Connection string for PostgreSQL database (e.g., `postgresql://postgres:postgres@127.0.0.1:5432/heatmap`). |
| **REDIS_URL** | Connection string for Redis (e.g., `redis://127.0.0.1:6379/0`). |
| **DTE rule (CME third Friday)** | Equity index futures expire on the third Friday of the month (CME rule). |
| **Basemap** | The background map (vendored echarts@4.9.0) that countries are drawn on. |
| **Natural Earth** | Public domain map dataset at 50m resolution used for basemap geometries. |
| **Source gate** | Each data source is "gated" — checked for real data, and if unavailable, reported honestly. |
| **IV_MIN_REAL** | Floor for implied volatility: 0.02 (2%). Sub-floor quotes (e.g., 1e-5) are rejected. |
| **STALE_MAX_GAP_BDAILIES** | Daily series older than 10 business days flags STALE. |
| **COT_MIN_HISTORY_YEARS** | COT z-scores need ≥2y of weekly observations (R4 history gate). |
| **DR_STALE_MAX_AGE_DAYS** | Default rate momentum component goes dark when last observation >130 days old. |
| **APPETITE composite** | Combined OAS + breadth signal. Was 0 obs (bug: DRCCLACBS quarterly → asfreq("ME") = all-NaN). Fixed with resample("MS") + ffill. |
| **Friction percentile 90** | Friction (execution cost) only activates when vol is above 90th percentile of recent history. |
| **GCO board vote** | Each leg votes only with demonstrated edge (fitted sign + OOS Sharpe > 0). Abdications reported honestly. |
| **Leg validation status** | VALIDATED (fitted sign matches hypothesis + OOS Sharpe > 0), REJECTED (fitted sign ≠ hypothesis), NOT_CONFIRMED (OOS Sharpe ≤ 0), UNVALIDATED (leg voted but carries label). |

---

## 6. What You Did (Contributions)

Here's a summary of your key contributions to the project:

### 6.1 UI Fixes (Web Layer)
- **Removed purple logo/brand name** from the top corner of the web app (`web/index.html`, `web/src/theme.css`)
- **Updated timestamp** to show Los Angeles Pacific Time with automatic PDT/PST handling using `Intl.DateTimeFormat(timeZone: "America/Los_Angeles")`
- **Fixed "last updated" timestamp** to read from static `bundle.json` generated date (2026-08-18), not generate fresh timestamps via `new Date()`
- **Added "Data updated (Pacific Time)"** stamp label

### 6.2 Accessible Methodology Documentation
- **Rewrote CONTEXT.md §3.5** with gradual, middle/high school-level explanations of:
  - Heat metric (total return in USD, not credit spread)
  - Three versions of trading costs (Gross/HF Net/Retail Net)
  - Dealer markup formulas (MOVE/TNX based, premium share 0.3, floor 1.05)
  - Straddle fee (empirical |T-day move|, not theoretical Black-Scholes)
  - Pair netting (retail pays ONE netted straddle on pair series)

### 6.3 Fallen Angel ETF Straddles (Returns Page)
- **Added ANGL** (VanEck Fallen Angel HY Bond ETF, US) to US market volatility strategy book
- **Added EM1A.DE** (VanEck EM1A.DE, EUR-quoted UCITS) to Countries market volatility strategy book
- Both now appear as tradable straddles with Gross/HF/Retail net return curves
- Handled EM1ADE's short history by fitting separate daily-frequency VAR (only 36 monthly obs vs 60+ required for joint sovereign VAR)
- Verified via Playwright: US market shows `ANGL — Fallen angels — VanEck ANGL`, Countries market shows `EM1ADE — Fallen angels — VanEck EM1A.DE`

### 6.4 Code Bug Fixes
- **Fixed `_trade_cost_basis` series alignment** — all components now reindexed to the series' own index (not retail-markup index)
- **Fixed fallen angel premium** — changed from substring match (`any(g in name for g in DISTRESSED_GRADES)`) to exact membership (`name in config.DISTRESSED_GRADES`), preventing BB/BBB from being charged the 1.05 premium
- **Fixed dealer markup** — lightened premium share from 1.0 (100%) to 0.3 (30%), and FA premium from 1.20 to 1.05, preventing negative nets everywhere
- **Fixed FRED CSV endpoint** — web API layer ported from decommissioned `api.stlouisfed.org/fredgraph.csv` to JSON observations API
- **Fixed ECB URL** — changed from `data/YC.B.U2...` (400s) to `data/YC/B.U2...` (live)
- **Fixed atlas NaN serialization** — defensive `_clean_for_json` sanitizer in `api/server.py`
- **Fixed global credit `_etf_fund_data` lambda** — captured symbol string instead of Ticker object (EM-CARRY was permanently UNAVAILABLE)
- **Fixed heatmap_db.py** — `execute(list)` → `executemany` under psycopg3 (15 parameters vs 2 placeholders)
- **Fixed FINRA breadth column matcher** — added `tradereportdate` alongside existing matcher
- **Fixed APPETITE composite** — DRCCLACBS quarterly → resample("MS") + ffill limit 21 (was 0 obs due to all-NaN mapping)
- **Fixed stub-IV rejection** — `IV_MIN_REAL = 0.02` gates reject sub-floor quotes from degraded yfinance feed

### 6.5 Testing
- **149 pure-logic unit tests** (no network required) covering: spread math, forecast stationarity, markup floors, data casts, secret management, GCO board legs, keyed-source auth, atlas formulas, options gates, API server cache, return-curve regressions, board validation, tz-mismatch regression, EUR country-panel math, secret redaction, IV-RV unlock proofs, walk-forward leg-validation gate

---

## 7. Libraries & Math Used (Superficial Overview)

### Python Libraries
| Library | Purpose (one line) |
|---------|---------------------|
| `pandas` | Data manipulation, time series, DataFrames |
| `numpy` | Numerical operations, arrays |
| `scipy` | Statistical tests, distributions |
| `statsmodels` | VAR/VECM models, cointegration (Johansen), GARCH |
| `yfinance` | Yahoo Finance API, ETF/options data |
| `fredapi` / `requests` | FRED API client |
| `xgboost` | Gradient boosting model (ML scorecard) |
| `lightgbm` | Gradient boosting model (ML scorecard) |
| `catboost` | Gradient boosting model (ML scorecard) |
| `shap` | Explainable AI — feature importance |
| `playwright` | Browser automation (tests) |
| `pytest` | Test runner (149 tests) |
| `fastapi` + `uvicorn` | Web API server (portal) |
| `psycopg` | PostgreSQL driver |
| `redis` | In-memory cache |
| `docker` | Postgres + Redis local stack |
| `matplotlib` / `seaborn` | Plotting (return curves, heatmaps) |
| `charts.js` / `ECharts` | Frontend map visualizations |

### Math / Statistical Concepts (used, not invented)
- **Bachelier model** → Normal distribution for price changes (goes negative, not lognormal)
- **Exponential growth** → `exp(0.08 × excess)` for friction cost growth
- **Log-normal** → Price model where log(price) is normal (prices > 0)
- **Rolling window** → Moving average over last N observations (5-day, 90-day, 252-day)
- **Percentile** → Location in sorted data (90th percentile = top 10%)
- **Auto-correlation** → Correlation of a series with itself lagged by N days (FA ≈ −0.32)
- **Mean-reversion** → Tendency of a variable to return to its long-run average
- **Basis point arithmetic** → 1 bps = 0.01%, used throughout for precision
- **Duration × yield change** → Price change approximation (8.5yr duration × 1bps = ~0.087bps price change)

### Math You DEFINITELY Need to Explain Simply
If asked: *"How does the straddle fee work?"*
- **Answer:** We look at what the market ACTUALLY moved on similar days (shock vs calm), not a theoretical formula. We shift by T days (no look-ahead), take absolute moves, and average over ~1 quarter. This captures mean-reversion (whipsaw) that theoretical formulas miss.

If asked: *"What is a VAR?"*
- **Answer:** A model where each thing depends on its own past AND other things' past. Like predicting both temperature and humidity tomorrow using yesterday's temperature AND yesterday's humidity.

If asked: *"What does z-score > 1.5 mean?"*
- **Answer:** It's unusually high. Like if the average is 0 with stddev 1, then 1.5 means it's 1.5 standard deviations above average — a rare/extreme event.

If asked: *"How are the three cost views different?"*
- **Answer:** Gross = no costs. HF Net = dealer markup minus hedge fund's volume discount. Retail Net = full dealer markup plus execution friction. The difference is the discount schedule.

---

## 8. Future Projections Methodology

### 8.1 What is Forecasted?
- **Yield changes** (basis points) over horizon h (6 or 24 days)
- **Return curves** at horizon T = 1..21 days (hold-horizon return curves)
- **Impulse response functions** (IRF) — how one shock propagates through the system
- **Granger causality** — does one variable help predict another?

### 8.2 How It Works (VAR → IRF → Returns)
1. **Fit VAR/VECM** on current data (monthly sovereign yields, or daily ETF OAS)
2. **Compute IRF** — simulate a 1-standard-deviation shock to one variable, track how all variables respond over h days
3. **Extract |T-day move|** on "shock days" (days where state variable exceeds threshold)
4. **Compute empirical fee** — average |T-day move| on shock days, shifted by T (no look-ahead)
5. **Compute P&L:** Gross_bps - (fee_T × markup) - friction
6. **Produce PNG** — one chart per view (gross / HF net / retail net) with legend and zero line

### 8.3 CLI Forecast Command
```
python cli.py --market us --hold-days 5 --trade-size-m 50
```
- Runs US market full pipeline
- Prints hold-horizon return curves (1..21 days)
- Prints per-item table: net at CLI hold AND first hold day each series turns non-negative
- Emits PNG: `us_pure_gross_return_curves.png`, `us_pure_hf_net_return_curves.png`, `us_pure_retail_net_return_curves.png`

### 8.4 What You Didn't Do (Limitations)
- **No private credit** — completely removed per project spec
- **No NeuralCox** — no deal-level EV/CVaR super-learner
- **No mock/synthetic deal data** — all data is live or honestly unavailable
- **No interactive input() prompts** — all headless/CLI driven
- **No look-ahead in straddle fee** — fee is strictly empirical and shifted (known after window closes)
- **No 100% dealer comp** — premium share capped at 0.3 (30%), not the full IV−RV ratio
- **No BB/BBB fallen angel premium** — exact membership check prevents overcharging

### 8.5 EUR Country Panel (Your Work)
- Added **EM1A.DE** fallen angel straddle to countries market
- Sovereign yields from ECB LTIR (long-term interest rates) per country: DE, FI, FR, IT, ES, NL, BE, AT, PT, IE, GR
- Bund spread over DE as canonical trade
- Country-level return curves with monthly hold units (LTIR is monthly cadence)
- Three views: gross / HF net / retail net
- PNGs: `europe_country_level_gross_return_curves.png`, etc.
- Spread return curves: `europe_country_spread_gross_return_curves.png`, etc.

---

## 9. Web Portal & API Layer

### 9.1 What It Is
FastAPI-based portal serving GeoJSON and drill-down endpoints:
- `GET /api/v1/heatmap` → GeoJSON with country heat values
- `GET /api/v1/countries/{iso}` → Drill-down for one country
- `GET /api/v1/regions` → Region listing

### 9.2 Data Flow
1. **Engine computes** atlas rows (heat, basis, straddle, VRP, etc.)
2. **Writes** `data/atlas.json` (live store)
3. **Exports** to PostgreSQL via `--market atlas --db` (DATABASE_URL gated)
4. **API reads** from atlas.json + Redis parse-cache (when REDIS_URL set)
5. **Sanitizes** NaN values (defensive `_clean_for_json` in `api/server.py`)

### 9.3 Your Contributions
- Fixed NaN in `data/atlas.json` causing 500 on `/api/v1/countries/{iso}` — added `_clean_for_json` sanitizer
- Fixed `pipelines/heatmap_db.py` — `execute(list)` → `executemany` under psycopg3
- Dockerized local stack — `docker compose up -d` runs postgis (5432) + redis (6379)
- Applied schema: `psql "$DATABASE_URL" -f sql/heatmap_schema.sql`
- `--market atlas --db` verified writing 15+15 rows

### 9.4 Deployment
- **Vercel:** Root directory `web`, Vite preset, build `npm run build`, output `dist`
- **Env vars:** Required `FRED_API_KEY`, optional free-tier keys
- **Serverless:** `web/api/*.js` use `runtime: "nodejs"` (not `nodejs20`)
- **Auto-redeploy:** Push to `master` triggers build; env var changes require manual redeploy

---

## 10. Quick Soundbites for Interview

Here are 10 short statements you can use:

1. **"This project evaluates public debt markets — government bonds, corporate bonds, and ETFs — to surface where compensation is today."**

2. **"The core question: where is compensation in public credit, and what's the expected payoff of trading volatility in those segments?"**

3. **"Data sources are all free and keyless: FRED (Treasury yields, spreads), Yahoo Finance (ETF prices, options), ECB (euro-area yields), CFTC (trader positioning), World Bank (sovereign debt)."**

4. **"Heat on the map is a 1-month total return in USD for each country — averaged from bond price change + currency move + credit carry, double-counting avoided."**

5. **"Three cost views: Gross (theoretical, no costs), HF Net (hedge fund discount), Retail Net (full markup + friction). The difference is the discount schedule."**

6. **"The straddle fee is empirical — based on what the market actually moved on similar days, not a theoretical Black-Scholes formula. This captures mean-reversal (whipsaw) that models miss."**

7. **"Fallen angel ETFs: ANGL for US, EM1A.DE for euro-area countries, GFA.L for global. These are UCITS wrappers, not country-specific fallen angel indices."**

8. **"The board assembles legs (COT, options curve, sovereign trend, FX), each votes only with demonstrated edge (walk-forward sign + OOS Sharpe > 0), threshold |z| ≥ 1.5."**

9. **"I fixed several bugs: the fallen angel premium was overcharging BB/BBB (fixed to exact membership), dealer markup was overstated (lightened premium share to 30%), FRED CSV endpoint decommissioned (port to JSON API), and NaN in atlas causing 500s."**

10. **"The system is 149 pure-logic unit tests, no network, CI-free by design. Everything is auditable in LEDGER.md and CONTEXT.md."**

---

## Final Tips for the Interview

- **It's OK to say "I don't remember the exact constant"** — you can look it up or say "it's in config.py with the audit log in CONTEXT.md §6"
- **Carry a printed copy of this document** or have it open on your screen
- **If asked about something you didn't do** (private credit, NeuralCox), immediately say "That was completely removed per project spec — no private credit pipeline exists"
- **Point to the audit trail** — LEDGER.md and CONTEXT.md show the full execution history
- **Be honest about limitations** — "EMHY has no listed expiries, EMB ATM IV re-measured live, some COT legs genuinely unavailable until ~2028"
- **Show, don't tell** — if they ask about a feature, show the code or the output (CLI run, API response, PNG)

Good luck! You've built a sophisticated system and have a thorough understanding of every component.