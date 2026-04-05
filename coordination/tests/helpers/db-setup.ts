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
