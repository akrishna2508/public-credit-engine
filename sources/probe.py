"""Source probe: exercise every GCO source once, report pass/fail honestly.

Usage:  python -m sources.probe

Writes data/source_probe.json (the board's availability truth) and prints a
human table. One failing source never aborts the probe. A failure records
the reason and fix — never a fabricated value.
"""
from __future__ import annotations

import importlib
import time
from typing import Callable

import pandas as pd

from sources.registry import SourceStatus, write_probe_report


def _status_from_result(name: str, result) -> SourceStatus:
    if result is None:
        return SourceStatus(name=name, available=False, detail="loader returned None")
    if isinstance(result, dict):
        series = next((v for v in result.values()
                       if isinstance(v, (pd.Series, pd.DataFrame)) and not v.empty), None)
        if series is not None:
            return SourceStatus(name=name, available=True,
                                as_of=_as_of(series), detail=f"{len(series)} observations")
        # Non-series snapshot dicts (e.g. Alpaca trade quotes) are real data
        # when non-empty — an empty dict is a genuinely empty result.
        if result:
            return SourceStatus(name=name, available=True,
                                detail=f"{len(result)} keys")
        return SourceStatus(name=name, available=False, detail="loader returned no data")
    if isinstance(result, (pd.Series, pd.DataFrame)):
        if result.empty:
            return SourceStatus(name=name, available=False, detail="empty result")
        return SourceStatus(name=name, available=True,
                            as_of=_as_of(result), detail=f"{len(result)} observations")
    return SourceStatus(name=name, available=True, detail=str(result)[:120])


def _as_of(obj) -> str | None:
    idx = obj.index
    if isinstance(idx, pd.DatetimeIndex) and len(idx):
        return str(idx.max().date())
    if isinstance(obj, pd.DataFrame) and len(obj) and "report_date" in obj.columns:
        return str(pd.to_datetime(obj["report_date"]).max().date())
    return None


def _probe(name: str, loader: Callable[[], object]) -> SourceStatus:
    try:
        result = loader()
        st = _status_from_result(name, result)
        st.gap_days = None
        return st
    except Exception as e:
        return SourceStatus(name=name, available=False,
                            detail=f"{type(e).__name__}: {str(e)[:200]}")


def loaders() -> list[tuple[str, Callable[[], object]]]:
    s = lambda m: importlib.import_module(f"sources.{m}")  # noqa: E731
    return [
        ("fred_ext.treasury_curve", lambda: s("fred_ext").fetch_treasury_curve()),
        ("fred_ext.moodys", lambda: s("fred_ext").fetch_moodys()),
        ("fred_ext.tips", lambda: s("fred_ext").fetch_tips()),
        ("fred_ext.macro_anchors", lambda: s("fred_ext").fetch_macro_anchors()),
        ("fred_ext.regional_credit", lambda: s("fred_ext").fetch_regional_credit()),
        ("fred_ext.global_sovereign", lambda: s("fred_ext").fetch_global_sovereign()),
        ("fred_ext.em_sector_credit", lambda: s("fred_ext").fetch_em_sector_credit()),
        ("fred_ext.inflation", lambda: s("fred_ext").fetch_inflation()),
        ("treasury_api.auctions", lambda: s("treasury_api").fetch_auctions(limit=25)),
        ("treasury_api.debt_to_penny", lambda: s("treasury_api").fetch_debt_to_penny()),
        ("cftc.cot", lambda: s("cftc").fetch_positioning(years=[2026])),
        ("ecb.corp_yields", lambda: s("ecb").fetch_corporate_yields()),
        ("world_bank.debt", lambda: s("world_bank").fetch_debt_snapshot()),
        ("world_bank.credit_gap_proxy", lambda: s("world_bank").fetch_credit_gap_proxy()),
        ("sec_edgar.leverage", lambda: s("sec_edgar").leverage_screen()),
        ("bcb.selic", lambda: s("bcb").fetch_selic()),
        ("yf_futures.panel", lambda: s("yf_futures").fetch_futures_panel()),
        ("yf_options.snapshot", lambda: s("yf_options").snapshot_all()),
        ("yf_fx.panel", lambda: s("yf_fx").fetch_fx_panel()),
        ("finra.trace", lambda: s("finra").fetch_breadth()),
        ("optional.alpaca", lambda: s("optional").fetch_alpaca_quote()),
        ("ndl.yield_curve", lambda: s("ndl").fetch_yield_curve(rows=120)),
        ("polygon.options", lambda: s("polygon").snapshot_all()),
    ]


def run_probe(verbose: bool = True) -> list[SourceStatus]:
    if verbose:
        print("=" * 74)
        print("  GCO SOURCE PROBE")
        print("=" * 74)
    statuses = []
    for name, loader in loaders():
        t0 = time.time()
        st = _probe(name, loader)
        if verbose:
            mark = "OK  " if st.available else "FAIL"
            print(f"  [{mark}] {name:<26} {time.time() - t0:5.1f}s {st.detail[:110]}")
        statuses.append(st)
    write_probe_report([s.to_dict() for s in statuses])
    n_ok = sum(1 for s in statuses if s.available)
    if verbose:
        print(f"\n  {n_ok}/{len(statuses)} sources available. "
              f"Report -> {__import__('config').SOURCE_PROBE_FILE}")
    return statuses


if __name__ == "__main__":
    run_probe()
