import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { AgentIdentity, RoleTemplate } from "./types.js";
import { getStateDir, getOfficeConfig, getProjectRootPath } from "./config-reader.js";

// ─── Session Key Management ─────────────────────────────────────────────────

let sessionKey: Buffer | null = null;
let sessionId: string | null = null;

function getSessionKeyPath(): string {
  return path.join(getStateDir(), "session-key");
}

function getRevokedPath(): string {
  return path.join(getStateDir(), "revoked-tokens.json");
}

/**
 * Generate a new session key (called on orchestrator startup).
 * Invalidates all tokens from previous sessions.
 */
export function generateSessionKey(): string {
  sessionKey = randomBytes(32);
  sessionId = randomBytes(8).toString("hex");

  const keyPath = getSessionKeyPath();
  fs.writeFileSync(keyPath, sessionKey.toString("hex"), "utf-8");

  // Clear revocation list (new session = all old tokens invalid anyway)
  const revokedPath = getRevokedPath();
  fs.writeFileSync(revokedPath, "[]", "utf-8");

  console.log(`[Identity] New session: ${sessionId}`);
  return sessionId;
}

/**
 * Load existing session key from disk.
 */
export function loadSessionKey(): void {
  const keyPath = getSessionKeyPath();
  if (!fs.existsSync(keyPath)) {
    throw new Error("No session key found. Call generateSessionKey() first.");
  }

  const hex = fs.readFileSync(keyPath, "utf-8").trim();
  sessionKey = Buffer.from(hex, "hex");

  // Derive session ID from key
  sessionId = createHmac("sha256", sessionKey).update("session-id").digest("hex").substring(0, 16);
}

function getKey(): Buffer {
  if (!sessionKey) {
    try {
      loadSessionKey();
    } catch {
      throw new Error("Session key not initialized.");
    }
  }
  return sessionKey!;
}

function getSessionId(): string {
  if (!sessionId) {
    getKey(); // triggers load
  }
  return sessionId!;
}

// ─── Base64url helpers ───────────────────────────────────────────────────────

function b64urlEncode(data: string): string {
  return Buffer.from(data, "utf-8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(data: string): string {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf-8");
}

// ─── Token Operations ────────────────────────────────────────────────────────

function sign(payload: string): string {
  return createHmac("sha256", getKey()).update(payload).digest("hex");
}

/**
 * Issue an identity token for an agent.
 */
export function issueToken(roleId: string, instance: number): string {
  const config = getOfficeConfig();
  const root = getProjectRootPath();

  // Load role template
  const candidates = [
    path.join(root, "roles", "templates", `${roleId}.yaml`),
    path.join(root, "roles", "templates", `_${roleId}.yaml`),
  ];

  let template: RoleTemplate | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      template = yaml.load(fs.readFileSync(p, "utf-8")) as RoleTemplate;
      break;
    }
  }

  if (!template) {
    throw new Error(`Role template not found: ${roleId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: AgentIdentity = {
    agent_id: `${roleId}-${instance}`,
    role_id: roleId,
    department: template.department,
    clearance_level: template.security.clearance_level,
    scopes: template.security.scopes,
    denied_scopes: template.security.denied_scopes ?? [],
    iat: now,
    exp: now + (config.agents.workers.token_ttl ?? 3600),
    session_id: getSessionId(),
  };

  const header = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "AIT" }));
  const body = b64urlEncode(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`);

  return `${header}.${body}.${signature}`;
}

/**
 * Validate an identity token. Returns the payload or null if invalid.
 */
export function validateToken(token: string): AgentIdentity | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;

  // Verify signature
  const expected = sign(`${header}.${body}`);
  if (sig !== expected) {
    console.warn("[Identity] Token signature mismatch");
    return null;
  }

  // Decode payload
  let payload: AgentIdentity;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch {
    console.warn("[Identity] Token payload decode failed");
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    console.warn(`[Identity] Token expired for ${payload.agent_id}`);
    return null;
  }

  // Check session
  if (payload.session_id !== getSessionId()) {
    console.warn(`[Identity] Token from different session for ${payload.agent_id}`);
    return null;
  }

  // Check revocation
  if (isRevoked(payload.agent_id)) {
    console.warn(`[Identity] Token revoked for ${payload.agent_id}`);
    return null;
  }

  return payload;
}

/**
 * Revoke a token by agent_id.
 */
export function revokeToken(agentId: string): void {
  const revokedPath = getRevokedPath();
  let revoked: string[] = [];
  if (fs.existsSync(revokedPath)) {
    try {
      revoked = JSON.parse(fs.readFileSync(revokedPath, "utf-8"));
    } catch { /* empty */ }
  }
  if (!revoked.includes(agentId)) {
    revoked.push(agentId);
    fs.writeFileSync(revokedPath, JSON.stringify(revoked), "utf-8");
  }
}

function isRevoked(agentId: string): boolean {
  const revokedPath = getRevokedPath();
  if (!fs.existsSync(revokedPath)) return false;
  try {
    const revoked: string[] = JSON.parse(fs.readFileSync(revokedPath, "utf-8"));
    return revoked.includes(agentId);
  } catch {
    return false;
  }
}
