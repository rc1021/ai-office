import {
  ChannelType,
  CategoryChannel,
  TextChannel,
  Guild,
  PermissionsBitField,
} from "discord.js";
import { getDiscordClient } from "./discord-client.js";

function validateChannelName(name: string): string {
  // Discord channel names: lowercase, alphanumeric, hyphens, max 100 chars
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").substring(0, 100);
  if (!sanitized || sanitized.replace(/-/g, "").length === 0) {
    throw new Error(`Invalid channel name: "${name}". Must contain at least one alphanumeric character.`);
  }
  return sanitized;
}

async function getGuild(): Promise<Guild> {
  const client = getDiscordClient();
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error("DISCORD_GUILD_ID environment variable not set.");
  }
  const guild = await client.guilds.fetch(guildId);
  if (!guild) {
    throw new Error(`Guild ${guildId} not found.`);
  }
  return guild;
}

export async function createCategory(name: string): Promise<CategoryChannel> {
  const guild = await getGuild();

  // Check if category already exists
  const existing = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildCategory &&
      ch.name.toLowerCase() === name.toLowerCase()
  ) as CategoryChannel | undefined;

  if (existing) {
    console.log(`[ChannelManager] Category "${name}" already exists.`);
    return existing;
  }

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
  });

  console.log(`[ChannelManager] Created category: ${category.name} (${category.id})`);
  return category;
}

export async function createChannel(
  categoryName: string,
  channelName: string,
  topic?: string
): Promise<TextChannel> {
  const guild = await getGuild();
  const sanitizedName = validateChannelName(channelName);

  // Find the parent category
  const category = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildCategory &&
      ch.name.toLowerCase() === categoryName.toLowerCase()
  ) as CategoryChannel | undefined;

  if (!category) {
    throw new Error(`Category "${categoryName}" not found. Create it first with create_category.`);
  }

  // Check if channel already exists in that category
  const existing = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      ch.name.toLowerCase() === sanitizedName.toLowerCase() &&
      (ch as TextChannel).parentId === category.id
  ) as TextChannel | undefined;

  if (existing) {
    console.log(`[ChannelManager] Channel #${sanitizedName} already exists in category "${categoryName}".`);
    return existing;
  }

  const channel = await guild.channels.create({
    name: sanitizedName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: topic ?? undefined,
  });

  console.log(`[ChannelManager] Created channel #${channel.name} in "${categoryName}" (${channel.id})`);
  return channel;
}

export async function listChannels(): Promise<
  { id: string; name: string; type: string; category: string | null; topic: string | null }[]
> {
  const guild = await getGuild();
  // Fetch fresh channel list
  await guild.channels.fetch();

  const result: { id: string; name: string; type: string; category: string | null; topic: string | null }[] = [];

  const categories = guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildCategory)
    .sort((a, b) => ((a as CategoryChannel).position ?? 0) - ((b as CategoryChannel).position ?? 0));

  for (const [, category] of categories) {
    result.push({
      id: category.id,
      name: category.name,
      type: "category",
      category: null,
      topic: null,
    });

    const children = guild.channels.cache
      .filter(
        (ch) =>
          ch.type === ChannelType.GuildText &&
          (ch as TextChannel).parentId === category.id
      )
      .sort((a, b) => ((a as TextChannel).position ?? 0) - ((b as TextChannel).position ?? 0));

    for (const [, ch] of children) {
      const textCh = ch as TextChannel;
      result.push({
        id: textCh.id,
        name: textCh.name,
        type: "text",
        category: category.name,
        topic: textCh.topic ?? null,
      });
    }
  }

  // Channels without a category
  const uncategorized = guild.channels.cache.filter(
    (ch) => ch.type === ChannelType.GuildText && !(ch as TextChannel).parentId
  );
  for (const [, ch] of uncategorized) {
    const textCh = ch as TextChannel;
    result.push({
      id: textCh.id,
      name: textCh.name,
      type: "text",
      category: null,
      topic: textCh.topic ?? null,
    });
  }

  return result;
}

export async function deleteChannel(channelName: string): Promise<string> {
  const guild = await getGuild();
  const sanitizedName = channelName.toLowerCase();

  const channel = guild.channels.cache.find(
    (ch) =>
      (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildCategory) &&
      ch.name.toLowerCase() === sanitizedName
  );

  if (!channel) {
    throw new Error(`Channel or category "${channelName}" not found.`);
  }

  const channelId = channel.id;
  const channelFullName = channel.name;
  await channel.delete(`Deleted via MCP tool`);

  console.log(`[ChannelManager] Deleted channel/category: ${channelFullName} (${channelId})`);
  return channelFullName;
}

export async function findTextChannel(channelName: string): Promise<TextChannel> {
  const guild = await getGuild();
  const sanitizedName = channelName.toLowerCase().replace(/^#/, "");

  const channel = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      ch.name.toLowerCase() === sanitizedName
  ) as TextChannel | undefined;

  if (!channel) {
    throw new Error(`Text channel "#${sanitizedName}" not found.`);
  }

  return channel;
}
