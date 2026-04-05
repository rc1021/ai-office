#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/rc1021/ai-office.git"
INSTALL_DIR="${AI_OFFICE_DIR:-ai-office}"

# ── Detect if running via curl pipe (stdin is not a terminal) ─────────────────

if [ ! -t 0 ]; then
  # Running via: curl ... | bash
  # Only clone the repo, then tell the user to run setup.sh interactively
  echo ""
  echo "  ==================================="
  echo "    AI Office — Installer"
  echo "  ==================================="
  echo ""

  # Check git
  if ! command -v git &>/dev/null; then
    echo "  [FAIL] git not found. Install git first."
    exit 1
  fi

  if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/CLAUDE.md" ]; then
    echo "  [OK] AI Office already exists at ./$INSTALL_DIR"
    echo ""
    echo "  To update and configure, run:"
    echo "    cd $INSTALL_DIR && ./setup.sh"
    echo ""
  else
    echo "  Cloning AI Office..."
    git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'
    echo ""
    echo "  [OK] AI Office cloned to ./$INSTALL_DIR"
    echo ""
    echo "  Next — run the setup wizard:"
    echo "    cd $INSTALL_DIR && ./setup.sh"
    echo ""
  fi
  exit 0
fi

# ── Interactive setup (stdin is a terminal) ───────────────────────────────────

echo ""
echo "  ==================================="
echo "    AI Office — Setup"
echo "  ==================================="
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────

echo "[1/5] Checking prerequisites..."

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
echo "[2/5] Installing dependencies..."

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
echo "[3/5] Building TypeScript..."

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
    echo "  [FAIL] Build failed in pixel-office"
    exit 1
  }
fi

echo "  [OK] All builds successful"

# ── Configuration Wizard ──────────────────────────────────────────────────────

echo ""
echo "[4/5] Running configuration wizard..."
echo ""

node setup/dist/wizard.js

# ── Start Services ───────────────────────────────────────────────────────────

echo ""
echo "[5/5] Starting AI Office..."
echo ""

# Start Pixel Office in background
if [ -d "pixel-office" ]; then
  echo "  Starting Pixel Office server..."
  (cd pixel-office && npx tsx server/index.ts &>/dev/null &)
  PIXEL_PID=$!
  sleep 2
  if kill -0 "$PIXEL_PID" 2>/dev/null; then
    echo "  [OK] Pixel Office running at http://localhost:${PIXEL_OFFICE_PORT:-3847}"
  else
    echo "  [WARN] Pixel Office failed to start (non-critical)"
  fi
fi

echo ""
echo "  ==================================="
echo "    Setup Complete!"
echo "  ==================================="
echo ""
echo "  Launching Leader agent..."
echo "  (The Leader will greet you in Discord #general)"
echo ""

# Launch Claude Code with Leader — interactive session
exec claude "Execute your Startup Checklist. This may be the first launch — check for the onboarded flag and run the Welcome Flow if needed."
