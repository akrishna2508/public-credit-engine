"""European public corporate bond proxies (yfinance UCITS ETFs) + EUR risk-free.

Audit fix (Session 2): the EUR risk-free benchmark was US DGS10. It now prefers
the German 10Y Bund (FRED IRLTLT01DEM156N, OECD monthly) — a real EUR benchmark —
and only falls back to DGS10 with a visible warning. Both are real data; the
warning exists so a US-proxied benchmark is never silently treated as EUR.
"""
from __future__ import annotations

import pandas as pd

from engine import data_engine

EUR_RISK_FREE_PRIMARY = "IRLTLT01DEM156N"  # Germany 10Y government bond yield, monthly
EUR_RISK_FREE_FALLBACK = "DGS10"           # US 10Y — warned proxy only


def get_eur_market_data() -> pd.DataFrame:
    print("  [API] Fetching European Proxies (ETFs for OAS, FRED for Risk-Free)...")
    data = {
        "EUR_IG_OAS": data_engine.fetch_etf_yield("IEAC.L"),
        "EUR_HY_OAS": data_engine.fetch_etf_yield("IHYG.L"),
    }
    risk_free = data_engine.fetch_fred_series(EUR_RISK_FREE_PRIMARY)
    if risk_free.empty:
        print(f"  [WARNING] {EUR_RISK_FREE_PRIMARY} (German Bund) returned empty; "
              f"falling back to {EUR_RISK_FREE_FALLBACK} (US 10Y proxy).")
        risk_free = data_engine.fetch_fred_series(EUR_RISK_FREE_FALLBACK)
    if not risk_free.empty:
        data["EUR_Risk_Free_10Y"] = risk_free
        print(f"  OK   EUR_Risk_Free_10Y -> {len(risk_free)} obs")
    else:
        print("  [ERROR] Both EUR risk-free candidates returned empty series.")

    df = pd.DataFrame(data).ffill().dropna()
    if df.empty:
        print("  [CRITICAL] European dataframe is empty. Data fetch failed.")
        return df
    df = df.resample("B").last().ffill()
    df = df * 100.0  # percent -> bps
    print(f"  [SUCCESS] Assembled European Data: {len(df)} overlapping observations.")
    return df