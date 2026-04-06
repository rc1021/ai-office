/**
 * config-loader.ts — Load office.yaml configuration
 *
 * Reads config/office.yaml from the project root and exports
 * key settings needed by the listener daemon subsystems.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface OfficeConfig {
  timezone: string;
  language: string;
  statePath: string;
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

  cached = {
    timezone: office.timezone ?? "Asia/Taipei",
    language: office.language ?? "zh-TW",
    statePath: path.resolve(projectDir, paths.state ?? ".ai-office/state"),
  };

  console.log(`[ConfigLoader] Loaded config: timezone=${cached.timezone}, language=${cached.language}, state=${cached.statePath}`);
  return cached;
}
