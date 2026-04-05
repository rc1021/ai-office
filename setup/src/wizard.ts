#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import fs from "node:fs";
import { loadStarterPacks, localize, StarterPack } from "./starter-packs.js";
import {
  SetupConfig,
  writeOfficeYaml,
  writeDiscordEnv,
  writeMcpJson,
  createWorkspaceDirs,
  writeActiveRoles,
  writePixelOfficeEnv,
} from "./writers.js";

// ─── i18n ────────────────────────────────────────────────────────────────────

type Lang = "zh-TW" | "en" | "ja";

const i18n: Record<string, Record<Lang, string>> = {
  "section.discord":    { "zh-TW": "-- Discord Bot 設定 --",      en: "-- Discord Bot Setup --",       ja: "-- Discord Bot 設定 --" },
  "section.starter":    { "zh-TW": "-- 入門組合包 --",             en: "-- Starter Pack --",            ja: "-- スターターパック --" },
  "section.ngrok":      { "zh-TW": "-- 遠端存取（Pixel Office）--", en: "-- Remote Access (Pixel Office) --", ja: "-- リモートアクセス（Pixel Office）--" },
  "section.perf":       { "zh-TW": "-- 效能 --",                   en: "-- Performance --",             ja: "-- パフォーマンス --" },
  "section.summary":    { "zh-TW": "-- 摘要 --",                   en: "-- Summary --",                 ja: "-- サマリー --" },
  "section.writing":    { "zh-TW": "-- 寫入設定 --",                en: "-- Writing configuration --",   ja: "-- 設定書き込み --" },

  "discord.step1":      { "zh-TW": "1. 打開 Discord Developer Portal：",              en: "1. Open the Discord Developer Portal:",              ja: "1. Discord Developer Portal を開く：" },
  "discord.step2":      { "zh-TW": "2. 點「New Application」建立應用 → 進入「Bot」頁籤", en: "2. Click 'New Application' → go to the 'Bot' tab",    ja: "2.「New Application」→「Bot」タブへ" },
  "discord.step3":      { "zh-TW": "3. 開啟「MESSAGE CONTENT INTENT」開關",             en: "3. Enable 'MESSAGE CONTENT INTENT' toggle",           ja: "3.「MESSAGE CONTENT INTENT」を有効にする" },
  "discord.step4":      { "zh-TW": "4. 點「Reset Token」複製 Bot Token",                en: "4. Click 'Reset Token' and copy the Bot Token",       ja: "4.「Reset Token」→ トークンをコピー" },
  "discord.step5":      { "zh-TW": "5. 進入「OAuth2 > URL Generator」，勾選 bot + Administrator，產生邀請連結",
                          en: "5. Go to 'OAuth2 > URL Generator', select 'bot' + 'Administrator', generate invite URL",
                          ja: "5.「OAuth2 > URL Generator」→ bot + Administrator を選択 → 招待URLを生成" },
  "discord.step6":      { "zh-TW": "6. 用邀請連結把 Bot 加入你的 Discord Server",        en: "6. Use the invite URL to add the Bot to your server", ja: "6. 招待URLでBotをサーバーに追加" },
  "discord.guild_hint": { "zh-TW": "（在 Discord 設定中開啟「開發者模式」，右鍵 Server 名稱 → 複製 Server ID）",
                          en: "(Enable 'Developer Mode' in Discord settings, right-click server name → Copy Server ID)",
                          ja: "（Discord設定で「開発者モード」→ サーバー名を右クリック → IDをコピー）" },

  "prompt.token":       { "zh-TW": "Discord Bot Token",       en: "Discord Bot Token",        ja: "Discord Bot Token" },
  "prompt.guild":       { "zh-TW": "Discord Server ID",       en: "Discord Guild (Server) ID", ja: "Discord Server ID" },
  "prompt.starter":     { "zh-TW": "選擇入門組合包：",         en: "Choose a starter pack:",    ja: "スターターパックを選択：" },
  "prompt.ngrok_enable":{ "zh-TW": "啟用 ngrok 遠端存取？(y/N)", en: "Enable remote access via ngrok? (y/N)", ja: "ngrokリモートアクセスを有効にしますか？(y/N)" },
  "prompt.ngrok_token": { "zh-TW": "ngrok auth token",        en: "ngrok auth token",          ja: "ngrok auth token" },
  "prompt.pixel_user":  { "zh-TW": "Pixel Office 帳號",       en: "Pixel Office username",     ja: "Pixel Office ユーザー名" },
  "prompt.pixel_pass":  { "zh-TW": "Pixel Office 密碼",       en: "Pixel Office password",     ja: "Pixel Office パスワード" },
  "prompt.max_workers": { "zh-TW": "最大同時運行 Worker 數",   en: "Max concurrent workers",    ja: "最大同時ワーカー数" },
  "prompt.proceed":     { "zh-TW": "確認開始安裝？(Y/n)",      en: "Proceed with setup? (Y/n)", ja: "セットアップを開始しますか？(Y/n)" },

  "hint.ngrok_auth":    { "zh-TW": "這組帳密用來保護你的 Pixel Office 儀表板，\n  當別人透過公開 URL 訪問時需要輸入。",
                          en: "These credentials protect your Pixel Office dashboard.\n  Anyone accessing the public URL will need to enter them.",
                          ja: "この認証情報はPixel Officeダッシュボードを保護します。\n  公開URLにアクセスする際に入力が必要です。" },
  "hint.ngrok_get":     { "zh-TW": "取得 auth token：",       en: "Get your auth token at:",    ja: "auth tokenの取得：" },

  "warn.no_token":      { "zh-TW": "[提示] 未提供 Token，稍後可在 discord-bot/.env 設定", en: "[INFO] No token provided. Set it later in discord-bot/.env", ja: "[情報] トークン未入力。後で discord-bot/.env に設定できます" },
  "warn.no_guild":      { "zh-TW": "[提示] 未提供 Server ID，稍後可在 discord-bot/.env 設定", en: "[INFO] No guild ID provided. Set it later in discord-bot/.env", ja: "[情報] サーバーID未入力。後で設定できます" },
  "warn.no_pass":       { "zh-TW": "[提示] 未設定密碼，遠端存取將無保護", en: "[WARN] No password set. Remote access will be unprotected.", ja: "[警告] パスワード未設定。リモートアクセスは保護されません" },

  "sum.office":         { "zh-TW": "辦公室",    en: "Office",       ja: "オフィス" },
  "sum.language":       { "zh-TW": "語言",      en: "Language",     ja: "言語" },
  "sum.timezone":       { "zh-TW": "時區",      en: "Timezone",     ja: "タイムゾーン" },
  "sum.discord":        { "zh-TW": "Discord",   en: "Discord",      ja: "Discord" },
  "sum.guild":          { "zh-TW": "Server ID",  en: "Guild ID",    ja: "サーバーID" },
  "sum.starter":        { "zh-TW": "組合包",    en: "Starter Pack", ja: "パック" },
  "sum.workers":        { "zh-TW": "Worker 上限", en: "Max Workers", ja: "最大ワーカー" },
  "sum.ngrok":          { "zh-TW": "ngrok",     en: "ngrok",        ja: "ngrok" },
  "sum.token_ok":       { "zh-TW": "已提供 Token", en: "Token provided", ja: "トークン設定済み" },
  "sum.token_later":    { "zh-TW": "稍後設定",   en: "Not set (configure later)", ja: "後で設定" },
  "sum.enabled":        { "zh-TW": "已啟用",     en: "Enabled",      ja: "有効" },
  "sum.disabled":       { "zh-TW": "未啟用",     en: "Disabled",     ja: "無効" },
};

