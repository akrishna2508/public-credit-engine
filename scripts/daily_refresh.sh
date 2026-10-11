#!/bin/bash
# Daily refresh: regenerate all engine data and warm web seed bundle.
# Runs all CLI markets to refresh data, then delegates git commit/push to the GitHub Actions workflow.
# Designed for cron: runs once per day after market set-close.
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate

LOG="/tmp/publiccredit_daily_refresh.log"
exec > >(tee -a "$LOG") 2>&1

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "========================================="
echo "Daily refresh started: $TIMESTAMP"
echo "========================================="

# 1. Regenerate atlas/heatmap data
echo "-- Regenerating atlas (15 countries + 168 markets)..."
python cli.py --market atlas
echo "  DONE atlas"
}
echo "  DONE atlas"

# 2. US pipeline (yields, spreads, EL, VAR, volatility spectra, return curves)
echo "-- Running US public pipeline..."
python cli.py --market us --hold-days 5 --trade-size-m 50 > /dev/null 2>&1 || echo "  WARN: US pipeline had issues"
echo "  DONE us"

# 3. EUR panel (ECB LTIR yields, country spreads, three-view curves)
echo "-- Running EU panel..."
python cli.py --market eu > /dev/null 2>&1 || echo "  WARN: EU pipeline had issues"
echo "  DONE eu"

# 4. EM pure yields and volatility spectrum
echo "-- Running EM pipeline..."
python cli.py --market em > /dev/null 2>&1 || echo "  WARN: EM pipeline had issues"
echo "  DONE em"

# 5. ML scorecard with SHAP explanations
echo "-- Running ML scorecard..."
python cli.py --market ml > /dev/null 2>&1 || echo "  WARN: ML pipeline had issues"
echo "  DONE ml"

# 6. GCO opportunity board (free sources, gated votes)
echo "-- Running GCO global board..."
python cli.py --market global > /dev/null 2>&1 || echo "  WARN: Global board had issues"
echo "  DONE global"

# 7. Walk-forward OOS battery (no look-ahead validation)
echo "-- Running backtest battery..."
python cli.py --market backtest > /dev/null 2>&1 || echo "  WARN: Backtest battery had issues"
echo "  DONE backtest"

# 8. Warm the web seed bundle (committed fallback for cold/deployed instances)
echo "-- Warming web seed bundle..."
(cd web && npm run seed 2>/dev/null) || {
    echo "  WARNING: web seed npm script had issues (check node deps)"
}
echo "  DONE web seed"

# 9. Stage all changed data files for git commit
echo "-- Staging data changes for git..."
git add data/atlas.json data/dealer_markup.json data/iv_history.json \
        data/expected_loss_by_grade.json \
        web/public/data/bundle.json web/public/data/status.json api/iv_history.json 2>/dev/null || true

# Check if anything was staged
STAGED=$(git diff --staged --quiet 2>/dev/null && echo "NO" || echo "YES")
echo "  Staged changes: $STAGED"

# Note: git commit + push delegated to GitHub Actions workflow (see .github/workflows/daily_refresh.yml)
# The workflow step 5 will commit and push using GH_PAT secret.
# We leave files staged so the workflow can pick them up.

echo "-- Daily refresh complete (git commit/push delegated to GitHub Actions workflow)"
echo "  Files staged for: atlas.json, dealer_markup.json, iv_history.json,"
echo "  bundle.json, status.json, iv_history.json (api)"

echo "$(date): Daily refresh complete."
echo "========================================="
TIMESTAMP_END=$(date '+%Y-%m-%d %H:%M:%S')
echo "Started: $TIMESTAMP"
echo "Finished: $TIMESTAMP_END"
echo "========================================="
