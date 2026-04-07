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
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:discord:*"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(true);
  });

  it("denies when no matching scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:discord:alerts"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("lacks write");
  });

  it("allows with exact scope match", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({ scopes: ["write:discord:general"] }));
    const result = checkOutputGate("test-1", "general", "hello");
    expect(result.allowed).toBe(true);
  });

  it("denied scope overrides allowed scope", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:discord:*"],
      denied_scopes: ["write:discord:alerts"],
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
      scopes: ["write:discord:dept-*"],
    }));
    const result = checkOutputGate("test-1", "dept-sales", "hi");
    expect(result.allowed).toBe(true);
  });

  it("denies low clearance for confidential channel", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:discord:dept-*"],
      clearance_level: 1,
    }));
    const result = checkOutputGate("test-1", "dept-engineering-confidential", "test");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("confidential");
  });

  it("allows clearance 2 for confidential channel", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:discord:dept-*"],
      clearance_level: 2,
    }));
    const result = checkOutputGate("test-1", "dept-engineering-confidential", "test");
    expect(result.allowed).toBe(true);
  });

  it("denies RESTRICTED content with low clearance", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:discord:*"],
      clearance_level: 1,
    }));
    const result = checkOutputGate("test-1", "general", "[RESTRICTED] secret data");
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe("RESTRICTED");
  });

  it("allows RESTRICTED content with clearance 3", () => {
    mockedResolveAgent.mockReturnValue(makeAgent({
      scopes: ["write:discord:*"],
      clearance_level: 3,
    }));
    const result = checkOutputGate("test-1", "general", "[RESTRICTED] secret data");
    expect(result.allowed).toBe(true);
  });
});
