import { describe, it, expect, afterEach, vi } from "vitest";
import {
  throttle,
  recordEmbedMessageId,
  forceFlush,
  cleanupThrottleTimers,
} from "@ai-office/core";

describe("throttle", () => {
  afterEach(() => {
    cleanupThrottleTimers();
    vi.useRealTimers();
  });

  // -- No-throttle channels (the 4 active channels) --

  it("sends immediately on general", () => {
    const result = throttle("general", "hello");
    expect(result.action).toBe("send");
  });

  it("sends immediately on approvals", () => {
    const result = throttle("approvals", "approve this");
    expect(result.action).toBe("send");
  });

  it("sends immediately on alerts", () => {
    const result = throttle("alerts", "alert!");
    expect(result.action).toBe("send");
  });

  // -- Daily limit --

  it("allows first daily message on daily-brief", () => {
    const result = throttle("daily-brief", "Good morning");
    expect(result.action).toBe("send");
  });

  it("rejects second daily message on daily-brief", () => {
    throttle("daily-brief", "First");
    const result = throttle("daily-brief", "Second");
    expect(result.action).toBe("reject");
    expect(result.reason).toContain("1 message/day");
  });

  // -- Unknown channels default to no-throttle --

  it("sends immediately on unknown channel", () => {
    const result = throttle("some-unknown-channel", "hello");
    expect(result.action).toBe("send");
  });

  // -- Bypass checks --

  it("bypasses throttle for threads", () => {
    const result = throttle("daily-brief", "msg", { isThread: true });
    expect(result.action).toBe("send");
  });

  it("bypasses throttle for mentions", () => {
    const result = throttle("daily-brief", "msg", { hasMention: true });
    expect(result.action).toBe("send");
  });

  it("bypasses throttle for errors", () => {
    const result = throttle("daily-brief", "msg", { isError: true });
    expect(result.action).toBe("send");
  });

  // -- Force flush --

  it("forceFlush returns null when buffer is empty", async () => {
    const flushed = await forceFlush("general");
    expect(flushed).toBeNull();
  });
});
