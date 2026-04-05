import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export interface StarterPack {
  name: string;
  description: string;
  roles: string[];
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
