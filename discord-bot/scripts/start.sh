#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "[Start] dist/index.js not found. Run scripts/build.sh first."
  exit 1
fi

echo "[Start] Starting AI Office Discord Bot + MCP Server..."
cd "$PROJECT_DIR"
node dist/index.js
