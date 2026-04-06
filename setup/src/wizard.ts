#!/usr/bin/env node

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import fs from "node:fs";
import { loadStarterPacks, loadAdvancedPacks, localize, StarterPack, AdvancedIndustry, AdvancedTeam } from "./starter-packs.js";
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
  "prompt.ngrok_mode":  { "zh-TW": "選擇遠端存取方式：",       en: "Choose remote access mode:",   ja: "リモートアクセス方式を選択：" },
  "ngrok.mode_internal":{ "zh-TW": "內建 ngrok (AI Office 自動啟動 tunnel)", en: "Built-in ngrok (AI Office starts tunnel automatically)", ja: "内蔵 ngrok (AI Officeが自動でトンネルを起動)" },
  "ngrok.mode_external":{ "zh-TW": "外部 ngrok (你自己管理 ngrok，填入 URL)", en: "External ngrok (you manage ngrok, enter URL)", ja: "外部 ngrok (自分でngrokを管理、URLを入力)" },
  "ngrok.mode_custom":  { "zh-TW": "自訂 URL (自有 domain / Cloudflare / reverse proxy)", en: "Custom URL (own domain / Cloudflare / reverse proxy)", ja: "カスタムURL (独自ドメイン / Cloudflare / リバースプロキシ)" },
  "ngrok.mode_disabled":{ "zh-TW": "不啟用 (僅 localhost)",   en: "Disabled (localhost only)",     ja: "無効 (localhostのみ)" },
  "prompt.public_url":  { "zh-TW": "Public URL",              en: "Public URL",                   ja: "パブリックURL" },
  "hint.external_ngrok": { "zh-TW": "請在 ngrok 設定中將 tunnel 指向 http://localhost:3847\n     Pixel Office 啟動後會自動從 ngrok API (localhost:4040) 偵測 tunnel URL",
                          en: "Point your ngrok tunnel to http://localhost:3847\n     Pixel Office will auto-detect the tunnel URL from ngrok API (localhost:4040)",
                          ja: "ngrok設定でトンネルを http://localhost:3847 に向けてください\n     Pixel Officeが起動後、ngrok API (localhost:4040) からトンネルURLを自動検出します" },
  "warn.no_url":        { "zh-TW": "未提供 URL，稍後可在 pixel-office/.env 設定", en: "No URL provided. Configure later in pixel-office/.env", ja: "URLが入力されていません。後でpixel-office/.envで設定できます" },
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
  "discord.checking":   { "zh-TW": "正在驗證 Discord Bot 連線...", en: "Verifying Discord Bot connection...", ja: "Discord Bot接続を確認中..." },
  "discord.ok":         { "zh-TW": "✅ Bot 已連線到伺服器", en: "✅ Bot connected to server", ja: "✅ Botがサーバーに接続済み" },
  "discord.bad_token":  { "zh-TW": "❌ Token 無效，請確認後重新輸入", en: "❌ Invalid token. Please check and re-enter", ja: "❌ トークンが無効です。確認して再入力してください" },
  "discord.no_guild":   { "zh-TW": "❌ Bot 不在此伺服器中（Server ID 錯誤，或尚未邀請 Bot）", en: "❌ Bot is not in this server (wrong Guild ID or bot not invited)", ja: "❌ Botがこのサーバーにいません（サーバーIDが間違いか、Bot未招待）" },
  "discord.net_error":  { "zh-TW": "⚠️  無法連線 Discord API（網路問題？）", en: "⚠️  Cannot reach Discord API (network issue?)", ja: "⚠️  Discord APIに接続できません（ネットワーク問題？）" },
  "sum.enabled":        { "zh-TW": "已啟用",     en: "Enabled",      ja: "有効" },
  "sum.disabled":       { "zh-TW": "未啟用",     en: "Disabled",     ja: "無効" },

  "prompt.pack_mode":   { "zh-TW": "選擇組合包模式：",   en: "Choose pack mode:",           ja: "パックモードを選択：" },
  "mode.basic":         { "zh-TW": "入門組合包 (Basic) — 快速選擇常見配置",
                          en: "Basic Packs — Quick selection of common configurations",
                          ja: "ベーシックパック — よくある構成をすばやく選択" },
  "mode.advanced":      { "zh-TW": "進階組合包 (Advanced) — 按行業選擇專業團隊",
                          en: "Advanced Packs — Choose specialized teams by industry",
                          ja: "アドバンスドパック — 業界別に専門チームを選択" },
  "prompt.industry":    { "zh-TW": "選擇行業：",         en: "Choose an industry:",         ja: "業界を選択：" },
  "prompt.team":        { "zh-TW": "選擇團隊類型：",      en: "Choose a team type:",         ja: "チームタイプを選択：" },
  "back":               { "zh-TW": "[B] 返回上一步",     en: "[B] Go back",                 ja: "[B] 前に戻る" },
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

