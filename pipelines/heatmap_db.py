"""Heatmap Postgres export (multi-asset spec §4) — optional, availability-gated.

The working store is data/atlas.json. This module exports the atlas rows into
the `country_financial_metrics` table ONLY when all three preconditions hold:
  * DATABASE_URL is set in .env (config.get_database_url)
  * psycopg is installed (`pip install "psycopg[binary]"`, optional)
  * the schema exists (sql/heatmap_schema.sql, apply once with psql)

Any missing precondition -> structured UNAVAILABLE message, JSON stays live.
The row math lives in engine.atlas.country_metric_rows (pure, tested).

country_financial_metrics carries the numeric payload. `countries` rows are
inserted with geometry NULL: the spec's countries.geometry is MultiPolygon
(country shapes from a Natural-Earth-style import — not fabricated here);
GeoJSON for the map comes from the API layer over data/atlas.json instead.
"""
from __future__ import annotations

import json
import os

from engine import atlas

ATLAS_FILE = os.path.join("data", "atlas.json")


def load_atlas_doc() -> dict:
    if not os.path.exists(ATLAS_FILE):
        raise FileNotFoundError(
            f"{ATLAS_FILE} missing — run `python cli.py --market atlas` first")
    with open(ATLAS_FILE) as f:
        return json.load(f)


def export_heatmap_database() -> dict:
    """Upsert countries + metric rows into Postgres. Returns a report dict
    with status; raises nothing on gating failures (reports UNAVAILABLE)."""
    import config

    dsn = config.get_database_url()
    if dsn is None:
        return {"status": "UNAVAILABLE",
                "reason": "DATABASE_URL not set in .env",
                "fix": "paste a local Postgres DSN (see .env.example)"}
    try:
        import psycopg
    except ImportError:
        return {"status": "UNAVAILABLE",
                "reason": "psycopg not installed",
                "fix": 'pip install "psycopg[binary]"'}

    doc = load_atlas_doc()
    rows = atlas.country_metric_rows(doc)
    if not rows:
        return {"status": "UNAVAILABLE", "reason": "atlas doc has no country rows"}

    countries = []
    for iso, node in (doc.get("countries") or {}).items():
        countries.append((iso, node.get("name", iso)))

    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                # geometry stays NULL (MultiPolygon shapes come from a
                # Natural-Earth-style import, not fabricated here).
                cur.executemany("""
                    INSERT INTO countries (country_code, country_name)
                    VALUES (%s, %s)
                    ON CONFLICT (country_code) DO UPDATE SET
                        country_name = EXCLUDED.country_name
                """, countries)
                cur.executemany("""
                    INSERT INTO country_financial_metrics (
                        timestamp, country_code, yield_2y, yield_10y,
                        yield_spread_vs_ust, cds_spread_bps, index_futures_basis_ann,
                        implied_vol_30d, realized_vol_30d, volatility_risk_premium,
                        straddle_yield_ann, composite_heatmap_score)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (timestamp, country_code) DO UPDATE SET
                        yield_2y = EXCLUDED.yield_2y,
                        yield_10y = EXCLUDED.yield_10y,
                        yield_spread_vs_ust = EXCLUDED.yield_spread_vs_ust,
                        cds_spread_bps = EXCLUDED.cds_spread_bps,
                        index_futures_basis_ann = EXCLUDED.index_futures_basis_ann,
                        implied_vol_30d = EXCLUDED.implied_vol_30d,
                        realized_vol_30d = EXCLUDED.realized_vol_30d,
                        volatility_risk_premium = EXCLUDED.volatility_risk_premium,
                        straddle_yield_ann = EXCLUDED.straddle_yield_ann,
                        composite_heatmap_score = EXCLUDED.composite_heatmap_score
                """, [
                    (r["timestamp"], r["country_code"], r["yield_2y"], r["yield_10y"],
                     r["yield_spread_vs_ust"], r["cds_spread_bps"],
                     r["index_futures_basis_ann"], r["implied_vol_30d"],
                     r["realized_vol_30d"], r["volatility_risk_premium"],
                     r["straddle_yield_ann"], r["composite_heatmap_score"])
                    for r in rows
                ])
        return {"status": "ok", "rows_written": len(rows)}
    except Exception as e:  # psycopg errors (missing table, bad DSN, ...)
        return {"status": "UNAVAILABLE",
                "reason": f"database write failed: {e}",
                "fix": "check DATABASE_URL and apply sql/heatmap_schema.sql"}