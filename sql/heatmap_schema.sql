-- Heatmap portal schema (multi_asset_heatmap_spec.md §4).
-- PostgreSQL + PostGIS. The live engine store is data/atlas.json; this
-- schema is the documented storage layer for the portal. Load once with:
--   psql "$DATABASE_URL" -f sql/heatmap_schema.sql
-- and export rows with:  python cli.py --market atlas --db

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE countries (
    country_code VARCHAR(3) PRIMARY KEY,
    country_name VARCHAR(100) NOT NULL,
    geometry GEOMETRY(MultiPolygon, 4326)
);

CREATE TABLE country_financial_metrics (
    timestamp TIMESTAMPTZ NOT NULL,
    country_code VARCHAR(3) REFERENCES countries(country_code),

    yield_2y NUMERIC(8,4),
    yield_10y NUMERIC(8,4),
    yield_spread_vs_ust NUMERIC(8,4),

    cds_spread_bps NUMERIC(8,2),

    index_futures_basis_ann NUMERIC(8,4),

    implied_vol_30d NUMERIC(8,4),
    realized_vol_30d NUMERIC(8,4),
    volatility_risk_premium NUMERIC(8,4),
    straddle_yield_ann NUMERIC(8,4),

    composite_heatmap_score NUMERIC(8,4),
    PRIMARY KEY (timestamp, country_code)
);

CREATE INDEX idx_cfm_country ON country_financial_metrics (country_code, timestamp DESC);