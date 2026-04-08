// @ai-office/core — Platform-agnostic orchestration logic

// Types
export type {
  RiskLevel,
  ApprovalStatus,
  DataClassification,
  AgentProfile,
  OutputGateResult,
  ThrottleAction,
  ThrottleDecision,
  ThrottleOptions,
  ApprovalRequest,
  EmbedField,
  EmbedInput,
  ChannelMessage,
  ServerSetupResult,
} from "./types.js";
export { COLORS } from "./types.js";

// Chat adapter interface
export type { ChatAdapter } from "./chat-adapter.js";

// Config
export { loadOfficeConfig } from "./config-loader.js";
export type { OfficeConfig, AuditConfig, ModelsConfig } from "./config-loader.js";

// Claude runner
export { runClaude } from "./claude-runner.js";
export type { ClaudeRunnerConfig, ClaudeRunResult } from "./claude-runner.js";

// Session store
export { SessionStore } from "./session-store.js";

// Security
export { checkOutputGate } from "./output-gate.js";
export { resolveAgent, clearRoleCache } from "./agent-registry.js";

// Throttle
export {
  throttle,
  recordEmbedMessageId,
  forceFlush,
  setFlushCallback,
  cleanupThrottleTimers,
} from "./throttle-manager.js";

// Subsystems
export { HeartbeatScheduler } from "./heartbeat.js";
