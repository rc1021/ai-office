#!/usr/bin/env bash
set -euo pipefail

# ── 解析 PROJECT_DIR(處理 symlink，相容 macOS 無 readlink -f)────────────────

_resolve_dir() {
  local source="${BASH_SOURCE[0]}"
  local dir
  while [ -L "$source" ]; do
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done
  dir="$(cd -P "$(dirname "$source")" && pwd)"
  echo "$dir"
}

PROJECT_DIR="$(_resolve_dir)"

# ── 常數 ──────────────────────────────────────────────────────────────────────

REPO="rc1021/ai-office"
BRANCH="main"
ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
OFFICE_BIN="$PROJECT_DIR/bin/office"

echo ""
echo "  ==================================="
echo "    AI Office — Update"
echo "  ==================================="
echo ""

# ── 確認在正確目錄 ────────────────────────────────────────────────────────────

if [ ! -f "$PROJECT_DIR/CLAUDE.md" ] || [ ! -d "$PROJECT_DIR/config" ]; then
  echo "  [FAIL] 找不到 AI Office 目錄結構。請從專案根目錄執行。"
  exit 1
fi

# ── [1/4] 下載最新版本（整包下載）──────────────────────────────────────────────

echo "[1/4] 下載最新版本..."

tmpfile=$(mktemp)
tmpdir=$(mktemp -d)

cleanup() {
  rm -f "$tmpfile"
  rm -rf "$tmpdir"
}
trap cleanup EXIT

curl -fsSL "$ARCHIVE_URL" -o "$tmpfile" || {
  echo "  [FAIL] 下載失敗，請確認網路連線。"
  exit 1
}
tar xzf "$tmpfile" --strip-components=1 -C "$tmpdir"
echo "  [OK] 下載完成"

# ── [2/4] 合併更新（保留使用者設定檔）────────────────────────────────────────

echo ""
echo "[2/4] 更新程式碼（保留設定）..."

# 永遠不覆蓋的使用者設定路徑
PRESERVE=(
  "config/office.yaml"
  "config/active-roles.yaml"
  "discord-bot/.env"
  "pixel-office/.env"
  ".mcp.json"
  ".ai-office"
)

if command -v rsync &>/dev/null; then
  EXCLUDES=()
  for p in "${PRESERVE[@]}"; do
    EXCLUDES+=(--exclude "$p")
  done
  rsync -a "${EXCLUDES[@]}" "$tmpdir/" "$PROJECT_DIR/"
  echo "  [OK] 程式碼已更新（rsync）"
else
  # 備份保留路徑 → 全量覆蓋 → 還原備份
  backup_dir=$(mktemp -d)
  for p in "${PRESERVE[@]}"; do
    if [ -e "$PROJECT_DIR/$p" ]; then
      mkdir -p "$backup_dir/$(dirname "$p")"
      cp -a "$PROJECT_DIR/$p" "$backup_dir/$p"
    fi
  done

  cp -a "$tmpdir/"* "$PROJECT_DIR/"

  for p in "${PRESERVE[@]}"; do
    if [ -e "$backup_dir/$p" ]; then
      mkdir -p "$(dirname "$PROJECT_DIR/$p")"
      cp -a "$backup_dir/$p" "$PROJECT_DIR/$p"
    fi
  done
  rm -rf "$backup_dir"
  echo "  [OK] 程式碼已更新（manual copy）"
fi

# ── [3/4] 安裝相依套件 + 重新建置 ────────────────────────────────────────────

echo ""
echo "[3/4] 更新相依套件並重新建置..."

for dir in core discord-bot coordination orchestrator pixel-office setup cli; do
  if [ -d "$PROJECT_DIR/$dir" ] && [ -f "$PROJECT_DIR/$dir/package.json" ]; then
    echo "  $dir: install..."
    (cd "$PROJECT_DIR/$dir" && npm install --silent 2>&1) || {
      echo "  [FAIL] npm install 失敗：$dir"
      exit 1
    }
  fi
done

