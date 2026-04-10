/**
 * register-commands.ts — One-time script to register the /office guild slash command.
 *
 * Usage (after building):
 *   node discord-bot/dist/scripts/register-commands.js
 *
 * Required env vars (read from discord-bot/.env):
 *   DISCORD_BOT_TOKEN   — Bot token
 *   DISCORD_CLIENT_ID   — Application / Client ID  (also accepted as APPLICATION_ID)
 *   DISCORD_GUILD_ID    — Target guild ID
 *
 * Note: DISCORD_CLIENT_ID is not in the default .env template yet — add it.
 * You can find it in the Discord Developer Portal → Your App → General Information → Application ID.
 */

import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REST, Routes } from "discord.js";
import { ApplicationCommandType } from "discord-api-types/v10";

// Load .env from discord-bot/ directory
const __filename = fileURLToPath(import.meta.url);
// At runtime: discord-bot/dist/scripts/register-commands.js
// scripts/ → dist/ → discord-bot/
const DIST_SCRIPTS_DIR = path.dirname(__filename);
const DIST_DIR = path.resolve(DIST_SCRIPTS_DIR, "..");
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");

dotenv.config({ path: path.join(DISCORD_BOT_DIR, ".env") });

const token      = process.env.DISCORD_BOT_TOKEN;
const clientId   = process.env.DISCORD_CLIENT_ID ?? process.env.APPLICATION_ID;
const guildId    = process.env.DISCORD_GUILD_ID;

if (!token) {
  console.error("[RegisterCommands] DISCORD_BOT_TOKEN is not set.");
  process.exit(1);
}
if (!clientId) {
  console.error(
    "[RegisterCommands] DISCORD_CLIENT_ID (or APPLICATION_ID) is not set.\n" +
    "Add it to discord-bot/.env:\n  DISCORD_CLIENT_ID=your-application-id-here\n" +
    "You can find it in the Discord Developer Portal → Your App → General Information."
  );
  process.exit(1);
}
if (!guildId) {
  console.error("[RegisterCommands] DISCORD_GUILD_ID is not set.");
  process.exit(1);
}

const commands = [
  {
    type: ApplicationCommandType.ChatInput,
    name: "office",
    description: "開啟 AI Office 控制面板",
  },
];

const rest = new REST({ version: "10" }).setToken(token);

async function main(): Promise<void> {
  console.log("[RegisterCommands] Registering /office command for guild:", guildId);

  try {
    const data = await rest.put(
      Routes.applicationGuildCommands(clientId!, guildId!),
      { body: commands }
    ) as unknown[];

    console.log(
      `[RegisterCommands] Successfully registered ${data.length} command(s).`
    );
    console.log("[RegisterCommands] Done. The /office command is now available in your guild.");
  } catch (err) {
    console.error("[RegisterCommands] Failed to register commands:", err);
    process.exit(1);
  }
}

main();
