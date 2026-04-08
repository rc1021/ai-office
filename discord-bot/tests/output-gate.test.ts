import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentProfile } from "@ai-office/core";

// Mock the agent-registry at the core's internal path
// checkOutputGate imports resolveAgent from "./agent-registry.js" inside core
vi.mock("@ai-office/core/dist/agent-registry.js", () => ({
  resolveAgent: vi.fn(),
}));

import { checkOutputGate } from "@ai-office/core";
import { resolveAgent } from "@ai-office/core/dist/agent-registry.js";

const mockedResolveAgent = vi.mocked(resolveAgent);

function makeAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agent_id: "test-1",
    role_id: "test",
    department: "engineering",
    clearance_level: 1,
    scopes: [],
    denied_scopes: [],
    ...overrides,
  };
}

describe("checkOutputGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows with wildcard scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:channel:*"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(true);
  });

  it("denies when no matching scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:channel:alerts"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("lacks write");
  });

  it("allows with exact scope match", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:channel:general"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(true);
  });

  it("denied scope overrides allowed scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      denied_scopes: ["write:channel:alerts"],
    }));
    const result = checkOutputGate("test-1", "alerts", "test");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("explicitly denied");
  });

  it("allows department channel via department membership", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      department: "engineering",
      scopes: [],
    }));
    const result = checkOutputGate("test-1", "dept-engineering", "test");
    expect(result.allowed).toBe(true);
  });

  it("denies department channel for wrong department", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      department: "marketing",
      scopes: [],
    }));
    const result = checkOutputGate("test-1", "dept-engineering", "test");
    expect(result.allowed).toBe(false);
  });

  it("allows with dept-* glob scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      department: "marketing",
      scopes: ["write:channel:dept-*"],
    }));
    const result = checkOutputGate("test-1", "dept-sales", "hi");
    expect(result.allowed).toBe(true);
  });

  it("denies RESTRICTED content with low clearance", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 1,
    }));
    const result = checkOutputGate("test-1", "general", "[RESTRICTED] secret data");
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe("RESTRICTED");
  });

  it("allows RESTRICTED content with clearance 3", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 3,
    }));
    const result = checkOutputGate("test-1", "general", "[RESTRICTED] secret data");
    expect(result.allowed).toBe(true);
  });

  // ── Check field on denied results ──────────────────────────────────────────

  it("check1: sets check field on denied-scope block", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      denied_scopes: ["write:channel:alerts"],
    }));
    const result = checkOutputGate("test-1", "alerts", "test");
    expect(result.allowed).toBe(false);
    expect(result.check).toBe("check1_denied_scope");
  });

  it("check2: sets check field on missing-scope block", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: [] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(false);
    expect(result.check).toBe("check2_write_scope");
  });

  // ── Check 3: Channel clearance ─────────────────────────────────────────────

  it("check3: denies audit-log channel when clearance < 3", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 2,
    }));
    const result = checkOutputGate("test-1", "audit-log", "hello");
    expect(result.allowed).toBe(false);
    expect(result.check).toBe("check3_channel_clearance");
    expect(result.reason).toContain("below the minimum");
  });

  it("check3: allows audit-log channel when clearance = 3", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 3,
    }));
    const result = checkOutputGate("test-1", "audit-log", "hello");
    expect(result.allowed).toBe(true);
  });

  it("check3: denies -confidential channel when clearance < 2", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 1,
    }));
    const result = checkOutputGate("test-1", "dept-engineering-confidential", "hello");
    expect(result.allowed).toBe(false);
    expect(result.check).toBe("check3_channel_clearance");
  });

  it("check3: allows -confidential channel when clearance >= 2", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 2,
    }));
    const result = checkOutputGate("test-1", "dept-engineering-confidential", "hello");
    expect(result.allowed).toBe(true);
  });

  // ── Check 4: Data classification ──────────────────────────────────────────

  it("check4: sets check field on data-classification block", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:channel:*"],
      clearance_level: 1,
    }));
    const result = checkOutputGate("test-1", "general", "[RESTRICTED] secret data");
    expect(result.allowed).toBe(false);
    expect(result.check).toBe("check4_data_classification");
    expect(result.classification).toBe("RESTRICTED");
  });
});
