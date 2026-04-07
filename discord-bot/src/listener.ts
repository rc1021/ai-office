/**
 * listener.ts — Standalone Discord Bot Daemon
 *
 * Thin shell: connects to Discord, delegates core logic to @ai-office/core.
 * This is the entry point for the Discord listener daemon.
 *
 * Start with: node discord-bot/dist/listener.js
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
import { DiscordChatAdapter } from "./discord-adapter.js";
import {
  loadOfficeConfig,
  runClaude,
  HeartbeatScheduler,
  COLORS,
} from "@ai-office/core";
import type { ClaudeRunnerConfig } from "@ai-office/core";

// ── Resolve project root (two levels up from dist/listener.js) ────────────────

const __filename = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(__filename);
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");   // discord-bot/
const PROJECT_DIR = path.resolve(DISCORD_BOT_DIR, ".."); // repo root

const MCP_CONFIG = path.join(PROJECT_DIR, ".mcp.json");
const ONBOARDED_FLAG = path.join(PROJECT_DIR, ".ai-office", "state", ".onboarded");
const GENERAL_CHANNEL = "general";

console.log("[Listener] Project dir:", PROJECT_DIR);
console.log("[Listener] MCP config:", MCP_CONFIG);

// ── Allowed tools for Leader ─────────────────────────────────────────────────

const ALLOWED_TOOLS = [
  "Agent",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
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

const CLAUDE_CONFIG: ClaudeRunnerConfig = {
  projectDir: PROJECT_DIR,
  mcpConfigPath: MCP_CONFIG,
  allowedTools: ALLOWED_TOOLS,
};

const STARTUP_CHECKLIST_PROMPT =
  "You are the AI Office Leader. This is the first launch. " +
  "Follow your Startup Checklist in agents/leader/CLAUDE.md: " +
  "initialize the orchestrator, report status, setup Discord server channels, " +
  "check for interrupted tasks, " +
  "and run the Welcome Flow to greet the user in #general.";

// ── First-run check ───────────────────────────────────────────────────────────

async function checkFirstRun(): Promise<void> {
  if (fs.existsSync(ONBOARDED_FLAG)) {
    console.log("[Listener] Already onboarded, skipping first-run flow.");
    return;
  }

  console.log("");
  console.log("[Listener] First run detected! Setting up AI Office...");
  console.log("");

  try {
    const response = await runClaude(STARTUP_CHECKLIST_PROMPT, CLAUDE_CONFIG);
    console.log("[Listener] Setup complete! Check Discord #general.");
    if (response) {
      console.log("[Listener] Leader output:", response.substring(0, 300));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] First-run setup failed:", msg);
  }
}

// ── Message Queue — process one message at a time ────────────────────────────

const messageQueue: Message[] = [];
let processing = false;
const processedMessageIds = new Set<string>();

async function enqueueMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!(message.channel instanceof TextChannel)) return;
  if (message.channel.name !== GENERAL_CHANNEL) return;
  if (!message.content.trim()) return;

  // Dedup: Discord may fire MessageCreate multiple times
  if (processedMessageIds.has(message.id)) return;
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 200) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }

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

  console.log(`[Listener] Processing message from ${message.author.username}: ${userContent.substring(0, 80)}`);

  // 1. Acknowledge with ⏳
  try { await message.react("⏳"); } catch { /* non-fatal */ }

  // 2. Resolve reply context (if user replied to a message)
  //    Extract text + embeds, save full content as file, put brief in prompt
  let replyContext = "";
  if (message.reference?.messageId) {
    try {
      const replied = await channel.messages.fetch(message.reference.messageId);
      const replyAuthor = replied.member?.displayName ?? replied.author.displayName ?? replied.author.username;

      // Build full content: text + embeds
      const parts: string[] = [];
      if (replied.content) parts.push(replied.content);
      for (const embed of replied.embeds) {
        const embedParts: string[] = [];
        if (embed.title) embedParts.push(`## ${embed.title}`);
        if (embed.description) embedParts.push(embed.description);
        for (const field of embed.fields) {
          embedParts.push(`**${field.name}**: ${field.value}`);
        }
        if (embed.footer?.text) embedParts.push(`_${embed.footer.text}_`);
        if (embedParts.length > 0) parts.push(embedParts.join("\n"));
      }
      const fullContent = parts.join("\n\n");
      if (fullContent) {
        const brief = fullContent.length > 200
          ? fullContent.substring(0, 200) + "..."
          : fullContent;

        // Save full reply content as file
        const replyDir = path.join(PROJECT_DIR, ".ai-office", "shared", "inbox", "reply-context");
        fs.mkdirSync(replyDir, { recursive: true });
        const replyFile = path.join(replyDir, `${message.reference.messageId}.md`);
        fs.writeFileSync(replyFile, `# Reply from ${replyAuthor}\n\n${fullContent}`, "utf-8");

        replyContext = `\n\nThis message is a REPLY to a previous message:\n` +
          `Reply-to author: ${replyAuthor}\n` +
          `Reply-to brief: ${brief}\n` +
          `Full content saved at: ${replyFile} (use Read tool if you need the complete text)\n`;
      }
    } catch { /* non-fatal — original message may be deleted */ }
  }

  // 3. Save attachments (files, images, PDFs) to shared/inbox for agents to Read
  const savedAttachments: string[] = [];
  if (message.attachments.size > 0) {
    const inboxDir = path.join(PROJECT_DIR, ".ai-office", "shared", "inbox", "user-uploads");
    fs.mkdirSync(inboxDir, { recursive: true });

    for (const [, attachment] of message.attachments) {
      try {
        const res = await fetch(attachment.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, "_") ?? "file";
        const filePath = path.join(inboxDir, `${Date.now()}-${safeName}`);
        fs.writeFileSync(filePath, buffer);
        savedAttachments.push(filePath);
        console.log(`[Listener] Saved attachment: ${filePath} (${buffer.length} bytes)`);
      } catch (err) {
        console.warn(`[Listener] Failed to save attachment ${attachment.name}:`, err);
      }
    }
  }

  // 4. Build prompt + run claude -p
  // Prefer server nickname > global display name > username
  const displayName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
  const prompt = buildPrompt(displayName, userContent, replyContext, savedAttachments);

  try {
    const output = await runClaude(prompt, CLAUDE_CONFIG);
    if (output) {
      console.log("[Listener] Claude output (not posted to Discord):", output.substring(0, 200));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] claude failed:", errMsg);

    await removeReaction(message, "⏳");
    await channel
      .send(`❌ Error processing your request: ${errMsg.substring(0, 1000)}`)
      .catch((e) => console.error("[Listener] Failed to send error:", e));
    return;
  }

  // 3. Replace ⏳ with ✅
  try { await message.react("✅"); } catch { /* non-fatal */ }
  await removeReaction(message, "⏳");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(
  username: string,
  content: string,
  replyContext: string = "",
  attachments: string[] = [],
): string {
  let attachmentInfo = "";
  if (attachments.length > 0) {
    attachmentInfo = "\n\nUser uploaded files (saved to disk — use Read tool to access):\n" +
      attachments.map(p => `- ${p}`).join("\n") + "\n";
  }

  return (
    "You are the AI Office Leader. A user has sent you a message in Discord #general.\n" +
    "\n" +
    "User: " + username + "\n" +
    "--- BEGIN MESSAGE ---\n" +
    content + "\n" +
    "--- END MESSAGE ---\n" +
    replyContext +
    attachmentInfo +
    "\n" +
    "Process this request according to your role instructions (agents/leader/CLAUDE.md). " +
    "Read agents/leader/CLAUDE.md first for your full identity and instructions.\n" +
    "RULES:\n" +
    "- Use send_message MCP tool to respond in #general. stdout is NOT posted to Discord.\n" +
    "- Long messages are auto-paginated — just send the full content in one call.\n" +
    "- When spawning workers via Agent tool, include in their prompt: " +
    "'FORBIDDEN: Do NOT call send_message, send_embed, or any mcp__ai-office-discord__ tool.'\n" +
    "- Do NOT register new agents with report_status — only use existing agents from list_agents.\n" +
    "- Every task you create MUST be closed with task_update(status: completed) before you exit.\n" +
    "- Call report_status(busy) at start, report_status(idle) at end.\n" +
    "- Call task_checkpoint with context_summary before exiting."
  );
}

