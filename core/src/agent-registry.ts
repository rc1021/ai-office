import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { AgentProfile } from "./types.js";

// ─── Role Template Cache ─────────────────────────────────────────────────────

interface RoleTemplate {
  id: string;
  department: string;
  security: {
    clearance_level: number;
    scopes: string[];
    denied_scopes?: string[];
  };
}

const roleCache = new Map<string, RoleTemplate>();

function getRolesDir(): string {
  // AI_OFFICE_ROOT is set in worker .mcp.json so this works regardless of CWD
  const root = process.env.AI_OFFICE_ROOT ?? process.cwd();
  return path.resolve(root, "roles", "templates");
}

function loadRoleTemplate(roleId: string): RoleTemplate | null {
  if (roleCache.has(roleId)) {
    return roleCache.get(roleId)!;
  }

  const rolesDir = getRolesDir();

  // Try exact filename, then with _ prefix (for _leader.yaml)
  const candidates = [
    path.join(rolesDir, `${roleId}.yaml`),
    path.join(rolesDir, `_${roleId}.yaml`),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const parsed = yaml.load(content) as RoleTemplate;
        roleCache.set(roleId, parsed);
        return parsed;
      } catch (err) {
        console.error(`[AgentRegistry] Failed to parse role template ${filePath}:`, err);
        return null;
      }
    }
  }

  console.warn(`[AgentRegistry] Role template not found for: ${roleId}`);
  return null;
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

// Built-in system agent profile
const SYSTEM_PROFILE: AgentProfile = {
  agent_id: "system",
  role_id: "system",
  department: "system",
  clearance_level: 3,
  scopes: ["write:channel:*", "read:channel:*"],
  denied_scopes: [],
};

/**
 * Parse agent_id format: {role-id}-{instance} → role_id
 * Examples:
 *   "leader-1" → "leader"
 *   "software-engineer-1" → "software-engineer"
 *   "software-engineer-12" → "software-engineer"
 */
function extractRoleId(agentId: string): string {
  // Remove trailing -N (instance number)
  const match = agentId.match(/^(.+)-(\d+)$/);
  return match ? match[1] : agentId;
}

/**
 * Resolve an agent_id to its security profile by loading the role template YAML.
 */
export function resolveAgent(agentId: string): AgentProfile {
  if (agentId === "system") {
    return SYSTEM_PROFILE;
  }

  const roleId = extractRoleId(agentId);
  const template = loadRoleTemplate(roleId);

  if (!template) {
    // Unknown agent — deny all by default (security-first)
    console.warn(`[AgentRegistry] Unknown agent "${agentId}", returning minimal profile`);
    return {
      agent_id: agentId,
      role_id: roleId,
      department: "unknown",
      clearance_level: 0,
      scopes: [],
      denied_scopes: ["write:channel:*"],
    };
  }

  return {
    agent_id: agentId,
    role_id: roleId,
    department: template.department,
    clearance_level: template.security.clearance_level,
    scopes: template.security.scopes,
    denied_scopes: template.security.denied_scopes ?? [],
  };
}

/**
 * Clear the role template cache (for hot-reload scenarios).
 */
export function clearRoleCache(): void {
  roleCache.clear();
}
