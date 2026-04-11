#!/usr/bin/env bash
set -euo pipefail

REPO="rc1021/ai-office"
BRANCH="main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
INSTALL_DIR="${AI_OFFICE_DIR:-ai-office}"

echo ""
echo "  ==================================="
echo "    AI Office — Setup"
echo "  ==================================="
echo ""

# ── OS Detection ──────────────────────────────────────────────────────────────

detect_os() {
  case "${OSTYPE:-}" in
    darwin*)  echo "macOS" ;;
    linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        echo "WSL"
      else
        echo "Linux"
      fi ;;
    msys*|cygwin*|win32*) echo "Windows" ;;
    *)        echo "Unknown" ;;
  esac
}
OS=$(detect_os)

# ── Download if needed ───────────────────────────────────────────────────────

if [ -f "CLAUDE.md" ] && [ -d "config" ] && [ -d "discord-bot" ]; then
  : # Already inside the project
elif [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/CLAUDE.md" ]; then
  cd "$INSTALL_DIR"
else
  echo "  Downloading AI Office..."
  tmpfile=$(mktemp)
  curl -fsSL "$ARCHIVE_URL" -o "$tmpfile" || {
    echo "  [FAIL] Download failed. Check your network connection."
    rm -f "$tmpfile"
    exit 1
  }
  mkdir -p "$INSTALL_DIR"
  tar xzf "$tmpfile" --strip-components=1 -C "$INSTALL_DIR"
  rm -f "$tmpfile"
  cd "$INSTALL_DIR"
  echo "  [OK] Downloaded to $(pwd)"
  echo ""
fi

# Save project directory (must be after clone/cd)
PROJECT_DIR="$(pwd)"

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "[1/4] Checking prerequisites..."

# Node.js
if ! command -v node &>/dev/null; then
  echo ""
  echo "  [FAIL] Node.js 22+ not found."
  echo ""
  echo "  Install Node.js for your platform:"
  case "$OS" in
    macOS)
      echo "    brew install node@22          (Homebrew)"
      echo "    or: nvm install 22            (https://nvm.sh)"
      ;;
    Linux|WSL)
      echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
      echo "    sudo apt-get install -y nodejs"
      echo "    or: nvm install 22            (https://nvm.sh)"
      ;;
    Windows)
      echo "    winget install OpenJS.NodeJS.LTS"
      echo "    or download: https://nodejs.org/en/download"
      echo "    (recommended: run this script via Git Bash or WSL)"
      ;;
    *)
      echo "    https://nodejs.org/en/download"
      echo "    or: nvm install 22            (https://nvm.sh)"
      ;;
  esac
  echo ""
  echo "  After installing, re-run: bash setup.sh"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "  [WARN] Node.js v$NODE_VERSION detected. Recommended: >= 22"
  echo "         Upgrade: nvm install 22 && nvm use 22"
else
  echo "  [OK] Node.js $(node -v)"
fi

# npm
if ! command -v npm &>/dev/null; then
  echo ""
  echo "  [FAIL] npm not found. It should ship with Node.js."
  echo "  Try reinstalling Node.js: https://nodejs.org"
  echo ""
  exit 1
fi
echo "  [OK] npm $(npm -v)"

# curl (needed for downloads)
if ! command -v curl &>/dev/null; then
  echo ""
  echo "  [FAIL] curl not found."
  case "$OS" in
    macOS)   echo "  Install: brew install curl" ;;
    Linux|WSL) echo "  Install: sudo apt-get install -y curl" ;;
    Windows) echo "  curl is built into Windows 10+. Try running from Git Bash." ;;
  esac
  echo ""
  exit 1
fi
echo "  [OK] curl"

# Claude Code (required for Leader agent)
if command -v claude &>/dev/null; then
  echo "  [OK] Claude Code $(claude --version 2>/dev/null | head -1 || echo 'installed')"
else
  echo ""
  echo "  [FAIL] Claude Code not found. It is required to run the Leader agent."
  echo ""
  echo "  Install Claude Code:"
  echo "    npm install -g @anthropic-ai/claude-code"
  echo "    then: claude login"
  echo ""
  echo "  Docs: https://docs.anthropic.com/en/docs/claude-code"
  echo ""
  echo "  After installing, re-run: bash setup.sh"
  echo ""
  exit 1
fi

# Docker (optional)
if command -v docker &>/dev/null; then
  echo "  [OK] Docker $(docker --version | awk '{print $3}' | tr -d ',')"
else
  echo "  [SKIP] Docker not found (optional — needed only for containerized deployment)"
fi

# ngrok (optional)
if command -v ngrok &>/dev/null; then
  echo "  [OK] ngrok $(ngrok version 2>/dev/null | awk '{print $3}' || echo 'installed')"
else
  echo "  [SKIP] ngrok not found (optional — for remote Pixel Office access)"
fi

# ── Install Dependencies ─────────────────────────────────────────────────────

echo ""
echo "[2/4] Installing dependencies..."

for dir in core discord-bot coordination orchestrator pixel-office setup cli; do
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

# core must build before discord-bot (file: dependency)
for dir in core discord-bot coordination orchestrator setup cli; do
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
echo "[4/6] Running configuration wizard..."
echo ""

# Reset terminal settings (npm/build may have altered them)
stty sane 2>/dev/null || true

node setup/dist/wizard.js || {
  echo ""
  echo "  Wizard skipped — using existing configuration."
  echo ""
}

# ── Stop old processes ────────────────────────────────────────────────────────

echo ""
echo "[5/6] Stopping old processes..."

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

echo "  [OK] Old processes cleaned up"

# ── Reset onboarding state so the welcome flow triggers on next start ─────────

STATE_DIR="$PROJECT_DIR/.ai-office/state"
mkdir -p "$STATE_DIR"
for f in ".onboarded" "onboarding-state.yaml" "company-profile.yaml"; do
  rm -f "$STATE_DIR/$f" && echo "  [OK] Cleared $f" || true
done

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
