# Public Credit Opportunity Engine

Evaluates and surfaces opportunities in **public** debt markets: US IG/HY
corporate bonds, European corporate bonds, emerging-market sovereign/corporate
debt, plus a liquid ML credit screen. The private credit pipeline was
**completely removed** — no private-deal underwriting code exists in this repo.

## Setup

```bash
cp .env.example .env        # then paste your keys into .env
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

`.env` is git-ignored. Keys are read only via `config.get_*_key()` getters.

All keyed sources are **optional free tiers** — the engine runs keyless, and a
missing key makes only that source report `UNAVAILABLE` with signup
instructions. Only `FRED_API_KEY` is load-bearing for the US pipeline and the
board's curve leg. Optional: FINRA TRACE Public Credential
(`FINRA_API_CLIENT_ID`/`FINRA_API_SECRET`, free, non-commercial), Alpaca
(`ALPACA_API_KEY`/`ALPACA_API_SECRET`, free dev). FMP and OpenBB were removed
(dead keys / no implementation — see LEDGER). Every key is documented in
`.env.example` with a "how to obtain" comment.

## Usage

```bash
python cli.py --market us --hold-days 5 --trade-size-m 50   # full US pipeline
python cli.py --market eu                      # EUR matrix
python cli.py --market em                      # EM matrix
python cli.py --market ml                      # ML credit scorecard
python cli.py --market global                  # GCO Opportunity Board
python cli.py --market backtest                # walk-forward OOS battery
python cli.py --market global --source cot,curve   # restrict board legs
python cli.py --market atlas                   # country heatmap -> data/atlas.json
python cli.py --market atlas --db              # + optional Postgres export (gated)
python -m api.server                           # FastAPI heatmap portal (spec §6)
python -m sources.probe                        # exercise every source once
```

Read `context.md` (adjacent file) first — it is the canonical project spec,
containing the objective, architecture, calibration audit log, and known gaps.

## Heatmap portal (multi-asset spec)

`python cli.py --market atlas` builds the per-country return grid (bonds
10Y + term structure, real yield, CDS proxy, equity ETFs + RV_30d, US
options IV/VRP/straddle-yield accrual, ES=NQ index-futures basis, SOFR
implied rate) into `data/atlas.json`. The FastAPI portal
(`pip install fastapi uvicorn`, then `python -m api.server`) serves:

- `/api/v1/heatmap` — GeoJSON FeatureCollection (country centroids, heat score, yield + 1m change) for the map.
- `/api/v1/countries/{iso}` — full per-instrument drill-down.
- `/api/v1/regions` — region rollup heats.

Optional Redis parse-cache (spec §1): `pip install redis`, `REDIS_URL` in
`.env` — the API then serves the parsed doc from Redis, keyed on the atlas
file's mtime (no TTL constants), falling back to the JSON parse when unset
or broken.

Optional PostgreSQL storage (spec §4): `pip install "psycopg[binary]"`,
`DATABASE_URL` in `.env`, `psql "$DATABASE_URL" -f sql/heatmap_schema.sql`,
then `--market atlas --db`. JSON remains the live store; everything gates
honestly when a dependency is missing.

## Status

- **Live today**: US/EUR/EM/ML pipelines (FRED key), the GCO Opportunity
  Board (`global`) with COT / curve / sovereign / FX / options legs, the
  walk-forward backtest battery (with OOS sign-fit reporting), the source
  probe (`python -m sources.probe`), and the country atlas (spec legs: term
  structure, real yield, CDS proxy, RV_30d, index-futures basis, straddle
  yield accrual, GeoJSON + gated Postgres export + FastAPI heatmap portal).
- **Live with your keys**: FINRA TRACE (FIP OAuth2 flow, breadth 3064 obs)
  and Alpaca (SGOV T-bill ETF quote) — both verified live 2026-08-10.
- **Gated, needs time**: IV-RV option signal (auto-unlocks at 20 accrued
  probe days; `scripts/accrue_iv_daily.sh` + launchd runs it daily), COT
  IG/HY credit futures legs (2y history; contracts only listed 2026-03/05 —
  unlock ~2028), EMHY options chains (exchange lists no expiries).
- **Removed as dead**: BIS stats API (replaced by World Bank credit-gap
  proxy `FS.AST.PRVT.GD.ZS`), US Debt Clock (Treasury debt_to_penny
  covers it), FMP (key 403'd; non-load-bearing).
- Full pending list: `context.md` §10.

## Tests

```bash
pytest tests/ -q
```