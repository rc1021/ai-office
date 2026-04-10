import { ChannelType } from "discord.js";
import { getDiscordClient } from "./discord-client.js";
import { createCategory, createChannel } from "./channel-manager.js";
import { ServerSetupResult } from "./types.js";

// Fixed AI Office server layout — only human-facing channels
const SERVER_STRUCTURE = [
  {
    category: "AI OFFICE",
    channels: [
      { name: "general", topic: "Chat with your AI Office Leader" },
      { name: "approvals", topic: "Human approval requests" },
      { name: "alerts", topic: "Critical alerts requiring attention" },
      { name: "daily-brief", topic: "Daily office summary" },
      { name: "hr", topic: "Hiring board — recruit new team members" },
      { name: "memo", topic: "Memos & notes" },
    ],
  },
];

async function categoryExists(guildId: string, categoryName: string): Promise<boolean> {
  const client = getDiscordClient();
  const guild = await client.guilds.fetch(guildId);
  return guild.channels.cache.some(
    (ch) =>
      ch.type === ChannelType.GuildCategory &&
      ch.name.toLowerCase() === categoryName.toLowerCase()
  );
}

async function channelExists(
  guildId: string,
  categoryName: string,
  channelName: string
): Promise<boolean> {
  const client = getDiscordClient();
  const guild = await client.guilds.fetch(guildId);

  const category = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildCategory &&
      ch.name.toLowerCase() === categoryName.toLowerCase()
  );

  if (!category) return false;

  return guild.channels.cache.some(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      ch.name.toLowerCase() === channelName.toLowerCase() &&
      (ch as { parentId?: string | null }).parentId === category.id
  );
}

export async function setupServer(): Promise<ServerSetupResult> {
  const result: ServerSetupResult = {
    created: [],
    skipped: [],
    errors: [],
  };

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    throw new Error("DISCORD_GUILD_ID environment variable not set.");
  }

  for (const section of SERVER_STRUCTURE) {
    // Handle category
    try {
      const catExists = await categoryExists(guildId, section.category);
      if (catExists) {
        result.skipped.push(`[Category] ${section.category}`);
      } else {
        await createCategory(section.category);
        result.created.push(`[Category] ${section.category}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`[Category] ${section.category}: ${message}`);
      console.error(`[Setup] Failed to create category "${section.category}":`, err);
      continue; // Skip channels if category failed
    }

    // Handle each channel
    for (const ch of section.channels) {
      try {
        const chExists = await channelExists(guildId, section.category, ch.name);
        if (chExists) {
          result.skipped.push(`[Channel] #${ch.name} in ${section.category}`);
        } else {
          await createChannel(section.category, ch.name, ch.topic);
          result.created.push(`[Channel] #${ch.name} in ${section.category}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`[Channel] #${ch.name} in ${section.category}: ${message}`);
        console.error(`[Setup] Failed to create channel "#${ch.name}":`, err);
      }
    }
  }

  console.log(
    `[Setup] Server setup complete. Created: ${result.created.length}, Skipped: ${result.skipped.length}, Errors: ${result.errors.length}`
  );

  return result;
}
