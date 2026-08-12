"""SEC EDGAR companyconcept (keyless, free): corporate leverage by sector.

For a curated universe of liquid public borrowers (config.SEC_LEVERAGE_UNIVERSE)
we pull LongTermDebt and TotalAssets from 10-K annual filings and compute
LongTermDebt / TotalAssets per filer per year. Sectors with >=
SEC_SECTOR_MIN_FILERS filers get a median leverage level and a z-score vs
their own annual history (SEC_LEVERAGE_MIN_OBS minimum) — a real
balance-sheet screen on which industries are levered into the cycle.

EDGAR requires a descriptive User-Agent (config.SEC_USER_AGENT); the probe
uses it. Nothing here fabricates a ratio: a filer with no data is skipped,
a sector under the minimum filer count reports UNAVAILABLE.
"""
from __future__ import annotations

import time

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable, cache_json

ASSETS_CONCEPT = "Assets"


def _fetch_concept(cik: str, concept: str) -> list[dict]:
    """companyconcept entries: [{form, start, end, val, fy, fp}, ...].
    Raises SourceUnavailable on HTTP errors or missing data."""
    url = config.SEC_EDGAR_FACTS_URL.format(cik=cik, concept=concept)
    try:
        resp = requests.get(url, headers={"User-Agent": config.SEC_USER_AGENT,
                                          "Accept-Encoding": "gzip, deflate"},
                            timeout=60)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise SourceUnavailable("sec_edgar", f"CIK {cik} {concept}: {e}") from e
    units = data.get("units", {})
    entries = units.get("USD", []) if isinstance(units.get("USD"), list) else None
    if entries:
        return entries
    # companyconcept returns an empty object for high-cardinality concepts
    # (observed for Ford's us-gaap:Assets, 2026-08-10). Fall back to the
    # full companyfacts payload and filter the same tag locally.
    return _facts_concept(cik, concept)


def _facts_concept(cik: str, concept: str) -> list[dict]:
    """Filter one us-gaap concept out of the full companyfacts payload."""
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
    try:
        resp = requests.get(url, headers={"User-Agent": config.SEC_USER_AGENT,
                                          "Accept-Encoding": "gzip, deflate"},
                            timeout=120)
        resp.raise_for_status()
        facts = resp.json().get("facts", {})
    except requests.RequestException as e:
        raise SourceUnavailable("sec_edgar", f"CIK {cik} companyfacts: {e}") from e
    entries = facts.get("us-gaap", {}).get(concept, {}).get("units", {}).get("USD", [])
    if not entries:
        raise SourceUnavailable("sec_edgar", f"CIK {cik}: no USD {concept} entries (facts)")
    return entries


def annual_series(entries: list[dict]) -> pd.Series:
    """Latest 10-K value per fiscal year end (annual, not quarterly frames)."""
    rows = []
    for e in entries:
        form = str(e.get("form", ""))
        if "10-K" not in form and "20-F" not in form:
            continue
        try:
            end = pd.Timestamp(e["end"])
        except (KeyError, ValueError):
            continue
        val = e.get("val")
        if val is None or not isinstance(val, (int, float)):
            continue
        rows.append((end, float(val)))
    if not rows:
        return pd.Series(dtype=float)
    df = pd.DataFrame(rows, columns=["end", "val"])
    # keep the latest filed value for a given fiscal year end
    df = df.sort_values("end").groupby("end")["val"].last()
    return df.dropna().astype(float)


def filer_leverage(cik: str) -> pd.Series | None:
    """LongTermDebt / TotalAssets per fiscal year for one issuer.

    The debt concept falls back across config.SEC_DEBT_CONCEPTS (filers move
    between LongTermDebt / LongTermDebtNoncurrent / DebtAndCapitalLeaseOb-
    ligations over time). Foreign-GAAP filers (e.g. Toyota, JPY units) have
    no USD entries and are skipped — never converted."""
    debt = None
    for concept in config.SEC_DEBT_CONCEPTS:
        try:
            entries = cache_json(f"edgar_{cik}_{concept}", 7.0,
                                 lambda c=concept: _fetch_concept(cik, c))
            annual = annual_series(entries)
            if not annual.empty:
                debt = annual
                break
        except SourceUnavailable:
            continue
    try:
        assets = annual_series(cache_json(f"edgar_{cik}_Assets", 7.0,
                                          lambda: _fetch_concept(cik, ASSETS_CONCEPT)))
    except SourceUnavailable:
        assets = pd.Series(dtype=float)
    if debt is None or debt.empty or assets.empty:
        return None
    both = pd.concat([debt, assets], axis=1, join="inner").dropna()
    both.columns = ["debt", "assets"]
    lev = (both["debt"] / both["assets"]).replace([float("inf"), -float("inf")], float("nan")).dropna()
    return lev


def sector_leverage(sector: str, ciks: list[str]) -> pd.DataFrame | None:
    """Per-year median leverage across the sector's filers (annual index)."""
    series = []
    for cik in ciks:
        lev = filer_leverage(cik)
        if lev is not None and len(lev) > 0:
            series.append(lev.rename(cik))
    if len(series) < config.SEC_SECTOR_MIN_FILERS:
        return None
    frame = pd.concat(series, axis=1)
    med = frame.median(axis=1).dropna().sort_index()
    return pd.DataFrame({"leverage": med, "filers": int(len(series))})


def leverage_screen() -> dict[str, dict]:
    """Per-sector: latest median leverage, its z vs own annual history, and
    the 3y change. Sectors below the filer minimum are reported UNAVAILABLE."""
    out: dict[str, dict] = {}
    for sector, ciks in config.SEC_LEVERAGE_UNIVERSE.items():
        frame = sector_leverage(sector, ciks)
        if frame is None or frame.empty:
            out[sector] = {"status": "UNAVAILABLE",
                           "detail": "fewer than SEC_SECTOR_MIN_FILERS filers with data"}
            continue
        lev = frame["leverage"]
        latest = float(lev.iloc[-1])
        roll = lev.rolling(config.SEC_LEVERAGE_MIN_OBS, min_periods=config.SEC_LEVERAGE_MIN_OBS)
        mu, sd = roll.mean(), roll.std(ddof=0)
        z = float((latest - mu.iloc[-1]) / sd.iloc[-1]) if sd.iloc[-1] and sd.iloc[-1] > 0 else None
        chg3 = float(lev.iloc[-1] / lev.iloc[-4] - 1) if len(lev) >= 5 else None
        out[sector] = {
            "status": "OK", "as_of": str(lev.index.max().date()),
            "leverage": round(latest, 4), "leverage_z": round(z, 2) if z is not None else None,
            "chg_3y": round(chg3, 4) if chg3 is not None else None,
            "n_obs": int(len(lev)), "filers": int(frame["filers"].iloc[-1]),
        }
    return out


def _probe_universe_size() -> int:
    """Number of (sector, cik) pairs — for the probe report."""
    return sum(len(ciks) for ciks in config.SEC_LEVERAGE_UNIVERSE.values())


if __name__ == "__main__":
    t0 = time.time()
    screen = leverage_screen()
    for sector, rec in screen.items():
        if rec["status"] == "OK":
            print(f"  {sector:<12} lev={rec['leverage']:.3f} z={rec['leverage_z']} "
                  f"chg3y={rec['chg_3y']} filers={rec['filers']} obs={rec['n_obs']}")
        else:
            print(f"  {sector:<12} {rec['status']}")
    print(f"  ({time.time() - t0:.1f}s, {_probe_universe_size()} filer concepts cached 7d)")
