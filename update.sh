#!/usr/bin/env bash
set -euo pipefail

REPO="rc1021/ai-office"
BRANCH="main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

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

PROJECT_DIR="$(pwd)"

# ── Download latest source ───────────────────────────────────────────────────

echo "[1/4] Downloading latest version..."

tmpfile=$(mktemp)
tmpdir=$(mktemp -d)

curl -fsSL "$ARCHIVE_URL" -o "$tmpfile" || {
  echo "  [FAIL] Download failed. Check your network connection."
  rm -f "$tmpfile"
  rmdir "$tmpdir"
  exit 1
}
tar xzf "$tmpfile" --strip-components=1 -C "$tmpdir"
rm -f "$tmpfile"
echo "  [OK] Downloaded"

# ── Merge: overwrite source, preserve config ─────────────────────────────────

echo ""
echo "[2/4] Updating source files (preserving config)..."

# Files/dirs to NEVER overwrite (user-specific config)
PRESERVE=(
  "config/office.yaml"
  "config/active-roles.yaml"
  "discord-bot/.env"
  "pixel-office/.env"
  ".mcp.json"
  ".ai-office"
)

# Copy new files over, skipping preserved paths
# Use rsync if available (cleaner), fall back to manual copy
if command -v rsync &>/dev/null; then
  # Build rsync exclude list
  EXCLUDES=()
  for p in "${PRESERVE[@]}"; do
    EXCLUDES+=(--exclude "$p")
  done
  rsync -a "${EXCLUDES[@]}" "$tmpdir/" "$PROJECT_DIR/"
  echo "  [OK] Source files updated (rsync)"
else
  # Manual: copy everything, then restore preserved files
  # Back up preserved files
  backup_dir=$(mktemp -d)
  for p in "${PRESERVE[@]}"; do
    if [ -e "$PROJECT_DIR/$p" ]; then
      mkdir -p "$backup_dir/$(dirname "$p")"
      cp -a "$PROJECT_DIR/$p" "$backup_dir/$p"
    fi
  done

  # Overwrite with new source
  cp -a "$tmpdir/"* "$PROJECT_DIR/"

  # Restore preserved files
  for p in "${PRESERVE[@]}"; do
    if [ -e "$backup_dir/$p" ]; then
      mkdir -p "$(dirname "$PROJECT_DIR/$p")"
      cp -a "$backup_dir/$p" "$PROJECT_DIR/$p"
    fi
  done
  rm -rf "$backup_dir"
  echo "  [OK] Source files updated (manual copy)"
fi

rm -rf "$tmpdir"

# ── Install Dependencies + Build ─────────────────────────────────────────────

echo ""
echo "[3/4] Updating dependencies & rebuilding..."

for dir in discord-bot coordination orchestrator pixel-office setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  $dir: install..."
    (cd "$dir" && npm install --silent 2>&1) || {
      echo "  [FAIL] npm install failed in $dir"
      exit 1
    }
  fi
done

for dir in discord-bot coordination orchestrator setup; do
  if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
    echo "  $dir: build..."
    (cd "$dir" && npm run build --silent 2>&1) || {
      echo "  [FAIL] Build failed in $dir"
      exit 1
    }
  fi
done

if [ -d "pixel-office" ]; then
  echo "  pixel-office: build (server)..."
  (cd pixel-office && npm run build:server --silent 2>&1) || {
    echo "  [FAIL] Build failed in pixel-office (server)"
    exit 1
  }
  echo "  pixel-office: build (client)..."
  (cd pixel-office && npm run build:client --silent 2>&1) || {
    echo "  [FAIL] Build failed in pixel-office (client)"
    exit 1
  }
fi

echo "  [OK] All builds successful"

# ── Stop old processes & restart listener ────────────────────────────────────

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

pkill -f "$PROJECT_DIR/discord-bot/dist/listener" 2>/dev/null && echo "  [OK] Cleaned up stale listener processes" || true
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
echo "  Config files preserved:"
echo "    • config/office.yaml"
echo "    • config/active-roles.yaml"
echo "    • discord-bot/.env"
echo "    • pixel-office/.env"
echo "    • .mcp.json"
echo ""
echo "  • View listener logs:"
echo "     tail -f $LISTENER_LOG"
echo ""
echo "  • Stop the listener:"
echo "     kill $LISTENER_PID"
echo ""
