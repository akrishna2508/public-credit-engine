"""Heatmap portal API (multi-asset spec §6) — FastAPI, JSON-backed.

Serves the live data/atlas.json store: a GeoJSON heatmap FeatureCollection
and per-country drill-down. Storage/caching per spec §1: optional Postgres
(sql/heatmap_schema.sql, §4) and an optional Redis parse-cache. When Redis is
configured (REDIS_URL in .env + `pip install redis`) the parsed atlas doc is
served from Redis, keyed on the file's mtime; otherwise the JSON file is
parsed on each request — honest fallback, same contract.

Run:  uvicorn api.server:app --reload   (or:  python -m api.server)
Optional deps: fastapi + uvicorn (see requirements.txt).
"""
from __future__ import annotations

import json
import os

import config as _config

ATLAS_FILE = os.path.join("data", "atlas.json")
_REDIS_KEY_DOC = "atlas:doc"
_REDIS_KEY_MTIME = "atlas:doc:mtime"


def _file_mtime() -> float:
    return os.path.getmtime(ATLAS_FILE)


def _clean_for_json(obj):
    """Recursively replace non-finite floats with None so FastAPI's strict
    json.dumps can serve docs that still carry NaN from legacy builds."""
    if isinstance(obj, float):
        import math
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _clean_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean_for_json(v) for v in obj]
    return obj


def _load_file_doc() -> dict:
    with open(ATLAS_FILE) as f:
        return json.load(f)


def _load_redis_doc(client) -> dict | None:
    """Serve the cached doc when the atlas file is unchanged since it was
    cached; None on any mismatch (re-parse + refresh by the caller)."""
    cached_mtime = client.get(_REDIS_KEY_MTIME)
    if cached_mtime is None:
        return None
    try:
        if abs(float(cached_mtime) - _file_mtime()) > 1e-6:
            return None
    except (TypeError, ValueError):
        return None
    cached = client.get(_REDIS_KEY_DOC)
    if cached is None:
        return None
    try:
        return json.loads(cached)
    except ValueError:
        return None


def load_doc() -> dict:
    """Parse the atlas store, using the optional Redis parse-cache when
    configured. Pure-logic; no calibrated constants (mtime is the oracle)."""
    redis_url = _config.get_redis_url()
    if redis_url:
        try:
            import redis
            client = redis.from_url(redis_url)
            doc = _load_redis_doc(client)
            if doc is not None:
                return doc
        except Exception:
            pass  # any redis failure -> honest file fallback
    doc = _load_file_doc()
    if redis_url:
        try:
            import redis
            client = redis.from_url(redis_url)
            client.set(_REDIS_KEY_MTIME, str(_file_mtime()))
            client.set(_REDIS_KEY_DOC, json.dumps(doc))
        except Exception:
            pass  # cache write failure never blocks serving
    return doc


def build_app():
    try:
        from fastapi import FastAPI, HTTPException
    except ImportError as e:
        raise SystemExit(
            "fastapi not installed (optional dep). "
            'Run: pip install fastapi uvicorn') from e

    import config
    from engine import atlas

    app = FastAPI(title="Public Credit Heatmap Portal",
                  version="1.0",
                  description="Global multi-asset returns heatmap "
                              "(multi_asset_heatmap_spec.md)")

    @app.get("/api/v1/heatmap")
    async def get_heatmap_geojson():
        """GeoJSON FeatureCollection: one Point per country at its real
        centroid, colored by the composite heat score (portal map)."""
        try:
            doc = load_doc()
        except OSError:
            raise HTTPException(503, "atlas store unavailable — run "
                                     "`python cli.py --market atlas` first")
        fc = atlas.geojson_feature_collection(doc, config.ATLAS_COUNTRY_LATLON)
        fc["generated"] = doc.get("generated")
        return fc

    @app.get("/api/v1/countries/{iso}")
    async def get_country(iso: str):
        """Full per-instrument drill-down for one country (bonds, curve,
        cds, yield spreads, irf spreads, futures basis, options/straddle,
        equity leg + heat)."""
        doc = load_doc()
        node = (doc.get("countries") or {}).get(iso.upper())
        if node is None:
            raise HTTPException(404, f"no atlas node for {iso}")
        return _clean_for_json(node)

    @app.get("/api/v1/regions")
    async def get_regions():
        doc = load_doc()
        return {"regions": doc.get("regions")}

    return app


app = build_app()


if __name__ == "__main__":
    import config as _cfg
    import uvicorn

    uvicorn.run(app, host=_cfg.API_HOST, port=_cfg.API_PORT)