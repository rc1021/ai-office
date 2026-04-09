import { createHash } from "node:crypto";
import { getDb, appendAudit, publishEvent, generateId } from "../database.js";
import type { Task, TaskStep } from "../types.js";

// ── task_create ──

/**
 * Compute a short hash of the task content for dedup.
 * Two tasks with the same title + description within the dedup window are considered duplicates.
 */
function computeContentHash(title: string, description: string): string {
  return createHash("sha256")
    .update(`${title.trim().toLowerCase()}|${description.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

/** Dedup window: ignore duplicate tasks created within this many seconds. */
const DEDUP_WINDOW_SECONDS = 300; // 5 minutes

export function taskCreate(params: {
  title: string;
  description?: string;
  created_by: string;
  assigned_to?: string;
  priority?: string;
  risk_level?: string;
  trace_id?: string;
  steps?: Array<{ description: string }>;
  input_artifacts?: string[];
}): Task {
  const db = getDb();
  const id = generateId("task");
  const traceId = params.trace_id ?? generateId("trace");
  const steps: TaskStep[] = (params.steps ?? []).map((s, i) => ({
    step_index: i,
    description: s.description,
    status: "pending" as const,
  }));
  const status = params.assigned_to ? "assigned" : "pending";
  const contentHash = computeContentHash(params.title, params.description ?? "");

  // ── Dedup check: reject if an active task with the same content hash exists recently ──
  const existing = db.prepare(`
    SELECT id, status, assigned_to FROM tasks
    WHERE content_hash = ?
      AND status IN ('pending', 'assigned', 'in_progress', 'checkpoint')
      AND created_at > datetime('now', ?)
  `).get(contentHash, `-${DEDUP_WINDOW_SECONDS} seconds`) as
    | { id: string; status: string; assigned_to: string | null }
    | undefined;

  if (existing) {
    throw new Error(
      `Duplicate task rejected: an active task with similar content already exists ` +
      `(task_id=${existing.id}, status=${existing.status}). ` +
      `Wait for it to complete/fail, or use a different title/description.`
    );
  }

  // ── Agent busy check: reject if the target agent already has an active task ──
  if (params.assigned_to) {
    const busyTask = db.prepare(`
      SELECT id, title FROM tasks
      WHERE assigned_to = ?
        AND status IN ('assigned', 'in_progress', 'checkpoint')
    `).get(params.assigned_to) as { id: string; title: string } | undefined;

    if (busyTask) {
      throw new Error(
        `Agent "${params.assigned_to}" is busy with task "${busyTask.title}" ` +
        `(task_id=${busyTask.id}). Wait for it to finish or assign to another agent.`
      );
    }
  }

  db.prepare(`
    INSERT INTO tasks (id, trace_id, title, description, status, priority, risk_level,
      assigned_to, created_by, steps, input_artifacts, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    traceId,
    params.title,
    params.description ?? "",
    status,
    params.priority ?? "normal",
    params.risk_level ?? "GREEN",
    params.assigned_to ?? null,
    params.created_by,
    JSON.stringify(steps),
    JSON.stringify(params.input_artifacts ?? []),
    contentHash
  );

  // Update agent status if assigned
  if (params.assigned_to) {
    db.prepare("UPDATE agents SET status = 'busy', current_task_id = ? WHERE agent_id = ?").run(
      id,
      params.assigned_to
    );
  }

  // Publish event
  publishEvent(generateId("evt"), "task.created", params.created_by, params.assigned_to ?? "*", {
    task_id: id,
    title: params.title,
    assigned_to: params.assigned_to,
    priority: params.priority ?? "normal",
  }, traceId);

  appendAudit(params.created_by, traceId, "task.created", `Task "${params.title}" created, id=${id}`);

  return getTask(id)!;
}

// ── task_update ──

export function taskUpdate(params: {
  task_id: string;
  agent_id: string;
  status?: string;
  assigned_to?: string;
  context_summary?: string;
  output_artifact?: string;
}): Task {
  const db = getDb();
  const task = getTask(params.task_id);
  if (!task) throw new Error(`Task ${params.task_id} not found`);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    updates.push("status = ?");
    values.push(params.status);
  }
  if (params.assigned_to) {
    updates.push("assigned_to = ?");
    values.push(params.assigned_to);
  }
  if (params.context_summary) {
    updates.push("context_summary = ?");
    values.push(params.context_summary);
  }
  if (params.output_artifact) {
    updates.push("output_artifact = ?");
    values.push(params.output_artifact);
  }

  if (updates.length > 0) {
    updates.push("updated_at = datetime('now')");
    values.push(params.task_id);
    db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  }

  // If completed, mark all non-completed steps as skipped
  if (params.status === "completed") {
    const stepsRow = db.prepare("SELECT steps FROM tasks WHERE id = ?").get(params.task_id) as { steps: string };
    const steps: TaskStep[] = JSON.parse(stepsRow.steps);
    let stepsChanged = false;
    for (const step of steps) {
      if (step.status !== "completed") {
        step.status = "skipped";
        step.completed_at = new Date().toISOString();
        stepsChanged = true;
      }
    }
    if (stepsChanged) {
      db.prepare("UPDATE tasks SET steps = ? WHERE id = ?").run(JSON.stringify(steps), params.task_id);
    }
  }

  // If completed/failed, free the agent
  if (params.status === "completed" || params.status === "failed") {
    if (task.assigned_to) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE agent_id = ?").run(
        task.assigned_to
      );
    }
    const eventType = params.status === "completed" ? "task.completed" : "task.failed";
    publishEvent(generateId("evt"), eventType, params.agent_id, "*", {
      task_id: params.task_id,
      title: task.title,
    }, task.trace_id);
  }

  appendAudit(params.agent_id, task.trace_id, "task.updated",
    `Task ${params.task_id} updated: ${updates.map(u => u.split(" =")[0]).join(", ")}`);

  return getTask(params.task_id)!;
}

