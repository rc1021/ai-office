#!/bin/bash
# Claude Code Hook: PostToolUse for report_status
# Logs agent status changes to .ai-office/logs/hooks.log

INPUT=$(cat)

AGENT_ID=$(echo "$INPUT" | jq -r '.tool_input.agent_id // empty' 2>/dev/null)
STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // empty' 2>/dev/null)

if [ -n "$AGENT_ID" ] && [ -n "$STATUS" ]; then
  LOG_DIR="${CLAUDE_PROJECT_DIR:-.}/.ai-office/logs"
  mkdir -p "$LOG_DIR"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] report_status: ${AGENT_ID} → ${STATUS}" >> "$LOG_DIR/hooks.log"
fi

exit 0
