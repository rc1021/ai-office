#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import fs from "node:fs";
import { loadStarterPacks, StarterPack } from "./starter-packs.js";
import {
  SetupConfig,
  writeOfficeYaml,
  writeDiscordEnv,
  writeMcpJson,
  createWorkspaceDirs,
  writeActiveRoles,
  writePixelOfficeEnv,
} from "./writers.js";

const rl = readline.createInterface({ input: stdin, output: stdout });

function getProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "CLAUDE.md")) && fs.existsSync(path.join(dir, "config"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

async function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  const answer = await rl.question(`  ${question}${suffix}: `);
  return answer.trim() || defaultVal || "";
}

async function choose(question: string, options: string[], defaultIdx: number = 0): Promise<string> {
  console.log(`  ${question}`);
  options.forEach((opt, i) => {
    const marker = i === defaultIdx ? ">" : " ";
    console.log(`  ${marker} ${i + 1}. ${opt}`);
  });
  const answer = await rl.question(`  Choose [${defaultIdx + 1}]: `);
  const idx = parseInt(answer.trim()) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  return options[defaultIdx];
}

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

async function main(): Promise<void> {
  const projectRoot = getProjectRoot();

  console.log("");
  console.log("  ===================================");
  console.log("    AI Office Setup Wizard");
  console.log("  ===================================");
  console.log("");

  // Check for existing config
  const mcpExists = fs.existsSync(path.join(projectRoot, ".mcp.json"));
  if (mcpExists) {
    const overwrite = await ask("Existing configuration found. Overwrite? (y/N)", "N");
    if (overwrite.toLowerCase() !== "y") {
      console.log("\n  Setup cancelled. Existing config preserved.\n");
      rl.close();
      return;
    }
    console.log("");
  }

  // 1. Office name
  console.log("  -- Office Settings --\n");
  const officeName = await ask("Office name", "My AI Office");

  // 2. Language
  const langChoice = await choose("Primary language:", [
    "zh-TW (Traditional Chinese)",
    "en (English)",
    "ja (Japanese)",
  ], 0);
  const language = langChoice.split(" ")[0];

  // 3. Timezone
  const detectedTz = detectTimezone();
  const timezone = await ask("Timezone", detectedTz);

  // 4. Discord credentials
  console.log("\n  -- Discord Bot --\n");
  console.log("  Create a Discord bot at https://discord.com/developers/applications");
  console.log("  Enable MESSAGE CONTENT intent, then invite the bot to your server.\n");

  const discordToken = await ask("Discord Bot Token");
  if (!discordToken) {
    console.log("\n  [WARN] No token provided. You can set it later in discord-bot/.env\n");
  }

  const guildId = await ask("Discord Guild (Server) ID");
  if (!guildId) {
    console.log("  [WARN] No guild ID provided. You can set it later in discord-bot/.env\n");
  }

  // 5. Starter pack
  console.log("\n  -- Starter Pack --\n");
  const packs = loadStarterPacks(projectRoot);
  const packEntries = Object.entries(packs);
  const packOptions = packEntries.map(([id, p]) => {
    const roles = p.roles.length > 0 ? ` (${p.roles.join(", ")})` : " (Leader only)";
    return `${p.name}${roles} — ${p.description}`;
  });

  const packChoice = await choose("Choose a starter pack:", packOptions, 0);
  const packIdx = packOptions.indexOf(packChoice);
  const [packId, packData] = packEntries[packIdx >= 0 ? packIdx : 0];

  // 6. Remote access (ngrok)
  console.log("\n  -- Remote Access (Pixel Office) --\n");
  const enableNgrok = await ask("Enable remote access via ngrok? (y/N)", "N");
  let ngrokAuthToken = "";
  let pixelAuthUser = "";
  let pixelAuthPass = "";

  if (enableNgrok.toLowerCase() === "y") {
    console.log("\n  Get your auth token at https://dashboard.ngrok.com/get-started/your-authtoken\n");
    ngrokAuthToken = await ask("ngrok auth token");
    pixelAuthUser = await ask("Pixel Office username", "admin");
    pixelAuthPass = await ask("Pixel Office password");
    if (!pixelAuthPass) {
      console.log("  [WARN] No password set. Remote access will be unprotected.\n");
    }
  }

  // 7. Max workers
  console.log("\n  -- Performance --\n");
  const maxWorkersStr = await ask("Max concurrent workers", "3");
  const maxWorkers = parseInt(maxWorkersStr) || 3;

  // Summary
  const config: SetupConfig = {
    officeName,
    language,
    timezone,
    discordToken: discordToken || "YOUR_TOKEN_HERE",
    guildId: guildId || "YOUR_GUILD_ID_HERE",
    maxWorkers,
    starterPack: packId,
    starterRoles: packData.roles,
    ngrokEnabled: enableNgrok.toLowerCase() === "y",
    ngrokAuthToken,
    pixelAuthUser,
    pixelAuthPass,
  };

  console.log("\n  -- Summary --\n");
  console.log(`  Office:       ${config.officeName}`);
  console.log(`  Language:     ${config.language}`);
  console.log(`  Timezone:     ${config.timezone}`);
  console.log(`  Discord:      ${discordToken ? "Token provided" : "Not set (configure later)"}`);
  console.log(`  Guild ID:     ${guildId || "Not set (configure later)"}`);
  console.log(`  Starter Pack: ${packData.name} (${packData.roles.length > 0 ? packData.roles.join(", ") : "Leader only"})`);
  console.log(`  Max Workers:  ${config.maxWorkers}`);
  console.log(`  ngrok:        ${config.ngrokEnabled ? `Enabled (user: ${config.pixelAuthUser})` : "Disabled"}`);

  const confirm = await ask("\nProceed with setup? (Y/n)", "Y");
  if (confirm.toLowerCase() === "n") {
    console.log("\n  Setup cancelled.\n");
    rl.close();
    return;
  }

  // Write files
  console.log("\n  -- Writing configuration --\n");
  writeOfficeYaml(projectRoot, config);
  writeDiscordEnv(projectRoot, config);
  writeMcpJson(projectRoot, config);
  createWorkspaceDirs(projectRoot);
  writeActiveRoles(projectRoot, config);
  writePixelOfficeEnv(projectRoot, config);

  console.log("\n  ===================================");
  console.log("    Setup Complete!");
  console.log("  ===================================\n");
  console.log("  Next steps:\n");
  console.log("  1. Open Claude Code in this directory:");
  console.log(`     cd ${projectRoot} && claude\n`);
  console.log("  2. The Leader agent will initialize automatically.\n");
  console.log("  3. Start the Pixel Office UI (optional):");
  console.log("     cd pixel-office && npm run dev\n");

  rl.close();
}

main().catch((err) => {
  console.error("\n  [ERROR]", err.message);
  rl.close();
  process.exit(1);
});
