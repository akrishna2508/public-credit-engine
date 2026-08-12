"""US public corporate bond yield spreads via FRED ICE BofA series + ANGL ETF proxy."""
from __future__ import annotations

import json

import pandas as pd

import config


def fetch_fred_series(series_id: str) -> dict[str, float]:
    """Return {date: value} dict; skips '.' sentinel values.

    Uses the retry-backed session from engine.data_engine (single FRED path)."""
    from engine.data_engine import get_secure_session
    resp = get_secure_session().get(
        config.FRED_BASE_URL,
        params={"series_id": series_id, "api_key": config.get_fred_key(),
                "file_type": "json", "sort_order": "asc"},
        timeout=30,
    )
    if not resp.ok:
        resp.raise_for_status()
    raw = resp.json()
    return {o["date"]: float(o["value"]) for o in raw.get("observations", []) if o.get("value", ".") != "."}


def fetch_all_bond_returns(rating_order: list[str], series_map: dict) -> dict:
    bond_returns: dict[str, dict] = {}
    for rating in rating_order:
        sid = series_map.get(rating)
        if rating == "Fallen_Angel":
            print("  [API] Fetching Fallen Angel Proxy (ANGL ETF) via yfinance...")
            try:
                from engine.data_engine import fetch_etf_yield
                yld = fetch_etf_yield("ANGL")
                bond_returns[rating] = {str(d.date()): float(v) for d, v in yld.items()}
                print(f"  OK   {rating:<12} (Dynamic ANGL Yield) -> {len(bond_returns[rating])} obs")
            except Exception as e:
                print(f"  FAIL {rating:<12} (ANGL Proxy) -> {e}")
            continue
        try:
            data = fetch_fred_series(sid)
            if data:
                bond_returns[rating] = data
                print(f"  OK   {rating:<12} ({sid}) -> {len(data)} obs")
        except Exception as e:
            print(f"  ERROR {rating:<12} ({sid}) -> {e}")
    return bond_returns


def get_adjacent_pairs(rating_order: list[str]) -> list[tuple[str, str]]:
    return list(zip(rating_order, rating_order[1:]))


def compute_spreads_pct(bond_returns: dict) -> dict:
    spreads_pct: dict[str, dict] = {}
    available = [r for r in config.SPREAD_ORDER if r in bond_returns]
    for lower, higher in get_adjacent_pairs(available):
        key = f"{higher} - {lower}"
        common = sorted(set(bond_returns[lower]) & set(bond_returns[higher]))
        if not common:
            continue
        spreads_pct[key] = {d: bond_returns[higher][d] - bond_returns[lower][d] for d in common}
    if "Fallen_Angel" in bond_returns and "BB" in bond_returns:
        common = sorted(set(bond_returns["BB"]) & set(bond_returns["Fallen_Angel"]))
        if common:
            spreads_pct["BB - Fallen_Angel"] = {
                d: bond_returns["BB"][d] - bond_returns["Fallen_Angel"][d] for d in common
            }
    return spreads_pct


def convert_to_bps(spreads_pct: dict) -> dict:
    return {pair: {d: round(v * 100, 2) for d, v in series.items()} for pair, series in spreads_pct.items()}


def merge_timeseries_dict(filepath, new_data: dict) -> dict:
    import os
    old_data: dict = {}
    if os.path.exists(filepath):
        try:
            with open(filepath) as f:
                old_data = json.load(f)
        except Exception:
            pass
    merged: dict = {}
    for key in set(old_data.keys()) | set(new_data.keys()):
        merged[key] = {}
        if key in old_data:
            merged[key].update(old_data[key])
        if key in new_data:
            merged[key].update(new_data[key])
        merged[key] = dict(sorted(merged[key].items()))
    return merged


def save_spread_jsons(merged_returns: dict, spreads_bps: dict) -> None:
    with open(config.USA_BOND_RETURNS_FILE, "w") as f:
        json.dump(merged_returns, f, indent=2)
    with open(config.USA_SPREAD_FILE, "w") as f:
        json.dump(spreads_bps, f, indent=2)


def print_spread_table(spreads_bps: dict) -> None:
    if not spreads_bps:
        return
    latest = max(d for s in spreads_bps.values() for d in s)
    print(f"\nLatest USA yield spreads as of {latest}:")
    print(f"{'Pair':<18} {'Date':<12} {'Spread (bps)':>14}")
    print(f"{'-'*18} {'-'*12} {'-'*14}")
    for pair, series in spreads_bps.items():
        d = list(series.keys())[-1]
        print(f"{pair:<18} {d:<12} {series[d]:>14.2f}")


def fetch_us_public_data() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Run full US fetch+merge+spread pipeline; return (df_raw, df_spreads) DataFrames."""
    new_bond_returns = fetch_all_bond_returns(config.FETCH_ORDER, config.US_BOND_SERIES)
    merged = merge_timeseries_dict(config.USA_BOND_RETURNS_FILE, new_bond_returns)
    spreads_pct = compute_spreads_pct(merged)
    spreads_bps = convert_to_bps(spreads_pct)
    save_spread_jsons(merged, spreads_bps)
    print_spread_table(spreads_bps)
    return prepare_pristine_data(config.USA_BOND_RETURNS_FILE)


def prepare_pristine_data(raw_filepath) -> tuple[pd.DataFrame, pd.DataFrame]:
    import os
    if not os.path.exists(raw_filepath):
        raise FileNotFoundError(f"Could not find {raw_filepath}")
    with open(raw_filepath) as f:
        data = json.load(f)
    df_raw = pd.DataFrame(data)
    df_raw.index = pd.to_datetime(df_raw.index)
    df_raw = df_raw.sort_index().resample("B").last().ffill()
    df_raw = df_raw.astype(float) * 100.0  # numeric cast + yields (percent) to bps
    df_spreads = pd.DataFrame(index=df_raw.index)
    for riskier, safer in config.ADJACENT_PAIRS:
        if safer in df_raw.columns and riskier in df_raw.columns:
            df_spreads[f"{riskier} - {safer}"] = df_raw[riskier] - df_raw[safer]
    return df_raw, df_spreads.dropna(axis=1, how='all')


def main() -> None:
    fetch_us_public_data()


if __name__ == "__main__":
    main()
