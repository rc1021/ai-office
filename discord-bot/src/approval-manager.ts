import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  Client,
} from "discord.js";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import path from "node:path";
import fs from "node:fs";
import { findTextChannel } from "./channel-manager.js";
import { ApprovalRequest, ApprovalStatus, RiskLevel } from "./types.js";
import { getDiscordClient } from "./discord-client.js";

// ── Approval-resolved callback ────────────────────────────────────────────────

type ApprovalResolvedCallback = (approval: ApprovalRequest) => void;
let onApprovalResolved: ApprovalResolvedCallback | null = null;

export function setApprovalResolvedCallback(cb: ApprovalResolvedCallback): void {
  onApprovalResolved = cb;
}

// ── DB singleton (lazy) ───────────────────────────────────────────────────────

// Compute project root from this file's location:
// At runtime: discord-bot/dist/approval-manager.js → project root is ../..
const distDir = path.dirname(new URL(import.meta.url).pathname);
const projectRoot = path.resolve(distDir, "..", "..");
const dbPath = path.join(projectRoot, ".ai-office", "state", "coordination.db");

let approvalDb: Database.Database | null = null;

function getApprovalDb(): Database.Database {
  if (approvalDb) return approvalDb;
  return initApprovalsDb();
}

export function initApprovalsDb(): Database.Database {
  const stateDir = path.join(projectRoot, ".ai-office", "state");
  fs.mkdirSync(stateDir, { recursive: true });

  approvalDb = new Database(dbPath);
  approvalDb.pragma("journal_mode = WAL");
  approvalDb.pragma("busy_timeout = 5000");
  approvalDb.pragma("foreign_keys = ON");

  // Safety net: create the approvals table if it doesn't exist yet
  // (in case coordination MCP hasn't run migration 4 yet)
  approvalDb.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL DEFAULT '',
      task_id TEXT,
      requesting_agent_id TEXT NOT NULL DEFAULT 'leader',
      channel_name TEXT NOT NULL,
      action TEXT NOT NULL,
      description TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('GREEN','YELLOW','RED')),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK(status IN ('PENDING','APPROVED','REJECTED','TIMEOUT','CANCELLED','CONSUMED','SUPERSEDED')),
      timeout_seconds INTEGER NOT NULL DEFAULT 0,
      deadline_at TEXT,
      message_id TEXT,
      idempotency_key TEXT UNIQUE,
      batch_count INTEGER,
      preview_artifact_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_deadline ON approvals(deadline_at) WHERE status = 'PENDING';
    CREATE INDEX IF NOT EXISTS idx_approvals_idempotency ON approvals(idempotency_key);
  `);

  return approvalDb;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateApprovalId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `approval-${timestamp}-${random}`;
}

function getRiskColor(riskLevel: RiskLevel): number {
  switch (riskLevel) {
    case "GREEN":  return 0x57f287;
    case "YELLOW": return 0xfee75c;
    case "RED":    return 0xed4245;
    default:       return 0x5865f2;
  }
}

function getRiskEmoji(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case "GREEN":  return "🟢";
    case "YELLOW": return "🟡";
    case "RED":    return "🔴";
    default:       return "⚪";
  }
}

function buildApprovalEmbed(approval: ApprovalRequest): EmbedBuilder {
  const statusText =
    approval.status === "PENDING"
      ? "⏳ Awaiting Decision"
      : approval.status === "APPROVED"
      ? "✅ Approved"
      : approval.status === "REJECTED"
      ? "❌ Rejected"
      : approval.status === "TIMEOUT"
      ? "⏫ Timed Out"
      : approval.status === "CANCELLED"
      ? "🚫 Cancelled"
      : approval.status === "CONSUMED"
      ? "📦 Consumed"
      : approval.status === "SUPERSEDED"
      ? "🔄 Superseded"
      : approval.status;

  const embed = new EmbedBuilder()
    .setTitle(`${getRiskEmoji(approval.riskLevel)} Approval Request`)
    .setColor(getRiskColor(approval.riskLevel))
    .addFields(
      { name: "Action", value: approval.action, inline: false },
      { name: "Description", value: approval.description, inline: false },
      { name: "Risk Level", value: `${getRiskEmoji(approval.riskLevel)} ${approval.riskLevel}`, inline: true },
      { name: "Status", value: statusText, inline: true },
      { name: "Approval ID", value: `\`${approval.id}\``, inline: false }
    )
    .setTimestamp(approval.createdAt)
    .setFooter({ text: "AI Office Approval System" });

  if (approval.resolvedAt && approval.resolvedBy) {
    embed.addFields({
      name: "Resolved By",
      value: `<@${approval.resolvedBy}> at ${approval.resolvedAt.toISOString()}`,
      inline: false,
    });
  }

  return embed;
}

