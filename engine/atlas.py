"""Country atlas (Opportunity Map): pure logic for the per-country
instrument grid behind the portal view.

Every instrument leg follows the project honesty gates: real data only,
UNAVAILABLE when a source has nothing (never fabricated), and any proxy is
explicitly labeled. The CDS leg is UNAVAILABLE everywhere (no free CDS
series exist; verified live 2026-08-10 via FRED series search) and carries a
labeled "sovereign_spread_proxy" instead. The equity-ETF leg is labeled as
an equity (not debt) return because no liquid single-country sovereign debt
ETFs exist on yfinance.

Units: all inputs into this module are yields in percent (monthly FRED
OECD series, ECB csvdata percentages). Return changes are emitted in bps.
"""
from __future__ import annotations

import pandas as pd

MONTHLY_Z_WINDOW = 126  # ~10 years of monthly observations
MONTHLY_Z_MIN = 24      # need >= 2 years before a z-score is reported
DEFAULT_DURATION = 8.5  # approximate Macaulay duration of a 10Y sovereign
DAYS_PER_YEAR = 365     # annualization convention (heatmap spec §3.3/§3.4)


def yield_changes_bps(s: pd.Series, horizons: tuple[int, ...] = (1, 3, 12)) -> dict:
    """Yield change (bps) from the last observed value back to the last
    observation at least `h` months earlier. No look-ahead: only values at
    or before the as-of month-end are used."""
    clean = s.dropna()
    if len(clean) < 2:
        return {}
    out = {}
    last = clean.iloc[-1]
    cutoff = clean.index[-1] - pd.DateOffset(months=max(horizons))
    if len(clean) < 2 or clean.index.min() > cutoff:
        pass  # fall through; each horizon still tries its own cutoff
    for h in horizons:
        t = clean.index[-1] - pd.DateOffset(months=h)
        prev = clean.loc[:t]
        if len(prev):
            out[h] = round((last - prev.iloc[-1]) * 100.0, 2)
    return out


def price_return_proxy(dy_bps: float | None, duration: float = DEFAULT_DURATION) -> float | None:
    """Price-return proxy for a yield change: -D * (dy in decimal).

    A rise in yields lowers prices, so the sign flips. Returned in percent.
    """
    if dy_bps is None or not float(dy_bps) == dy_bps:
        return None
    return round(-(dy_bps / 100.0) * duration, 3)


def rolling_z_last(s: pd.Series, window: int = MONTHLY_Z_WINDOW,
                   min_obs: int = MONTHLY_Z_MIN) -> float | None:
    """z-score of the latest observation over a trailing rolling window."""
    clean = s.dropna().astype(float)
    if len(clean) < min_obs:
        return None
    roll = clean.rolling(window, min_periods=min_obs)
    mean = roll.mean().iloc[-1]
    sd = roll.std(ddof=0).iloc[-1]
    if not pd.notna(mean) or not pd.notna(sd) or sd <= 0:
        return None
    return round((clean.iloc[-1] - mean) / sd, 3)


def sovereign_spread_proxy(country_yield_pct: float | None,
                           us_yield_pct: float | None) -> dict:
    """CDS proxy: 10Y yield minus US 10Y (labeled, not a real CDS)."""
    if country_yield_pct is None or us_yield_pct is None:
        return {"status": "UNAVAILABLE"}
    return {
        "status": "proxy",  # real CDS has no free source; see module docstring
        "sovereign_spread_bps": round((country_yield_pct - us_yield_pct) * 100.0, 2),
    }


def heat_score(returns_pct: dict[str, float | None]) -> float | None:
    """Atlas heat value: unweighted mean of available 1-month price-return
    proxies across instrument legs (bonds proxy, equity ETF). No magic
    weights; missing legs are simply not counted."""
    vals = [v for v in returns_pct.values() if v is not None]
    if not vals:
        return None
    return round(sum(vals) / len(vals), 3)


def assemble_country(country_name: str, iso: str, region: str,
                     metrics: dict) -> dict:
    """Build one country node from a metrics bundle:
    metrics = {yield_pct, yields: {h: bps}, yield_z, bond_1m_pct,
               etf_1m_pct, etf_3m_pct, etf_12m_pct, spread_us_bps, ...}
    """
    debt = {"notes": "10Y OECD sovereign yield (FRED, monthly)"}
    if metrics.get("yield_pct") is not None:
        debt["yield_pct"] = metrics["yield_pct"]
        debt["yield_chg_bps"] = metrics.get("yields", {})
        debt["yield_z"] = metrics.get("yield_z")
        debt["bond_price_1m_pct"] = metrics.get("bond_1m_pct")
    else:
        debt["status"] = "UNAVAILABLE"
    node = {
        "name": country_name,
        "iso": iso,
        "region": region,
        "instruments": {
            "bonds": debt,
            "cds": sovereign_spread_proxy(metrics.get("yield_pct"),
                                          metrics.get("us_yield_pct")),
            "yield_spreads": {
                "vs_us_10y_bps": metrics.get("spread_us_bps")
                if metrics.get("spread_us_bps") is not None
                else (round((metrics["yield_pct"] - metrics["us_yield_pct"]) * 100.0, 2)
                      if metrics.get("yield_pct") is not None
                      and metrics.get("us_yield_pct") is not None else None),
                "vs_us_10y_z": metrics.get("spread_us_z"),
            },
            "equity_etf": {
                "label": "equity-return leg (no single-country debt ETF)",
                "ret_1m_pct": metrics.get("etf_1m_pct"),
                "ret_3m_pct": metrics.get("etf_3m_pct"),
                "ret_12m_pct": metrics.get("etf_12m_pct"),
            },
        },
    }
    node["heat"] = heat_score({"bond_1m": metrics.get("bond_1m_pct"),
                               "etf_1m": metrics.get("etf_1m_pct")})
    return node


