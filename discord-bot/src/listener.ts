/**
 * listener.ts — Standalone Discord Bot Daemon
 *
 * This is a SEPARATE entry point from index.ts (the MCP server).
 * It runs as an independent long-lived process that:
 *  1. Connects to Discord and stays online
 *  2. Listens for user messages in #general
 *  3. Spawns `claude -p` for each message
 *  4. Posts Claude's response back to Discord
 *
 * Start with: node discord-bot/dist/listener.js
 * (from the project root directory)
 */

import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Load .env from discord-bot/ directory (not cwd)
const __listener_file = fileURLToPath(import.meta.url);
const __discord_bot_dir = path.resolve(path.dirname(__listener_file), "..");
dotenv.config({ path: path.join(__discord_bot_dir, ".env") });
import { spawn } from "node:child_process";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  TextChannel,
  Message,
} from "discord.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GENERAL_CHANNEL = "general";
const ONBOARDED_FLAG = path.join(
  process.env.HOME ?? "~",
  ".ai-office",
  "state",
  ".onboarded"
);
const STARTUP_CHECKLIST_PROMPT =
  "You are the AI Office Leader. This is the first launch. " +
  "Follow your Startup Checklist in agents/leader/CLAUDE.md: " +
  "initialize the orchestrator, report status, setup Discord server channels, " +
  "check for interrupted tasks, post bot-status update, " +
  "and run the Welcome Flow to greet the user in #general.";

// ── Resolve project root (two levels up from dist/listener.js) ────────────────

const __filename = fileURLToPath(import.meta.url);
// __filename is discord-bot/src/listener.ts at compile time; at runtime it's
// discord-bot/dist/listener.js — two levels up from dist/ gives the repo root.
const DIST_DIR = path.dirname(__filename);
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");   // discord-bot/
const PROJECT_DIR = path.resolve(DISCORD_BOT_DIR, ".."); // repo root

const MCP_CONFIG = path.join(PROJECT_DIR, ".mcp.json");

console.log("[Listener] Project dir:", PROJECT_DIR);
console.log("[Listener] MCP config:", MCP_CONFIG);

