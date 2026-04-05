#!/bin/bash
# Claude Code Hook: PostToolUse for task_update
# Logs task completion events to .ai-office/logs/hooks.log

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // empty' 2>/dev/null)
TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // empty' 2>/dev/null)
AGENT_ID=$(echo "$INPUT" | jq -r '.tool_input.agent_id // empty' 2>/dev/null)

if [ "$STATUS" = "completed" ] || [ "$STATUS" = "failed" ]; then
  LOG_DIR="${CLAUDE_PROJECT_DIR:-.}/.ai-office/logs"
  mkdir -p "$LOG_DIR"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] task_update: ${TASK_ID} → ${STATUS} (by ${AGENT_ID})" >> "$LOG_DIR/hooks.log"
fi

exit 0
