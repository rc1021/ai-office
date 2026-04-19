/**
 * claude-runner.ts — Spawns `claude -p` processes
 *
 * Platform-agnostic: accepts projectDir, mcpConfigPath, and allowedTools
 * as parameters so both discord-bot and slack-bot can use it with their
 * own MCP tool lists.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

// 2-hour absolute cap — safety net for truly hung processes.
// Long-running tasks (multi-step, sub-agents) should not be killed by a wall-clock timer.
const ABSOLUTE_MAX_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface ClaudeRunnerConfig {
  projectDir: string;
  mcpConfigPath: string;
  allowedTools: string[];
  model?: string;
  systemPrompt?: string;    // if set, passed via --system-prompt (static, cached portion of the prompt)
  resumeSessionId?: string; // if set, pass --resume <id> to claude
  timeoutMs?: number;       // if set, cap is min(timeoutMs, ABSOLUTE_MAX_TIMEOUT_MS)
  onToolUse?: (toolName: string) => void; // called each time a tool_use event is seen
}

export interface ClaudeRunResult {
  output: string;    // the assistant's text response
  sessionId: string; // session UUID from claude's JSON output (empty string if unavailable)
}

export function runClaude(prompt: string, config: ClaudeRunnerConfig): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
      "--dangerously-skip-permissions",
    ];

    if (config.systemPrompt) {
      args.push("--system-prompt", config.systemPrompt);
    }

    if (config.model) {
      args.push("--model", config.model);
    }

    // stream-json emits one JSON event per line in real-time, letting us
    // observe tool calls as they happen. --verbose includes full tool I/O.
    args.push("--output-format", "stream-json");
    args.push("--verbose");

    if (config.resumeSessionId) {
      args.push("--resume", config.resumeSessionId);
    }

    args.push("--allowedTools", ...config.allowedTools);

    // Only pass --mcp-config if the file actually exists
    if (fs.existsSync(config.mcpConfigPath)) {
      args.push("--mcp-config", config.mcpConfigPath);
    } else {
      console.warn("[ClaudeRunner] .mcp.json not found at", config.mcpConfigPath, "— running without MCP tools");
    }

    if (config.systemPrompt) {
      console.log("[ClaudeRunner] System prompt (static):", config.systemPrompt.substring(0, 60) + "…");
    }
    console.log("[ClaudeRunner] Spawning claude with prompt:", prompt.substring(0, 80));

    const proc = spawn("claude", args, {
      cwd: config.projectDir,
      env: {
        ...process.env,
        // Propagate resume session ID so the MCP server (index.js) can append
        // a short session ID footer to Discord messages for easy --resume reference.
        ...(config.resumeSessionId ? { AI_OFFICE_SESSION_ID: config.resumeSessionId } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";   // partial line buffer
    let finalResult = ""; // from type=result event
    let finalSessionId = "";
    let stderrOutput = "";
    let timedOut = false;

    // Always enforce absolute cap; caller may pass a shorter timeoutMs (e.g. heartbeat audit).
    const effectiveTimeout = config.timeoutMs && config.timeoutMs > 0
      ? Math.min(config.timeoutMs, ABSOLUTE_MAX_TIMEOUT_MS)
      : ABSOLUTE_MAX_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const timeoutSec = Math.round(effectiveTimeout / 1000);
      console.error(`[ClaudeRunner] Timeout after ${timeoutSec}s — killing claude process`);
      proc.kill("SIGTERM");
      // Force-kill after a further 5 s if SIGTERM is ignored
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000).unref();
    }, effectiveTimeout);

    proc.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      // Process all complete lines
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? ""; // keep incomplete last chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          // Extract final result + session_id
          if (event.type === "result") {
            finalResult = typeof event.result === "string" ? event.result : "";
            finalSessionId = typeof event.session_id === "string" ? event.session_id : "";
          }
          // Fire onToolUse callback for tool_use events inside assistant messages
          if (event.type === "assistant" && config.onToolUse) {
            const content: unknown[] = event.message?.content ?? [];
            for (const block of content) {
              if (
                typeof block === "object" && block !== null &&
                (block as Record<string, unknown>).type === "tool_use"
              ) {
                const name = (block as Record<string, unknown>).name;
                if (typeof name === "string") config.onToolUse(name);
              }
            }
          }
        } catch {
          // Non-JSON line (shouldn't happen with stream-json, but be safe)
          console.error("[ClaudeRunner] Failed to parse stream line:", trimmed.substring(0, 100));
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrOutput += chunk;
      console.error("[Claude]", chunk.trimEnd());
    });

    proc.on("error", (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutHandle);

      if (timedOut) {
        const timeoutSec = Math.round(effectiveTimeout / 1000);
        reject(new Error(`TIMEOUT: claude process did not complete within ${timeoutSec}s`));
        return;
      }

      if (code === 0) {
        resolve({ output: finalResult, sessionId: finalSessionId });
      } else {
        const isAuthError = /auth|login|401|unauthorized|unauthenticated|token|credential/i.test(stderrOutput);
        if (isAuthError) {
          reject(new Error(`AUTH_EXPIRED: Claude authentication expired. Please run \`claude auth login\` (or /login in Discord) to re-authenticate.\nstderr: ${stderrOutput.slice(-500)}`));
        } else {
          reject(
            new Error(
              `claude exited with code ${code}. stderr: ${stderrOutput.slice(-500)}`
            )
          );
        }
      }
    });
  });
}
