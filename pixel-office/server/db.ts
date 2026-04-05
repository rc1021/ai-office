import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;

export function resolveDbPath(): string {
  // 1. Explicit env var
  const workspace = process.env.AI_OFFICE_WORKSPACE?.replace("~", process.env.HOME ?? "");
  if (workspace) {
    return path.join(workspace, "state", "coordination.db");
  }

  // 2. Walk up from cwd to find project root (has config/office.yaml),
  //    then read the paths.state from office.yaml or fall back to .ai-office/state
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "config", "office.yaml"))) {
      // Check ~/.ai-office first (standard location)
      const homePath = path.join(process.env.HOME ?? "", ".ai-office", "state", "coordination.db");
      if (fs.existsSync(homePath)) return homePath;

      // Then check project-local .ai-office
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
