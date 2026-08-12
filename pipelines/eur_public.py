"""EUR public corporate bonds: ETF proxies -> dealer markup -> volatility matrix."""
from __future__ import annotations

import pandas as pd

from engine import bonds_EUR_data, dealer_markup, eur_country
from pipelines.volatility_strategy import run_volatility_spectrum


def _eur_spread_pairs(df_raw: pd.DataFrame) -> pd.DataFrame:
    """Adjacent-tier bps pairs (mirror of the US grade-pair construction)."""
    order = ["EUR_IG_OAS", "EUR_HY_OAS"]
    available = [c for c in order if c in df_raw.columns]
    pairs = {}
    for riskier, safer in zip(available[1:], available[:-1]):
        pairs[f"{riskier} - {safer}"] = df_raw[riskier] - df_raw[safer]
    return pd.DataFrame(pairs).dropna(axis=1, how="all")


def run_eur_public(trade_size_millions: float, hold_days: int,
                   percentiles: list[int] | None = None) -> None:
    print("=" * 75)
    print("  EUR PUBLIC CORPORATE BONDS (ETFs) - MATRIX + COUNTRY PANEL")
    print("=" * 75)

    df_raw = bonds_EUR_data.get_eur_market_data()
    if df_raw.empty:
        print("  [CRITICAL] European data empty. Aborting.")
        return
    dealer_markup.run()
    df_pairs = _eur_spread_pairs(df_raw)

    run_volatility_spectrum(df_raw, df_pairs, "Europe",
                            trade_size_millions, hold_days, percentiles)
    eur_country.run_country_analysis(trade_size_millions, hold_days,
                                     percentile=percentiles[0] if percentiles else None)