let currentLang: Lang = "zh-TW";

function t(key: string): string {
  return i18n[key]?.[currentLang] ?? i18n[key]?.["en"] ?? key;
}

// ─── Readline Helpers ────────────────────────────────────────────────────────

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

// ─── Main ────────────────────────────────────────────────────────────────────

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

  // 2. Language (always in English — user hasn't chosen yet)
  const langChoice = await choose("Primary language:", [
    "zh-TW (Traditional Chinese)",
    "en (English)",
    "ja (Japanese)",
  ], 0);
  const language = langChoice.split(" ")[0] as Lang;
  currentLang = language;

  // 3. Timezone
  const detectedTz = detectTimezone();
  const timezone = await ask("Timezone", detectedTz);

  // 4. Discord credentials — detailed step-by-step guide
  console.log(`\n  ${t("section.discord")}\n`);
  console.log(`  ${t("discord.step1")}`);
  console.log("     https://discord.com/developers/applications\n");
  console.log(`  ${t("discord.step2")}`);
  console.log(`  ${t("discord.step3")}`);
  console.log(`  ${t("discord.step4")}`);
  console.log(`  ${t("discord.step5")}`);
  console.log(`  ${t("discord.step6")}`);
  console.log("");

  const discordToken = await ask(t("prompt.token"));
  if (!discordToken) {
    console.log(`\n  ${t("warn.no_token")}\n`);
  }

  console.log(`\n  ${t("discord.guild_hint")}\n`);
  const guildId = await ask(t("prompt.guild"));
  if (!guildId) {
    console.log(`  ${t("warn.no_guild")}\n`);
  }

  // 5. Starter pack
  console.log(`\n  ${t("section.starter")}\n`);
  const packs = loadStarterPacks(projectRoot);
  const packEntries = Object.entries(packs);
  const packOptions = packEntries.map(([id, p]) => {
    const name = localize(p.name, currentLang);
    const desc = localize(p.description, currentLang);
    const roles = p.roles.length > 0 ? ` (${p.roles.join(", ")})` : "";
    return `${name}${roles} — ${desc}`;
  });

  const packChoice = await choose(t("prompt.starter"), packOptions, 0);
  const packIdx = packOptions.indexOf(packChoice);
  const [packId, packData] = packEntries[packIdx >= 0 ? packIdx : 0];

  // 6. Remote access (ngrok)
  console.log(`\n  ${t("section.ngrok")}\n`);
  const enableNgrok = await ask(t("prompt.ngrok_enable"), "N");
  let ngrokAuthToken = "";
  let pixelAuthUser = "";
  let pixelAuthPass = "";

  if (enableNgrok.toLowerCase() === "y") {
    console.log(`\n  ${t("hint.ngrok_get")}`);
    console.log("     https://dashboard.ngrok.com/get-started/your-authtoken\n");
    ngrokAuthToken = await ask(t("prompt.ngrok_token"));

    console.log(`\n  ${t("hint.ngrok_auth")}\n`);
    pixelAuthUser = await ask(t("prompt.pixel_user"), "admin");
    pixelAuthPass = await ask(t("prompt.pixel_pass"));
    if (!pixelAuthPass) {
      console.log(`  ${t("warn.no_pass")}\n`);
    }
  }

  // 7. Max workers
  console.log(`\n  ${t("section.perf")}\n`);
  const maxWorkersStr = await ask(t("prompt.max_workers"), "3");
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

  console.log(`\n  ${t("section.summary")}\n`);
  console.log(`  ${t("sum.office")}:       ${config.officeName}`);
  console.log(`  ${t("sum.language")}:     ${config.language}`);
  console.log(`  ${t("sum.timezone")}:     ${config.timezone}`);
  console.log(`  ${t("sum.discord")}:      ${discordToken ? t("sum.token_ok") : t("sum.token_later")}`);
  console.log(`  ${t("sum.guild")}:        ${guildId || t("sum.token_later")}`);
  console.log(`  ${t("sum.starter")}:      ${localize(packData.name, currentLang)} (${packData.roles.length > 0 ? packData.roles.join(", ") : "Leader only"})`);
  console.log(`  ${t("sum.workers")}:      ${config.maxWorkers}`);
  console.log(`  ${t("sum.ngrok")}:        ${config.ngrokEnabled ? `${t("sum.enabled")} (user: ${config.pixelAuthUser})` : t("sum.disabled")}`);

  const confirm = await ask(`\n${t("prompt.proceed")}`, "Y");
  if (confirm.toLowerCase() === "n") {
    console.log("\n  Setup cancelled.\n");
    rl.close();
    return;
  }

  // Write files
  console.log(`\n  ${t("section.writing")}\n`);
  writeOfficeYaml(projectRoot, config);
  writeDiscordEnv(projectRoot, config);
  writeMcpJson(projectRoot, config);
  createWorkspaceDirs(projectRoot);
  writeActiveRoles(projectRoot, config);
  writePixelOfficeEnv(projectRoot, config);

  console.log("\n  ===================================");
  console.log("    Setup Complete!");
  console.log("  ===================================\n");

  rl.close();
}

main().catch((err) => {
  console.error("\n  [ERROR]", err.message);
  process.exit(1);
});
