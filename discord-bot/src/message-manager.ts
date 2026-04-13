import {
  EmbedBuilder,
  TextChannel,
  ThreadChannel,
  Message,
  Collection,
  MessageCreateOptions,
} from "discord.js";
import path from "node:path";
import { findTextChannel } from "./channel-manager.js";
import { EmbedInput, ChannelMessage } from "./types.js";

// Track last-read message ID per channel (keyed by channel name)
const lastReadMessageId = new Map<string, string>();

function formatMessage(msg: Message): ChannelMessage {
  return {
    id: msg.id,
    author: msg.author.username,
    content: msg.content || (msg.embeds.length > 0 ? `[Embed: ${msg.embeds[0].title ?? "untitled"}]` : "[No text content]"),
    timestamp: msg.createdAt.toISOString(),
    isBot: msg.author.bot,
  };
}

const DISCORD_MAX_LENGTH = 2000;
const FOOTER_RESERVE_NO_LABEL = 10;  // "\n-# 99/99" ≈ 8 chars + margin
const FOOTER_RESERVE_WITH_LABEL = 60; // "\n-# 99/99 <label> • a1b2c3d4" up to 60 chars

/**
 * Split text into chunks that fit within Discord's 2000-char limit.
 * Splits at newline boundaries when possible.
 */
