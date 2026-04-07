import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase, getDb, initAuditChain } from "../../src/database.js";
import type Database from "better-sqlite3";

export interface TestDbContext {
  db: Database.Database;
  tmpDir: string;
  cleanup: () => void;
}

export function setupTestDb(): TestDbContext {
  const tmpDir = mkdtempSync(join(tmpdir(), "ai-office-test-"));
  const db = initDatabase(tmpDir);
  initAuditChain(db);
  return {
    db,
    tmpDir,
    cleanup: () => {
      try { db.close(); } catch { /* already closed */ }
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/**
 * Pre-register an agent directly in the DB (bypasses reportStatus validation).
 * Use this in test beforeEach to satisfy the "agent must be registered" check.
 */
export function registerTestAgent(
  db: Database.Database,
  agentId: string,
  roleId: string = "test-role",
  department: string = "engineering",
  clearanceLevel: number = 1,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, role_id, department, status, clearance_level, last_heartbeat)
    VALUES (?, ?, ?, 'idle', ?, datetime('now'))
  `).run(agentId, roleId, department, clearanceLevel);
}
