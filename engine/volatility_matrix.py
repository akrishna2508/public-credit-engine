"""Volatility/market matrix heatmap and yield/carry tables."""
from __future__ import annotations

import pandas as pd
import numpy as np
import seaborn as sns
import matplotlib.pyplot as plt


def plot_return_curve_view(curves: dict, region: str, percentile: int,
                           path: str, column: str = "HF_net_bps",
                           dashed: bool = False,
                           x_unit: str = "trading days") -> None:
    """Multi-line chart of ONE return view: x = hold days, one line per item.

    Views (column): Gross_bps (Tier 1), HF_net_bps (Tier 2, dashed), or
    Ret_net_bps (Tier 3, dashed). Each item is a full 1..T_max hold-horizon
    curve — never a fixed-period metric — with a legend and a zero line.
    Items with no evaluable points are skipped honestly.
    """
    label_map = {"Gross_bps": "gross (Tier 1)",
                 "HF_net_bps": "HF net (Tier 2)",
                 "Ret_net_bps": "retail net (Tier 3)"}
    usable = {k: v for k, v in curves.items()
              if v is not None and not v.empty and v[column].notna().any()}
    if not usable:
        print(f"  [WARNING] Skipping return-curve plot '{path}': no evaluable curves.")
        return
    fig, ax = plt.subplots(figsize=(15, 9))
    for name, df in usable.items():
        ax.plot(df.index, df[column], lw=1.8, ls="--" if dashed else "-",
                label=f"{name.replace('_', ' ')} — {label_map.get(column, column)}")
    ax.axhline(0, color="black", lw=0.9)
    ax.set_xlabel(f"Holding period ({x_unit})", fontweight="bold")
    ax.set_ylabel("Return after dealer markup + friction (bps)", fontweight="bold")
    ax.set_title(f"{region} — {label_map.get(column, column)} vs hold days "
                 f"({percentile}th percentile, {len(usable)} items)",
                 fontsize=15, fontweight="bold", pad=16)
    ax.legend(fontsize=7.5, ncol=2, framealpha=0.9)
    ax.grid(alpha=0.3)
    ax.set_xlim(1, max(df.index.max() for df in usable.values()))
    plt.tight_layout()
    plt.savefig(path, dpi=150)
    plt.close(fig)


def plot_return_curves(curves: dict, region: str, percentile: int,
                       path: str) -> None:
    """Combined net-return chart (legacy single-PNG view, HF + retail)."""
    usable = {k: v for k, v in curves.items()
              if v is not None and not v.empty and v["HF_net_bps"].notna().any()}
    if not usable:
        print(f"  [WARNING] Skipping return-curve plot '{path}': no evaluable curves.")
        return
    fig, ax = plt.subplots(figsize=(15, 9))
    for name, df in usable.items():
        ax.plot(df.index, df["HF_net_bps"], lw=1.8,
                label=f"{name.replace('_', ' ')} — HF net")
        ax.plot(df.index, df["Ret_net_bps"], lw=1.2, ls="--",
                label=f"{name.replace('_', ' ')} — retail net")
    ax.axhline(0, color="black", lw=0.9)
    ax.set_xlabel("Holding period (trading days)", fontweight="bold")
    ax.set_ylabel("Net return after dealer markup + friction (bps)", fontweight="bold")
    ax.set_title(f"{region} — Shock-band straddle net return vs hold days "
                 f"({percentile}th percentile, {len(usable)} items)",
                 fontsize=15, fontweight="bold", pad=16)
    ax.legend(fontsize=7.5, ncol=2, framealpha=0.9)
    ax.grid(alpha=0.3)
    ax.set_xlim(1, max(df.index.max() for df in usable.values()))
    plt.tight_layout()
    plt.savefig(path, dpi=150)
    plt.close(fig)


def plot_volatility_matrix(matrix_df: pd.DataFrame, base_title: str, hold_days: int, region: str) -> None:
    if matrix_df.empty or matrix_df.isnull().all().all():
        print(f"  [WARNING] Skipping plot '{base_title}': No valid data.")
        return
    plt.figure(figsize=(16, 10))
    sns.heatmap(matrix_df, annot=True, fmt=".5f", cmap="RdYlGn", center=0,
                cbar_kws={'label': 'Net Profit / Return (bps)'}, annot_kws={"size": 8})
    plt.title(f"{region} - {base_title} ({hold_days}-Day Hold)", fontsize=16, fontweight="bold", pad=20)
    plt.ylabel("Asset Class", fontweight="bold")
    plt.xlabel("Volatility Percentile Traded", fontweight="bold")
    plt.tight_layout()
    plt.savefig(f"{region.replace(' ', '_').lower()}_{base_title.replace(' ', '_').lower()}.png", dpi=150)
    plt.close()


