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
import os from "node:os";
import { fileURLToPath } from "node:url";
import * as prism from "prism-media";
import { whisper } from "whisper-node";
import Database from "better-sqlite3";

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
import {
  registerOnboardingInteractionHandler,
  startOnboarding,
  recoverOnboardingState,
  isAwaitingUserInput,
  handleUserMessage as onboardingHandleUserMessage,
} from "./onboarding-manager.js";
import { handleOfficeCommand } from "./interactions/officeCommand.js";
import { handleOfficeInteraction } from "./interactions/officeInteractionHandler.js";
import { registerOfficeCommands } from "./registerCommands.js";
import type { ApprovalRequest } from "./types.js";
import { setDiscordClient, getDiscordClient } from "./discord-client.js";
import {
  handleVoiceStateUpdate,
  setVoiceTranscriptCallback,
  setWhisperLanguage,
} from "./voice-listener.js";
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

// ── Static system prompt (identity + output constraint) ───────────────────────
//
// Split into static vs dynamic to achieve two goals:
//   1. Pass via --system flag → Claude treats it as the system prompt (not user turn),
//      enabling prompt caching across session turns.
//   2. Keep injection surface minimal — dynamic content (username, message body) stays
//      in the per-request payload; sanitization targets only that payload.
//
// ⚠️  The CRITICAL constraint appears here (before the user payload) AND as a FINAL
// REMINDER at the end of the user payload (LLM recency bias). Both are intentional.
const LEADER_SYSTEM_PROMPT =
  "You are the AI Office Leader.\n" +
  "\n" +
  "⚠️  CRITICAL: Your text output (stdout / result field) is NEVER shown to the user.\n" +
  "You MUST call the send_message MCP tool to post your reply to Discord.\n" +
  "After calling send_message, your ONLY text output must be the single line: 'Message sent to Discord.'";

// No per-message timeout — claude-runner enforces a 2-hour absolute cap.
// Long tasks (multi-step, sub-agents) must not be killed by a wall-clock timer.
const BASE_CLAUDE_CONFIG: ClaudeRunnerConfig = {
  projectDir: PROJECT_DIR,
  mcpConfigPath: MCP_CONFIG,
  allowedTools: ALLOWED_TOOLS,
  systemPrompt: LEADER_SYSTEM_PROMPT,
};

// Will be set to include model once config is loaded in ClientReady
let leaderClaudeConfig: ClaudeRunnerConfig = BASE_CLAUDE_CONFIG;

// Session store — persists claude --resume session IDs per user per channel
const sessionStore = new SessionStore(
  path.join(PROJECT_DIR, ".ai-office", "state", "sessions.json")
);

// Role identity ("You are the AI Office Leader.") is in LEADER_SYSTEM_PROMPT (--system).
const STARTUP_CHECKLIST_PROMPT =
  "This is the first launch. " +
  "Follow your Startup Checklist in agents/leader/CLAUDE.md: " +
  "initialize the orchestrator, report status, setup Discord server channels, " +
  "check for interrupted tasks. " +
  "IMPORTANT: Do NOT run the Welcome Flow or send any welcome/greeting messages — " +
  "the Discord bot handles the interactive onboarding flow directly. " +
  "Your job is only: setup_server, report_status, check for pending tasks, then set status idle.";

// ── First-run check ───────────────────────────────────────────────────────────

async function checkFirstRun(): Promise<void> {
  if (fs.existsSync(ONBOARDED_FLAG)) {
    console.log("[Listener] Already onboarded, skipping first-run flow.");
    return;
  }

  console.log("");
  console.log("[Listener] First run detected! Setting up AI Office...");
  console.log("");

  // Start onboarding FIRST so state is saved and the button is clickable immediately.
  // The startup checklist (setup_server, report_status, etc.) runs in the background
  // and does not need to complete before the user can begin onboarding.
  await startOnboarding();

  runClaude(STARTUP_CHECKLIST_PROMPT, leaderClaudeConfig).then(response => {
    console.log("[Listener] Startup checklist complete.");
    if (response.output) {
      console.log("[Listener] Leader output:", response.output.substring(0, 300));
    }
  }).catch(err => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] First-run setup failed:", msg);
  });
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
let whisperLanguage = "zh"; // default; updated from office.yaml (language field) after ClientReady
const processedMessageIds = new Set<string>();

