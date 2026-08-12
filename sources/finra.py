"""FINRA TRACE-family aggregated datasets (free Public Credential).

Credential is free (individual, non-commercial): gateway.finra.org ->
Create Account -> API Console -> Public Credential. Only the public
aggregated datasets are requested; the paid transaction-level tier is never
touched. Without credentials the module reports UNAVAILABLE with the signup
path — it does not fabricate liquidity data.

Auth flow (verified live 2026-08-10): the platform uses the FINRA Identity
Platform (FIP) OAuth2 client-credentials grant. POST the client
id:secret as a Basic header to the token URL, then use the returned
access_token as a Bearer header on the Query API. The earlier Basic-on-data
implementation 401'd; the dataset names previously configured
(corporateDebtMarketBreadth, corporateAndAgencyCappedVolume) do not exist
and returned 404 — the real names are in config.FINRA_PUBLIC_DATASETS.
"""
from __future__ import annotations

import base64

import pandas as pd
import requests

import config
from sources.registry import SourceUnavailable

TOKEN_GRANT = {"grant_type": "client_credentials"}


def _bearer_headers() -> dict[str, str]:
    """FIP OAuth2 token -> Bearer Authorization headers for the Query API."""
    creds = config.get_finra_credentials()
    if creds is None:
        raise SourceUnavailable(
            "finra", "FINRA_API_CLIENT_ID / FINRA_API_SECRET not set in .env",
            "Free Public Credential: https://gateway.finra.org/app/dfo-console -> "
            "Create Account (Individual) -> API Console -> Public Credential")
    cid, secret = creds
    token = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    resp = requests.post(config.FINRA_TOKEN_URL, params=TOKEN_GRANT,
                         headers={"Authorization": f"Basic {token}"}, timeout=30)
    if resp.status_code != 200:
        raise SourceUnavailable(
            "finra", f"token endpoint {resp.status_code}",
            "re-check the Public Credential values in .env (API Console)")
    access = resp.json().get("access_token")
    if not access:
        raise SourceUnavailable("finra", "token response had no access_token")
    return {"Authorization": f"Bearer {access}"}


def fetch_dataset(name: str, limit: int = 5000) -> pd.DataFrame:
    if name not in config.FINRA_PUBLIC_DATASETS:
        raise SourceUnavailable("finra", f"{name} is outside the free public set")
    group, dataset = config.FINRA_PUBLIC_DATASETS[name]
    url = f"{config.FINRA_BASE}/data/group/{group}/name/{dataset}"
    try:
        headers = _bearer_headers()
        headers["Accept"] = "application/json"  # default is text/plain CSV
        resp = requests.get(url, params={"limit": limit}, headers=headers, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise SourceUnavailable("finra", f"{name}: {e}",
                                "check the Public Credential values in .env") from e
    data = resp.json()
    rows = data.get("data", data) if isinstance(data, dict) else data
    df = pd.DataFrame(rows)
    if df.empty:
        raise SourceUnavailable("finra", f"{name}: no rows returned")
    return df


def fetch_breadth() -> pd.DataFrame:
    return fetch_dataset("breadth")


def fetch_capped_volume() -> pd.DataFrame:
    return fetch_dataset("capped_volume")
