"""Backtest pipeline: out-of-sample validation of the GCO signal legs.

Each leg records its actual sample window — a short or partial history is
printed, never dressed up as a long validated record. Legs are gated:
unavailable data reports UNAVAILABLE.

`horizon` parameterizes the forward window (default 21 business days).
Strategy legs report BOTH the economic-hypothesis sign and a genuine
walk-forward sign fit (split-sample, 1-day execution delay). Session 7
added legs for the new signals: global_rates, sector, real_rates, appetite,
em_carry, skew.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config
from engine import backtest, cot_positioning, global_rates, treasury_curve
from sources.registry import SourceUnavailable


def _fwd(df: pd.DataFrame, col: str, horizon: int) -> pd.Series:
    return df[col].shift(-horizon) / df[col] - 1


def _bt_curve(horizon: int = 21) -> None:
    """2s10s z-score vs forward DGS10 move (FRED, gated on key)."""
    from sources import fred_ext
    try:
        curve = treasury_curve.assemble_curve(fred_ext.fetch_treasury_curve())
        z = treasury_curve.curve_position(curve)
        if curve.empty or "Slope_2s10s_z" not in z.columns or "DGS10" not in curve.columns:
            print("  [CURVE] UNAVAILABLE: required curve series missing")
            return
        fwd = curve["DGS10"].shift(-horizon) / curve["DGS10"] - 1
        print(f"  [CURVE] 2s10s-z vs forward {horizon}d 10Y move:",
              backtest.directional_hit_rate(z["Slope_2s10s_z"], fwd))
        print("  [CURVE] rank IC:",
              backtest.information_coefficient(z["Slope_2s10s_z"], fwd))
    except SourceUnavailable as e:
        print(f"  [CURVE] {e}")


def _bt_cot(horizon: int = 21) -> None:
    """COT leveraged-money z vs forward 10Y yield move (weekly -> daily reindex)."""
    import yfinance as yf
    from sources import cftc
    try:
        df = cftc.fetch_positioning()
        tnx = yf.download("^TNX", period="5y", progress=False, auto_adjust=True)["Close"].dropna()
        if isinstance(tnx, pd.DataFrame):
            tnx = tnx.iloc[:, 0]
        if tnx.empty:
            print("  [COT] UNAVAILABLE: ^TNX returned no data")
            return
        for rec in cot_positioning.positioning_signals(df):
            if rec["status"] != "OK" or rec["market"] != "UST 10Y NOTE":
                continue
            sub = df[df["market"].str.startswith("UST 10Y NOTE")].copy()
            sub["report_date"] = pd.to_datetime(sub["report_date"])
            lev = (sub["LevMoney_Long"] - sub["LevMoney_Short"])
            lev.index = pd.to_datetime(sub["report_date"])
            z = cot_positioning.zscore(lev)
            daily = z.reindex(tnx.index.union(z.index)).ffill().dropna()
            # CFTC publishes Tuesday-report data on Friday: shift the signal
            # 3 business days so the test is executable, not look-ahead.
            daily = daily.shift(3).dropna()
            fwd = tnx.shift(-horizon) / tnx - 1
            print(f"  [COT] lev-z vs forward {horizon}d 10Y yield move: "
                  f"{backtest.directional_hit_rate(daily, fwd)}")
            print(f"  [COT] sample: {rec['obs']} weekly obs, {rec['hist_years']}y history")
    except SourceUnavailable as e:
        print(f"  [COT] {e}")


def _bt_cot_strategy() -> None:
    """Sharpe/Sortino of a rule on ZN=F in the sign of the 10Y lev-z,
    with a walk-forward sign fit (1-day execution delay)."""
    from sources import cftc, yf_futures
    try:
        df = cftc.fetch_positioning()
        panel = yf_futures.fetch_futures_panel()
        zn = panel.get("ZN=F")
        if zn is None or zn.empty:
            print("  [COT-STRATEGY] UNAVAILABLE: ZN=F not in futures panel")
            return
        lev = None
        for rec in cot_positioning.positioning_signals(df):
            if rec["status"] == "OK" and rec["market"] == "UST 10Y NOTE":
                sub = df[df["market"].str.startswith("UST 10Y NOTE")].copy()
                sub["report_date"] = pd.to_datetime(sub["report_date"])
                lev = (sub["LevMoney_Long"] - sub["LevMoney_Short"])
                lev.index = pd.to_datetime(sub["report_date"])
        if lev is None:
            print("  [COT-STRATEGY] UNAVAILABLE: UST 10Y NOTE positioning missing")
            return
        z = cot_positioning.zscore(lev)
        daily = z.reindex(zn.index.union(z.index)).ffill().dropna().shift(3).dropna()
        ret = zn.pct_change().dropna()
        pos = np.sign(daily)
        strat = (pos.shift(1) * ret).dropna()  # hypothesis sign, prior close
        print("  [COT-STRATEGY] lev-z long/short ZN=F (hypothesis sign, 1-day exec delay):",
              backtest.strategy_metrics(strat))
        oos = backtest.sign_fit_oos(daily, ret)
        if oos.get("fitted_sign") is None:
            print(f"  [COT-STRATEGY] OOS: {oos['status']}")
        else:
            print(f"  [COT-STRATEGY] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
                  f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
            backtest.persist_leg_validation("COT-STRATEGY", oos, hypothesis_sign=1)
        if oos["status"] == "OK":
            print("  [COT-STRATEGY] OOS (fitted sign):", oos["metrics"])
        else:
            print(f"  [COT-STRATEGY] OOS: {oos['status']}")
        print(f"  [COT-STRATEGY] sample: {len(strat)} daily obs, "
              f"{len(lev)} weekly COT obs")
    except SourceUnavailable as e:
        print(f"  [COT-STRATEGY] {e}")


def _bt_curve_strategy() -> None:
    """Sharpe/Sortino of a mean-reversion rule on the 2s10s spread
    (long ZN=F, short ZF=F), with a walk-forward sign fit."""
    from sources import fred_ext, yf_futures
    try:
        curve = treasury_curve.assemble_curve(fred_ext.fetch_treasury_curve())
        z = treasury_curve.curve_position(curve)
        panel = yf_futures.fetch_futures_panel()
        zn, zf = panel.get("ZN=F"), panel.get("ZF=F")
        if (curve.empty or "Slope_2s10s_z" not in z.columns
                or zn is None or zn.empty or zf is None or zf.empty):
            print("  [CURVE-STRATEGY] UNAVAILABLE: curve series or ZN=F/ZF=F missing")
            return
        slope_z = z["Slope_2s10s_z"]
        daily = slope_z.reindex(zn.index.union(slope_z.index)).ffill().dropna()
        spread_ret = (zn.pct_change() - zf.pct_change()).dropna()
        pos = np.sign(daily)
        strat = (pos.shift(1) * spread_ret).dropna()  # hypothesis sign, prior close
        print("  [CURVE-STRATEGY] 2s10s slope-z mean-reversion on ZN-F/ZF=F "
              "(hypothesis sign, 1-day exec delay):", backtest.strategy_metrics(strat))
        oos = backtest.sign_fit_oos(daily, spread_ret)
        if oos.get("fitted_sign") is None:
            print(f"  [CURVE-STRATEGY] OOS: {oos['status']}")
        else:
            print(f"  [CURVE-STRATEGY] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
                  f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
            backtest.persist_leg_validation("CURVE-STRATEGY", oos, hypothesis_sign=1)
        if oos["status"] == "OK":
            print("  [CURVE-STRATEGY] OOS (fitted sign):", oos["metrics"])
        else:
            print(f"  [CURVE-STRATEGY] OOS: {oos['status']}")
        print(f"  [CURVE-STRATEGY] sample: {len(strat)} daily obs, "
              f"{len(slope_z.dropna())} slope-z obs")
    except SourceUnavailable as e:
        print(f"  [CURVE-STRATEGY] {e}")


def _bt_global_rates(horizon: int = 21) -> None:
    """Regional yield momentum z vs forward 3m yield change (monthly data)."""
    from sources import fred_ext
    try:
        matrix = fred_ext.fetch_global_sovereign()
        screen = global_rates.global_rates_screen(matrix)
        if screen.get("status") != "OK":
            print("  [GLOBAL-RATES] UNAVAILABLE: no sovereign series")
            return
        m = screen["matrix"]
        fwd_win = max(3, horizon // 21)  # monthly steps
        for region in config.GLOBAL_RATE_REGIONS:
            members = [c for c in config.GLOBAL_RATE_REGIONS[region] if c in m.columns]
            if not members:
                continue
            avg = m[members].mean(axis=1).dropna()
            if len(avg) < 24:
                continue
            mom = (avg / avg.shift(3) - 1).dropna()
            sig = _roll_z(mom)
            fwd_chg = avg.shift(-fwd_win) / avg - 1
            print(f"  [GLOBAL-RATES.{region}] mom-z vs forward {fwd_win}m yield change:",
                  backtest.directional_hit_rate(sig, fwd_chg))
            print(f"  [GLOBAL-RATES.{region}] rank IC:",
                  backtest.information_coefficient(sig, fwd_chg))
    except SourceUnavailable as e:
        print(f"  [GLOBAL-RATES] {e}")


def _roll_z(s: pd.Series, window: int = 24, min_periods: int = 12) -> pd.Series:
    roll = s.rolling(window, min_periods=min_periods)
    return ((s - roll.mean()) / roll.std(ddof=0).replace(0, np.nan)).dropna()


def _bt_sector(horizon: int = 21) -> None:
    """EM sector OAS z vs forward 63d spread change (daily series)."""
    from sources import fred_ext
    try:
        oas = fred_ext.fetch_em_sector_credit()
        if not oas:
            print("  [SECTOR] UNAVAILABLE: no EM sector OAS series")
            return
        for label, s in oas.items():
            if s is None or len(s) < 100:
                continue
            sig = _roll_z(s, 252, 63)
            fwd = s.shift(-horizon) / s - 1
            print(f"  [SECTOR.{label}] OAS-z vs forward {horizon}d spread move:",
                  backtest.directional_hit_rate(sig, fwd))
            print(f"  [SECTOR.{label}] rank IC:",
                  backtest.information_coefficient(sig, fwd))
    except SourceUnavailable as e:
        print(f"  [SECTOR] {e}")


def _bt_real_rates() -> None:
    """DFII10 real-yield z vs forward 21d TIP returns (hypothesis + OOS fit)."""
    import yfinance as yf
    from sources import fred_ext
    try:
        inflation = fred_ext.fetch_inflation()
        tip = yf.download("TIP", period="5y", progress=False, auto_adjust=True)["Close"].dropna()
        if isinstance(tip, pd.DataFrame):
            tip = tip.iloc[:, 0]
        d10 = inflation.get("DFII10")
        if d10 is None or d10.empty or tip is None or tip.empty:
            print("  [REAL-RATES] UNAVAILABLE: DFII10 or TIP missing")
            return
        z = _roll_z(d10, 252, 63)
        ret = tip.pct_change().dropna()
        daily = z.reindex(ret.index.union(z.index)).ffill().dropna()
        pos = np.sign(daily)
        strat = (pos.shift(1) * ret).dropna()
        print("  [REAL-RATES] DFII10-z long TIP (hypothesis: high real yield = buy TIPS):",
              backtest.strategy_metrics(strat))
        oos = backtest.sign_fit_oos(daily, ret)
        if oos.get("fitted_sign") is None:
            print(f"  [REAL-RATES] OOS: {oos['status']}")
        else:
            print(f"  [REAL-RATES] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
                  f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
            backtest.persist_leg_validation("REAL-RATES", oos, hypothesis_sign=1)
        if oos["status"] == "OK":
            print("  [REAL-RATES] OOS (fitted sign):", oos["metrics"])
        print(f"  [REAL-RATES] sample: {len(strat)} daily obs")
    except SourceUnavailable as e:
        print(f"  [REAL-RATES] {e}")


def _bt_appetite(horizon: int = 21) -> None:
    """Appetite composite z vs forward HYG returns (hypothesis + OOS fit).

    The composite needs its full history to backtest honestly: we build it
    from the two long-history components (HY OAS z, DR momentum z) so the
    walk-forward battery validates the SAME signal the board trades today."""
    import yfinance as yf
    from engine.data_engine import fetch_fred_series
    try:
        hyg = yf.download("HYG", period="10y", progress=False, auto_adjust=True)["Close"].dropna()
        if isinstance(hyg, pd.DataFrame):
            hyg = hyg.iloc[:, 0]
        hy_oas = fetch_fred_series("BAMLH0A0HYM2")
        dr = fetch_fred_series("DRCCLACBS")
        if hy_oas.empty or dr.empty or hyg is None or hyg.empty:
            print("  [APPETITE] UNAVAILABLE: HY OAS / DR / HYG missing")
            return
        oas_z = -_roll_z(hy_oas, 252, 63)
        dr_monthly = dr.dropna().resample("MS").last().dropna()
        if dr_monthly.empty:
            print("  [APPETITE] UNAVAILABLE: DR series empty after monthly resample")
            return
        dr_mom = dr_monthly.diff(6).dropna()
        dr_z = -_roll_z(dr_mom)
        # DR observations are quarterly; the composite stops contributing
        # 1 business month after the last one (no frozen stale tail).
        dr_z_daily = dr_z.reindex(oas_z.index).ffill(limit=21)
        app = pd.concat([oas_z, dr_z_daily], axis=1).dropna()
        if app.empty:
            print("  [APPETITE] UNAVAILABLE: OAS/DR history does not overlap")
            return
        composite = app.mean(axis=1)
        ret = hyg.pct_change().dropna()
        daily = composite.reindex(ret.index.union(composite.index)).ffill().dropna()
        pos = np.sign(daily)
        strat = (pos.shift(1) * ret).dropna()
        print("  [APPETITE] composite-z long HYG (hypothesis: appetite up = risk-on):",
              backtest.strategy_metrics(strat))
        oos = backtest.sign_fit_oos(daily, ret)
        if oos.get("fitted_sign") is None:
            print(f"  [APPETITE] OOS: {oos['status']}")
        else:
            print(f"  [APPETITE] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
                  f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
            backtest.persist_leg_validation("APPETITE", oos, hypothesis_sign=1)
        if oos["status"] == "OK":
            print("  [APPETITE] OOS (fitted sign):", oos["metrics"])
        print(f"  [APPETITE] sample: {len(strat)} daily obs")
    except SourceUnavailable as e:
        print(f"  [APPETITE] {e}")


def _bt_em_carry() -> None:
    """Local-hard carry differential z vs forward LEMB/EMB relative return."""
    import yfinance as yf
    from engine import em_carry
    try:
        closes, dividends = _bt_fund_data()
        carry = em_carry.carry_screen(closes, dividends)
        if carry.get("status") != "OK":
            print(f"  [EM-CARRY] UNAVAILABLE: {carry.get('status')}")
            return
        # monthly differential series rebuilt for the walk-forward
        local = em_carry.basket_yield(closes, dividends, config.EM_LOCAL_FUNDS)
        hard = em_carry.basket_yield(closes, dividends, config.EM_HARD_FUNDS)
        diff = (local - hard).dropna()
        if len(diff) < 24:
            print(f"  [EM-CARRY] UNAVAILABLE: only {len(diff)} months of carry history")
            return
        z = _roll_z(diff, 24, 12)
        lemb = yf.download("LEMB", period="5y", progress=False, auto_adjust=True)["Close"].dropna()
        emb = yf.download("EMB", period="5y", progress=False, auto_adjust=True)["Close"].dropna()
        if isinstance(lemb, pd.DataFrame):
            lemb = lemb.iloc[:, 0]
        if isinstance(emb, pd.DataFrame):
            emb = emb.iloc[:, 0]
        rel = lemb / emb
        rel_ret = rel.pct_change().dropna()
        daily = z.reindex(rel_ret.index.union(z.index)).ffill().dropna()
        pos = np.sign(daily)
        strat = (pos.shift(1) * rel_ret).dropna()
        print("  [EM-CARRY] carry-z long LEMB/short EMB (hypothesis: high local carry):",
              backtest.strategy_metrics(strat))
        oos = backtest.sign_fit_oos(daily, rel_ret)
        if oos.get("fitted_sign") is None:
            print(f"  [EM-CARRY] OOS: {oos['status']}")
        else:
            print(f"  [EM-CARRY] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
                  f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
            backtest.persist_leg_validation("EM-CARRY", oos, hypothesis_sign=1)
        if oos["status"] == "OK":
            print("  [EM-CARRY] OOS (fitted sign):", oos["metrics"])
        print(f"  [EM-CARRY] sample: {len(strat)} daily obs, {len(diff)} months carry")
    except SourceUnavailable as e:
        print(f"  [EM-CARRY] {e}")


def _bt_fund_data() -> tuple[dict, dict]:
    import yfinance as yf
    funds = list(dict.fromkeys(config.EM_LOCAL_FUNDS + config.EM_HARD_FUNDS))
    closes, dividends = {}, {}
    for f in funds:
        df = yf.download(f, period="5y", progress=False, auto_adjust=True)["Close"].dropna()
        if isinstance(df, pd.DataFrame):
            df = df.iloc[:, 0]
        if df.empty:
            continue
        closes[f] = df
        try:
            acts = yf.Ticker(f).actions
            if acts is not None and not acts.empty and "Dividends" in acts.columns:
                dividends[f] = acts["Dividends"].dropna()
        except Exception:
            pass
    return closes, dividends


def _bt_skew() -> None:
    """Put-skew z on HYG vs forward HYG returns (gated on accrued skew)."""
    import yfinance as yf
    from engine import options_surface
    hist = options_surface.load_iv_history()
    skew = options_surface.skew_series(hist, "HYG")
    z, n = options_surface.skew_z(skew)
    if z is None:
        print(f"  [SKEW] UNAVAILABLE: {n}/{config.SKEW_Z_MIN_OBS} accrued skew snapshots "
              f"(needs polygon key + daily probe runs)")
        return
    hyg = yf.download("HYG", period="1y", progress=False, auto_adjust=True)["Close"].dropna()
    if isinstance(hyg, pd.DataFrame):
        hyg = hyg.iloc[:, 0]
    ret = hyg.pct_change().dropna()
    daily = skew.reindex(ret.index.union(skew.index)).ffill().dropna()
    pos = np.sign(daily)
    strat = (pos.shift(1) * ret).dropna()
    print("  [SKEW] skew-z long HYG (hypothesis: cheap puts = risk-on):",
          backtest.strategy_metrics(strat))
    oos = backtest.sign_fit_oos(daily, ret)
    if oos.get("fitted_sign") is None:
        print(f"  [SKEW] OOS: {oos['status']}")
    else:
        print(f"  [SKEW] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
              f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
        backtest.persist_leg_validation("SKEW", oos, hypothesis_sign=1)
    if oos["status"] == "OK":
        print("  [SKEW] OOS (fitted sign):", oos["metrics"])


def _bt_ivrv(horizon: int = 21) -> None:
    """HYG IV-RV premium z vs forward HYG returns (gated on IV_Z_MIN_OBS)."""
    import yfinance as yf
    from engine import options_surface
    hist = options_surface.load_iv_history()
    frame = options_surface.history_to_frame(hist)
    iv = frame["HYG"].dropna() if "HYG" in frame.columns else pd.Series(dtype=float)
    if iv.empty:
        print("  [IVRV] UNAVAILABLE: no accrued HYG IV snapshots")
        return
    hyg = yf.download("HYG", period="2y", progress=False, auto_adjust=True)["Close"].dropna()
    if isinstance(hyg, pd.DataFrame):
        hyg = hyg.iloc[:, 0]
    if hyg.empty:
        print("  [IVRV] UNAVAILABLE: HYG closes missing")
        return
    rv = options_surface.realized_vol_series(hyg)
    prem = options_surface.premium_series(iv, rv)
    pz, n = options_surface.premium_z_series(prem, min_obs=config.IV_Z_MIN_OBS)
    if pz.empty:
        print(f"  [IVRV] UNAVAILABLE: {n}/{config.IV_Z_MIN_OBS} accrued IV-RV snapshots "
              f"(launchd accrual runs daily; auto-unlocks at 20)")
        return
    ret = hyg.pct_change().dropna()
    daily = pz.reindex(ret.index.union(pz.index)).ffill().dropna()
    pos = np.sign(daily)
    strat = (pos.shift(1) * ret).dropna()
    print("  [IVRV] IV-RV premium-z long HYG (hypothesis: rich implied vol =",
          "hedge demand = risk-off; walk-forward fit arbitrates the sign):",
          backtest.strategy_metrics(strat))
    oos = backtest.sign_fit_oos(daily, ret)
    if oos.get("fitted_sign") is None:
        print(f"  [IVRV] OOS: {oos['status']}")
    else:
        print(f"  [IVRV] OOS sign fit: in={oos['n_in']} oos={oos['n_oos']} "
              f"sign={oos['fitted_sign']} ic_in={oos['ic_in_sample']}")
        backtest.persist_leg_validation("IVRV", oos, hypothesis_sign=1)
    if oos["status"] == "OK":
        print("  [IVRV] OOS (fitted sign):", oos["metrics"])
    print(f"  [IVRV] sample: {len(strat)} daily obs")


def run_backtests(sources: list[str] | None = None, horizon: int | None = None) -> None:
    """Run the walk-forward battery; `sources` optionally restricts the legs."""
    print("=" * 78)
    print("  WALK-FORWARD OOS BACKTEST BATTERY (no look-ahead)")
    print("=" * 78)
    want = set(sources or ["curve", "cot", "cot_strategy", "curve_strategy",
                           "global_rates", "sector", "real_rates", "appetite",
                           "em_carry", "skew", "ivrv"])
    h = horizon or 21
    if h != 21:
        print(f"  forward window: {h} business days (--horizon)")
    if "curve" in want:
        _bt_curve(h)
    if "cot" in want:
        _bt_cot(h)
    if "cot_strategy" in want:
        _bt_cot_strategy()
    if "curve_strategy" in want:
        _bt_curve_strategy()
    if "global_rates" in want:
        _bt_global_rates(h)
    if "sector" in want:
        _bt_sector(h)
    if "real_rates" in want:
        _bt_real_rates()
    if "appetite" in want:
        _bt_appetite(h)
    if "em_carry" in want:
        _bt_em_carry()
    if "skew" in want:
        _bt_skew()
    if "ivrv" in want:
        _bt_ivrv(h)
    print("\n  Backtest battery complete.")
