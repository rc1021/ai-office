import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { OfficeConfig } from "./types.js";

let cachedConfig: OfficeConfig | null = null;

function getProjectRoot(): string {
  // Walk up from orchestrator/dist/ or orchestrator/src/ to find project root
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "config", "office.yaml"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to cwd
  return process.cwd();
}

export function getOfficeConfig(): OfficeConfig {
  if (cachedConfig) return cachedConfig;

  const root = getProjectRoot();
  const configPath = path.join(root, "config", "office.yaml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Office config not found: ${configPath}`);
  }

  const content = fs.readFileSync(configPath, "utf-8");
  cachedConfig = yaml.load(content) as OfficeConfig;

  console.log(`[ConfigReader] Loaded office config: "${cachedConfig.office.name}"`);
  return cachedConfig;
}

/**
 * Resolve a relative path from config to absolute path.
 */
export function resolvePath(relativePath: string): string {
  const root = getProjectRoot();
  return path.resolve(root, relativePath);
}

/**
 * Get the workspace state directory (creates if needed).
 */
export function getStateDir(): string {
  const config = getOfficeConfig();
  const stateDir = resolvePath(config.paths.state);
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

export function getProjectRootPath(): string {
  return getProjectRoot();
}
