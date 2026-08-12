"""Shared volatility-spectrum pipeline (used by US, EUR, EM public markets)."""
from __future__ import annotations

import numpy as np
import pandas as pd

import config
from engine import volatility, volatility_matrix


def _curve_summary_table(curves: dict, hold_days: int, region_png: str) -> None:
    """Print per-item curve summary: net at the CLI hold AND first positive T
    (returns are horizon curves, not single fixed-period metrics)."""
    if not curves:
        return
    rows = []
    for name, df in curves.items():
        if df is None or df.empty:
            continue
        at_hold_gr = df.loc[hold_days, "Gross_bps"] if hold_days in df.index else np.nan
        at_hold_hf = df.loc[hold_days, "HF_net_bps"] if hold_days in df.index else np.nan
        at_hold_rt = df.loc[hold_days, "Ret_net_bps"] if hold_days in df.index else np.nan
        rows.append([name,
                     f"{at_hold_gr:+.2f}" if pd.notna(at_hold_gr) else "n/a",
                     f"{at_hold_hf:+.2f}" if pd.notna(at_hold_hf) else "n/a",
                     f"{at_hold_rt:+.2f}" if pd.notna(at_hold_rt) else "n/a",
                     str(volatility.first_positive_hold(df, "HF_net_bps")),
                     str(volatility.first_positive_hold(df, "Ret_net_bps"))])
    if not rows:
        return
    print("\n  Return curves (bps, by hold days; gross = Tier 1 payout, "
          "nets = after dealer markup + friction):")
    print(f"    {'asset':<16} {'gross@T':>8} {'HF@T':>7} {'retail@T':>9} "
          f"{'HF>=0 at T':>11} {'retail>=0 at T':>14}")
    for r in rows:
        print(f"    {r[0]:<16} {r[1]:>8} {r[2]:>7} {r[3]:>9} {r[4]:>11} {r[5]:>14}")
    print(f"    (full curves: {region_png} — three views: "
          "gross / HF net / retail net, one line per item, legend + zero line)")


def _plot_curves(series: dict, region_name: str, percentile: int,
                 retail_markup: pd.Series, trade_size_millions: float,
                 hold_days: int, tag: str) -> dict:
    curves = {}
    for a, s in series.items():
        s = s.rename(a)
        curves[a] = volatility.return_curve(s, percentile, retail_markup,
                                            trade_size_millions=trade_size_millions)
    stem = f"{region_name.replace(' ', '_').lower()}_{tag}_return_curves"
    views = [("gross", "Gross_bps", False),
             ("hf_net", "HF_net_bps", True),
             ("retail_net", "Ret_net_bps", True)]
    for view, col, dashed in views:
        volatility_matrix.plot_return_curve_view(curves, f"{region_name} ({tag})",
                                                 percentile, f"{stem}_{view}.png",
                                                 column=col, dashed=dashed)
    _curve_summary_table(curves, hold_days, f"{stem}_*.png")
    return curves


def run_volatility_spectrum(df_raw: pd.DataFrame, df_spreads: pd.DataFrame | None,
                            region_name: str, trade_size_millions: float,
                            hold_days: int, percentiles: list[int] | None = None) -> None:
    """Run pure-asset and spread-pair shock/normal returns across percentile bands."""
    percentiles = percentiles or config.VOLATILITY_PERCENTILES
    skip_cols = list(config.SKIP_VOL_COLS)
    assets = [c for c in df_raw.columns if c not in skip_cols]

    index = df_raw.index
    retail_markup = volatility.load_dealer_markup(index)

    volatility_matrix.generate_yield_tables(df_raw[assets], hold_days, region_name)

    all_pure = []
    for pct in percentiles:
        print(f"\n  [SIMULATION] Running {pct}th Percentile Volatility Threshold (PURE)...")
        results = volatility.analyze_strategy(
            series_dict={a: df_raw[a] for a in assets},
            index=index, percentile=pct, trade_size_millions=trade_size_millions, hold_days=hold_days,
            retail_markup=retail_markup,
        )
        for r in results:
            r["Percentile"] = pct
        all_pure.extend(results)

    volatility_matrix.generate_spectrum_matrices(assets, percentiles, all_pure,
                                                 hold_days, f"{region_name} (Pure)")
    print(f"\n  [RETURN CURVES] {region_name} pure assets at the {config.GARCH_SIGNAL_PERCENTILE}th "
          f"percentile (hold-horizon view, not fixed-period):")
    _plot_curves({a: df_raw[a] for a in assets}, region_name,
                 config.GARCH_SIGNAL_PERCENTILE, retail_markup,
                 trade_size_millions, hold_days, "pure")

    if df_spreads is not None and not df_spreads.empty:
        pairs = list(df_spreads.columns)
        all_pairs = []
        for pct in percentiles:
            print(f"\n  [SIMULATION] Running {pct}th Percentile Volatility Threshold (SPREAD)...")
            results = volatility.analyze_strategy(
                series_dict={p: df_spreads[p] for p in pairs},
                index=index, percentile=pct, trade_size_millions=trade_size_millions, hold_days=hold_days,
                retail_markup=retail_markup,
            )
            for r in results:
                r["Percentile"] = pct
            all_pairs.extend(results)

        volatility_matrix.generate_spectrum_matrices(pairs, percentiles, all_pairs,
                                                     hold_days, f"{region_name} (Spread)")
        print(f"\n  [RETURN CURVES] {region_name} spread pairs at the "
              f"{config.GARCH_SIGNAL_PERCENTILE}th percentile:")
        _plot_curves({p: df_spreads[p] for p in pairs}, region_name,
                     config.GARCH_SIGNAL_PERCENTILE, retail_markup,
                     trade_size_millions, hold_days, "spread")