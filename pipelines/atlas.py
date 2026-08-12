"""Country atlas (Opportunity Map) pipeline: per-country instrument grid.

Fetch layer only. Pure math lives in engine.atlas.py. Emits
data/atlas.json + a console map. The portal UI layer (not built here) can
consume the JSON as-is: mapping by ISO code, heat per country, and the
click-through instrument sections.

Instrument sections per country:
  bonds         10Y OECD sovereign yield (FRED monthly) + changes + z
  bond_curve    US full 2y/5y/10y/30y (FRED daily) + real yield (T10YIE);
                euro area 1y-30y AAA curve (ECB daily) + 2s10s
  cds           UNAVAILABLE everywhere + labeled sovereign-spread proxy
  yield_spreads vs-US-10Y spread (+ its z), plus the US/EZ 2s10s legs
  irf_spreads   US only: SOFR continuous implied 3M + quarterly strip
                snapshot slope (futures seam caveat documented in
                engine.futures_layer); euro-area 2s10s from the ECB curve
  futures       momentum for note futures (no rolled PnL) + cash-index
                basis/carry for ES=F/^GSPC and NQ=F/^NDX (heatmap §3.4)
  options       IV-RV history + ATM-straddle annualized yield (heatmap §3.3)
                — US credit ETFs
  equity_etf    labeled auxiliary equity-return leg per country (+ RV_30d)
"""
from __future__ import annotations

import json
import os

import numpy as np
import pandas as pd
import yfinance as yf

import config
from engine import atlas, data_engine, futures_layer

IV_HISTORY_FILE = os.path.join("data", "iv_history.json")


def _fred_yield(iso: str) -> pd.Series:
    return data_engine.fetch_fred_series(config.ATLAS_COUNTRY_YIELDS[iso])


def _etf_returns(ticker: str) -> dict:
    out: dict = {}
    try:
        h = yf.Ticker(ticker).history(period="5y", auto_adjust=True)["Close"]
    except Exception:
        return {"status": "UNAVAILABLE"}
    if h.empty or len(h) < 21:
        return {"status": "UNAVAILABLE"}
    last = h.iloc[-1]
    for lab, sess in (("ret_1m_pct", 21), ("ret_3m_pct", 63), ("ret_12m_pct", 252)):
        if len(h) > sess:
            out[lab] = round((last / h.iloc[-1 - sess] - 1) * 100.0, 3)
    out["rv_30d"] = _rv_30d(h)
    return out


