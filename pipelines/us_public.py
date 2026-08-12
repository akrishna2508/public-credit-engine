"""US public corporate bond pipeline: FRED spreads -> default analysis ->
forecast -> volatility spectrum."""
from __future__ import annotations

import config
from engine import analysis, dealer_markup, default_rates, spreads
from pipelines.volatility_strategy import run_volatility_spectrum


def run_us_public(trade_size_millions: float, hold_days: int,
                  percentiles: list[int] | None = None,
                  horizon: int | None = None) -> None:
    print("=" * 75)
    print("  USA PUBLIC CORPORATE BONDS (FRED) - FULL PIPELINE")
    print("=" * 75)

    df_raw, df_spreads = spreads.fetch_us_public_data()
    if df_raw is None or df_raw.empty:
        print("  [CRITICAL] US market data is empty. Aborting US pipeline.")
        return
    default_rates.run_default_analysis()
    try:
        analysis.run_analysis(horizon=horizon)
    except Exception as e:
        print(f"  [FORECAST SKIPPED] {e}")

    # Bootstrap the dealer-markup series from live MOVE/TNX so the volatility
    # spectrum never consumes the stale committed JSON (audit log gap #1).
    try:
        dealer_markup.run(bond_filepath=str(config.USA_BOND_RETURNS_FILE))
    except Exception as e:
        print(f"  [DEALER MARKUP UNAVAILABLE] {e}")

    run_volatility_spectrum(df_raw, df_spreads, "USA Public",
                            trade_size_millions, hold_days, percentiles)