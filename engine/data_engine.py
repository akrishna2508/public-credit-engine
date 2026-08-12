"""Secure FRED + yfinance data layer. All FRED key access via config.get_fred_key()."""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import config

logging.basicConfig(level=logging.INFO, format='%(asctime)s - [%(levelname)s] - %(message)s')
logger = logging.getLogger(__name__)


def get_secure_session() -> requests.Session:
    """Auto-retried session for 429/5xx responses."""
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1,
                  status_forcelist=[429, 500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retry)
    session.mount('http://', adapter)
    session.mount('https://', adapter)
    return session


def fetch_fred_series(series_id: str, session: requests.Session | None = None) -> pd.Series:
    """Fetch a FRED series into a tz-naive indexed Series. Empty Series on error."""
    key = config.get_fred_key()
    sess = session or get_secure_session()
    url = f"{config.FRED_BASE_URL}?series_id={series_id}&api_key={key}&file_type=json"
    try:
        resp = sess.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if "error_message" in data:
            logger.error(f"FRED error for {series_id}: {data['error_message']}")
            return pd.Series(dtype=float)
        df = pd.DataFrame(data['observations'])[['date', 'value']]
        df['date'] = pd.to_datetime(df['date'])
        df['value'] = pd.to_numeric(df['value'], errors='coerce')
        return df.set_index('date')['value'].ffill().dropna()
    except Exception as e:
        msg = str(e).replace(key, "***")
        logger.error(f"FRED Fetch Error ({series_id}): {msg}")
        return pd.Series(dtype=float)


def fetch_treasury_daily_rate(index: pd.DatetimeIndex, ticker: str = config.TREASURY_PROXY_TICKER) -> pd.Series:
    """Fetch the daily T-bill proxy via yfinance; align to index. Fails loud on missing data."""
    if index.empty:
        raise ValueError("Cannot fetch Treasury rate for an empty index.")
    start, end = index.min().strftime("%Y-%m-%d"), index.max().strftime("%Y-%m-%d")
    raw = yf.download(ticker, start=start, end=end, progress=False)
    if raw.empty:
        raise RuntimeError(f"yfinance returned no data for {ticker}; cannot price discount factor.")
    rates = raw["Close"].squeeze() / 100.0
    if rates.index.tz is not None:
        rates.index = rates.index.tz_localize(None)
    return rates.reindex(index).ffill().bfill()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """Engineer Sharpe/Sortino/Calmar/Liquidity/OAS-Z ratios with safe rolling windows."""
    df = df.copy()
    df['Ret'] = df['Adj Close'].pct_change()
    df['Liquidity_Proxy'] = (df['High'] - df['Low']) / df['Close']

    eps = 1e-9
    for w in config.FEATURE_WINDOWS:
        roll_ret = df['Ret'].rolling(w, min_periods=1)
        std_dev = roll_ret.std().fillna(0)
        df[f'Sharpe_{w}'] = (roll_ret.mean() / (std_dev + eps)) * np.sqrt(config.TRADING_DAYS)

        downside = df['Ret'].where(df['Ret'] < 0, 0)
        down_std = downside.rolling(w, min_periods=1).std().fillna(0)
        df[f'Sortino_{w}'] = (roll_ret.mean() / (down_std + eps)) * np.sqrt(config.TRADING_DAYS)

        roll_max = df['Adj Close'].rolling(w, min_periods=1).max()
        max_dd = ((df['Adj Close'] / roll_max) - 1.0).rolling(w, min_periods=1).min()
        shifted_close = df['Adj Close'].shift(w).bfill()
        annual_ret = (df['Adj Close'] / shifted_close) ** (config.TRADING_DAYS / w) - 1
        df[f'Calmar_{w}'] = annual_ret / (abs(max_dd) + eps)

    return df


def generate_master_dataset() -> dict[str, pd.DataFrame]:
    """Compile ETF proxies + macro anchors into an ML-ready panel (public credit only)."""
    logger.info("Fetching ETFs and Macro Anchors...")
    session = get_secure_session()

    term_spread = (fetch_fred_series("DGS10", session) - fetch_fred_series("DGS2", session)).ffill()
    oas = fetch_fred_series("BAMLC0A0CM", session)

    dataset: dict[str, pd.DataFrame] = {}
    for t in config.ML_ETFS:
        logger.info(f"Processing {t}...")
        df = yf.download(t, start="2015-01-01", progress=False)
        if df.empty:
            logger.warning(f"No data for {t}; skipping.")
            continue
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)
        if 'Adj Close' not in df.columns:
            df['Adj Close'] = df['Close']
        if df.index.tz is not None:
            df.index = df.index.tz_localize(None)

        df = build_features(df)
        df = df.iloc[config.TRADING_DAYS:].copy()

        df['Term_Spread'] = term_spread.reindex(df.index).bfill().ffill().fillna(0)
        oas_reindexed = oas.reindex(df.index).bfill().ffill().fillna(0)
        roll_mean = oas_reindexed.rolling(63, min_periods=1).mean()
        roll_std = oas_reindexed.rolling(63, min_periods=1).std().fillna(0)
        df['OAS_Z'] = (oas_reindexed - roll_mean) / (roll_std + 1e-9)

        future_close = df['Adj Close'].shift(-config.ML_HORIZON_DAYS)
        df['Target'] = (future_close > df['Adj Close']).astype(float)
        df.loc[future_close.isna(), 'Target'] = np.nan

        feature_cols = [c for c in df.columns if c != 'Target']
        nan_pct = df[feature_cols].isnull().mean()
        critical_nan = nan_pct[nan_pct > 0.05]
        if not critical_nan.empty:
            raise RuntimeError(
                f"Feature NaN threshold exceeded for {t}. "
                f"Columns above 5% NaN: {critical_nan.to_dict()}"
            )

        df = df.dropna(subset=feature_cols)
        dataset[t] = df

    logger.info(f"Master dataset: {len(dataset)} ETFs.")
    return dataset


def fetch_etf_yield(ticker: str, start: str = "2016-01-01") -> pd.Series:
    """Trailing 12-month (TTM) dividend yield proxy via yfinance."""
    t = yf.Ticker(ticker)
    hist = t.history(start=start)
    if hist.empty:
        return pd.Series(dtype=float)
    ttm_dividends = hist["Dividends"].rolling(window=config.TRADING_DAYS).sum().bfill()
    safe_close = hist["Close"].replace(0, np.nan)
    yld = (ttm_dividends / safe_close) * 100
    if yld.index.tz is not None:
        yld.index = yld.index.tz_localize(None)
    return yld.dropna()