// Per-user processing lock: prevents two claude -p processes from running on the
// same session simultaneously (would corrupt --resume session state).
const userProcessing = new Set<string>();

/**
 * Map a tool name to a Pixel Office bubble text for the progress message.
 * Matches the tool→bubble mapping table in design_pixel_office_rewrite.md.
 */
function getToolBubbleText(toolName: string): string {
  if (toolName === "task_create" || toolName === "mcp__ai-office-coordination__task_create") return "📋 建立任務";
  if (toolName === "Agent") return "🤖 派工中";
  if (toolName === "mcp__ai-office-discord__send_message") return "💬 回覆用戶";
  if (toolName === "task_checkpoint" || toolName === "mcp__ai-office-coordination__task_checkpoint") return "✅ 完成一步!";
  if (toolName === "report_status" || toolName === "mcp__ai-office-coordination__report_status") return "📡 報告狀態";
  if (toolName === "list_agents" || toolName === "mcp__ai-office-coordination__list_agents") return "👥 確認成員";
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") return "📂 讀取文件";
  if (toolName === "Edit" || toolName === "Write") return "✏️ 修改程式";
  if (toolName === "Bash") return "⚙️ 執行指令";
  if (toolName === "task_resume" || toolName === "mcp__ai-office-coordination__task_resume") return "🔄 接續任務";
  if (toolName === "publish_artifact" || toolName === "mcp__ai-office-coordination__publish_artifact") return "📦 發布成果";
  if (
    toolName === "request_approval_escalation" ||
    toolName === "mcp__ai-office-coordination__request_approval_escalation"
  ) return "🙋 請求審核";
  const label = toolName.replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
  return `🔧 ${label}`;
}

/**
 * Called once after office config is loaded to set the concurrency limit.
 * When executionMode is "sequential", maxConcurrent is clamped to 1.
 */
function initConcurrency(executionMode: "sequential" | "parallel", limit: number): void {
  maxConcurrent = executionMode === "parallel" ? Math.max(1, limit) : 1;
  console.log(`[Listener] Concurrency mode: ${executionMode}, maxConcurrent: ${maxConcurrent}`);
}

/**
 * Poll the coordination DB audit_log for the most recent action.
 * Returns a short human-readable string, or null if unavailable.
 */
function queryLastAuditAction(): string | null {
  const dbPath = path.join(PROJECT_DIR, ".ai-office", "state", "coordination.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma("busy_timeout = 1000");
    const row = db.prepare(
      "SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1"
    ).get() as { action: string; detail: string } | undefined;
    db.close();
    if (!row) return null;
    const detail = row.detail.length > 60 ? row.detail.substring(0, 60) + "…" : row.detail;
    return `${row.action}: ${detail}`;
  } catch {
    return null;
  }
}

// ── Write PCM buffer as 16kHz mono 16-bit WAV ────────────────────────────────

function writePcmToWav(pcmChunks: Buffer[], outPath: string, sampleRate = 16000): void {
  const pcm = Buffer.concat(pcmChunks);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  fs.writeFileSync(outPath, Buffer.concat([header, pcm]));
}

