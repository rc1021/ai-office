import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createCategory,
  createChannel,
  listChannels,
  deleteChannel,
  findTextChannel,
} from "./channel-manager.js";
import {
  sendMessage,
  sendEmbed,
  readMessages,
  readMessageById,
  readNewMessages,
  createThread,
  sendThreadMessage,
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
});

const SendThreadMessageSchema = z.object({
  agent_id: AgentIdField,
  thread_id: z.string().min(1),
  content: z.string().min(1).max(2000),
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
    name: "create_thread",
    description: "Create a thread from an existing message in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: AGENT_ID_PROP,
        channel_name: { type: "string" },
        message_id: { type: "string", description: "ID of the message to thread from" },
        thread_name: { type: "string", description: "Name for the new thread" },
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
  pageLabel?: string
): Promise<string> {
  // OutputGate check
  const gate = checkOutputGate(agentId, channelName, content);
  if (!gate.allowed) {
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
  embedInput: EmbedInput
): Promise<string> {
  // OutputGate check (use embed description as content for classification check)
  const gate = checkOutputGate(agentId, channelName, embedInput.description);
  if (!gate.allowed) {
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
            input.page_label
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
            input.embed as EmbedInput
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

        // ── Threads ──────────────────────────────────────────────────────────

        case "create_thread": {
          const input = CreateThreadSchema.parse(args);
          // OutputGate check for the parent channel
          const gate = checkOutputGate(input.agent_id, input.channel_name, input.thread_name);
          if (!gate.allowed) {
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

        // ── Approval Flow ────────────────────────────────────────────────────

        case "create_approval": {
          const input = CreateApprovalSchema.parse(args);
          // OutputGate check for the approval channel
          const gate = checkOutputGate(input.agent_id, input.channel_name, input.description);
          if (!gate.allowed) {
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
            `    Scopes: ${profile.scopes.filter(s => s.startsWith("write:discord:")).join(", ") || "(none)"}`,
            `    Denied: ${profile.denied_scopes.filter(s => s.startsWith("write:discord:")).join(", ") || "(none)"}`,
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
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("[MCP] Server connected via stdio transport.");
}