async function removeReaction(message: Message, emoji: string): Promise<void> {
  try {
    const encodedEmoji = encodeURIComponent(emoji);
    await message.client.rest.delete(
      `/channels/${message.channelId}/messages/${message.id}/reactions/${encodedEmoji}/@me`
    );
  } catch { /* non-fatal */ }
}

async function postNgrokUrl(readyClient: import("discord.js").Client<true>): Promise<void> {
  const ngrokFile = path.join(PROJECT_DIR, ".ai-office", "state", "ngrok-url.txt");
  let url = "";
  if (fs.existsSync(ngrokFile)) {
    url = fs.readFileSync(ngrokFile, "utf-8").trim();
  }
  if (!url) {
    console.log("[Listener] No ngrok URL found — skipping #general post.");
    return;
  }

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return;

  try {
    const guild = await readyClient.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const general = channels.find(
      (ch) => ch !== null && "name" in ch && ch.name === "general"
    );
    if (general && general.isTextBased()) {
      await (general as TextChannel).send(`🌐 **Pixel Office** is online: ${url}`);
      console.log(`[Listener] Posted ngrok URL to #general: ${url}`);
    }
  } catch (err) {
    console.warn("[Listener] Failed to post ngrok URL:", err);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error("[Listener] DISCORD_BOT_TOKEN is not set.");
    process.exit(1);
  }
  if (!process.env.DISCORD_GUILD_ID) {
    console.error("[Listener] DISCORD_GUILD_ID is not set.");
    process.exit(1);
  }

  console.log("[Listener] Starting AI Office Discord Listener...");

  // Start Pixel Office server in background
  const pixelServerPath = path.join(PROJECT_DIR, "pixel-office", "server", "index.ts");
  const pixelPidFile = path.join(PROJECT_DIR, "pixel-office", "pixel.pid");
  if (fs.existsSync(pixelServerPath)) {
    let alreadyRunning = false;
    if (fs.existsSync(pixelPidFile)) {
      try {
        const oldPid = parseInt(fs.readFileSync(pixelPidFile, "utf-8").trim(), 10);
        process.kill(oldPid, 0);
        alreadyRunning = true;
        console.log(`[Listener] Pixel Office already running (PID ${oldPid})`);
      } catch { /* PID stale */ }
    }

    if (!alreadyRunning) {
      console.log("[Listener] Starting Pixel Office server...");
      const npxPath = path.join(PROJECT_DIR, "pixel-office", "node_modules", ".bin", "tsx");
      const pixelProc = spawn(npxPath, [pixelServerPath], {
        cwd: path.join(PROJECT_DIR, "pixel-office"),
        env: { ...process.env, PROJECT_DIR },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      });
      pixelProc.stderr?.on("data", (data: Buffer) => {
        const line = data.toString().trim();
        if (line) console.log("[PixelOffice]", line);
      });
      pixelProc.unref();
      if (pixelProc.pid) {
        fs.writeFileSync(pixelPidFile, String(pixelProc.pid), "utf-8");
        console.log(`[Listener] Pixel Office started (PID ${pixelProc.pid})`);
      }
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

  setDiscordClient(client);
  registerApprovalInteractionHandler(client);

  // Subsystem instances
  let heartbeat: HeartbeatScheduler | null = null;

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Listener] Bot ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[Listener] Listening for messages in #${GENERAL_CHANNEL}`);

    await checkFirstRun();
    await postNgrokUrl(readyClient);

    // Start core subsystems with Discord adapter
    try {
      const config = loadOfficeConfig(PROJECT_DIR);
      const adapter = new DiscordChatAdapter();

      heartbeat = new HeartbeatScheduler(
        config.timezone, config.statePath, PROJECT_DIR, CLAUDE_CONFIG, adapter,
        config.dailyBriefTime, config.audit,
      );
      heartbeat.start();
      console.log("[Listener] HeartbeatScheduler started");
    } catch (err) {
      console.error("[Listener] Failed to start subsystems:", err);
    }
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

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Listener] Received ${signal}. Shutting down...`);
    if (heartbeat) heartbeat.stop();
    client.destroy();
    console.log("[Listener] Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    console.error("[Listener] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[Listener] Unhandled promise rejection:", reason);
  });

  try {
    await client.login(token);
    console.log("[Listener] Discord login initiated.");
  } catch (err) {
    console.error("[Listener] Failed to log into Discord:", err);
    process.exit(1);
  }
}

main();
