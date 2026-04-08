import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { generateId, appendAudit, publishEvent } from "../database.js";
import type { RiskLevel } from "../types.js";

// ── Workspace resolution ──────────────────────────────────────────────────────

const WORKSPACE = process.env.AI_OFFICE_WORKSPACE ?? path.join(process.cwd(), ".ai-office");

// ── Risk Matrix types ─────────────────────────────────────────────────────────

interface MatrixEntry {
  operation: string;
  scope: string;
  risk: RiskLevel;
  auto_approve: boolean;
  timeout_seconds: number;
}

interface ImpactThreshold {
  operation: string;
  scope: string;
  escalate_to: RiskLevel;
  when_count_exceeds: number;
}

interface RoleOverride {
  role_id: string;
  operation: string;
  scope: string;
  risk: RiskLevel;
  auto_approve: boolean;
  timeout_seconds: number;
}

interface RiskMatrix {
  version: number;
  matrix: MatrixEntry[];
  impact_thresholds: ImpactThreshold[];
  role_overrides: RoleOverride[];
}

// ── resolveRisk ───────────────────────────────────────────────────────────────

export function resolveRisk(
  operation: string,
  scope: string,
  agentRoleId: string,
  batchCount?: number
): { risk: RiskLevel; timeout_seconds: number; auto_approve: boolean } {
  const matrixPath = path.join(WORKSPACE, "..", "config", "risk-matrix.yaml");

  let matrix: RiskMatrix;
  try {
    const raw = fs.readFileSync(matrixPath, "utf-8");
    matrix = yaml.load(raw) as RiskMatrix;
  } catch {
    return { risk: "RED", timeout_seconds: 900, auto_approve: false };
  }

  // Role override check first
  const override = (matrix.role_overrides ?? []).find(
    (r) =>
      r.role_id === agentRoleId &&
      (r.operation === operation || r.operation === "any") &&
      (r.scope === scope || r.scope === "any")
  );
  if (override) {
    return {
      risk: override.risk,
      timeout_seconds: override.timeout_seconds,
      auto_approve: override.auto_approve,
    };
  }

  // Base matrix match (exact operation+scope first, then operation+any)
  const match =
    matrix.matrix.find((e) => e.operation === operation && e.scope === scope) ??
    matrix.matrix.find((e) => e.operation === operation && e.scope === "any");

  if (!match) {
    return { risk: "RED", timeout_seconds: 900, auto_approve: false };
  }

  let risk = match.risk;
  let timeout_seconds = match.timeout_seconds;
  let auto_approve = match.auto_approve;

  // Impact threshold escalation
  if (batchCount !== undefined) {
    const threshold = (matrix.impact_thresholds ?? []).find(
      (t) =>
        t.operation === operation &&
        t.scope === scope &&
        batchCount > t.when_count_exceeds
    );
    if (threshold) {
      risk = threshold.escalate_to;
      auto_approve = false;
      // Use timeout from the escalated risk level's first matching matrix entry
      const escalatedMatch = matrix.matrix.find(
        (e) => e.risk === threshold.escalate_to && (e.scope === "any" || e.scope === scope)
      );
      if (escalatedMatch) {
        timeout_seconds = escalatedMatch.timeout_seconds;
      }
    }
  }

  return { risk, timeout_seconds, auto_approve };
}

// ── requestApprovalEscalation ─────────────────────────────────────────────────

export interface EscalationParams {
  agent_id: string;
  task_id: string;
  trace_id: string;
  action: string;
  description: string;
  suggested_risk_level: "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
  risk_justification: string;
  preview_data?: string;
  timeout_preference?: "block" | "auto_cancel";
}

export function requestApprovalEscalation(
  params: EscalationParams
): { escalation_id: string; status: "queued" } {
  if (params.agent_id === "leader" || params.agent_id.startsWith("leader-")) {
    throw new Error("requestApprovalEscalation is for workers only — leader cannot escalate to itself.");
  }

  const escalationId = generateId("esc");

  appendAudit(
    params.agent_id,
    params.trace_id,
    "approval.escalation_requested",
    JSON.stringify({
      escalation_id: escalationId,
      action: params.action,
      suggested_risk_level: params.suggested_risk_level,
    })
  );

  publishEvent(
    generateId("evt"),
    "approval.escalation_requested",
    params.agent_id,
    "role:leader",
    {
      escalation_id: escalationId,
      agent_id: params.agent_id,
      task_id: params.task_id,
      action: params.action,
      description: params.description,
      suggested_risk_level: params.suggested_risk_level,
      risk_justification: params.risk_justification,
      preview_data: params.preview_data,
      timeout_preference: params.timeout_preference,
    },
    params.trace_id
  );

  return { escalation_id: escalationId, status: "queued" };
}
