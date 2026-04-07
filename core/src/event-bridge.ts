/**
 * event-bridge.ts — Polls coordination DB and routes events to chat channels
 *
 * Platform-agnostic: uses ChatAdapter to send messages.
 * Opens coordination.db (SQLite WAL mode) and polls for new events every 3 seconds.
 * Also polls audit_log and batches entries to #audit-log.
 */

import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import type { ChatAdapter } from "./chat-adapter.js";
import { COLORS } from "./types.js";
import type { EmbedInput } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface EventRow {
  id: number;
  type: string;
  source_agent: string;
  target_agents: string | null;
  payload: string;
  trace_id: string | null;
  created_at: string;
  processed: number;
}

interface AuditRow {
  id: number;
  timestamp: string;
  agent_id: string;
  trace_id: string | null;
  action: string;
  detail: string | null;
}

interface AgentRow {
  agent_id: string;
  role_id: string;
  department: string;
  status: string;
  current_task_id: string | null;
}

// ── EventBridge ──────────────────────────────────────────────────────────────

export class EventBridge {
  private dbPath: string;
  private db: Database.Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private auditTimer: ReturnType<typeof setInterval> | null = null;
  private taskMessageMap = new Map<string, string>(); // taskId -> chatMessageId
  private lastSeenAuditId = 0;
  private running = false;
  private adapter: ChatAdapter;

