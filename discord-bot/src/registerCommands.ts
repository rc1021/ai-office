/**
 * registerCommands.ts — Auto-register /office slash command on startup.
 * Called from listener.ts clientReady event.
 */
import { REST, Routes } from "discord.js";
import { ApplicationCommandType } from "discord-api-types/v10";

const OFFICE_COMMANDS = [
  {
    type: ApplicationCommandType.ChatInput,
    name: "office",
    description: "開啟 AI Office 控制面板",
  },
];

/**
 * Register the /office guild slash command.
 * Silently skips if DISCORD_CLIENT_ID is not set.
 * Idempotent — safe to call on every startup.
 */
export async function registerOfficeCommands(
  token: string,
  guildId: string
): Promise<void> {
  const clientId = process.env.DISCORD_CLIENT_ID ?? process.env.APPLICATION_ID;
  if (!clientId) {
    console.warn("[RegisterCommands] DISCORD_CLIENT_ID not set — skipping slash command registration.");
    console.warn("[RegisterCommands] Run: office configure client-id  to set it.");
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: OFFICE_COMMANDS }
    );
    console.log("[RegisterCommands] /office command registered successfully.");
  } catch (err) {
    console.warn("[RegisterCommands] Failed to register /office command:", err);
    // Non-fatal — don't crash the listener
  }
}
