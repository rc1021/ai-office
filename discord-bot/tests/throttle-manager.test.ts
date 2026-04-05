import { describe, it, expect, afterEach, vi } from "vitest";
import {
  throttle,
  recordEmbedMessageId,
  forceFlush,
  cleanupThrottleTimers,
} from "../src/throttle-manager.js";

describe("throttle", () => {
  afterEach(() => {
    cleanupThrottleTimers();
    vi.useRealTimers();
  });

  // -- No-throttle channels --

  it("sends immediately on no-throttle channel", () => {
    const result = throttle("general", "hello");
    expect(result.action).toBe("send");
  });

  // -- Bypass checks --

  it("bypasses throttle for threads", () => {
    const result = throttle("ai-internal", "msg", { isThread: true });
    expect(result.action).toBe("send");
  });

  it("bypasses throttle for mentions", () => {
    const result = throttle("ai-internal", "msg", { hasMention: true });
    expect(result.action).toBe("send");
  });

  it("bypasses throttle for errors", () => {
    const result = throttle("ai-internal", "msg", { isError: true });
    expect(result.action).toBe("send");
  });

  // -- Daily limit --

  it("allows first daily message", () => {
    const result = throttle("daily-brief", "Good morning");
    expect(result.action).toBe("send");
  });

  it("rejects second daily message", () => {
    throttle("daily-brief", "First");
    const result = throttle("daily-brief", "Second");
    expect(result.action).toBe("reject");
    expect(result.reason).toContain("1 message/day");
  });

  // -- Batch buffering --

  it("buffers messages below max", () => {
    vi.useFakeTimers();
    // ai-internal has batch:5msg/10s
    const r1 = throttle("ai-internal", "msg1");
    expect(r1.action).toBe("buffer");
    const r2 = throttle("ai-internal", "msg2");
    expect(r2.action).toBe("buffer");
    expect(r2.reason).toContain("2/5");
  });

  it("flushes when hitting max messages", () => {
    vi.useFakeTimers();
    // ai-internal: batch:5msg/10s
    for (let i = 1; i < 5; i++) {
      throttle("ai-internal", `msg${i}`);
    }
    const result = throttle("ai-internal", "msg5");
    expect(result.action).toBe("send");
    expect(result.bufferedContent).toContain("msg1");
    expect(result.bufferedContent).toContain("msg5");
  });

  // -- Embed-edit --

  it("sends first message on embed-edit channel", () => {
    const result = throttle("task-board", "status update");
    expect(result.action).toBe("send");
  });

  it("returns edit action after recording message ID", () => {
    throttle("task-board", "first");
    recordEmbedMessageId("task-board", "msg-123");
    const result = throttle("task-board", "updated status");
    expect(result.action).toBe("edit");
    expect(result.editMessageId).toBe("msg-123");
  });

  // -- Force flush --

  it("forceFlush returns combined buffered content", async () => {
    vi.useFakeTimers();
    throttle("ai-internal", "msg1");
    throttle("ai-internal", "msg2");
    const flushed = await forceFlush("ai-internal");
    expect(flushed).toContain("msg1");
    expect(flushed).toContain("msg2");
  });

  it("forceFlush returns null when buffer is empty", async () => {
    const flushed = await forceFlush("general");
    expect(flushed).toBeNull();
  });

  // -- Department channels --

  it("applies default batch throttle to dept channels", () => {
    vi.useFakeTimers();
    // dept channels default: batch:3msg/15s
    const r1 = throttle("dept-engineering", "msg1");
    expect(r1.action).toBe("buffer");
    throttle("dept-engineering", "msg2");
    const r3 = throttle("dept-engineering", "msg3");
    expect(r3.action).toBe("send"); // 3/3 = flush
    expect(r3.bufferedContent).toContain("msg1");
  });
});
