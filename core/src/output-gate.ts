import { resolveAgent } from "./agent-registry.js";
import { OutputGateResult, DataClassification } from "./types.js";

// ─── Classification Patterns ─────────────────────────────────────────────────

const CLASSIFICATION_PATTERNS: Array<{ pattern: RegExp; level: DataClassification; clearance: number }> = [
  { pattern: /\[RESTRICTED\]/i, level: "RESTRICTED", clearance: 3 },
  { pattern: /\[CONFIDENTIAL\]/i, level: "CONFIDENTIAL", clearance: 2 },
  { pattern: /\[INTERNAL\]/i, level: "INTERNAL", clearance: 1 },
];


// ─── Scope Matching ──────────────────────────────────────────────────────────

function matchesScope(scope: string, channelName: string): boolean {
  // Parse scope: write:channel:{pattern}
  const parts = scope.split(":");
  if (parts.length < 3 || parts[0] !== "write" || parts[1] !== "channel") {
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


// ─── OutputGate ──────────────────────────────────────────────────────────────

/**
 * Check if an agent is allowed to send a message to a channel.
 * Enforces two checks:
 * 1. Scope check — does the agent have write:channel:{channel} scope?
 * 2. Data classification check — is the content appropriate for the agent's clearance?
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
      reason: `Agent "${agentId}" lacks write:channel:${normalizedChannel} scope`,
    };
  }

  // ── Check 3: Data classification check ──
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
