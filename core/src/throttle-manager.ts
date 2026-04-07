import { ThrottleDecision, ThrottleOptions } from "./types.js";

// ─── Throttle Rule Parsing ───────────────────────────────────────────────────

type ThrottleType = "none" | "batch" | "daily" | "embed-edit";

interface ThrottleRule {
  type: ThrottleType;
  maxMessages?: number;
  windowMs?: number;
}

function parseThrottleRule(rule: string): ThrottleRule {
  if (rule === "none") return { type: "none" };
  if (rule === "embed-edit") return { type: "embed-edit" };
  if (rule === "1/day") return { type: "daily" };

  // batch:Nmsg/Ts format — e.g., "batch:5msg/10s", "batch:1msg/5min"
  const batchMatch = rule.match(/^batch:(\d+)msg\/(\d+)(s|min)$/);
  if (batchMatch) {
    const maxMessages = parseInt(batchMatch[1], 10);
    const timeValue = parseInt(batchMatch[2], 10);
    const timeUnit = batchMatch[3];
    const windowMs = timeUnit === "min" ? timeValue * 60_000 : timeValue * 1_000;
    return { type: "batch", maxMessages, windowMs };
  }

  console.warn(`[ThrottleManager] Unknown throttle rule: "${rule}", defaulting to none`);
  return { type: "none" };
}

// ─── Channel Throttle Config (from channels.yaml) ────────────────────────────

const CHANNEL_THROTTLE_RULES: Record<string, string> = {
  "general": "none",
  "approvals": "none",
  "alerts": "none",
  "daily-brief": "1/day",
};

// ─── Throttle State ──────────────────────────────────────────────────────────

interface BatchBuffer {
  messages: string[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  windowStart: number;
}

interface DailyState {
  lastSendDate: string; // YYYY-MM-DD
}

interface EmbedEditState {
  lastMessageId: string | null;
}

const batchBuffers = new Map<string, BatchBuffer>();
const dailyStates = new Map<string, DailyState>();
const embedEditStates = new Map<string, EmbedEditState>();

// Flush callback registry — set by the caller
let flushCallback: ((channelName: string, combinedContent: string) => Promise<void>) | null = null;

export function setFlushCallback(cb: (channelName: string, combinedContent: string) => Promise<void>): void {
  flushCallback = cb;
}

// ─── Throttle Manager ────────────────────────────────────────────────────────

function getThrottleRule(channelName: string): ThrottleRule {
  const ruleStr = CHANNEL_THROTTLE_RULES[channelName];
  if (ruleStr) return parseThrottleRule(ruleStr);

  return { type: "none" };
}

function getTodayStr(): string {
  return new Date().toISOString().split("T")[0];
}

async function flushBuffer(channelName: string): Promise<void> {
  const buffer = batchBuffers.get(channelName);
  if (!buffer || buffer.messages.length === 0) return;

  const combined = buffer.messages.join("\n───\n");
  buffer.messages = [];
  buffer.windowStart = Date.now();
  if (buffer.flushTimer) {
    clearTimeout(buffer.flushTimer);
    buffer.flushTimer = null;
  }

  if (flushCallback) {
    try {
      await flushCallback(channelName, combined);
    } catch (err) {
      console.error(`[ThrottleManager] Flush failed for #${channelName}:`, err);
    }
  }
}

/**
 * Evaluate throttle rules for a channel message.
 * Returns a decision on what action to take.
 */
export function throttle(
  channelName: string,
  content: string,
  options?: ThrottleOptions
): ThrottleDecision {
  // ── Bypass checks ──
  if (options?.isThread) {
    return { action: "send" }; // thread_bypass
  }
  if (options?.hasMention) {
    return { action: "send" }; // mention_bypass
  }
  if (options?.isError) {
    return { action: "send" }; // error_bypass
  }

  const rule = getThrottleRule(channelName);

  switch (rule.type) {
    case "none":
      return { action: "send" };

    case "daily": {
      const today = getTodayStr();
      const state = dailyStates.get(channelName);
      if (state && state.lastSendDate === today) {
        return { action: "reject", reason: `#${channelName} limited to 1 message/day (already sent today)` };
      }
      dailyStates.set(channelName, { lastSendDate: today });
      return { action: "send" };
    }

    case "embed-edit": {
      const state = embedEditStates.get(channelName);
      if (state?.lastMessageId) {
        return { action: "edit", editMessageId: state.lastMessageId };
      }
      return { action: "send" };
    }

    case "batch": {
      if (!batchBuffers.has(channelName)) {
        batchBuffers.set(channelName, {
          messages: [],
          flushTimer: null,
          windowStart: Date.now(),
        });
      }

      const buffer = batchBuffers.get(channelName)!;
      buffer.messages.push(content);

      // If buffer hits max, flush immediately
      if (rule.maxMessages && buffer.messages.length >= rule.maxMessages) {
        const combined = buffer.messages.join("\n───\n");
        buffer.messages = [];
        buffer.windowStart = Date.now();
        if (buffer.flushTimer) {
          clearTimeout(buffer.flushTimer);
          buffer.flushTimer = null;
        }
        return { action: "send", bufferedContent: combined };
      }

      // Set a flush timer if not already running
      if (!buffer.flushTimer && rule.windowMs) {
        buffer.flushTimer = setTimeout(() => {
          flushBuffer(channelName);
        }, rule.windowMs);
      }

      return { action: "buffer", reason: `Buffered (${buffer.messages.length}/${rule.maxMessages})` };
    }

    default:
      return { action: "send" };
  }
}

/**
 * Record a sent embed message ID for embed-edit channels.
 */
export function recordEmbedMessageId(channelName: string, messageId: string): void {
  embedEditStates.set(channelName, { lastMessageId: messageId });
}

/**
 * Force-flush the throttle buffer for a channel.
 */
export async function forceFlush(channelName: string): Promise<string | null> {
  const buffer = batchBuffers.get(channelName);
  if (!buffer || buffer.messages.length === 0) return null;

  const combined = buffer.messages.join("\n───\n");
  buffer.messages = [];
  buffer.windowStart = Date.now();
  if (buffer.flushTimer) {
    clearTimeout(buffer.flushTimer);
    buffer.flushTimer = null;
  }

  return combined;
}

/**
 * Clean up all timers (for graceful shutdown).
 */
export function cleanupThrottleTimers(): void {
  for (const [, buffer] of batchBuffers) {
    if (buffer.flushTimer) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = null;
    }
  }
  batchBuffers.clear();
  dailyStates.clear();
  embedEditStates.clear();
}
