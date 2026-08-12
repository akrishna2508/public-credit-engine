"""Opportunity Board: rank signals into a single source-attributed view.

Conviction = (n_pos - n_neg) / n_available over non-None signals, with a
|z| threshold. There are no magic weights — a source that is unavailable
reports UNAVAILABLE and contributes nothing.
"""
from __future__ import annotations

from dataclasses import dataclass


def _sign(value: float | None, threshold: float) -> int:
    if value is None:
        return 0
    if value > threshold:
        return 1
    if value < -threshold:
        return -1
    return 0


def conviction(signals: list[float | None], threshold: float) -> tuple[float | None, int, int]:
    """(score, n_pos, n_neg) over non-None signals; (None, 0, 0) if none usable."""
    usable = [(v, _sign(v, threshold)) for v in signals if v is not None]
    if not usable:
        return None, 0, 0
    n_pos = sum(1 for _, s in usable if s > 0)
    n_neg = sum(1 for _, s in usable if s < 0)
    return round((n_pos - n_neg) / len(usable), 3), n_pos, n_neg


@dataclass
class BoardRow:
    name: str
    direction: str
    signals: dict
    sources: list
    score: float | None
    n_pos: int
    n_neg: int
    detail: str = ""


def build_board(rows: list[dict], threshold: float) -> list[BoardRow]:
    """rows: [{name, direction, signals: {k: v|None}, sources, detail}]."""
    out = []
    for r in rows:
        score, n_pos, n_neg = conviction(list(r["signals"].values()), threshold)
        out.append(BoardRow(name=r["name"], direction=r.get("direction", "NEUTRAL"),
                            signals=r["signals"], sources=r.get("sources", []),
                            score=score, n_pos=n_pos, n_neg=n_neg,
                            detail=r.get("detail", "")))
    out.sort(key=lambda b: (b.score is None, -(b.score or 0)))
    return out


def print_board(board: list[BoardRow]) -> None:
    print("\n" + "=" * 78)
    print("  GLOBAL CREDIT OPPORTUNITY BOARD")
    print("=" * 78)
    if not board:
        print("  No signals available — nothing fabricated on this board.")
        return
    for b in board:
        score = f"{b.score:+.3f}" if b.score is not None else "   n/a"
        sigs = "; ".join(f"{k}={v}" if v is not None else f"{k}=UNAVAILABLE"
                         for k, v in b.signals.items())
        print(f"\n  [{b.direction:<14}] {b.name}")
        print(f"    conviction={score}  (pos={b.n_pos}, neg={b.n_neg})")
        print(f"    signals: {sigs}")
        print(f"    sources: {', '.join(b.sources)}")
        if b.detail:
            print(f"    detail: {b.detail}")
