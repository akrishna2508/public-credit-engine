"""Johansen-augmented VAR/VECM forecasting for spread-minus-EL series."""
from __future__ import annotations

import json
import warnings

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import adfuller, grangercausalitytests, kpss as kpss_test
from statsmodels.tsa.api import VAR
from statsmodels.tsa.vector_ar.vecm import coint_johansen, VECM

import config

warnings.filterwarnings("ignore")


def build_dataframe(diff_over_time: dict) -> pd.DataFrame:
    if not diff_over_time:
        return pd.DataFrame()
    frames: dict[str, pd.Series] = {}
    for pair, series in diff_over_time.items():
        s = pd.Series(series)
        s.index = pd.to_datetime(s.index)
        frames[pair] = s
    df = pd.DataFrame(frames).sort_index()
    ordered_cols = [c for c in config.FORECAST_HIERARCHY if c in df.columns]
    df = df[ordered_cols]
    if df.empty:
        return df
    return df.resample("B").last().ffill().dropna()


def _is_stationary(series: pd.Series) -> bool:
    adf_p = adfuller(series, autolag="AIC")[1]
    try:
        kpss_p = kpss_test(series, regression='c', nlags='auto')[1]
    except Exception:
        kpss_p = 0.05  # conservative: assume non-stationary on KPSS failure
    return (adf_p < config.SIGNIFICANCE_ALPHA) and (kpss_p > config.SIGNIFICANCE_ALPHA)


def ensure_stationarity(df: pd.DataFrame) -> tuple:
    print("\n" + "=" * 65)
    print("STEP 1 - ADF/KPSS Stationarity")
    print("=" * 65)
    print(f"  {'Pair':<18} {'ADF p':>10} {'KPSS p':>10}  Result")
    print(f"  {'-'*18} {'-'*10} {'-'*10}  {'-'*28}")

    differenced: dict[str, pd.Series] = {}
    was_differenced: dict[str, bool] = {}
    for col in df.columns:
        series = df[col].dropna()
        adf_p = adfuller(series, autolag="AIC")[1]
        try:
            kpss_p = kpss_test(series, regression='c', nlags='auto')[1]
        except Exception:
            kpss_p = 0.05
        is_stat = (adf_p < config.SIGNIFICANCE_ALPHA) and (kpss_p > config.SIGNIFICANCE_ALPHA)
        was_differenced[col] = not is_stat
        differenced[col] = series if is_stat else series.diff().dropna()
        result = "Stationary" if is_stat else "Non-stationary -> differenced"
        print(f"  {col:<18} {adf_p:>10.6f} {kpss_p:>10.6f}  {result}")
    stat_df = pd.DataFrame(differenced).dropna()
    stat_df.index.freq = pd.tseries.frequencies.to_offset("B")
    return stat_df, was_differenced


def select_lag_order(stationary_df: pd.DataFrame, max_lags: int) -> int:
    model = VAR(stationary_df)
    lag_result = model.select_order(maxlags=max_lags)
    return max(1, int(lag_result.selected_orders.get('aic', 1)))


def fit_var_model(stationary_df: pd.DataFrame, lag_order: int):
    return VAR(stationary_df).fit(lag_order)


def run_granger_causality(stationary_df: pd.DataFrame, lag_order: int) -> dict:
    cols = list(stationary_df.columns)
    results: dict[str, dict] = {}
    for i in range(len(cols) - 1):
        col_a, col_b = cols[i], cols[i + 1]
        for causing, target in [(col_a, col_b), (col_b, col_a)]:
            try:
                test_data = stationary_df[[target, causing]].dropna()
                gc = grangercausalitytests(test_data, maxlag=lag_order, verbose=False)
                p = gc[lag_order][0]["ssr_ftest"][1]
                results[f"{causing} -> {target}"] = {"p_value": round(p, 6)}
            except Exception:
                pass
    return results


def forecast_and_irf(fitted_model, stationary_df: pd.DataFrame, original_df: pd.DataFrame,
                     was_differenced: dict, horizon: int) -> dict:
    cols = list(stationary_df.columns)
    lag_order = fitted_model.k_ar
    last_obs = stationary_df.values[-lag_order:]
    raw_fc = fitted_model.forecast(last_obs, steps=horizon)
    future_dates = pd.bdate_range(start=original_df.index[-1], periods=horizon + 1)[1:]
    forecast_df = pd.DataFrame(raw_fc, index=future_dates, columns=cols)

    forecast_levels: dict[str, pd.Series] = {}
    for col in cols:
        if was_differenced.get(col, False):
            forecast_levels[col] = original_df[col].iloc[-1] + forecast_df[col].cumsum()
        else:
            forecast_levels[col] = forecast_df[col]
    return {
        "forecast_df": pd.DataFrame(forecast_levels, index=future_dates),
        "irf": fitted_model.irf(periods=horizon),
        "future_dates": future_dates,
        "cols": cols,
    }


