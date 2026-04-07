import { resolveAgent } from "./agent-registry.js";
import { OutputGateResult, DataClassification } from "./types.js";

// ─── Classification Patterns ─────────────────────────────────────────────────

const CLASSIFICATION_PATTERNS: Array<{ pattern: RegExp; level: DataClassification; clearance: number }> = [
  { pattern: /\[RESTRICTED\]/i, level: "RESTRICTED", clearance: 3 },
  { pattern: /\[CONFIDENTIAL\]/i, level: "CONFIDENTIAL", clearance: 2 },
  { pattern: /\[INTERNAL\]/i, level: "INTERNAL", clearance: 1 },
];

// Channels that require specific clearance levels
const CHANNEL_CLEARANCE: Record<string, number> = {
  "audit-log": 3, // system-only
};

// ─── Scope Matching ──────────────────────────────────────────────────────────

function matchesScope(scope: string, channelName: string): boolean {
  // Parse scope: write:discord:{pattern}
  const parts = scope.split(":");
  if (parts.length < 3 || parts[0] !== "write" || parts[1] !== "discord") {
    return false;
  }

  const pattern = parts.slice(2).join(":");

  // Wildcard
  if (pattern === "*") return true;

  // Glob-style dept-* match
  if (pattern === "dept-*" && channelName.startsWith("dept-")) return true;

  // Exact match
  return pattern === channelName;
}

function hasWriteScope(scopes: string[], channelName: string): boolean {
  return scopes.some((scope) => matchesScope(scope, channelName));
}

function isDenied(deniedScopes: string[], channelName: string): boolean {
  return deniedScopes.some((scope) => matchesScope(scope, channelName));
}

// ─── Department Check ────────────────────────────────────────────────────────

function isDepartmentChannel(channelName: string): boolean {
  return channelName.startsWith("dept-");
}

function extractDepartmentFromChannel(channelName: string): string | null {
  if (!isDepartmentChannel(channelName)) return null;
  // dept-engineering → engineering
  // dept-engineering-confidential → engineering
  const parts = channelName.replace(/^dept-/, "").replace(/-confidential$/, "");
  return parts;
}

function isConfidentialChannel(channelName: string): boolean {
  return channelName.endsWith("-confidential");
}

// ─── OutputGate ──────────────────────────────────────────────────────────────

/**
 * Check if an agent is allowed to send a message to a channel.
 * Enforces three checks:
 * 1. Scope check — does the agent have write:discord:{channel} scope?
 * 2. Clearance check — does the agent meet the channel's clearance requirement?
 * 3. Data classification check — is the content appropriate for the agent's clearance?
 */
export function checkOutputGate(
  agentId: string,
  channelName: string,
  content: string
): OutputGateResult {
  const agent = resolveAgent(agentId);
  const normalizedChannel = channelName.toLowerCase();

  // ── Check 1: Denied scopes take priority ──
  if (isDenied(agent.denied_scopes, normalizedChannel)) {
    return {
      allowed: false,
      reason: `Agent "${agentId}" is explicitly denied write access to #${normalizedChannel}`,
    };
  }

  // ── Check 2: Scope check ──
  // For department channels, also allow if agent belongs to that department
  let hasScope = hasWriteScope(agent.scopes, normalizedChannel);

  if (!hasScope && isDepartmentChannel(normalizedChannel)) {
    const dept = extractDepartmentFromChannel(normalizedChannel);
    if (dept && dept === agent.department) {
      // Agent belongs to this department — implicitly grant write scope
      hasScope = true;
    }
  }

  if (!hasScope) {
    return {
      allowed: false,
      reason: `Agent "${agentId}" lacks write:discord:${normalizedChannel} scope`,
    };
  }

  // ── Check 3: Clearance check ──
  // Fixed channels with specific clearance requirements
  const requiredClearance = CHANNEL_CLEARANCE[normalizedChannel];
  if (requiredClearance !== undefined && agent.clearance_level < requiredClearance) {
    return {
      allowed: false,
      reason: `Agent "${agentId}" clearance ${agent.clearance_level} < required ${requiredClearance} for #${normalizedChannel}`,
    };
  }

  // Confidential department channels require clearance >= 2
  if (isConfidentialChannel(normalizedChannel) && agent.clearance_level < 2) {
    return {
      allowed: false,
      reason: `Agent "${agentId}" clearance ${agent.clearance_level} < 2 required for confidential channel #${normalizedChannel}`,
    };
  }

  // ── Check 4: Data classification check ──
  for (const { pattern, level, clearance } of CLASSIFICATION_PATTERNS) {
    if (pattern.test(content) && agent.clearance_level < clearance) {
      return {
        allowed: false,
        reason: `Agent "${agentId}" clearance ${agent.clearance_level} cannot post ${level} content`,
        classification: level,
      };
    }
  }

  return { allowed: true };
}
