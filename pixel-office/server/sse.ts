import { Request, Response } from "express";
import { getAllAgents, getAllTasks, AgentRow, TaskRow } from "./db.js";

interface SSEClient {
  res: Response;
  lastAgents: string; // JSON hash for diff detection
  lastTasks: string;
}

const clients: Set<SSEClient> = new Set();
let pollInterval: ReturnType<typeof setInterval> | null = null;

function hashData(data: unknown): string {
  return JSON.stringify(data);
}

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

function pollForChanges(): void {
  try {
    const agents = getAllAgents();
    const tasks = getAllTasks(20);
    const agentsHash = hashData(agents);
    const tasksHash = hashData(tasks);

    for (const client of clients) {
      // Send agents if changed
      if (client.lastAgents !== agentsHash) {
        const payload = `event: agents\ndata: ${JSON.stringify(agents)}\n\n`;
        try {
          client.res.write(payload);
          client.lastAgents = agentsHash;
        } catch {
          clients.delete(client);
        }
      }

      // Send tasks if changed
      if (client.lastTasks !== tasksHash) {
        const parsed = tasks.map((t) => ({
          ...t,
          steps: JSON.parse(t.steps),
        }));
        const payload = `event: tasks\ndata: ${JSON.stringify(parsed)}\n\n`;
        try {
          client.res.write(payload);
          client.lastTasks = tasksHash;
        } catch {
          clients.delete(client);
        }
      }
    }
  } catch (err) {
    console.error("[SSE] Poll error:", err);
  }
}

export function handleSSE(req: Request, res: Response): void {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send initial data
  const agents = getAllAgents();
  const tasks = getAllTasks(20).map((t) => ({
    ...t,
    steps: JSON.parse(t.steps),
  }));

  res.write(`event: agents\ndata: ${JSON.stringify(agents)}\n\n`);
  res.write(`event: tasks\ndata: ${JSON.stringify(tasks)}\n\n`);

  const client: SSEClient = {
    res,
    lastAgents: hashData(agents),
    lastTasks: hashData(getAllTasks(20)),
  };
  clients.add(client);

  // Start polling if not already running
  if (!pollInterval) {
    pollInterval = setInterval(pollForChanges, 2000);
    console.log("[SSE] Polling started (2s interval)");
  }

  // Keepalive
  const keepalive = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepalive);
      clients.delete(client);
    }
  }, 15000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(keepalive);
    clients.delete(client);
    console.log(`[SSE] Client disconnected (${clients.size} remaining)`);

    if (clients.size === 0 && pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
      console.log("[SSE] Polling stopped (no clients)");
    }
  });

  console.log(`[SSE] Client connected (${clients.size} total)`);
}
