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
import { registerApprovalInteractionHandler, setApprovalResolvedCallback, runTimeoutSweep, recoverPendingApprovals } from "./approval-manager.js";
import type { ApprovalRequest } from "./types.js";
import { setDiscordClient, getDiscordClient } from "./discord-client.js";
import { DiscordChatAdapter } from "./discord-adapter.js";
import {
  loadOfficeConfig,
  runClaude,
  HeartbeatScheduler,
  SessionStore,
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
  "mcp__ai-office-discord__read_message_by_id",
  "mcp__ai-office-discord__create_thread",
  "mcp__ai-office-discord__send_thread_message",
  "mcp__ai-office-discord__create_approval",
  "mcp__ai-office-discord__check_approval",
  "mcp__ai-office-discord__register_agent",
  "mcp__ai-office-discord__list_channels",
];

// Default timeout: 8 minutes. Claude -p sessions on complex tasks can take several minutes,
// but 8 min is a safe upper bound. If the process hangs past this, surface a visible error.
const CLAUDE_TIMEOUT_MS = 8 * 60 * 1000;

const BASE_CLAUDE_CONFIG: ClaudeRunnerConfig = {
  projectDir: PROJECT_DIR,
  mcpConfigPath: MCP_CONFIG,
  allowedTools: ALLOWED_TOOLS,
  timeoutMs: CLAUDE_TIMEOUT_MS,
};

// Will be set to include model once config is loaded in ClientReady
let leaderClaudeConfig: ClaudeRunnerConfig = BASE_CLAUDE_CONFIG;

// Session store — persists claude --resume session IDs per user per channel
const sessionStore = new SessionStore(
  path.join(PROJECT_DIR, ".ai-office", "state", "sessions.json")
);

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
    const response = await runClaude(STARTUP_CHECKLIST_PROMPT, leaderClaudeConfig);
    console.log("[Listener] Setup complete! Check Discord #general.");
    if (response.output) {
      console.log("[Listener] Leader output:", response.output.substring(0, 300));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] First-run setup failed:", msg);
  }
}

// ── Job Queue — semaphore-based parallel pool (configurable via office.yaml) ──

interface QueueJob {
  type: "message" | "approval";
  message?: Message;
  approval?: ApprovalRequest;
}

const jobQueue: QueueJob[] = [];
let activeJobs = 0;
let maxConcurrent = 1; // default sequential; updated from config after ClientReady
let workerModel = "sonnet"; // default worker model; updated from config after ClientReady
const processedMessageIds = new Set<string>();

/**
 * Called once after office config is loaded to set the concurrency limit.
 * When executionMode is "sequential", maxConcurrent is clamped to 1.
 */
function initConcurrency(executionMode: "sequential" | "parallel", limit: number): void {
  maxConcurrent = executionMode === "parallel" ? Math.max(1, limit) : 1;
  console.log(`[Listener] Concurrency mode: ${executionMode}, maxConcurrent: ${maxConcurrent}`);
}

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

  jobQueue.push({ type: "message", message });
  console.log(`[Listener] Queued message from ${message.author.username} (queue size: ${jobQueue.length}, active: ${activeJobs}/${maxConcurrent})`);

  // Acknowledge immediately so the user sees ⏳ even if the job has to wait in queue
  try { await message.react("⏳"); } catch { /* non-fatal */ }

  processQueue();
}

function enqueueApprovalTrigger(approval: ApprovalRequest): void {
  jobQueue.push({ type: "approval", approval });
  console.log(`[Listener] Queued approval trigger for ${approval.id} (${approval.status}) (queue size: ${jobQueue.length}, active: ${activeJobs}/${maxConcurrent})`);

  processQueue();
}

/**
 * Drain the queue up to maxConcurrent active jobs.
 * Each completed job calls processQueue() again to pick up the next item.
 */
function processQueue(): void {
  while (jobQueue.length > 0 && activeJobs < maxConcurrent) {
    const job = jobQueue.shift()!;
    activeJobs++;
    processJob(job).finally(() => {
      activeJobs--;
      processQueue(); // try to pick up the next job
    });
  }
}

async function processJob(job: QueueJob): Promise<void> {
  try {
    if (job.type === "message" && job.message) {
      await handleMessage(job.message);
    } else if (job.type === "approval" && job.approval) {
      await handleApproval(job.approval);
    }
  } catch (err) {
    console.error("[Listener] Unhandled error in processJob:", err);
  }
}

// ── Handle incoming user message ──────────────────────────────────────────────

