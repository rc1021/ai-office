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
}

export function runClaude(prompt: string, config: ClaudeRunnerConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
      "--allowedTools", ...config.allowedTools,
    ];

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

    let output = "";
    let stderrOutput = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
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
        resolve(output.trim());
      } else {
        reject(
          new Error(
            `claude exited with code ${code}. stderr: ${stderrOutput.slice(-500)}`
          )
        );
      }
    });
  });
}
