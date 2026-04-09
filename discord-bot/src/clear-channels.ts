/**
 * clear-channels.ts — One-shot script to bulk-delete all messages in AI Office channels.
 *
 * Used by `office restore` to wipe Discord message history before restarting.
 * Connects as the bot, deletes messages from all AI Office channels, then exits.
 *
 * Run: node discord-bot/dist/clear-channels.js
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __file = fileURLToPath(import.meta.url);
const __discord_bot_dir = path.resolve(path.dirname(__file), "..");
dotenv.config({ path: path.join(__discord_bot_dir, ".env") });

import { Client, GatewayIntentBits, TextChannel, Collection, Message, Snowflake } from "discord.js";

const CHANNELS_TO_CLEAR = ["general", "approvals", "alerts", "daily-brief", "hr"];

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !guildId) {
  console.error("[ClearChannels] Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID in .env");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

async function clearChannel(channel: TextChannel): Promise<void> {
  let deleted = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const messages: Collection<Snowflake, Message> = await channel.messages.fetch({ limit: 100 });
    if (messages.size === 0) break;

    // Discord bulkDelete only works for messages < 14 days old
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recent = messages.filter((m) => m.createdTimestamp > cutoff);
    const old = messages.filter((m) => m.createdTimestamp <= cutoff);

    if (recent.size >= 2) {
      const bulkResult = await channel.bulkDelete(recent, true);
      deleted += bulkResult.size;
    } else if (recent.size === 1) {
      // bulkDelete requires >= 2; delete single message individually
      await recent.first()!.delete();
      deleted += 1;
    }

    // Delete old messages one by one (bulkDelete doesn't support them)
    for (const msg of old.values()) {
      try {
        await msg.delete();
        deleted += 1;
      } catch {
        // Non-fatal — might already be deleted
      }
    }

    // If we got fewer than 100 messages, we've reached the end
    if (messages.size < 100) break;
  }

  console.log(`[ClearChannels] #${channel.name}: deleted ${deleted} messages`);
}

client.once("clientReady", async (readyClient) => {
  try {
    const guild = await readyClient.guilds.fetch(guildId!);
    const allChannels = await guild.channels.fetch();

    for (const name of CHANNELS_TO_CLEAR) {
      const ch = allChannels.find(
        (c) => c !== null && "name" in c && c.name === name
      );
      if (!ch) {
        console.log(`[ClearChannels] #${name}: not found, skipping`);
        continue;
      }
      if (!(ch instanceof TextChannel)) {
        console.log(`[ClearChannels] #${name}: not a text channel, skipping`);
        continue;
      }
      await clearChannel(ch);
    }

    console.log("[ClearChannels] Done.");
  } catch (err) {
    console.error("[ClearChannels] Error:", err);
    process.exit(1);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(token);
