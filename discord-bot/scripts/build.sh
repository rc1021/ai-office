#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "[Build] Compiling TypeScript..."
cd "$PROJECT_DIR"
npx tsc
echo "[Build] Done. Output in ./dist/"
