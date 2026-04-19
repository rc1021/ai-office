import { Cron } from "croner";
import { getDb, appendAudit, generateId } from "../database.js";

// ── Types ──

interface JobRow {
  id: string;
  name: string;
  schedule_type: string;
  schedule_config: string;  // JSON
  task_template: string;    // JSON
  enabled: number;
  last_run_at: string | null;
  next_run_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// ── Helpers ──

/**
 * Compute the initial next_run_at for a new dynamic job.
 * All times are in UTC by default; pass timezone in config for cron-type jobs.
 * The Leader is responsible for converting user-facing local times to UTC
 * before calling job_create for interval/daily/weekly types.
 */
function computeInitialNextRunAt(scheduleType: string, config: Record<string, unknown>): string {
  const now = Date.now();

  if (scheduleType === "interval") {
    const intervalMs = ((config.minutes as number) ?? 60) * 60_000;
    return new Date(now + intervalMs).toISOString();
  }

  if (scheduleType === "daily") {
    const hour = (config.hour as number) ?? 8;
    const minute = (config.minute as number) ?? 0;
    const d = new Date();
    d.setUTCHours(hour, minute, 0, 0);
    if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }

  if (scheduleType === "weekly") {
    const weekday = (config.weekday as number) ?? 1; // Monday
    const hour = (config.hour as number) ?? 8;
    const minute = (config.minute as number) ?? 0;
    const d = new Date();
    d.setUTCHours(hour, minute, 0, 0);
    const currentDay = d.getUTCDay();
    let daysUntil = (weekday - currentDay + 7) % 7;
    if (daysUntil === 0 && d.getTime() <= now) daysUntil = 7;
    d.setUTCDate(d.getUTCDate() + daysUntil);
    return d.toISOString();
  }

  // cron format: schedule_config = {cron: "* * * * *", timezone?: "..."}
  if (scheduleType === "cron" || config.cron) {
    try {
      const cronExpr = config.cron as string;
      const tz = (config.timezone as string | undefined) ?? "UTC";
      const c = new Cron(cronExpr, { timezone: tz });
      const next = c.nextRun();
      c.stop();
      if (next) return next.toISOString();
    } catch { /* fall through to default */ }
  }

  return new Date(now + 60 * 60_000).toISOString();
}

function deserializeJob(job: JobRow) {
  return {
    id: job.id,
    name: job.name,
    schedule_type: job.schedule_type,
    schedule_config: JSON.parse(job.schedule_config) as object,
    task_template: JSON.parse(job.task_template) as object,
    enabled: job.enabled === 1,
    last_run_at: job.last_run_at,
    next_run_at: job.next_run_at,
    created_by: job.created_by,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
}

// ── job_create ──

export function jobCreate(params: {
  name: string;
  schedule_type: string;
  schedule_config: object;
  task_template: object;
  enabled?: boolean;
  agent_id: string;
}): object {
  const db = getDb();
  const id = generateId("job");
  const config = params.schedule_config as Record<string, unknown>;
  const nextRunAt = computeInitialNextRunAt(params.schedule_type, config);
  const scheduleConfigStr = JSON.stringify(params.schedule_config);
  const taskTemplateStr = JSON.stringify(params.task_template);
  const enabled = params.enabled !== false ? 1 : 0;

  db.prepare(
    "INSERT INTO jobs (id, name, schedule_type, schedule_config, task_template, enabled, next_run_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(id, params.name, params.schedule_type, scheduleConfigStr, taskTemplateStr, enabled, nextRunAt, params.agent_id);

  appendAudit(params.agent_id, "", "job.created",
    `Job "${params.name}" (${id}) created — ${params.schedule_type}, next: ${nextRunAt}`);

  return {
    ok: true,
    id,
    name: params.name,
    schedule_type: params.schedule_type,
    next_run_at: nextRunAt,
    enabled: enabled === 1,
  };
}

// ── job_list ──

export function jobList(params: { enabled?: boolean; limit?: number }): object {
  const db = getDb();
  const limit = params.limit ?? 50;
  const jobs = params.enabled !== undefined
    ? db.prepare("SELECT * FROM jobs WHERE enabled = ? ORDER BY next_run_at ASC LIMIT ?")
        .all(params.enabled ? 1 : 0, limit) as JobRow[]
    : db.prepare("SELECT * FROM jobs ORDER BY next_run_at ASC LIMIT ?")
        .all(limit) as JobRow[];

  return { jobs: jobs.map(deserializeJob), total: jobs.length };
}

// ── job_update ──

export function jobUpdate(params: {
  job_id: string;
  agent_id: string;
  enabled?: boolean;
  schedule_config?: object;
  task_template?: object;
  name?: string;
}): object {
  const db = getDb();
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(params.job_id) as JobRow | undefined;
  if (!job) return { ok: false, error: `Job ${params.job_id} not found` };

  const setClauses: string[] = ["updated_at = datetime('now')"];
  const args: unknown[] = [];

  if (params.name !== undefined) {
    setClauses.push("name = ?");
    args.push(params.name);
  }
  if (params.enabled !== undefined) {
    setClauses.push("enabled = ?");
    args.push(params.enabled ? 1 : 0);
  }
  if (params.schedule_config !== undefined) {
    setClauses.push("schedule_config = ?");
    args.push(JSON.stringify(params.schedule_config));
    // Recompute next_run_at from new config
    const newNext = computeInitialNextRunAt(job.schedule_type, params.schedule_config as Record<string, unknown>);
    setClauses.push("next_run_at = ?");
    args.push(newNext);
  }
  if (params.task_template !== undefined) {
    setClauses.push("task_template = ?");
    args.push(JSON.stringify(params.task_template));
  }

  args.push(params.job_id);
  db.prepare(`UPDATE jobs SET ${setClauses.join(", ")} WHERE id = ?`).run(...(args as Parameters<typeof db.prepare>));

  appendAudit(params.agent_id, "", "job.updated", `Job "${job.name}" (${params.job_id}) updated`);
  return { ok: true, job_id: params.job_id };
}

// ── job_delete ──

export function jobDelete(params: { job_id: string; agent_id: string }): object {
  const db = getDb();
  const job = db.prepare("SELECT name FROM jobs WHERE id = ?").get(params.job_id) as
    | { name: string }
    | undefined;
  if (!job) return { ok: false, error: `Job ${params.job_id} not found` };

  db.prepare("DELETE FROM jobs WHERE id = ?").run(params.job_id);
  appendAudit(params.agent_id, "", "job.deleted", `Job "${job.name}" (${params.job_id}) deleted`);
  return { ok: true };
}
