// ── Risk & Status Enums ──

export type RiskLevel = "GREEN" | "YELLOW" | "RED";
export type TaskStatus = "pending" | "assigned" | "in_progress" | "checkpoint" | "completed" | "failed" | "cancelled";
export type AgentStatus = "online" | "busy" | "idle" | "offline";
export type EventType =
  | "task.created"
  | "task.assigned"
  | "task.checkpoint"
  | "task.completed"
  | "task.failed"
  | "artifact.published"
  | "anomaly.reported"
  | "verification.failed"
  | "agent.online"
  | "agent.offline"
  | "agent.heartbeat"
  | "approval.escalation_requested"
  | "approval.created"
  | "approval.resolved"
  | "approval.timeout";

// ── Task ──

export interface TaskStep {
  step_index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "skipped" | "failed";
  output_artifact?: string;
  checksum?: string;
  started_at?: string;
  completed_at?: string;
}

export interface Task {
  id: string;
  trace_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  risk_level: RiskLevel;
  assigned_to: string | null;
  created_by: string;
  current_step: number;
  steps: TaskStep[];
  context_summary: string;
  content_hash: string;
  input_artifacts: string[];
  output_artifact: string | null;
  created_at: string;
  updated_at: string;
}

// ── Agent ──

export interface AgentRecord {
  agent_id: string;
  role_id: string;
  department: string;
  status: AgentStatus;
  current_task_id: string | null;
  clearance_level: number;
  last_heartbeat: string;
  registered_at: string;
}

// ── Event ──

export interface Event {
  id: string;
  type: EventType;
  source_agent: string;
  target_agents: string; // "*" for broadcast, comma-separated agent IDs
  payload: string; // JSON string
  trace_id: string;
  created_at: string;
  processed: boolean;
}

// ── Inbox Message ──

export interface InboxMessage {
  id: number;
  agent_id: string;
  event_id: string;
  event_type: EventType;
  payload: string;
  read: boolean;
  created_at: string;
}

// ── Audit Log ──

export interface AuditEntry {
  id: number;
  timestamp: string;
  agent_id: string;
  trace_id: string;
  action: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

// ── Artifact ──

export interface Artifact {
  id: string;
  task_id: string;
  agent_id: string;
  name: string;
  path: string;
  checksum: string;
  version: number;
  created_at: string;
}

// ── Trace ──

export interface TraceSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  agent_id: string;
  operation: string;
  status: "active" | "completed" | "error";
  started_at: string;
  ended_at: string | null;
  metadata: string; // JSON
}

// ── Validation ──

export interface NumericValidation {
  value: number;
  field_name: string;
  expected_range?: { min: number; max: number };
  cross_check_formula?: string;
  cross_check_values?: Record<string, number>;
  tolerance_pct?: number;
  baseline?: number;
}

export interface CrossVerifyRequest {
  task_id: string;
  field_name: string;
  agent_a: string;
  value_a: number;
  agent_b: string;
  value_b: number;
  tolerance_pct: number;
}

// ── Schema Version ──

export const SCHEMA_VERSION = 2;
