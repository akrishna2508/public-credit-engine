"""Compose yield-spread-minus-EL series and dispatch forecast pipeline."""
from __future__ import annotations

import json

from engine import forecast

import config


def load_inputs(spread_path, el_path) -> tuple[dict, dict]:
    with open(spread_path) as f:
        yield_spreads = json.load(f)
    with open(el_path) as f:
        el_diffs = json.load(f)
    return yield_spreads, el_diffs


def compute_diff_over_time(yield_spreads: dict, el_diffs: dict) -> dict:
    diff_over_time: dict[str, dict] = {}
    for pair in yield_spreads:
        if pair not in el_diffs:
            # Audit gate: a pair whose expected-loss diff is unavailable must
            # not silently vanish — surface it so the omission is visible.
            print(f"  [WARNING] Pair '{pair}' has no EL diff; excluded from composite.")
            continue
        el_bps = el_diffs[pair] * 100 * 100
        diff_over_time[pair] = {
            date: round(ys_bps - el_bps, 4) for date, ys_bps in yield_spreads[pair].items()
        }
    return diff_over_time


def save_diff_json(diff_over_time: dict, path=None) -> None:
    path = path or config.SPREAD_EL_FILE
    with open(path, "w") as f:
        json.dump(diff_over_time, f, indent=2)


def print_diff_table(diff_over_time: dict, yield_spreads: dict, el_diffs: dict) -> None:
    print(f"\n{'Pair':<18} {'Date':<13} {'Yield Spread':>14} {'EL (bps)':>10} {'Difference':>12}")
    print(f"{'-'*18} {'-'*13} {'-'*14} {'-'*10} {'-'*12}")
    for pair, series in diff_over_time.items():
        d = list(series.keys())[-1]
        diff_val = series[d]
        ys_val = list(yield_spreads[pair].values())[-1]
        el_bps = el_diffs[pair] * 100 * 100
        print(f"{pair:<18} {d:<13} {ys_val:>14.2f} {el_bps:>10.2f} {diff_val:>12.2f}")


def run_analysis(horizon: int | None = None) -> dict:
    yield_spreads, el_diffs = load_inputs(config.USA_SPREAD_FILE, config.EL_DIFF_FILE)
    diff_over_time = compute_diff_over_time(yield_spreads, el_diffs)
    save_diff_json(diff_over_time)
    print_diff_table(diff_over_time, yield_spreads, el_diffs)

    print("\n  [FORECAST] Launching Johansen-Augmented VAR Pipeline...")
    return forecast.run_johansen_var_pipeline(
        diff_over_time=diff_over_time,
        horizon=horizon if horizon is not None else config.DEFAULT_FORECAST_HORIZON,
        max_lags=config.DEFAULT_MAX_LAGS,
    )


def main() -> None:
    run_analysis()


if __name__ == "__main__":
    main()