async function handleMessage(message: Message): Promise<void> {
  const userContent = message.content.trim();
  const channel = message.channel as TextChannel;

  console.log(`[Listener] Processing message from ${message.author.username}: ${userContent.substring(0, 80)}`);

  // 1. (⏳ already added at enqueue time in enqueueMessage)

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
  const prompt = buildPrompt(displayName, userContent, message.id, replyContext, savedAttachments, workerModel);

  // Resolve session key and attach existing session ID for --resume
  const sessionKey = `channel:${message.channelId}:${message.author.id}`;
  const existingSessionId = sessionStore.get(sessionKey);
  const sessionConfig = existingSessionId
    ? { ...leaderClaudeConfig, resumeSessionId: existingSessionId }
    : leaderClaudeConfig;

  let claudeSucceeded = false;
  try {
    const result = await runClaude(prompt, sessionConfig);
    claudeSucceeded = true;

    // Persist the returned session ID for the next message from this user
    if (result.sessionId) {
      sessionStore.upsert(sessionKey, result.sessionId);
    }

    if (result.output) {
      console.log("[Listener] Claude output (not posted to Discord):", result.output.substring(0, 200));
    }

    // Fallback guard: if the claude process exited cleanly but the output strongly suggests
    // the Leader never sent a reply (e.g. OutputGate blocked it or it wrote to stdout instead
    // of calling send_message), surface a visible warning so the user is not left in silence.
    const out = result.output ?? "";
    const looksLikeUnsentReply =
      out.length > 40 &&
      !/send_message|sent to #|Message sent|BUFFERED/i.test(out) &&
      // Heuristic: plain prose output longer than 80 chars is likely meant for the user
      /[\u4e00-\u9fff]|[a-z]{4,}/i.test(out);

    if (looksLikeUnsentReply) {
      console.warn("[Listener] Leader output looks like an unsent reply — forwarding to Discord as fallback");
      // Truncate to 1800 chars to leave room for the warning prefix
      const truncated = out.length > 1800 ? out.substring(0, 1800) + "…" : out;
      await channel
        .send(`⚠️ *(fallback — Leader reply not sent via MCP)*\n\n${truncated}`)
        .catch((e) => console.error("[Listener] Failed to send fallback:", e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] claude failed:", errMsg);

    await removeReaction(message, "⏳");
    const isTimeoutError = errMsg.startsWith("TIMEOUT:");
    const isAuthError = errMsg.startsWith("AUTH_EXPIRED:");
    const userMsg = isAuthError
      ? "🔐 Claude authentication expired. Please run `/login` to re-authenticate, then retry."
      : isTimeoutError
        ? "⏱️ Request timed out — the Leader took too long to respond. Please try again."
        : `❌ Error processing your request: ${errMsg.substring(0, 1000)}`;
    await channel
      .send(userMsg)
      .catch((e) => console.error("[Listener] Failed to send error:", e));
    return;
  }

  // Replace ⏳ with ✅ only when claude completed without error
  if (claudeSucceeded) {
    try { await message.react("✅"); } catch { /* non-fatal */ }
    await removeReaction(message, "⏳");
  }
}

// ── Handle approval resolution ────────────────────────────────────────────────

async function handleApproval(approval: ApprovalRequest): Promise<void> {
  console.log(`[Listener] Processing approval trigger: ${approval.id} (${approval.status})`);

  const prompt = buildApprovalPrompt(approval, workerModel);

  try {
    const result = await runClaude(prompt, leaderClaudeConfig);
    if (result.output) {
      console.log("[Listener] Claude approval output (not posted to Discord):", result.output.substring(0, 200));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] claude failed for approval trigger:", errMsg);
    const isAuthError = errMsg.startsWith("AUTH_EXPIRED:");
    const isTimeoutError = errMsg.startsWith("TIMEOUT:");
    if (isAuthError || isTimeoutError) {
      try {
        const dc = getDiscordClient();
        const ch = dc.channels.cache.find(
          (c) => c.isTextBased() && "name" in c && c.name === GENERAL_CHANNEL
        ) as TextChannel | undefined;
        const msg = isAuthError
          ? "🔐 Claude authentication expired. Please run `/login` to re-authenticate."
          : "⏱️ Approval processing timed out. Please retry or check the task status.";
        await ch?.send(msg);
      } catch { /* non-fatal */ }
    }
  }
}

function buildApprovalPrompt(approval: ApprovalRequest, workerModelOverride?: string): string {
  const resolvedBy = approval.resolvedBy ?? "unknown";
  const resolvedAt = approval.resolvedAt ? approval.resolvedAt.toISOString() : "unknown";
  const modelHint = workerModelOverride ?? "sonnet";

  return (
    "You are the AI Office Leader. An approval has been resolved in Discord.\n" +
    "\n" +
    // ── Critical constraint — stated FIRST (same reason as buildPrompt) ──
    "⚠️  CRITICAL: Your text output (stdout / result field) is NEVER shown to the user.\n" +
    "You MUST call the send_message MCP tool to post your response to Discord.\n" +
    "Do NOT write your answer as text output — write it ONLY via send_message.\n" +
    "\n" +
    // ── Mandatory execution steps ──
    "Execute these steps IN ORDER:\n" +
    "1. Call report_status with status 'busy'.\n" +
    "2. Read agents/leader/CLAUDE.md for your full identity and instructions.\n" +
    "3. Execute or acknowledge the approval (see details below).\n" +
    "4. Call send_message to inform the user in #general.\n" +
    "5. Call task_checkpoint with a context_summary.\n" +
    "6. Call report_status with status 'idle'.\n" +
    "\n" +
    // ── Approval payload ──
    `Approval ID: ${approval.id}\n` +
    `Status: ${approval.status}\n` +
    `Action: ${approval.action}\n` +
    `Description: ${approval.description}\n` +
    `Risk Level: ${approval.riskLevel}\n` +
    `Resolved By: ${resolvedBy}\n` +
    `Resolved At: ${resolvedAt}\n` +
    "\n" +
    "If APPROVED: execute the action described above.\n" +
    "If REJECTED: acknowledge the rejection and inform the user.\n" +
    "\n" +
    // ── Additional rules ──
    "Additional rules:\n" +
    "- Long messages are auto-paginated — just send the full content in one call.\n" +
    "- When spawning workers via Agent tool, include in their prompt: " +
    "'FORBIDDEN: Do NOT call send_message, send_embed, or any mcp__ai-office-discord__ tool.'\n" +
    "- Do NOT register new agents with report_status — only use existing agents from list_agents.\n" +
    "- Every task you create MUST be closed with task_update(status: completed) before you exit.\n" +
    `\nDefault worker model: ${modelHint}. Use this when calling Agent tool unless task complexity requires override.\n`
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrompt(
  username: string,
  content: string,
  messageId: string,
  replyContext: string = "",
  attachments: string[] = [],
  workerModelOverride?: string,
): string {
  let attachmentInfo = "";
  if (attachments.length > 0) {
    attachmentInfo = "\n\nUser uploaded files (saved to disk — use Read tool to access):\n" +
      attachments.map(p => `- ${p}`).join("\n") + "\n";
  }
  const modelHint = workerModelOverride ?? "sonnet";

  // ⚠️  PROMPT STRUCTURE NOTE
  // The send_message requirement is stated BEFORE "read CLAUDE.md" intentionally.
  // claude -p --output-format json always writes a `result` text field to stdout.
  // That result field is NEVER shown to the user — only send_message reaches Discord.
  // If the Leader writes its reply as text output (stdout) instead of calling
  // send_message, the user sees nothing. We put the critical constraint first so
  // the model cannot shortcut past it even for simple/quick answers.
  return (
    "You are the AI Office Leader. A user has sent you a message in Discord #general.\n" +
    "\n" +
    // ── Critical constraint — stated FIRST, before any other instruction ──
    "⚠️  CRITICAL: Your text output (stdout / result field) is NEVER shown to the user.\n" +
    "You MUST call the send_message MCP tool to post your reply to Discord.\n" +
    "Do NOT write your answer as text output — write it ONLY via send_message.\n" +
    "Even for a one-line answer, you must call send_message.\n" +
    "\n" +
    // ── Mandatory execution steps ──
    "Execute these steps IN ORDER — do not skip any:\n" +
    "1. Call report_status with status 'busy'.\n" +
    "2. Read agents/leader/CLAUDE.md for your full identity and instructions.\n" +
    "3. Process the user request (delegate to workers if needed).\n" +
    "4. Call send_message to post your reply to #general, using reply_to_message_id: " + messageId + ".\n" +
    "5. Call task_checkpoint with a context_summary of what was done.\n" +
    "6. Call report_status with status 'idle'.\n" +
    "\n" +
    // ── Message payload ──
    "User: " + username + "\n" +
    "--- BEGIN MESSAGE ---\n" +
    content + "\n" +
    "--- END MESSAGE ---\n" +
    replyContext +
    attachmentInfo +
    "\n" +
    // ── Additional rules ──
    "Additional rules:\n" +
    "- Long messages are auto-paginated — just send the full content in one call.\n" +
    "- When spawning workers via Agent tool, include in their prompt: " +
    "'FORBIDDEN: Do NOT call send_message, send_embed, or any mcp__ai-office-discord__ tool.'\n" +
    "- Do NOT register new agents with report_status — only use existing agents from list_agents.\n" +
    "- Every task you create MUST be closed with task_update(status: completed) before you exit.\n" +
    `\nDefault worker model: ${modelHint}. Use this when calling Agent tool unless task complexity requires override.\n`
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

// ── Module-level state for shard reconnect tracking ───────────────────────────

let reconnectAttempts = 0;
let lastReconnectAt = 0;
let isShuttingDown = false;

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
  setApprovalResolvedCallback((approval) => {
    enqueueApprovalTrigger(approval);
  });

  // Subsystem instances
  let heartbeat: HeartbeatScheduler | null = null;

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Listener] Bot ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[Listener] Listening for messages in #${GENERAL_CHANNEL}`);

    // Start core subsystems with Discord adapter
    try {
      const config = loadOfficeConfig(PROJECT_DIR);

      // Initialize concurrency from config (parallel vs sequential)
      initConcurrency(config.executionMode, config.maxConcurrent);

      // Set model-aware configs from office.yaml
      leaderClaudeConfig = { ...BASE_CLAUDE_CONFIG, model: config.models.leader };
      workerModel = config.models.worker;
      console.log(`[Listener] Leader model: ${config.models.leader}, Worker model: ${config.models.worker}`);

      // Recover orphan pending approvals from before daemon restart
      await recoverPendingApprovals(client).catch(err => console.warn('[Listener] recoverPendingApprovals failed:', err));

      await checkFirstRun();
      await postNgrokUrl(readyClient);

      const adapter = new DiscordChatAdapter();

      const dailyBriefConfig: ClaudeRunnerConfig = { ...BASE_CLAUDE_CONFIG, model: config.models.dailyBrief };
      const auditClaudeConfig: ClaudeRunnerConfig = { ...BASE_CLAUDE_CONFIG, model: config.models.auditor };

      heartbeat = new HeartbeatScheduler(
        config.timezone, config.statePath, PROJECT_DIR, dailyBriefConfig, adapter,
        config.dailyBriefTime, config.audit, auditClaudeConfig,
      );
      heartbeat.start();
      console.log("[Listener] HeartbeatScheduler started");

      sessionStore.start();
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

  // discord.js v14 不可恢復的 close codes
  const FATAL_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014];

  client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
    console.error(`[Listener] Shard ${shardId} disconnected. Close code: ${closeEvent.code}`);
    if (FATAL_CLOSE_CODES.includes(closeEvent.code)) {
      console.error(`[Listener] Fatal close code ${closeEvent.code} — exiting for supervisor restart`);
      process.exit(1);
    }
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`[Listener] Shard ${shardId} reconnecting...`);
    reconnectAttempts++;
    lastReconnectAt = Date.now();
  });

  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    console.log(`[Listener] Shard ${shardId} resumed. Replayed ${replayedEvents} events`);
    reconnectAttempts = 0;
    lastReconnectAt = 0;
  });

  client.on(Events.ShardError, (error, shardId) => {
    console.error(`[Listener] Shard ${shardId} error:`, error.message);
  });

  client.on(Events.ShardReady, (shardId) => {
    console.log(`[Listener] Shard ${shardId} ready`);
  });

  client.on(Events.Invalidated, () => {
    console.error("[Listener] Session invalidated — exiting for supervisor restart");
    process.exit(1);
  });

  // Keepalive timer handle — assigned after client.login(); declared here so
  // shutdown() can close over the binding.
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return; // 避免重複 shutdown
    isShuttingDown = true;
    console.log(`\n[Listener] Received ${signal}. Shutting down...`);
    if (keepaliveTimer !== undefined) clearInterval(keepaliveTimer);
    if (heartbeat) heartbeat.stop();
    sessionStore.stop();
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

  process.on("beforeExit", (code) => {
    if (isShuttingDown) return; // 正常 shutdown，不干預
    console.error(`[Listener] Event loop drained unexpectedly (code=${code}) — exiting with code 1`);
    process.exit(1); // 讓 supervisor 重啟
  });

  process.on("exit", (code) => {
    const ts = new Date().toISOString();
    try {
      fs.appendFileSync(
        path.join(__discord_bot_dir, "listener.exit.log"),
        `${ts} exit code=${code} shuttingDown=${isShuttingDown}\n`
      );
    } catch { /* best effort */ }
  });

  try {
    await client.login(token);
    console.log("[Listener] Discord login initiated.");
  } catch (err) {
    console.error("[Listener] Failed to log into Discord:", err);
    process.exit(1);
  }

  // 保持 event loop 活著，同時偵測重連卡住
  const KEEPALIVE_INTERVAL_MS = 30_000;
  const RECONNECT_STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 分鐘

  keepaliveTimer = setInterval(() => {
    if (reconnectAttempts > 0 && lastReconnectAt > 0) {
      const elapsed = Date.now() - lastReconnectAt;
      if (elapsed > RECONNECT_STUCK_THRESHOLD_MS) {
        console.error(`[Listener] Reconnect stuck for ${Math.round(elapsed / 60000)} min — force exit`);
        process.exit(1);
      }
    }
    // Sweep for timed-out approvals (fire and forget)
    runTimeoutSweep();
  }, KEEPALIVE_INTERVAL_MS);
  // 不用 .unref() — 我們就是要它防止 event loop 排空
}

main();
