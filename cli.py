"""Command-line entry point for the Public Credit Opportunity Engine.

Supports public markets only:
  us  :  US public corporates (FRED spreads + default rates + forecast + vol)
  eu  :  European public corporates (ETF proxies + volatility spectrum)
  em  :  Emerging-markets public debt (ETF proxies + volatility spectrum)
  ml  :  Liquid ML credit scorecard (XGBoost/LightGBM/CatBoost + SHAP)
global : GCO Opportunity Board (COT, options IV-RV, skew, curve, sovereign,
            global rates, EM sector, real rates, credit appetite, EM carry)
   backtest: walk-forward OOS validation of the GCO signal legs
   atlas : country opportunity map (10Y yields, spreads, futures, options,
           straddle/vol proxies per country -> data/atlas.json, portal-ready)

Examples:
  python cli.py --market us --hold-days 5 --trade-size-m 50
  python cli.py --market eu --percentile 90
  python cli.py --market ml
  python cli.py --market global
  python cli.py --market global --source cot,curve,appetite,em_carry
  python cli.py --market backtest
  python -m sources.probe
"""
from __future__ import annotations

import argparse

import config

GCO_LEGS = ["cot", "options", "skew", "curve", "sovereign", "fx",
            "global_rates", "sector", "real_rates", "appetite", "em_carry",
            "cot_strategy", "curve_strategy", "ivrv"]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Public Credit Opportunity Engine")
    p.add_argument("--market", choices=["us", "eu", "em", "ml", "global", "backtest", "atlas"],
                   default="us",
                   help="Which public-credit pipeline to run (default: us)")
    p.add_argument("--source", action="append", choices=GCO_LEGS,
                   help="Restrict global/backtest to specific GCO legs "
                        "(repeatable; default: all)")
    p.add_argument("--hold-days", type=int, default=config.DEFAULT_HOLD_DAYS,
                   help="Holding period in business days (default: %(default)s)")
    p.add_argument("--trade-size-m", type=float, default=config.DEFAULT_TRADE_SIZE_M,
                   help="Per-trade size in $ millions (default: %(default).0f)")
    p.add_argument("--percentile", type=int, default=None,
                   help="Single volatility percentile to trade (default: all bands 50-95)")
    p.add_argument("--horizon", type=int, default=None,
                   help="Forward window in business days: forecast horizon "
                        "(us) or backtest forward move (default: config 12 / 21)")
    p.add_argument("--db", action="store_true",
                   help="With --market atlas: export the heatmap rows to "
                        "PostgreSQL (needs DATABASE_URL + psycopg + schema; "
                        "reports UNAVAILABLE honestly when anything is missing)")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    percentiles = [args.percentile] if args.percentile else None

    if args.market == "ml":
        from pipelines.ml_scorecard import run_ml_scorecard
        run_ml_scorecard()
        return

    if args.market == "global":
        from pipelines.global_credit import run_global_credit
        run_global_credit(args.source, args.horizon)
        return

    if args.market == "backtest":
        from pipelines.backtest import run_backtests
        run_backtests(args.source, args.horizon)
        return

    if args.market == "atlas":
        from pipelines.atlas import run_atlas
        run_atlas()
        if args.db:
            from pipelines.heatmap_db import export_heatmap_database
            report = export_heatmap_database()
            if report.get("status") == "ok":
                print(f"\n  [DB] rows written: {report['rows_written']}")
                print("  [DB] country points + metrics upserted (sql/heatmap_schema.sql)")
            else:
                print(f"\n  [DB] UNAVAILABLE: {report['reason']}"
                      f" | fix: {report['fix']}")
        return

    if args.market == "us":
        from pipelines.us_public import run_us_public
        run_us_public(args.trade_size_m, args.hold_days, percentiles, args.horizon)
    elif args.market == "eu":
        from pipelines.eur_public import run_eur_public
        run_eur_public(args.trade_size_m, args.hold_days, percentiles)
    elif args.market == "em":
        from pipelines.em_public import run_em_public
        run_em_public(args.trade_size_m, args.hold_days, percentiles)


if __name__ == "__main__":
    main()