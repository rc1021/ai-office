/**
 * claude-runner.ts — Extracted claude -p spawner
 *
 * Shared by listener.ts (message handling) and heartbeat.ts (daily brief).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Resolve project root ─────────────────────────────────────────────────────

const __filename_runner = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(__filename_runner);
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");
export const PROJECT_DIR = path.resolve(DISCORD_BOT_DIR, "..");
export const MCP_CONFIG = path.join(PROJECT_DIR, ".mcp.json");

// ── Allowed tools for Leader ─────────────────────────────────────────────────

export const ALLOWED_TOOLS = [
  "Agent",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "mcp__ai-office-coordination__report_status",
  "mcp__ai-office-coordination__task_create",
  "mcp__ai-office-coordination__task_update",
  "mcp__ai-office-coordination__task_checkpoint",
  "mcp__ai-office-coordination__task_resume",
  "mcp__ai-office-coordination__task_list",
  "mcp__ai-office-coordination__list_agents",
  "mcp__ai-office-coordination__publish_event",
  "mcp__ai-office-coordination__publish_artifact",
  "mcp__ai-office-coordination__check_inbox",
  "mcp__ai-office-coordination__start_trace",
  "mcp__ai-office-coordination__end_trace",
  "mcp__ai-office-coordination__report_anomaly",
  "mcp__ai-office-coordination__validate_numeric",
  "mcp__ai-office-coordination__cross_verify",
  "mcp__ai-office-coordination__pipeline_gate",
  "mcp__ai-office-discord__setup_server",
  "mcp__ai-office-discord__send_message",
  "mcp__ai-office-discord__send_embed",
  "mcp__ai-office-discord__read_messages",
  "mcp__ai-office-discord__read_new_messages",
  "mcp__ai-office-discord__create_thread",
  "mcp__ai-office-discord__send_thread_message",
  "mcp__ai-office-discord__create_approval",
  "mcp__ai-office-discord__check_approval",
  "mcp__ai-office-discord__register_agent",
  "mcp__ai-office-discord__list_channels",
];

// ── Spawn claude -p ──────────────────────────────────────────────────────────

export function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
      "--allowedTools", ...ALLOWED_TOOLS,
    ];

    // Only pass --mcp-config if the file actually exists
    if (fs.existsSync(MCP_CONFIG)) {
      args.push("--mcp-config", MCP_CONFIG);
    } else {
      console.warn("[ClaudeRunner] .mcp.json not found at", MCP_CONFIG, "— running without MCP tools");
    }

    console.log("[ClaudeRunner] Spawning claude with prompt:", prompt.substring(0, 80));

    const proc = spawn("claude", args, {
      cwd: PROJECT_DIR,
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
