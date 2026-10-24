"""Unit tests: US Treasury daily par-yield CSV parser (keyless source).

The web + engine merge this same-day curve over FRED's T+1 DGS series for the
US benchmark, so the parser must be exact: quoted headers, blanks for missing
tenors, and a hard failure (never a fabricated number) on an unexpected payload.
"""
import numpy as np
import pandas as pd
import pytest

from sources.registry import SourceUnavailable
from sources.treasury_api import parse_par_yield_csv

# Real header shape (quoted tenor labels), two dated rows.
CSV = (
    'Date,"1 Mo","3 Mo","1 Yr","2 Yr","5 Yr","10 Yr","30 Yr"\n'
    '10/22/2026,4.11,4.22,4.41,4.65,4.78,4.96,5.29\n'
    '10/23/2026,4.11,4.22,4.44,4.69,4.82,5.00,5.33\n'
)

# A row with a blank 30Y (Treasury sometimes omits a tenor).
CSV_BLANK = (
    'Date,"10 Yr","30 Yr"\n'
    '10/23/2026,5.00,\n'
)


def test_parses_tenors_and_dates():
    df = parse_par_yield_csv(CSV)
    assert list(df.columns) == ["1 Mo", "3 Mo", "1 Yr", "2 Yr", "5 Yr", "10 Yr", "30 Yr"]
    assert df.index.is_monotonic_increasing
    assert df.index[0] == pd.Timestamp("2026-10-22")
    assert df.index[-1] == pd.Timestamp("2026-10-23")
    assert float(df["10 Yr"].iloc[-1]) == pytest.approx(5.00)
    assert float(df["2 Yr"].iloc[-1]) == pytest.approx(4.69)


def test_blank_tenor_is_nan_not_zero():
    df = parse_par_yield_csv(CSV_BLANK)
    assert float(df["10 Yr"].iloc[-1]) == pytest.approx(5.00)
    assert np.isnan(df["30 Yr"].iloc[-1])


def test_unexpected_payload_raises():
    with pytest.raises(SourceUnavailable):
        parse_par_yield_csv("<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD></HTML>")


def test_header_only_raises():
    with pytest.raises(SourceUnavailable):
        parse_par_yield_csv('Date,"10 Yr"\n')
