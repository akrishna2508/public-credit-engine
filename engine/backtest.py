"""Walk-forward validation for GCO signals (no-look-ahead enforced).

Every signal is applied one step later than it is observed (shift(1)).
Metrics: directional hit rate, Sharpe/Sortino/maxDD, rank IC. Pure logic —
feed it your own series and it reports what the data says.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import config


def shifted_signal(signal: pd.Series) -> pd.Series:
    """Signal observable at t is tradable at t+1 — shift by one."""
    return signal.shift(1)


def directional_hit_rate(signal: pd.Series, forward: pd.Series) -> dict:
    """Share of days where sign(lagged signal) == sign(forward move)."""
    sig = shifted_signal(signal).dropna()
    both = pd.concat([sig, forward.reindex(sig.index)], axis=1).dropna()
    if len(both) < config.BACKTEST_MIN_OBS:
        return {"status": f"insufficient obs {len(both)} < {config.BACKTEST_MIN_OBS}", "n": len(both)}
    agree = (np.sign(both.iloc[:, 0]) == np.sign(both.iloc[:, 1])).mean()
    return {"status": "OK", "n": len(both), "hit_rate": round(float(agree), 4)}


def strategy_metrics(returns: pd.Series) -> dict:
    """Annualized return/vol, Sharpe, Sortino, max drawdown."""
    r = returns.dropna()
    if len(r) < config.BACKTEST_MIN_OBS:
        return {"status": f"insufficient obs {len(r)} < {config.BACKTEST_MIN_OBS}", "n": len(r)}
    ann_mean = r.mean() * 252
    ann_vol = r.std(ddof=0) * np.sqrt(252)
    downside = r[r < 0].std(ddof=0) * np.sqrt(252) if (r < 0).any() else np.nan
    cum = (1 + r).cumprod()
    max_dd = float((cum / cum.cummax() - 1).min())
    return {
        "status": "OK", "n": len(r),
        "ann_return": round(float(ann_mean), 4), "ann_vol": round(float(ann_vol), 4),
        "sharpe": round(float(ann_mean / ann_vol), 3) if ann_vol > 0 else None,
        "sortino": round(float(ann_mean / downside), 3) if downside and downside > 0 else None,
        "max_dd": round(float(max_dd), 4),
    }


def information_coefficient(signal: pd.Series, forward: pd.Series) -> dict:
    """Spearman rank IC between lagged signal and forward return."""
    from scipy.stats import spearmanr
    sig = shifted_signal(signal).dropna()
    both = pd.concat([sig, forward.reindex(sig.index)], axis=1).dropna()
    if len(both) < config.BACKTEST_MIN_OBS:
        return {"status": f"insufficient obs {len(both)} < {config.BACKTEST_MIN_OBS}", "n": len(both)}
    rho, p = spearmanr(both.iloc[:, 0], both.iloc[:, 1])
    return {"status": "OK", "n": len(both), "spearman_ic": round(float(rho), 4),
            "p_value": round(float(p), 4)}


def ml_hit_rate(predictions: pd.Series, realized: pd.Series, threshold: float = 0.5) -> dict:
    """Binary-direction hit rate of an ML probability vs realized sign."""
    both = pd.concat([predictions, realized], axis=1).dropna()
    if len(both) < config.BACKTEST_MIN_OBS:
        return {"status": f"insufficient obs {len(both)} < {config.BACKTEST_MIN_OBS}", "n": len(both)}
    pred = (both.iloc[:, 0] >= threshold).astype(int)
    actual = (both.iloc[:, 1] > 0).astype(int)
    return {"status": "OK", "n": len(both), "hit_rate": round(float((pred == actual).mean()), 4)}


def sign_fit_oos(signal: pd.Series, returns: pd.Series, in_sample_frac: float = 0.5) -> dict:
    """True out-of-sample sign fit for a strategy rule.

    Split the sample in half. On the in-sample half, fit the position sign
    from the rank correlation between the lagged signal and forward returns
    (the sign the data actually rewards, not an economic prior). On the
    out-of-sample half, apply that sign with a 1-day execution delay and
    report strategy metrics. This replaces the "sign taken from the
    economic hypothesis" caveat with a genuine walk-forward sign fit.

    Returns {"status", "n_in", "n_oos", "fitted_sign", "metrics"}.
    """
    sig = shifted_signal(signal).dropna()
    both = pd.concat([sig, returns.reindex(sig.index)], axis=1).dropna()
    if len(both) < 2 * config.BACKTEST_MIN_OBS:
        status = f"insufficient obs {len(both)} < 2*{config.BACKTEST_MIN_OBS}"
        return {"status": status, "n_in": 0, "n_oos": 0,
                "fitted_sign": None, "ic_in_sample": None,
                "metrics": {"status": status, "n": len(both)}}
    split = max(int(len(both) * in_sample_frac), 1)
    train, test = both.iloc[:split], both.iloc[split:]
    from scipy.stats import spearmanr
    rho, _ = spearmanr(train.iloc[:, 0], train.iloc[:, 1])
    if not np.isfinite(rho) or rho == 0:
        fitted_sign = np.nan
    else:
        fitted_sign = 1.0 if rho > 0 else -1.0
    pos = np.sign(test.iloc[:, 0])
    strat = (fitted_sign * pos.shift(1) * test.iloc[:, 1]).dropna()
    metrics = strategy_metrics(strat)
    return {"status": metrics.get("status", "OK"), "n_in": len(train), "n_oos": len(test),
            "fitted_sign": None if not np.isfinite(fitted_sign) else fitted_sign,
            "ic_in_sample": round(float(rho), 4) if np.isfinite(rho) else None,
            "metrics": metrics}


LEG_VALIDATION_FILE = config.DATA_DIR / "backtest_legs.json"


def persist_leg_validation(leg: str, oos: dict, hypothesis_sign: int,
                           as_of: str | None = None) -> None:
    """Append one walk-forward leg result to data/backtest_legs.json.

    Written by the battery (pipelines/backtest.py) so the board can gate its
    votes on demonstrated edge instead of economic priors. Append-only per
    leg (last run wins, timestamped); missing file -> created.
    """
    import datetime as _dt
    import json as _json
    as_of = as_of or _dt.date.today().isoformat()
    rec = {
        "fitted_sign": oos.get("fitted_sign"),
        "ic_in_sample": oos.get("ic_in_sample"),
        "metrics": oos.get("metrics", {}),
        "n_in": oos.get("n_in"), "n_oos": oos.get("n_oos"),
        "hypothesis_sign": int(hypothesis_sign),
        "as_of": as_of,
    }
    data = load_leg_validations()
    data[leg] = rec
    LEG_VALIDATION_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LEG_VALIDATION_FILE, "w") as f:
        _json.dump(data, f, indent=2, default=str)


def load_leg_validations() -> dict:
    """{} when the file is missing — the board then votes hypothesis-sign
    with an UNVALIDATED label rather than fabricating validation."""
    import json as _json
    if not LEG_VALIDATION_FILE.exists():
        return {}
    try:
        with open(LEG_VALIDATION_FILE) as f:
            return _json.load(f)
    except (ValueError, OSError):
        return {}


def leg_validation_status(record: dict | None, hypothesis_sign: int) -> str:
    """Vote-gate status for one board leg.

    VALIDATED      — fitted sign == hypothesis AND positive OOS Sharpe: the
                     hypothesis edge survived walk-forward; vote with it.
    REJECTED       — fitted sign != hypothesis: the data contradicts the
                     prior; the leg has no demonstrated edge, abstain.
    NOT_CONFIRMED  — fitted sign == hypothesis but OOS Sharpe <= 0: no edge;
                     abstain.
    UNVALIDATED    — no battery record yet; vote hypothesis-sign but label it.
    """
    if record is None:
        return "UNVALIDATED"
    fitted = record.get("fitted_sign")
    if fitted is None:
        return "UNVALIDATED"
    if int(fitted) != int(hypothesis_sign):
        return "REJECTED"
    sharpe = (record.get("metrics") or {}).get("sharpe")
    if sharpe is None or not np.isfinite(sharpe) or sharpe <= 0:
        return "NOT_CONFIRMED"
    return "VALIDATED"