// ── Spawn claude -p ───────────────────────────────────────────────────────────

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["-p", prompt];

    // Only pass --mcp-config if the file actually exists (avoids confusing errors)
    if (fs.existsSync(MCP_CONFIG)) {
      args.push("--mcp-config", MCP_CONFIG);
    } else {
      console.warn("[Listener] .mcp.json not found at", MCP_CONFIG, "— running without MCP tools");
    }

    console.log("[Listener] Spawning claude with prompt:", prompt.substring(0, 80));

    const proc = spawn("claude", args, {
      cwd: PROJECT_DIR,
      env: { ...process.env },
    });

    let output = "";
    let stderrOutput = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderrOutput += chunk;
      console.error("[Claude]", chunk.trimEnd());
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}. Is Claude Code installed?`));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(
          new Error(
            `claude exited with code ${code}. stderr: ${stderrOutput.slice(-500)}`
          )
        );
      }
    });
  });
}

// ── First-run check ───────────────────────────────────────────────────────────

async function checkFirstRun(generalChannel: TextChannel): Promise<void> {
  if (fs.existsSync(ONBOARDED_FLAG)) {
    console.log("[Listener] Already onboarded, skipping first-run flow.");
    return;
  }

  console.log("[Listener] First run detected — triggering startup checklist via claude -p...");

  try {
    const response = await runClaude(STARTUP_CHECKLIST_PROMPT);
    if (response) {
      // The Leader should have already posted to Discord via MCP tools,
      // but if there's leftover stdout, log it (don't double-post).
      console.log("[Listener] Startup checklist result:", response.substring(0, 200));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] First-run startup failed:", msg);
    await generalChannel
      .send(`⚠️ First-run startup encountered an error: ${msg.substring(0, 500)}`)
      .catch((e) => console.error("[Listener] Failed to send error message:", e));
  }
}

// ── Handle incoming user message ──────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  // Safety checks
  if (message.author.bot) return;
  if (!(message.channel instanceof TextChannel)) return;
  if (message.channel.name !== GENERAL_CHANNEL) return;

  const userContent = message.content.trim();
  if (!userContent) return;

  const channel = message.channel as TextChannel;

  console.log(
    `[Listener] Message from ${message.author.username}: ${userContent.substring(0, 80)}`
  );

  // 1. Acknowledge with ⏳
  try {
    await message.react("⏳");
  } catch (err) {
    console.warn("[Listener] Could not add ⏳ reaction:", err);
  }

  // 2. Build prompt — include author context so Claude knows who is speaking
  //    Sanitize to prevent trivial injection: wrap in a structured envelope.
  const prompt = buildPrompt(message.author.username, userContent);

  // 3. Run claude -p
  let response: string;
  try {
    response = await runClaude(prompt);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] claude failed:", errMsg);

    // Remove ⏳ and post error
    await removeReaction(message, "⏳");
    await channel
      .send(`❌ Error processing your request: ${errMsg.substring(0, 1000)}`)
      .catch((e) => console.error("[Listener] Failed to send error:", e));
    return;
  }

  // 4. Post response
  if (response) {
    // Discord messages have a 2000-char limit; split if needed
    const chunks = splitMessage(response, 1900);
    for (const chunk of chunks) {
      await channel.send(chunk).catch((e) =>
        console.error("[Listener] Failed to send response chunk:", e)
      );
    }
  } else {
    console.warn("[Listener] claude returned empty output.");
  }

  // 5. Replace ⏳ with ✅
  await removeReaction(message, "⏳");
  try {
    await message.react("✅");
  } catch (err) {
    console.warn("[Listener] Could not add ✅ reaction:", err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Wrap the user message in a structured envelope to reduce injection risk.
 * The Leader's CLAUDE.md instructs it to sanitize input before delegation.
 */
function buildPrompt(username: string, content: string): string {
  // Use a delimited structure so it is harder to escape the envelope context.
  return (
    "You are the AI Office Leader. A user has sent you a message in Discord #general.\n" +
    "\n" +
    "User: " + username + "\n" +
    "--- BEGIN MESSAGE ---\n" +
    content + "\n" +
    "--- END MESSAGE ---\n" +
    "\n" +
    "Process this request according to your role instructions (agents/leader/CLAUDE.md). " +
    "Return a concise response that will be posted back to Discord #general. " +
    "Keep it under 1800 characters when possible. " +
    "Use your MCP tools (coordination, discord) as needed."
  );
}

/**
 * Remove a specific reaction emoji from a message (best-effort).
 */
async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const myReaction = message.reactions.cache.get(emoji);
    if (myReaction) {
      await myReaction.users.remove(message.client.user!.id);
    }
  } catch {
    // Non-fatal — permissions may not allow reaction removal
  }
}

/**
 * Split a long string into <=maxLen chunks at newline boundaries when possible.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at last newline within limit
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error(
      "[Listener] DISCORD_BOT_TOKEN is not set. " +
        "Set it in discord-bot/.env or as an environment variable."
    );
    process.exit(1);
  }

  if (!process.env.DISCORD_GUILD_ID) {
    console.error("[Listener] DISCORD_GUILD_ID is not set. Exiting.");
    process.exit(1);
  }

  console.log("[Listener] Starting AI Office Discord Listener...");

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Listener] Bot ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[Listener] Serving ${readyClient.guilds.cache.size} guild(s)`);
    console.log(`[Listener] Listening for messages in #${GENERAL_CHANNEL}`);

    // Locate #general for first-run flow
    const guild = readyClient.guilds.cache.first();
    if (guild) {
      const generalChannel = guild.channels.cache.find(
        (ch) => ch instanceof TextChannel && ch.name === GENERAL_CHANNEL
      ) as TextChannel | undefined;

      if (generalChannel) {
        await checkFirstRun(generalChannel);
      } else {
        console.warn(
          "[Listener] #general channel not found — skipping first-run check. " +
            "Run the Leader's setup_server tool first."
        );
      }
    }
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => {
      console.error("[Listener] Unhandled error in handleMessage:", err);
    });
  });

  client.on(Events.Error, (error) => {
    console.error("[Listener] Discord client error:", error);
  });

  client.on(Events.Warn, (info) => {
    console.warn("[Listener] Discord warning:", info);
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Listener] Received ${signal}. Shutting down gracefully...`);
    client.destroy();
    console.log("[Listener] Discord client destroyed. Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    console.error("[Listener] Uncaught exception:", err);
    // Keep running — don't let a single bad message kill the daemon
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[Listener] Unhandled promise rejection:", reason);
  });

  // ── Login ──────────────────────────────────────────────────────────────────

  try {
    await client.login(token);
    console.log("[Listener] Discord login initiated.");
  } catch (err) {
    console.error("[Listener] Failed to log into Discord:", err);
    process.exit(1);
  }
}

main();
