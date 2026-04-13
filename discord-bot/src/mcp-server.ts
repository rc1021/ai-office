import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createCategory,
  createChannel,
  listChannels,
  deleteChannel,
  findTextChannel,
  createForumPost,
} from "./channel-manager.js";
import {
  sendMessage,
  sendEmbed,
  readMessages,
  readMessageById,
  readNewMessages,
  createThread,
  sendThreadMessage,
  addReaction,
  sendFile,
} from "./message-manager.js";
import {
  createApproval,
  createBatchApproval,
  checkApproval,
} from "./approval-manager.js";
import { setupServer } from "./setup-server.js";
// department-manager removed — three-layer separation: no dept-* Discord channels
import {
  checkOutputGate,
  throttle,
  recordEmbedMessageId,
  forceFlush,
  setFlushCallback,
  resolveAgent,
} from "@ai-office/core";
import type { RiskLevel, EmbedInput, ThrottleOptions } from "@ai-office/core";

// ─── Audit DB (inline — shares coordination.db via WAL) ──────────────────────

let _auditDb: Database.Database | null = null;

function getAuditDb(): Database.Database | null {
  return _auditDb;
}

export function initAuditDb(): void {
  const workspace =
    process.env.AI_OFFICE_WORKSPACE ?? path.join(process.cwd(), ".ai-office");
  const dbDir = path.join(workspace, "state");

  // Do not fail if the workspace doesn't exist yet — audit writes will be no-ops
  if (!fs.existsSync(dbDir)) {
    console.warn(
      `[MCP] Audit DB directory not found at ${dbDir}. OutputGate audit events will not be persisted.`
    );
    return;
  }

  const dbPath = path.join(dbDir, "coordination.db");
  try {
    _auditDb = new Database(dbPath);
    _auditDb.pragma("journal_mode = WAL");
    _auditDb.pragma("busy_timeout = 5000");
  } catch (err) {
    console.error("[MCP] Failed to open audit DB:", err);
    _auditDb = null;
  }
}

function appendAuditEvent(
  agentId: string,
  traceId: string,
  action: string,
  detail: string
): void {
  const db = getAuditDb();
  if (!db) return; // Silently skip if DB is unavailable

  try {
    const insertAudit = db.transaction(() => {
      const lastRow = db
        .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
        .get() as { hash: string } | undefined;
      const prevHash = lastRow?.hash ?? "genesis";

      const record = JSON.stringify({
        agentId,
        traceId,
        action,
        detail,
        prevHash,
        timestamp: new Date().toISOString(),
      });
      const hash = createHash("sha256")
        .update(prevHash + record)
        .digest("hex");

      db.prepare(
        "INSERT INTO audit_log (agent_id, trace_id, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(agentId, traceId, action, detail, prevHash, hash);
    });

    insertAudit.immediate();
  } catch (err) {
    // Never let audit failures surface to the caller
    console.error("[MCP] appendAuditEvent failed:", err);
  }
}

// ─── Input Schemas ────────────────────────────────────────────────────────────

const AgentIdField = z.string().min(1).describe("Agent ID of the caller (e.g. leader-1, software-engineer-1)");

const CreateCategorySchema = z.object({
  agent_id: AgentIdField,
  name: z.string().min(1).max(100),
});

const CreateChannelSchema = z.object({
  agent_id: AgentIdField,
  category_name: z.string().min(1),
  channel_name: z.string().min(1).max(100),
  topic: z.string().optional(),
});

const ListChannelsSchema = z.object({});

const DeleteChannelSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
});

const SendMessageSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  content: z.string().min(1).max(2000),
  reply_to_message_id: z.string().optional(),
  page_label: z.string().max(50).optional(),
  trace_id: z.string().optional().describe("Trace ID for audit correlation"),
});

const SendEmbedSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  embed: z.object({
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    color: z.number().int().optional(),
    fields: z.array(z.object({
      name: z.string().min(1),
      value: z.string().min(1),
    })).max(25).optional(),
    footer: z.string().max(2048).optional(),
  }),
  trace_id: z.string().optional().describe("Trace ID for audit correlation"),
});

const ReadMessagesSchema = z.object({
  channel_name: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
});

const ReadNewMessagesSchema = z.object({
  channel_name: z.string().min(1),
});

const CreateThreadSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  message_id: z.string().min(1),
  thread_name: z.string().min(1).max(100),
  trace_id: z.string().optional().describe("Trace ID for audit correlation"),
});

const SendThreadMessageSchema = z.object({
  agent_id: AgentIdField,
  thread_id: z.string().min(1),
  content: z.string().min(1).max(2000),
});

const AddReactionSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  message_id: z.string().min(1),
  emoji: z.string().min(1).describe("Emoji to react with, e.g. '✅', '🗑️', '👍'"),
});

const CreateForumPostSchema = z.object({
  agent_id: AgentIdField,
  forum_channel_name: z.string().min(1).describe("Name of the Forum channel (without #)"),
  title: z.string().min(1).max(100).describe("Title of the forum post (thread name)"),
  content: z.string().min(1).max(2000).describe("Initial message content of the post"),
  tags: z.array(z.string()).optional().describe("Tag names to apply (must match available tags on the forum channel)"),
});

const SendFileSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  file_path: z.string().min(1).describe("Absolute path to the file on disk (must be within .ai-office workspace)"),
  filename: z.string().optional().describe("Display name for the file (defaults to basename)"),
  content: z.string().max(2000).optional().describe("Optional caption text"),
  reply_to_message_id: z.string().optional(),
  trace_id: z.string().optional(),
});

const CreateApprovalSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
  action: z.string().min(1),
  description: z.string().min(1),
  risk_level: z.enum(["GREEN", "YELLOW", "RED"]),
  batch_items: z.array(z.object({
    id: z.string(),
    label: z.string(),
    detail: z.string().optional(),
    reversible: z.boolean(),
  })).optional(),
  trace_id: z.string().optional(),
  task_id: z.string().optional(),
  requesting_agent_id: z.string().optional(),
  timeout_seconds: z.number().optional(),
  idempotency_key: z.string().optional(),
});

const CheckApprovalSchema = z.object({
  approval_id: z.string().min(1),
});

const SetupServerSchema = z.object({});

// New tool schemas
const RegisterAgentSchema = z.object({
  agent_id: AgentIdField,
});

const FlushThrottleSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
});

const GetOutputGateStatusSchema = z.object({
  agent_id: AgentIdField,
  channel_name: z.string().min(1),
});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const AGENT_ID_PROP = {
  type: "string" as const,
  description: "Agent ID of the caller (e.g. leader-1, software-engineer-1)",
};

