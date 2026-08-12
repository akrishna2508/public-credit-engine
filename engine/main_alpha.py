"""Scoring/presentation: ML scorecard, asset profiles, vol-vs-spread charts."""
from __future__ import annotations

import textwrap

import matplotlib.pyplot as plt

import config
from engine import ml_engine


def plot_ml_scorecard(scorecard_df) -> None:
    print("\n[UI] Rendering Machine Learning Scorecard...")
    df = scorecard_df.copy()
    df['ML_Score_Str'] = df['ML_Score'].apply(lambda x: f"{x:.1f}%")
    df['ROI_Str'] = df['Trailing_21D_ROI'].apply(lambda x: f"{x:+.2f}%")
    df['Status'] = df['Anomaly'].apply(lambda x: "SAFE" if x == 1 else "ANOMALY (DO NOT TRADE)")
    df['Yield_Str'] = df['Current_Yield'].apply(
        lambda x: f"{x:.2f}%" if x is not None and x > 0 else "n/a")
    df['Profit_Drivers'] = df['Profit_Drivers'].apply(lambda x: "\n".join(textwrap.wrap(str(x), width=32)))
    df['Risk_Drivers'] = df['Risk_Drivers'].apply(lambda x: "\n".join(textwrap.wrap(str(x), width=32)))

    table_data = df[['Asset_Name', 'ML_Score_Str', 'Status', 'Yield_Str', 'ROI_Str',
                     'Profit_Drivers', 'Risk_Drivers']].values.tolist()
    columns = ["Credit Asset", "Win\nProbability", "System\nStatus", "Current\nYield",
               "21-Day ROI\n(Momentum)", "Top 3 Profit Drivers\n(Positive SHAP)",
               "Top 3 Risk Drivers\n(Negative SHAP)"]

    fig, ax = plt.subplots(figsize=(28, 10))
    ax.axis('tight')
    ax.axis('off')
    plt.title("Institutional ML Credit Alpha Scorecard (21-Day Forward Horizon)",
              fontweight="bold", fontsize=18, pad=30)
    table = ax.table(cellText=table_data, colLabels=columns, cellLoc='center', bbox=[0, 0, 1, 0.85])
    table.auto_set_font_size(False)
    table.set_fontsize(11)

    col_widths = {0: 0.16, 1: 0.07, 2: 0.07, 3: 0.07, 4: 0.09, 5: 0.27, 6: 0.27}
    for (row, col), cell in table.get_celld().items():
        cell.set_width(col_widths[col])
        if row == 0:
            cell.set_facecolor('#1D3557')
            cell.set_text_props(weight='bold', color='white')
        elif col == 1:
            val = float(table_data[row - 1][1].replace('%', ''))
            cell.set_facecolor('#E6F4EA') if val > config.ML_TARGET_PROBABILITY_THRESHOLD else cell.set_facecolor('#FCE8E6')
            cell.set_text_props(weight='bold')
        elif col == 2 and table_data[row - 1][2] != "SAFE":
            cell.set_facecolor('#FFCCCB')
            cell.set_text_props(weight='bold')
        elif col == 3:
            cell.set_facecolor('#F8F9FA')
            cell.set_text_props(weight='bold')
        elif col == 4:
            val = float(table_data[row - 1][4].replace('%', ''))
            cell.set_text_props(color='green' if val > 0 else 'red', weight='bold')
        elif col == 5:
            cell.set_facecolor('#F6FDF8')
            cell.set_text_props(ha='left')
        elif col == 6:
            cell.set_facecolor('#FFF9F9')
            cell.set_text_props(ha='left')

    plt.tight_layout()
    plt.savefig("ML_Credit_Scorecard.png", dpi=150, bbox_inches="tight")
    plt.close()
    print(" -> Saved 'ML_Credit_Scorecard.png'")


def plot_individual_asset_metrics(scorecard_df) -> None:
    """Per-asset ratio profile tables (12 quantitative metrics each)."""
    metrics = ["Liquidity_Proxy", "Term_Spread", "OAS_Z",
               "Sharpe_21", "Sharpe_63", "Sharpe_252",
               "Sortino_21", "Sortino_63", "Sortino_252",
               "Calmar_21", "Calmar_63", "Calmar_252"]
    for index, row in scorecard_df.iterrows():
        table_data = []
        for m in metrics:
            if m in row:
                table_data.append([ml_engine.format_feature_name(m), f"{row[m]:.4f}"])
        fig, ax = plt.subplots(figsize=(8, len(table_data) * 0.4 + 2))
        ax.axis('tight')
        ax.axis('off')
        plt.title(f"Quantitative Ratio Profile: {row['Asset_Name']}", fontweight="bold", fontsize=14, pad=20)
        table = ax.table(cellText=table_data, colLabels=["Quantitative Metric", "Current Computed Value"],
                         loc='center', cellLoc='center')
        table.auto_set_font_size(False)
        table.set_fontsize(11)
        table.scale(1, 2.0)
        for (r, c), cell in table.get_celld().items():
            if r == 0:
                cell.set_facecolor('#1D3557')
                cell.set_text_props(weight='bold', color='white')
            elif c == 0:
                cell.set_text_props(weight='bold', ha='left')
                cell.set_facecolor('#F8F9FA')
        plt.tight_layout()
        plt.savefig(f"{row['Asset']}_Comprehensive_Profile.png", dpi=150, bbox_inches="tight")
        plt.close()


def plot_vol_vs_spread(dataset) -> None:
    tlt = dataset['TLT']['Ret'].rolling(21).std() * (252 ** 0.5) * 100
    hyg = dataset['HYG']['Ret'].rolling(21).std() * (252 ** 0.5) * 100
    plt.figure(figsize=(14, 6))
    plt.plot(tlt.tail(252), label="Pure Duration Vol (TLT 20Y+)", color="blue")
    plt.plot(hyg.tail(252), label="Credit Spread Vol (HYG Junk)", color="red")
    plt.title("Volatility Regime: Pure Duration vs. High Yield Spreads", fontweight="bold")
    plt.ylabel("Annualized Volatility (%)")
    plt.legend()
    plt.grid(True, alpha=0.3)
    plt.savefig("Vol_vs_Spread.png", dpi=150, bbox_inches="tight")
    plt.close()
    print(" -> Saved 'Vol_vs_Spread.png'")


def run() -> None:
    """Callable entry point for the ML scorecard pipeline."""
    print("=" * 70)
    print("  INSTITUTIONAL ML CREDIT ALPHA ENGINE (XGBoost + SHAP)")
    print("=" * 70)
    from pipelines.ml_scorecard import run_ml_scorecard
    run_ml_scorecard()


if __name__ == "__main__":
    run()