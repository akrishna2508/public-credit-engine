"""GCO data-source layer: availability-gated free sources (no placeholders).

Design rules (context.md §2.2 / LEDGER §2.2):
  * Every source returns real data or raises SourceUnavailable with a reason
    and a fix instruction. No fabricated values, no zero-fill of missing data.
  * Per-source disk cache under data/cache/ with TTL.
  * Recency checks: stale daily series are flagged, never silently used.
"""
