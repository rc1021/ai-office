import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface StarterPack {
  name: string | Record<string, string>;
  description: string | Record<string, string>;
  roles: string[];
}

/** Resolve a localized string — supports both plain string and {en, zh-TW, ja} object */
export function localize(value: string | Record<string, string>, lang: string): string {
  if (typeof value === "string") return value;
  return value[lang] ?? value["en"] ?? Object.values(value)[0] ?? "";
}

export function loadStarterPacks(projectRoot: string): Record<string, StarterPack> {
  const filePath = path.join(projectRoot, "config", "starter-packs.yaml");
  if (!fs.existsSync(filePath)) {
    return { "solo-creator": { name: "Solo Creator", description: "Just the Leader", roles: [] } };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = yaml.load(content) as { starter_packs: Record<string, StarterPack> };
  return parsed.starter_packs;
}
