/**
 * chat-adapter.ts — Platform-agnostic chat interface
 *
 * Implemented by discord-bot (DiscordChatAdapter), slack-bot (SlackChatAdapter), etc.
 * Used by HeartbeatScheduler to send messages without
 * knowing which chat platform is active.
 */

import type { EmbedInput } from "./types.js";

export interface ChatAdapter {
  /** Send a plain text message to a named channel. Returns platform message ID. */
  sendMessage(channel: string, content: string): Promise<string>;

  /** Send a rich embed to a named channel. Returns platform message ID. */
  sendEmbed(channel: string, embed: EmbedInput): Promise<string>;

  /** Edit an existing embed message by platform message ID. */
  editEmbed(channel: string, messageId: string, embed: EmbedInput): Promise<void>;

  /** Check if a named channel exists. */
  channelExists(channel: string): Promise<boolean>;

  /** Create a category (or workspace equivalent). */
  createCategory(name: string): Promise<void>;

  /** Create a channel under a category. */
  createChannel(category: string, channel: string, topic?: string): Promise<void>;
}
