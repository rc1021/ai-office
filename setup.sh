#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/rc1021/ai-office.git"
INSTALL_DIR="${AI_OFFICE_DIR:-ai-office}"

echo ""
echo "  ==================================="
echo "    AI Office — Setup"
echo "  ==================================="
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────

# ── Clone if needed ───────────────────────────────────────────────────────────

if [ -f "CLAUDE.md" ] && [ -d "config" ] && [ -d "discord-bot" ]; then
  : # Already inside the repo
elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/CLAUDE.md" ]; then
  cd "$INSTALL_DIR"
else
  echo "  Cloning AI Office..."
  git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
  cd "$INSTALL_DIR"
  echo "  [OK] Cloned to $(pwd)"
  echo ""
fi

# Save project directory (must be after clone/cd)
PROJECT_DIR="$(pwd)"

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "[1/4] Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo "  [FAIL] Node.js not found. Install Node.js >= 22: https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "  [WARN] Node.js v$NODE_VERSION detected. Recommended: >= 22"
else
  echo "  [OK] Node.js $(node -v)"
fi

# npm
if ! command -v npm &>/dev/null; then
  echo "  [FAIL] npm not found."
  exit 1
fi
echo "  [OK] npm $(npm -v)"

# git
if ! command -v git &>/dev/null; then
  echo "  [FAIL] git not found."
  exit 1
fi
echo "  [OK] git $(git --version | awk '{print $3}')"

# Claude Code
if command -v claude &>/dev/null; then
  echo "  [OK] Claude Code installed"
else
  echo "  [WARN] Claude Code not found. Install: https://docs.anthropic.com/en/docs/claude-code"
fi

# Docker (optional)
if command -v docker &>/dev/null; then
  echo "  [OK] Docker $(docker --version | awk '{print $3}' | tr -d ',')"
else
  echo "  [SKIP] Docker not found (optional)"
fi

# ngrok (optional)
if command -v ngrok &>/dev/null; then
  echo "  [OK] ngrok $(ngrok version | awk '{print $3}')"
else
  echo "  [SKIP] ngrok not found (optional — for remote Pixel Office access)"
fi

# ── Install Dependencies ─────────────────────────────────────────────────────

echo ""
echo "[2/4] Installing dependencies..."

for dir in discord-bot coordination orchestrator pixel-office setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  Installing $dir..."
    (cd "$dir" && npm install --silent 2>&1) || {
      echo "  [FAIL] npm install failed in $dir"
      exit 1
    }
  fi
done
echo "  [OK] All dependencies installed"

# ── Build ─────────────────────────────────────────────────────────────────────

echo ""
echo "[3/4] Building TypeScript..."

for dir in discord-bot coordination orchestrator setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  Building $dir..."
    (cd "$dir" && npm run build --silent 2>&1) || {
      echo "  [FAIL] Build failed in $dir"
      exit 1
    }
  fi
done

# Pixel Office has separate server/client builds
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

# ── Configuration Wizard ──────────────────────────────────────────────────────

echo ""
echo "[4/4] Running configuration wizard..."
echo ""

# Reset terminal settings (npm/build may have altered them)
stty sane 2>/dev/null || true

node setup/dist/wizard.js || {
  echo ""
  echo "  Setup was cancelled. To restart: ./setup.sh"
  echo ""
  exit 0
}

# ── Stop old processes ────────────────────────────────────────────────────────

echo ""
echo "[5/6] Stopping old processes (if any)..."

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

# Kill any remaining pixel-office processes for THIS project
pkill -f "$PROJECT_DIR/pixel-office" 2>/dev/null && echo "  [OK] Cleaned up stale pixel-office processes" || true

echo "  [OK] Old processes cleaned up"

# ── Start Discord Listener ────────────────────────────────────────────────────

echo ""
echo "[6/6] Starting Discord Listener daemon..."

LISTENER_LOG="$PROJECT_DIR/discord-bot/listener.log"

# Start listener in background, redirect all output to log file
set +u  # $! is unset before first background job
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

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    Setup Complete!"
echo "  ==================================="
echo ""
echo "  Discord Listener is running in the background."
echo "  Send a message in Discord #general — the bot will respond via claude -p."
echo ""
echo "  Other options:"
echo ""
echo "  • Start the Leader interactively (Claude Code session):"
echo "     cd $PROJECT_DIR && claude"
echo ""
echo "  • View listener logs:"
echo "     tail -f $LISTENER_LOG"
echo ""
echo "  • Stop the listener:"
echo "     kill $LISTENER_PID"
echo ""
if [ -f "$PROJECT_DIR/pixel-office/.env" ] && grep -q "NGROK_ENABLED=true" "$PROJECT_DIR/pixel-office/.env" 2>/dev/null; then
echo "  • Pixel Office will start automatically with ngrok"
echo "    (public URL will be posted to Discord #bot-status)"
else
echo "  • Start Pixel Office (optional):"
echo "    cd $PROJECT_DIR/pixel-office && npm run dev"
fi
echo ""
