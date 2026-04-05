import { getDb, appendAudit, publishEvent, generateId } from "../database.js";
import type { InboxMessage } from "../types.js";

// ── publish_artifact ──

export function publishArtifact(params: {
  task_id: string;
  agent_id: string;
  name: string;
  path: string;
  checksum: string;
  trace_id: string;
  version?: number;
}): { artifact_id: string; message: string } {
  const db = getDb();
  const id = generateId("art");

  // Check for existing artifact with same name and task
  const existing = db.prepare(
    "SELECT id, version, checksum FROM artifacts WHERE task_id = ? AND name = ? ORDER BY version DESC LIMIT 1"
  ).get(params.task_id, params.name) as { id: string; version: number; checksum: string } | undefined;

  const version = existing ? existing.version + 1 : params.version ?? 1;

  // Skip if checksum matches latest version
  if (existing && existing.checksum === params.checksum) {
    return {
      artifact_id: existing.id,
      message: `Artifact "${params.name}" already exists with same checksum. Skipped.`,
    };
  }

  db.prepare(`
    INSERT INTO artifacts (id, task_id, agent_id, name, path, checksum, version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.task_id, params.agent_id, params.name, params.path, params.checksum, version);

  // Broadcast artifact.published event
  publishEvent(generateId("evt"), "artifact.published", params.agent_id, "*", {
    artifact_id: id,
    task_id: params.task_id,
    name: params.name,
    path: params.path,
    version,
  }, params.trace_id);

  appendAudit(params.agent_id, params.trace_id, "artifact.published",
    `Published "${params.name}" v${version} for task ${params.task_id}`);

  return { artifact_id: id, message: `Artifact "${params.name}" v${version} published.` };
}

// ── check_inbox (#13) ──

export function checkInbox(params: {
  agent_id: string;
  mark_read?: boolean;
  limit?: number;
}): { messages: InboxMessage[]; unread_count: number } {
  const db = getDb();
  const limit = params.limit ?? 20;
  const markRead = params.mark_read !== false; // default true

  const messages = db.prepare(`
    SELECT * FROM inbox WHERE agent_id = ? AND read = 0
    ORDER BY created_at ASC LIMIT ?
  `).all(params.agent_id, limit) as InboxMessage[];

  const countRow = db.prepare(
    "SELECT COUNT(*) as count FROM inbox WHERE agent_id = ? AND read = 0"
  ).get(params.agent_id) as { count: number };

  if (markRead && messages.length > 0) {
    const ids = messages.map((m) => m.id);
    db.prepare(
      `UPDATE inbox SET read = 1 WHERE id IN (${ids.map(() => "?").join(",")})`
    ).run(...ids);
  }

  return { messages, unread_count: countRow.count };
}

// ── publish_event (generic) ──

export function publishGenericEvent(params: {
  type: string;
  source_agent: string;
  target_agents?: string;
  payload: object;
  trace_id: string;
}): { event_id: string } {
  const id = generateId("evt");
  publishEvent(
    id,
    params.type,
    params.source_agent,
    params.target_agents ?? "*",
    params.payload,
    params.trace_id
  );

  appendAudit(params.source_agent, params.trace_id, "event.published",
    `Event ${params.type} published, targets: ${params.target_agents ?? "*"}`);

  return { event_id: id };
}
