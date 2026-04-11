#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "  ==================================="
echo "    AI Office — Restart"
echo "  ==================================="
echo ""

# Verify we're in the right directory
if [ ! -f "CLAUDE.md" ] || [ ! -d "config" ] || [ ! -d "discord-bot" ]; then
  echo "  [FAIL] Not in AI Office directory. Run this from the project root."
  exit 1
fi

# Node.js required to start the listener
if ! command -v node &>/dev/null; then
  echo "  [FAIL] Node.js not found. Run ./setup.sh first."
  exit 1
fi

PROJECT_DIR="$(pwd)"

# ── Stop running processes ──────────────────────────────────────────────────

echo "[1/2] Stopping running processes..."

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

# Kill any remaining processes for THIS project
pkill -f "$PROJECT_DIR/discord-bot/dist/listener" 2>/dev/null && echo "  [OK] Cleaned up stale listener processes" || true
pkill -f "$PROJECT_DIR/pixel-office" 2>/dev/null && echo "  [OK] Cleaned up stale pixel-office processes" || true

# Kill ALL listener.js processes system-wide (prevents duplicate responses from old installs)
for pid in $(ps aux | grep "[l]istener.js" | awk '{print $2}'); do
  kill "$pid" 2>/dev/null && echo "  [OK] Killed stale listener (PID $pid)"
done

# Clear stale ngrok URL so Leader never shares an expired tunnel
rm -f "$PROJECT_DIR/.ai-office/state/ngrok-url.txt" && echo "  [OK] Cleared stale ngrok URL"

echo "  [OK] All processes stopped"

# ── Start Discord Listener ──────────────────────────────────────────────────

echo ""
echo "[2/2] Starting Discord Listener daemon..."

# Verify build exists
if [ ! -f "$PROJECT_DIR/discord-bot/dist/listener.js" ]; then
  echo "  [FAIL] discord-bot/dist/listener.js not found. Run ./setup.sh or ./update.sh first."
  exit 1
fi

LISTENER_LOG="$PROJECT_DIR/discord-bot/listener.log"

# Start listener in background, redirect all output to log file
set +u
node "$PROJECT_DIR/discord-bot/dist/listener.js" >>"$LISTENER_LOG" 2>&1 &
LISTENER_PID="$!"
set -u

# Brief pause to detect immediate crash
sleep 2
if kill -0 "$LISTENER_PID" 2>/dev/null; then
  echo "$LISTENER_PID" > "$PROJECT_DIR/discord-bot/listener.pid"
  echo "  [OK] Discord Listener started (PID $LISTENER_PID)"
  echo "  Log: $LISTENER_LOG"
else
  echo "  [WARN] Discord Listener may have failed to start."
  echo "         Check log: $LISTENER_LOG"
  echo "         You can start it manually:"
  echo "         cd $PROJECT_DIR && node discord-bot/dist/listener.js"
fi

# ── Done ────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    Restart Complete!"
echo "  ==================================="
echo ""
echo "  • View listener logs:"
echo "     tail -f $LISTENER_LOG"
echo ""
echo "  • Stop the listener:"
echo "     kill $LISTENER_PID"
echo ""
NGROK_MODE=$(grep "^NGROK_MODE=" "$PROJECT_DIR/pixel-office/.env" 2>/dev/null | cut -d= -f2)
if [ -n "$NGROK_MODE" ] && [ "$NGROK_MODE" != "disabled" ]; then
echo "  • Pixel Office starts automatically with the listener"
echo "    (ngrok mode: $NGROK_MODE — public URL will be posted to Discord #general)"
else
echo "  • Pixel Office is running locally at http://localhost:3847"
fi
echo ""
echo "  Showing listener logs (Ctrl+C to stop watching)..."
echo ""
tail -f "$LISTENER_LOG"
