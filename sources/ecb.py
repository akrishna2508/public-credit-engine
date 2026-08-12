"""ECB Data Portal SDMX REST (keyless, free): euro-area yield curves.

The portal serves `?format=csvdata`; the jsondata format was dropped (400 on
the new portal). Verified live 2026-08-10:

- The data-api requires the dataflow as a path component: the canonical
  SDW key "YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y" must be requested as
  /service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y — the dotted form
  (data/YC.B.U2...) returns 400.
- The YC dataflow publishes GOVERNMENT curves only (G_N_*). Every corporate
  key (C_N_*) returns 404 — the ECB no longer serves corporate yield curves
  in this flow. Euro corporate compensation comes from FRED
  (BAMLHE00EHYIOAS) and the UCITS ETF proxies (IEAC.L/IHYG.L).

Each series key is gated individually: a wrong or removed key degrades to
UNAVAILABLE, never a fabricated yield.
"""
from __future__ import annotations

import requests

import pandas as pd

import config
from sources.registry import SourceUnavailable, cache_json, parse_ecb_csvdata


def sdmx_url(key: str) -> str:
    """SDW key -> data-api URL (flow as a path component, not a key prefix)."""
    flow, _, series = key.partition(".")
    if not series:
        raise SourceUnavailable("ecb", f"{key}: not an SDMX series key (missing flow)")
    return f"{config.ECB_SDMX_BASE}/{flow}/{series}"


def fetch_sdmx(key: str) -> pd.Series:
    """Fetch one SDMX series key -> daily observation Series (real data only)."""
    def _loader() -> str:
        resp = requests.get(f"{sdmx_url(key)}?format=csvdata", timeout=60,
                            headers={"Accept": "text/csv"})
        resp.raise_for_status()
        return resp.text

    try:
        payload = cache_json(f"ecb_{key}", 1.0, _loader)
    except Exception as e:
        raise SourceUnavailable("ecb", f"{key}: {e}",
                                "verify the series key at https://data.ecb.europa.eu") from e
    return parse_ecb_csvdata(payload, key)


def fetch_corporate_yields() -> dict[str, pd.Series]:
    """Fetch the configured ECB yield curves; failures are gated individually.

    The name is kept for backward compatibility, but the configured series
    are euro-area government curves (see config.ECB_YIELD_KEYS).
    """
    out: dict[str, pd.Series] = {}
    for name, key in config.ECB_YIELD_KEYS.items():
        try:
            out[name] = fetch_sdmx(key)
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] ecb.{name}: {e}")
    if not out:
        raise SourceUnavailable("ecb", "no yield series resolved")
    return out
