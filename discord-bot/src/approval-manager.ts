import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ButtonInteraction,
  Events,
  ComponentType,
  Message,
  Client,
} from "discord.js";
import { randomUUID } from "crypto";
import fs from "node:fs";
import path from "node:path";
import { findTextChannel } from "./channel-manager.js";
import { ApprovalRequest, ApprovalStatus, RiskLevel } from "./types.js";
import { getDiscordClient } from "./discord-client.js";

// ── Approval-resolved callback ────────────────────────────────────────────────

type ApprovalResolvedCallback = (approval: ApprovalRequest) => void;
let onApprovalResolved: ApprovalResolvedCallback | null = null;

export function setApprovalResolvedCallback(cb: ApprovalResolvedCallback): void {
  onApprovalResolved = cb;
}

// ── File-based approval persistence ─────────────────────────────────────────
// Approvals are stored on disk so both the MCP server (transient) and the
// listener daemon (persistent) can access them.

function getApprovalsFilePath(): string {
  // Walk up from this file to find the project root
  // At runtime: discord-bot/dist/approval-manager.js → project root is ../..
  const distDir = path.dirname(new URL(import.meta.url).pathname);
  const projectDir = path.resolve(distDir, "..", "..");
  const stateDir = path.join(projectDir, ".ai-office", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return path.join(stateDir, "approvals.json");
}

interface SerializedApproval {
  id: string;
  channelName: string;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  messageId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

function loadApprovals(): Map<string, ApprovalRequest> {
  const filePath = getApprovalsFilePath();
  if (!fs.existsSync(filePath)) return new Map();
  try {
    const raw: SerializedApproval[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const map = new Map<string, ApprovalRequest>();
    for (const item of raw) {
      map.set(item.id, {
        ...item,
        createdAt: new Date(item.createdAt),
        resolvedAt: item.resolvedAt ? new Date(item.resolvedAt) : null,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

function saveApprovals(approvals: Map<string, ApprovalRequest>): void {
  const filePath = getApprovalsFilePath();
  const arr: SerializedApproval[] = Array.from(approvals.values()).map((a) => ({
    ...a,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt ? a.resolvedAt.toISOString() : null,
  }));
  // Keep only the last 100 approvals to avoid unbounded growth
  const trimmed = arr.slice(-100);
  fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), "utf-8");
}

function generateApprovalId(): string {
  return `approval-${randomUUID()}`;
}

function getRiskColor(riskLevel: RiskLevel): number {
  switch (riskLevel) {
    case "GREEN":
      return 0x57f287; // Green
    case "YELLOW":
      return 0xfee75c; // Yellow
    case "RED":
      return 0xed4245; // Red
    default:
      return 0x5865f2;
  }
}

function getRiskEmoji(riskLevel: RiskLevel): string {
  switch (riskLevel) {
    case "GREEN":
      return "🟢";
    case "YELLOW":
      return "🟡";
    case "RED":
      return "🔴";
    default:
      return "⚪";
  }
}

function buildApprovalEmbed(approval: ApprovalRequest): EmbedBuilder {
  const statusText =
    approval.status === "PENDING"
      ? "⏳ Awaiting Decision"
      : approval.status === "APPROVED"
      ? "✅ Approved"
      : "❌ Rejected";

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
      value: `${approval.resolvedBy} at ${approval.resolvedAt.toISOString()}`,
      inline: false,
    });
  }

  return embed;
}

function buildApprovalButtons(approvalId: string, disabled: boolean = false): ActionRowBuilder<ButtonBuilder> {
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

export async function createApproval(
  channelName: string,
  action: string,
  description: string,
  riskLevel: RiskLevel
): Promise<ApprovalRequest> {
  const channel = await findTextChannel(channelName);

  const approvalId = generateApprovalId();
  const approval: ApprovalRequest = {
    id: approvalId,
    channelName,
    action,
    description,
    riskLevel,
    status: "PENDING",
    messageId: null,
    createdAt: new Date(),
    resolvedAt: null,
    resolvedBy: null,
  };

  const approvals = loadApprovals();
  approvals.set(approvalId, approval);

  const embed = buildApprovalEmbed(approval);
  const row = buildApprovalButtons(approvalId);

  const message = await channel.send({
    embeds: [embed],
    components: [row],
  });

  approval.messageId = message.id;
  approvals.set(approvalId, approval);
  saveApprovals(approvals);

  console.log(`[ApprovalManager] Created approval ${approvalId} in #${channelName} (risk: ${riskLevel})`);
  return approval;
}

export function checkApproval(approvalId: string): ApprovalRequest {
  const approvals = loadApprovals();
  const approval = approvals.get(approvalId);
  if (!approval) {
    throw new Error(`Approval "${approvalId}" not found.`);
  }
  return approval;
}

export function listApprovals(): ApprovalRequest[] {
  const approvals = loadApprovals();
  return Array.from(approvals.values()).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  );
}

async function updateApprovalMessage(approval: ApprovalRequest): Promise<void> {
  if (!approval.messageId) return;

  try {
    const channel = await findTextChannel(approval.channelName);
    const message = await channel.messages.fetch(approval.messageId);

    const embed = buildApprovalEmbed(approval);
    const row = buildApprovalButtons(approval.id, true); // disabled after resolution

    await message.edit({
      embeds: [embed],
      components: [row],
    });
  } catch (err) {
    console.error(`[ApprovalManager] Failed to update approval message ${approval.messageId}:`, err);
  }
}

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

    const approvals = loadApprovals();
    const approval = approvals.get(approvalId);

    if (!approval) {
      await interaction.editReply({
        content: `Approval \`${approvalId}\` not found or expired.`,
      });
      return;
    }

    if (action === "preview") {
      await interaction.editReply({
        content: `**Preview for Approval \`${approvalId}\`**\n**Action:** ${approval.action}\n**Description:** ${approval.description}\n**Risk:** ${getRiskEmoji(approval.riskLevel)} ${approval.riskLevel}`,
      });
      return;
    }

    if (approval.status !== "PENDING") {
      await interaction.editReply({
        content: `This approval has already been ${approval.status.toLowerCase()}.`,
      });
      return;
    }

    const newStatus: ApprovalStatus = action === "approve" ? "APPROVED" : "REJECTED";
    approval.status = newStatus;
    approval.resolvedAt = new Date();
    approval.resolvedBy = interaction.user.username;
    approvals.set(approvalId, approval);
    saveApprovals(approvals);

    // Notify listener so it can trigger a Leader session to act on the decision
    if (onApprovalResolved) {
      try {
        onApprovalResolved(approval);
      } catch (err) {
        console.error("[ApprovalManager] Callback error:", err);
      }
    }

    const emoji = newStatus === "APPROVED" ? "✅" : "❌";
    await interaction.editReply({
      content: `${emoji} Approval \`${approvalId}\` has been **${newStatus}** by ${interaction.user.username}.`,
    });

    await updateApprovalMessage(approval);

    console.log(
      `[ApprovalManager] Approval ${approvalId} ${newStatus} by ${interaction.user.username}`
    );
  });

  console.log("[ApprovalManager] Interaction handler registered.");
}
