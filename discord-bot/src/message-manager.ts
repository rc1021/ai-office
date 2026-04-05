import {
  EmbedBuilder,
  TextChannel,
  ThreadChannel,
  Message,
  Collection,
} from "discord.js";
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

export async function sendMessage(channelName: string, content: string): Promise<string> {
  const channel = await findTextChannel(channelName);
  const msg = await channel.send(content);
  console.log(`[MessageManager] Sent message to #${channelName}: ${content.substring(0, 60)}`);
  return msg.id;
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
