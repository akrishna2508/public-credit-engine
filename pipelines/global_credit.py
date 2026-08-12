"""Global Credit Opportunity pipeline: probe sources, assemble the board.

Every leg is availability-gated via sources.registry: a failing source
prints UNAVAILABLE with its reason and is skipped; the board is built only
from signal rows backed by real data.

Legs (Session 7 expansion): cot, options (IV-RV), skew, curve, sovereign,
global_rates, sector (EM OAS + EDGAR leverage), real_rates, appetite
(credit-appetite composite), em_carry, fx context.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config
from engine import (backtest, cot_positioning, credit_appetite, em_carry,
                    global_board, global_rates, options_surface, real_rates,
                    sector_screen, sovereign_screen, treasury_curve)
from sources.registry import SourceUnavailable


def _safe(label: str, loader):
    """Run loader; print a gated UNAVAILABLE note on failure, return None."""
    try:
        return loader()
    except SourceUnavailable as e:
        print(f"  [SKIP] {label}: {e}")
    except Exception as e:
        print(f"  [SKIP] {label}: {type(e).__name__}: {e}")
    return None


def _gate_leg(label: str, leg_key: str, hypothesis_sign: int) -> str | None:
    """Vote-gate one board leg on its walk-forward battery record (Q1).

    A leg votes ONLY when the battery validated its hypothesis sign with
    positive OOS economics (VALIDATED). REJECTED (fitted sign contradicts
    the hypothesis) and NOT_CONFIRMED (fitted sign OK but OOS Sharpe <= 0)
    legs abstain — no demonstrated edge, so they print a SKIP and are
    dropped instead of voting with a rejected prior or a losing flip.
    Without a battery record the leg still votes but is labeled UNVALIDATED
    (run `python cli.py --market backtest` to validate it).
    Returns the validation label for the detail line, or None when the leg
    must abstain (caller skips the row).
    """
    record = backtest.load_leg_validations().get(leg_key)
    status = backtest.leg_validation_status(record, hypothesis_sign)
    if status in ("REJECTED", "NOT_CONFIRMED"):
        fitted = record.get("fitted_sign")
        oos_sharpe = (record.get("metrics") or {}).get("sharpe")
        print(f"  [SKIP] {label}: walk-forward battery {status.lower()} — "
              f"fitted sign {fitted} (hypothesis {hypothesis_sign:+d}), "
              f"OOS Sharpe {oos_sharpe}; no demonstrated edge, vote withheld "
              f"(see data/backtest_legs.json)")
        return None
    return status


def _cot_rows(rows) -> None:
    from sources import cftc
    df = _safe("cot", lambda: cftc.fetch_positioning())
    if df is None:
        return
    for rec in cot_positioning.positioning_signals(df):
        if rec["status"] != "OK":
            print(f"  [SKIP] cot.{rec['market']}: {rec['status']}")
            continue
        validation = _gate_leg(f"cot.{rec['market']}", "COT-STRATEGY",
                               hypothesis_sign=1)
        if validation is None:
            continue
        rows.append({
            "name": f"COT {rec['market']}",
            "direction": ("LEV_LONG_CROWDED" if rec["lev_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "LEV_SHORT_CROWDED" if rec["lev_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": {"lev_z": rec["lev_z"]},
            "sources": ["CFTC COT (TFF)"],
            "detail": (f"as_of={rec['as_of']}, dealer_net={rec['dealer_net']} "
                       f"(dealer_z={rec['dealer_z']}), lev_net={rec['lev_net']}, "
                       f"validation={validation}"),
        })


def _options_rows(rows) -> None:
    frame = options_surface.history_to_frame(options_surface.load_iv_history())
    if frame.empty:
        print("  [SKIP] options: no accrued IV history yet (run `python -m sources.probe` daily)")
        return
    for ticker in frame.columns:
        iv = frame[ticker].dropna()
        if iv.empty:
            continue
        close = _safe(f"yf_etf.{ticker}", lambda t=ticker: _etf_close(t))
        if close is None:
            continue
        rv = options_surface.realized_vol_series(close)
        prem = options_surface.premium_series(iv, rv)
        z, n = options_surface.premium_z(prem, config.IV_Z_MIN_OBS)
        if z is None:
            print(f"  [SKIP] options.{ticker}: IV-RV accrual {n}/{config.IV_Z_MIN_OBS} days "
                  f"(z-score needs a month of history, R4)")
            continue
        # the IVRV battery validates the HYG hypothesis sign walk-forward;
        # other tickers have no battery record yet and vote UNVALIDATED.
        validation = None
        if ticker == "HYG":
            validation = _gate_leg(f"options.{ticker}", "IVRV", hypothesis_sign=1)
            if validation is None:
                continue
        rows.append({
            "name": f"Options IV-RV {ticker}",
            "direction": ("SELL_VOL" if z > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "BUY_VOL" if z < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": {"iv_rv_premium_z": round(z, 2)},
            "sources": ["yfinance options (accrued) + ETF returns"],
            "detail": (f"premium_obs={n}, atm_iv={float(iv.iloc[-1]):.4f}, "
                       f"rv_21d={options_surface.realized_vol(close):.4f}, "
                       f"validation={validation or 'UNVALIDATED'}"),
        })


def _curve_rows(rows) -> None:
    from sources import fred_ext
    curve = _safe("fred.curve", lambda: treasury_curve.assemble_curve(
        fred_ext.fetch_treasury_curve()))
    if curve is None or curve.empty:
        return
    z = treasury_curve.curve_position(curve)
    if "Slope_2s10s_z" not in z.columns:
        return
    validation = _gate_leg("curve.2s10s", "CURVE-STRATEGY", hypothesis_sign=1)
    if validation is None:
        return
    last_z = float(z["Slope_2s10s_z"].iloc[-1])
    # Labels are POSITIONS, not states: the mean-reversion hypothesis fades
    # the stretched slope. State steep (z>0) -> bet on flattening.
    direction = "LONG_FLATTENER" if last_z > 0 else "LONG_STEEPENER"
    rows.append({
        "name": "US Treasury 2s10s",
        "direction": direction,
        "signals": {"curve_z": round(last_z, 2)},
        "sources": ["FRED DGS2/DGS10"],
        "detail": (f"State: {last_z:+.2f} vs own 1y history "
                   f"(+ = steep, - = flat); position fades it (long ZN=F, "
                   f"short ZF=F per CURVE-STRATEGY); validation={validation}"),
    })


def _sovereign_rows(rows) -> None:
    from sources import world_bank
    wb = _safe("world_bank", world_bank.fetch_debt_snapshot)
    if wb is None or "EXT_DEBT_TOTAL" not in wb:
        return
    trend = sovereign_screen.trend_cagr(wb["EXT_DEBT_TOTAL"])
    if trend.empty:
        return
    top = trend.iloc[0]
    rows.append({
        "name": f"Sovereign debt trend: {top['country']}",
        "direction": "RISING_DEBT" if top["cagr"] > 0.05 else "STABLE",
        "signals": {"debt_cagr_5y": top["cagr"]},
        "sources": ["World Bank DT.DOD.DECT.CD"],
        "detail": f"Fastest 5y external-debt CAGR among observed countries "
                  f"({top['span_years']}y window)",
    })


def _global_rates_rows(rows) -> None:
    """Country/region yield matrix: which sovereigns are rich/cheap vs their
    own history and vs the US carry baseline (Session 7)."""
    from sources import fred_ext
    matrix = _safe("fred.global_sovereign", fred_ext.fetch_global_sovereign)
    if not matrix:
        return
    screen = _safe("global_rates", lambda: global_rates.global_rates_screen(matrix))
    if not screen or screen.get("status") != "OK":
        return
    regions = screen.get("regions", {})
    for reg in sorted(regions):
        r = regions[reg]
        signals = {}
        if r["level_z"] is not None:
            signals["level_z"] = r["level_z"]
        if r["carry_vs_us_z"] is not None:
            signals["carry_z"] = r["carry_vs_us_z"]
        if not signals:
            continue
        rows.append({
            "name": f"Global rates: {reg} (n={r['countries']})",
            "direction": ("LONG_DURATION" if r["level_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "SHORT_DURATION" if r["level_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": signals,
            "sources": ["FRED OECD IRLTLT01*"],
            "detail": (f"avg_10y={r['yield']}%, as_of={r['as_of']}, "
                       f"mom_3m_z={r['mom_3m_z']} (yields vs own 2y history)"),
        })
    # the two most extreme countries by level z (opportunity screen)
    countries = screen.get("countries", {})
    ranked = sorted([c for c in countries.values() if c["level_z"] is not None],
                    key=lambda c: abs(c["level_z"]), reverse=True)
    for c in ranked[:2]:
        rows.append({
            "name": f"Global rates: {c['country']}",
            "direction": ("LONG_DURATION" if c["level_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "SHORT_DURATION" if c["level_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": {"level_z": c["level_z"]},
            "sources": ["FRED OECD IRLTLT01*"],
            "detail": (f"10y={c['yield']}%, as_of={c['as_of']}, "
                       f"carry_vs_us_z={c['carry_vs_us_z']}"),
        })


def _sector_rows(rows) -> None:
    """EM credit segments by sector/ownership (OAS z) + US corporate
    leverage by sector (SEC EDGAR balance sheets)."""
    from sources import fred_ext, sec_edgar
    oas = _safe("fred.em_sector", fred_ext.fetch_em_sector_credit)
    if oas:
        for seg in sector_screen.em_sector_signals(oas):
            if seg["status"] != "OK" or seg["oas_z"] is None:
                continue
            rows.append({
                "name": f"EM sector spread: {seg['segment']}",
                "direction": ("CHEAP_BUY" if seg["oas_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                              else "RICH_AVOID" if seg["oas_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                              else "NEUTRAL"),
                "signals": {"oas_z": seg["oas_z"]},
                "sources": ["FRED ICE BofA EM sector OAS"],
                "detail": (f"oas={seg['oas']}bp, as_of={seg['as_of']}, "
                           f"chg_21d={seg['chg_21d']}"),
            })
    screen = _safe("sec_edgar.leverage", sec_edgar.leverage_screen)
    for row in sector_screen.leverage_signals(screen or {}):
        if row["leverage_z"] is None:
            continue
        rows.append({
            "name": f"Corp leverage: {row['sector']}",
            "direction": ("LEVERED_UP" if row["leverage_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "DELEVERING" if row["leverage_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": {"leverage_z": row["leverage_z"]},
            "sources": ["SEC EDGAR companyconcept (10-K)"],
            "detail": (f"med_lev={row['leverage']:.3f} (debt/assets), "
                       f"chg_3y={row['chg_3y']}, filers={row['filers']}, "
                       f"as_of={row['as_of']}"),
        })


def _real_rates_rows(rows) -> None:
    """TIPS real yield vs breakeven: long TIPS when real yields rich."""
    from sources import fred_ext
    inflation = _safe("fred.inflation", fred_ext.fetch_inflation)
    if not inflation:
        return
    sig = _safe("real_rates", lambda: real_rates.real_rates_signals(inflation))
    if not sig or sig.get("status") != "OK":
        return
    d10 = sig["components"].get("DFII10") or {}
    be10 = sig["components"].get("T10YIE") or {}
    if d10.get("z") is None:
        return
    validation = _gate_leg("real_rates.10y", "REAL-RATES", hypothesis_sign=1)
    if validation is None:
        return
    rows.append({
        "name": "Real rates 10Y (TIPS)",
        "direction": ("LONG_TIPS" if d10["z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                      else "SHORT_TIPS" if d10["z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                      else "NEUTRAL"),
        "signals": {"real_yield_z": d10["z"]},
        "sources": ["FRED DFII10/T10YIE"],
        "detail": (f"real_10y={d10['value']}% (as_of {d10['as_of']}), "
                   f"breakeven_10y={be10.get('value')}% z={be10.get('z')}, "
                   f"real_slope_5s10s={sig.get('real_slope_5s10s_bp')}bp, "
                   f"validation={validation}"),
    })


def _appetite_rows(rows) -> None:
    """Credit-appetite composite — the LIVE proxy for the COT IG/HY legs
    (which stay data-existence-gated until ~2028)."""
    from engine.data_engine import fetch_fred_series
    hy_oas = _safe("fred.hy_oas", lambda: fetch_fred_series("BAMLH0A0HYM2"))
    dr = _safe("fred.dr_hy", lambda: fetch_fred_series("DRCCLACBS"))
    components = {
        "hy_oas_z": credit_appetite.hy_oas_component(hy_oas),
        "dr_momentum_z": credit_appetite.default_rate_component(dr),
        "breadth_z": _breadth_z_safe(),
        "hyg_ivrv_z": credit_appetite.ivrv_component(_hyg_ivrv_z_safe()),
    }
    z, used, n = credit_appetite.appetite_z(components)
    if z is None:
        print(f"  [SKIP] appetite: {n}/2 components live "
              f"({'/'.join(used) or 'none'})")
        return
    validation = _gate_leg("appetite", "APPETITE", hypothesis_sign=1)
    if validation is None:
        return
    rows.append({
        "name": "Credit appetite (composite)",
        "direction": ("RISK_ON" if z > config.BOARD_SIGNAL_THRESHOLD_Z
                      else "RISK_OFF" if z < -config.BOARD_SIGNAL_THRESHOLD_Z
                      else "NEUTRAL"),
        "signals": {"appetite_z": z},
        "sources": ["FRED HY OAS + DR, FINRA, options (accrued)"],
        "detail": f"components: {', '.join(f'{k}={v}' for k, v in used.items())}, validation={validation}",
    })


def _breadth_z_safe() -> float | None:
    """Rolling z of FINRA corporate breadth (defensive: schema varies)."""
    from sources import finra
    frame = _safe("finra.breadth", finra.fetch_breadth)
    if frame is None or frame.empty:
        return None
    try:
        df = frame.copy()
        date_col = next((c for c in df.columns
                         if c.lower() in ("report_date", "date", "as_of_date",
                                          "tradereportdate")), None)
        if date_col is None:
            return None
        df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
        df = df.dropna(subset=[date_col])
        numeric = df.select_dtypes(include=[np.number])
        metric_col = next((c for c in numeric.columns if any(k in c.lower()
                          for k in ("volume", "traded", "count", "breadth"))), None)
        if metric_col is None:
            metric_col = numeric.columns[0] if len(numeric.columns) else None
        if metric_col is None:
            return None
        daily = df.groupby(date_col)[metric_col].sum().sort_index()
        roll = daily.rolling(63, min_periods=30)
        sd = roll.std(ddof=0).iloc[-1]
        if not np.isfinite(sd) or sd <= 0:
            return None
        return round(float((daily.iloc[-1] - roll.mean().iloc[-1]) / sd), 3)
    except Exception:
        return None


def _hyg_ivrv_z_safe() -> float | None:
    """Accrued HYG IV-RV premium z (None until the accrual gate unlocks)."""
    hist = options_surface.load_iv_history()
    if "HYG" not in hist:
        return None
    close = _safe("yf_etf.HYG", lambda: _etf_close("HYG"))
    if close is None:
        return None
    rv = options_surface.realized_vol_series(close)
    iv = options_surface.history_to_frame(hist)["HYG"].dropna()
    prem = options_surface.premium_series(iv, rv)
    z, _ = options_surface.premium_z(prem, config.IV_Z_MIN_OBS)
    return z


def _em_carry_rows(rows) -> None:
    """Local-currency vs hard-currency EM carry (fund distribution yields)."""
    closes, dividends = _etf_fund_data()
    if not closes or not dividends:
        print("  [SKIP] em_carry: no EM fund data")
        return
    carry = _safe("em_carry", lambda: em_carry.carry_screen(closes, dividends))
    if not carry or carry.get("status") != "OK":
        return
    signals = {"carry_diff_z": carry["carry_diff_z"]} if carry["carry_diff_z"] is not None else {}
    if not signals:
        return
    validation = _gate_leg("em_carry", "EM-CARRY", hypothesis_sign=1)
    if validation is None:
        return
    rows.append({
        "name": "EM local vs hard carry",
        "direction": ("LOCAL_CARRY" if carry["carry_diff_z"] > config.BOARD_SIGNAL_THRESHOLD_Z
                      else "HARD_CARRY" if carry["carry_diff_z"] < -config.BOARD_SIGNAL_THRESHOLD_Z
                      else "NEUTRAL"),
        "signals": signals,
        "sources": ["yfinance distributions (LEMB/PCY/VWOB/EMB/CEMB)"],
        "detail": (f"local_yield={carry['local_yield']}%, hard_yield={carry['hard_yield']}%, "
                   f"diff={carry['carry_diff']}pp, n={carry['n_months']}m, "
                   f"chg_3m={carry['chg_3m']}, validation={validation}"),
    })
    _fx_context()


def _skew_rows(rows) -> None:
    """Accrued 25-delta put skew on credit ETFs (polygon snapshots).

    Gated exactly like IV-RV: no z until SKEW_Z_MIN_OBS snapshots accrue,
    and only when the polygon source is live (yfinance chains carry no skew).
    """
    hist = options_surface.load_iv_history()
    for ticker in config.POLYGON_OPTION_ETFS:
        skew = options_surface.skew_series(hist, ticker)
        z, n = options_surface.skew_z(skew)
        if z is None:
            print(f"  [SKIP] skew.{ticker}: {n}/{config.SKEW_Z_MIN_OBS} accrued "
                  f"snapshots (needs polygon key + daily probe runs)")
            continue
        rows.append({
            "name": f"Put skew {ticker}",
            "direction": ("BUY_TAIL" if z < -config.BOARD_SIGNAL_THRESHOLD_Z
                          else "SELL_TAIL" if z > config.BOARD_SIGNAL_THRESHOLD_Z
                          else "NEUTRAL"),
            "signals": {"skew_z": round(z, 2)},
            "sources": ["Polygon options (accrued)"],
            "detail": f"latest_skew={float(skew.iloc[-1]):.4f} (put25-call25 IV), obs={n}",
        })


def _etf_fund_data() -> tuple[dict, dict]:
    """Close + dividend histories for the EM carry baskets (5y)."""
    import yfinance as yf
    funds = list(dict.fromkeys(config.EM_LOCAL_FUNDS + config.EM_HARD_FUNDS))
    closes, dividends = {}, {}
    for f in funds:
        t = yf.Ticker(f)
        df = _safe(f"yf_etf.{f}", lambda f=f: _etf_close(f))
        if df is None or df.empty:
            continue
        closes[f] = df
        try:
            acts = t.actions
            if acts is not None and not acts.empty and "Dividends" in acts.columns:
                dividends[f] = acts["Dividends"].dropna()
        except Exception:
            pass
    return closes, dividends


def _etf_close(ticker: str):
    """yfinance Close squeezed to a Series (the download quirk returns a
    one-column DataFrame; squeeze matches yf_futures/yf_fx behavior)."""
    import yfinance as yf
    df = yf.download(ticker, period="1y", progress=False, auto_adjust=True)
    if df is None or df.empty:
        return None
    close = df["Close"]
    if isinstance(close, pd.DataFrame):
        close = close.iloc[:, 0]
    return close.dropna()


def _fx_context() -> None:
    from sources import yf_fx
    fx = _safe("yf_fx", yf_fx.fetch_fx_panel)
    if fx is None:
        return
    print("\n  FX risk overlay (unhedged local-yield context):")
    for r in sovereign_screen.fx_risk_overlay(fx):
        if r.get("status", "OK") == "OK":
            print(f"    {r['pair']:<10} last={r['last']:>9} 20d={r['ret_20d']:>7.1%} "
                  f"ann_vol_63d={r['ann_vol_63d']:.1%}")


def run_global_credit(sources: list[str] | None = None, horizon: int | None = None) -> None:
    """Assemble the GCO board; `sources` optionally restricts the legs run.

    `horizon` is accepted for CLI symmetry with the other markets; the board
    itself has no forecast leg (its signals are current-state z-scores), so
    it is not used here — it applies to --market backtest and us."""
    print("=" * 78)
    print("  GLOBAL CREDIT OPPORTUNITY ENGINE (GCO)")
    print("=" * 78)
    want = set(sources or ["cot", "options", "skew", "curve", "sovereign", "fx",
                           "global_rates", "sector", "real_rates", "appetite",
                           "em_carry"])
    rows = []
    if "cot" in want:
        _cot_rows(rows)
    if "options" in want:
        _options_rows(rows)
    if "skew" in want:
        _skew_rows(rows)
    if "curve" in want:
        _curve_rows(rows)
    if "sovereign" in want:
        _sovereign_rows(rows)
    if "global_rates" in want:
        _global_rates_rows(rows)
    if "sector" in want:
        _sector_rows(rows)
    if "real_rates" in want:
        _real_rates_rows(rows)
    if "appetite" in want:
        _appetite_rows(rows)
    if "em_carry" in want:
        _em_carry_rows(rows)
    if "fx" in want and "em_carry" not in want:
        _fx_context()
    board = global_board.build_board(rows, config.BOARD_SIGNAL_THRESHOLD_Z)
    global_board.print_board(board)
    if not rows:
        print("\n  No signal blocks could be built with currently available free data.")
