/**
 * Sync active roles from config/active-roles.yaml into coordination DB.
 * Called during `orchestrator init` to ensure all configured roles
 * are registered before any worker spawning.
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { getProjectRootPath, getStateDir } from "./config-reader.js";
import { loadRoleTemplate } from "./template-assembler.js";

interface ActiveRolesConfig {
  active_roles: string[];
}

export function syncActiveRolesToDb(): string[] {
  const root = getProjectRootPath();
  const activeRolesPath = path.join(root, "config", "active-roles.yaml");

  if (!fs.existsSync(activeRolesPath)) {
    return [];
  }

  const config = yaml.load(fs.readFileSync(activeRolesPath, "utf-8")) as ActiveRolesConfig;
  const roleIds = config.active_roles ?? [];
  if (roleIds.length === 0) return [];

  const dbPath = path.join(getStateDir(), "coordination.db");
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, role_id, department, status, clearance_level)
    VALUES (?, ?, ?, 'idle', ?)
  `);

  const synced: string[] = [];
  for (const roleId of roleIds) {
    try {
      const template = loadRoleTemplate(roleId);
      const result = insertStmt.run(
        roleId,
        roleId,
        template.department,
        template.security?.clearance_level ?? 0
      );
      if (result.changes > 0) synced.push(roleId);
    } catch {
      // Role template not found — insert with defaults
      const result = insertStmt.run(roleId, roleId, "general", 0);
      if (result.changes > 0) synced.push(roleId);
    }
  }

  db.close();
  return synced;
}