// ── task_checkpoint (#6) ──

export function taskCheckpoint(params: {
  task_id: string;
  agent_id: string;
  step_index: number;
  output_artifact?: string;
  checksum?: string;
  context_summary?: string;
}): { task: Task; message: string } {
  const db = getDb();
  const task = getTask(params.task_id);
  if (!task) throw new Error(`Task ${params.task_id} not found`);

  const steps: TaskStep[] = JSON.parse(
    (db.prepare("SELECT steps FROM tasks WHERE id = ?").get(params.task_id) as { steps: string }).steps
  );

  if (params.step_index < 0 || params.step_index >= steps.length) {
    throw new Error(`Step index ${params.step_index} out of range (0-${steps.length - 1})`);
  }

  // Fill gaps — mark skipped steps
  const currentStep = task.current_step ?? 0;
  if (params.step_index > currentStep) {
    for (let i = currentStep; i < params.step_index; i++) {
      if (steps[i].status !== "completed") {
        steps[i].status = "skipped";
        steps[i].completed_at = new Date().toISOString();
      }
    }
  }

  // Update step
  steps[params.step_index].status = "completed";
  steps[params.step_index].completed_at = new Date().toISOString();
  if (params.output_artifact) steps[params.step_index].output_artifact = params.output_artifact;
  if (params.checksum) steps[params.step_index].checksum = params.checksum;

  // Mark next step as in_progress if exists
  const nextStep = params.step_index + 1;
  if (nextStep < steps.length) {
    steps[nextStep].status = "in_progress";
    steps[nextStep].started_at = new Date().toISOString();
  }

  db.prepare(`
    UPDATE tasks SET steps = ?, current_step = ?, status = 'checkpoint',
      context_summary = COALESCE(?, context_summary), updated_at = datetime('now')
    WHERE id = ?
  `).run(
    JSON.stringify(steps),
    nextStep,
    params.context_summary ?? null,
    params.task_id
  );

  publishEvent(generateId("evt"), "task.checkpoint", params.agent_id, "*", {
    task_id: params.task_id,
    step_index: params.step_index,
    next_step: nextStep < steps.length ? nextStep : null,
  }, task.trace_id);

  appendAudit(params.agent_id, task.trace_id, "task.checkpoint",
    `Step ${params.step_index} completed for task ${params.task_id}`);

  const allDone = steps.every((s) => s.status === "completed" || s.status === "skipped");
  const message = allDone
    ? `All ${steps.length} steps completed. Task ready for final update.`
    : `Step ${params.step_index} checkpointed. Next: step ${nextStep}.`;

  return { task: getTask(params.task_id)!, message };
}