for dir in core discord-bot coordination orchestrator setup cli; do
  if [ -d "$PROJECT_DIR/$dir" ] && [ -f "$PROJECT_DIR/$dir/package.json" ]; then
    echo "  $dir: build..."
    (cd "$PROJECT_DIR/$dir" && npm run build --silent 2>&1) || {
      echo "  [FAIL] build 失敗：$dir"
      exit 1
    }
  fi
done

if [ -d "$PROJECT_DIR/pixel-office" ]; then
  echo "  pixel-office: build (server)..."
  (cd "$PROJECT_DIR/pixel-office" && npm run build:server --silent 2>&1) || {
    echo "  [FAIL] build 失敗：pixel-office (server)"
    exit 1
  }
  echo "  pixel-office: build (client)..."
  (cd "$PROJECT_DIR/pixel-office" && npm run build:client --silent 2>&1) || {
    echo "  [FAIL] build 失敗：pixel-office (client)"
    exit 1
  }
fi

echo "  [OK] 所有建置完成"

# ── [4/4] 重新啟動服務（委派給 office CLI）────────────────────────────────────

echo ""
echo "[4/4] 重新啟動服務..."

if [ -f "$OFFICE_BIN" ]; then
  "$OFFICE_BIN" stop  || true
  echo ""
  "$OFFICE_BIN" start
else
  # Fallback：office bin 不存在時直接啟動 supervisor/listener
  LISTENER_LOG="$PROJECT_DIR/discord-bot/listener.log"
  LISTENER_PID_FILE="$PROJECT_DIR/discord-bot/listener.pid"
  SUPERVISOR_JS="$PROJECT_DIR/discord-bot/dist/supervisor.js"
  LISTENER_JS="$PROJECT_DIR/discord-bot/dist/listener.js"

  # 停止舊程序
  if [ -f "$LISTENER_PID_FILE" ]; then
    OLD_PID=$(cat "$LISTENER_PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      kill "$OLD_PID" 2>/dev/null && echo "  [OK] 已停止舊程序 (PID $OLD_PID)"
      sleep 1
    fi
    rm -f "$LISTENER_PID_FILE"
  fi
  pkill -f "$PROJECT_DIR/discord-bot/dist/supervisor" 2>/dev/null || true
  pkill -f "$PROJECT_DIR/discord-bot/dist/listener" 2>/dev/null || true
  pkill -f "$PROJECT_DIR/pixel-office" 2>/dev/null || true

  # 清除全域殘留 listener.js（防止重複回應）
  for pid in $(ps aux | grep "[l]istener.js" | awk '{print $2}'); do
    kill "$pid" 2>/dev/null && echo "  [OK] 已清除殘留 listener (PID $pid)" || true
  done

  # 選擇啟動目標（優先 supervisor）
  TARGET_JS=""
  if [ -f "$SUPERVISOR_JS" ]; then
    TARGET_JS="$SUPERVISOR_JS"
  elif [ -f "$LISTENER_JS" ]; then
    TARGET_JS="$LISTENER_JS"
  fi

  if [ -n "$TARGET_JS" ]; then
    set +u
    node "$TARGET_JS" >>"$LISTENER_LOG" 2>&1 &
    NEW_PID="$!"
    set -u
    sleep 2
    if kill -0 "$NEW_PID" 2>/dev/null; then
      echo "$NEW_PID" > "$LISTENER_PID_FILE"
      echo "  [OK] Discord Listener 已重新啟動 (PID $NEW_PID)"
    else
      echo "  [WARN] Discord Listener 可能啟動失敗，請確認日誌：$LISTENER_LOG"
    fi
  else
    echo "  [WARN] 找不到 supervisor.js 或 listener.js，請手動啟動。"
  fi
fi

# ── 完成 ──────────────────────────────────────────────────────────────────────

echo ""
echo "  ==================================="
echo "    更新完成！"
echo "  ==================================="
echo ""
echo "  已保留的設定檔："
echo "    • config/office.yaml"
echo "    • config/active-roles.yaml"
echo "    • discord-bot/.env"
echo "    • pixel-office/.env"
echo "    • .mcp.json"
echo ""
echo "  查看服務狀態："
echo "    office status"
echo ""
echo "  查看日誌："
echo "    office logs"
echo ""
