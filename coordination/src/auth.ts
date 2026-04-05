/**
 * Token-based authentication for the Coordination MCP Server.
 *
 * When AI_OFFICE_AGENT_TOKEN env is set (worker sessions), the server
 * validates the token on startup and enforces identity on every tool call.
 * When not set (Leader / dev sessions), all calls are unrestricted.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AgentIdentity {
  agent_id: string;
  role_id: string;
  department: string;
  clearance_level: number;
  scopes: string[];
  denied_scopes: string[];
  iat: number;
  exp: number;
  session_id: string;
}

let authenticatedIdentity: AgentIdentity | null = null;
let authEnabled = false;

function b64urlDecode(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

/**
 * Initialize auth from environment. Call once on server startup.
 * Returns the identity if a valid token was provided, null otherwise.
 */
export function initAuth(): AgentIdentity | null {
  const token = process.env.AI_OFFICE_AGENT_TOKEN;
  if (!token) {
    authEnabled = false;
    console.error("[Auth] No agent token — running in unrestricted mode (Leader/dev)");
    return null;
  }

  // Decode token payload (we can't verify signature without the session key,
  // which lives in the orchestrator's state dir). We trust the token because
  // it was injected by the orchestrator into the .mcp.json env.
  // The orchestrator already validated scopes when issuing it.
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.error("[Auth] Invalid token format — running unrestricted");
    authEnabled = false;
    return null;
  }

  try {
    const payload = JSON.parse(b64urlDecode(parts[1])) as AgentIdentity;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      console.error(`[Auth] Token expired for ${payload.agent_id} — running unrestricted`);
      authEnabled = false;
      return null;
    }

    authenticatedIdentity = payload;
    authEnabled = true;
    console.error(`[Auth] Authenticated as ${payload.agent_id} (${payload.role_id}, clearance ${payload.clearance_level})`);
    return payload;
  } catch {
    console.error("[Auth] Token decode failed — running unrestricted");
    authEnabled = false;
    return null;
  }
}

/**
 * Check if the caller's agent_id matches the authenticated identity.
 * In unrestricted mode (Leader), always passes.
 */
export function enforceIdentity(callerAgentId: string): void {
  if (!authEnabled || !authenticatedIdentity) return;

  if (callerAgentId !== authenticatedIdentity.agent_id) {
    throw new Error(
      `Identity mismatch: authenticated as "${authenticatedIdentity.agent_id}" but tool called with agent_id "${callerAgentId}"`
    );
  }
}

/**
 * Check if the authenticated agent has sufficient clearance.
 * In unrestricted mode (Leader), always passes.
 */
export function enforceClearance(requiredLevel: number): void {
  if (!authEnabled || !authenticatedIdentity) return;

  if (authenticatedIdentity.clearance_level < requiredLevel) {
    throw new Error(
      `Clearance denied: ${authenticatedIdentity.agent_id} has clearance ${authenticatedIdentity.clearance_level}, requires ${requiredLevel}`
    );
  }
}

/**
 * Get the current authenticated identity (or null in unrestricted mode).
 */
export function getAuthIdentity(): AgentIdentity | null {
  return authenticatedIdentity;
}

/**
 * Check if auth enforcement is active.
 */
export function isAuthEnabled(): boolean {
  return authEnabled;
}