def region_rollup(country_heats: dict[str, float | None],
                  regions: dict[str, str]) -> dict[str, float | None]:
    """Region heat: unweighted mean of member-country heats that exist."""
    out: dict[str, float | None] = {}
    for iso, heat in country_heats.items():
        region = regions.get(iso)
        if region is None or heat is None:
            continue
        bucket = out.setdefault(region, [])
        bucket.append(heat)
    return {r: round(float(sum(v) / len(v)), 3) for r, v in out.items() if v}


# ---------------------------------------------------------------------------
# Multi-asset heatmap spec legs (multi_asset_heatmap_spec.md §3).
# Every formula is the spec's, executed on real data only; any missing input
# returns None (the honest third state).
# ---------------------------------------------------------------------------

def straddle_yield_ann(straddle_price: float | None, spot: float | None,
                       dte: float | None) -> float | None:
    """Short-straddle yield (annualized): (P_straddle / Spot) * sqrt(365 / DTE).

    Spec §3.3. Returned as a fraction (e.g. 0.65 = 65% annualized). None when
    any input is missing or DTE <= 0."""
    if straddle_price is None or spot is None or dte is None:
        return None
    if spot <= 0 or dte <= 0:
        return None
    return round((straddle_price / spot) * (DAYS_PER_YEAR / dte) ** 0.5, 4)


def futures_basis_ann(futures_price: float | None, spot: float | None,
                      dte: float | None) -> float | None:
    """Annualized basis yield: ((Futures - Spot) / Spot) * (365 / DTE).

    Spec §3.4. Returned as a fraction. None when any input is missing,
    spot <= 0, or DTE <= 0."""
    if futures_price is None or spot is None or dte is None:
        return None
    if spot <= 0 or dte <= 0:
        return None
    return round((futures_price - spot) / spot * (DAYS_PER_YEAR / dte), 4)


def real_yield(nominal_y_pct: float | None, breakeven_pct: float | None) -> float | None:
    """Real yield: Y_10Y - expected inflation (spec §3.1), in percent.

    Only computed when BOTH legs are real data (US: FRED T10YIE breakeven).
    No fabricated inflation assumptions for other countries -> None."""
    if nominal_y_pct is None or breakeven_pct is None:
        return None
    return round(nominal_y_pct - breakeven_pct, 3)


def term_spread_bps(long_y_pct: float | None, short_y_pct: float | None) -> float | None:
    """Term spread in bps: (Y_long - Y_short) * 100 (spec §3.1 Slope)."""
    if long_y_pct is None or short_y_pct is None:
        return None
    return round((long_y_pct - short_y_pct) * 100.0, 2)


def geojson_feature_collection(doc: dict, latlon: dict[str, list[float]] | None = None,
                               coords: str = "Point") -> dict:
    """atlas.json -> GeoJSON FeatureCollection (portal heatmap, spec §1/§6).

    Pure builder: one Point feature per country at its centroid (latlon map)
    with properties = iso, name, region, heat and the 1m yield change bps.
    latlon entries are real country centroids from config.ATLAS_COUNTRY_LATLON
    (static geography, not fabricated market data)."""
    latlon = latlon or {}
    features = []
    for iso, node in (doc.get("countries") or {}).items():
        if not isinstance(node, dict):
            continue
        instruments = node.get("instruments") or {}
        bonds = instruments.get("bonds") or {}
        geo = latlon.get(iso, [0.0, 0.0])
        features.append({
            "type": "Feature",
            "properties": {
                "country_code": iso,
                "country_name": node.get("name", iso),
                "region": node.get("region"),
                "heatmap_score": node.get("heat"),
                "yield_10y_pct": bonds.get("yield_pct"),
                "yield_chg_1m_bps": (bonds.get("yield_chg_bps") or {}).get(1),
            },
            "geometry": {"type": coords, "coordinates": geo},
        })
    return {"type": "FeatureCollection", "features": features}


def country_metric_rows(doc: dict) -> list[dict]:
    """atlas.json -> country_financial_metrics rows (heatmap schema §4).

    One row per country node with the spec columns filled from whatever real
    data the node carries; missing legs stay None (never zero-filled)."""
    rows = []
    for iso, node in (doc.get("countries") or {}).items():
        if not isinstance(node, dict):
            continue
        inst = node.get("instruments") or {}
        bonds = inst.get("bonds") or {}
        spreads = inst.get("yield_spreads") or {}
        cds = inst.get("cds") or {}
        etf = inst.get("equity_etf") or {}
        curve = bonds.get("curve") or {}
        futures = inst.get("futures") or {}
        options = inst.get("options") or {}
        basis = next((v.get("basis_ann") for v in futures.values()
                      if isinstance(v, dict) and v.get("basis_ann") is not None), None)
        opt_primary = next((v for v in options.values() if isinstance(v, dict)), {})
        rows.append({
            "country_code": iso,
            "timestamp": (doc.get("generated") or ""),
            "yield_2y": curve.get("2y_pct"),
            "yield_5y": curve.get("5y_pct"),
            "yield_10y": bonds.get("yield_pct"),
            "yield_30y": curve.get("30y_pct"),
            "yield_spread_vs_ust": spreads.get("vs_us_10y_bps"),
            "cds_spread_bps": cds.get("sovereign_spread_bps"),
            "index_futures_basis_ann": basis,
            "implied_vol_30d": opt_primary.get("atm_iv_last"),
            "realized_vol_30d": etf.get("rv_30d"),
            "volatility_risk_premium": opt_primary.get("vrp"),
            "straddle_yield_ann": opt_primary.get("straddle_yield_ann"),
            "composite_heatmap_score": node.get("heat"),
        })
    return rows