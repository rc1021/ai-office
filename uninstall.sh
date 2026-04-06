#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "  ==================================="
echo "    AI Office — Uninstall"
echo "  ==================================="
echo ""

# Verify we're in the right directory
if [ ! -f "CLAUDE.md" ] || [ ! -d "config" ] || [ ! -d "discord-bot" ]; then
  echo "  [FAIL] Not in AI Office directory. Run this from the project root."
  exit 1
fi

PROJECT_DIR="$(pwd)"

# ── Stop Discord Listener ────────────────────────────────────────────────────

echo "[1/3] Stopping running processes..."

LISTENER_PID_FILE="$PROJECT_DIR/discord-bot/listener.pid"
if [ -f "$LISTENER_PID_FILE" ]; then
  OLD_PID=$(cat "$LISTENER_PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null && echo "  [OK] Stopped Discord Listener (PID $OLD_PID)"
    sleep 1
  else
    echo "  [SKIP] Listener PID $OLD_PID not running"
  fi
  rm -f "$LISTENER_PID_FILE"
else
  echo "  [SKIP] No listener PID file found"
fi

# ── Stop Pixel Office ────────────────────────────────────────────────────────

PIXEL_PID_FILE="$PROJECT_DIR/pixel-office/pixel.pid"
if [ -f "$PIXEL_PID_FILE" ]; then
  OLD_PID=$(cat "$PIXEL_PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null && echo "  [OK] Stopped Pixel Office (PID $OLD_PID)"
    sleep 1
  else
    echo "  [SKIP] Pixel Office PID $OLD_PID not running"
  fi
  rm -f "$PIXEL_PID_FILE"
else
  echo "  [SKIP] No pixel-office PID file found"
fi

# Kill any remaining pixel-office processes for THIS project
if pkill -f "$PROJECT_DIR/pixel-office" 2>/dev/null; then
  echo "  [OK] Cleaned up stale pixel-office processes"
fi

# Kill any remaining listener processes for THIS project
if pkill -f "$PROJECT_DIR/discord-bot/dist/listener" 2>/dev/null; then
  echo "  [OK] Cleaned up stale listener processes"
fi

echo "  [OK] All processes stopped"

# ── Clean up state ───────────────────────────────────────────────────────────

echo ""
echo "[2/3] Cleaning up state files..."

# Remove AI Office state (onboarded flag, coordination DB, approvals)
if [ -d "$PROJECT_DIR/.ai-office" ]; then
  rm -rf "$PROJECT_DIR/.ai-office"
  echo "  [OK] Removed .ai-office/ (state, DB, approvals)"
fi

# Remove listener log
if [ -f "$PROJECT_DIR/discord-bot/listener.log" ]; then
  rm -f "$PROJECT_DIR/discord-bot/listener.log"
  echo "  [OK] Removed listener.log"
fi

# Remove build outputs
for dir in discord-bot coordination orchestrator setup; do
  if [ -d "$PROJECT_DIR/$dir/dist" ]; then
    rm -rf "$PROJECT_DIR/$dir/dist"
    echo "  [OK] Removed $dir/dist/"
  fi
done

if [ -d "$PROJECT_DIR/pixel-office/client/dist" ]; then
  rm -rf "$PROJECT_DIR/pixel-office/client/dist"
  echo "  [OK] Removed pixel-office/client/dist/"
fi

echo "  [OK] State files cleaned"

# ── Remove node_modules ──────────────────────────────────────────────────────

echo ""
echo "[3/3] Removing node_modules..."

for dir in discord-bot coordination orchestrator pixel-office setup; do
  if [ -d "$PROJECT_DIR/$dir/node_modules" ]; then
    rm -rf "$PROJECT_DIR/$dir/node_modules"
    echo "  [OK] Removed $dir/node_modules/"
  fi
done

echo "  [OK] All node_modules removed"

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    Uninstall Complete!"
echo "  ==================================="
echo ""
echo "  All processes stopped, state cleared, dependencies removed."
echo "  Your .env config files are preserved (discord-bot/.env, pixel-office/.env)."
echo ""
echo "  To reinstall:  ./setup.sh"
echo "  To fully remove:  rm -rf $PROJECT_DIR"
echo ""
