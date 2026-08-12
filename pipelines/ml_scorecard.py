"""Liquid public ML credit scorecard: features -> super-learner -> SHAP reports."""
from __future__ import annotations

from engine import data_engine, main_alpha, ml_engine


def run_ml_scorecard() -> None:
    print("=" * 75)
    print("  LIQUID ML CREDIT SCORECARD (XGBOOST + SHAP)")
    print("=" * 75)

    dataset = data_engine.generate_master_dataset()
    if not dataset:
        print("[CRITICAL] Dataset failed to build. Check network and FRED API key.")
        return

    scorecard = ml_engine.run_ml_pipeline(dataset)
    if scorecard.empty:
        print("[WARNING] Empty scorecard produced; nothing to render.")
        return

    main_alpha.plot_ml_scorecard(scorecard)
    main_alpha.plot_individual_asset_metrics(scorecard)
    main_alpha.plot_vol_vs_spread(dataset)