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
  ngrokEnabled?: boolean;
  ngrokAuthToken?: string;
  pixelAuthUser?: string;
  pixelAuthPass?: string;
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
  const mcpConfig = {
    mcpServers: {
      "ai-office-discord": {
        command: nodePath,
        args: ["./discord-bot/dist/index.js"],
        env: {
          DISCORD_BOT_TOKEN: config.discordToken,
          DISCORD_GUILD_ID: config.guildId,
        },
      },
      "ai-office-coordination": {
        command: nodePath,
        args: ["./coordination/dist/index.js"],
        env: {
          AI_OFFICE_WORKSPACE: "~/.ai-office",
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
  const dirs = ["state", "artifacts", "events", "logs", "memory"];
  const base = path.join(projectRoot, ".ai-office");

  for (const dir of dirs) {
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
 * Write pixel-office/.env with ngrok and auth settings.
 */
export function writePixelOfficeEnv(projectRoot: string, config: SetupConfig): void {
  if (!config.ngrokEnabled) return;

  const envPath = path.join(projectRoot, "pixel-office", ".env");
  const lines = [
    `NGROK_ENABLED=true`,
    `NGROK_AUTHTOKEN=${config.ngrokAuthToken ?? ""}`,
    `PIXEL_AUTH_USER=${config.pixelAuthUser ?? "admin"}`,
    `PIXEL_AUTH_PASS=${config.pixelAuthPass ?? ""}`,
  ];
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf-8");
  console.log("  [OK] pixel-office/.env (ngrok)");
}
