import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestDb, TestDbContext, registerTestAgent } from "./helpers/db-setup.js";
import { taskCreate, taskUpdate, taskCheckpoint, taskResume, taskList } from "../src/tools/task-tools.js";

describe("task-tools", () => {
  let ctx: TestDbContext;

  beforeEach(() => {
    ctx = setupTestDb();
    // Pre-register agents directly in DB (bypasses reportStatus validation)
    registerTestAgent(ctx.db, "worker-1", "worker", "engineering");
    registerTestAgent(ctx.db, "leader", "leader", "management", 3);
  });
  afterEach(() => { ctx.cleanup(); });

  describe("taskCreate", () => {
    it("creates a pending task without assignee", () => {
      const task = taskCreate({ title: "Test task", created_by: "leader" });
      expect(task.id).toMatch(/^task-/);
      expect(task.status).toBe("pending");
      expect(task.assigned_to).toBeNull();
    });

    it("creates an assigned task and sets agent to busy", () => {
      const task = taskCreate({
        title: "Assigned task",
        created_by: "leader",
        assigned_to: "worker-1",
        steps: [{ description: "Step 1" }, { description: "Step 2" }],
      });
      expect(task.status).toBe("assigned");
      expect(task.assigned_to).toBe("worker-1");
      expect(task.steps).toHaveLength(2);
    });
  });

  describe("taskUpdate", () => {
    it("updates task status to completed and frees agent", () => {
      const task = taskCreate({
        title: "Complete me",
        created_by: "leader",
        assigned_to: "worker-1",
      });
      const updated = taskUpdate({
        task_id: task.id,
        agent_id: "worker-1",
        status: "completed",
        output_artifact: "result.json",
      });
      expect(updated.status).toBe("completed");
      expect(updated.output_artifact).toBe("result.json");
    });

    it("updates context_summary", () => {
      const task = taskCreate({ title: "Context test", created_by: "leader" });
      const updated = taskUpdate({
        task_id: task.id,
        agent_id: "leader",
        context_summary: "Halfway done",
      });
      expect(updated.context_summary).toBe("Halfway done");
    });
  });

  describe("taskCheckpoint", () => {
    it("marks step completed and advances current_step", () => {
      const task = taskCreate({
        title: "Multi-step",
        created_by: "leader",
        assigned_to: "worker-1",
        steps: [{ description: "Step A" }, { description: "Step B" }],
      });
      const result = taskCheckpoint({
        task_id: task.id,
        agent_id: "worker-1",
        step_index: 0,
        output_artifact: "step0.json",
      });
      expect(result.task.current_step).toBe(1);
      expect(result.task.steps[0].status).toBe("completed");
      expect(result.task.steps[1].status).toBe("in_progress");
    });

    it("throws for invalid step_index", () => {
      const task = taskCreate({
        title: "Short",
        created_by: "leader",
        steps: [{ description: "Only step" }],
      });
      expect(() => {
        taskCheckpoint({ task_id: task.id, agent_id: "leader", step_index: 5 });
      }).toThrow();
    });
  });

  describe("taskResume", () => {
    it("finds incomplete task for agent", () => {
      const task = taskCreate({
        title: "Resumable",
        created_by: "leader",
        assigned_to: "worker-1",
        steps: [{ description: "S1" }, { description: "S2" }],
      });
      taskCheckpoint({ task_id: task.id, agent_id: "worker-1", step_index: 0 });

      const result = taskResume({ agent_id: "worker-1" });
      expect(result.task).not.toBeNull();
      expect(result.task!.id).toBe(task.id);
      expect(result.resume_context).toContain("S2");
    });

    it("returns null when no incomplete tasks exist", () => {
      const result = taskResume({ agent_id: "worker-1" });
      expect(result.task).toBeNull();
    });
  });

  describe("taskList", () => {
    it("lists tasks filtered by status", () => {
      taskCreate({ title: "Task A", created_by: "leader" });
      taskCreate({ title: "Task B", created_by: "leader", assigned_to: "worker-1" });

      const pending = taskList({ status: "pending" });
      expect(pending.length).toBe(1);
      expect(pending[0].title).toBe("Task A");

      const assigned = taskList({ status: "assigned" });
      expect(assigned.length).toBe(1);
      expect(assigned[0].title).toBe("Task B");
    });

    it("lists tasks filtered by assigned_to", () => {
      taskCreate({ title: "Mine", created_by: "leader", assigned_to: "worker-1" });
      taskCreate({ title: "Unassigned", created_by: "leader" });

      const result = taskList({ assigned_to: "worker-1" });
      expect(result.length).toBe(1);
      expect(result[0].title).toBe("Mine");
    });
  });
});
