"""EUR credit panel: true EUR-denominated spreads.

EUR risk-free is the German Bund (FRED IRLTLT01DEM156N, monthly, real data).
The DGS10-as-EUR-proxy misuse is deliberately NOT rebuilt here: if the Bund
series is unavailable, the panel reports UNAVAILABLE — a US yield is never
substituted for a EUR risk-free rate. Corporate legs come from yfinance
UCITS ETF yields (IEAC.L / IHYG.L) and FRED BAMLHE00EHYIOAS. The optional
`ecb_corp` dict may carry the ECB euro-area government curves (the YC
dataflow publishes government keys only — see sources.ecb) as a cross-check.
"""
from __future__ import annotations

import pandas as pd

from sources.registry import SourceUnavailable


def fetch_eur_risk_free() -> pd.Series:
    """German Bund 10Y (monthly FRED series), gated."""
    from sources import fred_ext
    group = fred_ext.fetch_group(["IRLTLT01DEM156N"], "eur_risk_free")
    if not group:
        raise SourceUnavailable(
            "eur_panel", "German Bund 10Y (IRLTLT01DEM156N) unavailable",
            "The Bund is the only honest EUR risk-free proxy in this layer; "
            "no US substitute is used")
    return next(iter(group.values()))


def eur_spread_panel(etf_yields: dict[str, pd.Series],
                     risk_free: pd.Series | None = None,
                     ecb_corp: dict[str, pd.Series] | None = None) -> pd.DataFrame:
    """Corporate yield minus Bund, business-day aligned, in bps.

    Rows where any leg is missing are dropped (a spread needs both sides).
    Returns an empty frame with a status attribute when nothing overlaps.
    """
    frame = pd.DataFrame(etf_yields)
    if risk_free is None:
        risk_free = fetch_eur_risk_free()
    frame["EUR_Risk_Free_10Y"] = risk_free
    if ecb_corp:
        for name, s in ecb_corp.items():
            frame[name] = s
    if frame.empty:
        return pd.DataFrame({"status": ["UNAVAILABLE: no corporate yield series"]})
    frame = frame.resample("B").last().ffill().dropna()
    if frame.empty:
        return pd.DataFrame({"status": ["UNAVAILABLE: no overlapping EUR observations"]})
    spreads = pd.DataFrame(index=frame.index)
    for c in frame.columns:
        if c == "EUR_Risk_Free_10Y":
            continue
        spreads[f"{c}_spread_bp"] = (frame[c] - frame["EUR_Risk_Free_10Y"]) * 100
    return spreads
