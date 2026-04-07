import fs from "node:fs";
import path from "node:path";

export interface SetupConfig {
  officeName: string;
  language: string;
  timezone: string;
  discordToken: string;
  guildId: string;
  maxWorkers: number;
  starterPack: string;
  starterRoles: string[];
  ngrokMode?: "internal" | "external" | "custom" | "disabled";
  ngrokEnabled?: boolean;
  ngrokAuthToken?: string;
  pixelAuthUser?: string;
  pixelAuthPass?: string;
  pixelPublicUrl?: string;
}

/**
 * Write config/office.yaml with user values (preserving comments via string replace).
 */
export function writeOfficeYaml(projectRoot: string, config: SetupConfig): void {
  const filePath = path.join(projectRoot, "config", "office.yaml");
  const examplePath = path.join(projectRoot, "config", "office.yaml.example");

  // If office.yaml doesn't exist (fresh clone), copy from .example
  if (!fs.existsSync(filePath) && fs.existsSync(examplePath)) {
    fs.copyFileSync(examplePath, filePath);
  }

  let content = fs.readFileSync(filePath, "utf-8");

  content = content.replace(
    /name: ".*"/,
    `name: "${config.officeName}"`
  );
  content = content.replace(
    /language: ".*"/,
    `language: "${config.language}"`
  );
  content = content.replace(
    /timezone: ".*"/,
    `timezone: "${config.timezone}"`
  );
  content = content.replace(
    /max_concurrent: \d+/,
    `max_concurrent: ${config.maxWorkers}`
  );

  fs.writeFileSync(filePath, content, "utf-8");
  console.log("  [OK] config/office.yaml");
}

/**
 * Write discord-bot/.env with bot credentials.
 */
export function writeDiscordEnv(projectRoot: string, config: SetupConfig): void {
  const envPath = path.join(projectRoot, "discord-bot", ".env");
  const content = `DISCORD_BOT_TOKEN=${config.discordToken}\nDISCORD_GUILD_ID=${config.guildId}\n`;
  fs.writeFileSync(envPath, content, "utf-8");
  console.log("  [OK] discord-bot/.env");
}

/**
 * Write .mcp.json with correct node path and credentials.
 */
export function writeMcpJson(projectRoot: string, config: SetupConfig): void {
  const nodePath = process.execPath;
  const absRoot = path.resolve(projectRoot);
  const mcpConfig = {
    mcpServers: {
      "ai-office-discord": {
        command: nodePath,
        args: [path.join(absRoot, "discord-bot", "dist", "index.js")],
        env: {
          DISCORD_BOT_TOKEN: config.discordToken,
          DISCORD_GUILD_ID: config.guildId,
        },
      },
      "ai-office-coordination": {
        command: nodePath,
        args: [path.join(absRoot, "coordination", "dist", "index.js")],
        env: {
          AI_OFFICE_WORKSPACE: path.join(absRoot, ".ai-office"),
          AI_OFFICE_ROOT: absRoot,
        },
      },
    },
  };

  const mcpPath = path.join(projectRoot, ".mcp.json");
  fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n", "utf-8");
  console.log("  [OK] .mcp.json");
}

/**
 * Create the .ai-office directory structure.
 */
export function createWorkspaceDirs(projectRoot: string): void {
  const base = path.join(projectRoot, ".ai-office");

  // Top-level dirs (kept from original)
  const topLevelDirs = ["state", "events", "logs", "questions", "answers", "brainstorm"];

  // Shared workspace dirs
  const sharedDirs = [
    "shared/inbox",
    "shared/public/briefs",
    "shared/public/announcements",
    "shared/cross-dept",
  ];

  // Department list matches the `department` enum in role-template.schema.json
  const departments = [
    "management", "engineering", "finance", "marketing",
    "hr", "legal", "research", "design",
    "operations", "sales", "support", "audit",
  ];
  const deptSubdirs = ["workspace", "artifacts", "memory", "outbox"];
  const deptDirs = departments.flatMap((dept) =>
    deptSubdirs.map((sub) => `departments/${dept}/${sub}`)
  );

  const allDirs = [...topLevelDirs, ...sharedDirs, ...deptDirs];

  for (const dir of allDirs) {
    fs.mkdirSync(path.join(base, dir), { recursive: true });
  }

  // Remove onboarded flag so the Leader runs the Welcome Flow on next launch
  const onboardedFlag = path.join(base, "state", ".onboarded");
  if (fs.existsSync(onboardedFlag)) {
    fs.unlinkSync(onboardedFlag);
  }

  console.log("  [OK] .ai-office/ directories");
}

/**
 * Write config/active-roles.yaml with selected starter pack roles.
 */
export function writeActiveRoles(projectRoot: string, config: SetupConfig): void {
  const lines = [
    "# Active roles for this AI Office instance",
    `# Starter pack: ${config.starterPack}`,
    "# Leader is always active (default role)",
    "",
    "active_roles:",
    "  - leader",
  ];

  for (const role of config.starterRoles) {
    lines.push(`  - ${role}`);
  }

  const filePath = path.join(projectRoot, "config", "active-roles.yaml");
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  console.log("  [OK] config/active-roles.yaml");
}

/**
 * Write pixel-office/.env with ngrok mode and auth settings.
 */
export function writePixelOfficeEnv(projectRoot: string, config: SetupConfig): void {
  const mode = config.ngrokMode ?? (config.ngrokEnabled ? "internal" : "disabled");
  if (mode === "disabled") return;

  const envPath = path.join(projectRoot, "pixel-office", ".env");
  const lines = [
    `NGROK_MODE=${mode}`,
  ];

  if (mode === "internal") {
    lines.push(`NGROK_AUTHTOKEN=${config.ngrokAuthToken ?? ""}`);
    lines.push(`PIXEL_AUTH_USER=${config.pixelAuthUser ?? "admin"}`);
    lines.push(`PIXEL_AUTH_PASS=${config.pixelAuthPass ?? ""}`);
  }

  if ((mode === "external" || mode === "custom") && config.pixelPublicUrl) {
    lines.push(`PIXEL_PUBLIC_URL=${config.pixelPublicUrl}`);
  }

  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  console.log(`  [OK] pixel-office/.env (${mode})`);
}
