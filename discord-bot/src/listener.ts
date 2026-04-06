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
import { registerApprovalInteractionHandler } from "./approval-manager.js";
import { setDiscordClient } from "./discord-client.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const GENERAL_CHANNEL = "general";
// Onboarded flag is per-project (in .ai-office/ under project root), not global
// Resolved after PROJECT_DIR is computed (see below)
let ONBOARDED_FLAG = "";
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
ONBOARDED_FLAG = path.join(PROJECT_DIR, ".ai-office", "state", ".onboarded");

console.log("[Listener] Project dir:", PROJECT_DIR);
console.log("[Listener] MCP config:", MCP_CONFIG);

// ── Spawn claude -p ───────────────────────────────────────────────────────────

// Tools the Leader needs access to (pre-approved for non-interactive mode)
const ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "mcp__ai-office-coordination__report_status",
  "mcp__ai-office-coordination__task_create",
  "mcp__ai-office-coordination__task_update",
  "mcp__ai-office-coordination__task_checkpoint",
  "mcp__ai-office-coordination__task_resume",
  "mcp__ai-office-coordination__task_list",
  "mcp__ai-office-coordination__list_agents",
  "mcp__ai-office-coordination__publish_event",
  "mcp__ai-office-coordination__publish_artifact",
  "mcp__ai-office-coordination__check_inbox",
  "mcp__ai-office-coordination__start_trace",
  "mcp__ai-office-coordination__end_trace",
  "mcp__ai-office-coordination__report_anomaly",
  "mcp__ai-office-coordination__validate_numeric",
  "mcp__ai-office-coordination__cross_verify",
  "mcp__ai-office-coordination__pipeline_gate",
  "mcp__ai-office-discord__setup_server",
  "mcp__ai-office-discord__send_message",
  "mcp__ai-office-discord__send_embed",
  "mcp__ai-office-discord__read_messages",
  "mcp__ai-office-discord__read_new_messages",
  "mcp__ai-office-discord__create_thread",
  "mcp__ai-office-discord__send_thread_message",
  "mcp__ai-office-discord__create_approval",
  "mcp__ai-office-discord__check_approval",
  "mcp__ai-office-discord__register_agent",
  "mcp__ai-office-discord__list_channels",
];

function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [
      "-p", prompt,
      "--allowedTools", ...ALLOWED_TOOLS,
    ];

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
      stdio: ["ignore", "pipe", "pipe"],
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

async function checkFirstRun(): Promise<void> {
  if (fs.existsSync(ONBOARDED_FLAG)) {
    console.log("[Listener] Already onboarded, skipping first-run flow.");
    return;
  }

  console.log("");
  console.log("[Listener] 🚀 First run detected!");
  console.log("[Listener] Setting up your AI Office — this takes 1-2 minutes...");
  console.log("[Listener]   • Creating Discord channels");
  console.log("[Listener]   • Registering Leader agent");
  console.log("[Listener]   • Sending welcome message to #general");
  console.log("");

  try {
    const response = await runClaude(STARTUP_CHECKLIST_PROMPT);
    console.log("");
    console.log("[Listener] ✅ Setup complete! Check Discord #general for the welcome message.");
    console.log("[Listener] You can now send messages in Discord — the bot will respond.");
    console.log("");
    if (response) {
      console.log("[Listener] Leader output:", response.substring(0, 300));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("");
    console.error("[Listener] ❌ First-run setup failed:", msg);
    console.error("[Listener] To retry: delete ~/.ai-office/state/.onboarded and restart the listener.");
    console.error("");
  }
}

// ── Message Queue — process one message at a time ────────────────────────────

const messageQueue: Message[] = [];
let processing = false;

async function enqueueMessage(message: Message): Promise<void> {
  // Safety checks (fast, before queuing)
  if (message.author.bot) return;
  if (!(message.channel instanceof TextChannel)) return;
  if (message.channel.name !== GENERAL_CHANNEL) return;
  if (!message.content.trim()) return;

  messageQueue.push(message);
  console.log(`[Listener] Queued message from ${message.author.username} (queue size: ${messageQueue.length})`);

  if (!processing) {
    await drainQueue();
  }
}

async function drainQueue(): Promise<void> {
  processing = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift()!;
    try {
      await handleMessage(msg);
    } catch (err) {
      console.error("[Listener] Unhandled error in handleMessage:", err);
    }
  }
  processing = false;
}

