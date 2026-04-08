import { Router } from "express";
import {
  getAllAgents,
  getAgentById,
  getAllTasks,
  getTasksByStatus,
  getTaskById,
  getRecentEvents,
  getSummary,
  getAuditLog,
  getArtifacts,
  getTraceSpans,
  getActivity,
} from "./db.js";

export function createRouter(): Router {
  const router = Router();

  // Health check endpoint — used by heartbeat.ts
  router.get("/status", (_req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
  });

  router.get("/agents", (_req, res) => {
    res.json(getAllAgents());
  });

  router.get("/agents/:id", (req, res) => {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json(agent);
  });

  router.get("/tasks", (req, res) => {
    const status = req.query.status as string | undefined;
    if (status) {
      res.json(getTasksByStatus(status));
    } else {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json(getAllTasks(limit));
    }
  });

  router.get("/tasks/:id", (req, res) => {
    const task = getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    // Parse JSON fields
    res.json({
      ...task,
      steps: JSON.parse(task.steps),
      input_artifacts: undefined,
    });
  });

  router.get("/events/recent", (req, res) => {
    const since = (req.query.since as string) || "1970-01-01";
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getRecentEvents(since, limit));
  });

  router.get("/summary", (_req, res) => {
    res.json(getSummary());
  });

  // Audit log
  router.get("/audit-log", (req, res) => {
    const since = req.query.since as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    res.json(getAuditLog(since, limit));
  });

  // Artifacts
  router.get("/artifacts", (req, res) => {
    const taskId = req.query.task_id as string | undefined;
    res.json(getArtifacts(taskId));
  });

  // Trace spans
  router.get("/traces/:traceId", (req, res) => {
    res.json(getTraceSpans(req.params.traceId));
  });

  // Unified activity feed
  router.get("/activity", (req, res) => {
    const since = req.query.since as string | undefined;
    const limit = parseInt(req.query.limit as string) || 100;
    const agent = req.query.agent as string | undefined;
    const type = req.query.type as string | undefined;
    res.json(getActivity({ since, limit, agent, type }));
  });

  return router;
}
