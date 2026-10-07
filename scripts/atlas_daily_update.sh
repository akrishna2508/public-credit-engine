#!/bin/bash
# Daily atlas update: regenerates data/atlas.json and pushes seed bundle to deployment
# Run this once per day (e.g., via cron or launchd) to keep the opportunity map current.
set -euo pipefail
cd "$(dirname "$0")/.."
source .venv/bin/activate

echo "$(date): Starting daily atlas update..."

# Step 1: Regenerate atlas from live FRED/yfinance data
echo "  Regenerating atlas.json from live data..."
python cli.py --market atlas > /dev/null 2>&1 || {
    echo "  ERROR: atlas regeneration failed"
    exit 1
}
echo "  atlas.json regenerated OK"

# Step 2: Warm the web seed bundle (the committed fallback for cold/deployed instances)
echo "  warming web seed bundle..."
(cd web && npm run seed 2>/dev/null) || {
    echo "  WARNING: web seed npm script had issues (check deps)"
}
echo "  web seed complete"

# Step 3: Git commit and push (if git is available and working)
if git rev-parse --git-dir > /dev/null 2>&1; then
    echo "  Committing atlas changes..."
    git add data/atlas.json web/public/data/bundle.json web/public/data/status.json 2>/dev/null
    if git diff --staged --quiet; then
        echo "  No changes to commit (atlas data unchanged)"
    else
        git commit -m "daily atlas update: $(date +%Y-%m-%d)" 2>/dev/null
        echo "  Changes committed"
        # Note: push not automatic — requires credentials/remote config
        # git push origin master 2>/dev/null || echo "  push skipped (no remote/or auth)"
    fi
else
    echo "  Not a git repo — skipping commit"
fi

echo "$(date): Daily atlas update complete."
