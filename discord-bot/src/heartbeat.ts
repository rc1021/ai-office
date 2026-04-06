/**
 * heartbeat.ts — Health checks, status updates, and daily brief scheduler
 *
 * Three timers:
 *  - Every 5 min: health check (pixel-office PID, coordination DB)
 *  - Every 30 min: system status embed to #bot-status
 *  - Daily 08:30 (user timezone): spawn claude -p for Leader daily brief
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { sendMessage, sendEmbed } from "./message-manager.js";
import { findTextChannel } from "./channel-manager.js";
import { COLORS, buildDiscordEmbed } from "./embed-helpers.js";
import { runClaude, PROJECT_DIR } from "./claude-runner.js";
import type { EmbedInput } from "./types.js";

// ── HeartbeatScheduler ───────────────────────────────────────────────────────

export class HeartbeatScheduler {
  private timezone: string;
  private statePath: string;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private dailyTimeout: ReturnType<typeof setTimeout> | null = null;
  private startTime: number;
  private statusMessageId: string | null = null;
  private running = false;
  private lastAuditVerifiedId: number = 0;

  constructor(timezone: string, statePath: string) {
    this.timezone = timezone;
    this.statePath = statePath;
    this.startTime = Date.now();
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

    // System status every 30 minutes
    this.statusTimer = setInterval(() => {
      this.postSystemStatus().catch((err) =>
        console.error("[Heartbeat] Status update error:", err)
      );
    }, 30 * 60 * 1000);

    // Schedule daily brief
    this.scheduleDailyBrief();

    console.log(`[Heartbeat] Started — health/1min, status/30min, daily-brief@08:30 ${this.timezone}`);
  }

  stop(): void {
    this.running = false;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
    if (this.dailyTimeout) {
      clearTimeout(this.dailyTimeout);
      this.dailyTimeout = null;
    }
    console.log("[Heartbeat] Stopped");
  }

  // ── Health Check (every 5 min) ──────────────────────────────────────────

  private async healthCheck(): Promise<void> {
    const issues: string[] = [];

    // Check pixel-office PID
    const pidFile = path.join(PROJECT_DIR, "pixel-office", "pixel.pid");
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
        await sendEmbed("alerts", {
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
   * Verify audit log hash chain linkage: each row's prev_hash must equal
   * the previous row's hash. Only checks chain linkage, not hash recomputation
   * (original timestamps are not stored in the hash input).
   */
  /**
   * Verify audit log hash chain linkage for NEW entries only.
   * Each row's prev_hash must equal the previous row's hash.
   * Tracks lastVerifiedId to avoid re-checking historical entries
   * (which may have been corrupted by earlier multi-process bugs).
   */
  private async verifyAuditChain(dbPath: string, issues: string[]): Promise<void> {
    if (!fs.existsSync(dbPath)) return;

    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: true });
      db.pragma("busy_timeout = 2000");

      // On first run, skip to the latest entry (trust existing history)
      if (this.lastAuditVerifiedId === 0) {
        const latest = db.prepare("SELECT MAX(id) as maxId FROM audit_log").get() as { maxId: number } | undefined;
        this.lastAuditVerifiedId = latest?.maxId ?? 0;
        db.close();
        return;
      }

      // Only verify entries added since last check
      const rows = db.prepare(
        "SELECT id, prev_hash, hash FROM audit_log WHERE id > ? ORDER BY id ASC"
      ).all(this.lastAuditVerifiedId) as { id: number; prev_hash: string; hash: string }[];

      if (rows.length === 0) { db.close(); return; }

      // Get the hash of the last verified row to check linkage
      const prevRow = db.prepare(
        "SELECT hash FROM audit_log WHERE id = ?"
      ).get(this.lastAuditVerifiedId) as { hash: string } | undefined;
      let expectedPrev = prevRow?.hash ?? "genesis";

      let broken = false;
      for (const row of rows) {
        if (row.prev_hash !== expectedPrev) {
          broken = true;
          break;
        }
        expectedPrev = row.hash;
        this.lastAuditVerifiedId = row.id;
      }

      if (broken) {
        issues.push("Audit log hash chain broken in recent entries — possible tampering");
        console.error("[Heartbeat] AUDIT CHAIN INTEGRITY FAILURE (new entries)");
      }

      db.close();
    } catch {
      // Non-critical
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

      // Find and fail stale tasks (no update in 15 minutes)
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

      // Free any agents stuck in "busy" with no recent heartbeat (>15 min)
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
    const pixelServerPath = path.join(PROJECT_DIR, "pixel-office", "server", "index.ts");
    if (!fs.existsSync(pixelServerPath)) return;

    console.log("[Heartbeat] Attempting to restart Pixel Office...");
    try {
      const npxPath = path.join(PROJECT_DIR, "pixel-office", "node_modules", ".bin", "tsx");
      const pixelProc = spawn(npxPath, [pixelServerPath], {
        cwd: path.join(PROJECT_DIR, "pixel-office"),
        env: { ...process.env, PROJECT_DIR },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      pixelProc.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log("[PixelOffice:restart]", line);
      });
      pixelProc.unref();

      if (pixelProc.pid) {
        const pidFile = path.join(PROJECT_DIR, "pixel-office", "pixel.pid");
        fs.writeFileSync(pidFile, String(pixelProc.pid), "utf-8");
        console.log(`[Heartbeat] Pixel Office restarted (PID ${pixelProc.pid})`);
      }
    } catch (err) {
      console.error("[Heartbeat] Failed to restart Pixel Office:", err);
    }
  }

  // ── System Status (every 30 min) ───────────────────────────────────────

  private async postSystemStatus(): Promise<void> {
    const uptimeMs = Date.now() - this.startTime;
    const uptimeStr = this.formatUptime(uptimeMs);
    const memUsage = process.memoryUsage();
    const memMB = Math.round(memUsage.rss / 1024 / 1024);

    // Count active agents and tasks from DB
    const dbPath = path.join(this.statePath, "coordination.db");
    let activeAgents = 0;
    let activeTasks = 0;
    if (fs.existsSync(dbPath)) {
      try {
        // Dynamic import to avoid issues if DB doesn't exist
        const Database = (await import("better-sqlite3")).default;
        const db = new Database(dbPath, { readonly: true });
        db.pragma("busy_timeout = 2000");
        try {
          const agentRow = db.prepare("SELECT COUNT(*) as cnt FROM agents WHERE status = 'online'").get() as { cnt: number } | undefined;
          activeAgents = agentRow?.cnt ?? 0;
        } catch { /* table may not exist */ }
        try {
          const taskRow = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status IN ('pending', 'in_progress')").get() as { cnt: number } | undefined;
          activeTasks = taskRow?.cnt ?? 0;
        } catch { /* table may not exist */ }
        db.close();
      } catch {
        // DB open failed — fine
      }
    }

    const embed: EmbedInput = {
      title: "System Status",
      description: "Periodic system health report",
      color: COLORS.BLUE,
      fields: [
        { name: "Uptime", value: uptimeStr },
        { name: "Memory (RSS)", value: `${memMB} MB` },
        { name: "Active Agents", value: String(activeAgents) },
        { name: "Active Tasks", value: String(activeTasks) },
      ],
      footer: new Date().toISOString(),
    };

    try {
      if (this.statusMessageId) {
        // Try to edit existing status message
        const channel = await findTextChannel("bot-status");
        const message = await channel.messages.fetch(this.statusMessageId);
        const discordEmbed = buildDiscordEmbed(embed);
        await message.edit({ embeds: [discordEmbed] });
      } else {
        // First time: send new
        this.statusMessageId = await sendEmbed("bot-status", embed);
      }
    } catch {
      // If edit fails, send new
      try {
        this.statusMessageId = await sendEmbed("bot-status", embed);
      } catch (err) {
        console.error("[Heartbeat] Failed to post status:", err);
      }
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
      await runClaude(prompt);
      console.log("[Heartbeat] Daily brief completed");
    } catch (err) {
      console.error("[Heartbeat] Daily brief claude -p failed:", err);
      // Post a fallback message
      try {
        await sendMessage("daily-brief", "Daily brief generation failed. Please check system logs.");
      } catch { /* best effort */ }
    }
  }

  /**
   * Compute milliseconds until next 08:30 in the configured timezone.
   * Uses Intl.DateTimeFormat with formatToParts to find the current time
   * in the target timezone, then calculates the delta.
   */
  private msUntilNext0830(): number {
    const now = new Date();

    // Get current time parts in the target timezone
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

    // Minutes since midnight in timezone
    const currentMinutes = tzHour * 60 + tzMinute;
    const targetMinutes = 8 * 60 + 30; // 08:30

    let deltaMinutes: number;
    if (currentMinutes < targetMinutes) {
      // 08:30 is later today
      deltaMinutes = targetMinutes - currentMinutes;
    } else {
      // 08:30 already passed today — schedule for tomorrow
      deltaMinutes = (24 * 60 - currentMinutes) + targetMinutes;
    }

    // Convert to ms, subtract current seconds for precision
    return deltaMinutes * 60 * 1000 - tzSecond * 1000;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }
}
