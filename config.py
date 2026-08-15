"""Central configuration: secrets, FRED series maps, calibrated constants.

All FRED API key access goes through get_fred_key(); no other module reads
the key directly. Every numeric constant below is either (a) live-fetched,
(b) CLI-supplied via cli.py, or (c) documented empirical calibration — see
context.md "Calibration audit log" for provenance.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

load_dotenv(BASE_DIR / ".env")


def get_fred_key() -> str:
    """Return the FRED API key loaded from .env. Fail loudly if missing."""
    key = os.getenv("FRED_API_KEY")
    if not key or key == "REPLACE_ME":
        raise EnvironmentError(
            "FRED_API_KEY is not set. Copy .env.example to .env and paste your "
            "free key from https://fred.stlouisfed.org/docs/api/api_keys.html"
        )
    return key


def _get_optional_key(env_name: str, how_to_get: str) -> str | None:
    """Optional free-tier credential. Returns None when absent — the caller's
    availability gate reports UNAVAILABLE with the signup instructions."""
    key = os.getenv(env_name)
    if not key or key == "REPLACE_ME":
        return None
    return key


def get_database_url() -> str | None:
    """Optional PostgreSQL DSN for the heatmap export (multi-asset spec §4).

    None when .env has no DATABASE_URL -> the exporter reports UNAVAILABLE and
    data/atlas.json remains the live store. Documented in .env.example.
    """
    return _get_optional_key("DATABASE_URL", "local Postgres; paste a DSN like "
                                            "postgresql://user:pass@localhost:5432/heatmap")


def get_redis_url() -> str | None:
    """Optional Redis URL for the heatmap portal cache (multi-asset spec §1).

    None when .env has no REDIS_URL -> api.server serves the parsed
    data/atlas.json cache directly (same behavior as before). Documented in
    .env.example. No TTL constants: staleness is the file mtime, so no new
    calibration entry is introduced (see context.md §6).
    """
    return _get_optional_key("REDIS_URL", "local Redis; paste a URL like "
                                          "redis://localhost:6379/0")


def get_finra_credentials() -> tuple[str, str] | None:
    """FINRA API Platform Public Credential (free, individual, non-commercial).

    How to get it: https://gateway.finra.org/app/dfo-console -> "Create Account
    Here" (Individual user) -> after login, open the API Console and create a
    Public Credential; the Client ID + Client Secret you set are placed in .env
    as FINRA_API_CLIENT_ID / FINRA_API_SECRET.
    """
    cid = _get_optional_key("FINRA_API_CLIENT_ID", "FINRA API Console -> Public Credential")
    sec = _get_optional_key("FINRA_API_SECRET", "FINRA API Console -> Public Credential")
    return (cid, sec) if cid and sec else None


def get_alpaca_keys() -> tuple[str, str] | None:
    """Alpaca free developer tier (paper trading). Signup: https://alpaca.markets
    -> dashboard -> API Keys; paste ALPACA_API_KEY / ALPACA_API_SECRET into .env."""
    k = _get_optional_key("ALPACA_API_KEY", "https://alpaca.markets free dev account")
    s = _get_optional_key("ALPACA_API_SECRET", "https://alpaca.markets free dev account")
    return (k, s) if k and s else None


def get_ndl_key() -> str | None:
    """Nasdaq Data Link (ex-Quandl) free API key — daily US Treasury yield curve
    (USTREASURY/YIELD), T-bill auction rates (USTREASURY/BILL_RATES).

    How to get it: https://data.nasdaq.com -> Sign up (free) -> "API Keys" ->
    paste NASDAQ_DATA_LINK_API_KEY into .env. ~50k calls/day free tier."""
    return _get_optional_key("NASDAQ_DATA_LINK_API_KEY", "https://data.nasdaq.com free account")


def get_polygon_key() -> str | None:
    """Polygon.io free-tier API key — listed options contracts (strike grid, IV,
    open interest) for credit ETFs, as a second options chain source.

    How to get it: https://polygon.io/dashboard/signup -> Free plan ->
    paste POLYGON_API_KEY into .env (free tier: 5 calls/min, 10k/mo)."""
    return _get_optional_key("POLYGON_API_KEY", "https://polygon.io free plan")


FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations"
FRED_SEARCH_URL = "https://api.stlouisfed.org/fred/series/search"

RATING_ORDER = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC"]

FETCH_ORDER = ["AAA", "AA", "A", "BBB", "Fallen_Angel", "BB", "B", "CCC"]
SPREAD_ORDER = ["AAA", "AA", "A", "BBB", "BB", "B", "CCC"]

US_BOND_SERIES = {
    "AAA": "BAMLC0A1CAAA", "AA": "BAMLC0A2CAA", "A": "BAMLC0A3CA",
    "BBB": "BAMLC0A4CBBB", "Fallen_Angel": "ANGL_ETF_PROXY",
    "BB": "BAMLH0A0HYM2", "B": "BAMLH0A2HYB", "CCC": "BAMLH0A3HYC",
}

FRED_OAS_SERIES = {
    "AAA": ["BAMLC0A1CAAA", "BAMLC0A0CM"],
    "AA": ["BAMLC0A2CAA"],
    "A": ["BAMLC0A3CA"],
    "BBB": ["BAMLC0A4CBBB"],
    "BB": ["BAMLH0A1HYM2", "BAMLH0A1BB", "BAMLH0A0HYM2"],
    "B": ["BAMLH0A2HYM2", "BAMLH0A2B", "BAMLH0A0HYM2"],
    "CCC": ["BAMLH0A3HYM2", "BAMLH0A3CCC", "BAMLH0A0HYM2"],
}
FRED_DR_SERIES = {"IG_proxy": "DRBLACBS", "HY_proxy": "DRCCLACBS"}
DR_MAPPING = {
    "AAA": "IG_proxy", "AA": "IG_proxy", "A": "IG_proxy", "BBB": "IG_proxy",
    "BB": "HY_proxy", "B": "HY_proxy", "CCC": "HY_proxy",
}
HY_SEARCH_QUERIES = {
    "BB": "ICE BofA BB US High Yield Index Option-Adjusted Spread",
    "B": "ICE BofA Single-B US High Yield Index Option-Adjusted Spread",
    "CCC": "ICE BofA CCC US High Yield Index Option-Adjusted Spread",
}

PUBLISHED_LGD = {
    "AAA": 0.400, "AA": 0.400, "A": 0.414, "BBB": 0.435,
    "BB": 0.519, "B": 0.621, "CCC": 0.682,
}

ETF_NAMES = {
    "SHY": "1-3 Year Treasury (SHY)",
    "TLT": "20+ Year Treasury (TLT)",
    "LQD": "Inv. Grade Corporate (LQD)",
    "HYG": "High Yield Corporate (HYG)",
    "ANGL": "Fallen Angels (ANGL)",
    "PFF": "Preferred Stock (PFF)",
}

ML_ETFS = ["SHY", "TLT", "LQD", "HYG", "ANGL", "PFF"]
FEATURE_WINDOWS = [21, 63, 252]
TRADING_DAYS = 252
ML_HORIZON_DAYS = 21
ML_TARGET_PROBABILITY_THRESHOLD = 55.0
ML_USE_GPU = False
ISOLATION_FOREST_CONTAMINATION = 0.02
ML_RANDOM_STATE = 42
ISOLATION_FOREST_RANDOM_STATE = 42

VOLATILITY_PERCENTILES = [95, 90, 80, 70, 60, 50]
GARCH_SIGNAL_PERCENTILE = 90
MIN_OBS_FOR_GARCH = 100
DEALER_PRICING_WINDOW = 90
DEFAULT_NOTIONAL_USD = 100000.0
DEFAULT_TRADE_SIZE_M = 50.0
DEFAULT_HOLD_DAYS = 5
TREASURY_PROXY_TICKER = "^IRX"
FALLEN_ANGEL_LIQUIDITY_PREMIUM = 1.05
DEALER_MARKUP_FLOOR = 1.05
DEALER_MARKUP_PREMIUM_SHARE = 0.3
DEALER_MARKUP_SMOOTHING_WINDOW = 5
REALIZED_VOL_LOOKBACK = 21

# Observation-frequency profiles for the volatility machinery.
#
# DEALER_PRICING_WINDOW and REALIZED_VOL_LOOKBACK are counts of OBSERVATIONS,
# and every caller but one feeds daily series, so they read as "one business
# quarter" and "one month". engine/eur_country.py feeds MONTHLY ECB LTIR
# series through the same code, where the same counts mean a 7.5-year fee
# window measured against 21-month shocks. The consequence was visible in the
# output: the mean |12-month move| over a 90-month window spanning the 2022
# rate shock came out LARGER than the mean move on the shock periods it was
# charged against, so every euro sovereign priced as a guaranteed loss for a
# reason that was purely an indexing artefact.
#
# The monthly profile keeps the ~1:4 ratio the daily constants encode — one
# year of realized vol against four years of dealer pricing — the shortest
# pair that still estimates a standard deviation and a 90th percentile from
# monthly data. periods_per_year annualises.
FREQ_PROFILES = {
    "days": {"rv_lookback": REALIZED_VOL_LOOKBACK,
             "dealer_window": DEALER_PRICING_WINDOW,
             "periods_per_year": TRADING_DAYS},
    "months": {"rv_lookback": 12, "dealer_window": 48, "periods_per_year": 12},
}


def freq_profile(freq: str = "days") -> dict:
    """Window lengths and annualisation for an observation frequency."""
    return FREQ_PROFILES.get(freq, FREQ_PROFILES["days"])


PB_BASE_DISCOUNT = 0.05
PB_VOLUME_DISCOUNT_FACTOR = 0.05
PB_VOL_THRESHOLD_BPS = 100.0
PB_ILLIQUIDITY_DIVISOR = 1000.0
PB_DISCOUNT_CLIP = (0.0, 0.25)

FRICTION_BASE_SPREAD_BPS = 0.5
FRICTION_GROWTH_RATE = 0.08
FRICTION_PERCENTILE = 90

DISTRESSED_GRADES = {"B", "CCC", "Fallen_Angel"}
SKIP_VOL_COLS = ["Risk_Free", "EUR_Risk_Free_10Y"]
ADJACENT_PAIRS = [
    ("AA", "AAA"), ("A", "AA"), ("BBB", "A"),
    ("BB", "Fallen_Angel"),
    ("BB", "BBB"), ("B", "BB"), ("CCC", "B"),
]
FORECAST_HIERARCHY = ["AA - AAA", "A - AA", "BBB - A", "BB - Fallen_Angel", "BB - BBB", "B - BB", "CCC - B"]
PURE_YIELD_HIERARCHY = ["AAA", "AA", "A", "BBB", "Fallen_Angel", "BB", "B", "CCC"]
COINTEGRATION_DET_ORDER = 0
COINTEGRATION_K_AR_DIFF = 1
DEFAULT_FORECAST_HORIZON = 12
DEFAULT_MAX_LAGS = 12
SIGNIFICANCE_ALPHA = 0.05

VAR_JITTER_SCALE = 1e-8
VAR_JITTER_SEED = 42

USA_BOND_RETURNS_FILE = BASE_DIR / "USA_bond_returns_by_grade.json"
USA_SPREAD_FILE = BASE_DIR / "USA_yield_spread_by_bond_grade.json"
EL_BY_GRADE_FILE = BASE_DIR / "expected_loss_by_grade.json"
EL_DIFF_FILE = BASE_DIR / "el_diff_adjacent_grades.json"
SPREAD_EL_FILE = BASE_DIR / "spread-el_grades.json"
DEALER_MARKUP_FILE = DATA_DIR / "dealer_markup.json"

# ---------------------------------------------------------------------------
# GCO layer (Session 2): free-source registry, series maps, calibration notes.
# Every new constant below is documented in context.md §6 audit table.
# ---------------------------------------------------------------------------

SOURCE_CACHE_DIR = DATA_DIR / "cache"
SOURCE_PROBE_FILE = DATA_DIR / "source_probe.json"
IV_HISTORY_FILE = DATA_DIR / "iv_history.json"
STALE_MAX_GAP_BDAYS = 10  # business days after which a daily series is STALE

FRED_TREASURY_CURVE_SERIES = [
    "DGS1MO", "DGS3MO", "DGS6MO", "DGS1", "DGS2", "DGS3", "DGS5", "DGS7",
    "DGS10", "DGS20", "DGS30",
]
FRED_MOODY_SERIES = ["AAA", "BAA", "BAA10Y"]
FRED_TIPS_SERIES = ["DFII5", "DFII10", "DFII30"]
FRED_MACRO_SERIES = ["FEDFUNDS", "SOFR", "NFCI", "STLFSI"]
# ICE BofA regional credit (free on FRED; existence re-verified via FRED search).
FRED_EUR_EM_CREDIT_SERIES = {
    "EUR_HY_OAS": "BAMLHE00EHYIOAS",
    "EM_CORP_OAS": "BAMLEMRECRPIEMEAOAS",
}

# ICE BofA EM sector/ownership splits (verified live 2026-08-10).
FRED_EM_SECTOR_SERIES = {
    "EM_OVERALL": "BAMLEMCBPIOAS",
    "EM_HY": "BAMLEMHBHYCRPIOAS",
    "EM_FINANCIALS": "BAMLEMFSFCRPIOAS",
    "EM_PUBLIC_SECTOR": "BAMLEMPBPUBSICRPIOAS",
    "EM_PRIVATE_SECTOR": "BAMLEMPTPRVICRPIOAS",
}

# Inflation breakevens + real rates (TIPS leg).
FRED_INFLATION_SERIES = {
    "DFII5": "DFII5", "DFII10": "DFII10", "DFII30": "DFII30",
    "T5YIE": "T5YIE", "T10YIE": "T10YIE",
}

# OECD long-term government bond yields (10Y) mirrored on FRED as
# IRLTLT01{CC}M156N (monthly). ALL series below verified live 2026-08-10
# (Brazil/China/Indonesia/Thailand/Turkey/etc. do NOT exist on FRED — see
# §4; Brazil is covered by sources/bcb.py, the rest are gated honestly).
# Region buckets are documented in context.md §6.
GLOBAL_SOVEREIGN_COUNTRIES = {
    "US": "IRLTLT01USM156N", "GB": "IRLTLT01GBM156N", "JP": "IRLTLT01JPM156N",
    "AU": "IRLTLT01AUM156N", "CA": "IRLTLT01CAM156N", "FR": "IRLTLT01FRM156N",
    "DE": "IRLTLT01DEM156N", "IT": "IRLTLT01ITM156N", "ES": "IRLTLT01ESM156N",
    "NL": "IRLTLT01NLM156N", "BE": "IRLTLT01BEM156N", "AT": "IRLTLT01ATM156N",
    "PT": "IRLTLT01PTM156N", "IE": "IRLTLT01IEM156N", "CH": "IRLTLT01CHM156N",
    "SE": "IRLTLT01SEM156N", "NO": "IRLTLT01NOM156N", "DK": "IRLTLT01DKM156N",
    "FI": "IRLTLT01FIM156N", "GR": "IRLTLT01GRM156N", "IL": "IRLTLT01ILM156N",
    "KR": "IRLTLT01KRM156N", "NZ": "IRLTLT01NZM156N", "MX": "IRLTLT01MXM156N",
    "CL": "IRLTLT01CLM156N", "ZA": "IRLTLT01ZAM156N", "PL": "IRLTLT01PLM156N",
    "CZ": "IRLTLT01CZM156N", "HU": "IRLTLT01HUM156N", "SK": "IRLTLT01SKM156N",
    "SI": "IRLTLT01SIM156N",
}
INDIA_LONG_RATE_SERIES = "INDIRLTLT01STM"
GLOBAL_RATE_REGIONS = {
    "DM_EX_US": ["GB", "JP", "AU", "CA", "FR", "DE", "IT", "ES", "NL", "BE",
                 "AT", "PT", "IE", "CH", "SE", "NO", "DK", "FI", "GR", "IL", "NZ"],
    "EM_ASIA": ["KR", "IN"],
    "EM_LATAM": ["MX", "CL"],
    "EM_EMEA": ["ZA", "PL", "CZ", "HU", "SK", "SI"],
}

TREASURY_AUCTION_BASE = ("https://api.fiscaldata.treasury.gov/services/api/"
                         "fiscal_service/v1/accounting/od/auctions_query")
TREASURY_DEBT_BASE = ("https://api.fiscaldata.treasury.gov/services/api/"
                      "fiscal_service/v2/accounting/od/debt_to_penny")

CFTC_FIN_FUT_URL = "https://www.cftc.gov/files/dea/history/fut_fin_txt_{year}.zip"
COT_MARKET_QUERIES = {
    "UST_2Y": "UST 2Y NOTE",
    "UST_5Y": "UST 5Y NOTE",
    "UST_10Y": "UST 10Y NOTE",
    "UST_30Y": "UST BOND",
    "UST_ULTRA": "ULTRA UST BOND",
    "SOFR_3M": "SOFR-3M",
    "BBG_IG_CREDIT": "BLOOMBERG IG CREDIT FUTURES",
    "BBG_HY_CREDIT": "BLOOMBERG HY CREDIT FUTURES",
}
COT_MIN_HISTORY_YEARS = 2.0  # z-scores require >=2y of observations (R4)

RATE_FUTURES_TICKERS = ["ZT=F", "ZF=F", "ZN=F", "ZB=F", "UB=F", "SR3=F"]
CREDIT_OPTION_ETFS = ["HYG", "LQD", "TLT", "ANGL", "EMB", "EMHY", "JNK"]
FX_PAIRS = ["EURUSD=X", "GBPUSD=X", "JPY=X", "MXN=X", "BRL=X", "ZAR=X", "INR=X", "CNY=X"]

# ECB YC dataflow keys. Verified live 2026-08-10: the YC dataflow publishes
# GOVERNMENT curves only (G_N_*); every corporate key (C_N_*) returns 404 —
# corporate euro compensation comes from FRED BAMLHE00EHYIOAS + UCITS ETFs.
ECB_YIELD_KEYS = {
    "EA_GOV_AAA_10Y": "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y",
    "EA_GOV_ALL_10Y": "YC.B.U2.EUR.4F.G_N_C.SV_C_YM.SR_10Y",
    "EA_GOV_AAA_2Y": "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y",  # verified live 2026-08-10
    # Full euro-area AAA curve for the heatmap term-structure leg — all four
    # keys verified live 2026-08-10 (5604 obs each, as-of 2026-08-07).
    "EA_GOV_AAA_1Y": "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_1Y",
    "EA_GOV_AAA_5Y": "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_5Y",
    "EA_GOV_AAA_30Y": "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_30Y",
}

# Per-country 10Y government benchmark yields — ECB long-term interest rate
# (LTIR) dataflow, monthly, ~35y history. ALL verified live 2026-08-11
# (396-486 obs each, latest 2026-06-01): the YC dataflow publishes only the
# euro-area aggregate (B.U2) — per-country keys there 404 — so the
# country-level legs use the IRS dataflow instead (same flow/series URL
# split; keys requested as /service/data/IRS/{series}).
ECB_LTIR_COUNTRY_KEYS = {
    "DE": "IRS.M.DE.L.L40.CI.0000.EUR.N.Z",
    "FR": "IRS.M.FR.L.L40.CI.0000.EUR.N.Z",
    "IT": "IRS.M.IT.L.L40.CI.0000.EUR.N.Z",
    "ES": "IRS.M.ES.L.L40.CI.0000.EUR.N.Z",
    "NL": "IRS.M.NL.L.L40.CI.0000.EUR.N.Z",
    "BE": "IRS.M.BE.L.L40.CI.0000.EUR.N.Z",
    "AT": "IRS.M.AT.L.L40.CI.0000.EUR.N.Z",
    "PT": "IRS.M.PT.L.L40.CI.0000.EUR.N.Z",
    "IE": "IRS.M.IE.L.L40.CI.0000.EUR.N.Z",
    "FI": "IRS.M.FI.L.L40.CI.0000.EUR.N.Z",
    "GR": "IRS.M.GR.L.L40.CI.0000.EUR.N.Z",
}
EUR_COUNTRY_REFERENCE = "DE"  # Bund — the EUR risk-free anchor (see eur_panel.py)

WB_DEBT_INDICATORS = {
    "EXT_DEBT_TOTAL": "DT.DOD.DECT.CD",
    "DEBT_SERVICE": "DT.TDS.DECT.CD",
    "DEBT_TO_GNI": "DT.DOD.DECT.GN.ZS",
}
WB_CREDIT_GAP_PROXY = "FS.AST.PRVT.GD.ZS"  # domestic credit to private sector (% GDP)

WORLD_BANK_BASE = "https://api.worldbank.org/v2"
ECB_SDMX_BASE = "https://data-api.ecb.europa.eu/service/data"
FINRA_TOKEN_URL = "https://ews.fip.finra.org/fip/rest/ews/oauth2/access_token"
FINRA_BASE = "https://api.finra.org"
# Real FINRA Query API dataset names (verified live 2026-08-10 via /datasets).
# The names used before this date (corporateDebtMarketBreadth,
# corporateAndAgencyCappedVolume) do not exist on the platform and returned 404.
FINRA_PUBLIC_DATASETS = {
    "breadth": ("fixedIncomeMarket", "CORPORATEMARKETBREADTH"),
    "capped_volume": ("fixedIncomeMarket", "CORPORATESANDAGENCIESCAPPEDVOLUME"),
}

BOARD_SIGNAL_THRESHOLD_Z = 1.5  # |z| above which a signal counts as +1/-1
BACKTEST_MIN_OBS = 60            # minimum observations for a backtest leg
IV_Z_MIN_OBS = 20                # IV-RV z-score gate: >=1 month of accrued IV history (R4)
# Real-quote floor for listed credit-ETF ATM IV (calibrated 2026-08-10):
# yfinance served whole chains at 1e-5 (and TLT/JNK at 0.0156/0.0039) one
# evening when its IV feed degraded. Every real ATM IV this project has
# observed across HYG/LQD/TLT/ANGL/EMB is >= 0.039 (HYG 0.051, LQD 0.109,
# TLT 0.107, EMB 0.418, ANGL 0.389); the floor 0.02 keeps >2x margin below
# the smallest real observation. Values at/below the floor are rejected (not
# accrued), so a bad quote can never overwrite a day's real snapshot.
IV_MIN_REAL = 0.02

# ---------------------------------------------------------------------------
# Session 7: exhaustive public-debt coverage — new free sources, universes and
# gates. Every constant below is documented in context.md §6 audit table.
# ---------------------------------------------------------------------------

# SEC EDGAR (keyless) issuer universe: CIKs for liquid public borrowers by
# sector. Used for the corporate-leverage screen (LongTermDebt / TotalAssets
# from 10-K annual filings). All CIKs verified live 2026-08-10.
SEC_USER_AGENT = "PublicCreditResearch contact@example.com"  # EDGAR requires a UA
SEC_EDGAR_FACTS_URL = "https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json"
# US-GAAP debt concepts tried in order (filers move between them over time);
# Assets has no fallback (universally reported).
SEC_DEBT_CONCEPTS = ["LongTermDebt", "LongTermDebtNoncurrent", "DebtAndCapitalLeaseObligations",
                     "LongTermDebtAndCapitalLeaseObligations"]
# CIKs are 10-digit zero-padded; verified live 2026-08-10.
SEC_LEVERAGE_UNIVERSE = {
    "Financials": ["0000019617", "0000070858", "0000886982", "0000831001"],   # JPM BAC GS C
    "Energy": ["0000034088", "0000093410", "0001163165", "0000797468"],       # XOM CVX COP OXY
    "Telecom": ["0000732717", "0000732712", "0001283699"],                    # T VZ TMUS
    "Auto": ["0000037996", "0001318605", "0001874178"],                      # F TSLA RIVN
    "Consumer": ["0000104169", "0000354950", "0000063908"],                   # WMT HD MCD
    "Industrials": ["0000040545", "0000012927", "0000018230"],                # GE BA CAT
    "Tech": ["0000320193", "0000789019", "0001341439"],                       # AAPL MSFT ORCL
    "Healthcare": ["0000200406", "0000078003", "0000731766"],                 # JNJ PFE UNH
    "Materials": ["0000831259", "0001164727", "0001751788", "0000073309"],    # FCX NEM DOW NUE
    "Utilities": ["0001326160", "0000092122", "0000753308"],                  # DUK SO NEE
}
SEC_SECTOR_MIN_FILERS = 3      # a sector needs >=3 filers for a median
SEC_LEVERAGE_MIN_OBS = 4       # annual leverage z needs >=4 annual points

# Nasdaq Data Link (free key, optional): daily Treasury curve + T-bill rates.
NDL_BASE = "https://data.nasdaq.com/api/v3/datasets"
NDL_YIELD_CURVE_DATASET = "USTREASURY/YIELD"     # daily nominal+real par yields
NDL_BILL_RATES_DATASET = "USTREASURY/BILL_RATES" # weekly T-bill auction rates

# Polygon.io (free key, optional): listed options on credit ETFs. The free
# tier is 5 calls/min — the probe fetches one chain snapshot per ticker per
# day. 25-delta put/call IV builds the put-skew accrual.
POLYGON_BASE = "https://api.polygon.io"
POLYGON_OPTION_ETFS = ["HYG", "LQD", "TLT", "ANGL", "JNK", "EMB"]
SKEW_Z_MIN_OBS = 20            # put-skew z needs >=1 month of accrued skew (R4-like gate)

# Credit-appetite composite (replaces the data-existence-gated COT IG/HY
# legs as the LIVE credit-positioning proxy — see context.md §9/§10).
APPETITE_COMPONENTS_MIN = 2    # composite z needs >=2 live components
DR_STALE_MAX_AGE_DAYS = 130    # DR momentum component goes dark when the last
                               # observation is older than ~2 quarters (DRCCLACBS
                               # is quarterly; measured stale 2026-01-01 -> 2026-08)

# EM carry leg: local-currency vs hard-currency fund baskets.
EM_LOCAL_FUNDS = ["LEMB", "PCY", "VWOB"]
EM_HARD_FUNDS = ["EMB", "CEMB"]

# Expanded public-debt ETF universe (all verified live 2026-08-10):
# US IG/HY/muni/MBS/TIPS/preferreds, EM local+hard, intl sovereign, duration.
CREDIT_ETF_UNIVERSE = {
    "SHY": "1-3Y UST", "IEF": "7-10Y UST", "TLT": "20Y+ UST", "EDV": "30Y+ STRIP",
    "VGIT": "IG UST 3-10Y", "GOVT": "UST Aggregate", "BND": "US Bond Aggregate",
    "LQD": "US IG Corporate", "VCIT": "IG Corporate 5-10Y", "VCSH": "IG Corporate 1-5Y",
    "HYG": "US HY Corporate", "JNK": "US HY Corporate", "ANGL": "US Fallen Angels",
    "HYLB": "US HY Liquid", "FALN": "US Fallen Angels", "PFF": "US Preferreds",
    "MBB": "US MBS Agency", "MUB": "US Municipal National", "TIP": "US TIPS",
    "BWX": "Intl Sovereign ex-US", "IGOV": "Intl Sovereign ex-US",
    "VWOB": "EM Sovereign", "LEMB": "EM Local Sovereign", "PCY": "EM Local Sovereign",
    "EMB": "EM Hard-Currency", "CEMB": "EM Corp Hard-Currency",
}
ML_ETFS_LIQUID = ["SHY", "IEF", "TLT", "VGIT", "GOVT", "BND", "LQD", "VCIT",
                  "VCSH", "HYG", "JNK", "ANGL", "HYLB", "PFF", "MBB", "MUB",
                  "TIP", "EMB", "LEMB", "VWOB"]  # ML screen universe (subset)

# Expanded FX overlay pairs (8 DM/EM + regional EM).
FX_PAIRS = ["EURUSD=X", "GBPUSD=X", "JPY=X", "CHF=X", "AUD=X", "CAD=X",
            "MXN=X", "BRL=X", "ZAR=X", "INR=X", "CNY=X", "KRW=X",
            "IDR=X", "THB=X", "TRY=X", "CLP=X", "COP=X"]

# BCB (Brazil Central Bank SGS, keyless): Selic policy rate (daily, code 4189).
BCB_SGS_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.{code}/dados/ultimos?formato=json"
BCB_SELIC_CODE = 4189

# Country atlas (Opportunity Map): OECD long-term (10Y) government bond
# yields per country, monthly, free on FRED (IRLTLT01*M156N; verified live
# 2026-08-10 via FRED series search). Auxiliary country equity ETFs (free on
# yfinance) power a clearly-labeled equity-return leg. NO free CDS data
# exists (FRED series search returns none) -> the atlas CDS leg reports
# UNAVAILABLE plus an explicit sovereign-spread proxy (10Y minus US 10Y).
ATLAS_COUNTRY_YIELDS = {
    "US": "IRLTLT01USM156N", "DE": "IRLTLT01DEM156N", "FR": "IRLTLT01FRM156N",
    "IT": "IRLTLT01ITM156N", "ES": "IRLTLT01ESM156N", "GB": "IRLTLT01GBM156N",
    "JP": "IRLTLT01JPM156N", "CA": "IRLTLT01CAM156N", "CH": "IRLTLT01CHM156N",
    "AU": "IRLTLT01AUM156N", "NL": "IRLTLT01NLM156N", "KR": "IRLTLT01KRM156N",
    "MX": "IRLTLT01MXM156N", "ZA": "IRLTLT01ZAM156N",
}
ATLAS_REGIONS = {
    "US": "americas", "CA": "americas", "MX": "americas", "BR": "americas",
    "GB": "europe", "DE": "europe", "FR": "europe", "IT": "europe",
    "ES": "europe", "NL": "europe", "CH": "europe",
    "JP": "asia", "KR": "asia", "AU": "apac", "CN": "asia", "IN": "asia",
    "SG": "asia", "TW": "asia", "ZA": "africa",
}
ATLAS_COUNTRY_ETFS = {
    "DE": "EWG", "FR": "EWQ", "IT": "EWI", "ES": "EWP", "NL": "EWN",
    "GB": "EWU", "JP": "EWJ", "CN": "FXI", "KR": "EWY", "IN": "INDA",
    "BR": "EWZ", "MX": "EWW", "SG": "EWS", "TW": "EWT", "AU": "EWA",
    "CA": "EWC", "ZA": "EZA", "US": "SPY",
}

# ---------------------------------------------------------------------------
# Multi-asset heatmap spec legs (multi_asset_heatmap_spec.md) — all verified
# live 2026-08-10. US-only facts are labeled as such; nothing is fabricated.
# ---------------------------------------------------------------------------

# US full nominal curve + breakeven (FRED): 2s10s used by the GCO board, now
# the full 2/5/10/30 + T10YIE real-yield leg for the heatmap term structure.
ATLAS_US_CURVE = {"DGS2": "2y", "DGS5": "5y", "DGS10": "10y", "DGS30": "30y"}
ATLAS_US_BREAKEVEN = "T10YIE"  # 10-year breakeven inflation, FRED daily (live)

# Cash-index futures basis/carry legs (heatmap spec §3.4). ES=F/^GSPC and
# NQ=F/^NDX verified live 2026-08-10 (yfinance). Other countries were probed
# on the same date: NK=F and FDAX.EX are NOT listed on yfinance -> no basis
# leg for them, honestly UNAVAILABLE. This is a same-underlying cash-index
# basis (immune to the note-futures CTD ambiguity seam).
ATLAS_INDEX_FUTURES = {
    "US": [("ES=F", "^GSPC"), ("NQ=F", "^NDX")],
}

# Real country centroids for the GeoJSON heatmap (static geography for the
# portal map; Point features, lon/lat order as GeoJSON requires).
ATLAS_COUNTRY_LATLON = {
    "US": [-98.5, 39.8], "CA": [-106.3, 56.1], "MX": [-102.5, 23.6], "BR": [-51.9, -14.2],
    "GB": [-3.4, 54.0], "DE": [10.4, 51.2], "FR": [2.2, 46.2], "IT": [12.6, 42.8],
    "ES": [-3.7, 40.4], "NL": [5.3, 52.1], "CH": [8.2, 46.8],
    "JP": [138.2, 36.2], "KR": [127.8, 35.9], "AU": [133.8, -25.3],
    "CN": [104.2, 35.9], "IN": [78.9, 21.6], "SG": [103.8, 1.35], "TW": [121.0, 23.7],
    "ZA": [24.7, -29.0], "EZ": [10.4, 51.0],
}

# RV_30d window for the atlas equity leg — the heatmap spec's convention
# (spec §3.3 "RV_30d"; distinct from the GCO signal's 21-day
# REALIZED_VOL_LOOKBACK, which stays untouched).
ATLAS_RV_WINDOW = 30

# Optional storage/API layer for the heatmap portal (spec §4/§6). The working
# store stays data/atlas.json; PostgreSQL is an optional export target enabled
# by DATABASE_URL in .env (get_database_url, documented in .env.example) +
# `pip install "psycopg[binary]"`. FastAPI/uvicorn are optional requirements.
API_HOST = "127.0.0.1"
API_PORT = 8000