// ── Handle incoming user message ──────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  const userContent = message.content.trim();
  const channel = message.channel as TextChannel;

  console.log(
    `[Listener] Processing message from ${message.author.username}: ${userContent.substring(0, 80)}`
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
  //    Claude sends responses directly via MCP send_message tool during execution.
  //    We do NOT post stdout to Discord — that caused duplicate/out-of-order messages.
  try {
    const output = await runClaude(prompt);
    if (output) {
      console.log("[Listener] Claude output (not posted to Discord):", output.substring(0, 200));
    }
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

  // 4. Replace ⏳ with ✅ (add ✅ first so there's no gap)
  try {
    await message.react("✅");
  } catch (err) {
    console.warn("[Listener] Could not add ✅ reaction:", err);
  }
  await removeReaction(message, "⏳");
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
    "IMPORTANT: Use the send_message MCP tool to respond to the user in #general. " +
    "Do NOT return text output — your stdout is not posted to Discord. " +
    "Keep each message under 1800 characters. " +
    "Use your MCP tools (coordination, discord) as needed."
  );
}

/**
 * Remove a specific reaction emoji from a message (best-effort).
 */
async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    // Fetch fresh reaction data instead of relying on potentially stale cache
    const fetched = await message.fetch();
    const reaction = fetched.reactions.cache.get(emoji);
    if (reaction) {
      await reaction.users.remove(message.client.user!.id);
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

  // Start Pixel Office server in background (for ngrok + visualization)
  const pixelServerPath = path.join(PROJECT_DIR, "pixel-office", "server", "index.ts");
  const pixelPidFile = path.join(PROJECT_DIR, "pixel-office", "pixel.pid");
  if (fs.existsSync(pixelServerPath)) {
    // Check if already running (via PID file)
    let alreadyRunning = false;
    if (fs.existsSync(pixelPidFile)) {
      try {
        const oldPid = parseInt(fs.readFileSync(pixelPidFile, "utf-8").trim(), 10);
        process.kill(oldPid, 0); // Test if process exists
        alreadyRunning = true;
        console.log(`[Listener] Pixel Office already running (PID ${oldPid})`);
      } catch {
        // PID file stale — process not running
      }
    }

    if (!alreadyRunning) {
      console.log("[Listener] Starting Pixel Office server...");
      const npxPath = path.join(PROJECT_DIR, "pixel-office", "node_modules", ".bin", "tsx");
      const pixelProc = spawn(npxPath, [pixelServerPath], {
        cwd: path.join(PROJECT_DIR, "pixel-office"),
        env: { ...process.env },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      pixelProc.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log("[PixelOffice]", line);
      });
      pixelProc.unref();

      // Save PID for cleanup
      if (pixelProc.pid) {
        fs.writeFileSync(pixelPidFile, String(pixelProc.pid), "utf-8");
        console.log(`[Listener] Pixel Office started (PID ${pixelProc.pid})`);
      }

      // Give it a moment to start + open ngrok tunnel
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  // Set the listener's client as the shared singleton so approval-manager
  // can use findTextChannel to update approval messages after button clicks.
  setDiscordClient(client);

  // Register approval button handler on the listener's client (persistent process)
  registerApprovalInteractionHandler(client);

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Listener] Bot ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[Listener] Serving ${readyClient.guilds.cache.size} guild(s)`);
    console.log(`[Listener] Listening for messages in #${GENERAL_CHANNEL}`);

    // First-run: Leader will create channels + post welcome via claude -p
    await checkFirstRun();
  });

  client.on(Events.MessageCreate, (message) => {
    enqueueMessage(message).catch((err) => {
      console.error("[Listener] Unhandled error in enqueueMessage:", err);
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
