"""EM public debt: ETF proxies -> dealer markup -> volatility matrix."""
from __future__ import annotations

import pandas as pd

from engine import bonds_EM_data, dealer_markup
from pipelines.volatility_strategy import run_volatility_spectrum

_EM_TIER_ORDER = ["EM_USD_Sovereign", "EM_Corporate", "EM_High_Yield",
                  "EM_Local_Currency"]


def _em_spread_pairs(df_raw: pd.DataFrame) -> pd.DataFrame:
    """Adjacent-tier bps pairs (mirror of the US grade-pair construction)."""
    available = [c for c in _EM_TIER_ORDER if c in df_raw.columns]
    pairs = {}
    for riskier, safer in zip(available[1:], available[:-1]):
        pairs[f"{riskier} - {safer}"] = df_raw[riskier] - df_raw[safer]
    return pd.DataFrame(pairs).dropna(axis=1, how="all")


def run_em_public(trade_size_millions: float, hold_days: int,
                  percentiles: list[int] | None = None) -> None:
    print("=" * 75)
    print("  EMERGING MARKETS (USD & LOCAL) - MATRIX ONLY")
    print("=" * 75)

    df_raw = bonds_EM_data.get_em_market_data()
    if df_raw.empty:
        print("  [CRITICAL] EM dataframe empty. Aborting.")
        return
    dealer_markup.run()
    df_pairs = _em_spread_pairs(df_raw)

    run_volatility_spectrum(df_raw, df_pairs, "Emerging Markets",
                            trade_size_millions, hold_days, percentiles)