const BACK = "__BACK__";

async function chooseWithBack(question: string, options: string[], defaultIdx: number = 0): Promise<string> {
  console.log(`  ${question}`);
  options.forEach((opt, i) => {
    const marker = i === defaultIdx ? ">" : " ";
    console.log(`  ${marker} ${i + 1}. ${opt}`);
  });
  console.log(`    ${t("back")}`);
  const answer = await rl.question(`  Choose [${defaultIdx + 1}]: `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "b") return BACK;
  const idx = parseInt(trimmed) - 1;
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

// ─── Discord Validation ─────────────────────────────────────────────────────

/**
 * Verify the Discord bot token is valid and the bot is in the specified guild.
 * Uses the Discord REST API directly (no discord.js dependency needed).
 */
async function validateDiscord(token: string, guildId: string): Promise<boolean> {
  if (!token || !guildId) return true; // Skip validation if either is empty (user will set later)

  console.log(`\n  ${t("discord.checking")}`);

  try {
    // 1. Verify token by fetching bot user info
    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!userRes.ok) {
      console.log(`  ${t("discord.bad_token")}\n`);
      return false;
    }
    const botUser = await userRes.json() as { username: string };

    // 2. Verify bot is in the specified guild
    const guildRes = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!guildRes.ok) {
      console.log(`  ${t("discord.no_guild")}\n`);
      return false;
    }
    const guild = await guildRes.json() as { name: string };

    console.log(`  ${t("discord.ok")}: ${botUser.username} → ${guild.name}\n`);
    return true;
  } catch {
    console.log(`  ${t("discord.net_error")}\n`);
    return true; // Don't block setup on network issues
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
      process.exit(2);
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

  let discordToken = await ask(t("prompt.token"));
  if (!discordToken) {
    console.log(`\n  ${t("warn.no_token")}\n`);
  }

  console.log(`\n  ${t("discord.guild_hint")}\n`);
  let guildId = await ask(t("prompt.guild"));
  if (!guildId) {
    console.log(`  ${t("warn.no_guild")}\n`);
  }

  // Validate Discord connection
  while (discordToken && guildId) {
    const valid = await validateDiscord(discordToken, guildId);
    if (valid) break;
    const retry = await ask("Retry? (y/N)", "N");
    if (retry.toLowerCase() !== "y") break;
    discordToken = await ask(t("prompt.token"), discordToken);
    console.log(`\n  ${t("discord.guild_hint")}\n`);
    guildId = await ask(t("prompt.guild"), guildId);
  }

  // 5. Starter pack (Basic or Advanced)
  console.log(`\n  ${t("section.starter")}\n`);
  const packs = loadStarterPacks(projectRoot);
  const advancedPacks = loadAdvancedPacks(projectRoot);

  let packId = "";
  let selectedRoles: string[] = [];
  let selectedPackName: string | Record<string, string> = "";
  let done = false;

  while (!done) {
    // Step 1: Mode selection
    const modeOptions = [t("mode.basic"), t("mode.advanced")];
    const modeChoice = await choose(t("prompt.pack_mode"), modeOptions, 0);
    const isAdvanced = modeChoice === modeOptions[1];

    if (!isAdvanced) {
      // Basic mode — flat pack list with back support
      const packEntries = Object.entries(packs);
      const packOptions = packEntries.map(([_id, p]) => {
        const name = localize(p.name, currentLang);
        const desc = localize(p.description, currentLang);
        const roles = p.roles.length > 0 ? ` (${p.roles.join(", ")})` : "";
        return `${name}${roles} — ${desc}`;
      });

      const packChoice = await chooseWithBack(t("prompt.starter"), packOptions, 0);
      if (packChoice === BACK) continue; // back to mode selection

      const packIdx = packOptions.indexOf(packChoice);
      const [id, data] = packEntries[packIdx >= 0 ? packIdx : 0];
      packId = id;
      selectedRoles = data.roles;
      selectedPackName = data.name;
      done = true;
    } else {
      // Advanced mode — Industry → Team
      const industryEntries = Object.entries(advancedPacks);
      const industryOptions = industryEntries.map(([_id, ind]) => localize(ind.name, currentLang));

      let industryDone = false;
      while (!industryDone) {
        const industryChoice = await chooseWithBack(t("prompt.industry"), industryOptions, 0);
        if (industryChoice === BACK) {
          industryDone = true; // back to mode selection
          break;
        }

        const industryIdx = industryOptions.indexOf(industryChoice);
        const [industryId, industry] = industryEntries[industryIdx >= 0 ? industryIdx : 0];
        const teamEntries = Object.entries(industry.teams);
        const teamOptions = teamEntries.map(([_id, team]) => {
          const name = localize(team.name, currentLang);
          const desc = localize(team.description, currentLang);
          return `${name} — ${desc}`;
        });

        const teamChoice = await chooseWithBack(t("prompt.team"), teamOptions, 0);
        if (teamChoice === BACK) continue; // back to industry selection

        const teamIdx = teamOptions.indexOf(teamChoice);
        const [teamId, teamData] = teamEntries[teamIdx >= 0 ? teamIdx : 0];
        packId = `${industryId}/${teamId}`;
        selectedRoles = teamData.roles;
        selectedPackName = teamData.name;
        done = true;
        industryDone = true;
      }
    }
  }

  // Build a packData-compatible object for the rest of the wizard
  const packData: StarterPack = {
    name: selectedPackName,
    description: "",
    roles: selectedRoles,
  };

  // 6. Remote access mode
  console.log(`\n  ${t("section.ngrok")}\n`);

  const ngrokModeOptions = [
    t("ngrok.mode_internal"),
    t("ngrok.mode_external"),
    t("ngrok.mode_custom"),
    t("ngrok.mode_disabled"),
  ];
  const ngrokModeChoice = await choose(t("prompt.ngrok_mode"), ngrokModeOptions, 3); // default: disabled
  const ngrokModeIdx = ngrokModeOptions.indexOf(ngrokModeChoice);
  const ngrokMode = (["internal", "external", "custom", "disabled"] as const)[ngrokModeIdx >= 0 ? ngrokModeIdx : 3];

  let ngrokAuthToken = "";
  let pixelAuthUser = "";
  let pixelAuthPass = "";
  let pixelPublicUrl = "";

  if (ngrokMode === "internal") {
    console.log(`\n  ${t("hint.ngrok_get")}`);
    console.log("     https://dashboard.ngrok.com/get-started/your-authtoken\n");
    ngrokAuthToken = await ask(t("prompt.ngrok_token"));

    console.log(`\n  ${t("hint.ngrok_auth")}\n`);
    pixelAuthUser = await ask(t("prompt.pixel_user"), "admin");
    while (true) {
      pixelAuthPass = await ask(t("prompt.pixel_pass"));
      if (!pixelAuthPass) {
        console.log(`  ${t("warn.no_pass")}\n`);
        break;
      } else if (pixelAuthPass.length < 8) {
        console.log(`  [!] ngrok requires at least 8 characters. Please try again.\n`);
      } else {
        break;
      }
    }
  } else if (ngrokMode === "external") {
    console.log(`  ${t("hint.external_ngrok")}\n`);
  } else if (ngrokMode === "custom") {
    pixelPublicUrl = await ask(t("prompt.public_url"));
    if (!pixelPublicUrl) {
      console.log(`  ${t("warn.no_url")}\n`);
    }
  }
  // disabled: nothing to ask

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
    ngrokMode,
    ngrokEnabled: ngrokMode === "internal",
    ngrokAuthToken,
    pixelAuthUser,
    pixelAuthPass,
    pixelPublicUrl,
  };

  console.log(`\n  ${t("section.summary")}\n`);
  console.log(`  ${t("sum.office")}:       ${config.officeName}`);
  console.log(`  ${t("sum.language")}:     ${config.language}`);
  console.log(`  ${t("sum.timezone")}:     ${config.timezone}`);
  console.log(`  ${t("sum.discord")}:      ${discordToken ? t("sum.token_ok") : t("sum.token_later")}`);
  console.log(`  ${t("sum.guild")}:        ${guildId || t("sum.token_later")}`);
  console.log(`  ${t("sum.starter")}:      ${localize(packData.name, currentLang)} (${packData.roles.length > 0 ? packData.roles.join(", ") : "Leader only"})`);
  console.log(`  ${t("sum.workers")}:      ${config.maxWorkers}`);
  const ngrokSummary = config.ngrokMode === "internal"
    ? `internal (user: ${config.pixelAuthUser})`
    : config.ngrokMode === "external" || config.ngrokMode === "custom"
      ? `${config.ngrokMode} (${config.pixelPublicUrl || "URL not set"})`
      : t("sum.disabled");
  console.log(`  ${t("sum.ngrok")}:        ${ngrokSummary}`);

  const confirm = await ask(`\n${t("prompt.proceed")}`, "Y");
  if (confirm.toLowerCase() === "n") {
    console.log("\n  Setup cancelled.\n");
    rl.close();
    process.exit(2);
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