def _rv_30d(close: pd.Series, window: int | None = None) -> float | None:
    """30-day annualized realized vol of log returns (heatmap spec §3.3 RV_30d).

    On the ETF's OWN returns — same underlying as any listed IV from the
    options leg (R4 invariant)."""
    window = window or config.ATLAS_RV_WINDOW
    logret = (np.log(close / close.shift(1))).dropna()
    rv = logret.rolling(window, min_periods=window // 2).std(ddof=0) * np.sqrt(252)
    return round(float(rv.dropna().iloc[-1]), 4) if len(rv.dropna()) else None


def _monthly_bundle(iso: str, us_yield: float | None) -> dict:
    """Per-country metrics from the OECD monthly 10Y series."""
    s = _fred_yield(iso)
    if s.empty:
        return {"available": False, "iso": iso}
    yld = float(s.iloc[-1])
    b = {
        "available": True,
        "iso": iso,
        "yield_pct": round(yld, 3),
        "as_of": str(s.index.max().date()),
        "yields": atlas.yield_changes_bps(s),
        "yield_z": atlas.rolling_z_last(s),
        "us_yield_pct": us_yield,
        "spread_us_bps": round((yld - us_yield) * 100.0, 2) if us_yield is not None else None,
        "spread_us_z": None,
    }
    dy1 = b["yields"].get(1) if "yields" in b else None
    b["bond_1m_pct"] = atlas.price_return_proxy(dy1)
    etf = config.ATLAS_COUNTRY_ETFS.get(iso)
    if etf:
        b.update(_etf_returns(etf))
    return b


def _us_extra_sections(us_10y_pct: float | None) -> dict:
    """Deep US instrument sections: full curve, real yield, 2s10s, index
    futures basis, SOFR strip, options (IV/RV/straddle)."""
    out: dict = {}
    # Full nominal curve 2y/5y/10y/30y (FRED) + real yield (T10YIE breakeven)
    curve: dict = {}
    try:
        for sid, label in config.ATLAS_US_CURVE.items():
            s = data_engine.fetch_fred_series(sid)
            if not s.empty:
                curve[label + "_pct"] = round(float(s.dropna().iloc[-1]), 3)
        if curve.get("10y_pct"):
            dgs10 = data_engine.fetch_fred_series("DGS10")
            dgs2 = data_engine.fetch_fred_series("DGS2")
            brek = data_engine.fetch_fred_series(config.ATLAS_US_BREAKEVEN)
            if not brek.empty:
                curve["real_10y_pct"] = atlas.real_yield(
                    curve["10y_pct"], round(float(brek.dropna().iloc[-1]), 3))
                curve["breakeven_10y_pct"] = round(float(brek.dropna().iloc[-1]), 3)
            curve.setdefault("2s10s_bps", round(float((dgs10 - dgs2).dropna().iloc[-1]) * 100.0, 2)
                             if not dgs10.empty and not dgs2.empty else None)
    except Exception as e:
        print(f"  [UNAVAILABLE] US curve/breakeven: {e}")
    if curve:
        out["bond_curve"] = curve
    # 2s10s daily leg (US only; DGS2 does not exist per country on FRED)
    try:
        dgs10 = data_engine.fetch_fred_series("DGS10")
        dgs2 = data_engine.fetch_fred_series("DGS2")
        if not dgs10.empty and not dgs2.empty:
            slope = (dgs10 - dgs2).dropna()
            out["yield_spreads"] = {
                "2s10s_bps": round(float(slope.iloc[-1]) * 100.0, 2),
                "2s10s_z": atlas.rolling_z_last(slope, window=252, min_obs=63),
            }
    except Exception as e:
        print(f"  [UNAVAILABLE] US 2s10s: {e}")
    # Cash-index futures basis/carry (heatmap spec §3.4; ES=F/^GSPC live,
    # NQ=F/^NDX live — see config.ATLAS_INDEX_FUTURES)
    try:
        pairs = config.ATLAS_INDEX_FUTURES.get("US", [])
        for fut_t, spot_t in pairs:
            try:
                data = yf.download([fut_t, spot_t], period="1mo", progress=False,
                                   auto_adjust=True)["Close"]
                fut = data[fut_t].dropna()
                spot = data[spot_t].dropna()
                basis = futures_layer.index_futures_basis(fut, spot)
                if basis.get("status") == "ok":
                    out.setdefault("futures", {})
                    out["futures"][f"{fut_t}/{spot_t}"] = basis
            except Exception as e:
                print(f"  [UNAVAILABLE] basis {fut_t}/{spot_t}: {e}")
    except Exception as e:
        print(f"  [UNAVAILABLE] index futures basis: {e}")
    # Futures: momentum only (futures_layer seam caveat) + SOFR implied rate
    fut: dict = {}
    try:
        panel = yf.download(config.RATE_FUTURES_TICKERS, period="1y",
                            progress=False, auto_adjust=True)["Close"]
    except Exception:
        panel = pd.DataFrame()
    if panel is not None and not panel.empty:
        futures_layer_panel = {t: panel[t].dropna() for t in config.RATE_FUTURES_TICKERS}
        for t, s in futures_layer_panel.items():
            if t not in out.get("futures", {}) and not s.empty:
                out.setdefault("futures", {}).update(futures_layer.futures_summary({t: s}))
        sr3 = futures_layer.sofr_expected_rate(futures_layer_panel)
        out["irf_spreads"] = {"sofr_implied_3m_bps": sr3.get("rate_bp"),
                              "note": "back-month SOFR contracts are not "
                                      "listed on yfinance (404 verified "
                                      "2026-08-10); strip slope UNAVAILABLE"}
    # Options: IV-RV accrual history + ATM straddle yield (heatmap spec §3.3)
    try:
        with open(IV_HISTORY_FILE) as f:
            iv_hist = json.load(f)
        options = {}
        for ticker, entries in iv_hist.items():
            if not isinstance(entries, dict):
                continue
            days = sorted(entries)[-20:]
            ivs = []
            for d in days:
                e = entries[d]
                if (isinstance(e, dict) and e.get("atm_iv") is not None
                        and float(e["atm_iv"]) > config.IV_MIN_REAL):  # stub-IV gate
                    ivs.append(float(e["atm_iv"]))
            if not ivs:
                continue
            opt = {"obs_days": len(ivs), "atm_iv_last": round(ivs[-1], 4),
                   "as_of": days[-1]}
            last = entries[days[-1]]
            if isinstance(last, dict):
                if last.get("atm_straddle_price") is not None and last.get("dte_days"):
                    opt["straddle_yield_ann"] = atlas.straddle_yield_ann(
                        float(last["atm_straddle_price"]),
                        float(last.get("underlying") or 0.0),
                        float(last["dte_days"]))
                    opt["straddle_price_usd"] = float(last["atm_straddle_price"])
                rv = None
                try:
                    rv = _rv_30d(yf.Ticker(ticker).history(period="2y",
                                                           auto_adjust=True)["Close"])
                except Exception:
                    pass
                if rv is not None:
                    opt["rv_30d"] = rv
                    opt["vrp"] = round(ivs[-1] - rv, 4)
            if len(ivs) >= 20:
                opt["iv_z"] = None  # accrual < 20 days for all tickers (tracked)
                ivs_s = pd.Series(ivs)
                z = (ivs_s.iloc[-1] - ivs_s.mean()) / ivs_s.std(ddof=0)
                if ivs_s.std(ddof=0) > 0:
                    opt["iv_z"] = round(z, 3)
                opt["put_call_oi_ratio"] = entries[days[-1]].get("put_call_oi_ratio")
            options[ticker] = opt
        if options:
            out["options"] = options
    except (OSError, json.JSONDecodeError) as e:
        print(f"  [UNAVAILABLE] IV history: {e}")
    return out


def _euro_area_node() -> dict:
    """Euro-area region node from the ECB curve (verified live 2026-08-10)."""
    try:
        from sources.ecb import fetch_sdmx
        curves = {}
        for label, key in config.ECB_YIELD_KEYS.items():
            try:
                curves[label] = fetch_sdmx(key)
            except Exception:
                continue
        a10 = curves.get("EA_GOV_AAA_10Y")
        if a10 is None:
            raise RuntimeError("no ECB AAA 10Y series")
    except Exception as e:
        print(f"  [UNAVAILABLE] ECB euro-area curve: {e}")
        return {"name": "Euro Area", "iso": "EZ", "region": "europe",
                "instruments": {"bonds": {"status": "UNAVAILABLE"}}}
    yld = float(a10.dropna().iloc[-1])
    slope = (a10 - curves["EA_GOV_AAA_2Y"]).dropna()
    dy1 = atlas.yield_changes_bps(a10).get(1)

    # Full AAA curve 1Y/2Y/5Y/10Y/30Y (all keys live) + term spreads; real
    # yield is UNAVAILABLE for the euro area (no free breakeven-inflation
    # series for the EZ exists — FRED only publishes the US T10YIE).
    rates = {}
    for label, ten in (("EA_GOV_AAA_1Y", "1y"), ("EA_GOV_AAA_2Y", "2y"),
                       ("EA_GOV_AAA_5Y", "5y"), ("EA_GOV_AAA_10Y", "10y"),
                       ("EA_GOV_AAA_30Y", "30y")):
        s = curves.get(label)
        if s is not None and not s.empty:
            rates[ten + "_pct"] = round(float(s.dropna().iloc[-1]), 3)
    if len(rates) >= 2:
        rates["2s10s_bps"] = atlas.term_spread_bps(rates.get("10y_pct"),
                                                   rates.get("2y_pct"))
        rates["note"] = "real yield UNAVAILABLE: no free euro-area breakeven series"

    return {
        "name": "Euro Area", "iso": "EZ", "region": "europe",
        "heat": atlas.heat_score({"bond_1m": atlas.price_return_proxy(dy1),
                                  "etf_1m": None}),
        "instruments": {
            "bonds": {"yield_pct": round(yld, 3), "source": "ECB AAA 10Y (daily)",
                      "yield_chg_bps": atlas.yield_changes_bps(a10),
                      "curve": rates},
            "yield_spreads": {"2s10s_bps": round(float(slope.iloc[-1]) * 100.0, 2),
                              "2s10s_z": atlas.rolling_z_last(slope, window=504,
                                                              min_obs=126)},
            "cds": atlas.sovereign_spread_proxy(yld, None),
            "irf_spreads": {"status": "UNAVAILABLE",
                            "reason": "no Bund futures on yfinance (FGBL=F not listed)"},
        },
    }


def run_atlas() -> None:
    print("=" * 75)
    print("  COUNTRY ATLAS (Opportunity Map) — data layer only, portal-ready")
    print("=" * 75)
    us_b = _monthly_bundle("US", None)
    us_yield = us_b.get("yield_pct")
    countries: dict = {}
    for iso in config.ATLAS_COUNTRY_YIELDS:
        b = _monthly_bundle(iso, us_yield)
        if not b.get("available"):
            print(f"  [UNAVAILABLE] {iso}: FRED series empty")
            continue
        countries[iso] = atlas.assemble_country(
            iso, iso, config.ATLAS_REGIONS.get(iso, "other"), b)
    us_node = countries.get("US")
    if us_node is not None:
        us_node["instruments"].update(_us_extra_sections(us_yield))
        us_node["instruments"]["cds"] = {
            "status": "proxy", "sovereign_spread_bps": 0.0,
            "note": "US is the base country; corporate CDS proxy = ICE OAS in "
                    "spreads.py (no free CDS series exist anywhere)",
        }
        us_node["instruments"]["yield_spreads"].update({"vs_us_10y_bps": 0.0})
    countries["EZ"] = _euro_area_node()

    rolls = atlas.region_rollup({i: c.get("heat") for i, c in countries.items()
                                 if isinstance(c.get("heat"), (int, float))},
                                config.ATLAS_REGIONS)
    doc = {
        "generated": str(pd.Timestamp.now().normalize().date()),
        "schema": "per-country instrument grid; heat = unweighted mean of "
                  "available 1m price-return proxies (bonds + equity leg). "
                  "Spec legs: term structure (2y/5y/10y/30y + 2s10s), real "
                  "yield (US T10YIE breakeven only), CDS proxy, RV_30d per "
                  "country ETF, IV/VRP/ATM-straddle yield (accrued chains), "
                  "index-futures basis (ES/NQ), SOFR implied rate",
        "regions": rolls,
        "countries": countries,
    }
    os.makedirs("data", exist_ok=True)
    with open(os.path.join("data", "atlas.json"), "w") as f:
        json.dump(doc, f, indent=1, default=str)
    print(f"\n  Atlas written:  data/atlas.json  ({len(countries)} nodes)")
    print(f"\n  {'ISO':<5}{'Region':<10}{'10Y %':>8}{'1m chg bps':>12}{'Heat (1m)':>12}")
    print("  " + "-" * 47)
    for iso, c in countries.items():
        inst = c.get("instruments", {})
        b = inst.get("bonds", {})
        yld = b.get("yield_pct")
        dy = (b.get("yield_chg_bps") or {}).get(1)
        heat = c.get("heat")
        y = f"{yld:.2f}" if yld is not None else "n/a"
        d = f"{dy:.1f}" if dy is not None else "n/a"
        h = f"{heat:+.3f}" if heat is not None else "n/a"
        print(f"  {iso:<5}{c.get('region',''):<10}{y:>8}{d:>12}{h:>12}")
    if rolls:
        print("\n  Region rollup heat:", rolls)