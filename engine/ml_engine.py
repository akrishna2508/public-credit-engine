"""Liquid public-credit ML super-learner (XGBoost + LightGBM + CatBoost + SHAP).

Audit fixes:
  * `random_state` seeds pinned (deterministic, not arbitrary randomness).
  * No private-credit code; targets built from real ETF forward returns.
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd
import shap
import yfinance as yf
from sklearn.ensemble import IsolationForest
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier
from catboost import CatBoostClassifier

import config

logger = logging.getLogger(__name__)


def format_feature_name(name: str) -> str:
    """Translate internal column names into readable institutional terms."""
    name = name.replace("OAS_Z", "OAS Z-Score")
    name = name.replace("Term_Spread", "Term Spread")
    name = name.replace("Liquidity_Proxy", "Liquidity Proxy")
    for w in config.FEATURE_WINDOWS:
        name = name.replace(f"Sharpe_{w}", f"{w}-Day Sharpe Ratio")
        name = name.replace(f"Sortino_{w}", f"{w}-Day Sortino Ratio")
        name = name.replace(f"Calmar_{w}", f"{w}-Day Calmar Ratio")
    return name


class ChronologicalStacker:
    """Stacked model with chronologically valid OOF meta-learner + SHAP access."""

    def __init__(self, base, meta):
        self.named_estimators_ = {n: m for n, m in base}
        self._base = base
        self._meta = meta

    def predict_proba(self, X):
        if isinstance(X, pd.DataFrame):
            X = X.values
        meta_input = np.column_stack([m.predict_proba(X)[:, 1] for _, m in self._base])
        return self._meta.predict_proba(meta_input)


def run_ml_pipeline(dataset: dict) -> pd.DataFrame:
    logger.info("Initializing Liquid Super-Learner: XGBoost + LightGBM + CatBoost...")
    if not dataset:
        logger.error("Dataset is empty. Aborting ML Pipeline.")
        return pd.DataFrame()

    all_data = []
    for ticker, df in dataset.items():
        tmp = df.copy()
        tmp['Asset'] = ticker
        all_data.append(tmp)
    master_df = pd.concat(all_data)

    master_df['Trailing_21D_ROI'] = (
        master_df.groupby('Asset')['Close'].pct_change(periods=21) * 100
    )

    exclude_cols = ['Open', 'High', 'Low', 'Close', 'Adj Close', 'Volume', 'Ret',
                    'Target', 'Asset', 'Trailing_21D_ROI']
    features = [c for c in master_df.columns if c not in exclude_cols]

    train_df = master_df.dropna(subset=['Target']).copy()
    inference_df = master_df[master_df['Target'].isna()].groupby('Asset').tail(1).copy()
    if inference_df.empty:
        logger.warning("No inference data found (missing NaN targets).")
        return pd.DataFrame()

    X_train = train_df[features]
    X_latest = inference_df[features]

    iso = IsolationForest(contamination=config.ISOLATION_FOREST_CONTAMINATION,
                          random_state=config.ISOLATION_FOREST_RANDOM_STATE)
    train_df['Anomaly'] = iso.fit_predict(X_train)
    clean_train = train_df[train_df['Anomaly'] == 1]

    use_gpu = config.ML_USE_GPU
    base_learners = [
        ('xgb', XGBClassifier(n_estimators=150, max_depth=4, learning_rate=0.05,
                              random_state=config.ML_RANDOM_STATE, eval_metric='logloss',
                              tree_method='hist', device='cuda' if use_gpu else 'cpu')),
        ('lgb', LGBMClassifier(n_estimators=150, max_depth=4, learning_rate=0.05,
                               verbose=-1, random_state=config.ML_RANDOM_STATE,
                               device='gpu' if use_gpu else 'cpu')),
        ('cat', CatBoostClassifier(iterations=150, depth=4, learning_rate=0.05,
                                   verbose=0, random_state=config.ML_RANDOM_STATE,
                                   task_type='GPU' if use_gpu else 'CPU')),
    ]

    X_train_arr = clean_train[features].values
    y_train_arr = clean_train['Target'].values

    tss = TimeSeriesSplit(n_splits=5)
    oof_meta = np.zeros((len(X_train_arr), len(base_learners)))
    valid_mask = np.zeros(len(X_train_arr), dtype=bool)
    for train_idx, test_idx in tss.split(X_train_arr):
        for col_idx, (_, model) in enumerate(base_learners):
            m = model.__class__(**model.get_params())
            m.fit(X_train_arr[train_idx], y_train_arr[train_idx])
            oof_meta[test_idx, col_idx] = m.predict_proba(X_train_arr[test_idx])[:, 1]
        valid_mask[test_idx] = True

    lr_meta = LogisticRegression()
    lr_meta.fit(oof_meta[valid_mask], y_train_arr[valid_mask])

    final_base = []
    for name, model in base_learners:
        m = model.__class__(**model.get_params())
        m.fit(X_train_arr, y_train_arr)
        final_base.append((name, m))

    stacked_model = ChronologicalStacker(final_base, lr_meta)
    inference_df['ML_Score'] = stacked_model.predict_proba(X_latest)[:, 1] * 100
    inference_df['Anomaly'] = iso.predict(X_latest)

    meta_weights = stacked_model._meta.coef_[0]
    weight_xgb, weight_lgb, weight_cat = meta_weights / np.sum(np.abs(meta_weights))

    shap_xgb = shap.TreeExplainer(stacked_model.named_estimators_['xgb']).shap_values(X_latest)
    shap_lgb = shap.TreeExplainer(stacked_model.named_estimators_['lgb']).shap_values(X_latest)
    shap_cat = shap.TreeExplainer(stacked_model.named_estimators_['cat']).shap_values(X_latest)

    def _extract(v):
        if isinstance(v, list):
            return v[1]
        if hasattr(v, 'values'):
            return v.values
        return np.asarray(v)

    ensemble_shap = (_extract(shap_xgb) * weight_xgb
                     + _extract(shap_lgb) * weight_lgb
                     + _extract(shap_cat) * weight_cat)

    profit_reasons, risk_reasons = [], []
    for i in range(len(X_latest)):
        sv = ensemble_shap[i]
        pos = np.where(sv > 0)[0]
        pos_sorted = pos[np.argsort(sv[pos])][::-1][:3]
        profit_reasons.append(
            " | ".join(f"{format_feature_name(features[j])} (+{sv[j]:.2f})" for j in pos_sorted)
            if len(pos_sorted) else "None")
        neg = np.where(sv < 0)[0]
        neg_sorted = neg[np.argsort(sv[neg])][:3]
        risk_reasons.append(
            " | ".join(f"{format_feature_name(features[j])} ({sv[j]:.2f})" for j in neg_sorted)
            if len(neg_sorted) else "None")

    inference_df['Profit_Drivers'] = profit_reasons
    inference_df['Risk_Drivers'] = risk_reasons
    inference_df['Asset_Name'] = inference_df['Asset'].map(config.ETF_NAMES).fillna(inference_df['Asset'])

    logger.info("Fetching live dividend yields for scorecard...")
    yields = []
    for t in inference_df['Asset']:
        try:
            info = yf.Ticker(t).info
            yld = info.get('yield') if info.get('yield') is not None else info.get('dividendYield')
            # Audit gate: an unavailable yield is None (explicitly unknown),
            # never a fabricated 0.0 which would read as "no income".
            yields.append((yld * 100) if yld is not None else None)
        except Exception as e:
            logger.warning(f"Could not fetch yield for {t}: {e}")
            yields.append(None)
    inference_df['Current_Yield'] = yields

    return inference_df