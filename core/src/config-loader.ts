/**
 * config-loader.ts — Load office.yaml configuration
 *
 * Reads config/office.yaml from the project root and exports
 * key settings needed by subsystems (event bridge, heartbeat, etc.).
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface AuditConfig {
  autoReview: boolean;
  riskThreshold: "GREEN" | "YELLOW" | "RED";
}

export interface ModelsConfig {
  leader: string;
  worker: string;
  dailyBrief: string;
  auditor: string;
}

export interface OfficeConfig {
  timezone: string;
  language: string;
  statePath: string;
  dailyBriefTime: string; // "HH:MM" format, default "08:00"
  audit: AuditConfig;
  executionMode: "sequential" | "parallel"; // default "sequential"
  maxConcurrent: number; // agents.workers.max_concurrent, default 1
  models: ModelsConfig;
}

let cached: OfficeConfig | null = null;

export function loadOfficeConfig(projectDir: string): OfficeConfig {
  if (cached) return cached;

  const configPath = path.join(projectDir, "config", "office.yaml");
  // Fall back to example if user hasn't created office.yaml yet
  const examplePath = path.join(projectDir, "config", "office.yaml.example");
  const filePath = fs.existsSync(configPath) ? configPath : examplePath;

  const raw = yaml.load(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  const office = (raw?.office ?? {}) as Record<string, string>;
  const paths = (raw?.paths ?? {}) as Record<string, string>;

  const auditRaw = (raw?.audit ?? {}) as Record<string, unknown>;
  const executionRaw = (raw?.execution ?? {}) as Record<string, unknown>;
  const agentsRaw = (raw?.agents ?? {}) as Record<string, unknown>;
  const workersRaw = (agentsRaw.workers ?? {}) as Record<string, unknown>;
  const leaderRaw = (agentsRaw.leader ?? {}) as Record<string, unknown>;
  const modelsRaw = (raw?.models ?? {}) as Record<string, unknown>;

  const rawMode = executionRaw.mode;
  const executionMode: "sequential" | "parallel" =
    rawMode === "parallel" ? "parallel" : "sequential";

  const maxConcurrent =
    typeof workersRaw.max_concurrent === "number" && workersRaw.max_concurrent > 0
      ? workersRaw.max_concurrent
      : 1;

  cached = {
    timezone: office.timezone ?? "Asia/Taipei",
    language: office.language ?? "zh-TW",
    statePath: path.resolve(projectDir, paths.state ?? ".ai-office/state"),
    dailyBriefTime: office.daily_brief_time ?? "08:00",
    audit: {
      autoReview: auditRaw.auto_review === true,
      riskThreshold: (auditRaw.risk_threshold as "GREEN" | "YELLOW" | "RED") ?? "YELLOW",
    },
    executionMode,
    maxConcurrent,
    models: {
      leader: (leaderRaw.model as string) ?? "sonnet",
      worker: (workersRaw.model as string) ?? "sonnet",
      dailyBrief: (modelsRaw.daily_brief as string) ?? "sonnet",
      auditor: (modelsRaw.auditor as string) ?? "sonnet",
    },
  };

  console.log(`[ConfigLoader] Loaded config: timezone=${cached.timezone}, language=${cached.language}, state=${cached.statePath}, executionMode=${cached.executionMode}, maxConcurrent=${cached.maxConcurrent}, models.leader=${cached.models.leader}, models.worker=${cached.models.worker}`);
  return cached;
}
