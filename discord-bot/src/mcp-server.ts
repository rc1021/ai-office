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
} from "./channel-manager.js";
import {
  sendMessage,
  sendEmbed,
  readMessages,
  readNewMessages,
  createThread,
  sendThreadMessage,
} from "./message-manager.js";
import {
  createApproval,
  checkApproval,
} from "./approval-manager.js";
import { setupServer } from "./setup-server.js";
import { RiskLevel, EmbedInput } from "./types.js";

// ─── Input Schemas ────────────────────────────────────────────────────────────

const CreateCategorySchema = z.object({
  name: z.string().min(1).max(100),
});

const CreateChannelSchema = z.object({
  category_name: z.string().min(1),
  channel_name: z.string().min(1).max(100),
  topic: z.string().optional(),
});

const ListChannelsSchema = z.object({});

const DeleteChannelSchema = z.object({
  channel_name: z.string().min(1),
});

const SendMessageSchema = z.object({
  channel_name: z.string().min(1),
  content: z.string().min(1).max(2000),
});

const EmbedFieldSchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});

const SendEmbedSchema = z.object({
  channel_name: z.string().min(1),
  embed: z.object({
    title: z.string().min(1).max(256),
    description: z.string().min(1).max(4096),
    color: z.number().int().optional(),
    fields: z.array(EmbedFieldSchema).max(25).optional(),
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
  channel_name: z.string().min(1),
  message_id: z.string().min(1),
  thread_name: z.string().min(1).max(100),
});

const SendThreadMessageSchema = z.object({
  thread_id: z.string().min(1),
  content: z.string().min(1).max(2000),
});

const CreateApprovalSchema = z.object({
  channel_name: z.string().min(1),
  action: z.string().min(1),
  description: z.string().min(1),
  risk_level: z.enum(["GREEN", "YELLOW", "RED"]),
});

const CheckApprovalSchema = z.object({
  approval_id: z.string().min(1),
});

const SetupServerSchema = z.object({});

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "create_category",
    description: "Create a Discord category channel in the server.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Category name" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_channel",
    description: "Create a text channel under a specific category.",
    inputSchema: {
      type: "object",
      properties: {
        category_name: { type: "string", description: "Name of the parent category" },
        channel_name: { type: "string", description: "Name for the new channel (lowercase, alphanumeric, hyphens)" },
        topic: { type: "string", description: "Optional channel topic/description" },
      },
      required: ["category_name", "channel_name"],
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
    description: "Delete a channel or category by name.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Name of the channel or category to delete" },
      },
      required: ["channel_name"],
    },
  },
  {
    name: "send_message",
    description: "Send a plain text message to a Discord channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Target channel name (without #)" },
        content: { type: "string", description: "Message text (max 2000 chars)" },
      },
      required: ["channel_name", "content"],
    },
  },
  {
    name: "send_embed",
    description: "Send a rich embed message to a Discord channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string", description: "Target channel name" },
        embed: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            color: { type: "number", description: "Decimal color value (e.g. 5765120 for blue)" },
            fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  value: { type: "string" },
                },
                required: ["name", "value"],
              },
            },
            footer: { type: "string" },
          },
          required: ["title", "description"],
        },
      },
      required: ["channel_name", "embed"],
    },
  },
  {
    name: "read_messages",
    description: "Read recent messages from a channel (default 10, max 100).",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
        limit: { type: "number", description: "Number of messages to fetch (1-100, default 10)" },
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
    name: "create_thread",
    description: "Create a thread from an existing message in a channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
        message_id: { type: "string", description: "ID of the message to thread from" },
        thread_name: { type: "string", description: "Name for the new thread" },
      },
      required: ["channel_name", "message_id", "thread_name"],
    },
  },
  {
    name: "send_thread_message",
    description: "Send a message inside an existing thread.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string", description: "Thread channel ID" },
        content: { type: "string", description: "Message content" },
      },
      required: ["thread_id", "content"],
    },
  },
  {
    name: "create_approval",
    description:
      "Post an approval request with Approve/Reject/Preview buttons to a channel. Returns an approval_id to track the response.",
    inputSchema: {
      type: "object",
      properties: {
        channel_name: { type: "string" },
        action: { type: "string", description: "Short description of what is being approved" },
        description: { type: "string", description: "Detailed explanation of the action" },
        risk_level: {
          type: "string",
          enum: ["GREEN", "YELLOW", "RED"],
          description: "GREEN=low risk, YELLOW=moderate, RED=high risk",
        },
      },
      required: ["channel_name", "action", "description", "risk_level"],
    },
  },
  {
    name: "check_approval",
    description: "Check the current status of an approval request by its ID.",
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
    description:
      "Initialize the AI Office Discord server with the standard 11 channels across 3 categories (OFFICE, AI-WORKSPACE, SYSTEM). Idempotent — safe to run multiple times.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function safeStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function makeTextContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function makeErrorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: `ERROR: ${message}` }],
    isError: true,
  };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

export function createMcpServer(): Server {
  const server = new Server(
    { name: "ai-office-discord-bot", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

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
                return `\n📁 [CATEGORY] ${ch.name}`;
              }
              const topic = ch.topic ? ` — ${ch.topic}` : "";
              return `  💬 #${ch.name}${topic} (ID: ${ch.id})`;
            })
            .join("\n");
          return makeTextContent(`Server Channels:\n${formatted}`);
        }

        case "delete_channel": {
          const input = DeleteChannelSchema.parse(args);
          const deleted = await deleteChannel(input.channel_name);
          return makeTextContent(`Channel/category "${deleted}" has been deleted.`);
        }

        // ── Messaging ────────────────────────────────────────────────────────

        case "send_message": {
          const input = SendMessageSchema.parse(args);
          const messageId = await sendMessage(input.channel_name, input.content);
          return makeTextContent(
            `Message sent to #${input.channel_name} (message ID: ${messageId}).`
          );
        }

        case "send_embed": {
          const input = SendEmbedSchema.parse(args);
          const messageId = await sendEmbed(input.channel_name, input.embed as EmbedInput);
          return makeTextContent(
            `Embed "${input.embed.title}" sent to #${input.channel_name} (message ID: ${messageId}).`
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
                `[${m.timestamp}] ${m.isBot ? "🤖" : "👤"} ${m.author}: ${m.content}`
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
                `[${m.timestamp}] ${m.isBot ? "🤖" : "👤"} ${m.author}: ${m.content}`
            )
            .join("\n");
          return makeTextContent(
            `New messages in #${input.channel_name} (${messages.length}):\n\n${formatted}`
          );
        }

        // ── Threads ──────────────────────────────────────────────────────────

        case "create_thread": {
          const input = CreateThreadSchema.parse(args);
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
          const messageId = await sendThreadMessage(input.thread_id, input.content);
          return makeTextContent(
            `Message sent to thread ${input.thread_id} (message ID: ${messageId}).`
          );
        }

        // ── Approval Flow ────────────────────────────────────────────────────

        case "create_approval": {
          const input = CreateApprovalSchema.parse(args);
          const approval = await createApproval(
            input.channel_name,
            input.action,
            input.description,
            input.risk_level as RiskLevel
          );
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

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const details = error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
        return makeErrorContent(`Invalid input: ${details}`);
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
