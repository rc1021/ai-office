import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock config-reader to use temp directories
let tmpDir: string;
let stateDir: string;
let projectRoot: string;

vi.mock("../src/config-reader.js", () => ({
  getStateDir: () => stateDir,
  getOfficeConfig: () => ({
    office: { name: "Test", language: "en", timezone: "UTC" },
    agents: {
      leader: { model: "opus" },
      workers: { model: "sonnet", max_concurrent: 3, default_timeout: 300, token_ttl: 3600 },
    },
    execution: { mode: "sequential", human_in_the_loop: true, auto_approve_risk: "GREEN" },
    startup: { greet_user: false, resume_pending_tasks: false, post_status_to_discord: false },
    logging: { level: "INFO", structured: true, audit_trail: true, trace_enabled: true },
    paths: { state: ".ai-office/state", artifacts: ".ai-office/artifacts", events: ".ai-office/events", logs: ".ai-office/logs", memory: ".ai-office/memory" },
  }),
  getProjectRootPath: () => projectRoot,
}));

import {
  generateSessionKey,
  issueToken,
  validateToken,
  revokeToken,
} from "../src/identity.js";

describe("identity", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ai-office-identity-test-"));
    stateDir = join(tmpDir, "state");
    projectRoot = join(tmpDir, "project");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(projectRoot, "roles", "templates"), { recursive: true });

    // Write a minimal role template
    writeFileSync(join(projectRoot, "roles", "templates", "software-engineer.yaml"), `
id: software-engineer
department: engineering
persona:
  role_description: "Test engineer"
  communication_style: "technical"
capabilities:
  primary_tasks: ["code"]
  output_formats: ["code"]
  tools_required: ["ai-office-coordination"]
security:
  clearance_level: 1
  scopes: ["read:coordination:*"]
  denied_scopes: []
  max_autonomous_risk: "GREEN"
`, "utf-8");

    // Generate a fresh session for each test
    generateSessionKey();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates a session key and returns session ID", () => {
    const sessionId = generateSessionKey();
    expect(sessionId).toHaveLength(16);
  });

  it("issues a 3-part dot-separated token", () => {
    const token = issueToken("software-engineer", 1);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("validates a freshly issued token", () => {
    const token = issueToken("software-engineer", 1);
    const identity = validateToken(token);
    expect(identity).not.toBeNull();
    expect(identity!.agent_id).toBe("software-engineer-1");
    expect(identity!.role_id).toBe("software-engineer");
    expect(identity!.department).toBe("engineering");
    expect(identity!.clearance_level).toBe(1);
  });

  it("rejects a tampered token", () => {
    const token = issueToken("software-engineer", 1);
    const tampered = token.slice(0, -4) + "xxxx";
    expect(validateToken(tampered)).toBeNull();
  });

  it("rejects a revoked token", () => {
    const token = issueToken("software-engineer", 1);
    revokeToken("software-engineer-1");
    expect(validateToken(token)).toBeNull();
  });

  it("rejects token from a different session", () => {
    const token = issueToken("software-engineer", 1);
    // Generate a new session — invalidates old tokens
    generateSessionKey();
    expect(validateToken(token)).toBeNull();
  });
});