function buildApprovalButtons(
  approvalId: string,
  disabled: boolean = false
): ActionRowBuilder<ButtonBuilder> {
  const approveBtn = new ButtonBuilder()
    .setCustomId(`approval:approve:${approvalId}`)
    .setLabel("Approve")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  const rejectBtn = new ButtonBuilder()
    .setCustomId(`approval:reject:${approvalId}`)
    .setLabel("Reject")
    .setEmoji("❌")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  const previewBtn = new ButtonBuilder()
    .setCustomId(`approval:preview:${approvalId}`)
    .setLabel("Preview")
    .setEmoji("👁")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  return new ActionRowBuilder<ButtonBuilder>().addComponents(approveBtn, rejectBtn, previewBtn);
}

// ── Row → ApprovalRequest mapper ──────────────────────────────────────────────

interface ApprovalRow {
  id: string;
  trace_id: string;
  task_id: string | null;
  requesting_agent_id: string;
  channel_name: string;
  action: string;
  description: string;
  risk_level: string;
  status: string;
  timeout_seconds: number;
  deadline_at: string | null;
  message_id: string | null;
  idempotency_key: string | null;
  batch_count: number | null;
  preview_artifact_path: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function rowToApproval(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    channelName: row.channel_name,
    action: row.action,
    description: row.description,
    riskLevel: row.risk_level as RiskLevel,
    status: row.status as ApprovalStatus,
    messageId: row.message_id,
    createdAt: new Date(row.created_at),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    resolvedBy: row.resolved_by,
    traceId: row.trace_id,
    taskId: row.task_id,
    requestingAgentId: row.requesting_agent_id,
    timeoutSeconds: row.timeout_seconds,
    deadlineAt: row.deadline_at ? new Date(row.deadline_at) : null,
    idempotencyKey: row.idempotency_key,
    batchCount: row.batch_count,
    previewArtifactPath: row.preview_artifact_path ?? null,
  };
}

// ── Atomic state transition helper ────────────────────────────────────────────

/**
 * Atomically transition an approval from `expectedStatus` to `newStatus`.
 * Returns true if the transition succeeded (changes === 1), false if it was
 * already in a different state (double-click race condition guard).
 */
