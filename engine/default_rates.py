"""Featured default-rate & expected-loss analysis via FRED OAS + DR proxies."""
from __future__ import annotations

import json

import certifi
import requests

import config


def fred_fetch(series_id: str) -> list[dict]:
    resp = requests.get(
        config.FRED_BASE_URL,
        params={"series_id": series_id, "api_key": config.get_fred_key(),
                "file_type": "json", "sort_order": "asc"},
        verify=certifi.where(), timeout=30,
    )
    data = resp.json()
    if "error_message" in data:
        return []
    return [{"date": o["date"], "value": float(o["value"])}
            for o in data.get("observations", []) if o.get("value", ".") != "."]


def search_fred_series(query: str) -> str | None:
    try:
        resp = requests.get(
            config.FRED_SEARCH_URL,
            params={"search_text": query, "api_key": config.get_fred_key(),
                    "file_type": "json", "limit": 20, "order_by": "popularity",
                    "sort_order": "desc"},
            verify=certifi.where(), timeout=30,
        )
        for s in resp.json().get("seriess", []):
            sid, title = s.get("id", ""), s.get("title", "").lower()
            if "baml" in sid.lower() and "option-adjusted" in title:
                return sid
    except Exception:
        pass
    return None


def resolve_hy_series_ids(oas_series: dict) -> dict:
    for rating, query in config.HY_SEARCH_QUERIES.items():
        found = search_fred_series(query)
        if found and found not in oas_series[rating]:
            oas_series[rating].insert(0, found)
    return oas_series


def fetch_dr_proxies(dr_series: dict) -> dict:
    fred_dr_data: dict[str, list] = {}
    for proxy_name, series_id in dr_series.items():
        obs = fred_fetch(series_id)
        if obs:
            fred_dr_data[proxy_name] = obs
            print(f"  OK   {proxy_name} ({series_id}) -> {len(obs)} obs")
    return fred_dr_data


def build_raw_api_json(oas_series: dict, fred_dr_data: dict, dr_mapping: dict, lgd: dict) -> dict:
    raw_api_json: dict[str, list] = {}
    for rating in config.RATING_ORDER:
        obs_list, used_id = [], None
        for sid in oas_series[rating]:
            obs_list = fred_fetch(sid)
            if obs_list:
                used_id = sid
                break
        if not obs_list:
            continue
        proxy_key = dr_mapping[rating]
        dr_obs = fred_dr_data.get(proxy_key, [])
        # Audit gate: a missing DR observation is UNAVAILABLE (NaN), never 0.0.
        # A fabricated 0.0 would silently halve expected loss for that grade.
        latest_dr = (dr_obs[-1]["value"] / 100) if dr_obs else float("nan")
        raw_api_json[rating] = [{"date": o["date"], "default_rate": latest_dr, "lgd": lgd[rating]}
                                for o in obs_list]
        print(f"  OK   {rating} ({used_id}) -> {len(obs_list)} entries DR={latest_dr*100:.4f}%  LGD={lgd[rating]*100:.1f}%")
    return raw_api_json


def filter_latest_entries(raw_api_json: dict) -> dict:
    latest: dict[str, list] = {}
    for rating, entries in raw_api_json.items():
        grouped: dict[str, list] = {}
        for each in entries:
            grouped.setdefault(each["date"], []).append(each)
        latest[rating] = grouped[max(grouped.keys())]
    return latest


def compute_averages(latest_entries: dict) -> dict:
    averages: dict[str, dict] = {}
    for rating, entries in latest_entries.items():
        n = len(entries)
        averages[rating] = {
            "avg_default_rate": round(sum(e["default_rate"] for e in entries) / n, 8),
            "avg_lgd": round(sum(e["lgd"] for e in entries) / n, 6),
        }
    return averages


def compute_expected_loss(averages: dict) -> dict:
    return {r: round(v["avg_default_rate"] * v["avg_lgd"], 8) for r, v in averages.items()}


def compute_el_diff(expected_loss: dict) -> dict:
    available = [r for r in config.RATING_ORDER if r in expected_loss]
    pairs = list(zip(available, available[1:]))
    el_diff: dict = {}
    for safer, riskier in pairs:
        el_r, el_s = expected_loss[riskier], expected_loss[safer]
        # Skip-gate: a grade whose EL is unavailable (NaN DR) must not emit a
        # fabricated difference; the pair simply does not enter the composite.
        if el_r != el_r or el_s != el_s:  # NaN self-inequality
            continue
        el_diff[f"{riskier} - {safer}"] = round(el_r - el_s, 8)
    return el_diff


