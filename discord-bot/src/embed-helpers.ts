/**
 * embed-helpers.ts — Discord embed construction helpers
 */

import { EmbedBuilder } from "discord.js";
import { COLORS } from "@ai-office/core";
import type { EmbedInput } from "@ai-office/core";

// Re-export COLORS for backward compatibility within discord-bot
export { COLORS };

// ── Embed Builder ────────────────────────────────────────────────────────────

export function buildDiscordEmbed(input: EmbedInput): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(input.title)
    .setDescription(input.description)
    .setColor(input.color ?? COLORS.BLURPLE)
    .setTimestamp();

  if (input.fields && input.fields.length > 0) {
    embed.addFields(input.fields.map((f) => ({ name: f.name, value: f.value })));
  }

  if (input.footer) {
    embed.setFooter({ text: input.footer });
  }

  return embed;
}
