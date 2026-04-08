/**
 * heartbeat.ts — Health checks and daily brief scheduler
 *
 * Platform-agnostic: uses ChatAdapter and ClaudeRunnerConfig.
 *
 * Two timers:
 *  - Every 1 min: health check (pixel-office PID, coordination DB, stale task cleanup)
 *  - Daily brief (default 08:00, configurable): spawn claude -p for Leader daily brief
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import type { ChatAdapter } from "./chat-adapter.js";
import { runClaude } from "./claude-runner.js";
import type { ClaudeRunnerConfig } from "./claude-runner.js";
import type { AuditConfig } from "./config-loader.js";
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
  private dailyBriefHour: number;
  private dailyBriefMinute: number;
  private auditConfig: AuditConfig;
  private auditingTaskIds = new Set<string>(); // prevent double-audit
  private lastAlertHashes = new Map<string, number>(); // hash → timestamp for cooldown
  private restarting = false; // guard flag: skip health check during restart
  private static ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    timezone: string,
    statePath: string,
    projectDir: string,
    claudeConfig: ClaudeRunnerConfig,
    adapter: ChatAdapter,
    dailyBriefTime: string = "08:00",
    auditConfig: AuditConfig = { autoReview: false, riskThreshold: "YELLOW" },
  ) {
    this.timezone = timezone;
    this.statePath = statePath;
    this.projectDir = projectDir;
    this.claudeConfig = claudeConfig;
    this.adapter = adapter;
    const [h, m] = dailyBriefTime.split(":").map(Number);
    this.dailyBriefHour = h;
    this.dailyBriefMinute = m;
    this.auditConfig = auditConfig;
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

    const timeStr = `${String(this.dailyBriefHour).padStart(2, "0")}:${String(this.dailyBriefMinute).padStart(2, "0")}`;
    console.log(`[Heartbeat] Started — health/1min, daily-brief@${timeStr} ${this.timezone}`);
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
    const criticalIssues: { icon: string; label: string; detail: string }[] = [];
    const routineActions: { icon: string; label: string; detail: string }[] = [];

    // Check pixel-office: PID file first, then HTTP fallback
    // Skip during active restart to avoid false alarms in the gap window
    const pidFile = path.join(this.projectDir, "pixel-office", "pixel.pid");
    if (this.restarting) {
      console.log("[Heartbeat] Pixel Office restart in progress — skipping health check");
    } else if (fs.existsSync(pidFile)) {
      let pidAlive = false;
      try {
        const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
        process.kill(pid, 0); // Test if process exists
        pidAlive = true;
      } catch {
        // PID dead — but server might still be running under a different PID
      }

      if (!pidAlive) {
        // HTTP health check as fallback before declaring dead
        const serverAlive = await this.checkPixelOfficeHttp();
        if (!serverAlive) {
          criticalIssues.push({
            icon: "🖥️", label: "視覺化儀表板離線",
            detail: "Pixel Office 程序已停止，正在嘗試重新啟動",
          });
          this.restartPixelOffice();
        } else {
          // Server is alive but PID file is stale — find real PID and update
          await this.fixStalePidFile(pidFile);
        }
      }
    }

    // Check coordination DB accessible
    const dbPath = path.join(this.statePath, "coordination.db");
    if (fs.existsSync(dbPath)) {
      try {
        // Quick read test — just check the file is readable
        fs.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
      } catch {
        criticalIssues.push({
          icon: "🗄️", label: "協調資料庫無法存取",
          detail: "coordination.db 無法讀寫，任務系統可能受影響",
        });
      }
    }

    // Clean up stale tasks and agents (stuck for >10 minutes)
    await this.cleanupStaleTasks(criticalIssues, routineActions);

    // Auto-audit completed tasks (if enabled)
    if (this.auditConfig.autoReview) {
      await this.checkPendingAudits();
    }

    // Only send alerts for critical issues (with cooldown to prevent spam)
    if (criticalIssues.length > 0) {
      const alertKey = criticalIssues.map(i => i.label).sort().join("|");
      if (!this.isAlertOnCooldown(alertKey)) {
        const fields = criticalIssues.map(i => `${i.icon} **${i.label}**\n${i.detail}`);
        if (routineActions.length > 0) {
          fields.push(
            "🔧 **自動處理**\n" +
            routineActions.map(a => `• ${a.detail}`).join("\n")
          );
        }
        try {
          await this.adapter.sendEmbed("alerts", {
            title: "⚠️ 系統健康檢查警報",
            description: fields.join("\n\n"),
            color: COLORS.YELLOW,
            footer: new Date().toLocaleString("zh-TW", { timeZone: this.timezone }),
          });
          this.markAlertSent(alertKey);
        } catch (err) {
          console.error("[Heartbeat] Failed to post health alert:", err);
        }
      }
    }

    // Log routine actions to console only (not Discord) to reduce noise
    if (routineActions.length > 0 && criticalIssues.length === 0) {
      for (const a of routineActions) {
        console.log(`[Heartbeat] ${a.label}: ${a.detail}`);
      }
    }
  }

  /** Check if a specific alert type is still within cooldown period */
  private isAlertOnCooldown(key: string): boolean {
    const lastSent = this.lastAlertHashes.get(key);
    if (!lastSent) return false;
    return Date.now() - lastSent < HeartbeatScheduler.ALERT_COOLDOWN_MS;
  }

  private markAlertSent(key: string): void {
    this.lastAlertHashes.set(key, Date.now());
    // Prune old entries
    const cutoff = Date.now() - HeartbeatScheduler.ALERT_COOLDOWN_MS;
    for (const [k, ts] of this.lastAlertHashes) {
      if (ts < cutoff) this.lastAlertHashes.delete(k);
    }
  }

  /**
   * Detect tasks stuck in active states for >10 minutes and mark them failed.
   * Free any agents that are stuck in "busy" with stale heartbeats.
   */
  private async cleanupStaleTasks(
    criticalIssues: { icon: string; label: string; detail: string }[],
    routineActions: { icon: string; label: string; detail: string }[],
  ): Promise<void> {
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
        const autoCompleteStmt = db.prepare(
          "UPDATE tasks SET status = 'completed', updated_at = datetime('now') WHERE id = ?"
        );
        const freeAgentStmt = db.prepare(
          "UPDATE agents SET status = 'idle', current_task_id = NULL WHERE agent_id = ? AND current_task_id = ?"
        );
        const getAgentStatus = db.prepare(
          "SELECT status FROM agents WHERE agent_id = ?"
        );

        const failedTasks: string[] = [];
        const autoCompletedTasks: string[] = [];

        for (const task of staleTasks) {
          // Safety net: if the assigned agent is already idle, the worker likely
          // finished its work but forgot to call task_update(completed).
          // Auto-complete instead of marking failed to avoid false alarms.
          let agentIsIdle = false;
          if (task.assigned_to) {
            const agent = getAgentStatus.get(task.assigned_to) as { status: string } | undefined;
            agentIsIdle = agent?.status === "idle";
          }

          if (agentIsIdle) {
            autoCompleteStmt.run(task.id);
            if (task.assigned_to) {
              freeAgentStmt.run(task.assigned_to, task.id);
            }
            autoCompletedTasks.push(task.title);
            console.log(`[Heartbeat] Auto-completed stale task (agent idle): "${task.title}" (${task.id})`);
          } else {
            failStmt.run(task.id);
            if (task.assigned_to) {
              freeAgentStmt.run(task.assigned_to, task.id);
            }
            failedTasks.push(task.title);
            console.log(`[Heartbeat] Marked stale task as failed: "${task.title}" (${task.id})`);
          }
        }

        if (autoCompletedTasks.length > 0) {
          routineActions.push({
            icon: "✅", label: "逾時任務自動完成",
            detail: `${autoCompletedTasks.length} 個閒置任務已自動結案：${autoCompletedTasks.join("、")}`,
          });
        }
        if (failedTasks.length > 0) {
          criticalIssues.push({
            icon: "❌", label: "任務逾時失敗",
            detail: `${failedTasks.length} 個任務超過 10 分鐘無回應，已標記失敗：${failedTasks.join("、")}`,
          });
        }
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
        routineActions.push({
          icon: "👤", label: "閒置代理已釋放",
          detail: `${staleAgents.length} 個代理超時已重設為閒置：${staleAgents.map(a => a.agent_id).join("、")}`,
        });
      }

      db.close();
    } catch (err) {
      console.error("[Heartbeat] Stale cleanup error:", err);
    }
  }

  /**
   * Check for completed tasks that need audit review.
   * Spawns internal-auditor via claude -p for each unaudited task.
   */
  private async checkPendingAudits(): Promise<void> {
    const dbPath = path.join(this.statePath, "coordination.db");
    if (!fs.existsSync(dbPath)) return;

    try {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(dbPath, { readonly: false });
      db.pragma("busy_timeout = 5000");

      // Check if internal-auditor is hired
      const auditor = db.prepare(
        "SELECT agent_id FROM agents WHERE role_id = 'internal-auditor'"
      ).get() as { agent_id: string } | undefined;

      if (!auditor) { db.close(); return; }

      // Risk level ordering for threshold comparison
      const riskOrder: Record<string, number> = { GREEN: 0, YELLOW: 1, RED: 2 };
      const threshold = riskOrder[this.auditConfig.riskThreshold] ?? 1;

      // Find completed tasks without audit_status that meet risk threshold
      const tasks = db.prepare(`
        SELECT id, title, risk_level, output_artifact, assigned_to
        FROM tasks
        WHERE status = 'completed'
        AND (audit_status IS NULL OR audit_status = '')
        AND updated_at > datetime('now', '-24 hours')
        LIMIT 3
      `).all() as {
        id: string; title: string; risk_level: string | null;
        output_artifact: string | null; assigned_to: string | null;
      }[];

      for (const task of tasks) {
        // Skip if below risk threshold
        const taskRisk = riskOrder[task.risk_level ?? "GREEN"] ?? 0;
        if (taskRisk < threshold) {
          db.prepare("UPDATE tasks SET audit_status = 'skipped' WHERE id = ?").run(task.id);
          continue;
        }

        // Skip if already auditing
        if (this.auditingTaskIds.has(task.id)) continue;
        this.auditingTaskIds.add(task.id);

        // Mark as auditing
        db.prepare("UPDATE tasks SET audit_status = 'auditing' WHERE id = ?").run(task.id);

        console.log(`[Heartbeat] Spawning audit for task: "${task.title}" (${task.id})`);

        // Spawn auditor — fire and forget (don't block health check)
        this.runAudit(task.id, task.title, task.output_artifact, task.assigned_to)
          .then((passed) => {
            try {
              const db2 = new Database(dbPath, { readonly: false });
              db2.pragma("busy_timeout = 5000");
              db2.prepare("UPDATE tasks SET audit_status = ? WHERE id = ?")
                .run(passed ? "passed" : "failed", task.id);
              db2.close();
            } catch { /* best effort */ }
            this.auditingTaskIds.delete(task.id);
            console.log(`[Heartbeat] Audit ${passed ? "passed" : "failed"}: "${task.title}"`);
          })
          .catch((err) => {
            console.error(`[Heartbeat] Audit error for "${task.title}":`, err);
            this.auditingTaskIds.delete(task.id);
          });
      }

      db.close();
    } catch (err) {
      console.error("[Heartbeat] Audit check error:", err);
    }
  }

  private async runAudit(
    taskId: string, title: string,
    outputArtifact: string | null, assignedTo: string | null,
  ): Promise<boolean> {
    const prompt =
      "You are the Internal Auditor (role: internal-auditor). " +
      "Review the following completed task for correctness and quality.\n\n" +
      `Task ID: ${taskId}\n` +
      `Title: ${title}\n` +
      `Completed by: ${assignedTo ?? "unknown"}\n` +
      (outputArtifact ? `Output artifact: ${outputArtifact}\n` : "") +
      "\nAudit checklist:\n" +
      "1. Numerical correctness — were numbers validated?\n" +
      "2. Source citations — are conclusions backed by evidence?\n" +
      "3. Completeness — does the output address all requirements?\n" +
      "4. Security — any sensitive data leakage or vulnerabilities?\n\n" +
      "If the output artifact exists, Read it and review its contents.\n" +
      "Call task_list to see the full task details.\n\n" +
      "After review, call publish_event with:\n" +
      "- type: 'audit.passed' if all checks pass\n" +
      "- type: 'audit.failed' + call report_anomaly if any check fails\n" +
      "Return PASS or FAIL as your final output.";

    try {
      const output = await runClaude(prompt, this.claudeConfig);
      return output.toUpperCase().includes("PASS");
    } catch {
      return false;
    }
  }

  /**
   * Find the real PID listening on port 3847 and update the stale PID file.
   */
  private async fixStalePidFile(pidFile: string): Promise<void> {
    try {
      const output = execSync("lsof -ti :3847", { encoding: "utf-8", timeout: 5000 }).trim();
      if (output) {
        const realPid = output.split("\n")[0].trim();
        fs.writeFileSync(pidFile, realPid, "utf-8");
        console.log(`[Heartbeat] Updated stale PID file → ${realPid}`);
      }
    } catch {
      // lsof failed — server might use a different method; just log
      console.log("[Heartbeat] Pixel Office HTTP alive but could not resolve PID — skipping PID update");
    }
  }

  private async checkPixelOfficeHttp(): Promise<boolean> {
    try {
      const resp = await fetch("http://localhost:3847/api/status", { signal: AbortSignal.timeout(3000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private restartPixelOffice(): void {
    const pixelServerPath = path.join(this.projectDir, "pixel-office", "server", "index.ts");
    if (!fs.existsSync(pixelServerPath)) return;

    this.restarting = true;
    console.log("[Heartbeat] Attempting to restart Pixel Office...");

    try {
      // Step 1: Kill ALL existing processes on port 3847 to prevent zombie accumulation
      this.killProcessesOnPort(3847);

      // Step 2: Remove stale PID file
      const pidFile = path.join(this.projectDir, "pixel-office", "pixel.pid");
      try { fs.unlinkSync(pidFile); } catch { /* may not exist */ }

      // Step 3: Spawn new server
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

      // Step 4: Wait for server to be ready, then resolve the REAL PID on the port
      // (tsx wrapper PID ≠ actual node PID listening on the port)
      setTimeout(async () => {
        try {
          const serverReady = await this.checkPixelOfficeHttp();
          if (serverReady) {
            await this.fixStalePidFile(pidFile);
            console.log("[Heartbeat] Pixel Office restarted and verified");
          } else if (pixelProc.pid) {
            // Fallback: write the spawn PID (better than nothing)
            fs.writeFileSync(pidFile, String(pixelProc.pid), "utf-8");
            console.log(`[Heartbeat] Pixel Office spawned (PID ${pixelProc.pid}), but HTTP not yet ready`);
          }
        } catch (err) {
          console.error("[Heartbeat] Post-restart PID resolution failed:", err);
        } finally {
          this.restarting = false;
        }
      }, 5000); // wait 5s for server startup
    } catch (err) {
      this.restarting = false;
      console.error("[Heartbeat] Failed to restart Pixel Office:", err);
    }
  }

  /**
   * Kill all processes listening on a given port.
   * Prevents zombie accumulation from repeated restarts.
   */
  private killProcessesOnPort(port: number): void {
    try {
      const pids = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
      if (pids) {
        const pidList = pids.split("\n").map(p => p.trim()).filter(Boolean);
        for (const pid of pidList) {
          try {
            process.kill(parseInt(pid, 10), "SIGTERM");
            console.log(`[Heartbeat] Killed old process on port ${port}: PID ${pid}`);
          } catch { /* already dead */ }
        }
        // Give processes time to exit gracefully, then force kill survivors
        try {
          execSync("sleep 2", { timeout: 5000 });
          const survivors = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 5000 }).trim();
          if (survivors) {
            for (const pid of survivors.split("\n").map(p => p.trim()).filter(Boolean)) {
              try {
                process.kill(parseInt(pid, 10), "SIGKILL");
                console.log(`[Heartbeat] Force-killed stubborn process: PID ${pid}`);
              } catch { /* already dead */ }
            }
          }
        } catch { /* no survivors or lsof failed — good */ }
      }
    } catch {
      // No processes on port or lsof not available — safe to proceed
    }
  }

  // ── Daily Brief (configurable time in user timezone) ─────────────────────

  private scheduleDailyBrief(): void {
    const msUntil = this.msUntilNextBrief();
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
   * Compute milliseconds until next daily brief time in the configured timezone.
   */
  private msUntilNextBrief(): number {
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
    const targetMinutes = this.dailyBriefHour * 60 + this.dailyBriefMinute;

    let deltaMinutes: number;
    if (currentMinutes < targetMinutes) {
      deltaMinutes = targetMinutes - currentMinutes;
    } else {
      deltaMinutes = (24 * 60 - currentMinutes) + targetMinutes;
    }

    return deltaMinutes * 60 * 1000 - tzSecond * 1000;
  }

}
