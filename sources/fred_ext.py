"""FRED expansion: Treasury curve, Moody's, TIPS, macro anchors, regional credit.

All series are free FRED series fetched through the existing key + retry
session. Each group is availability-gated: a series that fails or is empty is
reported, never replaced with a fabricated value.
"""
from __future__ import annotations

import pandas as pd

import config
from sources.registry import SourceUnavailable


def _fetch(series_id: str) -> pd.Series:
    from engine.data_engine import fetch_fred_series
    try:
        s = fetch_fred_series(series_id)
    except Exception as e:
        raise SourceUnavailable(
            "fred", f"series {series_id} fetch failed: {e}",
            "Set a valid FRED_API_KEY in .env (free: https://fred.stlouisfed.org/docs/api/api_keys.html)") from e
    if s.empty:
        raise SourceUnavailable("fred", f"series {series_id} returned no observations",
                                "verify the series ID exists via FRED search; retry when key is valid")
    return s


# Human-readable FRED search queries per regional credit label.
_REGIONAL_SEARCH_QUERIES = {
    "EUR_HY_OAS": "ICE BofA Euro High Yield Index Option-Adjusted Spread",
    "EM_CORP_OAS": "ICE BofA Emerging Markets Corporate Plus Index Option-Adjusted Spread",
}


def resolve_credit_series_id(query: str) -> str | None:
    """Resolve an ICE BofA regional series ID via FRED search (real check,
    not assumption). Returns None when nothing matches."""
    try:
        from engine.default_rates import search_fred_series
        return search_fred_series(query)
    except Exception:
        return None


def fetch_group(series_ids: list[str], label: str) -> dict[str, pd.Series]:
    out: dict[str, pd.Series] = {}
    for sid in series_ids:
        try:
            out[sid] = _fetch(sid)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] {label} {sid}: {e}")
    return out


def fetch_treasury_curve() -> dict[str, pd.Series]:
    """Full nominal par yield curve (DGS1MO..DGS30)."""
    return fetch_group(config.FRED_TREASURY_CURVE_SERIES, "treasury_curve")


def fetch_moodys() -> dict[str, pd.Series]:
    """Moody's seasoned Aaa/Baa + Baa-Aaa spread (long-run credit cycle)."""
    return fetch_group(config.FRED_MOODY_SERIES, "moodys")


def fetch_tips() -> dict[str, pd.Series]:
    """TIPS constant-maturity real yields (5/10/30) -> real rate + breakevens."""
    return fetch_group(config.FRED_TIPS_SERIES, "tips")


def fetch_macro_anchors() -> dict[str, pd.Series]:
    """Funding-stress anchors: fed funds, SOFR, financial conditions indices."""
    return fetch_group(config.FRED_MACRO_SERIES, "macro")


def fetch_regional_credit() -> dict[str, pd.Series]:
    """ICE BofA EUR HY / EM corporate OAS via FRED (series IDs re-verified via
    FRED search at runtime; a missing ID is UNAVAILABLE, never substituted)."""
    out: dict[str, pd.Series] = {}
    for label, sid in config.FRED_EUR_EM_CREDIT_SERIES.items():
        try:
            out[label] = _fetch(sid)
        except SourceUnavailable:
            query = _REGIONAL_SEARCH_QUERIES.get(label, f"ICE BofA {label}")
            resolved = resolve_credit_series_id(query)
            if resolved:
                try:
                    out[label] = _fetch(resolved)
                except SourceUnavailable as e:
                    print(f"  [UNAVAILABLE] {label} (resolved {resolved}): {e}")
            else:
                print(f"  [UNAVAILABLE] {label}: {sid} not found on FRED and no search match")
    return out


def fetch_global_sovereign() -> dict[str, pd.Series]:
    """OECD long-term government bond yields (10Y, monthly) per country via
    FRED IRLTLT01{CC}M156N (full series IDs in config) + India
    (INDIRLTLT01STM). Only countries verified live are configured; a missing
    series is reported, never substituted. 2026-08-11 fix: the legacy
    GLOBAL_SOVEREIGN_COUNTRIES values were suffix fragments ("USM"), so the
    fetch built IRLTLT01USMM156N and every sovereign leg 400'd — the dict now
    holds full IDs and the fetch uses them directly."""
    out: dict[str, pd.Series] = {}
    for country, sid in config.GLOBAL_SOVEREIGN_COUNTRIES.items():
        try:
            out[country] = _fetch(sid)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] global_sovereign.{country}: {e}")
    try:
        out["IN"] = _fetch(config.INDIA_LONG_RATE_SERIES)
    except SourceUnavailable as e:
        print(f"  [UNAVAILABLE] global_sovereign.IN: {e}")
    if not out:
        raise SourceUnavailable("fred", "no global sovereign yield series returned data")
    return out


def fetch_em_sector_credit() -> dict[str, pd.Series]:
    """ICE BofA EM sector/ownership OAS splits (verified live 2026-08-10):
    overall, HY, Financials, Public-Sector, Private-Sector issuers."""
    out: dict[str, pd.Series] = {}
    for label, sid in config.FRED_EM_SECTOR_SERIES.items():
        try:
            out[label] = _fetch(sid)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] em_sector.{label}: {e}")
    return out


def fetch_inflation() -> dict[str, pd.Series]:
    """TIPS real yields (5/10/30) + nominal breakevens (5Y/10Y) — the
    real-rate vs inflation-expectation trade."""
    return fetch_group(list(config.FRED_INFLATION_SERIES.values()), "inflation")
