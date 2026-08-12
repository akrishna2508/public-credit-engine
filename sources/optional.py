"""Optional free-tier enrichment sources (all availability-gated).

None of these is load-bearing for any signal. Missing keys render the
source UNAVAILABLE with a signup instruction. Every call returns real data
or raises SourceUnavailable.

Removed sources (2026-08-10, with reasons):
- FMP ETF profile: the key in .env returned 403 on every endpoint; the
  enrichment was non-load-bearing, so the source was removed instead of
  shipping a dead tier.
- US Debt Clock: the public API returns 404 on every variant; the Treasury
  Fiscal Data API (sources/treasury_api.debt_to_penny) already covers debt
  in real, live form.
"""
from __future__ import annotations

import requests

import config
from sources.registry import SourceUnavailable

ALPACA_TRADES_URL = "https://data.alpaca.markets/v2/stocks/trades/latest"
ALPACA_TBILL_ETF = "SGOV"  # iShares 0-3 Month Treasury Bond ETF: T-bill proxy quote


def fetch_alpaca_quote(symbol: str = ALPACA_TBILL_ETF) -> dict | None:
    """Free dev-tier last-trade quote for a symbol (requires .env Alpaca keys).

    The endpoint accepts exchange symbols, not CUSIPs (a CUSIP lookup
    returned 400). SGOV is a short-T-bill ETF, so it serves as the live
    T-bill-adjacent quote proxy.
    """
    creds = config.get_alpaca_keys()
    if creds is None:
        raise SourceUnavailable(
            "alpaca", "ALPACA_API_KEY/ALPACA_API_SECRET not set",
            "Free dev account: https://alpaca.markets -> API Keys -> paste into .env")
    key, secret = creds
    resp = requests.get(ALPACA_TRADES_URL, params={"symbols": symbol, "feed": "iex"},
                        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
                        timeout=30)
    resp.raise_for_status()
    return resp.json()