def save_future_projections(forecast_levels_df: pd.DataFrame) -> None:
    out: dict[str, dict] = {}
    for col in forecast_levels_df.columns:
        out[col] = {str(d.date()): round(v, 4) for d, v in forecast_levels_df[col].items()}
    with open(config.BASE_DIR / "future_projections.json", "w") as f:
        json.dump(out, f, indent=2)


def plot_forecast(original_df: pd.DataFrame, forecast_results: dict) -> None:
    cols = forecast_results["cols"]
    forecast_df = forecast_results["forecast_df"]
    future_dates = forecast_results["future_dates"]
    n = len(cols)
    hist_colors = ["#E63946", "#F4A261", "#2A9D8F", "#8338EC", "#457B7D", "#D4AF37", "#06D6A0"]
    fig, axes = plt.subplots(n, 1, figsize=(15, 3.8 * n), sharex=False)
    if n == 1:
        axes = [axes]
    for ax, col, c in zip(axes, cols, hist_colors):
        last_date = original_df.index[-1]
        one_month_ago = last_date - pd.DateOffset(months=1)
        hist_vals = original_df[col][original_df.index >= one_month_ago]
        fc_vals = forecast_df[col]
        ax.plot(hist_vals.index, hist_vals.values, color=c, linewidth=1.5, label="Historical (1 month)")
        ax.axvline(last_date, color="black", linewidth=1.5, linestyle="--", alpha=0.5, label="Today")
        ax.axvspan(future_dates[0], future_dates[-1], alpha=0.10, color="#FF0000", label="Forecast window")
        ax.plot(fc_vals.index, fc_vals.values, color="#FF0000", linewidth=2.5, linestyle="--",
                marker="o", markersize=5, markerfacecolor="white", label="VAR Forecast")
        ax.axhline(0, color="black", linewidth=0.5, linestyle=":", alpha=0.4)
        ax.set_title(f"{col}  -  Yield Spread minus Expected Loss (bps)", fontsize=9, fontweight="bold")
        ax.set_ylabel("bps")
        ax.legend(fontsize=7, loc="upper left")
        ax.grid(True, alpha=0.25)
        all_d = list(hist_vals.index) + list(future_dates)
        ax.set_xlim(all_d[0], future_dates[-1])
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=3))
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b %Y"))
        plt.setp(ax.get_xticklabels(), rotation=45, ha="right", fontsize=7)
    fig.suptitle("VAR Forecast - Yield Spread minus Expected Loss (bps)", fontsize=12, fontweight="bold", y=1.01)
    plt.tight_layout()
    plt.savefig("forecast_spread_minus_el.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


def plot_irf(forecast_results: dict) -> None:
    cols = forecast_results["cols"]
    irf = forecast_results["irf"]
    future_dates = forecast_results["future_dates"]
    n = len(cols)
    colors = ["#E63946", "#F4A261", "#2A9D8F", "#8338EC", "#457B7D", "#D4AF37", "#06D6A0"]
    try:
        today = future_dates[0] - pd.tseries.offsets.BDay(1)
        irf_dates = [today] + list(future_dates)
        if len(irf_dates) != irf.irfs.shape[0]:
            irf_dates = range(irf.irfs.shape[0])
    except Exception:
        irf_dates = range(irf.irfs.shape[0])

    configs = [
        {"data": irf.irfs, "json_file": "irf_contagion_matrix_1bps.json",
         "img_file": "irf_spread_minus_el_matrix_1bps.png",
         "title": "IRF for a 1 bps shock - Full Contagion Matrix"},
        {"data": irf.orth_irfs, "json_file": "irf_contagion_matrix_stddev.json",
         "img_file": "irf_spread_minus_el_matrix_stddev.png",
         "title": "IRF for a 1 Std-Dev shock - Full Contagion Matrix"},
    ]
    for cfg in configs:
        irf_data = cfg["data"]
        export: dict[str, dict] = {}
        for shock_idx in range(n):
            export[f"Shock_to_{cols[shock_idx]}"] = {}
            for resp_idx in range(n):
                response = irf_data[:, resp_idx, shock_idx]
                timeline = {}
                for i, val in enumerate(response):
                    d_str = irf_dates[i].strftime("%Y-%m-%d") if isinstance(irf_dates[i], pd.Timestamp) else f"Period_{i}"
                    timeline[d_str] = round(float(val), 4)
                export[f"Shock_to_{cols[shock_idx]}"][f"Response_of_{cols[resp_idx]}"] = timeline
        with open(cfg["json_file"], "w") as f:
            json.dump(export, f, indent=2)

        fig, axes = plt.subplots(n, n, figsize=(3.5 * n, 3.2 * n), sharex=False)
        if n == 1:
            axes = np.array([[axes]])
        for shock_idx in range(n):
            for resp_idx in range(n):
                ax = axes[resp_idx, shock_idx]
                response = irf_data[:, resp_idx, shock_idx]
                c = colors[resp_idx % len(colors)]
                ax.plot(irf_dates, response, color=c, linewidth=1.8)
                ax.fill_between(irf_dates, response, 0,
                                where=np.array([v > 0 for v in response]), alpha=0.18, color=c)
                ax.fill_between(irf_dates, response, 0,
                                where=np.array([v < 0 for v in response]), alpha=0.18, color="#AAAAAA")
                ax.axhline(0, color="black", linewidth=0.8, linestyle="--", alpha=0.6)
                if resp_idx == 0:
                    ax.set_title(f"Shock to {cols[shock_idx]}", fontsize=11, fontweight="bold")
                if shock_idx == 0:
                    ax.set_ylabel(f"Resp: {cols[resp_idx]}\n(bps change)", fontsize=10, fontweight="bold")
                if isinstance(irf_dates[0], pd.Timestamp):
                    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
                    step = max(1, len(irf_dates) // 4)
                    ax.xaxis.set_major_locator(mdates.DayLocator(interval=step))
                    ax.tick_params(axis='x', rotation=45, labelsize=8)
                else:
                    ax.set_xlabel("Periods after shock", fontsize=9)
                ax.grid(True, alpha=0.25)
        fig.suptitle(cfg["title"], fontsize=16, fontweight="bold", y=1.02)
        plt.tight_layout(h_pad=1.5, w_pad=1.0)
        plt.savefig(cfg["img_file"], dpi=150, bbox_inches="tight")
        plt.close(fig)


def determine_cointegration_rank(df: pd.DataFrame, k_ar_diff: int = config.COINTEGRATION_K_AR_DIFF) -> int:
    try:
        result = coint_johansen(df.values, det_order=config.COINTEGRATION_DET_ORDER, k_ar_diff=k_ar_diff)
    except Exception:
        return 0
    rank = 0
    for i in range(df.shape[1]):
        if result.lr1[i] > result.cvt[i, 1]:
            rank += 1
        else:
            break
    return rank


def run_johansen_var_pipeline(diff_over_time: dict, horizon: int = config.DEFAULT_FORECAST_HORIZON,
                              max_lags: int = config.DEFAULT_MAX_LAGS) -> dict:
    print("\n" + "=" * 65)
    print("  JOHANSEN-AUGMENTED VAR PIPELINE")
    print("=" * 65)
    original_df = build_dataframe(diff_over_time)
    if original_df.empty:
        raise ValueError("Data pipeline returned an empty DataFrame. Check FRED API.")
    print(f"\n  DataFrame: {original_df.shape[0]:,} rows x {original_df.shape[1]} columns")
    print(f"  Date range: {original_df.index[0].date()} -> {original_df.index[-1].date()}")
    print(f"  Pairs: {list(original_df.columns)}")
    if original_df.shape[1] < 2:
        return {}

    was_differenced, all_nonstationary = {}, True
    for col in original_df.columns:
        is_stat = _is_stationary(original_df[col].dropna())
        was_differenced[col] = not is_stat
        if is_stat:
            all_nonstationary = False

    diff_df = original_df.diff().dropna()
    diff_df.index.freq = pd.tseries.frequencies.to_offset("B")
    lag_for_var = select_lag_order(diff_df, max_lags=max_lags)
    k_ar_diff = max(1, lag_for_var - 1)

    rank = determine_cointegration_rank(original_df, k_ar_diff=k_ar_diff) if all_nonstationary else 0
    K = original_df.shape[1]

    if rank == 0:
        stationary_df = diff_df
        fitted_model = fit_var_model(stationary_df, lag_for_var)
        granger_results = run_granger_causality(stationary_df, lag_for_var)
        forecast_results = forecast_and_irf(fitted_model, stationary_df, original_df,
                                            was_differenced={c: True for c in original_df.columns},
                                            horizon=horizon)
    elif rank < K:
        vecm_fit = VECM(original_df, k_ar_diff=k_ar_diff, coint_rank=rank, deterministic='n').fit()
        last_date = original_df.index[-1]
        future_dates = pd.bdate_range(start=last_date, periods=horizon + 1)[1:]
        raw_forecast = vecm_fit.predict(steps=horizon)
        forecast_df = pd.DataFrame(raw_forecast, index=future_dates, columns=original_df.columns)
        forecast_results = {"forecast_df": forecast_df, "irf": vecm_fit.irf(periods=horizon),
                             "future_dates": future_dates, "cols": list(original_df.columns)}
        save_future_projections(forecast_df)
        plot_forecast(original_df, forecast_results)
        plot_irf(forecast_results)
        return {"rank": rank, "vecm_fit": vecm_fit, "forecast": forecast_df}
    else:
        fitted_model = fit_var_model(original_df, lag_for_var)
        granger_results = run_granger_causality(original_df, lag_for_var)
        forecast_results = forecast_and_irf(fitted_model, original_df, original_df,
                                            was_differenced={c: False for c in original_df.columns},
                                            horizon=horizon)
    save_future_projections(forecast_results["forecast_df"])
    plot_forecast(original_df, forecast_results)
    plot_irf(forecast_results)
    return {"rank": rank, "lag_order": lag_for_var, "granger": granger_results if rank != 1 else {},
            "forecast": forecast_results["forecast_df"], "irf": forecast_results["irf"]}
