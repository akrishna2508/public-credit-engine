"""VAR forecasting pipeline for pure bond yields (bps), one panel per rating."""
from __future__ import annotations

import json
import math
import warnings

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd
from statsmodels.tsa.api import VAR
from statsmodels.tsa.stattools import adfuller, kpss as kpss_test

import config

warnings.filterwarnings("ignore")

HIERARCHY = ["AAA", "AA", "A", "BBB", "Fallen_Angel", "BB", "B", "CCC"]
COLORS = ["#1D3557", "#457B9D", "#2A9D8F", "#E9C46A", "#F4A261", "#E63946", "#D62828", "#6A040F"]


def load_and_prep_yields(filepath: str, include_fallen_angels: bool = False) -> pd.DataFrame:
    with open(filepath) as f:
        data = json.load(f)
    df = pd.DataFrame(data)
    df.index = pd.to_datetime(df.index)
    df = df.astype(float) * 100  # percent -> bps

    hierarchy = list(HIERARCHY)
    if not include_fallen_angels:
        hierarchy.remove("Fallen_Angel")
    ordered_cols = [c for c in hierarchy if c in df.columns]
    df = df[ordered_cols]
    df = df.resample("B").last().ffill().dropna()

    # Financially immaterial jitter to keep VAR covariance positive-definite.
    # Deterministic local RNG (seed 42), scale 1e-8 bps — documented safeguard.
    _local_rng = np.random.RandomState(seed=config.VAR_JITTER_SEED)
    df = df + _local_rng.normal(0, config.VAR_JITTER_SCALE, df.shape)
    return df


