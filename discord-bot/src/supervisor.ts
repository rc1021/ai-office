#!/usr/bin/env node
/**
 * supervisor.ts — Process supervisor for listener.js
 *
 * Restarts listener on crash with exponential backoff.
 * Writes its own PID to listener.pid so `office stop` kills the supervisor,
 * which then forwards SIGTERM to the listener child.
 *
 * Start: node discord-bot/dist/supervisor.js >> discord-bot/listener.log 2>&1 &
 */

import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __file = fileURLToPath(import.meta.url);
const __dir = path.resolve(path.dirname(__file), ".."); // discord-bot/

const LISTENER_JS = path.join(__dir, "dist", "listener.js");
const PID_FILE = path.join(__dir, "listener.pid");

// ── Config ─────────────────────────────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const STABLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const CRASH_WINDOW_MS = 60_000;             // 1 minute rolling window
const MAX_CRASHES_IN_WINDOW = 5;
const COOLDOWN_MS = 5 * 60 * 1000;         // 5 minutes
const MAX_TOTAL_RESTARTS = 50;

// ── State ───────────────────────────────────────────────────────────────────────

let child: ChildProcess | null = null;
let currentBackoff = INITIAL_BACKOFF_MS;
let totalRestarts = 0;
let recentCrashes: number[] = []; // timestamps of crashes within rolling window
let childStartedAt = 0;
let isShuttingDown = false;

// ── Logging ─────────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [Supervisor] ${msg}`);
}

function logError(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`${ts} [Supervisor] ${msg}`);
}

// ── Core: spawn child ───────────────────────────────────────────────────────────

function spawnChild(): void {
  if (isShuttingDown) {
    log("Shutting down — not spawning child.");
    return;
  }

  log(`Spawning listener (restart #${totalRestarts}): ${LISTENER_JS}`);
  childStartedAt = Date.now();

  child = spawn("node", [LISTENER_JS], {
    stdio: "inherit", // child shares supervisor's stdout/stderr → goes to listener.log
    cwd: path.resolve(__dir, ".."), // project root
  });

  child.on("exit", handleExit);

  child.on("error", (err) => {
    logError(`Failed to spawn listener: ${err.message}`);
    // handleExit will fire after this; if not, treat as crash
  });

  log(`Listener spawned (PID ${child.pid ?? "unknown"})`);
}

// ── Core: handle child exit ─────────────────────────────────────────────────────

function handleExit(code: number | null, signal: string | null): void {
  const uptime = Date.now() - childStartedAt;
  const uptimeSec = Math.round(uptime / 1000);

  log(`Listener exited — code=${code} signal=${signal} uptime=${uptimeSec}s`);

  // Graceful shutdown: supervisor itself initiated the stop
  if (isShuttingDown) {
    log("Shutdown complete.");
    process.exit(0);
  }

  // Clean exit (code 0) without supervisor initiating it — treat as normal stop
  if (code === 0 && signal === null) {
    log("Listener exited cleanly (code 0). Supervisor exiting.");
    process.exit(0);
  }

  // Anything else is a crash — schedule restart
  logError(`Listener crashed (code=${code} signal=${signal}). Scheduling restart...`);
  recordCrash(uptime);
  scheduleRestart();
}

// ── Crash tracking ──────────────────────────────────────────────────────────────

function recordCrash(uptime: number): void {
  const now = Date.now();

  // If the child was stable for STABLE_THRESHOLD_MS before crashing, reset backoff
  if (uptime >= STABLE_THRESHOLD_MS) {
    log(`Listener was stable for ${Math.round(uptime / 1000)}s — resetting backoff.`);
    currentBackoff = INITIAL_BACKOFF_MS;
    recentCrashes = [];
  }

  recentCrashes.push(now);
  // Prune crashes older than the rolling window
  recentCrashes = recentCrashes.filter((t) => now - t <= CRASH_WINDOW_MS);
}

