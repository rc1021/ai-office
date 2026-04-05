import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { initDatabase, initAuditChain } from "./database.js";
import { taskCreate, taskUpdate, taskCheckpoint, taskResume, taskList } from "./tools/task-tools.js";
import { publishArtifact, checkInbox, publishGenericEvent } from "./tools/event-tools.js";
import {
  reportStatus, listAgents, startTrace, endTrace, getTrace,
  readAuditLog, verifyAuditChain,
} from "./tools/observability-tools.js";
import {
  validateNumeric, crossVerify, reportAnomaly, pipelineGate,
} from "./tools/validation-tools.js";
import { initAuth, enforceIdentity, enforceClearance } from "./auth.js";

// ── Resolve workspace path ──

const WORKSPACE = process.env.AI_OFFICE_WORKSPACE ?? path.join(
  process.env.HOME ?? "~", ".ai-office"
);

// ── Initialize database ──

const db = initDatabase(WORKSPACE);
initAuditChain(db);

// ── Authenticate agent (if token provided) ──
initAuth();

// ── MCP Server ──

const server = new McpServer({
  name: "ai-office-coordination",
  version: "1.0.0",
});

// ════════════════════════════════════════
// Task Management Tools (#6)
// ════════════════════════════════════════

server.tool(
  "task_create",
  "Create a new task and optionally assign it to an agent",
  {
    title: z.string().describe("Task title"),
    description: z.string().optional().describe("Task description"),
    created_by: z.string().describe("Agent ID of the creator"),
    assigned_to: z.string().optional().describe("Agent ID to assign to"),
    priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
    risk_level: z.enum(["GREEN", "YELLOW", "RED"]).optional(),
    trace_id: z.string().optional().describe("Trace ID for distributed tracing"),
    steps: z.array(z.object({ description: z.string() })).optional().describe("Task steps"),
    input_artifacts: z.array(z.string()).optional().describe("Input artifact paths"),
  },
  async (params) => {
    enforceIdentity(params.created_by);
    return { content: [{ type: "text" as const, text: JSON.stringify(taskCreate(params), null, 2) }] };
  }
);

server.tool(
  "task_update",
  "Update a task's status, assignment, or context",
  {
    task_id: z.string(),
    agent_id: z.string().describe("Agent making the update"),
    status: z.enum(["pending", "assigned", "in_progress", "checkpoint", "completed", "failed", "cancelled"]).optional(),
    assigned_to: z.string().optional(),
    context_summary: z.string().optional().describe("Updated context summary for resume"),
    output_artifact: z.string().optional(),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(taskUpdate(params), null, 2) }] };
  }
);

server.tool(
  "task_checkpoint",
  "Save progress at a step boundary for crash recovery (#6)",
  {
    task_id: z.string(),
    agent_id: z.string(),
    step_index: z.number().describe("Index of the completed step"),
    output_artifact: z.string().optional().describe("Artifact ID produced by this step"),
    checksum: z.string().optional().describe("Checksum for skip-on-match logic"),
    context_summary: z.string().optional().describe("Summary for context rebuilding on resume"),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(taskCheckpoint(params), null, 2) }] };
  }
);

server.tool(
  "task_resume",
  "Resume an interrupted task — rebuilds context from checkpoints (#6)",
  {
    agent_id: z.string(),
    task_id: z.string().optional().describe("Specific task to resume, or auto-find latest"),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(taskResume(params), null, 2) }] };
  }
);

server.tool(
  "task_list",
  "List tasks with optional filters",
  {
    status: z.string().optional(),
    assigned_to: z.string().optional(),
    limit: z.number().optional(),
  },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(taskList(params), null, 2) }] })
);

// ════════════════════════════════════════
// Event Bus & Inbox Tools (#13)
// ════════════════════════════════════════

server.tool(
  "publish_artifact",
  "Publish a shared artifact and notify all agents (#13)",
  {
    task_id: z.string(),
    agent_id: z.string(),
    name: z.string().describe("Artifact name"),
    path: z.string().describe("File path to the artifact"),
    checksum: z.string().describe("SHA256 checksum of the artifact content"),
    trace_id: z.string(),
    version: z.number().optional(),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(publishArtifact(params), null, 2) }] };
  }
);

server.tool(
  "check_inbox",
  "Read unread messages from agent inbox (#13)",
  {
    agent_id: z.string(),
    mark_read: z.boolean().optional().describe("Mark messages as read (default: true)"),
    limit: z.number().optional().describe("Max messages to return (default: 20)"),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(checkInbox(params), null, 2) }] };
  }
);

server.tool(
  "publish_event",
  "Publish a generic event to the event bus",
  {
    type: z.string().describe("Event type"),
    source_agent: z.string(),
    target_agents: z.string().optional().describe("Comma-separated agent IDs or '*' for broadcast"),
    payload: z.record(z.unknown()).describe("Event payload"),
    trace_id: z.string(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: JSON.stringify(publishGenericEvent({
      ...params,
      payload: params.payload as object,
    }), null, 2) }]
  })
);