export function transitionApproval(
  db: Database.Database,
  id: string,
  expectedStatus: ApprovalStatus,
  newStatus: ApprovalStatus,
  resolvedBy?: string
): boolean {
  const result = db
    .prepare(
      `UPDATE approvals
       SET status = ?, resolved_at = datetime('now'), resolved_by = ?
       WHERE id = ? AND status = ?`
    )
    .run(newStatus, resolvedBy ?? null, id, expectedStatus);
  return result.changes === 1;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createApproval(
  channelName: string,
  action: string,
  description: string,
  riskLevel: RiskLevel,
  options?: {
    traceId?: string;
    taskId?: string | null;
    requestingAgentId?: string;
    timeoutSeconds?: number;
    idempotencyKey?: string | null;
    batchCount?: number | null;
    previewArtifactPath?: string | null;
  }
): Promise<ApprovalRequest> {
  const db = getApprovalDb();
  const channel = await findTextChannel(channelName);

  const timeoutSeconds = options?.timeoutSeconds ?? 0;
  const now = new Date();
  const deadlineAt = timeoutSeconds > 0
    ? new Date(now.getTime() + timeoutSeconds * 1000)
    : null;

  const approvalId = generateApprovalId();
  const traceId = options?.traceId ?? "";
  const taskId = options?.taskId ?? null;
  const requestingAgentId = options?.requestingAgentId ?? "leader";
  const idempotencyKey = options?.idempotencyKey ?? null;
  const batchCount = options?.batchCount ?? null;
  const previewArtifactPath = options?.previewArtifactPath ?? null;

  // Idempotency: if a key is provided and already exists, return that approval
  if (idempotencyKey) {
    const existing = db
      .prepare("SELECT * FROM approvals WHERE idempotency_key = ?")
      .get(idempotencyKey) as ApprovalRow | undefined;
    if (existing) {
      console.log(`[ApprovalManager] Idempotency hit: returning existing approval ${existing.id}`);
      return rowToApproval(existing);
    }
  }

  // Insert into DB (no message_id yet)
  db.prepare(`
    INSERT INTO approvals
      (id, trace_id, task_id, requesting_agent_id, channel_name, action, description,
       risk_level, status, timeout_seconds, deadline_at, message_id, idempotency_key, batch_count,
       preview_artifact_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL, ?, ?, ?, datetime('now'))
  `).run(
    approvalId,
    traceId,
    taskId,
    requestingAgentId,
    channelName,
    action,
    description,
    riskLevel,
    timeoutSeconds,
    deadlineAt ? deadlineAt.toISOString() : null,
    idempotencyKey,
    batchCount,
    previewArtifactPath
  );

  const approval: ApprovalRequest = {
    id: approvalId,
    channelName,
    action,
    description,
    riskLevel,
    status: "PENDING",
    messageId: null,
    createdAt: now,
    resolvedAt: null,
    resolvedBy: null,
    traceId,
    taskId,
    requestingAgentId,
    timeoutSeconds,
    deadlineAt,
    idempotencyKey,
    batchCount,
    previewArtifactPath,
  };

  const embed = buildApprovalEmbed(approval);
  const row = buildApprovalButtons(approvalId);

  const message = await channel.send({
    embeds: [embed],
    components: [row],
  });

  // Update message_id now that we have it
  db.prepare("UPDATE approvals SET message_id = ? WHERE id = ?").run(message.id, approvalId);
  approval.messageId = message.id;

  console.log(`[ApprovalManager] Created approval ${approvalId} in #${channelName} (risk: ${riskLevel})`);
  return approval;
}

export function checkApproval(approvalId: string): ApprovalRequest {
  const db = getApprovalDb();
  const row = db
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(approvalId) as ApprovalRow | undefined;
  if (!row) {
    throw new Error(`Approval "${approvalId}" not found.`);
  }
  return rowToApproval(row);
}

export function listApprovals(): ApprovalRequest[] {
  const db = getApprovalDb();
  const rows = db
    .prepare("SELECT * FROM approvals ORDER BY created_at DESC")
    .all() as ApprovalRow[];
  return rows.map(rowToApproval);
}

export async function createBatchApproval(
  channelName: string,
  action: string,
  items: Array<{ id: string; label: string; detail?: string; reversible: boolean }>,
  riskLevel: RiskLevel,
  options?: {
    traceId?: string;
    taskId?: string | null;
    requestingAgentId?: string;
    timeoutSeconds?: number;
    idempotencyKey?: string | null;
    previewTruncateAt?: number;
  }
): Promise<ApprovalRequest> {
  const approvalId = generateApprovalId();
  const stateDir = path.join(projectRoot, ".ai-office", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const previewPath = path.join(stateDir, `batch-preview-${approvalId}.json`);
  fs.writeFileSync(previewPath, JSON.stringify(items, null, 2), "utf-8");

  const truncateAt = options?.previewTruncateAt ?? 10;
  const shown = items.slice(0, truncateAt);
  const remaining = items.length - shown.length;
  const lines = shown.map((item, i) => {
    const detail = item.detail ? ` — ${item.detail}` : "";
    return `${i + 1}. ${item.label}${detail}`;
  });
  if (remaining > 0) {
    lines.push(`...and ${remaining} more (see preview file)`);
  }
  const description = lines.join("\n");

  return createApproval(channelName, action, description, riskLevel, {
    ...options,
    batchCount: items.length,
    previewArtifactPath: previewPath,
  });
}

// ── Timeout sweep ─────────────────────────────────────────────────────────────

/**
 * Find all PENDING approvals that have passed their deadline and transition
 * them to TIMEOUT. Called periodically from the listener daemon.
 */
export function runTimeoutSweep(dbOverride?: Database.Database): void {
  try {
    const db = dbOverride ?? getApprovalDb();
    const expired = db
      .prepare(
        `SELECT * FROM approvals
         WHERE status = 'PENDING'
           AND timeout_seconds > 0
           AND deadline_at IS NOT NULL
           AND deadline_at <= datetime('now')`
      )
      .all() as ApprovalRow[];

    for (const row of expired) {
      const changed = transitionApproval(db, row.id, "PENDING", "TIMEOUT");
      if (changed) {
        console.log(`[ApprovalManager] Timed out approval ${row.id}`);
        // Fire and forget: update Discord message
        updateApprovalMessageById(row.id, row.channel_name, row.message_id).catch((err) => {
          console.warn(`[ApprovalManager] Failed to update timed-out message ${row.message_id}:`, err);
        });
        // Notify callback so leader can react
        if (onApprovalResolved) {
          try {
            onApprovalResolved(rowToApproval({ ...row, status: "TIMEOUT" }));
          } catch (err) {
            console.error("[ApprovalManager] Callback error (timeout):", err);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[ApprovalManager] runTimeoutSweep error:", err);
  }
}

// ── Startup recovery ──────────────────────────────────────────────────────────

/**
 * On daemon restart, fetch all PENDING approvals and re-register their
 * Discord messages so button interactions still work. Also disables buttons
 * for approvals that have already been resolved (status != PENDING) but whose
 * messages were never updated (e.g., daemon crashed mid-update).
 */
export async function recoverPendingApprovals(client: Client): Promise<void> {
  try {
    const db = getApprovalDb();
    const rows = db
      .prepare("SELECT * FROM approvals WHERE status != 'PENDING' AND message_id IS NOT NULL AND resolved_at > datetime('now', '-1 day')")
      .all() as ApprovalRow[];

    let recovered = 0;
    for (const row of rows) {
      try {
        await updateApprovalMessageById(row.id, row.channel_name, row.message_id);
        recovered++;
      } catch {
        // Non-fatal — message may have been deleted
      }
    }
    if (recovered > 0) {
      console.log(`[ApprovalManager] Recovered ${recovered} approval message(s) on startup`);
    }

    // Also run a timeout sweep immediately on startup
    runTimeoutSweep(db);
  } catch (err) {
    console.warn("[ApprovalManager] recoverPendingApprovals error:", err);
  }
}

// ── Discord message update helpers ────────────────────────────────────────────

async function updateApprovalMessageById(
  approvalId: string,
  channelName: string,
  messageId: string | null
): Promise<void> {
  if (!messageId) return;
  try {
    const approval = checkApproval(approvalId);
    const channel = await findTextChannel(channelName);
    const message = await channel.messages.fetch(messageId);
    const embed = buildApprovalEmbed(approval);
    const row = buildApprovalButtons(approvalId, true); // disabled after resolution
    await message.edit({ embeds: [embed], components: [row] });
  } catch (err) {
    console.error(`[ApprovalManager] Failed to update approval message ${messageId}:`, err);
  }
}

// ── Interaction handler registration ─────────────────────────────────────────

/**
 * Register the approval button interaction handler on a Discord client.
 * Can be called with any Client instance — the MCP server's or the listener's.
 * If no client is provided, falls back to the shared singleton.
 */
export function registerApprovalInteractionHandler(externalClient?: Client): void {
  const client = externalClient ?? getDiscordClient();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    if (!customId.startsWith("approval:")) return;

    const parts = customId.split(":");
    if (parts.length < 3) return;

    const [, action, approvalId] = parts;

    // Acknowledge immediately to avoid the 3-second Discord timeout
    try {
      await interaction.deferReply({ ephemeral: action === "preview" });
    } catch (err) {
      console.error("[ApprovalManager] Failed to defer interaction:", err);
      return;
    }

    const db = getApprovalDb();
    const row = db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(approvalId) as ApprovalRow | undefined;

    if (!row) {
      await interaction.editReply({
        content: `Approval \`${approvalId}\` not found or expired.`,
      });
      return;
    }

    if (action === "preview") {
      if (row.preview_artifact_path) {
        try {
          const raw = fs.readFileSync(row.preview_artifact_path, "utf-8");
          const items = JSON.parse(raw) as Array<{ id: string; label: string; detail?: string; reversible: boolean }>;
          const lines = items.map((item, i) => {
            const detail = item.detail ? ` — ${item.detail}` : "";
            return `${i + 1}. ${item.label}${detail}`;
          });
          let content = `**Batch Preview** (${items.length} items total):\n` + lines.join("\n");
          if (content.length > 1800) {
            content = content.slice(0, 1800) + "\n...and more";
          }
          await interaction.editReply({ content });
        } catch {
          await interaction.editReply({
            content:
              `**Preview for Approval \`${approvalId}\`**\n` +
              `**Action:** ${row.action}\n` +
              `**Description:** ${row.description}\n` +
              `**Risk:** ${getRiskEmoji(row.risk_level as RiskLevel)} ${row.risk_level}`,
          });
        }
      } else {
        await interaction.editReply({
          content:
            `**Preview for Approval \`${approvalId}\`**\n` +
            `**Action:** ${row.action}\n` +
            `**Description:** ${row.description}\n` +
            `**Risk:** ${getRiskEmoji(row.risk_level as RiskLevel)} ${row.risk_level}`,
        });
      }
      return;
    }

    if (row.status !== "PENDING") {
      await interaction.editReply({
        content: `This approval has already been ${row.status.toLowerCase()}.`,
      });
      return;
    }

    const newStatus: ApprovalStatus = action === "approve" ? "APPROVED" : "REJECTED";

    // Atomic transition: prevents double-click race condition
    // Only succeeds if approval is still PENDING at the moment of the UPDATE
    const transitioned = transitionApproval(
      db,
      approvalId,
      "PENDING",
      newStatus,
      interaction.user.id  // Discord snowflake user ID (not mutable username)
    );

    if (!transitioned) {
      await interaction.editReply({
        content: `This approval was already resolved by someone else.`,
      });
      return;
    }

    const updatedApproval = checkApproval(approvalId);

    // Notify listener so it can trigger a Leader session to act on the decision
    if (onApprovalResolved) {
      try {
        onApprovalResolved(updatedApproval);
      } catch (err) {
        console.error("[ApprovalManager] Callback error:", err);
      }
    }

    const emoji = newStatus === "APPROVED" ? "✅" : "❌";
    await interaction.editReply({
      content: `${emoji} Approval \`${approvalId}\` has been **${newStatus}** by <@${interaction.user.id}>.`,
    });

    await updateApprovalMessageById(approvalId, row.channel_name, row.message_id);

    console.log(
      `[ApprovalManager] Approval ${approvalId} ${newStatus} by ${interaction.user.id} (${interaction.user.username})`
    );
  });

  console.log("[ApprovalManager] Interaction handler registered.");
}
