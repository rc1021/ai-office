import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { SCHEMA_VERSION } from "./types.js";

// ── Database singleton ──

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function initDatabase(workspacePath: string): Database.Database {
  const dbDir = path.join(workspacePath, "state");
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, "coordination.db");
  db = new Database(dbPath);

  // WAL mode for concurrent read access (#13)
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  // Run migrations
  migrate(db);

  return db;
}

// ── Migration System (#31) ──

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: "Initial schema — tasks, agents, events, inbox, audit, artifacts, traces",
    up: (db) => {
      db.exec(`
        -- Tasks (#6: state machine with checkpoint/resume)
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','assigned','in_progress','checkpoint','completed','failed','cancelled')),
          priority TEXT NOT NULL DEFAULT 'normal'
            CHECK(priority IN ('low','normal','high','urgent')),
          risk_level TEXT NOT NULL DEFAULT 'GREEN'
            CHECK(risk_level IN ('GREEN','YELLOW','RED')),
          assigned_to TEXT,
          created_by TEXT NOT NULL,
          current_step INTEGER NOT NULL DEFAULT 0,
          steps TEXT NOT NULL DEFAULT '[]',
          context_summary TEXT NOT NULL DEFAULT '',
          input_artifacts TEXT NOT NULL DEFAULT '[]',
          output_artifact TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
        CREATE INDEX IF NOT EXISTS idx_tasks_trace ON tasks(trace_id);

        -- Agents (#33: heartbeat + status tracking)
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          role_id TEXT NOT NULL,
          department TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'offline'
            CHECK(status IN ('online','busy','idle','offline')),
          current_task_id TEXT,
          clearance_level INTEGER NOT NULL DEFAULT 0,
          last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
          registered_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (current_task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);

        -- Events (#13: event bus for state synchronization)
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          source_agent TEXT NOT NULL,
          target_agents TEXT NOT NULL DEFAULT '*',
          payload TEXT NOT NULL DEFAULT '{}',
          trace_id TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          processed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

        -- Inbox (#13: per-agent message queue)
        CREATE TABLE IF NOT EXISTS inbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL DEFAULT '{}',
          read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (event_id) REFERENCES events(id)
        );
        CREATE INDEX IF NOT EXISTS idx_inbox_agent ON inbox(agent_id, read);

        -- Audit Log (#33: hash-chained, tamper-evident)
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          agent_id TEXT NOT NULL,
          trace_id TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT '',
          prev_hash TEXT NOT NULL DEFAULT '',
          hash TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_log(trace_id);

        -- Artifacts (#6: shared outputs with versioning)
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          checksum TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (task_id) REFERENCES tasks(id)
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

        -- Trace Spans (#33: distributed tracing)
        CREATE TABLE IF NOT EXISTS trace_spans (
          trace_id TEXT NOT NULL,
          span_id TEXT PRIMARY KEY,
          parent_span_id TEXT,
          agent_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK(status IN ('active','completed','error')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          metadata TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (parent_span_id) REFERENCES trace_spans(span_id)
        );
        CREATE INDEX IF NOT EXISTS idx_spans_trace ON trace_spans(trace_id);

        -- Schema version tracking
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '1');
      `);
    },
  },
];

function migrate(db: Database.Database): void {
  // Get current version
  let currentVersion = 0;
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as
      | { value: string }
      | undefined;
    if (row) currentVersion = parseInt(row.value, 10);
  } catch {
    // Table doesn't exist yet — will be created by migration 1
  }

  // Run pending migrations in a transaction
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);
  if (pendingMigrations.length === 0) return;

  const runMigrations = db.transaction(() => {
    for (const migration of pendingMigrations) {
      migration.up(db);
      db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', ?)").run(
        String(migration.version)
      );
    }
  });

  runMigrations();
}

// ── Audit Log Helpers (#33) ──

let lastAuditHash = "";

export function initAuditChain(db: Database.Database): void {
  const lastRow = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  lastAuditHash = lastRow?.hash ?? "genesis";
}

export function appendAudit(
  agentId: string,
  traceId: string,
  action: string,
  detail: string
): void {
  const db = getDb();
  const prevHash = lastAuditHash;
  const record = JSON.stringify({ agentId, traceId, action, detail, prevHash, timestamp: new Date().toISOString() });
  const hash = createHash("sha256").update(prevHash + record).digest("hex");

  db.prepare(
    "INSERT INTO audit_log (agent_id, trace_id, action, detail, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(agentId, traceId, action, detail, prevHash, hash);

  lastAuditHash = hash;
}

// ── Event Bus Helpers (#13) ──

export function publishEvent(
  id: string,
  type: string,
  sourceAgent: string,
  targetAgents: string,
  payload: object,
  traceId: string
): void {
  const db = getDb();
  const payloadStr = JSON.stringify(payload);

  db.prepare(
    "INSERT INTO events (id, type, source_agent, target_agents, payload, trace_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, type, sourceAgent, targetAgents, payloadStr, traceId);

  // Route to inboxes
  const insert = db.prepare(
    "INSERT INTO inbox (agent_id, event_id, event_type, payload) VALUES (?, ?, ?, ?)"
  );

  if (targetAgents === "*") {
    // Broadcast: add to all registered agents' inboxes (except source)
    const agents = db
      .prepare("SELECT agent_id FROM agents WHERE agent_id != ?")
      .all(sourceAgent) as { agent_id: string }[];
    for (const agent of agents) {
      insert.run(agent.agent_id, id, type, payloadStr);
    }
  } else {
    // Targeted: route to specific agents, supporting "role:<role_id>" syntax
    const targets = targetAgents.split(",").map((s) => s.trim());
    const resolved: string[] = [];
    for (const target of targets) {
      if (target.startsWith("role:")) {
        const roleId = target.slice(5);
        const agents = db
          .prepare("SELECT agent_id FROM agents WHERE role_id = ?")
          .all(roleId) as { agent_id: string }[];
        resolved.push(...agents.map((a) => a.agent_id));
      } else if (target) {
        resolved.push(target);
      }
    }
    for (const agentId of resolved) {
      if (agentId !== sourceAgent) {
        insert.run(agentId, id, type, payloadStr);
      }
    }
  }
}

// ── ID Generation ──

export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}
