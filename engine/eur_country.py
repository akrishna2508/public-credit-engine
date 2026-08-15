"""EUR country-level panel: per-country 10Y yields, Bund spreads, return curves.

The ECB YC dataflow publishes only the euro-area aggregate (B.U2); per-country
keys there 404 (verified live 2026-08-11). Country legs therefore use the ECB
long-term interest rate (IRS) dataflow — monthly observations, ~35y history,
all 11 keys in config.ECB_LTIR_COUNTRY_KEYS verified live. The straddle
machinery (empirical |T-day move| fee, dealer markup, friction, PB discount,
hold-horizon return curves) is the SAME code path as the US grade panel
(engine.volatility) — here on monthly observations, so hold units are months
and the series are the country's own yield level (pure, incl. the Bund) and
the country-vs-Bund spread (pair, excl. the Bund). A US yield is never
substituted for a EUR risk-free rate (see eur_panel.py).
"""
from __future__ import annotations

import pandas as pd

import config
from engine import volatility, volatility_matrix
from sources.registry import SourceUnavailable

COUNTRY_NAMES = {
    "DE": "Germany", "FR": "France", "IT": "Italy", "ES": "Spain",
    "NL": "Netherlands", "BE": "Belgium", "AT": "Austria", "PT": "Portugal",
    "IE": "Ireland", "FI": "Finland", "GR": "Greece",
}


def fetch_country_ltir() -> dict[str, pd.Series]:
    """ECB LTIR 10Y per country -> {CC: monthly percent Series}. Gated per key."""
    from sources import ecb
    out: dict[str, pd.Series] = {}
    for cc, key in config.ECB_LTIR_COUNTRY_KEYS.items():
        try:
            s = ecb.fetch_sdmx(key)
            s.name = cc
            out[cc] = s
        except SourceUnavailable as e:
            print(f"  [UNAVAILABLE] ecb.LTIR.{cc}: {e}")
    return out


def _changes_bps(s: pd.Series) -> dict[str, float]:
    """1M/3M/12M changes in bps (None when the history is too short)."""
    out = {}
    last = float(s.iloc[-1])
    for months, key in ((1, "1M"), (3, "3M"), (12, "12M")):
        try:
            prev = float(s.iloc[-1 - months])
        except IndexError:
            out[key] = None
            continue
        out[key] = (last - prev) * 100.0
    return out


def _print_panel(levels: dict[str, pd.Series], ref_cc: str) -> None:
    """Print the country yield / Bund-spread / change table.

    levels are PERCENT series (the LTIR native unit); the spread and the
    changes are converted to bps here — single conversion, no double math.
    """
    ref = levels[ref_cc]
    as_of = ref.index[-1].date()
    print(f"\n  [COUNTRY PANEL] EUR 10Y government yields (ECB LTIR, monthly, "
          f"as-of {as_of}, Bund = {ref_cc} reference):")
    print(f"    {'country':<12} {'yield %':>8} {'vs Bund bps':>12} "
          f"{'1M bps':>8} {'3M bps':>8} {'12M bps':>8}")
    for cc, s in levels.items():
        chg = _changes_bps(s)
        spread = (float(s.iloc[-1]) - float(ref.iloc[-1])) * 100.0
        f = lambda v: f"{v:+.1f}" if v is not None else "n/a"
        print(f"    {COUNTRY_NAMES.get(cc, cc):<12} {float(s.iloc[-1]):>8.3f} "
              f"{spread:>12.1f} {f(chg['1M']):>8} {f(chg['3M']):>8} {f(chg['12M']):>8}")
    print("    (LTIR is monthly — the latest observation is the month-end value;"
          " changes are month-over-month)")