async function enqueueMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!(message.channel instanceof TextChannel)) return;
  if (message.channel.name !== GENERAL_CHANNEL) return;
  const hasAudioAttachment = message.attachments.some(
    (a) => a.contentType?.startsWith("audio/")
  );
  if (!message.content.trim() && !hasAudioAttachment) return;

  // Dedup: Discord may fire MessageCreate multiple times
  if (processedMessageIds.has(message.id)) return;
  processedMessageIds.add(message.id);

  if (processedMessageIds.size > 200) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }

  // ── Onboarding intercept (Step 2: company description) ───────────────────
  // If we're waiting for the user to describe their company, handle it here
  // directly rather than going through Claude -p.
  if (isAwaitingUserInput()) {
    try { await message.react("⏳"); } catch { /* non-fatal */ }
    try {
      const handled = await onboardingHandleUserMessage(message);
      if (handled) {
        await removeReaction(message, "⏳");
        try { await message.react("✅"); } catch { /* non-fatal */ }
        return;
      }
    } catch (err) {
      console.error("[Listener] Onboarding message handler error:", err);
    }
    await removeReaction(message, "⏳");
  }

  jobQueue.push({ type: "message", message });
  console.log(`[Listener] Queued message from ${message.author.username} (queue size: ${jobQueue.length}, active: ${activeJobs}/${maxConcurrent})`);

  // Acknowledge immediately so the user sees ⏳ even if the job has to wait in queue
  try { await message.react("⏳"); } catch { /* non-fatal */ }

  processQueue();
}

function enqueueApprovalTrigger(approval: ApprovalRequest): void {
  // Approval is time-sensitive and doesn't use --resume, so bypass the job queue
  // and fire immediately as a concurrent async task.
  console.log(`[Listener] Firing approval trigger immediately: ${approval.id} (${approval.status})`);
  handleApproval(approval).catch((err) =>
    console.error("[Listener] Unhandled error in handleApproval:", err)
  );
}

/**
 * Drain the queue up to maxConcurrent active jobs.
 * Each completed job calls processQueue() again to pick up the next item.
 *
 * Per-user ordering guarantee: messages from a locked user are SKIPPED (not dropped)
 * so that other users' messages can still be processed. When the lock clears, the
 * next processQueue() call will pick up the waiting message.
 */
