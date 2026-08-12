"""Tests for the walk-forward leg-validation gate (Q1: board vote semantics).

Pure logic, no network: the battery persists its sign fits to
data/backtest_legs.json; the board votes ONLY with demonstrated edge.
"""
import json

from engine import backtest


def test_leg_validation_status_matrix():
    assert backtest.leg_validation_status(None, hypothesis_sign=1) == "UNVALIDATED"
    assert backtest.leg_validation_status({}, hypothesis_sign=1) == "UNVALIDATED"
    rec = {"fitted_sign": None, "metrics": {}}
    assert backtest.leg_validation_status(rec, hypothesis_sign=1) == "UNVALIDATED"

    confirmed = {"fitted_sign": 1, "metrics": {"sharpe": 0.22}}
    assert backtest.leg_validation_status(confirmed, hypothesis_sign=1) == "VALIDATED"

    rejected = {"fitted_sign": -1, "metrics": {"sharpe": -0.57}}
    assert backtest.leg_validation_status(rejected, hypothesis_sign=1) == "REJECTED"

    not_confirmed = {"fitted_sign": 1, "metrics": {"sharpe": -0.2}}
    assert backtest.leg_validation_status(not_confirmed, hypothesis_sign=1) == "NOT_CONFIRMED"
    flat = {"fitted_sign": 1, "metrics": {"sharpe": 0.0}}
    assert backtest.leg_validation_status(flat, hypothesis_sign=1) == "NOT_CONFIRMED"
    missing = {"fitted_sign": 1, "metrics": {}}
    assert backtest.leg_validation_status(missing, hypothesis_sign=1) == "NOT_CONFIRMED"


def test_leg_validation_roundtrip(tmp_path, monkeypatch):
    """persist_leg_validation -> load_leg_validations round trip, append-only
    per leg, last run wins with an as_of date."""
    monkeypatch.setattr(backtest, "LEG_VALIDATION_FILE", tmp_path / "backtest_legs.json")
    oos = {"fitted_sign": -1, "ic_in_sample": -0.13, "n_in": 322, "n_oos": 322,
           "metrics": {"status": "OK", "n": 322, "sharpe": -0.57}}
    backtest.persist_leg_validation("COT-STRATEGY", oos, hypothesis_sign=1, as_of="2026-08-11")
    loaded = backtest.load_leg_validations()
    assert loaded["COT-STRATEGY"]["fitted_sign"] == -1
    assert loaded["COT-STRATEGY"]["hypothesis_sign"] == 1
    assert backtest.leg_validation_status(loaded["COT-STRATEGY"], 1) == "REJECTED"

    backtest.persist_leg_validation("COT-STRATEGY", oos, hypothesis_sign=1, as_of="2026-08-12")
    assert backtest.load_leg_validations()["COT-STRATEGY"]["as_of"] == "2026-08-12"

    # a broken file must read as {} (board votes UNVALIDATED, never fabricates)
    (tmp_path / "backtest_legs.json").write_text("{not json")
    assert backtest.load_leg_validations() == {}


def test_persist_uses_json_safe_defaults(tmp_path, monkeypatch):
    monkeypatch.setattr(backtest, "LEG_VALIDATION_FILE", tmp_path / "backtest_legs.json")
    oos = {"fitted_sign": None, "ic_in_sample": None, "n_in": 0, "n_oos": 0,
           "metrics": {"status": "insufficient obs 0 < 60", "n": 0}}
    backtest.persist_leg_validation("SKEW", oos, hypothesis_sign=1, as_of="2026-08-11")
    raw = json.loads((tmp_path / "backtest_legs.json").read_text())
    assert raw["SKEW"]["fitted_sign"] is None
    assert backtest.leg_validation_status(raw["SKEW"], 1) == "UNVALIDATED"