def ensure_stationarity(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    differenced: dict[str, pd.Series] = {}
    was_differenced: dict[str, bool] = {}
    for col in df.columns:
        series = df[col].dropna()
        adf_p = adfuller(series, autolag="AIC")[1]
        try:
            kpss_p = kpss_test(series, regression='c', nlags='auto')[1]
        except Exception:
            kpss_p = 0.05
        is_stationary = (adf_p < config.SIGNIFICANCE_ALPHA) and (kpss_p > config.SIGNIFICANCE_ALPHA)
        was_differenced[col] = not is_stationary
        differenced[col] = series if is_stationary else series.diff().dropna()
    stat_df = pd.DataFrame(differenced).dropna()
    stat_df.index.freq = pd.tseries.frequencies.to_offset("B")
    return stat_df, was_differenced


def select_lag_order(stat_df: pd.DataFrame, max_lags: int) -> int:
    return max(1, int(VAR(stat_df).select_order(maxlags=max_lags).aic))


def forecast_and_irf(fitted_model, stat_df: pd.DataFrame, original_df: pd.DataFrame,
                     was_diff: dict, horizon: int) -> dict:
    cols = list(stat_df.columns)
    lag_order = fitted_model.k_ar
    raw_fc = fitted_model.forecast(stat_df.values[-lag_order:], steps=horizon)
    future_dates = pd.bdate_range(start=original_df.index[-1], periods=horizon + 1)[1:]
    forecast_df = pd.DataFrame(raw_fc, index=future_dates, columns=cols)

    forecast_levels: dict[str, pd.Series] = {}
    for col in cols:
        forecast_levels[col] = (original_df[col].iloc[-1] + forecast_df[col].cumsum()
                                if was_diff.get(col, False) else forecast_df[col])
    return {
        "forecast_df": pd.DataFrame(forecast_levels, index=future_dates),
        "irf": fitted_model.irf(periods=horizon),
        "future_dates": future_dates,
        "cols": cols,
    }


def plot_pure_forecast(original_df: pd.DataFrame, forecast_results: dict) -> None:
    cols, forecast_df, future_dates = (forecast_results["cols"], forecast_results["forecast_df"],
                                       forecast_results["future_dates"])
    n = len(cols)
    fig, axes = plt.subplots(n, 1, figsize=(15, 3.5 * n), sharex=False)
    for ax, col, color in zip(axes, cols, COLORS[:n]):
        hist_vals = original_df[col][original_df.index >= (original_df.index[-1] - pd.DateOffset(months=3))]
        fc_vals = forecast_df[col]
        ax.plot(hist_vals.index, hist_vals.values, color=color, linewidth=1.5, label="Historical (3 months)")
        ax.axvline(original_df.index[-1], color="black", linewidth=1.5, linestyle="--", alpha=0.5, label="Today")
        ax.axvspan(future_dates[0], future_dates[-1], alpha=0.10, color="#FF0000")
        ax.plot(fc_vals.index, fc_vals.values, color="#FF0000", linewidth=2.5, linestyle="--",
                marker="o", markersize=4, markerfacecolor="white", label="VAR Forecast")
        ax.set_title(f"{col} Pure Bond Yield (bps)", fontsize=10, fontweight="bold")
        ax.set_ylabel("Yield (bps)")
        ax.grid(True, alpha=0.25)
        ax.legend(fontsize=8, loc="upper left")
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=5))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b %Y"))
        plt.setp(ax.get_xticklabels(), rotation=45, ha="right", fontsize=8)
    fig.suptitle("VAR Forecast - Pure Bond Yields (bps)", fontsize=14, fontweight="bold", y=1.01)
    plt.tight_layout()
    plt.savefig("pure_yield_forecast.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


def plot_pure_irf(forecast_results: dict) -> None:
    cols, irf, future_dates = (forecast_results["cols"], forecast_results["irf"],
                               forecast_results["future_dates"])
    n = len(cols)
    irf_dates = [future_dates[0] - pd.tseries.offsets.BDay(1)] + list(future_dates)
    configs = [
        {"data": irf.irfs, "img_file": "irf_pure_yield_matrix_1bps.png",
         "title": "IRF: 1 bps Absolute Yield Shock"},
        {"data": irf.orth_irfs, "img_file": "irf_pure_yield_matrix_stddev.png",
         "title": "IRF: 1 Std-Dev Yield Shock"},
    ]
    for cfg in configs:
        fig, axes = plt.subplots(n, n, figsize=(3 * n, 2.5 * n), sharex=False)
        for shock_idx in range(n):
            for resp_idx in range(n):
                ax = axes[resp_idx, shock_idx]
                response = cfg["data"][:, resp_idx, shock_idx]
                color = COLORS[resp_idx % len(COLORS)]
                ax.plot(irf_dates, response, color=color, linewidth=1.5)
                ax.fill_between(irf_dates, response, 0,
                                where=(response > 0), alpha=0.2, color=color)
                ax.fill_between(irf_dates, response, 0,
                                where=(response < 0), alpha=0.2, color="#AAAAAA")
                ax.axhline(0, color="black", linewidth=0.8, linestyle="--", alpha=0.4)
                if resp_idx == 0:
                    ax.set_title(f"Shock to {cols[shock_idx]}", fontsize=10, fontweight="bold")
                if shock_idx == 0:
                    ax.set_ylabel(f"Resp: {cols[resp_idx]}\n(bps change)", fontsize=8, fontweight="bold")
                ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
                ax.xaxis.set_major_locator(mdates.DayLocator(interval=max(1, len(irf_dates) // 3)))
                ax.tick_params(axis='x', rotation=45, labelsize=7)
                ax.grid(True, alpha=0.2)
        fig.suptitle(cfg["title"], fontsize=16, fontweight="bold", y=1.02)
        plt.tight_layout(h_pad=1.0, w_pad=0.5)
        plt.savefig(cfg["img_file"], dpi=150, bbox_inches="tight")
        plt.close(fig)


def run_pure_yield_forecast(filepath: str, include_fallen_angels: bool = False,
                            horizon: int | None = None) -> dict:
    print("\n" + "=" * 65)
    print("  VAR PIPELINE - Pure Bond Yield Forecasting")
    print("=" * 65)
    horizon = horizon if horizon is not None else config.DEFAULT_FORECAST_HORIZON
    df = load_and_prep_yields(filepath, include_fallen_angels=include_fallen_angels)
    T = len(df)
    dynamic_max_lags = math.floor(12 * ((T / 100) ** 0.25)) if T > 0 else 12
    stat_df, was_diff = ensure_stationarity(df)
    lag = select_lag_order(stat_df, dynamic_max_lags)
    model = VAR(stat_df).fit(lag)
    results = forecast_and_irf(model, stat_df, df, was_diff, horizon)
    print("  [Rendering] Plotting Historic vs Forecast Yields...")
    plot_pure_forecast(df, results)
    print("  [Rendering] Plotting IRF Contagion Matrices...")
    plot_pure_irf(results)
    print("  [Success] Pure Yield analysis complete. Images saved.")
    return results


def main() -> None:
    run_pure_yield_forecast(config.USA_BOND_RETURNS_FILE, include_fallen_angels=False)


if __name__ == "__main__":
    main()