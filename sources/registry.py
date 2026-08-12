"""Availability-gate framework shared by all GCO sources.

Core idea: a source is either (a) returning real data, or (b) reporting
UNAVAILABLE with a reason and a fix. There is no third state that injects
placeholder values into the pipeline.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, asdict
from datetime import date
from pathlib import Path
from typing import Any, Callable

import pandas as pd

import config


class SourceUnavailable(RuntimeError):
    """Raised by a source when its data cannot be obtained for a real reason."""

    def __init__(self, source: str, reason: str, fix: str | None = None):
        self.source = source
        self.fix = fix
        msg = f"{source} UNAVAILABLE: {reason}"
        if fix:
            msg += f" | fix: {fix}"
        super().__init__(msg)


@dataclass
class SourceStatus:
    """Structured availability report for one source."""
    name: str
    available: bool
    as_of: str | None = None
    gap_days: int | None = None
    detail: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def check_recency(index: pd.DatetimeIndex) -> tuple[int | None, bool]:
    """(gap_business_days, is_stale) for a DatetimeIndex vs today.

    gap is None when the index is empty. is_stale is True when the latest
    observation is older than config.STALE_MAX_GAP_BDAYS business days.
    """
    if index is None or len(index) == 0:
        return None, True
    latest = index.max()
    today = pd.Timestamp.now().normalize()
    gap = len(pd.bdate_range(latest, today)) - 1
    return int(max(gap, 0)), gap > config.STALE_MAX_GAP_BDAYS


def status_from_series(name: str, series: pd.Series | pd.DataFrame) -> SourceStatus:
    """Build a SourceStatus from a fetched series (empty -> UNAVAILABLE)."""
    if series is None or (hasattr(series, "empty") and series.empty):
        return SourceStatus(name=name, available=False, detail="source returned no data")
    idx = series.index if isinstance(series, pd.Series) else series.index
    gap, stale = check_recency(pd.DatetimeIndex(idx))
    flag = " (STALE)" if stale else ""
    return SourceStatus(name=name, available=True,
                        as_of=str(pd.Timestamp(idx.max()).date()),
                        gap_days=gap, detail=f"observations={len(series)}{flag}")


def _cache_path(cache_key: str) -> Path:
    safe = hashlib.sha1(cache_key.encode()).hexdigest()[:16]
    return config.SOURCE_CACHE_DIR / f"{safe}.json"


def cache_json(cache_key: str, ttl_days: float, loader: Callable[[], Any]) -> Any:
    """Disk cache: load from data/cache/ if fresh, else call loader() and store.

    The loader must return JSON-serializable data (or raise SourceUnavailable).
    """
    config.SOURCE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_key)
    if path.exists():
        age_days = (time.time() - path.stat().st_mtime) / 86400.0
        if age_days <= ttl_days:
            with open(path) as f:
                return json.load(f)
    data = loader()
    with open(path, "w") as f:
        json.dump(data, f)
    return data


def load_iv_history() -> dict:
    """IV accrual file: {ticker: {date: snapshot_dict}} where snapshot_dict is
    the dict produced by yf_options.snapshot_ticker (keys incl. atm_iv)."""
    if config.IV_HISTORY_FILE.exists():
        with open(config.IV_HISTORY_FILE) as f:
            return json.load(f)
    return {}


def save_iv_history(history: dict) -> None:
    with open(config.IV_HISTORY_FILE, "w") as f:
        json.dump(history, f)


def accrue_snapshot(ticker: str, as_of: str, snapshot: dict) -> None:
    """Merge one day's option snapshot into the IV history file (R4: chains are
    point-in-time, so we accrue a daily history for future IV-RV backtests)."""
    history = load_iv_history()
    hist = history.setdefault(ticker, {})
    hist[as_of] = snapshot
    save_iv_history(history)


def iso_today() -> str:
    return date.today().isoformat()


def parse_ecb_csvdata(text: str, key: str) -> pd.Series:
    """Convert an ECB SDMX csvdata response into a daily observation Series.

    The Data Portal API serves `?format=csvdata` (the jsondata format was
    dropped). Rows not matching `key` (multi-key responses) are dropped.
    Raises SourceUnavailable when nothing parses.
    """
    import io
    try:
        df = pd.read_csv(io.StringIO(text))
    except Exception as e:
        raise SourceUnavailable("ecb", f"csvdata parse failed: {e}") from e
    if df.empty:
        raise SourceUnavailable("ecb", "empty csvdata response")
    if "KEY" in df.columns:
        df = df[df["KEY"].astype(str) == key]
    time_col = next((c for c in ("TIME_PERIOD", "TIME") if c in df.columns), None)
    val_col = next((c for c in ("OBS_VALUE", "VALUE") if c in df.columns), None)
    if time_col is None or val_col is None:
        raise SourceUnavailable("ecb", "csvdata schema changed (no time/value column)",
                                "re-check column names at data.ecb.europa.eu/help/api")
    out = df[[time_col, val_col]].copy()
    out[time_col] = pd.to_datetime(out[time_col], errors="coerce")
    out[val_col] = pd.to_numeric(out[val_col], errors="coerce")
    out = out.dropna().set_index(time_col)[val_col]
    out = out[~out.index.duplicated(keep="last")].sort_index()
    if out.empty:
        raise SourceUnavailable("ecb", "csvdata response had no matching observations")
    return out.astype(float)


def write_probe_report(report: dict) -> None:
    with open(config.SOURCE_PROBE_FILE, "w") as f:
        json.dump(report, f, indent=2)


def load_probe_report() -> dict:
    if config.SOURCE_PROBE_FILE.exists():
        with open(config.SOURCE_PROBE_FILE) as f:
            return json.load(f)
    return {}


def clear_cache() -> None:
    if config.SOURCE_CACHE_DIR.exists():
        for f in config.SOURCE_CACHE_DIR.iterdir():
            os.remove(f)
