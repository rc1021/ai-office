import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface StarterPack {
  name: string | Record<string, string>;
  description: string | Record<string, string>;
  roles: string[];
}

export interface AdvancedTeam {
  name: string | Record<string, string>;
  description: string | Record<string, string>;
  roles: string[];
}

export interface AdvancedIndustry {
  name: string | Record<string, string>;
  teams: Record<string, AdvancedTeam>;
}

/** Resolve a localized string — supports both plain string and {en, zh-TW, ja} object */
export function localize(value: string | Record<string, string>, lang: string): string {
  if (typeof value === "string") return value;
  return value[lang] ?? value["en"] ?? Object.values(value)[0] ?? "";
}

function loadYamlFile(projectRoot: string): Record<string, unknown> {
  const filePath = path.join(projectRoot, "config", "starter-packs.yaml");
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf-8");
  return yaml.load(content) as Record<string, unknown>;
}

export function loadStarterPacks(projectRoot: string): Record<string, StarterPack> {
  const parsed = loadYamlFile(projectRoot);
  if (parsed.starter_packs) {
    return parsed.starter_packs as Record<string, StarterPack>;
  }
  return { "solo-creator": { name: "Solo Creator", description: "Just the Leader", roles: [] } };
}

export function loadAdvancedPacks(projectRoot: string): Record<string, AdvancedIndustry> {
  const parsed = loadYamlFile(projectRoot);
  if (parsed.advanced_packs) {
    return parsed.advanced_packs as Record<string, AdvancedIndustry>;
  }
  return {};
}
