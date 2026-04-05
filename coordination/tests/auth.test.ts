import { describe, it, expect, beforeEach, vi } from "vitest";

// We need to test initAuth with different env vars, so we re-import each time
describe("auth", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.AI_OFFICE_AGENT_TOKEN;
  });

  it("runs unrestricted when no token is set", async () => {
    const { initAuth, isAuthEnabled, enforceIdentity, enforceClearance } = await import("../src/auth.js");
    const identity = initAuth();
    expect(identity).toBeNull();
    expect(isAuthEnabled()).toBe(false);
    // Should not throw in unrestricted mode
    enforceIdentity("any-agent");
    enforceClearance(3);
  });

  it("authenticates with a valid token", async () => {
    // Build a fake token (header.payload.signature)
    const payload = {
      agent_id: "software-engineer-1",
      role_id: "software-engineer",
      department: "engineering",
      clearance_level: 1,
      scopes: ["read:coordination:*"],
      denied_scopes: [],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: "test-session",
    };
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const fakeToken = `${header}.${body}.fakesig`;

    process.env.AI_OFFICE_AGENT_TOKEN = fakeToken;
    const { initAuth, isAuthEnabled, getAuthIdentity } = await import("../src/auth.js");

    const identity = initAuth();
    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toBe("software-engineer-1");
    expect(isAuthEnabled()).toBe(true);
    expect(getAuthIdentity()?.department).toBe("engineering");
  });

  it("enforceIdentity blocks mismatched agent_id", async () => {
    const payload = {
      agent_id: "software-engineer-1",
      role_id: "software-engineer",
      department: "engineering",
      clearance_level: 1,
      scopes: [],
      denied_scopes: [],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: "test",
    };
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    process.env.AI_OFFICE_AGENT_TOKEN = `${header}.${body}.sig`;

    const { initAuth, enforceIdentity } = await import("../src/auth.js");
    initAuth();

    // Same agent — should pass
    enforceIdentity("software-engineer-1");

    // Different agent — should throw
    expect(() => enforceIdentity("leader")).toThrow("Identity mismatch");
  });

  it("enforceClearance blocks insufficient clearance", async () => {
    const payload = {
      agent_id: "worker-1",
      role_id: "worker",
      department: "engineering",
      clearance_level: 1,
      scopes: [],
      denied_scopes: [],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: "test",
    };
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    process.env.AI_OFFICE_AGENT_TOKEN = `${header}.${body}.sig`;

    const { initAuth, enforceClearance } = await import("../src/auth.js");
    initAuth();

    // Clearance 1 — allowed for level 1
    enforceClearance(1);

    // Clearance 1 — denied for level 3
    expect(() => enforceClearance(3)).toThrow("Clearance denied");
  });

  it("rejects expired token gracefully", async () => {
    const payload = {
      agent_id: "worker-1",
      role_id: "worker",
      department: "engineering",
      clearance_level: 1,
      scopes: [],
      denied_scopes: [],
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
      session_id: "test",
    };
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    process.env.AI_OFFICE_AGENT_TOKEN = `${header}.${body}.sig`;

    const { initAuth, isAuthEnabled } = await import("../src/auth.js");
    const identity = initAuth();
    expect(identity).toBeNull();
    expect(isAuthEnabled()).toBe(false);
  });

  it("rejects malformed token gracefully", async () => {
    process.env.AI_OFFICE_AGENT_TOKEN = "not-a-valid-token";

    const { initAuth, isAuthEnabled } = await import("../src/auth.js");
    const identity = initAuth();
    expect(identity).toBeNull();
    expect(isAuthEnabled()).toBe(false);
  });
});
