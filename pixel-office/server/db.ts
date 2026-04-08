import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

export function resolveDbPath(): string {
  // 1. Explicit env var (AI_OFFICE_WORKSPACE is an absolute path to .ai-office/)
  const workspace = process.env.AI_OFFICE_WORKSPACE;
  if (workspace) {
    return path.join(workspace, "state", "coordination.db");
  }

  // 2. PROJECT_DIR env var (set by the listener when spawning pixel-office)
  const projectDir = process.env.PROJECT_DIR;
  if (projectDir) {
    const dbPath = path.join(projectDir, ".ai-office", "state", "coordination.db");
    if (fs.existsSync(dbPath)) return dbPath;
  }

  // 3. Walk up from cwd to find project root (has config/office.yaml)
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "config", "office.yaml"))) {
      const localPath = path.join(dir, ".ai-office", "state", "coordination.db");
      if (fs.existsSync(localPath)) return localPath;
    }
    dir = path.dirname(dir);
  }

  throw new Error("Coordination DB not found. Set AI_OFFICE_WORKSPACE or run setup first.");
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  console.log(`[DB] Opened read-only: ${dbPath}`);
  return db;
}

// ─── Query Functions ─────────────────────────────────────────────────────────

export interface AgentRow {
  agent_id: string;
  role_id: string;
  department: string;
  status: string;
  current_task_id: string | null;
  clearance_level: number;
  last_heartbeat: string;
  registered_at: string;
}

export interface TaskRow {
  id: string;
  trace_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  risk_level: string;
  assigned_to: string | null;
  created_by: string;
  current_step: number;
  steps: string; // JSON
  context_summary: string;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  type: string;
  source_agent: string;
  target_agents: string;
  payload: string;
  trace_id: string;
  created_at: string;
}

export function getAllAgents(): AgentRow[] {
  return getDb()
    .prepare("SELECT * FROM agents ORDER BY department, agent_id")
    .all() as AgentRow[];
}

export function getAgentById(id: string): AgentRow | undefined {
  return getDb()
    .prepare("SELECT * FROM agents WHERE agent_id = ?")
    .get(id) as AgentRow | undefined;
}

export function getAllTasks(limit: number = 50): TaskRow[] {
  return getDb()
    .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as TaskRow[];
}

export function getTasksByStatus(status: string): TaskRow[] {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC")
    .all(status) as TaskRow[];
}

export function getTaskById(id: string): TaskRow | undefined {
  return getDb()
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(id) as TaskRow | undefined;
}

export function getRecentEvents(since: string, limit: number = 50): EventRow[] {
  return getDb()
    .prepare("SELECT * FROM events WHERE created_at > ? ORDER BY created_at ASC LIMIT ?")
    .all(since, limit) as EventRow[];
}

export function getSummary() {
  const db = getDb();

  const agentCounts = db
    .prepare("SELECT status, COUNT(*) as count FROM agents GROUP BY status")
    .all() as { status: string; count: number }[];

  const taskCounts = db
    .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
    .all() as { status: string; count: number }[];

  const recentEvents = db
    .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT 10")
    .all() as EventRow[];

  return {
    agents: Object.fromEntries(agentCounts.map((r) => [r.status, r.count])),
    tasks: Object.fromEntries(taskCounts.map((r) => [r.status, r.count])),
    recent_events: recentEvents,
  };
}

// ─── Audit Log ───────────────────────────────────────────────────────────────

export interface AuditLogRow {
  id: number;
  timestamp: string;
  agent_id: string;
  trace_id: string;
  action: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

export interface ArtifactRow {
  id: string;
  task_id: string;
  agent_id: string;
  name: string;
  path: string;
  checksum: string;
  version: number;
  created_at: string;
}

export interface TraceSpanRow {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  agent_id: string;
  operation: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  metadata: string; // JSON
}

export function getAuditLog(since?: string, limit: number = 50): AuditLogRow[] {
  const db = getDb();
  if (since) {
    return db.prepare("SELECT * FROM audit_log WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?")
      .all(since, limit) as AuditLogRow[];
  }
  return db.prepare("SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?")
    .all(limit) as AuditLogRow[];
}

export function getArtifacts(taskId?: string): ArtifactRow[] {
  const db = getDb();
  if (taskId) {
    return db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC")
      .all(taskId) as ArtifactRow[];
  }
  return db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC LIMIT 100")
    .all() as ArtifactRow[];
}

export function getTraceSpans(traceId: string): TraceSpanRow[] {
  return getDb()
    .prepare("SELECT * FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC")
    .all(traceId) as TraceSpanRow[];
}

// ─── Unified Activity Feed ────────────────────────────────────────────────────

export interface ActivityRow {
  source: 'event' | 'audit';
  id: string;
  timestamp: string;
  agent_id: string;
  type: string;        // event type or audit action
  target: string;      // target_agents for events, '' for audit
  detail: string;      // payload JSON for events, detail for audit
  trace_id: string;
}

export function getActivity(opts: {
  since?: string;
  limit?: number;
  agent?: string;
  type?: string;
}): ActivityRow[] {
  const db = getDb();
  const limit = opts.limit ?? 100;
  const since = opts.since ?? '1970-01-01';

  const eventConditions = ['created_at > ?'];
  const auditConditions = ['timestamp > ?'];
  const eventParams: any[] = [since];
  const auditParams: any[] = [since];

  if (opts.agent) {
    eventConditions.push('source_agent = ?');
    auditConditions.push('agent_id = ?');
    eventParams.push(opts.agent);
    auditParams.push(opts.agent);
  }
  if (opts.type) {
    eventConditions.push('type LIKE ?');
    auditConditions.push('action LIKE ?');
    eventParams.push(`%${opts.type}%`);
    auditParams.push(`%${opts.type}%`);
  }

  const sql = `
    SELECT 'event' as source, id, created_at as timestamp, source_agent as agent_id,
           type, target_agents as target, payload as detail, trace_id
    FROM events
    WHERE ${eventConditions.join(' AND ')}
    UNION ALL
    SELECT 'audit' as source, CAST(id AS TEXT) as id, timestamp, agent_id,
           action as type, '' as target, detail, trace_id
    FROM audit_log
    WHERE ${auditConditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(...eventParams, ...auditParams, limit) as ActivityRow[];
}
