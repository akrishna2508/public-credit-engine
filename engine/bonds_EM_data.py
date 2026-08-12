"""Emerging-market public debt proxies (yfinance ETFs) + USD risk-free (FRED)."""
from __future__ import annotations

import textwrap

import matplotlib.pyplot as plt
import pandas as pd

from engine import data_engine

EM_PROFILES = {
    "EM_USD_Sovereign": {
        "Ticker": "EMB", "Rating": "BB+ to BBB-", "Currency": "USD (No FX Risk)",
        "Vol_Regime": "Moderate",
        "Countries": "Mexico, Saudi Arabia, Turkey, Indonesia, UAE, Brazil.",
        "Profile": "Emerging market government debt issued in US Dollars. Highly sensitive to US Federal Reserve interest rate hikes. Considered the safest EM tier.",
    },
    "EM_Corporate": {
        "Ticker": "CEMB", "Rating": "BB to BB+", "Currency": "USD (No FX Risk)",
        "Vol_Regime": "Moderate-High",
        "Countries": "Colombia, Brazil, Israel, Mexico, UAE, Chile, Macao.",
        "Profile": "EM Corporate debt in USD. Driven by global macro sentiment and local corporate default cycles; tracks US High Yield closely.",
    },
    "EM_High_Yield": {
        "Ticker": "EMHY", "Rating": "B to CCC", "Currency": "USD (No FX Risk)",
        "Vol_Regime": "High",
        "Countries": "Turkey, Brazil, Colombia, Mexico, Argentina, South Africa.",
        "Profile": "High-yield tier of EM debt; sensitive to global liquidity vacuums and commodity price crashes.",
    },
    "EM_Local_Currency": {
        "Ticker": "LEMB", "Rating": "BB to B", "Currency": "Local (Extreme FX Risk)",
        "Vol_Regime": "Extreme",
        "Countries": "Brazil, Mexico, Indonesia, South Africa, Malaysia, Poland.",
        "Profile": "Government debt priced in native currencies; returns can be wiped out by currency devaluation.",
    },
    "Risk_Free": {
        "Ticker": "DGS10", "Rating": "AAA", "Currency": "USD",
        "Vol_Regime": "Baseline",
        "Countries": "United States of America.",
        "Profile": "US 10-Year Treasury Yield; the core benchmark against which all EM risk premiums are measured.",
    },
}


def generate_em_profile_table(latest_yields: pd.Series) -> None:
    print("\n  [SYSTEM] Generating Emerging Markets Profile Table...")
    table_data = []
    columns = ["Asset Class", "Benchmark\nETF", "Implied\nRating", "Currency\nExposure",
               "Volatility\nRegime", "Latest Dynamic\nYield", "Major Country\nExposures",
               "Macro Sensitivities & Asset Profile"]
    for asset in EM_PROFILES:
        if asset in latest_yields:
            prof = EM_PROFILES[asset]
            current_yield = latest_yields[asset] / 100.0  # bps -> percent
            table_data.append([
                asset.replace("_", " "), prof["Ticker"], prof["Rating"], prof["Currency"],
                prof["Vol_Regime"], f"{current_yield:.2f}%",
                "\n".join(textwrap.wrap(prof["Countries"], width=25)),
                "\n".join(textwrap.wrap(prof["Profile"], width=55)),
            ])
    fig, ax = plt.subplots(figsize=(28, 9))
    ax.axis('tight')
    ax.axis('off')
    plt.title("EMERGING MARKETS (EM) DEBT: ASSET PROFILE & RISK MATRIX",
              fontweight="bold", fontsize=15, loc="left", pad=20, color="#1D3557")
    table = ax.table(cellText=table_data, colLabels=columns, loc='center', cellLoc='center')
    table.auto_set_font_size(False)
    table.set_fontsize(12)
    col_widths = {0: 0.10, 1: 0.05, 2: 0.06, 3: 0.10, 4: 0.10, 5: 0.08, 6: 0.16, 7: 0.35}
    for (row, col), cell in table.get_celld().items():
        cell.set_width(col_widths[col])
        if row == 0:
            cell.set_facecolor('#1D3557')
            cell.set_text_props(weight='bold', color='white')
        else:
            if col == 5:
                cell.set_facecolor('#F8F9FA')
                cell.set_text_props(weight='bold')
            elif col in (6, 7):
                cell.set_text_props(ha='left')
    table.scale(1.0, 4.5)
    plt.tight_layout()
    plt.savefig("emerging_markets_profile_table.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("  [SUCCESS] Rendered emerging_markets_profile_table.png")


def get_em_market_data() -> pd.DataFrame:
    print("  [API] Fetching Emerging Market Proxies (ETFs for OAS, FRED for Risk-Free)...")
    data = {
        "EM_USD_Sovereign": data_engine.fetch_etf_yield("EMB"),
        "EM_Corporate": data_engine.fetch_etf_yield("CEMB"),
        "EM_High_Yield": data_engine.fetch_etf_yield("EMHY"),
        "EM_Local_Currency": data_engine.fetch_etf_yield("LEMB"),
    }
    try:
        s = data_engine.fetch_fred_series("DGS10")
        if not s.empty:
            data["Risk_Free"] = s
            print(f"  OK   Risk_Free (DGS10) -> {len(s)} obs")
        else:
            print("  [ERROR] DGS10 returned empty series.")
    except Exception as e:
        print(f"  [ERROR] DGS10: {e}")

    df = pd.DataFrame(data).ffill().dropna()
    if df.empty:
        print("  [CRITICAL] EM dataframe is empty. Data fetch failed.")
        return df
    df = df.resample("B").last().ffill()
    df = df * 100.0  # percent -> bps
    print(f"  [SUCCESS] Assembled EM Data: {len(df)} overlapping observations.")
    generate_em_profile_table(df.iloc[-1])
    return df