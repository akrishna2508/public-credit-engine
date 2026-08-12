"""Dealer markup derivation from MOVE (IV) vs realized TNX vol (RV)."""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import yfinance as yf

import config


def load_timeseries_data(filepath) -> pd.DataFrame:
    import os
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Could not find {filepath}")
    with open(filepath) as f:
        data = json.load(f)
    df = pd.DataFrame(data)
    df.index = pd.to_datetime(df.index)
    return df.sort_index().resample("B").last().ffill().dropna()


def calculate_realized_volatility(series: pd.Series, lookback_window: int = config.REALIZED_VOL_LOOKBACK,
                                  trading_days: int = config.TRADING_DAYS) -> pd.Series:
    """Annualized realized volatility of absolute daily bps changes (TNX in percent -> *100)."""
    series_bps = series * 100
    returns_bps = series_bps.diff().dropna()
    daily_vol = returns_bps.rolling(window=lookback_window).std()
    return (daily_vol * np.sqrt(trading_days)).dropna()


def fetch_macro_volatility_proxy(start_date: str, end_date: str) -> pd.DataFrame:
    print("  [API] Fetching ICE BofA MOVE Index (IV) and 10-Year Treasury Yield (RV)...")
    data = yf.download(["^MOVE", "^TNX"], start=start_date, end=end_date, progress=False)["Close"]
    if data.empty:
        raise ValueError("Failed to fetch macro volatility data from Yahoo Finance.")
    return data.ffill().dropna()


def calculate_dealer_markup(df_macro: pd.DataFrame, lookback: int = config.REALIZED_VOL_LOOKBACK) -> pd.Series:
    implied_vol = df_macro["^MOVE"]
    realized_vol = calculate_realized_volatility(df_macro["^TNX"], lookback_window=lookback)
    aligned = pd.concat([implied_vol, realized_vol], axis=1).dropna()
    aligned.columns = ["IV", "RV"]
    safe_rv = np.maximum(aligned["RV"], 0.0001)
    # Dealer comp = a share of the IV-RV premium over parity (1.0), not the full
    # ratio: the short-vol trader's carry IS the IV-RV gap, so charging 100% of
    # it as cost handed the whole collectible premium to the dealer. The share
    # keeps the markup monotone in IV stress while leaving the edge with the
    # strategy (calibrated 2026-08-11: full-ratio avg 1.174 / max 1.816 ->
    # shared avg ~1.05 / max ~1.25, floor 1.05).
    raw_markup = 1.0 + config.DEALER_MARKUP_PREMIUM_SHARE * (aligned["IV"] / safe_rv - 1.0)
    dynamic_markup = np.maximum(raw_markup, config.DEALER_MARKUP_FLOOR)  # dealer floor
    return dynamic_markup.rolling(window=config.DEALER_MARKUP_SMOOTHING_WINDOW).mean().bfill()


def run(bond_filepath=None, markup_filepath=None) -> None:
    bond_filepath = bond_filepath or str(config.USA_BOND_RETURNS_FILE)
    markup_filepath = markup_filepath or str(config.DEALER_MARKUP_FILE)

    try:
        df_bonds = load_timeseries_data(bond_filepath)
        start_date = df_bonds.index.min().strftime('%Y-%m-%d')
        end_date = df_bonds.index.max().strftime('%Y-%m-%d')
        df_macro = fetch_macro_volatility_proxy(start_date, end_date)
        daily_markup = calculate_dealer_markup(df_macro, lookback=config.REALIZED_VOL_LOOKBACK)
        final_markup = daily_markup.reindex(df_bonds.index).ffill().bfill()

        print("\n" + "=" * 50)
        print(" LATEST DYNAMIC DEALER MARKUPS")
        print("=" * 50)
        for date, markup in final_markup.tail(5).items():
            print(f"  {date.strftime('%Y-%m-%d'):<15} | {markup:>6.2f}x")
        print("-" * 50)
        print(f"  Historical Average Markup: {final_markup.mean():.2f}x")

        final_markup.index = final_markup.index.strftime('%Y-%m-%d')
        with open(markup_filepath, "w") as f:
            json.dump({"Dealer_Multiplier": final_markup.to_dict()}, f, indent=2)
    except Exception as e:
        print(f"[ERROR] {e}")


def main() -> None:
    run()


if __name__ == "__main__":
    main()