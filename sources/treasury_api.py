"""US Treasury Fiscal Data API: auction results (demand proxy) + debt snapshot.

Keyless and free. Auction bid-to-cover ratio is a real, tradeable demand
signal for Treasury supply; security terms cover the full curve. Fields come
back as strings with literal "null" for missing values — cast defensively
(NaN for missing, never a fabricated number).
"""
from __future__ import annotations

import math
from typing import Any

import pandas as pd
import requests

import config
from sources.registry import (SourceUnavailable, cache_json, status_from_series,
                              SourceStatus)


def _get(url: str, params: dict[str, Any]) -> list[dict]:
    try:
        resp = requests.get(url, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        raise SourceUnavailable("treasury_api", f"request failed: {e}",
                                "verify connectivity; endpoint is keyless") from e
    data = payload.get("data")
    if data is None:
        raise SourceUnavailable("treasury_api", "response has no data",
                                "dataset may have been renamed; see fiscaldata.treasury.gov")
    return data


def _clean(value: Any) -> float:
    """String field -> float; literal 'null' and empty -> NaN (not 0.0)."""
    if value is None or value == "null" or value == "":
        return math.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def fetch_auctions(limit: int = 250) -> pd.DataFrame:
    """Recent auction results: date, security type/term, yield, bid-to-cover."""
    def _loader() -> list[dict]:
        return _get(config.TREASURY_AUCTION_BASE,
                    {"sort": "-auction_date", "limit": limit, "format": "json"})

    raw = cache_json(f"treasury_auctions_{limit}", 0.5, _loader)
    df = pd.DataFrame(raw)
    if df.empty:
        raise SourceUnavailable("treasury_api", "auctions_query returned no rows")
    keep = ["auction_date", "security_type", "security_term",
            "high_yield", "avg_med_yield", "high_discount_rate",
            "bid_to_cover_ratio", "total_offered_amount", "total_tendered_amount",
            "total_accepted_amount"]
    for col in keep:
        if col not in df.columns:
            df[col] = math.nan
    df = df[keep].copy()
    df["auction_date"] = pd.to_datetime(df["auction_date"], errors="coerce")
    for col in df.columns:
        if col != "auction_date" and col not in ("security_type", "security_term"):
            df[col] = df[col].map(_clean)
    df = df.dropna(subset=["auction_date"]).sort_values("auction_date").reset_index(drop=True)
    return df


def parse_par_yield_csv(text: str) -> pd.DataFrame:
    """Parse the daily_treasury_yield_curve CSV into a date-indexed frame with
    one column per tenor ('10 Yr', '2 Yr', ...). Pure (no I/O); raises
    SourceUnavailable on a payload it cannot trust."""
    from datetime import datetime
    lines = [l for l in text.replace("\r", "").strip().split("\n") if l.strip()]
    if not lines or "Date" not in lines[0]:
        raise SourceUnavailable("treasury_api", "par-yield payload unexpected",
                                "re-check the daily_treasury_yield_curve CSV")
    header = [h.strip().strip('"') for h in lines[0].split(",")]
    out: list[dict] = []
    for line in lines[1:]:
        cols = line.split(",")
        try:
            d = datetime.strptime(cols[0].strip().strip('"'), "%m/%d/%Y").date()
        except (ValueError, IndexError):
            continue
        rec: dict = {"date": d.isoformat()}
        for i in range(1, min(len(header), len(cols))):
            v = _clean(cols[i].strip().strip('"'))
            if v == v:  # not NaN
                rec[header[i]] = v
        out.append(rec)
    if not out:
        raise SourceUnavailable("treasury_api", "par-yield CSV had no rows")
    df = pd.DataFrame(out)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"]).set_index("date").sort_index()
    # keep every tenor the header declared, NaN where a row left it blank —
    # a sparse row must not silently drop a column
    return df.reindex(columns=header[1:])


def fetch_par_yield_curve(year: int | None = None) -> pd.DataFrame:
    """Official daily US Treasury par yield curve (keyless, home.treasury.gov).

    Publishes the SAME business day (~4pm ET) — a day ahead of FRED's DGS
    constant-maturity series, which are derived from it. The raw CSV text is
    cached 0.2d (JSON-serializable); raises SourceUnavailable (never a
    fabricated number) if the endpoint blocks or the CSV schema changes."""
    from datetime import datetime, timezone
    year = year or datetime.now(timezone.utc).year

    def _loader() -> str:
        url = (f"https://home.treasury.gov/resource-center/data-chart-center/"
               f"interest-rates/daily-treasury-rates.csv/{year}/all"
               f"?type=daily_treasury_yield_curve&field_tdr_date_value={year}"
               f"&page&_format=csv")
        try:
            resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0 (PublicCredit/1.0)"},
                                timeout=30)
            resp.raise_for_status()
        except Exception as e:
            raise SourceUnavailable("treasury_api", f"par-yield request failed: {e}",
                                    "keyless endpoint; verify connectivity") from e
        return resp.text

    return parse_par_yield_csv(cache_json(f"treasury_par_yield_text_{year}", 0.2, _loader))


def fetch_debt_to_penny() -> pd.DataFrame:
    """Daily total public debt outstanding (record_date, amount). The dataset
    has been renamed/removed before; a 404 surfaces as UNAVAILABLE, never a
    fabricated number."""
    def _loader() -> list[dict]:
        return _get(config.TREASURY_DEBT_BASE, {"sort": "-record_date", "limit": 60, "format": "json"})

    raw = cache_json("treasury_debt_to_penny", 1.0, _loader)
    df = pd.DataFrame(raw)
    if df.empty:
        raise SourceUnavailable("treasury_api", "debt_to_penny returned no rows")
    date_col = next((c for c in ("record_date", "record_calendar_date") if c in df.columns), None)
    amt_col = next((c for c in df.columns
                    if "total_public_debt_outstanding" in c or "tot_pub_debt_out_amt" in c), None)
    if date_col is None or amt_col is None:
        raise SourceUnavailable("treasury_api", "debt_to_penny schema changed",
                                "re-check field names at fiscaldata.treasury.gov")
    out = pd.DataFrame({
        "record_date": pd.to_datetime(df[date_col], errors="coerce"),
        "debt_outstanding": df[amt_col].map(_clean),
    }).dropna().sort_values("record_date")
    return out


def latest_bid_to_cover_by_term(auctions: pd.DataFrame) -> pd.DataFrame:
    """Latest bid-to-cover per security term (real demand proxy, NaN if absent)."""
    if auctions.empty:
        return pd.DataFrame()
    out = auctions.sort_values("auction_date").groupby("security_term").tail(1)
    return out[["auction_date", "security_type", "security_term", "bid_to_cover_ratio"]]


def status_report() -> SourceStatus:
    try:
        auctions = fetch_auctions(limit=25)
    except SourceUnavailable as e:
        return SourceStatus(name="treasury_api", available=False, detail=str(e))
    return status_from_series("treasury_api", auctions.set_index("auction_date"))
