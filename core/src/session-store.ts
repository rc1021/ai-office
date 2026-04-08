/**
 * session-store.ts — Per-user conversation session persistence
 *
 * Stores claude --resume session IDs keyed by channel:channelId:authorId.
 * Sessions expire after TTL (default 60 minutes of inactivity).
 * State is flushed to disk every 30s and on shutdown.
 */

import fs from "node:fs";
import path from "node:path";

interface SessionEntry {
  sessionId: string;
  updatedAt: number; // Unix ms
}

type SessionMap = Record<string, SessionEntry>;

export class SessionStore {
  private filePath: string;
  private ttlMs: number;
  private sessions: SessionMap = {};
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(filePath: string, ttlMs = 60 * 60 * 1000) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
  }

  /**
   * Returns the sessionId for the given key if it exists and has not expired.
   * Returns null if absent or TTL-expired.
   */
  get(key: string): string | null {
    const entry = this.sessions[key];
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      delete this.sessions[key];
      return null;
    }
    return entry.sessionId;
  }

  /**
   * Insert or update a session entry, refreshing the TTL timestamp.
   */
  upsert(key: string, sessionId: string): void {
    this.sessions[key] = { sessionId, updatedAt: Date.now() };
  }

  /**
   * Load persisted sessions from disk and start the 30s flush timer.
   */
  start(): void {
    this.load();
    this.flushTimer = setInterval(() => {
      this.flush();
    }, 30_000);
    console.log("[SessionStore] Started — loaded sessions from disk, flush every 30s");
  }

  /**
   * Flush sessions to disk and stop the flush timer.
   */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
    console.log("[SessionStore] Stopped — sessions flushed to disk");
  }

  private flush(): void {
    this.evictExpired();
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), "utf-8");
    } catch (err) {
      console.error("[SessionStore] Failed to flush sessions to disk:", err);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        this.sessions = parsed as SessionMap;
        this.evictExpired();
        console.log(`[SessionStore] Loaded ${Object.keys(this.sessions).length} session(s) from disk`);
      }
    } catch (err) {
      console.warn("[SessionStore] Could not load sessions from disk (starting fresh):", err);
      this.sessions = {};
    }
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const key of Object.keys(this.sessions)) {
      if (this.sessions[key].updatedAt < cutoff) {
        delete this.sessions[key];
      }
    }
  }
}
