/**
 * officeCommand.ts — Handle /office slash command
 *
 * Sends the AI Office control panel as an ephemeral embed with action buttons.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * Build the control panel embed and button rows.
 * Exported so the interaction handler can reuse it when showing the panel again
 * after a cancel action.
 */
export function buildControlPanel(): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle("🏢 AI Office 控制面板")
    .setDescription("選擇要執行的操作：")
    .setColor(0x5865f2)
    .setFooter({ text: "AI Office — 僅限授權操作者" });

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("office:restart")
      .setLabel("重啟")
      .setEmoji("🔄")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("office:stop")
      .setLabel("停止")
      .setEmoji("⏹")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("office:status")
      .setLabel("狀態")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("office:agents")
      .setLabel("員工")
      .setEmoji("👥")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("office:tasks")
      .setLabel("任務")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("office:hire")
      .setLabel("雇用員工")
      .setEmoji("🆕")
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Handle the /office slash command.
 * Replies with an ephemeral control panel.
 */
export async function handleOfficeCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const ownerId = process.env.DISCORD_OWNER_USER_ID;
  if (ownerId && interaction.user.id !== ownerId) {
    await interaction.reply({ content: "⛔ 無授權操作。", ephemeral: true });
    return;
  }

  const { embeds, components } = buildControlPanel();
  await interaction.reply({ embeds, components, ephemeral: true });
}
