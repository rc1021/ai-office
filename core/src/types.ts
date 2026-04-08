export type RiskLevel = "GREEN" | "YELLOW" | "RED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "TIMEOUT" | "CANCELLED" | "CONSUMED" | "SUPERSEDED";

export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED";

// ─── Agent Identity ──────────────────────────────────────────────────────────

export interface AgentProfile {
  agent_id: string;
  role_id: string;
  department: string;
  clearance_level: number; // 0=PUBLIC, 1=INTERNAL, 2=CONFIDENTIAL, 3=RESTRICTED
  scopes: string[];
  denied_scopes: string[];
}

// ─── OutputGate ──────────────────────────────────────────────────────────────

export interface OutputGateResult {
  allowed: boolean;
  reason?: string;
  classification?: DataClassification;
}

// ─── Throttle ────────────────────────────────────────────────────────────────

export type ThrottleAction = "send" | "buffer" | "reject" | "edit";

export interface ThrottleDecision {
  action: ThrottleAction;
  bufferedContent?: string;
  editMessageId?: string;
  reason?: string;
}

export interface ThrottleOptions {
  hasMention?: boolean;
  isError?: boolean;
  isThread?: boolean;
}

export interface ApprovalRequest {
  id: string;
  channelName: string;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  messageId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;          // Discord snowflake user ID
  traceId?: string;
  taskId?: string | null;
  requestingAgentId?: string;
  timeoutSeconds?: number;            // 0 = no timeout
  deadlineAt?: Date | null;           // createdAt + timeoutSeconds
  idempotencyKey?: string | null;
  batchCount?: number | null;
}

export interface EmbedField {
  name: string;
  value: string;
}

export interface EmbedInput {
  title: string;
  description: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
}

export interface ChannelMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  isBot: boolean;
}

export interface ServerSetupResult {
  created: string[];
  skipped: string[];
  errors: string[];
}

// ─── Color Constants ────────────────────────────────────────────────────────

export const COLORS = {
  GREEN:   0x2ECC71,
  YELLOW:  0xF39C12,
  RED:     0xE74C3C,
  BLUE:    0x3498DB,
  GRAY:    0x95A5A6,
  BLURPLE: 0x5865F2,
} as const;