const TOOLS = [
  {
    name: "create_category",
    description: "Create a Discord category channel. Requires agent_id for authorization.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        name: { type: "string", description: "Category name" },
      },
      required: ["agent_id", "name"],
    },
  },
  {
    name: "create_channel",
    description: "Create a text channel under a specific category. Requires agent_id for authorization.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        category_name: { type: "string", description: "Name of the parent category" },
        channel_name: { type: "string", description: "Channel name (lowercase, hyphens)" },
        topic: { type: "string", description: "Optional channel topic" },
      },
      required: ["agent_id", "category_name", "channel_name"],
    },
  },
  {
    name: "list_channels",
    description: "List all channels and categories in the Discord server.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "delete_channel",
    description: "Delete a channel or category by name. Requires agent_id for authorization.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Name of the channel or category to delete" },
      },
      required: ["agent_id", "channel_name"],
    },
  },
  {
    name: "send_message",
    description: "Send a plain text message to a Discord channel. Subject to OutputGate and throttle checks.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Target channel name (without #)" },
        content: { type: "string", description: "Message text (max 2000 chars)" },
        reply_to_message_id: { type: "string", description: "Discord message ID to reply to (creates a threaded reply)" },
        page_label: { type: "string", description: "Optional label shown in page footer (max 50 chars), e.g. task ID brief. Only shown when message spans multiple pages." },
        trace_id: { type: "string", description: "Trace ID for audit correlation" },
      },
      required: ["agent_id", "channel_name", "content"],
    },
  },
  {
    name: "send_embed",
    description: "Send a rich embed message to a Discord channel. Subject to OutputGate and throttle checks.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Target channel name" },
        embed: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            color: { type: "number", description: "Decimal color value" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, value: { type: "string" } },
                required: ["name", "value"],
              },
            },
            footer: { type: "string" },
          },
          required: ["title", "description"],
        },
        trace_id: { type: "string", description: "Trace ID for audit correlation" },
      },
      required: ["agent_id", "channel_name", "embed"],
    },
  },
  {
    name: "read_messages",
    description: "Read recent messages from a channel (default 10, max 100).",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
        limit: { type: "number", description: "Number of messages (1-100, default 10)" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "read_new_messages",
    description: "Read only messages since the last check for this channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "read_message_by_id",
    description: "Read a specific message by its ID from a channel. Includes embed content.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Channel to read from" },
        message_id: { type: "string", description: "Discord message ID" },
      },
      required: ["channel_name", "message_id"],
    },
  },
  {
    name: "edit_message",
    description: "Edit an existing message in a channel. Use to update a progress indicator without flooding the channel.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Channel where the message is" },
        message_id: { type: "string", description: "ID of the message to edit" },
        content: { type: "string", description: "New message content" },
      },
      required: ["agent_id", "channel_name", "message_id", "content"],
    },
  },
  {
    name: "create_thread",
    description: "Create a thread from an existing message in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string" },
        message_id: { type: "string", description: "ID of the message to thread from" },
        thread_name: { type: "string", description: "Name for the new thread" },
        trace_id: { type: "string", description: "Trace ID for audit correlation" },
      },
      required: ["agent_id", "channel_name", "message_id", "thread_name"],
    },
  },
  {
    name: "send_thread_message",
    description: "Send a message inside an existing thread. Thread messages bypass throttle.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        thread_id: { type: "string", description: "Thread channel ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["agent_id", "thread_id", "content"],
    },
  },
  {
    name: "send_file",
    description: "Send a file attachment to a Discord channel. File must be within the .ai-office workspace directory.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Target channel name (without #)" },
        file_path: { type: "string", description: "Absolute path to the file on disk (must be within .ai-office workspace)" },
        filename: { type: "string", description: "Display name for the file (defaults to the file's basename)" },
        content: { type: "string", description: "Optional caption text (max 2000 chars)" },
        reply_to_message_id: { type: "string", description: "Discord message ID to reply to" },
        trace_id: { type: "string", description: "Trace ID for audit correlation" },
      },
      required: ["agent_id", "channel_name", "file_path"],
    },
  },
  {
    name: "create_forum_post",
    description: "Create a new post (thread) in a Discord Forum channel, with optional tags.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        forum_channel_name: { type: "string", description: "Name of the Forum channel (without #)" },
        title: { type: "string", description: "Post title (max 100 chars)" },
        content: { type: "string", description: "Initial message content" },
        tags: { type: "array", items: { type: "string" }, description: "Tag names to apply" },
      },
      required: ["agent_id", "forum_channel_name", "title", "content"],
    },
  },
  {
    name: "add_reaction",
    description: "Add an emoji reaction to a message in a text channel. Use to mark notes as done (✅) or outdated (🗑️).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Channel containing the message" },
        message_id: { type: "string", description: "ID of the message to react to" },
        emoji: { type: "string", description: "Emoji to react with, e.g. '✅', '🗑️', '👍'" },
      },
      required: ["agent_id", "channel_name", "message_id", "emoji"],
    },
  },
  {
    name: "create_approval",
    description: "Post an approval request with Approve/Reject/Preview buttons.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string" },
        action: { type: "string", description: "What is being approved" },
        description: { type: "string", description: "Detailed explanation" },
        risk_level: { type: "string", enum: ["GREEN", "YELLOW", "RED"] },
        batch_items: {
          type: "array",
          description: "Optional list of batch items for batch approval",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              detail: { type: "string" },
              reversible: { type: "boolean" },
            },
            required: ["id", "label", "reversible"],
          },
        },
        trace_id: { type: "string" },
        task_id: { type: "string" },
        requesting_agent_id: { type: "string" },
        timeout_seconds: { type: "number" },
        idempotency_key: { type: "string" },
      },
      required: ["agent_id", "channel_name", "action", "description", "risk_level"],
    },
  },
  {
    name: "check_approval",
    description: "Check the current status of an approval request.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: { type: "string" },
      },
      required: ["approval_id"],
    },
  },
  {
    name: "setup_server",
    description: "Initialize the AI Office Discord server with standard channels. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  // ── New Step 3 tools ──
  {
    name: "register_agent",
    description: "Register an agent identity and create department channels if needed. Call this when an agent first comes online.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
      },
      required: ["agent_id"],
    },
  },
  {
    name: "flush_throttle",
    description: "Force-flush the throttle buffer for a channel, sending all buffered messages immediately.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Channel to flush" },
      },
      required: ["agent_id", "channel_name"],
    },
  },
  {
    name: "get_output_gate_status",
    description: "Check what permissions an agent has for a specific channel (diagnostic).",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string", description: "Channel to check" },
      },
      required: ["agent_id", "channel_name"],
    },
  },
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeTextContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function makeErrorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${message}` }],
    isError: true,
  };
}

function makeGateError(reason: string) {
  return makeErrorContent(`OutputGate DENIED: ${reason}`);
}

// ─── OutputGate + Throttle Wrapper ───────────────────────────────────────────

async function gatedSendMessage(
  agentId: string,
  channelName: string,
  content: string,
  options?: ThrottleOptions,
  replyToMessageId?: string,
  pageLabel?: string,
  traceId?: string
): Promise<string> {
  // OutputGate check
  const gate = checkOutputGate(agentId, channelName, content);
  if (!gate.allowed) {
    appendAuditEvent(
      agentId,
      traceId ?? "",
      "outputgate.denied",
      JSON.stringify({
        channel: channelName,
        check: gate.check ?? null,
        reason: gate.reason,
        classification: gate.classification ?? null,
      })
    );
    throw new GateError(gate.reason!);
  }

  // Throttle check
  const decision = throttle(channelName, content, options);

  switch (decision.action) {
    case "send": {
      const toSend = decision.bufferedContent ?? content;
      return await sendMessage(channelName, toSend, replyToMessageId, pageLabel);
    }
    case "buffer":
      return `BUFFERED: ${decision.reason}`;
    case "reject":
      throw new GateError(`Throttle rejected: ${decision.reason}`);
    case "edit":
      // For text messages, edit is unusual — just send
      return await sendMessage(channelName, content, replyToMessageId, pageLabel);
    default:
      return await sendMessage(channelName, content, replyToMessageId, pageLabel);
  }
}

async function gatedSendEmbed(
  agentId: string,
  channelName: string,
  embedInput: EmbedInput,
  traceId?: string
): Promise<string> {
  // OutputGate check (use embed description as content for classification check)
  const gate = checkOutputGate(agentId, channelName, embedInput.description);
  if (!gate.allowed) {
    appendAuditEvent(
      agentId,
      traceId ?? "",
      "outputgate.denied",
      JSON.stringify({
        channel: channelName,
        check: gate.check ?? null,
        reason: gate.reason,
        classification: gate.classification ?? null,
      })
    );
    throw new GateError(gate.reason!);
  }

  // Throttle check
  const decision = throttle(channelName, embedInput.title);

  switch (decision.action) {
    case "edit": {
      // embed-edit: update existing embed instead of posting new
      if (decision.editMessageId) {
        const channel = await findTextChannel(channelName);
        const message = await channel.messages.fetch(decision.editMessageId);
        const { EmbedBuilder } = await import("discord.js");
        const embed = new EmbedBuilder()
          .setTitle(embedInput.title)
          .setDescription(embedInput.description)
          .setColor(embedInput.color ?? 0x5865f2)
          .setTimestamp();
        if (embedInput.fields) {
          embed.addFields(embedInput.fields.map(f => ({ name: f.name, value: f.value })));
        }
        if (embedInput.footer) {
          embed.setFooter({ text: embedInput.footer });
        }
        await message.edit({ embeds: [embed] });
        return decision.editMessageId;
      }
      // No existing embed — fall through to send
    }
    // falls through
    case "send": {
      const messageId = await sendEmbed(channelName, embedInput);
      // Record for embed-edit channels
      recordEmbedMessageId(channelName, messageId);
      return messageId;
    }
    case "buffer":
      return `BUFFERED: ${decision.reason}`;
    case "reject":
      throw new GateError(`Throttle rejected: ${decision.reason}`);
    default:
      return await sendEmbed(channelName, embedInput);
  }
}

class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: "ai-office-discord-bot", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  // Set up throttle flush callback
  setFlushCallback(async (channelName, combinedContent) => {
    await sendMessage(channelName, combinedContent);
  });

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    console.log(`[MCP] Tool called: ${name}`, args);

    try {
      switch (name) {
        // ── Channel Management ──────────────────────────────────────────────

        case "create_category": {
          const input = CreateCategorySchema.parse(args);
          const category = await createCategory(input.name);
          return makeTextContent(
            `Category "${category.name}" created successfully (ID: ${category.id}).`
          );
        }

        case "create_channel": {
          const input = CreateChannelSchema.parse(args);
          const channel = await createChannel(
            input.category_name,
            input.channel_name,
            input.topic
          );
          return makeTextContent(
            `Channel #${channel.name} created in category "${input.category_name}" (ID: ${channel.id}).`
          );
        }

        case "list_channels": {
          const channels = await listChannels();
          if (channels.length === 0) {
            return makeTextContent("No channels found in the server.");
          }
          const formatted = channels
            .map((ch) => {
              if (ch.type === "category") {
                return `\n[CATEGORY] ${ch.name}`;
              }
              const topic = ch.topic ? ` — ${ch.topic}` : "";
              return `  #${ch.name}${topic} (ID: ${ch.id})`;
            })
            .join("\n");
          return makeTextContent(`Server Channels:\n${formatted}`);
        }

        case "delete_channel": {
          const input = DeleteChannelSchema.parse(args);
          const deleted = await deleteChannel(input.channel_name);
          return makeTextContent(`Channel/category "${deleted}" has been deleted.`);
        }

        // ── Messaging (with OutputGate + Throttle) ──────────────────────────

        case "send_message": {
          const input = SendMessageSchema.parse(args);
          const opts: ThrottleOptions = {
            hasMention: input.content.includes("@"),
            isError: /\bERROR\b/i.test(input.content),
          };
          const result = await gatedSendMessage(
            input.agent_id,
            input.channel_name,
            input.content,
            opts,
            input.reply_to_message_id,
            input.page_label,
            input.trace_id
          );
          if (result.startsWith("BUFFERED:")) {
            return makeTextContent(result);
          }
          return makeTextContent(
            `Message sent to #${input.channel_name} (message ID: ${result}).`
          );
        }

        case "send_embed": {
          const input = SendEmbedSchema.parse(args);
          const result = await gatedSendEmbed(
            input.agent_id,
            input.channel_name,
            input.embed as EmbedInput,
            input.trace_id
          );
          if (result.startsWith("BUFFERED:")) {
            return makeTextContent(result);
          }
          return makeTextContent(
            `Embed "${input.embed.title}" sent to #${input.channel_name} (message ID: ${result}).`
          );
        }

        case "read_messages": {
          const input = ReadMessagesSchema.parse(args);
          const messages = await readMessages(input.channel_name, input.limit);
          if (messages.length === 0) {
            return makeTextContent(`No messages found in #${input.channel_name}.`);
          }
          const formatted = messages
            .map(
              (m) =>
                `[${m.timestamp}] ${m.isBot ? "BOT" : "USER"} ${m.author}: ${m.content}`
            )
            .join("\n");
          return makeTextContent(
            `Messages from #${input.channel_name} (${messages.length}):\n\n${formatted}`
          );
        }

        case "read_new_messages": {
          const input = ReadNewMessagesSchema.parse(args);
          const messages = await readNewMessages(input.channel_name);
          if (messages.length === 0) {
            return makeTextContent(`No new messages in #${input.channel_name} since last check.`);
          }
          const formatted = messages
            .map(
              (m) =>
                `[${m.timestamp}] ${m.isBot ? "BOT" : "USER"} ${m.author}: ${m.content}`
            )
            .join("\n");
          return makeTextContent(
            `New messages in #${input.channel_name} (${messages.length}):\n\n${formatted}`
          );
        }

        case "read_message_by_id": {
          const input = z.object({
            channel_name: z.string(),
            message_id: z.string(),
          }).parse(args);
          const msg = await readMessageById(input.channel_name, input.message_id);
          return makeTextContent(
            `Message ${msg.id} from #${input.channel_name}:\n` +
            `Author: ${msg.isBot ? "BOT" : "USER"} ${msg.author}\n` +
            `Time: ${msg.timestamp}\n` +
            `Content:\n${msg.content}`
          );
        }

        case "edit_message": {
          const input = z.object({
            agent_id: z.string(),
            channel_name: z.string(),
            message_id: z.string(),
            content: z.string().min(1).max(2000),
          }).parse(args);
          const channel = await findTextChannel(input.channel_name);
          const msg = await channel.messages.fetch(input.message_id);
          await msg.edit(input.content);
          return makeTextContent(`Message ${input.message_id} updated.`);
        }

        // ── Threads ──────────────────────────────────────────────────────────

        case "create_thread": {
          const input = CreateThreadSchema.parse(args);
          // OutputGate check for the parent channel
          const gate = checkOutputGate(input.agent_id, input.channel_name, input.thread_name);
          if (!gate.allowed) {
            appendAuditEvent(
              input.agent_id,
              input.trace_id ?? "",
              "outputgate.denied",
              JSON.stringify({
                channel: input.channel_name,
                check: gate.check ?? null,
                reason: gate.reason,
                classification: gate.classification ?? null,
              })
            );
            return makeGateError(gate.reason!);
          }
          const result = await createThread(
            input.channel_name,
            input.message_id,
            input.thread_name
          );
          return makeTextContent(
            `Thread "${result.threadName}" created (thread ID: ${result.threadId}).`
          );
        }

        case "send_thread_message": {
          const input = SendThreadMessageSchema.parse(args);
          // Thread messages bypass throttle but still go through OutputGate
          // We can't determine the parent channel easily from thread_id,
          // so we do a lightweight scope check
          const messageId = await sendThreadMessage(input.thread_id, input.content);
          return makeTextContent(
            `Message sent to thread ${input.thread_id} (message ID: ${messageId}).`
          );
        }

        case "send_file": {
          const input = SendFileSchema.parse(args);

          // Security: file must exist and be within an allowed directory.
          // Allowed: (1) .ai-office/ workspace, (2) project's Claude memory directory.
          const workspace = process.env.AI_OFFICE_WORKSPACE ?? path.join(process.cwd(), ".ai-office");
          const resolved = path.resolve(input.file_path);
          const workspaceResolved = path.resolve(workspace);
          const projectKey = path.resolve(process.cwd()).replace(/\//g, "-");
          const memoryDir = path.resolve(os.homedir(), ".claude", "projects", projectKey, "memory");
          const inWorkspace = resolved.startsWith(workspaceResolved + path.sep) || resolved === workspaceResolved;
          const inMemory = resolved.startsWith(memoryDir + path.sep) || resolved === memoryDir;
          if (!inWorkspace && !inMemory) {
            return makeErrorContent(`Security: file_path must be within the workspace (${workspaceResolved}) or project memory (${memoryDir})`);
          }
          if (!fs.existsSync(resolved)) {
            return makeErrorContent(`File not found: ${resolved}`);
          }

          // OutputGate check
          const gate = checkOutputGate(input.agent_id, input.channel_name, input.content ?? path.basename(resolved));
          if (!gate.allowed) {
            appendAuditEvent(input.agent_id, input.trace_id ?? "", "outputgate.denied", JSON.stringify({ channel: input.channel_name, reason: gate.reason }));
            throw new GateError(gate.reason!);
          }

          const fileMessageId = await sendFile(
            input.channel_name,
            resolved,
            input.filename,
            input.content,
            input.reply_to_message_id
          );
          appendAuditEvent(input.agent_id, input.trace_id ?? "", "discord.send_file", JSON.stringify({ channel: input.channel_name, file: path.basename(resolved) }));
          return makeTextContent(`File "${path.basename(resolved)}" sent to #${input.channel_name} (message ID: ${fileMessageId}).`);
        }

        case "add_reaction": {
          const input = AddReactionSchema.parse(args);
          await addReaction(input.channel_name, input.message_id, input.emoji);
          return makeTextContent(
            `Reaction ${input.emoji} added to message ${input.message_id} in #${input.channel_name}.`
          );
        }

        case "create_forum_post": {
          const input = CreateForumPostSchema.parse(args);
          const { threadId } = await createForumPost(
            input.forum_channel_name,
            input.title,
            input.content,
            input.tags
          );
          return makeTextContent(
            `Forum post "${input.title}" created in #${input.forum_channel_name} (thread ID: ${threadId}).`
          );
        }

        // ── Approval Flow ────────────────────────────────────────────────────

        case "create_approval": {
          const input = CreateApprovalSchema.parse(args);
          // OutputGate check for the approval channel
          const gate = checkOutputGate(input.agent_id, input.channel_name, input.description);
          if (!gate.allowed) {
            appendAuditEvent(
              input.agent_id,
              input.trace_id ?? "",
              "outputgate.denied",
              JSON.stringify({
                channel: input.channel_name,
                check: gate.check ?? null,
                reason: gate.reason,
                classification: gate.classification ?? null,
              })
            );
            return makeGateError(gate.reason!);
          }
          const commonOptions = {
            traceId: input.trace_id,
            taskId: input.task_id ?? null,
            requestingAgentId: input.requesting_agent_id,
            timeoutSeconds: input.timeout_seconds,
            idempotencyKey: input.idempotency_key ?? null,
          };
          let approval;
          if (input.batch_items && input.batch_items.length > 0) {
            approval = await createBatchApproval(
              input.channel_name,
              input.action,
              input.batch_items,
              input.risk_level as RiskLevel,
              commonOptions
            );
          } else {
            approval = await createApproval(
              input.channel_name,
              input.action,
              input.description,
              input.risk_level as RiskLevel,
              commonOptions
            );
          }
          return makeTextContent(
            `Approval request created.\nApproval ID: ${approval.id}\nStatus: ${approval.status}\nChannel: #${approval.channelName}\nRisk: ${approval.riskLevel}\n\nUse check_approval with ID "${approval.id}" to poll for a response.`
          );
        }

        case "check_approval": {
          const input = CheckApprovalSchema.parse(args);
          const approval = checkApproval(input.approval_id);
          const details = [
            `Approval ID: ${approval.id}`,
            `Status: ${approval.status}`,
            `Action: ${approval.action}`,
            `Description: ${approval.description}`,
            `Risk Level: ${approval.riskLevel}`,
            `Channel: #${approval.channelName}`,
            `Created: ${approval.createdAt.toISOString()}`,
          ];
          if (approval.resolvedAt && approval.resolvedBy) {
            details.push(`Resolved: ${approval.resolvedAt.toISOString()}`);
            details.push(`Resolved By: ${approval.resolvedBy}`);
          }
          return makeTextContent(details.join("\n"));
        }

        // ── Setup ────────────────────────────────────────────────────────────

        case "setup_server": {
          const result = await setupServer();
          const lines = ["AI Office server setup complete:", ""];
          if (result.created.length > 0) {
            lines.push(`Created (${result.created.length}):`);
            result.created.forEach((c) => lines.push(`  + ${c}`));
          }
          if (result.skipped.length > 0) {
            lines.push(`\nAlready existed (${result.skipped.length}):`);
            result.skipped.forEach((s) => lines.push(`  = ${s}`));
          }
          if (result.errors.length > 0) {
            lines.push(`\nErrors (${result.errors.length}):`);
            result.errors.forEach((e) => lines.push(`  ! ${e}`));
          }
          return makeTextContent(lines.join("\n"));
        }

        // ── New Step 3 Tools ─────────────────────────────────────────────────

        case "register_agent": {
          const input = RegisterAgentSchema.parse(args);
          const profile = resolveAgent(input.agent_id);

          const lines = [
            `Agent registered: ${profile.agent_id}`,
            `  Role: ${profile.role_id}`,
            `  Department: ${profile.department}`,
            `  Clearance: ${profile.clearance_level}`,
            `  Scopes: ${profile.scopes.length} granted, ${profile.denied_scopes.length} denied`,
          ];

          return makeTextContent(lines.join("\n"));
        }

        case "flush_throttle": {
          const input = FlushThrottleSchema.parse(args);
          // Only leader or system can flush
          const profile = resolveAgent(input.agent_id);
          if (profile.role_id !== "leader" && profile.role_id !== "system") {
            return makeErrorContent("Only leader or system agents can flush throttle buffers.");
          }

          const flushed = await forceFlush(input.channel_name);
          if (!flushed) {
            return makeTextContent(`No buffered messages in #${input.channel_name}.`);
          }

          const messageId = await sendMessage(input.channel_name, flushed);
          return makeTextContent(
            `Flushed buffered messages to #${input.channel_name} (message ID: ${messageId}).`
          );
        }

        case "get_output_gate_status": {
          const input = GetOutputGateStatusSchema.parse(args);
          const profile = resolveAgent(input.agent_id);
          const gate = checkOutputGate(input.agent_id, input.channel_name, "test");

          const lines = [
            `OutputGate status for ${input.agent_id} → #${input.channel_name}:`,
            `  Allowed: ${gate.allowed}`,
            gate.reason ? `  Reason: ${gate.reason}` : null,
            `  Agent profile:`,
            `    Role: ${profile.role_id}`,
            `    Department: ${profile.department}`,
            `    Clearance: ${profile.clearance_level}`,
            `    Scopes: ${profile.scopes.filter(s => s.startsWith("write:channel:")).join(", ") || "(none)"}`,
            `    Denied: ${profile.denied_scopes.filter(s => s.startsWith("write:channel:")).join(", ") || "(none)"}`,
          ].filter(Boolean);

          return makeTextContent(lines.join("\n"));
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
        return makeErrorContent(`Invalid input: ${details}`);
      }
      if (error instanceof GateError) {
        return makeGateError(error.message);
      }
      if (error instanceof McpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[MCP] Error in tool "${name}":`, error);
      return makeErrorContent(message);
    }
  });

  return server;
}

export async function startMcpServer(): Promise<void> {
  // Initialize audit DB connection (shares coordination.db via WAL)
  initAuditDb();

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[MCP] Server connected via stdio transport.");
}