function isInCrashLoop(): boolean {
  const now = Date.now();
  const recent = recentCrashes.filter((t) => now - t <= CRASH_WINDOW_MS);
  return recent.length >= MAX_CRASHES_IN_WINDOW;
}

// ── Restart scheduling ──────────────────────────────────────────────────────────

function scheduleRestart(): void {
  totalRestarts++;

  if (totalRestarts > MAX_TOTAL_RESTARTS) {
    logError(
      `Total restarts (${totalRestarts}) exceeded MAX_TOTAL_RESTARTS (${MAX_TOTAL_RESTARTS}). ` +
        "Giving up — manual intervention required."
    );
    process.exit(1);
  }

  let delay: number;

  if (isInCrashLoop()) {
    logError(
      `Crash loop detected (${recentCrashes.length} crashes in ${CRASH_WINDOW_MS / 1000}s). ` +
        `Entering cooldown for ${COOLDOWN_MS / 1000}s...`
    );
    delay = COOLDOWN_MS;
    // Reset crash history after cooldown so we start fresh
    recentCrashes = [];
    currentBackoff = INITIAL_BACKOFF_MS;
  } else {
    delay = currentBackoff;
    // Advance backoff for next crash (capped at MAX_BACKOFF_MS)
    currentBackoff = Math.min(currentBackoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  log(
    `Restarting in ${delay / 1000}s (restart #${totalRestarts}/${MAX_TOTAL_RESTARTS}, ` +
      `next backoff=${currentBackoff / 1000}s)...`
  );

  setTimeout(() => {
    spawnChild();
  }, delay);
  // Do NOT .unref() — we need this timer to keep the event loop alive
  // while waiting to respawn. SIGTERM handler will handle clean exits.
}

// ── Signal forwarding ───────────────────────────────────────────────────────────

function forwardAndExit(signal: string): void {
  if (isShuttingDown) return; // already handling
  isShuttingDown = true;

  log(`Received ${signal}, forwarding to child...`);

  if (child && child.pid) {
    try {
      child.kill(signal as NodeJS.Signals);
    } catch (err) {
      logError(`Failed to forward ${signal} to child: ${err}`);
    }
  } else {
    // No child running — exit immediately
    log("No child process running. Exiting.");
    process.exit(0);
  }

  // Safety net: if child doesn't exit in 5s, force-kill and exit
  setTimeout(() => {
    logError("Child did not exit in 5s — force killing...");
    if (child && child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch { /* already gone */ }
    }
    process.exit(0);
  }, 5_000).unref();
}

process.on("SIGTERM", () => forwardAndExit("SIGTERM"));
process.on("SIGINT", () => forwardAndExit("SIGINT"));

process.on("uncaughtException", (err) => {
  logError(`Uncaught exception in supervisor: ${err.message}\n${err.stack}`);
  // Do NOT exit — the supervisor must stay alive to restart the child
});

process.on("unhandledRejection", (reason) => {
  logError(`Unhandled rejection in supervisor: ${reason}`);
});

// ── Main ────────────────────────────────────────────────────────────────────────

// Write supervisor's own PID to listener.pid so `office stop` kills us
try {
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
} catch (err) {
  logError(`Failed to write PID file ${PID_FILE}: ${err}`);
  process.exit(1);
}

log(`Started (PID ${process.pid})`);
log(`Listener: ${LISTENER_JS}`);
log(`PID file: ${PID_FILE}`);
log(
  `Config: backoff=${INITIAL_BACKOFF_MS / 1000}s→${MAX_BACKOFF_MS / 1000}s, ` +
    `stable=${STABLE_THRESHOLD_MS / 60000}min, ` +
    `crashWindow=${CRASH_WINDOW_MS / 1000}s/${MAX_CRASHES_IN_WINDOW}crashes, ` +
    `cooldown=${COOLDOWN_MS / 60000}min, maxRestarts=${MAX_TOTAL_RESTARTS}`
);

spawnChild();
