#!/bin/bash
# Daily IV-RV accrual: snapshots the credit-ETF options chains into
# data/iv_history.json. The board's IV-RV z-score leg needs >= IV_Z_MIN_OBS
# (20) accrued days; run this once per trading day until it unlocks.
#
# macOS: load the companion launchd plist
#   cp scripts/com.publiccredit.iv-accrual.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/com.publiccredit.iv-accrual.plist
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate
python -m sources.probe 2>/dev/null || true
python - <<'PY'
import config
from engine.options_surface import history_to_frame, load_iv_history
frame = history_to_frame(load_iv_history())
for ticker in frame.columns:
    n = frame[ticker].dropna().shape[0]
    print(f"IV-RV accrual {ticker}: {n}/{config.IV_Z_MIN_OBS} days "
          f"({'UNLOCKED' if n >= config.IV_Z_MIN_OBS else 'still gated'})")
PY
# refresh the web Signals snapshot + seed bundle so the committed
# api/iv_history.json follows the accrual automatically (the Signals cards
# auto-go-live when their gate flips; redeploy picks the snapshots up)
(cd web && npm run seed) 2>/dev/null || echo "web seed skipped (deps/build unavailable)"