def run_country_analysis(trade_size_millions: float, hold_days: int,
                         percentile: int | None = None,
                         hold_max: int = 12) -> None:
    """Country yield levels + Bund-spread pairs through the shared straddle machinery.

    Returns are hold-horizon curves (hold units = MONTHS on monthly LTIR
    data), three views (gross / HF net / retail net) exactly like the US
    grade panel. Degenerate series (the Bund vs itself) are excluded from
    the spread set; the Bund stays in the level set.
    """
    percentile = percentile or config.GARCH_SIGNAL_PERCENTILE
    levels = fetch_country_ltir()
    ref_cc = config.EUR_COUNTRY_REFERENCE
    if len(levels) < 2 or ref_cc not in levels:
        print("  [UNAVAILABLE] EUR country panel: need >= 2 country LTIR "
              "series including the reference Bund.")
        return
    _print_panel(levels, ref_cc)

    levels_bps = {cc: s * 100.0 for cc, s in levels.items()}  # percent -> bps
    ref = levels_bps[ref_cc]
    index = ref.index
    try:
        retail_markup = volatility.load_dealer_markup(index)
    except FileNotFoundError:
        print("  [UNAVAILABLE] EUR country curves: dealer markup missing. "
              "Run engine.dealer_markup.run() first.")
        return

    for tag, series_set in (("level", levels_bps),
                            ("spread", {cc: (s - ref) for cc, s in levels_bps.items()
                                        if cc != ref_cc})):
        curves = {}
        for cc, s in series_set.items():
            s = s.rename(cc)
            # ECB LTIR is MONTHLY. Without freq="months" the shared machinery
            # applies its daily window counts verbatim — a 90-MONTH fee window
            # and a 21-MONTH realized-vol lookback — so the mean |T-month move|
            # over 7.5 years came out larger than the mean move on the shock
            # periods it was charged against, and every country priced as a
            # guaranteed loss. See config.FREQ_PROFILES.
            curves[cc] = volatility.return_curve(
                s, percentile, retail_markup,
                hold_max=hold_max, trade_size_millions=trade_size_millions,
                freq="months")
        stem = f"europe_country_{tag}_return_curves"
        for view, col, dashed in (("gross", "Gross_bps", False),
                                  ("hf_net", "HF_net_bps", True),
                                  ("retail_net", "Ret_net_bps", True)):
            volatility_matrix.plot_return_curve_view(
                curves, f"Europe countries ({tag})", percentile,
                f"{stem}_{view}.png", column=col, dashed=dashed,
                x_unit="months (ECB LTIR)")
        if tag == "level":
            print(f"\n  [RETURN CURVES] EUR country yields at the {percentile}th "
                  f"percentile (monthly hold units — see {stem}_*.png):")
            _curve_table(curves, hold_days, tag)


def _curve_table(curves: dict, hold_days: int, tag: str) -> None:
    """Per-country summary: net at the CLI hold (months) + first positive T."""
    rows = []
    for cc, df in curves.items():
        if df is None or df.empty:
            continue
        at_gr = df.loc[hold_days, "Gross_bps"] if hold_days in df.index else None
        at_hf = df.loc[hold_days, "HF_net_bps"] if hold_days in df.index else None
        at_rt = df.loc[hold_days, "Ret_net_bps"] if hold_days in df.index else None
        f = lambda v: f"{v:+.2f}" if pd.notna(v) else "n/a"
        rows.append([COUNTRY_NAMES.get(cc, cc), f(at_gr), f(at_hf), f(at_rt),
                     str(volatility.first_positive_hold(df, "HF_net_bps")),
                     str(volatility.first_positive_hold(df, "Ret_net_bps"))])
    if not rows:
        return
    print(f"    {'country':<12} {'gross@T':>8} {'HF@T':>7} {'retail@T':>9} "
          f"{'HF>=0 at T':>11} {'retail>=0 at T':>14}")
    for r in rows:
        print(f"    {r[0]:<12} {r[1]:>8} {r[2]:>7} {r[3]:>9} {r[4]:>11} {r[5]:>14}")
    print("    (hold units = months on monthly LTIR; T = the CLI hold months)")
