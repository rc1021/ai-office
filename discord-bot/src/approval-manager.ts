import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ButtonInteraction,
  Events,
  ComponentType,
  Message,
} from "discord.js";
import { randomUUID } from "crypto";
import { findTextChannel } from "./channel-manager.js";
import { ApprovalRequest, ApprovalStatus, RiskLevel } from "./types.js";
import { getDiscordClient } from "./discord-client.js";

// In-memory store for approvals
const approvals = new Map<string, ApprovalRequest>();

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

  approvals.set(approvalId, approval);

  const embed = buildApprovalEmbed(approval);
  const row = buildApprovalButtons(approvalId);

  const message = await channel.send({
    embeds: [embed],
    components: [row],
  });

  approval.messageId = message.id;
  approvals.set(approvalId, approval);

  console.log(`[ApprovalManager] Created approval ${approvalId} in #${channelName} (risk: ${riskLevel})`);
  return approval;
}

export function checkApproval(approvalId: string): ApprovalRequest {
  const approval = approvals.get(approvalId);
  if (!approval) {
    throw new Error(`Approval "${approvalId}" not found.`);
  }
  return approval;
}

export function listApprovals(): ApprovalRequest[] {
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

export function registerApprovalInteractionHandler(): void {
  const client = getDiscordClient();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const customId = interaction.customId;
    if (!customId.startsWith("approval:")) return;

    const parts = customId.split(":");
    if (parts.length < 3) return;

    const [, action, approvalId] = parts;
    const approval = approvals.get(approvalId);

    if (!approval) {
      await interaction.reply({
        content: `Approval \`${approvalId}\` not found or expired.`,
        ephemeral: true,
      });
      return;
    }

    if (action === "preview") {
      await interaction.reply({
        content: `**Preview for Approval \`${approvalId}\`**\n**Action:** ${approval.action}\n**Description:** ${approval.description}\n**Risk:** ${getRiskEmoji(approval.riskLevel)} ${approval.riskLevel}`,
        ephemeral: true,
      });
      return;
    }

    if (approval.status !== "PENDING") {
      await interaction.reply({
        content: `This approval has already been ${approval.status.toLowerCase()}.`,
        ephemeral: true,
      });
      return;
    }

    const newStatus: ApprovalStatus = action === "approve" ? "APPROVED" : "REJECTED";
    approval.status = newStatus;
    approval.resolvedAt = new Date();
    approval.resolvedBy = interaction.user.username;
    approvals.set(approvalId, approval);

    const emoji = newStatus === "APPROVED" ? "✅" : "❌";
    await interaction.reply({
      content: `${emoji} Approval \`${approvalId}\` has been **${newStatus}** by ${interaction.user.username}.`,
    });

    await updateApprovalMessage(approval);

    console.log(
      `[ApprovalManager] Approval ${approvalId} ${newStatus} by ${interaction.user.username}`
    );
  });

  console.log("[ApprovalManager] Interaction handler registered.");
}