def generate_spectrum_matrices(assets: list, percentiles: list, strategy_results: list,
                               hold_days: int, region: str) -> None:
    gross_df = pd.DataFrame(index=assets, columns=[f"{p}th" for p in percentiles], dtype=float)
    hf_net_df = pd.DataFrame(index=assets, columns=[f"{p}th" for p in percentiles], dtype=float)
    retail_net_df = pd.DataFrame(index=assets, columns=[f"{p}th" for p in percentiles], dtype=float)

    for r in strategy_results:
        asset = r.get("Asset", r.get("Pair"))
        if asset not in assets:
            continue
        pct_label = f"{r['Percentile']}th"
        gross_df.at[asset, pct_label] = r.get("HF_Gross_Shock", 0)
        hf_net_df.at[asset, pct_label] = r.get("HF_Net_Shock", 0)
        retail_net_df.at[asset, pct_label] = r.get("Ret_Net_Shock", 0)

    plot_volatility_matrix(gross_df, "Tier 1 - Theoretical Gross Payout", hold_days, region)
    plot_volatility_matrix(hf_net_df, "Tier 2 - Hedge Fund Net Return", hold_days, region)
    plot_volatility_matrix(retail_net_df, "Tier 3 - Retail Net Return", hold_days, region)


def _format_yield_rows(latest_bps: dict, hold_days: int) -> tuple[list, list]:
    """Format latest-value rows for the yield/carry tables.

    All callers pass bps-valued columns (percent yields already multiplied
    by 100 in spreads.fetch_us_public_data / bonds_EUR_data / bonds_EM_data).
    Display converts back to percent; carry is prorated in true percent.
    """
    t1_data, t2_data = [], []
    for asset, bps in latest_bps.items():
        if bps is None or not np.isfinite(bps):
            pct = prorated_pct = float("nan")
        else:
            pct = bps / 100.0
            prorated_pct = pct * (hold_days / 365.0)
        label = asset.replace("_", " ")
        t1_data.append([label, f"{pct:.3f}%" if np.isfinite(pct) else "n/a"])
        t2_data.append([label,
                        f"{pct:.3f}%" if np.isfinite(pct) else "n/a",
                        str(hold_days),
                        f"{prorated_pct:.4f}%" if np.isfinite(prorated_pct) else "n/a",
                        f"{prorated_pct * 100:.2f} bps" if np.isfinite(prorated_pct) else "n/a"])
    return t1_data, t2_data


def generate_yield_tables(df_assets: pd.DataFrame, hold_days: int, region: str) -> None:
    print(f"\n  [SYSTEM] Generating Yield & Carry Tables for {region}...")
    latest_yields = df_assets.iloc[-1]

    t1_data, t2_data = _format_yield_rows(latest_yields.to_dict(), hold_days)
    fig, ax = plt.subplots(figsize=(10, len(t1_data) * 0.5 + 2))
    ax.axis('tight')
    ax.axis('off')
    plt.title(f"{region} - Current Market Yields (Latest Annualized)", fontweight="bold", fontsize=14, loc="center", pad=20)
    table1 = ax.table(cellText=t1_data, colLabels=["Asset Class", "Current Annual Yield (%)"], loc='center', cellLoc='center')
    table1.auto_set_font_size(False)
    table1.set_fontsize(12)
    table1.scale(1.0, 2.0)
    for (row, col), cell in table1.get_celld().items():
        if row == 0:
            cell.set_facecolor('#1D3557')
            cell.set_text_props(weight='bold', color='white')
    plt.tight_layout()
    plt.savefig(f"{region.replace(' ', '_').lower()}_current_yields.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    fig2, ax2 = plt.subplots(figsize=(14, len(t2_data) * 0.5 + 2))
    ax2.axis('tight')
    ax2.axis('off')
    plt.title(f"{region} - Expected Baseline Carry Return ({hold_days}-Day Hold)", fontweight="bold", fontsize=14, loc="center", pad=20)
    cols2 = ["Asset Class", "Annual Yield", "Hold Period (Days)", "Expected Return (%)", "Expected Return (bps)"]
    table2 = ax2.table(cellText=t2_data, colLabels=cols2, loc='center', cellLoc='center')
    table2.auto_set_font_size(False)
    table2.set_fontsize(12)
    table2.scale(1.0, 2.0)
    for (row, col), cell in table2.get_celld().items():
        if row == 0:
            cell.set_facecolor('#1D3557')
            cell.set_text_props(weight='bold', color='white')
    plt.tight_layout()
    plt.savefig(f"{region.replace(' ', '_').lower()}_{hold_days}day_carry_return.png", dpi=150, bbox_inches="tight")
    plt.close(fig)