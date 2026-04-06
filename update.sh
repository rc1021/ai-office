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
    echo "  [FAIL] Build failed in pixel-office (server)"
    exit 1
  }
  echo "  Building pixel-office (client)..."
  (cd pixel-office && npm run build:client --silent 2>&1) || {
    echo "  [FAIL] Build failed in pixel-office (client)"
    exit 1
  }
fi

echo "  [OK] All builds successful"

# ── Stop old processes & restart listener ────────────────────────────────────

PROJECT_DIR="$(pwd)"

echo ""
echo "[4/4] Restarting services..."

# Stop old Discord Listener
LISTENER_PID_FILE="$PROJECT_DIR/discord-bot/listener.pid"
if [ -f "$LISTENER_PID_FILE" ]; then
  OLD_PID=$(cat "$LISTENER_PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null && echo "  [OK] Stopped old listener (PID $OLD_PID)"
    sleep 1
  fi
  rm -f "$LISTENER_PID_FILE"
fi

# Stop old Pixel Office
PIXEL_PID_FILE="$PROJECT_DIR/pixel-office/pixel.pid"
if [ -f "$PIXEL_PID_FILE" ]; then
  OLD_PID=$(cat "$PIXEL_PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null && echo "  [OK] Stopped old pixel-office (PID $OLD_PID)"
    sleep 1
  fi
  rm -f "$PIXEL_PID_FILE"
fi

pkill -f "$PROJECT_DIR/pixel-office" 2>/dev/null && echo "  [OK] Cleaned up stale pixel-office processes" || true

# Start new listener
LISTENER_LOG="$PROJECT_DIR/discord-bot/listener.log"

set +u
node "$PROJECT_DIR/discord-bot/dist/listener.js" >>"$LISTENER_LOG" 2>&1 &
LISTENER_PID="$!"
set -u

sleep 2
if kill -0 "$LISTENER_PID" 2>/dev/null; then
  echo "$LISTENER_PID" > "$PROJECT_DIR/discord-bot/listener.pid"
  echo "  [OK] Discord Listener restarted (PID $LISTENER_PID)"
else
  echo "  [WARN] Discord Listener may have failed to start."
  echo "         Check log: $LISTENER_LOG"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    Update Complete!"
echo "  ==================================="
echo ""
echo "  Your configuration is preserved."
echo "  Discord Listener has been restarted with the latest code."
echo ""
echo "  • View listener logs:"
echo "     tail -f $LISTENER_LOG"
echo ""
echo "  • Stop the listener:"
echo "     kill $LISTENER_PID"
echo ""
