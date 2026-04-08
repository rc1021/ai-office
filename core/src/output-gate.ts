import { resolveAgent } from "./agent-registry.js";
import { OutputGateResult, DataClassification } from "./types.js";

// ─── Classification Patterns ─────────────────────────────────────────────────

const CLASSIFICATION_PATTERNS: Array<{ pattern: RegExp; level: DataClassification; clearance: number }> = [
  { pattern: /\[RESTRICTED\]/i, level: "RESTRICTED", clearance: 3 },
  { pattern: /\[CONFIDENTIAL\]/i, level: "CONFIDENTIAL", clearance: 2 },
  { pattern: /\[INTERNAL\]/i, level: "INTERNAL", clearance: 1 },
];

// ─── Channel Clearance Table ─────────────────────────────────────────────────

/** Minimum clearance_level required to post in specific channels. */
const CHANNEL_CLEARANCE: Record<string, number> = {
  "audit-log": 3,
};

/**
 * Return the minimum clearance level required to post in a channel.
 * 0 = no channel-level restriction.
 */
function getChannelClearance(channelName: string): number {
  // Exact match
  if (Object.prototype.hasOwnProperty.call(CHANNEL_CLEARANCE, channelName)) {
    return CHANNEL_CLEARANCE[channelName];
  }
  // Suffix match: any channel ending with "-confidential" requires clearance 2
  if (channelName.endsWith("-confidential")) {
    return 2;
  }
  return 0;
}


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
 * Enforces four checks:
 * 1. Denied scopes — explicitly denied channels block all access
 * 2. Scope check — agent must have write:channel:{channel} scope
 * 3. Channel clearance — channel may require a minimum clearance level
 * 4. Data classification — content classification must not exceed agent clearance
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
      check: "check1_denied_scope",
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
      check: "check2_write_scope",
      reason: `Agent "${agentId}" lacks write:channel:${normalizedChannel} scope`,
    };
  }

  // ── Check 3: Channel clearance ──
  const requiredClearance = getChannelClearance(normalizedChannel);
  if (requiredClearance > 0 && agent.clearance_level < requiredClearance) {
    return {
      allowed: false,
      check: "check3_channel_clearance",
      reason: `Agent "${agentId}" clearance ${agent.clearance_level} is below the minimum ${requiredClearance} required for #${normalizedChannel}`,
    };
  }

  // ── Check 4: Data classification check ──
  for (const { pattern, level, clearance } of CLASSIFICATION_PATTERNS) {
    if (pattern.test(content) && agent.clearance_level < clearance) {
      return {
        allowed: false,
        check: "check4_data_classification",
        reason: `Agent "${agentId}" clearance ${agent.clearance_level} cannot post ${level} content`,
        classification: level,
      };
    }
  }

  return { allowed: true };
}