  constructor(statePath: string, adapter: ChatAdapter) {
    this.dbPath = path.join(statePath, "coordination.db");
    this.adapter = adapter;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (!fs.existsSync(this.dbPath)) {
      console.log(`[EventBridge] DB not found at ${this.dbPath} — will retry on next poll`);
    }

    // Poll events every 3 seconds
    this.pollTimer = setInterval(() => {
      this.pollEvents().catch((err) =>
        console.error("[EventBridge] Poll error:", err)
      );
    }, 3000);

    // Poll audit_log every 10 seconds
    this.auditTimer = setInterval(() => {
      this.pollAuditLog().catch((err) =>
        console.error("[EventBridge] Audit poll error:", err)
      );
    }, 10000);

    console.log("[EventBridge] Started — polling every 3s");
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.auditTimer) {
      clearInterval(this.auditTimer);
      this.auditTimer = null;
    }
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
    console.log("[EventBridge] Stopped");
  }

  private openDb(): Database.Database | null {
    if (this.db) return this.db;
    if (!fs.existsSync(this.dbPath)) return null;

    try {
      this.db = new Database(this.dbPath, { readonly: false });
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      console.log(`[EventBridge] Opened DB at ${this.dbPath}`);
      return this.db;
    } catch (err) {
      console.warn("[EventBridge] Failed to open DB:", err);
      return null;
    }
  }

  // ── Event Polling ────────────────────────────────────────────────────────

  private async pollEvents(): Promise<void> {
    const db = this.openDb();
    if (!db) return;

    let rows: EventRow[];
    try {
      rows = db.prepare(
        "SELECT id, type, source_agent, target_agents, payload, trace_id, created_at, processed FROM events WHERE processed = 0 ORDER BY id ASC LIMIT 50"
      ).all() as EventRow[];
    } catch {
      // Table may not exist yet
      return;
    }

    if (rows.length === 0) return;

    const markProcessed = db.prepare("UPDATE events SET processed = 1 WHERE id = ?");

    for (const row of rows) {
      try {
        await this.routeEvent(row, db);
        markProcessed.run(row.id);
      } catch (err) {
        console.error(`[EventBridge] Failed to route event ${row.id} (${row.type}):`, err);
        // Don't mark as processed — retry next cycle
      }
    }
  }

  private async routeEvent(event: EventRow, db: Database.Database): Promise<void> {
    const payload = this.parsePayload(event.payload);
    const taskId = payload.task_id ?? payload.taskId ?? "";
    const department = payload.department ?? "";

    switch (event.type) {
      case "task.created": {
        const embed: EmbedInput = {
          title: `New Task: ${payload.title ?? taskId}`,
          description: payload.description ?? "A new task has been created.",
          color: COLORS.BLUE,
          fields: [
            { name: "Task ID", value: taskId || "N/A" },
            { name: "Assigned To", value: payload.assigned_to ?? event.source_agent },
            { name: "Status", value: "CREATED" },
          ],
          footer: `Source: ${event.source_agent}`,
        };
        const msgId = await this.adapter.sendEmbed("task-board", embed);
        if (taskId) this.taskMessageMap.set(taskId, msgId);
        break;
      }

      case "task.completed": {
        await this.editTaskEmbed(taskId, {
          title: `Completed: ${payload.title ?? taskId}`,
          description: payload.summary ?? "Task completed successfully.",
          color: COLORS.GREEN,
          fields: [
            { name: "Task ID", value: taskId || "N/A" },
            { name: "Status", value: "COMPLETED" },
          ],
          footer: `Completed by: ${event.source_agent}`,
        });
        break;
      }

      case "task.failed": {
        await this.editTaskEmbed(taskId, {
          title: `Failed: ${payload.title ?? taskId}`,
          description: payload.error ?? payload.reason ?? "Task failed.",
          color: COLORS.RED,
          fields: [
            { name: "Task ID", value: taskId || "N/A" },
            { name: "Status", value: "FAILED" },
          ],
          footer: `Agent: ${event.source_agent}`,
        });
        // Also alert
        await this.safeSendEmbed("alerts", {
          title: `Task Failed: ${taskId}`,
          description: payload.error ?? payload.reason ?? "Unknown error",
          color: COLORS.RED,
          footer: `Agent: ${event.source_agent}`,
        });
        break;
      }

      case "task.checkpoint": {
        const text = `**Checkpoint** [${event.source_agent}] ${payload.message ?? payload.detail ?? JSON.stringify(payload)}`;
        await this.safeSendMessage("ai-internal", text);
        // Also post to department channel if it exists (dept channels are optional)
        const dept = department || await this.lookupAgentDepartment(event.source_agent, db);
        if (dept) {
          await this.trySendToDeptChannel(dept, text);
        }
        break;
      }

      case "artifact.published": {
        const text = `**Artifact Published** by ${event.source_agent}: ${payload.name ?? payload.artifact_id ?? "unnamed"}\n${payload.description ?? ""}`;
        await this.safeSendMessage("ai-internal", text);
        break;
      }

      case "agent.online": {
        const text = `**Agent Online**: ${event.source_agent}`;
        await this.safeSendMessage("bot-status", text);
        await this.safeSendEmbed("config", {
          title: `Agent Online: ${event.source_agent}`,
          description: `Role: ${payload.role_id ?? "unknown"}\nDepartment: ${payload.department ?? "unknown"}`,
          color: COLORS.GREEN,
          footer: new Date().toISOString(),
        });
        break;
      }

      case "agent.offline": {
        const text = `**Agent Offline**: ${event.source_agent}`;
        await this.safeSendMessage("bot-status", text);
        await this.safeSendMessage("config", `Agent offline: ${event.source_agent}`);
        break;
      }

      case "anomaly.reported": {
        await this.safeSendEmbed("alerts", {
          title: `Anomaly: ${payload.title ?? "Unknown"}`,
          description: payload.description ?? payload.detail ?? JSON.stringify(payload),
          color: COLORS.RED,
          fields: [
            { name: "Agent", value: event.source_agent },
            { name: "Severity", value: payload.severity ?? "UNKNOWN" },
          ],
          footer: event.trace_id ? `Trace: ${event.trace_id}` : undefined,
        });
        break;
      }

      case "verification.failed": {
        await this.safeSendEmbed("alerts", {
          title: `Verification Failed`,
          description: payload.detail ?? payload.reason ?? JSON.stringify(payload),
          color: COLORS.RED,
          fields: [
            { name: "Agent", value: event.source_agent },
            { name: "Check", value: payload.check_type ?? "unknown" },
          ],
        });
        break;
      }

      default:
        console.log(`[EventBridge] Unknown event type: ${event.type} — skipping`);
    }
  }

  // ── Task embed edit-in-place ─────────────────────────────────────────────

  private async editTaskEmbed(taskId: string, embed: EmbedInput): Promise<void> {
    const existingMsgId = taskId ? this.taskMessageMap.get(taskId) : undefined;

    if (existingMsgId) {
      try {
        await this.adapter.editEmbed("task-board", existingMsgId, embed);
        return;
      } catch {
        // Message may have been deleted — fall through to send new
      }
    }

    // Fallback: send new embed
    const msgId = await this.adapter.sendEmbed("task-board", embed);
    if (taskId) this.taskMessageMap.set(taskId, msgId);
  }

  // ── Audit Log Polling ────────────────────────────────────────────────────

  private async pollAuditLog(): Promise<void> {
    const db = this.openDb();
    if (!db) return;

    let rows: AuditRow[];
    try {
      rows = db.prepare(
        "SELECT id, timestamp, agent_id, trace_id, action, detail FROM audit_log WHERE id > ? ORDER BY id ASC LIMIT 50"
      ).all(this.lastSeenAuditId) as AuditRow[];
    } catch {
      // Table may not exist yet
      return;
    }

    if (rows.length === 0) return;

    // Batch up to 10 entries per message
    const batches: AuditRow[][] = [];
    for (let i = 0; i < rows.length; i += 10) {
      batches.push(rows.slice(i, i + 10));
    }

    for (const batch of batches) {
      const lines = batch.map((r) => {
        const detail = r.detail ? ` — ${r.detail.substring(0, 100)}` : "";
        return `\`${r.timestamp}\` **${r.agent_id}** ${r.action}${detail}`;
      });
      await this.safeSendMessage("audit-log", lines.join("\n"));
    }

    this.lastSeenAuditId = rows[rows.length - 1].id;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private parsePayload(raw: string): Record<string, string> {
    try {
      return JSON.parse(raw) ?? {};
    } catch {
      return { raw };
    }
  }

  private async lookupAgentDepartment(agentId: string, db: Database.Database): Promise<string> {
    try {
      const row = db.prepare(
        "SELECT department FROM agents WHERE agent_id = ?"
      ).get(agentId) as AgentRow | undefined;
      return row?.department ?? "";
    } catch {
      return "";
    }
  }

  // Departments that use fixed channels instead of dept-* channels
  private static readonly SKIP_DEPT_CHANNELS = new Set(["management", "system", "unknown", ""]);

  /**
   * Send to a dept-* channel, auto-creating it if it doesn't exist.
   * Skips departments that use fixed channels (management → #general).
   */
  private async trySendToDeptChannel(dept: string, content: string): Promise<void> {
    if (EventBridge.SKIP_DEPT_CHANNELS.has(dept)) return;

    const channelName = `dept-${dept}`;
    const exists = await this.adapter.channelExists(channelName);
    if (!exists) {
      try {
        const categoryName = `DEPT-${dept.toUpperCase()}`;
        await this.adapter.createCategory(categoryName);
        await this.adapter.createChannel(categoryName, channelName, `${dept} department workspace`);
        console.log(`[EventBridge] Auto-created #${channelName}`);
      } catch (createErr) {
        console.warn(`[EventBridge] Failed to create #${channelName}:`, createErr);
        return;
      }
    }

    try {
      await this.adapter.sendMessage(channelName, content);
    } catch (err) {
      console.warn(`[EventBridge] Failed to send to #${channelName}:`, err);
    }
  }

  private async safeSendMessage(channelName: string, content: string): Promise<void> {
    try {
      await this.adapter.sendMessage(channelName, content);
    } catch (err) {
      console.warn(`[EventBridge] Failed to send to #${channelName}:`, err);
    }
  }

  private async safeSendEmbed(channelName: string, embed: EmbedInput): Promise<void> {
    try {
      await this.adapter.sendEmbed(channelName, embed);
    } catch (err) {
      console.warn(`[EventBridge] Failed to send embed to #${channelName}:`, err);
    }
  }
}
