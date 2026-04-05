// ─── Office Configuration ────────────────────────────────────────────────────

export interface OfficeConfig {
  office: {
    name: string;
    language: string;
    timezone: string;
  };
  agents: {
    leader: { model: string };
    workers: {
      model: string;
      max_concurrent: number;
      default_timeout: number;
      token_ttl?: number; // Token TTL in seconds (default: 3600)
    };
  };
  execution: {
    mode: "sequential" | "parallel";
    human_in_the_loop: boolean;
    auto_approve_risk: "GREEN" | "YELLOW" | "RED";
  };
  startup: {
    greet_user: boolean;
    resume_pending_tasks: boolean;
    post_status_to_discord: boolean;
  };
  logging: {
    level: string;
    structured: boolean;
    audit_trail: boolean;
    trace_enabled: boolean;
  };
  paths: {
    state: string;
    artifacts: string;
    events: string;
    logs: string;
    memory: string;
  };
}

// ─── Agent Identity Token ────────────────────────────────────────────────────

export interface AgentIdentity {
  agent_id: string;
  role_id: string;
  department: string;
  clearance_level: number;
  scopes: string[];
  denied_scopes: string[];
  iat: number;       // issued at (epoch seconds)
  exp: number;       // expiry (epoch seconds)
  session_id: string;
}

// ─── Worker Lifecycle ────────────────────────────────────────────────────────

export type WorkerStatus = "spawning" | "online" | "busy" | "stopping" | "stopped";

export interface WorkerRecord {
  agent_id: string;
  role_id: string;
  instance: number;
  status: WorkerStatus;
  workspace_dir: string;
  identity_token: string;
  spawned_at: string;
  stopped_at?: string;
}

// ─── Role Template (subset for orchestrator) ─────────────────────────────────

export interface RoleTemplate {
  id: string;
  name: Record<string, string>;
  department: string;
  persona: {
    role_description: string;
    communication_style: string;
    emoji?: string;
    expertise_areas?: string[];
    personality_traits?: string[];
  };
  capabilities: {
    primary_tasks: string[];
    secondary_tasks?: string[];
    output_formats: string[];
    tools_required: string[];
    tools_optional?: string[];
  };
  security: {
    clearance_level: number;
    scopes: string[];
    denied_scopes?: string[];
    requires_approval?: string[];
    max_autonomous_risk: string;
  };
}