function processQueue(): void {
  let i = 0;
  while (activeJobs < maxConcurrent && i < jobQueue.length) {
    const job = jobQueue[i];
    // Skip messages from users whose session is currently being processed.
    // This preserves per-user ordering without dropping messages.
    if (job.type === "message" && job.message) {
      const lockKey = `channel:${job.message.channelId}:${job.message.author.id}`;
      if (userProcessing.has(lockKey)) {
        i++;
        continue;
      }
    }
    jobQueue.splice(i, 1); // dequeue this specific job
    activeJobs++;
    processJob(job).finally(() => {
      activeJobs--;
      processQueue(); // try to pick up the next job (including any skipped ones)
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
  const userLockKey = `channel:${message.channelId}:${message.author.id}`;

  // Per-user lock: if this user already has a claude -p running, re-enqueue instead
  // of dropping. processQueue() should have skipped this job, but guard just in case.
  // Two processes sharing the same --resume session would corrupt session state.
  if (userProcessing.has(userLockKey)) {
    console.warn(`[Listener] Per-user lock hit in handleMessage for ${message.author.username} — re-enqueueing (processQueue skipping logic may have missed this)`);
    jobQueue.unshift({ type: "message", message });
    return;
  }
  userProcessing.add(userLockKey);

  try {
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

  // 3b. Transcribe Discord native voice message (if present)
  let voiceTranscript = "";
  const voiceAttachment = message.attachments.find(
    (a) => a.contentType?.startsWith("audio/")
  );
  if (voiceAttachment) {
    try {
      console.log(`[Listener] Transcribing voice message from ${message.author.username}...`);
      const res = await fetch(voiceAttachment.url);
      const rawBuffer = Buffer.from(await res.arrayBuffer());

      // Save raw OGG to temp file, then convert to 16kHz mono WAV via ffmpeg.
      // Discord voice messages are OGG/Opus containers — prism.opus.Decoder expects
      // raw Opus frames, not the container, so ffmpeg is required here.
      const tmpOgg = path.join(os.tmpdir(), `voice-msg-${message.id}.ogg`);
      const tmpWav = path.join(os.tmpdir(), `voice-msg-${message.id}.wav`);
      fs.writeFileSync(tmpOgg, rawBuffer);

      const { spawnSync } = await import("node:child_process");
      const ffmpeg = spawnSync("ffmpeg", [
        "-i", tmpOgg,
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        tmpWav,
        "-y",
      ], { stdio: "pipe" });

      try { fs.unlinkSync(tmpOgg); } catch { /* best effort */ }

      if (ffmpeg.status === 0 && fs.existsSync(tmpWav)) {
        const result = await whisper(tmpWav, {
          modelName: "medium",
          whisperOptions: { language: whisperLanguage },
        });
        voiceTranscript = (result ?? []).map((s: { speech: string }) => s.speech).join(" ").trim();
        console.log(`[Listener] Voice message transcribed: "${voiceTranscript}"`);
      } else {
        console.error("[Listener] ffmpeg conversion failed:", ffmpeg.stderr?.toString());
      }
      try { fs.unlinkSync(tmpWav); } catch { /* best effort */ }
    } catch (err) {
      console.error("[Listener] Voice message transcription error:", err);
    }
  }

  // 4. Send progress message early so its ID can be included in the prompt.
  //    The Leader uses this ID to call edit_message for richer C-path updates.
  const startTime = Date.now();
  const PROGRESS_INTERVAL_MS = 2 * 60 * 1000;
  let progressMsg: Message | null = null;
  try {
    progressMsg = await channel.send("⏳ 處理中...");
  } catch { /* non-fatal */ }

  // 5. Build prompt + run claude -p
  // Prefer server nickname > global display name > username
  const displayName = message.member?.displayName ?? message.author.displayName ?? message.author.username;
  const effectiveContent = userContent || (voiceTranscript ? `[語音訊息] ${voiceTranscript}` : "");
  const prompt = buildPrompt(displayName, effectiveContent, message.id, replyContext, savedAttachments, workerModel, progressMsg?.id);

  // Resolve session key and attach existing session ID for --resume
  const sessionKey = `channel:${message.channelId}:${message.author.id}`;
  const existingSessionId = sessionStore.get(sessionKey);

  // onToolUse: fired immediately on each tool_use event from stream-json stdout.
  // Updates the progress message in real-time, faster than the 2-min interval fallback.
  // Also tracks whether send_message/send_embed was called (Layer 2: fallback guard).
  let lastToolName = "";
  let sendMessageCalled = false;
  const onToolUse = async (toolName: string): Promise<void> => {
    lastToolName = toolName;
    if (toolName === "mcp__ai-office-discord__send_message" || toolName === "mcp__ai-office-discord__send_embed") {
      sendMessageCalled = true;
    }
    if (!progressMsg) return;
    const elapsed = Math.round((Date.now() - startTime) / 60_000);
    const elapsedStr = elapsed > 0 ? ` (${elapsed} 分鐘)` : "";
    const bubbleText = getToolBubbleText(toolName);
    try {
      await progressMsg.edit(`⏳ 處理中${elapsedStr} — ${bubbleText}`);
    } catch { /* non-fatal */ }
  };

  const sessionConfig = existingSessionId
    ? { ...leaderClaudeConfig, resumeSessionId: existingSessionId, onToolUse }
    : { ...leaderClaudeConfig, onToolUse };

  const progressTimer = setInterval(async () => {
    if (!progressMsg) return;
    const elapsed = Math.round((Date.now() - startTime) / 60_000);
    const detail = lastToolName
      ? ` — ${getToolBubbleText(lastToolName)}`
      : (() => { const a = queryLastAuditAction(); return a ? ` — ${a}` : ""; })();
    try {
      await progressMsg.edit(`⏳ 處理中 (${elapsed} 分鐘)${detail}`);
    } catch { /* message may have been deleted */ }
  }, PROGRESS_INTERVAL_MS);

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

    // Fallback guard: fires only when the Leader genuinely forgot to call send_message.
    // Layer 2: sendMessageCalled (tracked via onToolUse) is the primary signal.
    // Layer 1: fallback is now silent — no warning prefix shown to users; logged internally only.
    const out = result.output ?? "";
    const looksLikeUnsentReply =
      !sendMessageCalled &&        // primary: onToolUse confirmed no send_message was called
      out.length > 40 &&           // secondary: output is substantive prose, not empty/ack
      !/Message sent|BUFFERED/i.test(out);

    if (looksLikeUnsentReply) {
      console.warn("[Listener] Fallback: Leader did not call send_message — routing output silently");
      const truncated = out.length > 1800 ? out.substring(0, 1800) + "…" : out;
      // Send without warning prefix (Layer 1: silent fallback), with reply threading
      await channel
        .send({ content: truncated, reply: { messageReference: message.id } })
        .catch((e) => console.error("[Listener] Failed to send fallback:", e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[Listener] claude failed:", errMsg);

    clearInterval(progressTimer);
    try { await progressMsg?.delete(); } catch { /* non-fatal */ }

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

  clearInterval(progressTimer);
  try { await progressMsg?.delete(); } catch { /* non-fatal */ }

  // Replace ⏳ with ✅ only when claude completed without error
  if (claudeSucceeded) {
    try { await message.react("✅"); } catch { /* non-fatal */ }
    await removeReaction(message, "⏳");
  }
  } finally {
    userProcessing.delete(userLockKey);
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
    // Notify in the channel where the approval originated (not hardcoded #general)
    try {
      const dc = getDiscordClient();
      const targetChannelName = approval.channelName ?? GENERAL_CHANNEL;
      const ch = dc.channels.cache.find(
        (c) => c.isTextBased() && "name" in c && c.name === targetChannelName
      ) as TextChannel | undefined;
      const isAuthError = errMsg.startsWith("AUTH_EXPIRED:");
      const msg = isAuthError
        ? "🔐 Claude authentication expired. Please run `/login` to re-authenticate."
        : `❌ Approval processing failed: ${errMsg.substring(0, 500)}`;
      await ch?.send(msg);
    } catch { /* non-fatal */ }
  }
}

// Dynamic approval payload — static identity + CRITICAL constraint are in LEADER_SYSTEM_PROMPT.
function buildApprovalPrompt(approval: ApprovalRequest, workerModelOverride?: string): string {
  const resolvedBy = approval.resolvedBy ?? "unknown";
  const resolvedAt = approval.resolvedAt ? approval.resolvedAt.toISOString() : "unknown";
  const modelHint = workerModelOverride ?? "sonnet";
  const replyLine = approval.originMessageId
    ? `   When calling send_message, use channel_name: "${approval.originChannelName ?? "general"}" and reply_to_message_id: ${approval.originMessageId}.\n`
    : "";

  return (
    "An approval has been resolved in Discord.\n" +
    "\n" +
    "1. Call report_status with status 'busy'.\n" +
    "2. Read agents/leader/CLAUDE.md — then follow its Listener Mode steps exactly.\n" +
    replyLine +
    "\n" +
    `Approval ID: ${approval.id}\n` +
    `Status: ${approval.status}\n` +
    `Action: ${approval.action}\n` +
    `Description: ${approval.description}\n` +
    `Risk Level: ${approval.riskLevel}\n` +
    `Resolved By: ${resolvedBy}\n` +
    `Resolved At: ${resolvedAt}\n` +
    (approval.taskId ? `Related Task ID: ${approval.taskId} — call task_get(task_id) before acting.\n` : "") +
    (approval.traceId ? `Trace ID: ${approval.traceId}\n` : "") +
    (approval.previewArtifactPath ? `Preview artifact: ${approval.previewArtifactPath} — Read this file before acting if APPROVED.\n` : "") +
    "\n" +
    "3. If APPROVED: execute the approved action following your standard routing and delegation\n" +
    "   protocol in CLAUDE.md. If a Task ID is provided, call task_get first. If a preview\n" +
    "   artifact is provided, Read it before executing.\n" +
    "4. If REJECTED: notify the user via send_message.\n" +
    "\n" +
    "⚠️ CRITICAL: Do NOT call create_approval. Do NOT trigger new approval workflows.\n" +
    `\nDefault worker model: ${modelHint}.\n` +
    "\n⚠️ FINAL REMINDER: After ALL work is done, call send_message to post your response to Discord. Output ONLY 'Message sent to Discord.' as your last text.\n"
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Dynamic per-request payload (user message + runtime values) ───────────────
//
// PROMPT STRUCTURE NOTE
// The static identity and CRITICAL constraint live in LEADER_SYSTEM_PROMPT (--system).
// This function builds only the per-request payload that CLAUDE.md cannot know:
//   - The channel context ("A user has sent you a message in #general")
//   - Bootstrap steps that include runtime values (reply_to_message_id, progressMessageId)
//   - The user's message content
//   - A trailing FINAL REMINDER to reinforce the send_message constraint
//     (LLM recency bias — end-of-prompt is closer to response generation)
function buildPrompt(
  username: string,
  content: string,
  messageId: string,
  replyContext: string = "",
  attachments: string[] = [],
  workerModelOverride?: string,
  progressMessageId?: string,
): string {
  let attachmentInfo = "";
  if (attachments.length > 0) {
    attachmentInfo = "\n\nUser uploaded files (saved to disk — use Read tool to access):\n" +
      attachments.map(p => `- ${p}`).join("\n") + "\n";
  }
  const modelHint = workerModelOverride ?? "sonnet";

  return (
    // ── Channel context (dynamic: varies by trigger type) ──
    "A user has sent you a message in Discord #general.\n" +
    "\n" +
    // ── Bootstrap steps + pointer to full procedure ──
    "1. Call report_status with status 'busy'.\n" +
    "2. Read agents/leader/CLAUDE.md — then follow its Listener Mode steps exactly.\n" +
    "   When calling send_message, use reply_to_message_id: " + messageId + ".\n" +
    "\n" +
    // ── Runtime values CLAUDE.md cannot know ──
    "User: " + username + "\n" +
    "--- BEGIN MESSAGE ---\n" +
    content + "\n" +
    "--- END MESSAGE ---\n" +
    replyContext +
    attachmentInfo +
    `\nDefault worker model: ${modelHint}.\n` +
    (progressMessageId
      ? `Progress message ID (call edit_message with channel_name "general" to update it): ${progressMessageId}\n`
      : "") +
    // Layer 3: trailing reminder — reinforces LEADER_SYSTEM_PROMPT constraint at end-of-prompt
    "\n⚠️ FINAL REMINDER: After ALL work is done, call send_message to post your reply to Discord. Output ONLY 'Message sent to Discord.' as your last text.\n"
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
      GatewayIntentBits.GuildVoiceStates, // required for voice channel listeners
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });

  setDiscordClient(client);
  registerApprovalInteractionHandler(client);
  registerOnboardingInteractionHandler(client);
  setApprovalResolvedCallback((approval) => {
    enqueueApprovalTrigger(approval);
  });

  // ── /office slash command + office:* button/select interactions ────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    // Slash command: /office
    if (interaction.isChatInputCommand() && interaction.commandName === "office") {
      try {
        await handleOfficeCommand(interaction);
      } catch (err) {
        console.error("[Listener] handleOfficeCommand error:", err);
      }
      return;
    }

    // Buttons and select menus with office:* customId
    const isOfficeInteraction =
      (interaction.isButton() || interaction.isStringSelectMenu()) &&
      interaction.customId.startsWith("office:");

    if (isOfficeInteraction) {
      try {
        await handleOfficeInteraction(interaction);
      } catch (err) {
        console.error("[Listener] handleOfficeInteraction error:", err);
      }
    }
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

      // Set Whisper STT language from office.yaml (e.g. "zh-TW" → "zh", "en" → "en")
      whisperLanguage = config.language.split("-")[0];
      setWhisperLanguage(whisperLanguage);
      console.log(`[Listener] Whisper language: ${whisperLanguage}`);

      // Recover orphan pending approvals from before daemon restart
      await recoverPendingApprovals(client).catch(err => console.warn('[Listener] recoverPendingApprovals failed:', err));

      // Recover onboarding state if interrupted by a previous bot restart
      await recoverOnboardingState().catch(err => console.warn('[Listener] recoverOnboardingState failed:', err));

      await checkFirstRun();

      // Only post ngrok URL when already onboarded — skip during first-run onboarding
      // so the URL notification doesn't interrupt the onboarding flow in #general.
      if (fs.existsSync(ONBOARDED_FLAG)) {
        await postNgrokUrl(readyClient);
      }

      const adapter = new DiscordChatAdapter();

      const dailyBriefConfig: ClaudeRunnerConfig = { ...BASE_CLAUDE_CONFIG, model: config.models.dailyBrief };
      const auditClaudeConfig: ClaudeRunnerConfig = { ...BASE_CLAUDE_CONFIG, model: config.models.auditor };

      heartbeat = new HeartbeatScheduler(
        config.timezone, config.statePath, PROJECT_DIR, dailyBriefConfig, adapter,
        config.dailyBriefTime, config.audit, auditClaudeConfig, config.language,
      );
      heartbeat.start();
      console.log("[Listener] HeartbeatScheduler started");

      sessionStore.start();

      // Auto-register /office slash command
      const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
      const guildId = process.env.DISCORD_GUILD_ID ?? "";
      if (botToken && guildId) {
        registerOfficeCommands(botToken, guildId).catch(err =>
          console.warn("[Listener] registerOfficeCommands error:", err)
        );
      }
    } catch (err) {
      console.error("[Listener] Failed to start subsystems:", err);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    enqueueMessage(message).catch((err) => {
      console.error("[Listener] Unhandled error in enqueueMessage:", err);
    });
  });

  // ── Voice channel → local Whisper STT ────────────────────────────────────
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState);
  });

  // When a voice utterance is transcribed, run it through the Leader pipeline
  setVoiceTranscriptCallback(async (userId, displayName, text) => {
    const dc = getDiscordClient();
    if (!dc) return;

    const generalChannel = dc.channels.cache.find(
      (ch) => ch.isTextBased() && "name" in ch && ch.name === GENERAL_CHANNEL
    ) as TextChannel | undefined;
    if (!generalChannel) return;

    // Post a progress indicator so the user knows we received their voice
    const progressMsg = await generalChannel.send(`🎙️ *${displayName}：「${text}」*\n⏳ 處理中…`).catch(() => undefined);

    const prompt = buildPrompt(displayName, text, "voice", "", [], workerModel, progressMsg?.id);
    const startTime = Date.now();
    let sendMessageCalled = false;
    const onToolUse = async (toolName: string) => {
      if (toolName === "mcp__ai-office-discord__send_message" || toolName === "mcp__ai-office-discord__send_embed") {
        sendMessageCalled = true;
      }
    };

    try {
      const result = await runClaude(prompt, { ...leaderClaudeConfig, onToolUse });
      const out = result.output ?? "";
      const looksUnsent = !sendMessageCalled && out.length > 40 && !/Message sent|BUFFERED/i.test(out);
      if (looksUnsent) {
        const truncated = out.length > 1800 ? out.slice(0, 1800) + "…" : out;
        await generalChannel.send(truncated).catch(() => undefined);
      }
    } catch (err) {
      console.error("[VoiceListener] runClaude error:", err);
    } finally {
      try { await progressMsg?.delete(); } catch { /* non-fatal */ }
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[VoiceListener] Voice message processed in ${elapsed}s`);
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