// ════════════════════════════════════════
// Observability Tools (#33)
// ════════════════════════════════════════

server.tool(
  "report_status",
  "Report agent status / heartbeat (#33)",
  {
    agent_id: z.string(),
    role_id: z.string(),
    department: z.string().optional(),
    status: z.enum(["online", "busy", "idle", "offline"]),
    current_task_id: z.string().optional(),
    clearance_level: z.number().optional(),
  },
  async (params) => {
    enforceIdentity(params.agent_id);
    return { content: [{ type: "text" as const, text: JSON.stringify(reportStatus(params), null, 2) }] };
  }
);

server.tool(
  "list_agents",
  "List registered agents with optional filters",
  {
    status: z.string().optional(),
    department: z.string().optional(),
  },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(listAgents(params), null, 2) }] })
);

server.tool(
  "start_trace",
  "Start a distributed trace span (#33)",
  {
    agent_id: z.string(),
    operation: z.string().describe("Name of the operation being traced"),
    trace_id: z.string().optional().describe("Existing trace ID to join, or auto-generate"),
    parent_span_id: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: JSON.stringify(startTrace({
      ...params,
      metadata: params.metadata as object | undefined,
    }), null, 2) }]
  })
);

server.tool(
  "end_trace",
  "End a trace span",
  {
    span_id: z.string(),
    status: z.enum(["completed", "error"]),
    metadata: z.record(z.unknown()).optional(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: JSON.stringify(endTrace({
      ...params,
      metadata: params.metadata as object | undefined,
    }), null, 2) }]
  })
);

server.tool(
  "get_trace",
  "Get all spans for a trace",
  { trace_id: z.string() },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(getTrace(params), null, 2) }] })
);

server.tool(
  "read_audit_log",
  "Read audit log entries with optional filters (#33)",
  {
    trace_id: z.string().optional(),
    agent_id: z.string().optional(),
    limit: z.number().optional(),
  },
  async (params) => {
    enforceClearance(3); // Audit log requires RESTRICTED clearance
    return { content: [{ type: "text" as const, text: JSON.stringify(readAuditLog(params), null, 2) }] };
  }
);

server.tool(
  "verify_audit_chain",
  "Verify the integrity of the hash-chained audit log (#33)",
  { limit: z.number().optional() },
  async (params) => {
    enforceClearance(3); // Audit chain verification requires RESTRICTED clearance
    return { content: [{ type: "text" as const, text: JSON.stringify(verifyAuditChain(params), null, 2) }] };
  }
);

// ════════════════════════════════════════
// Validation Tools (#14/#15)
// ════════════════════════════════════════

server.tool(
  "validate_numeric",
  "Validate a numeric value with range, cross-check formula, and baseline tolerance (#14/#15)",
  {
    agent_id: z.string(),
    trace_id: z.string(),
    value: z.number(),
    field_name: z.string(),
    expected_range: z.object({ min: z.number(), max: z.number() }).optional(),
    cross_check_formula: z.string().optional().describe("Formula like 'revenue - expenses'"),
    cross_check_values: z.record(z.number()).optional().describe("Variable values for the formula"),
    tolerance_pct: z.number().optional().describe("Allowed deviation from baseline (%)"),
    baseline: z.number().optional().describe("Historical baseline value"),
  },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(validateNumeric(params), null, 2) }] })
);

server.tool(
  "cross_verify",
  "Compare two agents' independent calculations for the same value (#15)",
  {
    task_id: z.string(),
    trace_id: z.string(),
    field_name: z.string(),
    agent_a: z.string(),
    value_a: z.number(),
    agent_b: z.string(),
    value_b: z.number(),
    tolerance_pct: z.number().optional().describe("Allowed difference (%) — default 0.01"),
  },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(crossVerify(params), null, 2) }] })
);

server.tool(
  "report_anomaly",
  "Report an anomaly to the Leader for review (#15)",
  {
    agent_id: z.string(),
    trace_id: z.string(),
    task_id: z.string().optional(),
    severity: z.enum(["warning", "error", "critical"]),
    description: z.string(),
    data: z.record(z.unknown()).optional(),
  },
  async (params) => ({
    content: [{ type: "text" as const, text: JSON.stringify(reportAnomaly({
      ...params,
      data: params.data as object | undefined,
    }), null, 2) }]
  })
);

server.tool(
  "pipeline_gate",
  "Validate conditions before proceeding to next step (#14)",
  {
    agent_id: z.string(),
    trace_id: z.string(),
    task_id: z.string(),
    step_index: z.number(),
    checks: z.array(z.object({
      name: z.string(),
      condition: z.boolean(),
      detail: z.string().optional(),
    })),
  },
  async (params) => ({ content: [{ type: "text" as const, text: JSON.stringify(pipelineGate(params), null, 2) }] })
);

// ════════════════════════════════════════
// Start Server
// ════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now running on stdio
}

main().catch((err) => {
  console.error("Failed to start coordination server:", err);
  process.exit(1);
});
