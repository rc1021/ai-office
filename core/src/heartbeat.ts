/**
 * heartbeat.ts — Health checks and daily brief scheduler
 *
 * Platform-agnostic: uses ChatAdapter and ClaudeRunnerConfig.
 *
 * Two timers:
 *  - Every 1 min: health check (pixel-office PID, coordination DB, stale task cleanup)
 *  - Daily 08:30 (user timezone): spawn claude -p for Leader daily brief
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChatAdapter } from "./chat-adapter.js";
import { runClaude } from "./claude-runner.js";
import type { ClaudeRunnerConfig } from "./claude-runner.js";
import { COLORS } from "./types.js";

// ── HeartbeatScheduler ───────────────────────────────────────────────────────

export class HeartbeatScheduler {
  private timezone: string;
  private statePath: string;
  private projectDir: string;
  private claudeConfig: ClaudeRunnerConfig;
  private adapter: ChatAdapter;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    timezone: string,
    statePath: string,
    projectDir: string,
    claudeConfig: ClaudeRunnerConfig,
    adapter: ChatAdapter,
  ) {
    this.timezone = timezone;
    this.statePath = statePath;
    this.projectDir = projectDir;
    this.claudeConfig = claudeConfig;
    this.adapter = adapter;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    // Health check every 1 minute (lightweight: PID check + stale task cleanup)
    this.healthTimer = setInterval(() => {
      this.healthCheck().catch((err) =>
        console.error("[Heartbeat] Health check error:", err)
      );
    }, 1 * 60 * 1000);

    // Schedule daily brief
    this.scheduleDailyBrief();

    console.log(`[Heartbeat] Started — health/1min, daily-brief@08:30 ${this.timezone}`);
  }

  stop(): void {
    this.running = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.dailyTimeout) {
      clearTimeout(this.dailyTimeout);
      this.dailyTimeout = null;
    }
    console.log("[Heartbeat] Stopped");
  }

  // ── Health Check (every 1 min) ──────────────────────────────────────────

  private async healthCheck(): Promise<void> {
    const issues: string[] = [];

    // Check pixel-office PID
    const pidFile = path.join(this.projectDir, "pixel-office", "pixel.pid");
    if (fs.existsSync(pidFile)) {
      try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        process.kill(pid, 0); // Test if process exists
      } catch {
        issues.push("Pixel Office process is dead");
        // Attempt auto-restart
        this.restartPixelOffice();
      }
    }

    // Check coordination DB accessible
    const dbPath = path.join(this.statePath, "coordination.db");
    if (fs.existsSync(dbPath)) {
      try {
        // Quick read test — just check the file is readable
        fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        issues.push("Coordination DB is inaccessible");
      }
    }

    // Clean up stale tasks and agents (stuck for >10 minutes)
    await this.cleanupStaleTasks(issues);

    // Only alert on failure
    if (issues.length > 0) {
      try {
        await this.adapter.sendEmbed("alerts", {
          title: "Health Check Alert",
          description: issues.join("\n"),
          color: COLORS.RED,
          footer: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[Heartbeat] Failed to post health alert:", err);
      }
    }
  }

  /**
   * Detect tasks stuck in active states for >10 minutes and mark them failed.
   * Free any agents that are stuck in "busy" with stale heartbeats.
   */
  private async cleanupStaleTasks(issues: string[]): Promise<void> {
    const dbPath = path.join(this.statePath, "coordination.db");
    if (!fs.existsSync(dbPath)) return;

    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: false });
      db.pragma("busy_timeout = 5000");

      // Find and fail stale tasks (no update in 10 minutes)
      const staleTasks = db.prepare(`
        SELECT id, title, assigned_to FROM tasks
        WHERE status IN ('assigned', 'in_progress', 'checkpoint')
        AND updated_at < datetime('now', '-10 minutes')
      `).all() as { id: string; title: string; assigned_to: string | null }[];

      if (staleTasks.length > 0) {
        const failStmt = db.prepare(
          "UPDATE tasks SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
        );
        const freeAgentStmt = db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL WHERE agent_id = ? AND current_task_id = ?"
        );

        for (const task of staleTasks) {
          failStmt.run(task.id);
          if (task.assigned_to) {
            freeAgentStmt.run(task.assigned_to, task.id);
          }
          console.log(`[Heartbeat] Marked stale task as failed: "${task.title}" (${task.id})`);
        }

        issues.push(`${staleTasks.length} stale task(s) marked as failed: ${staleTasks.map(t => t.title).join(", ")}`);
      }

      // Free any agents stuck in "busy" with no recent heartbeat (>10 min)
      const staleAgents = db.prepare(`
        SELECT agent_id FROM agents
        WHERE status = 'busy'
        AND last_heartbeat < datetime('now', '-10 minutes')
        AND (current_task_id IS NULL OR current_task_id NOT IN (
          SELECT id FROM tasks WHERE status IN ('assigned', 'in_progress', 'checkpoint')
        ))
      `).all() as { agent_id: string }[];

      if (staleAgents.length > 0) {
        const freeStmt = db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL WHERE agent_id = ?"
        );
        for (const agent of staleAgents) {
          freeStmt.run(agent.agent_id);
          console.log(`[Heartbeat] Freed stale agent: ${agent.agent_id}`);
        }
        issues.push(`${staleAgents.length} stale agent(s) freed: ${staleAgents.map(a => a.agent_id).join(", ")}`);
      }

      db.close();
    } catch (err) {
      console.error("[Heartbeat] Stale cleanup error:", err);
    }
  }

  private restartPixelOffice(): void {
    const pixelServerPath = path.join(this.projectDir, "pixel-office", "server", "index.ts");
    if (!fs.existsSync(pixelServerPath)) return;

    console.log("[Heartbeat] Attempting to restart Pixel Office...");
    try {
      const npxPath = path.join(this.projectDir, "pixel-office", "node_modules", ".bin", "tsx");
      const pixelProc = spawn(npxPath, [pixelServerPath], {
        cwd: path.join(this.projectDir, "pixel-office"),
        env: { ...process.env, PROJECT_DIR: this.projectDir },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      pixelProc.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log("[PixelOffice:restart]", line);
      });
      pixelProc.unref();

      if (pixelProc.pid) {
        const pidFile = path.join(this.projectDir, "pixel-office", "pixel.pid");
        fs.writeFileSync(pidFile, String(pixelProc.pid), "utf-8");
        console.log(`[Heartbeat] Pixel Office restarted (PID ${pixelProc.pid})`);
      }
    } catch (err) {
      console.error("[Heartbeat] Failed to restart Pixel Office:", err);
    }
  }

  // ── Daily Brief (08:30 in user timezone) ────────────────────────────────

  private scheduleDailyBrief(): void {
    const msUntil = this.msUntilNext0830();
    console.log(`[Heartbeat] Next daily brief in ${Math.round(msUntil / 60000)} minutes`);

    this.dailyTimeout = setTimeout(async () => {
      if (!this.running) return;

      console.log("[Heartbeat] Running daily brief...");
      try {
        await this.runDailyBrief();
      } catch (err) {
        console.error("[Heartbeat] Daily brief failed:", err);
      }

      // Re-schedule for tomorrow
      if (this.running) {
        this.scheduleDailyBrief();
      }
    }, msUntil);
  }

  private async runDailyBrief(): Promise<void> {
    const prompt =
      "You are the AI Office Leader. It's time for the daily brief.\n" +
      "Use the task_list MCP tool to see all current tasks.\n" +
      "Use the list_agents MCP tool to see who is online.\n" +
      "Then use send_embed MCP tool to post a summary to #daily-brief.\n" +
      "Include: completed tasks (last 24h), in-progress tasks, any blockers, agent status.\n" +
      "Keep it concise and actionable. Use zh-TW language.";

    try {
      await runClaude(prompt, this.claudeConfig);
      console.log("[Heartbeat] Daily brief completed");
    } catch (err) {
      console.error("[Heartbeat] Daily brief claude -p failed:", err);
      // Post a fallback message
      try {
        await this.adapter.sendMessage("daily-brief", "Daily brief generation failed. Please check system logs.");
      } catch { /* best effort */ }
    }
  }

  /**
   * Compute milliseconds until next 08:30 in the configured timezone.
   */
  private msUntilNext0830(): number {
    const now = new Date();

    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const get = (type: string): number => {
      const p = parts.find((p) => p.type === type);
      return p ? parseInt(p.value, 10) : 0;
    };

    const tzHour = get("hour");
    const tzMinute = get("minute");
    const tzSecond = get("second");

    const currentMinutes = tzHour * 60 + tzMinute;
    const targetMinutes = 8 * 60 + 30; // 08:30

    let deltaMinutes: number;
    if (currentMinutes < targetMinutes) {
      deltaMinutes = targetMinutes - currentMinutes;
    } else {
      deltaMinutes = (24 * 60 - currentMinutes) + targetMinutes;
    }

    return deltaMinutes * 60 * 1000 - tzSecond * 1000;
  }

}