def merge_list_of_dicts(filepath, new_data: dict) -> dict:
    import os
    old_data: dict = {}
    if os.path.exists(filepath):
        try:
            with open(filepath) as f:
                old_data = json.load(f)
        except Exception:
            old_data = {}
    merged: dict[str, list] = {}
    for key in set(old_data.keys()) | set(new_data.keys()):
        date_map: dict[str, dict] = {}
        if key in old_data:
            for entry in old_data[key]:
                date_map[entry["date"]] = entry
        if key in new_data:
            for entry in new_data[key]:
                date_map[entry["date"]] = entry
        merged[key] = [date_map[d] for d in sorted(date_map.keys())]
    return merged


def _nan_to_none(data) -> dict:
    """NaN floats are not strict JSON; persist them as None (explicitly unavailable)."""
    if isinstance(data, dict):
        return {k: _nan_to_none(v) for k, v in data.items()}
    if isinstance(data, list):
        return [_nan_to_none(v) for v in data]
    if isinstance(data, float) and data != data:
        return None
    return data


def save_default_rate_jsons(raw_api_json, latest_entries, averages, expected_loss, el_diff) -> None:
    merged_raw_api = merge_list_of_dicts(config.BASE_DIR / "default_rate_and_lgd_by_grade.json", raw_api_json)
    files = [
        (config.BASE_DIR / "default_rate_and_lgd_by_grade.json", merged_raw_api),
        (config.BASE_DIR / "latest_by_rating.json", latest_entries),
        (config.BASE_DIR / "averages_by_grade.json", averages),
        (config.EL_BY_GRADE_FILE, expected_loss),
        (config.EL_DIFF_FILE, el_diff),
    ]
    for path, data in files:
        import json as _json
        with open(path, "w") as f:
            _json.dump(_nan_to_none(data), f, indent=2)


def print_el_tables(averages: dict, expected_loss: dict, el_diff: dict) -> None:
    print(f"\n{'=' * 65}\nAverage DR, LGD and Expected Loss by grade\n{'=' * 65}")
    print(f"  {'Rating':<6}  {'DR':>10}  {'LGD':>8}  {'EL':>12}\n  {'-' * 6}  {'-' * 10}  {'-' * 8}  {'-' * 12}")
    for rating in config.RATING_ORDER:
        if rating in averages:
            dr = averages[rating]["avg_default_rate"]
            lgd = averages[rating]["avg_lgd"]
            el = expected_loss[rating]
            print(f"  {rating:<6}  {dr * 100:>9.4f}%  {lgd * 100:>7.1f}%  {el * 100:>11.6f}%")
    print(f"\n{'=' * 65}\nEL difference between adjacent grades\n{'=' * 65}")
    print(f"  {'Pair':<14}  {'Diff (%)':>12}  {'Diff (bps)':>12}\n  {'-' * 14}  {'-' * 12}  {'-' * 12}")
    for pair, diff in el_diff.items():
        print(f"  {pair:<14}  {diff * 100:>11.6f}%  {diff * 100 * 100:>11.4f}")


def run_default_analysis() -> dict:
    updated_oas_series = resolve_hy_series_ids(dict(config.FRED_OAS_SERIES))
    fred_dr_data = fetch_dr_proxies(dict(config.FRED_DR_SERIES))
    raw_api_json = build_raw_api_json(updated_oas_series, fred_dr_data,
                                      config.DR_MAPPING, config.PUBLISHED_LGD)
    latest_entries = filter_latest_entries(raw_api_json)
    averages = compute_averages(latest_entries)
    expected_loss = compute_expected_loss(averages)
    el_diff = compute_el_diff(expected_loss)
    save_default_rate_jsons(raw_api_json, latest_entries, averages, expected_loss, el_diff)
    print_el_tables(averages, expected_loss, el_diff)
    return {"expected_loss": expected_loss, "el_diff": el_diff}


def main() -> None:
    run_default_analysis()


if __name__ == "__main__":
    main()
