import "dotenv/config";
import { createDiscordClient } from "./discord-client.js";
import { startMcpServer } from "./mcp-server.js";

// Redirect all console output to stderr so stdout stays clean for MCP JSON-RPC
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;
const origInfo = console.info;
console.log = (...args: unknown[]) => origError(...args);
console.warn = (...args: unknown[]) => origError(...args);
console.info = (...args: unknown[]) => origError(...args);

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[Startup] DISCORD_BOT_TOKEN is not set. Exiting.");
    process.exit(1);
  }

  if (!process.env.DISCORD_GUILD_ID) {
    console.error("[Startup] DISCORD_GUILD_ID is not set. Exiting.");
    process.exit(1);
  }

  console.error("[Startup] Initializing AI Office Discord Bot + MCP Server...");

  // 1. Start MCP server FIRST so Claude Code can connect immediately
  console.error("[Startup] Starting MCP server on stdio...");
  try {
    await startMcpServer();
    console.error("[Startup] MCP server ready.");
  } catch (err) {
    console.error("[Startup] Failed to start MCP server:", err);
    process.exit(1);
  }

  // 2. Create and configure the Discord client
  const client = createDiscordClient();

  // 3. Log into Discord (after MCP is ready — Discord connects via WebSocket independently)
  // Note: approval interaction handling is done exclusively by the listener daemon,
  // not here, to prevent double-response when both processes receive InteractionCreate.
  try {
    await client.login(token);
    console.error("[Startup] Discord login initiated.");
  } catch (err) {
    console.error("[Startup] Failed to log into Discord:", err);
    process.exit(1);
  }

  // 5. Handle graceful shutdown
  process.on("SIGINT", async () => {
    console.error("\n[Shutdown] Received SIGINT. Shutting down gracefully...");
    client.destroy();
    console.error("[Shutdown] Discord client destroyed. Goodbye.");
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.error("\n[Shutdown] Received SIGTERM. Shutting down gracefully...");
    client.destroy();
    console.error("[Shutdown] Discord client destroyed. Goodbye.");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    console.error("[Error] Uncaught exception:", err);
    // Don't exit — keep the bot running
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Error] Unhandled promise rejection:", reason);
    // Don't exit — keep the bot running
  });
}

main();
