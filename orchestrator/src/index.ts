#!/usr/bin/env node

import { getOfficeConfig } from "./config-reader.js";
import { generateSessionKey, issueToken, validateToken } from "./identity.js";
import { prepareWorker, stopWorker, listWorkers, canSpawn, cleanupStaleWorkers } from "./lifecycle.js";
import { syncActiveRolesToDb } from "./sync-agents.js";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function output(data: object): void {
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  switch (command) {
    // ── Session Management ──────────────────────────────────────────────
    case "init": {
      const sessionId = generateSessionKey();
      const stale = cleanupStaleWorkers();
      const config = getOfficeConfig();
      const synced = syncActiveRolesToDb();
      output({
        session_id: sessionId,
        office_name: config.office.name,
        language: config.office.language,
        max_workers: config.agents.workers.max_concurrent,
        stale_workers_cleaned: stale,
        agents_synced: synced,
      });
      break;
    }

    // ── Worker Lifecycle ────────────────────────────────────────────────
    case "prepare-worker": {
      const roleId = getFlag("role");
      if (!roleId) {
        console.error("Usage: prepare-worker --role <role-id>");
        process.exit(1);
      }
      const record = prepareWorker(roleId);
      output({
        agent_id: record.agent_id,
        role_id: record.role_id,
        instance: record.instance,
        workspace_dir: record.workspace_dir,
        identity_token: record.identity_token,
        claude_md_path: `${record.workspace_dir}/CLAUDE.md`,
      });
      break;
    }

    case "stop-worker": {
      const agentId = getFlag("agent-id");
      if (!agentId) {
        console.error("Usage: stop-worker --agent-id <agent-id>");
        process.exit(1);
      }
      stopWorker(agentId);
      output({ agent_id: agentId, status: "stopped" });
      break;
    }

    case "list-workers": {
      const status = getFlag("status");
      const workers = listWorkers(status as any);
      const capacity = canSpawn();
      output({
        workers,
        capacity: {
          active: capacity.active,
          max: capacity.max,
          can_spawn: capacity.allowed,
        },
      });
      break;
    }

    // ── Identity ────────────────────────────────────────────────────────
    case "validate-token": {
      const token = getFlag("token");
      if (!token) {
        console.error("Usage: validate-token --token <token>");
        process.exit(1);
      }
      const identity = validateToken(token);
      if (identity) {
        output({ valid: true, identity });
      } else {
        output({ valid: false });
        process.exit(1);
      }
      break;
    }

    // ── Config ──────────────────────────────────────────────────────────
    case "office-config": {
      const config = getOfficeConfig();
      output(config);
      break;
    }

    // ── Help ─────────────────────────────────────────────────────────────
    default: {
      console.log(`AI Office Orchestrator CLI

Commands:
  init                          Initialize session (generate key, cleanup stale)
  prepare-worker --role <id>    Prepare a worker workspace for spawning
  stop-worker --agent-id <id>   Stop a worker and cleanup
  list-workers [--status <s>]   List workers (filter: spawning|online|busy|stopped)
  validate-token --token <t>    Validate an identity token
  office-config                 Show office configuration
`);
      break;
    }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
