"""CFTC Commitment of Traders — Traders in Financial Futures (TFF) positioning.

Free keyless weekly data. The current (post-2021) format is CSV with a header
row and Dealer / Asset Manager / Leveraged Money position buckets. Supported
markets: Treasury notes/bonds, SOFR, and the Bloomberg IG/HY credit futures —
all real rate/credit positioning.

The parser is grounded in a real downloaded fixture (data/fixtures/fin_fut_2026.csv).
"""
from __future__ import annotations

import csv
import io
import zipfile
from datetime import date

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable, cache_json

# TFF CSV column names -> internal mapping.
COL_LONG = {
    "Dealer_Positions_Long_All": "Dealer_Long",
    "Dealer_Positions_Short_All": "Dealer_Short",
    "Asset_Mgr_Positions_Long_All": "AssetMgr_Long",
    "Asset_Mgr_Positions_Short_All": "AssetMgr_Short",
    "Lev_Money_Positions_Long_All": "LevMoney_Long",
    "Lev_Money_Positions_Short_All": "LevMoney_Short",
}
OI_COL = "Open_Interest_All"
DATE_COL = "Report_Date_as_YYYY-MM-DD"
MARKET_COL = "Market_and_Exchange_Names"


def download_year_text(year: int) -> str:
    """Download fut_fin_txt_{year}.zip and return the inner FinFutYY.txt text."""
    url = config.CFTC_FIN_FUT_URL.format(year=year)
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        zf = zipfile.ZipFile(io.BytesIO(resp.content))
        member = [n for n in zf.namelist() if n.lower().startswith("finfut")]
        if not member:
            raise SourceUnavailable("cftc", f"{year} archive has no FinFut file")
        return zf.read(member[0]).decode("utf-8", errors="replace")
    except requests.RequestException as e:
        raise SourceUnavailable("cftc", f"download failed for {year}: {e}",
                                "verify https://www.cftc.gov/MarketReports/CommitmentsofTraders") from e


def parse_tff_text(text: str) -> pd.DataFrame:
    """Parse TFF CSV text into a long-form DataFrame (market, date, positions).

    Returns rows only for markets the report actually contains; columns are
    the internal names above. Any parsing failure is a data error, not a
    placeholder. If the text is the legacy (non-CSV) format, the caller gets
    an empty frame and a recorded reason via the raised error.
    """
    reader = csv.reader(io.StringIO(text))
    try:
        header = next(reader)
    except StopIteration:
        raise SourceUnavailable("cftc", "empty COT file")
    header = [h.strip() for h in header]
    if MARKET_COL not in header:
        raise SourceUnavailable("cftc", "unexpected COT format (expected TFF CSV header)",
                                "CFTC changed format; supported from the 2021 TFF layout onwards")

    def col(name: str) -> int:
        return header.index(name) if name in header else -1

    idx = {internal: col(header) for header, internal in COL_LONG.items()}
    idx["oi"] = col(OI_COL)
    idx["date"] = col(DATE_COL)
    idx["market"] = col(MARKET_COL)
    if any(v < 0 for v in idx.values()):
        missing = [k for k, v in idx.items() if v < 0]
        raise SourceUnavailable(
            "cftc", f"TFF header missing required columns: {missing}",
            "CFTC changed the TFF layout; re-check column names before parsing")
    rows = []
    for raw in reader:
        if len(raw) <= max(idx.values()):
            continue
        market = raw[idx["market"]].strip()
        market = " ".join(market.split())  # collapse whitespace
        date_str = raw[idx["date"]].strip()
        row = {"market": market, "report_date": date_str}
        ok = True
        for out_name in COL_LONG.values():
            try:
                row[out_name] = float(raw[idx[out_name]].strip())
            except ValueError:
                row[out_name] = float("nan")
        try:
            row["open_interest"] = float(raw[idx["oi"]].strip())
        except ValueError:
            row["open_interest"] = float("nan")
        try:
            pd.Timestamp(date_str)
        except Exception:
            ok = False
        if ok:
            rows.append(row)
    if not rows:
        raise SourceUnavailable("cftc", "no parseable rows in COT file")
    return pd.DataFrame(rows)


def fetch_positioning(years: list[int] | None = None) -> pd.DataFrame:
    """Fetch and parse COT for the given years (default: current + 4 prior).

    Each year's download is disk-cached for a week (TTL) so repeat runs do
    not re-download the annual zips. Returns the concatenated long-form
    DataFrame for ALL markets present."""
    if years is None:
        current = date.today().year
        years = list(range(current - 4, current + 1))
    frames = []
    for year in years:
        try:
            text = cache_json(f"cftc_year_{year}", 7.0,
                              lambda y=year: download_year_text(y))
            frames.append(parse_tff_text(text))
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] COT {year}: {e}")
    if not frames:
        raise SourceUnavailable("cftc", "no COT data across requested years")
    return pd.concat(frames, ignore_index=True)


def filter_markets(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only the configured rate/credit markets.

    Market names in the real TFF files carry an exchange suffix
    ("UST 10Y NOTE - CHICAGO BOARD OF TRADE"), so matching is by prefix
    against the configured name. Exact-match would silently drop every row.
    """
    wanted = tuple(config.COT_MARKET_QUERIES.values())
    return df[df["market"].str.startswith(wanted)].reset_index(drop=True)


def pivot_by_market(df: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Per-market time series: index = report_date, columns = position buckets."""
    out: dict[str, pd.DataFrame] = {}
    for name in config.COT_MARKET_QUERIES.values():
        sub = df[df["market"].str.startswith(name)].copy()
        if sub.empty:
            continue
        sub["report_date"] = pd.to_datetime(sub["report_date"])
        sub = sub.drop_duplicates(subset=["report_date"], keep="last").set_index("report_date").sort_index()
        out[name] = sub
    return out


def save_fixture(text: str, path: str = "data/fixtures/fin_fut_2026.csv") -> None:
    """Persist a downloaded file as a test fixture (test-only helper)."""
    with open(path, "w") as f:
        f.write(text)


if __name__ == "__main__":
    txt = download_year_text(2026)
    save_fixture(txt)
    parsed = parse_tff_text(txt)
    print(parsed["market"].nunique(), "markets;", len(parsed), "rows")
    filt = filter_markets(parsed)
    print(filt.groupby("market")["report_date"].nunique())
