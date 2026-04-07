import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestDb, TestDbContext, registerTestAgent } from "./helpers/db-setup.js";
import {
  reportStatus,
  listAgents,
  startTrace,
  endTrace,
  getTrace,
  readAuditLog,
  verifyAuditChain,
} from "../src/tools/observability-tools.js";
import { appendAudit } from "../src/database.js";

describe("observability-tools", () => {
  let ctx: TestDbContext;
  beforeEach(() => { ctx = setupTestDb(); });
  afterEach(() => { ctx.cleanup(); });

  describe("reportStatus", () => {
    it("updates a pre-registered agent", () => {
      registerTestAgent(ctx.db, "eng-1", "software-engineer", "engineering");
      const result = reportStatus({
        agent_id: "eng-1",
        role_id: "software-engineer",
        department: "engineering",
        status: "online",
      });
      expect(result.agent.agent_id).toBe("eng-1");
      expect(result.agent.status).toBe("online");
    });

    it("updates status from idle to busy", () => {
      registerTestAgent(ctx.db, "eng-1", "software-engineer", "engineering");
      reportStatus({
        agent_id: "eng-1", role_id: "software-engineer",
        department: "engineering", status: "online",
      });
      const result = reportStatus({
        agent_id: "eng-1", role_id: "software-engineer",
        department: "engineering", status: "busy",
      });
      expect(result.agent.status).toBe("busy");
    });

    it("rejects unregistered agent", () => {
      expect(() => {
        reportStatus({ agent_id: "ghost-1", role_id: "ghost", status: "online" });
      }).toThrow(/not registered/);
    });
  });

  describe("listAgents", () => {
    it("returns all agents", () => {
      registerTestAgent(ctx.db, "a1", "r1");
      registerTestAgent(ctx.db, "a2", "r2");
      reportStatus({ agent_id: "a1", role_id: "r1", status: "online" });
      reportStatus({ agent_id: "a2", role_id: "r2", status: "idle" });
      const agents = listAgents({});
      expect(agents.length).toBe(2);
    });

    it("filters by status", () => {
      registerTestAgent(ctx.db, "a1", "r1");
      registerTestAgent(ctx.db, "a2", "r2");
      reportStatus({ agent_id: "a1", role_id: "r1", status: "online" });
      reportStatus({ agent_id: "a2", role_id: "r2", status: "idle" });
      const agents = listAgents({ status: "online" });
      expect(agents.length).toBe(1);
      expect(agents[0].agent_id).toBe("a1");
    });

    it("filters by department", () => {
      registerTestAgent(ctx.db, "a1", "r1", "eng");
      registerTestAgent(ctx.db, "a2", "r2", "ops");
      reportStatus({ agent_id: "a1", role_id: "r1", department: "eng", status: "online" });
      reportStatus({ agent_id: "a2", role_id: "r2", department: "ops", status: "online" });
      const agents = listAgents({ department: "eng" });
      expect(agents.length).toBe(1);
      expect(agents[0].agent_id).toBe("a1");
    });
  });

  describe("tracing", () => {
    it("creates and ends a trace span", () => {
      const span = startTrace({
        agent_id: "eng-1", operation: "build-feature",
      });
      expect(span.trace_id).toMatch(/^trace-/);
      expect(span.span_id).toMatch(/^span-/);

      const result = endTrace({ span_id: span.span_id, status: "completed" });
      expect(result.message).toContain("completed");
    });

    it("retrieves all spans for a trace", () => {
      const span1 = startTrace({ agent_id: "eng-1", operation: "op1" });
      startTrace({
        agent_id: "eng-1", operation: "op2",
        trace_id: span1.trace_id,
      });

      const spans = getTrace({ trace_id: span1.trace_id });
      expect(spans.length).toBe(2);
    });
  });

  describe("audit", () => {
    it("verifies a clean audit chain", () => {
      appendAudit("a1", "t1", "test.action", "first entry");
      appendAudit("a2", "t2", "test.action", "second entry");

      const result = verifyAuditChain({ limit: 100 });
      expect(result.valid).toBe(true);
      expect(result.checked).toBeGreaterThan(0);
    });

    it("reads audit log filtered by agent_id", () => {
      appendAudit("a1", "t1", "test.action", "entry from a1");
      appendAudit("a2", "t2", "test.action", "entry from a2");

      const logs = readAuditLog({ agent_id: "a1" });
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((l: any) => l.agent_id === "a1")).toBe(true);
    });
  });
});
