"""Polygon.io free tier: listed options on credit ETFs (chain + put skew).

Optional keyed source (POLYGON_API_KEY, free plan at https://polygon.io,
5 calls/min). The free tier serves the full contracts list for one
underlying per call, so the probe takes one chain snapshot per ticker per
day and accrues it into data/iv_history.json exactly like the yfinance
snapshots — but with the full strike grid, giving us a 25-delta put skew.

Snapshot schema (matches yf_options keys + skew fields):
  {ticker, as_of, expiry, underlying, atm_strike, atm_iv,
   put_call_oi_ratio, skew_25d}  # skew_25d = put_25d_iv - call_25d_iv

Missing key or a ticker with no listed chains -> UNAVAILABLE. No fabricated IV.
"""
from __future__ import annotations

import numpy as np
import requests

import config
from sources.registry import SourceUnavailable, accrue_snapshot, iso_today


def fetch_contracts(ticker: str, limit: int = 2500) -> dict:
    """One options-contracts page for `ticker` (free tier: one call)."""
    key = config.get_polygon_key()
    if key is None:
        raise SourceUnavailable(
            "polygon", "POLYGON_API_KEY not set",
            "Free plan: https://polygon.io/dashboard/signup -> paste into .env")
    url = f"{config.POLYGON_BASE}/v3/reference/options/contracts"
    try:
        resp = requests.get(url, params={"underlying_ticker": ticker, "limit": limit,
                                         "apiKey": key}, timeout=60)
        resp.raise_for_status()
        payload = resp.json()
    except requests.RequestException as e:
        msg = str(e).replace(key, "***")  # never leak the key into logs
        raise SourceUnavailable("polygon", f"{ticker}: {msg}") from e
    results = payload.get("results", [])
    if not results:
        raise SourceUnavailable("polygon", f"{ticker}: no listed options contracts",
                                "some ETFs genuinely list no chains — skipped")
    return {"contracts": results, "as_of": iso_today()}


def _iv_from_contract(c: dict) -> float | None:
    iv = c.get("implied_volatility")
    return float(iv) if iv is not None else None


def snapshot_ticker(ticker: str) -> dict:
    """ATM IV, P/C OI and 25-delta put skew from the free-tier chain.

    Contracts carry strike_expiration/expiration_date, strike_price,
    contract_type, implied_volatility, open_interest. Delta is NOT on the
    reference contracts endpoint (it is a Greeks endpoint, paid), so the
    "25-delta" skew uses the 25% moneyness strikes: the put whose strike is
    ~25% below the underlying vs the call ~25% above (documented
    approximation in context.md §6).
    """
    payload = fetch_contracts(ticker)
    contracts = payload["contracts"]
    if not contracts:
        raise SourceUnavailable("polygon", f"{ticker}: no contracts returned")

    underlying = _last_price_or_none(ticker, contracts)
    # fall back to the contract fields when the underlying quote is absent
    if underlying is None:
        strikes = sorted(float(c["strike_price"]) for c in contracts
                         if c.get("strike_price") is not None)
        if not strikes:
            raise SourceUnavailable("polygon", f"{ticker}: no strike data in chain")
        underlying = float(np.median(strikes))

    calls, puts = [], []
    for c in contracts:
        iv = _iv_from_contract(c)
        if iv is None:
            continue
        try:
            strike = float(c["strike_price"])
        except (TypeError, ValueError):
            continue
        typ = (c.get("contract_type") or "").lower()
        rec = (strike, iv, float(c.get("open_interest") or 0))
        if typ == "call":
            calls.append(rec)
        elif typ == "put":
            puts.append(rec)
    if not calls or not puts:
        raise SourceUnavailable("polygon", f"{ticker}: chain has no usable IV quotes")

    def atm(rows):
        return min(rows, key=lambda r: abs(r[0] - underlying))

    atm_call = atm(calls)
    atm_iv = atm_call[1]
    call_oi = sum(r[2] for r in calls)
    put_oi = sum(r[2] for r in puts)

    def moneyness_iv(rows, side, pct: float):
        target = underlying * (1 - pct) if side == "put" else underlying * (1 + pct)
        if not rows:
            return None
        return min(rows, key=lambda r: abs(r[0] - target))[1]

    put_25d = moneyness_iv(puts, "put", 0.25)
    call_25d = moneyness_iv(calls, "call", 0.25)
    skew = (put_25d - call_25d) if put_25d is not None and call_25d is not None else None

    return {
        "ticker": ticker,
        "as_of": payload["as_of"],
        "expiry": next((c.get("expiration_date", "") for c in contracts if c.get("expiration_date")), ""),
        "underlying": round(underlying, 4),
        "atm_strike": float(atm_call[0]),
        "atm_iv": round(float(atm_iv), 6),
        "put_call_oi_ratio": round(put_oi / call_oi, 4) if call_oi > 0 else None,
        "skew_25d": round(float(skew), 6) if skew is not None else None,
        "n_strikes": int(len(calls) + len(puts)),
    }


def _last_price_or_none(ticker: str, contracts: list[dict]) -> float | None:
    """Polygon free tier lacks daily-quote history; derive the underlying
    from the most ATM quote when a `underlying_price` field exists."""
    for c in contracts:
        up = c.get("underlying_price")
        if up is not None:
            return float(up)
    return None


def snapshot_all() -> list[dict]:
    out = []
    for ticker in config.POLYGON_OPTION_ETFS:
        try:
            snap = snapshot_ticker(ticker)
            accrue_snapshot(ticker, snap["as_of"], snap)
            out.append(snap)
            print(f"  [polygon.{ticker}] ATM IV={snap['atm_iv']:.4f} "
                  f"skew25d={snap['skew_25d']} n={snap['n_strikes']}")
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] {e}")
    return out
