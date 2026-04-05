#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "  ==================================="
echo "    AI Office — Update"
echo "  ==================================="
echo ""

# Verify we're in the right directory
if [ ! -f "CLAUDE.md" ] || [ ! -d "config" ]; then
  echo "  [FAIL] Not in AI Office directory. Run this from the project root."
  exit 1
fi

# ── Pull latest ──────────────────────────────────────────────────────────────

echo "[1/3] Pulling latest changes..."

if git diff --quiet && git diff --cached --quiet; then
  git pull 2>&1 | sed 's/^/  /'
  echo "  [OK] Up to date"
else
  echo "  [WARN] You have local changes. Stashing..."
  git stash
  git pull 2>&1 | sed 's/^/  /'
  git stash pop 2>/dev/null || echo "  [INFO] Stash had conflicts — resolve manually"
  echo "  [OK] Updated (local changes preserved)"
fi

# ── Install Dependencies ─────────────────────────────────────────────────────

echo ""
echo "[2/3] Updating dependencies..."

for dir in discord-bot coordination orchestrator pixel-office setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  Updating $dir..."
    (cd "$dir" && npm install --silent 2>&1) || {
      echo "  [FAIL] npm install failed in $dir"
      exit 1
    }
  fi
done
echo "  [OK] All dependencies updated"

# ── Build ─────────────────────────────────────────────────────────────────────

echo ""
echo "[3/3] Rebuilding TypeScript..."

for dir in discord-bot coordination orchestrator setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  Building $dir..."
    (cd "$dir" && npm run build --silent 2>&1) || {
      echo "  [FAIL] Build failed in $dir"
      exit 1
    }
  fi
done

if [ -d "pixel-office" ]; then
  echo "  Building pixel-office (server)..."
  (cd pixel-office && npm run build:server --silent 2>&1) || {
    echo "  [FAIL] Build failed in pixel-office"
    exit 1
  }
fi

echo "  [OK] All builds successful"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    Update Complete!"
echo "  ==================================="
echo ""
echo "  Your configuration is preserved."
echo "  Restart AI Office:"
echo "    ./setup.sh    (to restart Pixel Office + Leader)"
echo "    or manually:  cd pixel-office && npm run dev"
echo ""
