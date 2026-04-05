/**
 * Seed active roles into coordination DB on Pixel Office startup.
 *
 * Reads config/active-roles.yaml + role templates, inserts missing agents
 * as "idle" so the UI shows all configured roles even before the
 * Orchestrator has run.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

interface RoleMeta {
  id: string;
  department: string;
  clearance_level: number;
}

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "config", "office.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** Minimal YAML list parser for active-roles.yaml */
function parseActiveRoles(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const roles: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*-\s+(.+)$/);
    if (match) roles.push(match[1].trim());
  }
  return roles;
}

/** Extract department and clearance from a role template YAML */
function parseRoleTemplate(filePath: string): { department: string; clearance_level: number } {
  const content = fs.readFileSync(filePath, "utf-8");
  const deptMatch = content.match(/^department:\s*(.+)$/m);
  const clMatch = content.match(/^clearance_level:\s*(\d+)$/m);
  return {
    department: deptMatch ? deptMatch[1].trim() : "general",
    clearance_level: clMatch ? parseInt(clMatch[1], 10) : 0,
  };
}

function loadRoleMeta(root: string, roleIds: string[]): RoleMeta[] {
  const templatesDir = path.join(root, "roles", "templates");
  return roleIds.map((id) => {
    const fileName = id === "leader" ? "_leader.yaml" : `${id}.yaml`;
    const filePath = path.join(templatesDir, fileName);
    if (fs.existsSync(filePath)) {
      const { department, clearance_level } = parseRoleTemplate(filePath);
      return { id, department, clearance_level };
    }
    return { id, department: "general", clearance_level: 0 };
  });
}

export function seedActiveRoles(dbPath: string): void {
  const root = findProjectRoot();
  const activeRolesPath = path.join(root, "config", "active-roles.yaml");

  if (!fs.existsSync(activeRolesPath)) {
    console.log("[Seed] No active-roles.yaml found, skipping seed");
    return;
  }

  if (!fs.existsSync(dbPath)) {
    console.log("[Seed] Coordination DB not found, skipping seed");
    return;
  }

  const roleIds = parseActiveRoles(activeRolesPath);
  if (roleIds.length === 0) {
    console.log("[Seed] No active roles configured");
    return;
  }

  const roles = loadRoleMeta(root, roleIds);

  // Open a writable connection just for seeding
  const writeDb = new Database(dbPath);
  writeDb.pragma("journal_mode = WAL");
  writeDb.pragma("busy_timeout = 5000");

  const insertStmt = writeDb.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, role_id, department, status, clearance_level)
    VALUES (?, ?, ?, 'idle', ?)
  `);

  let seeded = 0;
  for (const role of roles) {
    // Use role id as agent_id for the default instance (e.g., "leader", "pm")
    const result = insertStmt.run(role.id, role.id, role.department, role.clearance_level);
    if (result.changes > 0) seeded++;
  }

  writeDb.close();

  if (seeded > 0) {
    console.log(`[Seed] Seeded ${seeded} agent(s) from active-roles.yaml: ${roles.map((r) => r.id).join(", ")}`);
  } else {
    console.log(`[Seed] All ${roles.length} active roles already in DB`);
  }
}
