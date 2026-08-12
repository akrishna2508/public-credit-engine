"""yfinance listed options on credit ETFs (free, keyless): IV snapshot.

Chains are point-in-time — there is no free historical IV. So each run
snapshots the nearest expiry (ATM call IV, ATM straddle price in $, put/call
OI ratio, DTE) and accrues it to data/iv_history.json via
registry.accrue_snapshot, building a real history for IV-vs-realized analysis
and the annualized short-straddle yield (heatmap spec §3.3). A ticker with no
listed options is reported and skipped. No fabricated IV.
"""
from __future__ import annotations

import pandas as pd
import yfinance as yf

import config
from sources.registry import SourceUnavailable, accrue_snapshot, iso_today


def _mid(last: float, bid: float, ask: float) -> float:
    """Quote: lastPrice when real, else bid/ask mid (0 -> NaN handled by caller)."""
    if last is not None and last > 0:
        return float(last)
    if bid is not None and ask is not None and bid > 0 and ask > 0:
        return float((bid + ask) / 2.0)
    return float("nan")


def snapshot_ticker(ticker: str) -> dict:
    t = yf.Ticker(ticker)
    try:
        expiries = list(t.options)
    except Exception as e:
        raise SourceUnavailable("yf_options", f"{ticker}: {e}",
                                "yfinance options are free; some ETFs list none -> skipped") from e
    if not expiries:
        raise SourceUnavailable("yf_options", f"{ticker}: no listed expiries")

    hist = t.history(period="5d")
    if hist is None or hist.empty:
        raise SourceUnavailable("yf_options", f"{ticker}: no underlying price history")
    underlying = float(hist["Close"].dropna().iloc[-1])

    # Thin ETFs (e.g. ANGL) sometimes list an expiry with an empty call
    # chain; walk expiries in order and use the first with usable quotes.
    # Expiries with <= 1 day to expiry are skipped too: same-day chains have
    # degenerate IV (verified live 2026-08-10, TLT dte=0 served 0.016 IV).
    chosen = None
    today = pd.Timestamp(iso_today())
    for expiry in expiries:
        if (pd.Timestamp(expiry) - today).days <= 1:
            continue
        try:
            chain = t.option_chain(expiry)
        except Exception:
            continue
        calls = chain.calls
        if calls is None or calls.empty:
            continue
        calls = calls.copy()
        ev = pd.to_numeric(calls.get("impliedVolatility"), errors="coerce")
        calls["iv"] = ev if isinstance(ev, pd.Series) else pd.Series(float("nan"), index=calls.index)
        oi = pd.to_numeric(calls.get("openInterest"), errors="coerce")
        calls["oi"] = oi if isinstance(oi, pd.Series) else pd.Series(0.0, index=calls.index)
        calls["strike"] = pd.to_numeric(calls.get("strike"), errors="coerce")
        valid = calls[calls["iv"].notna() & calls["strike"].notna() & (calls["strike"] > 0)]
        if valid.empty:
            continue
        chosen = (expiry, valid.reset_index(drop=True), chain.puts)
        break
    if chosen is None:
        raise SourceUnavailable(
            "yf_options",
            f"{ticker}: no expiry with usable call quotes "
            f"({', '.join(expiries[:4])}{'...' if len(expiries) > 4 else ''})")
    expiry, valid, puts = chosen

    atm = valid.iloc[int((valid["strike"] - underlying).abs().idxmin())]
    # Real-quote floor: yfinance occasionally serves whole chains at ~1e-5 IV
    # (verified live 2026-08-10: HYG/LQD/ANGL/EMB at exactly 1e-05, TLT/JNK
    # at 0.016/0.004). Such values are not quotes; accruing them would
    # overwrite the day's good snapshot — reject, keeping the last real one.
    if float(atm["iv"]) <= config.IV_MIN_REAL:
        raise SourceUnavailable(
            "yf_options",
            f"{ticker}: yfinance implied vol {float(atm['iv']):.6g} below the "
            f"real-quote floor {config.IV_MIN_REAL} on {expiry} — skipped, "
            f"keeping the last real snapshot")
    put_oi = 0.0
    if puts is not None and not puts.empty and "openInterest" in puts.columns:
        put_oi = float(pd.to_numeric(puts["openInterest"], errors="coerce").fillna(0).sum())
    call_oi = float(valid["oi"].sum())

    # ATM straddle: call + put AT THE ATM STRIKE, quoted prices (heatmap spec
    # §3.3 needs the market straddle price, not an IV-based estimate).
    straddle_price = None
    if puts is not None and not puts.empty:
        pours = puts.copy()
        pours["strike"] = pd.to_numeric(pours.get("strike"), errors="coerce")
        atmp = pours[(pours["strike"] - atm["strike"]).abs() < 1e-9]
        if not atmp.empty:
            p = atmp.iloc[0]
            for col in ("lastPrice", "bid", "ask"):
                if col in p.index:
                    p[col] = pd.to_numeric(p[col], errors="coerce")
            c_price = _mid(pd.to_numeric(atm.get("lastPrice"), errors="coerce"),
                           pd.to_numeric(atm.get("bid"), errors="coerce"),
                           pd.to_numeric(atm.get("ask"), errors="coerce"))
            p_price = _mid(pd.to_numeric(p.get("lastPrice"), errors="coerce"),
                           pd.to_numeric(p.get("bid"), errors="coerce"),
                           pd.to_numeric(p.get("ask"), errors="coerce"))
            if c_price == c_price and p_price == p_price and c_price > 0 and p_price > 0:
                straddle_price = round(c_price + p_price, 4)

    return {
        "ticker": ticker,
        "as_of": iso_today(),
        "expiry": expiry,
        "underlying": round(underlying, 4),
        "atm_strike": float(atm["strike"]),
        "atm_iv": float(atm["iv"]),
        "put_call_oi_ratio": round(put_oi / call_oi, 4) if call_oi > 0 else None,
        "atm_straddle_price": straddle_price,
        "dte_days": (pd.Timestamp(expiry) - pd.Timestamp(iso_today())).days,
    }


def snapshot_all() -> list[dict]:
    out = []
    for ticker in config.CREDIT_OPTION_ETFS:
        try:
            snap = snapshot_ticker(ticker)
            accrue_snapshot(ticker, snap["as_of"], snap)
            out.append(snap)
            print(f"  [yf_options.{ticker}] ATM IV={snap['atm_iv']:.4f} "
                  f"P/C OI={snap['put_call_oi_ratio']}")
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] {e}")
    return out
