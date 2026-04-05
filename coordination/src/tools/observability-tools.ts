import { getDb, appendAudit, publishEvent, generateId } from "../database.js";
import type { AgentRecord, AgentStatus, TraceSpan } from "../types.js";

// ── report_status (#33: agent heartbeat) ──

export function reportStatus(params: {
  agent_id: string;
  role_id: string;
  department?: string;
  status: string;
  current_task_id?: string;
  clearance_level?: number;
}): { agent: AgentRecord; message: string } {
  const db = getDb();
  const status = params.status as AgentStatus;

  // Upsert agent record
  const existing = db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(
    params.agent_id
  ) as { agent_id: string } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE agents SET status = ?, current_task_id = ?, last_heartbeat = datetime('now')
      WHERE agent_id = ?
    `).run(status, params.current_task_id ?? null, params.agent_id);
  } else {
    db.prepare(`
      INSERT INTO agents (agent_id, role_id, department, status, current_task_id, clearance_level)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      params.agent_id,
      params.role_id,
      params.department ?? "",
      status,
      params.current_task_id ?? null,
      params.clearance_level ?? 0
    );

    // Announce new agent
    publishEvent(generateId("evt"), "agent.online", params.agent_id, "*", {
      agent_id: params.agent_id,
      role_id: params.role_id,
      department: params.department,
    }, "");
  }

  const agent = db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(
    params.agent_id
  ) as AgentRecord;

  return { agent, message: `Agent ${params.agent_id} status: ${status}` };
}

// ── list_agents ──

export function listAgents(params: {
  status?: string;
  department?: string;
}): AgentRecord[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }
  if (params.department) {
    conditions.push("department = ?");
    values.push(params.department);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM agents ${where} ORDER BY agent_id`).all(...values) as AgentRecord[];
}

// ── start_trace (#33: distributed tracing) ──

export function startTrace(params: {
  agent_id: string;
  operation: string;
  trace_id?: string;
  parent_span_id?: string;
  metadata?: object;
}): { trace_id: string; span_id: string } {
  const db = getDb();
  const traceId = params.trace_id ?? generateId("trace");
  const spanId = generateId("span");

  db.prepare(`
    INSERT INTO trace_spans (trace_id, span_id, parent_span_id, agent_id, operation, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    traceId,
    spanId,
    params.parent_span_id ?? null,
    params.agent_id,
    params.operation,
    JSON.stringify(params.metadata ?? {})
  );

  return { trace_id: traceId, span_id: spanId };
}

// ── end_trace ──

export function endTrace(params: {
  span_id: string;
  status: "completed" | "error";
  metadata?: object;
}): { message: string } {
  const db = getDb();

  const existing = db.prepare("SELECT metadata FROM trace_spans WHERE span_id = ?").get(
    params.span_id
  ) as { metadata: string } | undefined;

  if (!existing) throw new Error(`Span ${params.span_id} not found`);

  // Merge metadata
  let mergedMeta = JSON.parse(existing.metadata);
  if (params.metadata) {
    mergedMeta = { ...mergedMeta, ...params.metadata };
  }

  db.prepare(`
    UPDATE trace_spans SET status = ?, ended_at = datetime('now'), metadata = ?
    WHERE span_id = ?
  `).run(params.status, JSON.stringify(mergedMeta), params.span_id);

  return { message: `Span ${params.span_id} ended with status: ${params.status}` };
}

// ── get_trace ──

export function getTrace(params: {
  trace_id: string;
}): TraceSpan[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC"
  ).all(params.trace_id) as TraceSpan[];
}

// ── read_audit_log ──

export function readAuditLog(params: {
  trace_id?: string;
  agent_id?: string;
  limit?: number;
}): Array<{ id: number; timestamp: string; agent_id: string; trace_id: string; action: string; detail: string; hash: string }> {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.trace_id) {
    conditions.push("trace_id = ?");
    values.push(params.trace_id);
  }
  if (params.agent_id) {
    conditions.push("agent_id = ?");
    values.push(params.agent_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  values.push(limit);

  return db.prepare(
    `SELECT id, timestamp, agent_id, trace_id, action, detail, hash FROM audit_log ${where} ORDER BY id DESC LIMIT ?`
  ).all(...values) as Array<{ id: number; timestamp: string; agent_id: string; trace_id: string; action: string; detail: string; hash: string }>;
}

// ── verify_audit_chain (#33: tamper detection) ──

export function verifyAuditChain(params: {
  limit?: number;
}): { valid: boolean; checked: number; first_invalid_id?: number } {
  const db = getDb();
  const limit = params.limit ?? 1000;

  const rows = db.prepare(
    "SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC LIMIT ?"
  ).all(limit) as Array<{ id: number; prev_hash: string; hash: string }>;

  if (rows.length === 0) return { valid: true, checked: 0 };

  // First entry's prev_hash should be "genesis"
  let expectedPrev = "genesis";
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { valid: false, checked: rows.length, first_invalid_id: row.id };
    }
    expectedPrev = row.hash;
  }

  return { valid: true, checked: rows.length };
}
