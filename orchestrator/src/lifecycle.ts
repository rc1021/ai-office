import fs from "node:fs";
import path from "node:path";
import { WorkerRecord, WorkerStatus } from "./types.js";
import { getStateDir, getOfficeConfig, getProjectRootPath } from "./config-reader.js";
import { issueToken, revokeToken } from "./identity.js";
import { assembleWorkerClaude, loadRoleTemplate } from "./template-assembler.js";

// ─── Workers State ───────────────────────────────────────────────────────────

function getWorkersPath(): string {
  return path.join(getStateDir(), "workers.json");
}

function loadWorkers(): WorkerRecord[] {
  const p = getWorkersPath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

function saveWorkers(workers: WorkerRecord[]): void {
  const p = getWorkersPath();
  fs.writeFileSync(p, JSON.stringify(workers, null, 2), "utf-8");
}

// ─── Instance Numbering ─────────────────────────────────────────────────────

function getNextInstance(roleId: string): number {
  const workers = loadWorkers();
  const existing = workers
    .filter((w) => w.role_id === roleId)
    .map((w) => w.instance);
  return existing.length === 0 ? 1 : Math.max(...existing) + 1;
}

// ─── Worker Workspace ────────────────────────────────────────────────────────

function getWorkersDir(): string {
  const dir = path.join(getStateDir(), "workers");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWorkerWorkspace(agentId: string): string {
  const dir = path.join(getWorkersDir(), agentId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Read Discord credentials from project-root .mcp.json or discord-bot/.env
 * (process.env won't have them when running orchestrator CLI directly)
 */
function readDiscordCredentials(): { token: string; guildId: string } {
  const root = getProjectRootPath();

  // Try .mcp.json first
  const mcpPath = path.join(root, ".mcp.json");
  if (fs.existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(fs.readFileSync(mcpPath, "utf-8"));
      const discordEnv = mcp?.mcpServers?.["ai-office-discord"]?.env;
      if (discordEnv?.DISCORD_BOT_TOKEN && discordEnv?.DISCORD_GUILD_ID) {
        return { token: discordEnv.DISCORD_BOT_TOKEN, guildId: discordEnv.DISCORD_GUILD_ID };
      }
    } catch { /* fall through */ }
  }

  // Try discord-bot/.env
  const envPath = path.join(root, "discord-bot", ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf-8");
    const tokenMatch = content.match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    const guildMatch = content.match(/^DISCORD_GUILD_ID=(.+)$/m);
    if (tokenMatch && guildMatch) {
      return { token: tokenMatch[1].trim(), guildId: guildMatch[1].trim() };
    }
  }

  return { token: "", guildId: "" };
}

function generateWorkerMcpJson(roleId: string): object {
  const root = getProjectRootPath();
  const nodeCmd = process.execPath; // Use the same Node binary as the current process

  // All workers get coordination server. Discord is optional based on role.
  const servers: Record<string, object> = {
    "ai-office-coordination": {
      command: nodeCmd,
      args: [path.join(root, "coordination", "dist", "index.js")],
      env: {
        AI_OFFICE_WORKSPACE: "~/.ai-office",
        AI_OFFICE_ROOT: root,
      },
    },
  };

  // Check if role needs Discord access
  let template: import("./types.js").RoleTemplate | null;
  try {
    template = loadRoleTemplate(roleId);
  } catch {
    template = null;
  }

  const allTools = [
    ...(template?.capabilities?.tools_required ?? []),
    ...(template?.capabilities?.tools_optional ?? []),
  ];

  if (allTools.includes("ai-office-discord")) {
    const discord = readDiscordCredentials();
    servers["ai-office-discord"] = {
      command: nodeCmd,
      args: [path.join(root, "discord-bot", "dist", "index.js")],
      env: {
        DISCORD_BOT_TOKEN: discord.token,
        DISCORD_GUILD_ID: discord.guildId,
        AI_OFFICE_ROOT: root,
      },
    };
  }

  return { mcpServers: servers };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if we can spawn another worker.
 */
export function canSpawn(): { allowed: boolean; reason?: string; active: number; max: number } {
  const config = getOfficeConfig();
  const workers = loadWorkers();
  const active = workers.filter((w) =>
    w.status === "spawning" || w.status === "online" || w.status === "busy"
  ).length;
  const max = config.agents.workers.max_concurrent;

  if (active >= max) {
    return { allowed: false, reason: `Active workers (${active}) >= max (${max})`, active, max };
  }
  return { allowed: true, active, max };
}

/**
 * Prepare a worker for spawning: allocate instance, create workspace, assemble CLAUDE.md, issue token.
 */
export function prepareWorker(roleId: string): WorkerRecord {
  const spawnCheck = canSpawn();
  if (!spawnCheck.allowed) {
    throw new Error(`Cannot spawn: ${spawnCheck.reason}`);
  }

  const config = getOfficeConfig();
  const instance = getNextInstance(roleId);
  const agentId = `${roleId}-${instance}`;

  // Issue identity token
  const token = issueToken(roleId, instance);

  // Create workspace directory
  const workspaceDir = createWorkerWorkspace(agentId);

  // Assemble CLAUDE.md
  const claudeMd = assembleWorkerClaude(roleId, instance, config, token);
  fs.writeFileSync(path.join(workspaceDir, "CLAUDE.md"), claudeMd, "utf-8");

  // Generate .mcp.json
  const mcpJson = generateWorkerMcpJson(roleId);
  fs.writeFileSync(
    path.join(workspaceDir, ".mcp.json"),
    JSON.stringify(mcpJson, null, 2),
    "utf-8"
  );

  // Create worker record
  const record: WorkerRecord = {
    agent_id: agentId,
    role_id: roleId,
    instance,
    status: "spawning",
    workspace_dir: workspaceDir,
    identity_token: token,
    spawned_at: new Date().toISOString(),
  };

  // Save to workers.json
  const workers = loadWorkers();
  workers.push(record);
  saveWorkers(workers);

  console.log(`[Lifecycle] Prepared worker: ${agentId} at ${workspaceDir}`);
  return record;
}

/**
 * Update a worker's status.
 */
export function updateWorkerStatus(agentId: string, status: WorkerStatus): void {
  const workers = loadWorkers();
  const worker = workers.find((w) => w.agent_id === agentId);
  if (!worker) {
    throw new Error(`Worker not found: ${agentId}`);
  }

  worker.status = status;
  if (status === "stopped") {
    worker.stopped_at = new Date().toISOString();
  }

  saveWorkers(workers);
  console.log(`[Lifecycle] ${agentId} status → ${status}`);
}

/**
 * Stop a worker: revoke token, update status, cleanup workspace.
 */
export function stopWorker(agentId: string): void {
  const workers = loadWorkers();
  const worker = workers.find((w) => w.agent_id === agentId);
  if (!worker) {
    throw new Error(`Worker not found: ${agentId}`);
  }

  // Revoke identity token
  revokeToken(agentId);

  // Update status
  worker.status = "stopped";
  worker.stopped_at = new Date().toISOString();
  saveWorkers(workers);

  // Cleanup workspace
  if (fs.existsSync(worker.workspace_dir)) {
    fs.rmSync(worker.workspace_dir, { recursive: true, force: true });
    console.log(`[Lifecycle] Cleaned workspace: ${worker.workspace_dir}`);
  }

  console.log(`[Lifecycle] Stopped worker: ${agentId}`);
}

/**
 * List all workers (optionally filter by status).
 */
export function listWorkers(statusFilter?: WorkerStatus): WorkerRecord[] {
  const workers = loadWorkers();
  if (statusFilter) {
    return workers.filter((w) => w.status === statusFilter);
  }
  return workers;
}

/**
 * Get a specific worker record.
 */
export function getWorker(agentId: string): WorkerRecord | null {
  const workers = loadWorkers();
  return workers.find((w) => w.agent_id === agentId) ?? null;
}

/**
 * Clean up stale workers from previous crashed sessions.
 */
export function cleanupStaleWorkers(): number {
  const workers = loadWorkers();
  const stale = workers.filter(
    (w) => w.status === "spawning" || w.status === "online" || w.status === "busy"
  );

  let cleaned = 0;
  for (const worker of stale) {
    worker.status = "stopped";
    worker.stopped_at = new Date().toISOString();
    revokeToken(worker.agent_id);

    if (fs.existsSync(worker.workspace_dir)) {
      fs.rmSync(worker.workspace_dir, { recursive: true, force: true });
    }
    cleaned++;
  }

  if (cleaned > 0) {
    saveWorkers(workers);
    console.log(`[Lifecycle] Cleaned ${cleaned} stale workers from previous session`);
  }

  return cleaned;
}
