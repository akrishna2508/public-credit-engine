"""Tests for configuration / secret handling - no network."""
import pathlib

import pytest

import config


def test_fred_key_missing_raises(monkeypatch):
    """Real raise path: with FRED_API_KEY absent from the environment, the
    actual get_fred_key() implementation must raise (no monkeypatched stub)."""
    monkeypatch.delenv("FRED_API_KEY", raising=False)
    with pytest.raises(EnvironmentError):
        config.get_fred_key()


def test_no_embedded_key_in_source():
    """The leaked key literal must not exist anywhere in the repo.

    Scans every file (not just .py) — the earlier *.py-only scan missed the
    leaked literal that had been copied into .env.example. Excluded: .venv,
    caches, notebooks/ (archived original), .env (the user's live key,
    git-ignored), and this test file itself.
    """
    root = pathlib.Path(__file__).resolve().parent.parent
    leaked = "ccb67ba570ac152dc7930a216488320d"
    skip_dir = {"notebooks", ".venv", "__pycache__", ".pytest_cache", ".git"}
    hits = []
    for f in root.rglob("*"):
        if not f.is_file() or f.name == "test_config.py" or f.name == ".env":
            continue
        if any(part in skip_dir for part in f.parts):
            continue
        try:
            content = f.read_bytes()
        except OSError:
            continue
        if leaked.encode() in content:
            hits.append(str(f))
    assert hits == [], f"Embedded key literal found in: {hits}"


def test_env_placeholder_name():
    env = config.BASE_DIR / ".env"
    assert env.exists()