function splitContent(text: string, maxLen: number = DISCORD_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export async function sendMessage(
  channelName: string,
  content: string,
  replyToMessageId?: string,
  pageLabel?: string
): Promise<string> {
  const channel = await findTextChannel(channelName);

  // Short session ID injected via AI_OFFICE_SESSION_ID env var (set by claude-runner
  // when --resume is active). Shows on the last page so users can easily --resume.
  const rawSessionId = process.env.AI_OFFICE_SESSION_ID ?? "";
  const shortSessionId = rawSessionId ? rawSessionId.replace(/-/g, "").substring(0, 8) : "";

  const effectiveMax = DISCORD_MAX_LENGTH
    - (pageLabel !== undefined || shortSessionId ? FOOTER_RESERVE_WITH_LABEL : FOOTER_RESERVE_NO_LABEL);
  const chunks = splitContent(content, effectiveMax);
  const total = chunks.length;
  let lastMsgId = "";

  for (let i = 0; i < chunks.length; i++) {
    let pageContent = chunks[i];
    const label = pageLabel ? ` ${pageLabel}` : '';
    const isLast = i === total - 1;

    if (total > 1 && isLast && shortSessionId) {
      pageContent += `\n-# ${i + 1}/${total}${label} • ${shortSessionId}`;
    } else if (total > 1) {
      pageContent += `\n-# ${i + 1}/${total}${label}`;
    } else if (shortSessionId) {
      pageContent += `\n-# ${shortSessionId}`;
    }
    const options: MessageCreateOptions = { content: pageContent };
    if (replyToMessageId && lastMsgId === "") {
      // Only apply the reply reference on the first chunk
      options.reply = { messageReference: replyToMessageId, failIfNotExists: false };
    }
    const msg = await channel.send(options);
    lastMsgId = msg.id;
  }

  console.log(`[MessageManager] Sent message to #${channelName} (${chunks.length} part${chunks.length > 1 ? "s" : ""}): ${content.substring(0, 60)}`);
  return lastMsgId;
}

export async function sendEmbed(channelName: string, embedInput: EmbedInput): Promise<string> {
  const channel = await findTextChannel(channelName);

  const embed = new EmbedBuilder()
    .setTitle(embedInput.title)
    .setDescription(embedInput.description);

  if (embedInput.color !== undefined) {
    embed.setColor(embedInput.color);
  } else {
    embed.setColor(0x5865f2); // Discord blurple default
  }

  if (embedInput.fields && embedInput.fields.length > 0) {
    embed.addFields(
      embedInput.fields.map((f) => ({ name: f.name, value: f.value }))
    );
  }

  if (embedInput.footer) {
    embed.setFooter({ text: embedInput.footer });
  }

  embed.setTimestamp();

  const msg = await channel.send({ embeds: [embed] });
  console.log(`[MessageManager] Sent embed to #${channelName}: "${embedInput.title}"`);
  return msg.id;
}

export async function readMessages(
  channelName: string,
  limit: number = 10
): Promise<ChannelMessage[]> {
  const channel = await findTextChannel(channelName);

  const clampedLimit = Math.min(Math.max(1, limit), 100);
  const messages = await channel.messages.fetch({ limit: clampedLimit });

  const result = Array.from(messages.values())
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(formatMessage);

  console.log(`[MessageManager] Read ${result.length} messages from #${channelName}`);
  return result;
}

export async function readNewMessages(channelName: string): Promise<ChannelMessage[]> {
  const channel = await findTextChannel(channelName);

  const lastId = lastReadMessageId.get(channelName.toLowerCase());

  let messages: Collection<string, Message>;

  if (lastId) {
    // Fetch messages after the last-read message
    messages = await channel.messages.fetch({ after: lastId, limit: 100 });
  } else {
    // First time: fetch last 10 messages
    messages = await channel.messages.fetch({ limit: 10 });
  }

  if (messages.size === 0) {
    return [];
  }

  // Update the last-read message ID to the newest message
  const sortedMessages = Array.from(messages.values()).sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const newestMessage = sortedMessages[sortedMessages.length - 1];
  lastReadMessageId.set(channelName.toLowerCase(), newestMessage.id);

  const result = sortedMessages.map(formatMessage);
  console.log(`[MessageManager] Read ${result.length} new messages from #${channelName}`);
  return result;
}

export async function readMessageById(channelName: string, messageId: string): Promise<ChannelMessage> {
  const channel = await findTextChannel(channelName);
  const msg = await channel.messages.fetch(messageId);

  // Include embed content if message text is empty
  let content = msg.content;
  if (!content && msg.embeds.length > 0) {
    const parts: string[] = [];
    for (const embed of msg.embeds) {
      if (embed.title) parts.push(`## ${embed.title}`);
      if (embed.description) parts.push(embed.description);
      for (const field of embed.fields) {
        parts.push(`**${field.name}**: ${field.value}`);
      }
      if (embed.footer?.text) parts.push(`_${embed.footer.text}_`);
    }
    content = parts.join("\n");
  }

  return {
    id: msg.id,
    author: msg.author.username,
    content: content || "[No content]",
    timestamp: msg.createdAt.toISOString(),
    isBot: msg.author.bot,
  };
}

export async function createThread(
  channelName: string,
  messageId: string,
  threadName: string
): Promise<{ threadId: string; threadName: string }> {
  const channel = await findTextChannel(channelName);

  const message = await channel.messages.fetch(messageId);
  if (!message) {
    throw new Error(`Message ${messageId} not found in #${channelName}`);
  }

  const thread = await message.startThread({
    name: threadName,
    autoArchiveDuration: 1440, // 24 hours
  });

  console.log(`[MessageManager] Created thread "${threadName}" (${thread.id}) in #${channelName}`);
  return { threadId: thread.id, threadName: thread.name };
}

export async function sendThreadMessage(
  threadId: string,
  content: string
): Promise<string> {
  const client = (await import("./discord-client.js")).getDiscordClient();

  const thread = await client.channels.fetch(threadId);
  if (!thread || !(thread instanceof ThreadChannel)) {
    throw new Error(`Thread ${threadId} not found or is not a thread channel.`);
  }

  const msg = await thread.send(content);
  console.log(`[MessageManager] Sent message to thread ${threadId}: ${content.substring(0, 60)}`);
  return msg.id;
}

export async function addReaction(
  channelName: string,
  messageId: string,
  emoji: string
): Promise<void> {
  const channel = await findTextChannel(channelName);
  const message = await channel.messages.fetch(messageId);
  await message.react(emoji);
  console.log(`[MessageManager] Added reaction ${emoji} to message ${messageId} in #${channelName}`);
}

export async function sendFile(
  channelName: string,
  filePath: string,
  filename?: string,
  content?: string,
  replyToMessageId?: string
): Promise<string> {
  const channel = await findTextChannel(channelName);
  const safeName = filename ?? path.basename(filePath);
  const options: MessageCreateOptions = {
    files: [{ attachment: filePath, name: safeName }],
  };
  if (content) {
    options.content = content;
  }
  if (replyToMessageId) {
    options.reply = { messageReference: replyToMessageId, failIfNotExists: false };
  }
  const msg = await channel.send(options);
  console.log(`[MessageManager] Sent file "${safeName}" to #${channelName}`);
  return msg.id;
}
