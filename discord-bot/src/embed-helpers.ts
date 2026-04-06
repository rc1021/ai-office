/**
 * embed-helpers.ts — Discord embed construction helpers
 */

import { EmbedBuilder } from "discord.js";
import { EmbedInput } from "./types.js";

// ── Color Constants ──────────────────────────────────────────────────────────

export const COLORS = {
  GREEN:   0x2ECC71,
  YELLOW:  0xF39C12,
  RED:     0xE74C3C,
  BLUE:    0x3498DB,
  GRAY:    0x95A5A6,
  BLURPLE: 0x5865F2,
} as const;

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