// ── task_resume (#6) ──

export function taskResume(params: {
  agent_id: string;
  task_id?: string;
}): { task: Task | null; resume_context: string; message: string } {
  const db = getDb();

  let task: Task | null = null;

  if (params.task_id) {
    task = getTask(params.task_id);
  } else {
    // Find the most recent incomplete task assigned to this agent.
    // Also includes tasks marked failed by heartbeat timeout (recoverable).
    const row = db.prepare(`
      SELECT * FROM tasks
      WHERE assigned_to = ?
        AND (
          status IN ('assigned', 'in_progress', 'checkpoint')
          OR (status = 'failed' AND context_summary LIKE 'interrupted by heartbeat%')
        )
      ORDER BY updated_at DESC LIMIT 1
    `).get(params.agent_id) as RawTaskRow | undefined;
    if (row) task = rowToTask(row);
  }

  if (!task) {
    return { task: null, resume_context: "", message: "No pending tasks found." };
  }

  const steps: TaskStep[] = JSON.parse(
    (db.prepare("SELECT steps FROM tasks WHERE id = ?").get(task.id) as { steps: string }).steps
  );

  // Build resume context from last 2 completed steps' artifacts
  const completedSteps = steps.filter((s) => s.status === "completed").slice(-2);
  const artifactSummaries: string[] = [];
  for (const step of completedSteps) {
    if (step.output_artifact) {
      const artifact = db.prepare("SELECT name, path, checksum FROM artifacts WHERE id = ?").get(
        step.output_artifact
      ) as { name: string; path: string; checksum: string } | undefined;
      if (artifact) {
        artifactSummaries.push(`Step ${step.step_index}: ${artifact.name} (${artifact.path})`);
      }
    }
  }

  const currentStep = steps[task.current_step];
  const resumeContext = [
    `Task: ${task.title}`,
    `Status: ${task.status}, Current step: ${task.current_step}/${steps.length}`,
    task.context_summary ? `Context: ${task.context_summary}` : "",
    currentStep ? `Next step: ${currentStep.description}` : "All steps completed",
    artifactSummaries.length > 0 ? `Recent artifacts:\n${artifactSummaries.join("\n")}` : "",
  ].filter(Boolean).join("\n");

  // Check if current step's artifact already exists (skip if checksum matches)
  let message = `Resuming task ${task.id} at step ${task.current_step}.`;
  if (currentStep?.output_artifact && currentStep.checksum) {
    const existing = db.prepare("SELECT checksum FROM artifacts WHERE id = ?").get(
      currentStep.output_artifact
    ) as { checksum: string } | undefined;
    if (existing && existing.checksum === currentStep.checksum) {
      message += ` Step ${task.current_step} artifact already exists with matching checksum — skip.`;
    }
  }

  appendAudit(params.agent_id, task.trace_id, "task.resumed",
    `Resumed task ${task.id} at step ${task.current_step}`);

  return { task, resume_context: resumeContext, message };
}

// ── task_list ──

export function taskList(params: {
  status?: string;
  assigned_to?: string;
  limit?: number;
}): Task[] {
  const db = getDb();
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (params.status) {
    conditions.push("status = ?");
    values.push(params.status);
  }
  if (params.assigned_to) {
    conditions.push("assigned_to = ?");
    values.push(params.assigned_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  values.push(limit);

  const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`).all(
    ...values
  ) as RawTaskRow[];

  return rows.map(rowToTask);
}

// ── Helpers ──

interface RawTaskRow {
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
  steps: string;
  context_summary: string;
  content_hash: string;
  input_artifacts: string;
  output_artifact: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: RawTaskRow): Task {
  return {
    ...row,
    status: row.status as Task["status"],
    priority: row.priority as Task["priority"],
    risk_level: row.risk_level as Task["risk_level"],
    steps: JSON.parse(row.steps),
    input_artifacts: JSON.parse(row.input_artifacts),
  };
}

function getTask(id: string): Task | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as RawTaskRow | undefined;
  return row ? rowToTask(row) : null;
}
