/**
 * claude-runner.ts — Spawns `claude -p` processes
 *
 * Platform-agnostic: accepts projectDir, mcpConfigPath, and allowedTools
 * as parameters so both discord-bot and slack-bot can use it with their
 * own MCP tool lists.
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

export interface ClaudeRunnerConfig {
  projectDir: string;
  mcpConfigPath: string;
  allowedTools: string[];
  model?: string;
  resumeSessionId?: string; // if set, pass --resume <id> to claude
}

export interface ClaudeRunResult {
  output: string;    // the assistant's text response
  sessionId: string; // session UUID from claude's JSON output (empty string if unavailable)
}

export function runClaude(prompt: string, config: ClaudeRunnerConfig): Promise<ClaudeRunResult> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
    ];

    if (config.model) {
      args.push("--model", config.model);
    }

    // Always request JSON output so we can extract session_id
    args.push("--output-format", "json");

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

    console.log("[ClaudeRunner] Spawning claude with prompt:", prompt.substring(0, 80));

    const proc = spawn("claude", args, {
      cwd: config.projectDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let rawOutput = "";
    let stderrOutput = "";

    proc.stdout.on("data", (data: Buffer) => {
      rawOutput += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrOutput += chunk;
      console.error("[Claude]", chunk.trimEnd());
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        const trimmed = rawOutput.trim();
        try {
          const parsed = JSON.parse(trimmed);
          resolve({
            output: typeof parsed.result === "string" ? parsed.result : trimmed,
            sessionId: typeof parsed.session_id === "string" ? parsed.session_id : "",
          });
        } catch {
          // JSON parse failed — return raw output with empty sessionId
          resolve({ output: trimmed, sessionId: "" });
        }
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
