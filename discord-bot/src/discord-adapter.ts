/**
 * discord-adapter.ts — Implements ChatAdapter for Discord
 *
 * Thin wrapper that delegates to existing Discord-specific modules
 * (message-manager, channel-manager, embed-helpers).
 */

import type { ChatAdapter, EmbedInput } from "@ai-office/core";
import { sendMessage, sendEmbed } from "./message-manager.js";
import { findTextChannel, createCategory, createChannel } from "./channel-manager.js";
import { buildDiscordEmbed } from "./embed-helpers.js";

export class DiscordChatAdapter implements ChatAdapter {
  async sendMessage(channelName: string, content: string): Promise<string> {
    return sendMessage(channelName, content);
  }

  async sendEmbed(channelName: string, embed: EmbedInput): Promise<string> {
    return sendEmbed(channelName, embed);
  }

  async editEmbed(channelName: string, messageId: string, embed: EmbedInput): Promise<void> {
    const channel = await findTextChannel(channelName);
    const message = await channel.messages.fetch(messageId);
    const discordEmbed = buildDiscordEmbed(embed);
    await message.edit({ embeds: [discordEmbed] });
  }

  async channelExists(channelName: string): Promise<boolean> {
    try {
      await findTextChannel(channelName);
      return true;
    } catch {
      return false;
    }
  }

  async createCategory(name: string): Promise<void> {
    await createCategory(name);
  }

  async createChannel(categoryName: string, channelName: string, topic?: string): Promise<void> {
    await createChannel(categoryName, channelName, topic);
  }
}
