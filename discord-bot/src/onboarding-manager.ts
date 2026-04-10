/**
 * onboarding-manager.ts — Interactive Onboarding Flow
 *
 * Manages the 6-step Discord-based onboarding experience:
 *   Step 1–3: #general — Welcome → Company description → Role suggestions
 *   Step 4–6: #hr      — Job board (shopping cart) → Role details → Team ready
 *
 * Button interaction prefix: "onboarding:"
 * Uses deferUpdate() (updates original message in-place, no new reply).
 *
 * State persisted in: .ai-office/state/onboarding-state.yaml
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  Client,
  Message,
  TextChannel,
  MessageEditOptions,
} from "discord.js";
import path from "node:path";
import fs from "node:fs";
import yaml from "js-yaml";
import { fileURLToPath } from "node:url";
import { getDiscordClient } from "./discord-client.js";
import { findTextChannel } from "./channel-manager.js";

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const DIST_DIR = path.dirname(__filename);
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");
const PROJECT_DIR = path.resolve(DISCORD_BOT_DIR, "..");

const STATE_PATH = path.join(PROJECT_DIR, ".ai-office", "state", "onboarding-state.yaml");
const COMPANY_PROFILE_PATH = path.join(PROJECT_DIR, ".ai-office", "state", "company-profile.yaml");
const ACTIVE_ROLES_PATH = path.join(PROJECT_DIR, "config", "active-roles.yaml");
const ROLE_INDEX_PATH = path.join(PROJECT_DIR, "roles", "role-index.yaml");
const STARTER_PACKS_PATH = path.join(PROJECT_DIR, "config", "starter-packs.yaml");
const ONBOARDED_FLAG = path.join(PROJECT_DIR, ".ai-office", "state", ".onboarded");

// ── Types ─────────────────────────────────────────────────────────────────────

type OnboardingStep =
  | "not-started"
  | "step-1-welcome"
  | "awaiting-company-description"
  | "step-3-show-suggestions"
  | "step-4-job-board"
  | "step-4-confirming"
  | "step-5-role-details"
  | "completed";

interface OnboardingState {
  step: OnboardingStep;
  startedAt: string;
  companyDescription?: string;
  suggestedRoles?: string[];
  selectedRoles: string[];
  roleDetails: Record<string, number>; // roleId → count
  currentRoleIndex: number;
  jobBoardPage: number;
  jobBoardMessageId?: string;
  generalMessageId?: string;
  hrMessageId?: string;
  hrPersistentMenuId?: string; // Message ID of the persistent rehire menu in #hr
}

interface RoleEntry {
  id: string;
  en: string;
  "zh-TW": string;
  department: string;
  category: string;
}

// ── i18n ─────────────────────────────────────────────────────────────────────

type Lang = "zh-TW" | "en";

let _cachedLang: Lang | null = null;

function loadLanguage(): Lang {
  try {
    const officeYaml = path.join(PROJECT_DIR, "config", "office.yaml");
    const raw = fs.readFileSync(officeYaml, "utf-8");
    const match = raw.match(/^language:\s*["']?([^"'\n]+)["']?/m);
    const val = match?.[1]?.trim() ?? "zh-TW";
    return val.startsWith("en") ? "en" : "zh-TW";
  } catch {
    return "zh-TW";
  }
}

function lang(): Lang {
  if (!_cachedLang) _cachedLang = loadLanguage();
  return _cachedLang;
}

/** Return role display name in the current language. */
function roleName(role: RoleEntry): string {
  return lang() === "en" ? role.en : role["zh-TW"];
}

const STRINGS = {
  "zh-TW": {
    // Step 1
    welcomeTitle: "👋 嗨！我是你的 AI Office Leader",
    welcomeDescription:
      "很高興認識你！在我們正式開始之前，我想花幾分鐘了解你的辦公室，這樣我才能為你推薦最適合的團隊成員。\n\n" +
      "整個招聘流程只需要幾分鐘，完成後你就可以立刻開始工作了。",
    startButton: "👋 開始招聘！",
    // Step 2
    askCompany:
      "👍 太好了！\n\n請問這間辦公室主要是做什麼的？（例如：軟體開發公司、電商、行銷顧問...）\n\n直接在這裡描述就可以，不需要很正式 😊",
    // Step 3
    suggestionsTitle: "🔍 了解了！以下是我的建議",
    suggestionsBody: (roleList: string) =>
      `根據你的描述，我建議先從這些基礎角色開始：\n\n${roleList}\n\n` +
      "前往招聘看板後，你可以從所有角色中自由選擇。之後也可以隨時新增更多角色。",
    roleListItem: (name: string, dept: string) => `• **${name}**（${dept}）`,
    toJobBoardButton: "🏢 前往招聘看板 #hr",
    // Job board
    jobBoardTitle: "🏢 招聘看板",
    jobBoardDescription: (count: number, list: string) =>
      `選擇你想雇用的角色，可以多選。確認後進入細節設定。\n\n**目前已選 (${count} 位)**\n${list}`,
    jobBoardNoRoles: "_尚未選擇任何角色_",
    jobBoardContent: "📋 **招聘看板** — 選擇你想加入團隊的角色",
    jobBoardFooter: (page: number, total: number) => `第 ${page} 頁 / 共 ${total} 頁`,
    prevPage: "◀ 上頁",
    nextPage: "▶ 下頁",
    confirmButton: (count: number) => `✅ 確認選擇 (${count})`,
    roleSelected: (name: string) => `✓ ${name}`,
    roleAdd: (name: string) => `+ ${name}`,
    jobBoardNotification: (hrId: string) => `🏢 招聘看板已在 <#${hrId}> 開啟，請前往選擇你的團隊成員！`,
    // Cart confirm
    cartConfirmTitle: "📋 確認選擇",
    cartConfirmBody: (count: number, list: string) =>
      `你選擇了 **${count}** 個角色：\n\n${list}`,
    cartConfirmItem: (name: string, dept: string) => `• ${name} (${dept})`,
    cartAdjustButton: "← 重新選擇",
    cartContinueButton: "繼續設定細節 →",
    // Role detail
    roleDetailTitle: (name: string) => `🧑‍💼 ${name} 設定`,
    roleDetailBody: (dept: string, en: string) =>
      `**部門**: ${dept}\n**英文名**: ${en}\n\n要雇用幾位？（同一個角色可以有多個實例）`,
    roleDetailFooter: (i: number, total: number) => `角色 ${i} / ${total}`,
    nextRoleButton: "下一位 →",
    finishButton: "完成設定 ✨",
    doneLabel: "✓ 完成",
    // Team ready
    teamReadyTitle: "✨ 團隊就緒！",
    teamReadyBody: (lines: string, generalId?: string) =>
      `太好了！你的 AI 辦公室已經組建完成，以下是你的新團隊：\n\n${lines}\n\n` +
      `前往 ${generalId ? `<#${generalId}>` : "**#general**"} 跟我說你想做什麼，我會分配任務給最合適的成員！`,
    teamReadyFooter: (office: string) => `${office} • Powered by Claude Code`,
    finishNotification: (count: number, hrId?: string) =>
      `✨ **招聘完成！** 你的團隊已組建好了。\n\n` +
      `雇用了 **${count}** 個角色，詳情請看 ${hrId ? `<#${hrId}>` : "**#hr**"}。\n\n` +
      `現在告訴我你想做什麼，我會分配給最合適的成員！`,
    // Rehire menu
    rehireMenuTitle: "➕ 追加招聘",
    rehireMenuDescription: "想調整你的團隊嗎？點擊下方按鈕重新進入招聘流程。",
    rehireAddButton: "➕ 追加招聘",
    rehireResetButton: "🔄 重新選擇",
    rehireResetConfirmTitle: "🔄 重新選擇確認",
    rehireResetConfirmDescription: "這將清空目前所有已選角色，重新開始招聘。確定要繼續嗎？",
    rehireResetConfirmButton: "確定重新選擇",
    rehireResetCancelButton: "取消",
    // Recovery
    recoveryMessage:
      "🔄 *（Bot 剛剛重啟）繼續你的 onboarding 流程 — 請告訴我你的辦公室主要做什麼？*",
    // Footer
    officeFooter: (office: string) => `${office} • AI Office`,
  },

  en: {
    // Step 1
    welcomeTitle: "👋 Hi! I'm your AI Office Leader",
    welcomeDescription:
      "Nice to meet you! Before we get started, I'd like to take a few minutes to learn about your office so I can recommend the best team members for you.\n\n" +
      "The whole hiring process only takes a few minutes, and once complete you can get straight to work.",
    startButton: "👋 Start Hiring!",
    // Step 2
    askCompany:
      "👍 Great!\n\nWhat does this office mainly do? (e.g. software development, e-commerce, marketing consultancy...)\n\nJust describe it here, no need to be formal 😊",
    // Step 3
    suggestionsTitle: "🔍 Got it! Here are my suggestions",
    suggestionsBody: (roleList: string) =>
      `Based on your description, I suggest starting with these core roles:\n\n${roleList}\n\n` +
      "On the job board you can freely choose from all available roles and add more at any time.",
    roleListItem: (name: string, dept: string) => `• **${name}** (${dept})`,
    toJobBoardButton: "🏢 Go to Job Board #hr",
    // Job board
    jobBoardTitle: "🏢 Job Board",
    jobBoardDescription: (count: number, list: string) =>
      `Select the roles you want to hire — multiple selections allowed. Confirm to proceed.\n\n**Currently selected (${count})**\n${list}`,
    jobBoardNoRoles: "_No roles selected yet_",
    jobBoardContent: "📋 **Job Board** — Choose your team members",
    jobBoardFooter: (page: number, total: number) => `Page ${page} / ${total}`,
    prevPage: "◀ Prev",
    nextPage: "▶ Next",
    confirmButton: (count: number) => `✅ Confirm (${count})`,
    roleSelected: (name: string) => `✓ ${name}`,
    roleAdd: (name: string) => `+ ${name}`,
    jobBoardNotification: (hrId: string) => `🏢 The job board is open in <#${hrId}> — head over to choose your team!`,
    // Cart confirm
    cartConfirmTitle: "📋 Confirm Selection",
    cartConfirmBody: (count: number, list: string) =>
      `You selected **${count}** role(s):\n\n${list}`,
    cartConfirmItem: (name: string, dept: string) => `• ${name} (${dept})`,
    cartAdjustButton: "← Reselect",
    cartContinueButton: "Continue to Details →",
    // Role detail
    roleDetailTitle: (name: string) => `🧑‍💼 Set up ${name}`,
    roleDetailBody: (dept: string, en: string) =>
      `**Department**: ${dept}\n**Role**: ${en}\n\nHow many do you want to hire? (The same role can have multiple instances)`,
    roleDetailFooter: (i: number, total: number) => `Role ${i} / ${total}`,
    nextRoleButton: "Next →",
    finishButton: "Finish ✨",
    doneLabel: "✓ Done",
    // Team ready
    teamReadyTitle: "✨ Team Ready!",
    teamReadyBody: (lines: string, generalId?: string) =>
      `Your AI Office is fully staffed! Here's your new team:\n\n${lines}\n\n` +
      `Head to ${generalId ? `<#${generalId}>` : "**#general**"} and tell me what you want to do — I'll assign tasks to the best person!`,
    teamReadyFooter: (office: string) => `${office} • Powered by Claude Code`,
    finishNotification: (count: number, hrId?: string) =>
      `✨ **Hiring complete!** Your team is ready.\n\n` +
      `Hired **${count}** role(s) — see ${hrId ? `<#${hrId}>` : "**#hr**"} for details.\n\n` +
      `Now tell me what you'd like to do and I'll assign it to the right person!`,
    // Rehire menu
    rehireMenuTitle: "➕ Hire More",
    rehireMenuDescription: "Want to adjust your team? Click a button below to re-open the hiring flow.",
    rehireAddButton: "➕ Add More",
    rehireResetButton: "🔄 Start Over",
    rehireResetConfirmTitle: "🔄 Confirm Reset",
    rehireResetConfirmDescription: "This will clear all currently selected roles and restart the hiring flow. Are you sure?",
    rehireResetConfirmButton: "Confirm Reset",
    rehireResetCancelButton: "Cancel",
    // Recovery
    recoveryMessage:
      "🔄 *(Bot just restarted) Continuing your onboarding — please tell me what your office mainly does.*",
    // Footer
    officeFooter: (office: string) => `${office} • AI Office`,
  },
} as const;

type StringsShape = typeof STRINGS["zh-TW"];

function s(): StringsShape {
  return STRINGS[lang()] as StringsShape;
}

// ── State management ──────────────────────────────────────────────────────────

function loadState(): OnboardingState | null {
  try {
    if (!fs.existsSync(STATE_PATH)) return null;
    const raw = fs.readFileSync(STATE_PATH, "utf-8");
    return yaml.load(raw) as OnboardingState;
  } catch {
    return null;
  }
}

function saveState(state: OnboardingState): void {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, yaml.dump(state, { lineWidth: 120 }), "utf-8");
}

function defaultState(): OnboardingState {
  return {
    step: "not-started",
    startedAt: new Date().toISOString(),
    selectedRoles: [],
    roleDetails: {},
    currentRoleIndex: 0,
    jobBoardPage: 0,
  };
}

// ── Role index loader ─────────────────────────────────────────────────────────

let cachedRoles: RoleEntry[] | null = null;

function loadRoles(): RoleEntry[] {
  if (cachedRoles) return cachedRoles;
  try {
    const raw = fs.readFileSync(ROLE_INDEX_PATH, "utf-8");
    const doc = yaml.load(raw) as { roles: RoleEntry[] };
    // Exclude the default leader role from the job board
    cachedRoles = (doc.roles ?? []).filter((r) => r.id !== "leader");
    return cachedRoles;
  } catch {
    return [];
  }
}

function getGeneralRoles(): RoleEntry[] {
  return loadRoles().filter((r) => r.category === "general");
}

function getAllHireableRoles(): RoleEntry[] {
  // Show general + emerging roles on the job board; industry roles available via "hire"
  return loadRoles().filter((r) => r.category === "general" || r.category === "emerging");
}

function getRoleById(id: string): RoleEntry | undefined {
  return loadRoles().find((r) => r.id === id);
}

/**
 * Suggest up to 6 roles based on a free-text company description.
 * Matches the description against starter-pack keywords; returns the
 * roles from the best-matching pack. Falls back to general roles if no
 * pack matches.
 */
function suggestRolesFromDescription(description: string): RoleEntry[] {
  const MAX_SUGGESTIONS = 6;

  try {
    const raw = fs.readFileSync(STARTER_PACKS_PATH, "utf-8");
    const doc = yaml.load(raw) as {
      starter_packs: Record<string, { keywords?: string[]; roles: string[] }>;
    };
    const packs = doc.starter_packs ?? {};
    const lower = description.toLowerCase();

    let bestPackId: string | null = null;
    let bestScore = 0;

    for (const [packId, pack] of Object.entries(packs)) {
      if (!pack.keywords || pack.keywords.length === 0) continue;
      let score = 0;
      for (const kw of pack.keywords) {
        if (lower.includes(kw.toLowerCase())) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPackId = packId;
      }
    }

    if (bestPackId && bestScore > 0) {
      const roleIds = packs[bestPackId].roles ?? [];
      const matched = roleIds
        .map((id) => getRoleById(id))
        .filter((r): r is RoleEntry => r !== undefined);
      if (matched.length > 0) {
        return matched.slice(0, MAX_SUGGESTIONS);
      }
    }
  } catch (err) {
    console.warn("[Onboarding] Failed to load starter-packs for suggestions:", err);
  }

  // Fallback: return first N general roles
  return getGeneralRoles().slice(0, MAX_SUGGESTIONS);
}

// ── Embed builders ────────────────────────────────────────────────────────────

const COLORS = {
  BLURPLE: 0x5865f2,
  GREEN: 0x57f287,
  YELLOW: 0xfee75c,
  GOLD: 0xf1c40f,
};

function buildWelcomeEmbed(officeName: string): EmbedBuilder {
  const str = s();
  return new EmbedBuilder()
    .setTitle(str.welcomeTitle)
    .setDescription(str.welcomeDescription)
    .setColor(COLORS.BLURPLE)
    .setTimestamp()
    .setFooter({ text: str.officeFooter(officeName) });
}

function buildJobBoardEmbed(
  roles: RoleEntry[],
  selected: Set<string>,
  page: number,
  pageSize: number
): { embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] } {
  const str = s();
  const total = roles.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRoles = roles.slice(page * pageSize, (page + 1) * pageSize);

  const selectedList = selected.size > 0
    ? [...selected].map((id) => {
        const r = getRoleById(id);
        return r ? `• ${roleName(r)}` : `• ${id}`;
      }).join("\n")
    : str.jobBoardNoRoles;

  const embed = new EmbedBuilder()
    .setTitle(str.jobBoardTitle)
    .setDescription(str.jobBoardDescription(selected.size, selectedList))
    .setColor(COLORS.BLURPLE)
    .setFooter({ text: str.jobBoardFooter(page + 1, totalPages) });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Role buttons (up to 4 per row)
  let row = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;
  for (const role of pageRoles) {
    const isSelected = selected.has(role.id);
    const label = isSelected ? str.roleSelected(roleName(role)) : str.roleAdd(roleName(role));
    const btn = new ButtonBuilder()
      .setCustomId(`onboarding:role-toggle:${role.id}:${page}`)
      .setLabel(label)
      .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    row.addComponents(btn);
    count++;
    if (count % 4 === 0) {
      rows.push(row);
      row = new ActionRowBuilder<ButtonBuilder>();
    }
  }
  if (count % 4 !== 0) rows.push(row);

  // Navigation + confirm row
  const navRow = new ActionRowBuilder<ButtonBuilder>();

  if (totalPages > 1) {
    navRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`onboarding:page:${page - 1}`)
        .setLabel(str.prevPage)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`onboarding:page:${page + 1}`)
        .setLabel(str.nextPage)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    );
  }

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-confirm")
      .setLabel(str.confirmButton(selected.size))
      .setStyle(ButtonStyle.Primary)
      .setDisabled(selected.size === 0)
  );

  rows.push(navRow);
  return { embed, rows };
}

function buildRoleDetailEmbed(
  role: RoleEntry,
  currentCount: number,
  index: number,
  total: number
): { embed: EmbedBuilder; row: ActionRowBuilder<ButtonBuilder> } {
  const str = s();
  const embed = new EmbedBuilder()
    .setTitle(str.roleDetailTitle(roleName(role)))
    .setDescription(str.roleDetailBody(role.department, role.en))
    .setColor(COLORS.GOLD)
    .setFooter({ text: str.roleDetailFooter(index + 1, total) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`onboarding:role-count:1`)
      .setLabel("×1")
      .setStyle(currentCount === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboarding:role-count:2`)
      .setLabel("×2")
      .setStyle(currentCount === 2 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`onboarding:role-count:3`)
      .setLabel("×3")
      .setStyle(currentCount === 3 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel(index + 1 < total ? str.nextRoleButton : str.finishButton)
      .setStyle(ButtonStyle.Success)
  );

  return { embed, row };
}

function buildTeamReadyEmbed(
  roleDetails: Record<string, number>,
  officeName: string,
  generalChannelId?: string
): EmbedBuilder {
  const str = s();
  const lines = Object.entries(roleDetails).map(([id, count]) => {
    const r = getRoleById(id);
    const name = r ? roleName(r) : id;
    return `• ${name} × ${count}`;
  });

  return new EmbedBuilder()
    .setTitle(str.teamReadyTitle)
    .setDescription(str.teamReadyBody(lines.join("\n"), generalChannelId))
    .setColor(COLORS.GREEN)
    .setTimestamp()
    .setFooter({ text: str.teamReadyFooter(officeName) });
}

// ── Active roles writer ───────────────────────────────────────────────────────

function writeActiveRoles(roleDetails: Record<string, number>): void {
  const lines = [
    "# Active roles for this AI Office instance",
    "# Selected during Discord onboarding",
    "# Leader is always active (default role)",
    "",
    "active_roles:",
    "  - leader",
  ];
  for (const [roleId] of Object.entries(roleDetails)) {
    lines.push(`  - ${roleId}`);
  }
  fs.mkdirSync(path.dirname(ACTIVE_ROLES_PATH), { recursive: true });
  fs.writeFileSync(ACTIVE_ROLES_PATH, lines.join("\n") + "\n", "utf-8");
  console.log("[Onboarding] Wrote active-roles.yaml:", Object.keys(roleDetails).join(", "));
}

// ── Utility: load office name ─────────────────────────────────────────────────

function loadOfficeName(): string {
  try {
    const officeYaml = path.join(PROJECT_DIR, "config", "office.yaml");
    const raw = fs.readFileSync(officeYaml, "utf-8");
    const match = raw.match(/name:\s*"([^"]+)"/);
    return match?.[1] ?? "AI Office";
  } catch {
    return "AI Office";
  }
}

// ── Utility: disable all buttons on a message ─────────────────────────────────

function disableAllButtons(
  rows: ActionRowBuilder<ButtonBuilder>[]
): ActionRowBuilder<ButtonBuilder>[] {
  return rows.map((row) => {
    const newRow = new ActionRowBuilder<ButtonBuilder>();
    for (const btn of row.components) {
      newRow.addComponents(ButtonBuilder.from(btn.toJSON()).setDisabled(true));
    }
    return newRow;
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns true if the onboarding flow is currently active and waiting for
 * user text input (Step 2). Listener uses this to intercept messages.
 */
export function isAwaitingUserInput(): boolean {
  const state = loadState();
  return state?.step === "awaiting-company-description";
}

/**
 * Returns true if onboarding is in progress (not started / not completed).
 * Used by listener to skip normal Claude -p flow when onboarding is active.
 */
export function isOnboardingActive(): boolean {
  if (fs.existsSync(ONBOARDED_FLAG)) return false;
  const state = loadState();
  if (!state) return false;
  return state.step !== "completed" && state.step !== "not-started";
}

/**
 * Handle a user text message during onboarding step 2.
 * Returns true if the message was handled (caller should skip Claude -p).
 */
export async function handleUserMessage(message: Message): Promise<boolean> {
  const state = loadState();
  if (!state || state.step !== "awaiting-company-description") return false;

  const description = message.content.trim();
  if (!description) return false;

  const str = s();
  const channel = message.channel as TextChannel;
  const officeName = loadOfficeName();

  // Save company description
  state.companyDescription = description;
  state.step = "step-3-show-suggestions";
  saveState(state);

  // Persist company profile
  fs.mkdirSync(path.dirname(COMPANY_PROFILE_PATH), { recursive: true });
  fs.writeFileSync(
    COMPANY_PROFILE_PATH,
    yaml.dump({ description, recordedAt: new Date().toISOString() }),
    "utf-8"
  );

  // Suggest roles dynamically based on the description
  const generalRoles = suggestRolesFromDescription(description);
  const roleList = generalRoles.map((r) => str.roleListItem(roleName(r), r.department)).join("\n");

  const embed = new EmbedBuilder()
    .setTitle(str.suggestionsTitle)
    .setDescription(str.suggestionsBody(roleList))
    .setColor(COLORS.BLURPLE)
    .setFooter({ text: str.officeFooter(officeName) });

  state.suggestedRoles = generalRoles.map((r) => r.id);
  saveState(state);

  const confirmBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:to-job-board")
      .setLabel(str.toJobBoardButton)
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({ embeds: [embed], components: [confirmBtn] });
  state.generalMessageId = msg.id;
  saveState(state);

  return true;
}

/**
 * Kick off the onboarding flow. Called on first launch when .onboarded doesn't exist.
 * Sends the Step 1 welcome embed to #general.
 */
export async function startOnboarding(): Promise<void> {
  // Do not restart if already in progress
  const existing = loadState();
  if (existing && existing.step !== "not-started" && existing.step !== "completed") {
    console.log("[Onboarding] Already in progress at step:", existing.step);
    await recoverOnboardingState();
    return;
  }

  const str = s();
  const officeName = loadOfficeName();
  const state = defaultState();
  state.step = "step-1-welcome";
  saveState(state);

  console.log("[Onboarding] Starting onboarding flow...");

  try {
    const channel = await findTextChannel("general");

    // Step 1a: greeting embed (no button) — feels like Leader is "talking" first
    const embed = buildWelcomeEmbed(officeName);
    await channel.send({ embeds: [embed] });

    // Short pause for conversational feel
    await new Promise(r => setTimeout(r, 1200));

    // Step 1b: button as a separate follow-up message
    const startBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("onboarding:start")
        .setLabel(str.startButton)
        .setStyle(ButtonStyle.Primary)
    );
    const msg = await channel.send({ components: [startBtn] });
    state.generalMessageId = msg.id;
    saveState(state);

    console.log("[Onboarding] Welcome embed sent (msg:", msg.id, ")");
  } catch (err) {
    console.error("[Onboarding] Failed to start onboarding:", err);
  }
}

/**
 * On bot restart, re-register state-appropriate handlers if onboarding is in progress.
 * Called once after client is ready.
 */
export async function recoverOnboardingState(): Promise<void> {
  const state = loadState();
  if (!state || state.step === "completed" || state.step === "not-started") return;

  console.log("[Onboarding] Recovering onboarding at step:", state.step);

  if (state.step === "awaiting-company-description") {
    try {
      const channel = await findTextChannel("general");
      await channel.send(s().recoveryMessage);
    } catch {
      // Non-fatal
    }
  }
}

// ── Interaction handler ───────────────────────────────────────────────────────

const ROLES_PER_PAGE = 12; // max 3 rows × 4 buttons

/**
 * Register the onboarding button interaction handler.
 * Can be called with any Client instance — the listener's or the MCP server's.
 */
export function registerOnboardingInteractionHandler(externalClient?: Client): void {
  const client = externalClient ?? getDiscordClient();

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("onboarding:")) return;

    const parts = interaction.customId.split(":");
    const action = parts[1];

    // Acknowledge immediately — deferUpdate() tells Discord we'll update the original message
    try {
      await interaction.deferUpdate();
    } catch (err) {
      console.error("[Onboarding] Failed to deferUpdate:", err);
      return;
    }

    const state = loadState();
    if (!state) {
      console.warn("[Onboarding] Button pressed but no state found:", interaction.customId, "— re-triggering startOnboarding");
      await startOnboarding();
      return;
    }

    const officeName = loadOfficeName();

    try {
      switch (action) {
        case "start":
          await handleStart(interaction, state, officeName);
          break;
        case "to-job-board":
          await handleToJobBoard(interaction, state, officeName);
          break;
        case "role-toggle":
          await handleRoleToggle(interaction, state, parts[2], Number(parts[3]));
          break;
        case "page":
          await handlePage(interaction, state, Number(parts[2]));
          break;
        case "cart-confirm":
          await handleCartConfirm(interaction, state, officeName);
          break;
        case "cart-adjust":
          await handleCartAdjust(interaction, state);
          break;
        case "role-count":
          await handleRoleCount(interaction, state, Number(parts[2]));
          break;
        case "role-detail-next":
          await handleRoleDetailNext(interaction, state, officeName);
          break;
        case "rehire-add":
          await handleRehire(interaction, state, "add", officeName);
          break;
        case "rehire-reset":
          await handleRehire(interaction, state, "reset", officeName);
          break;
        default:
          console.warn("[Onboarding] Unknown action:", action);
      }
    } catch (err) {
      console.error("[Onboarding] Handler error:", err);
    }
  });

  console.log("[Onboarding] Interaction handler registered.");
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleStart(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  _officeName: string
): Promise<void> {
  const str = s();
  // Disable the start button
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:start")
      .setLabel(str.startButton)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] });

  state.step = "awaiting-company-description";
  saveState(state);

  const channel = await findTextChannel("general");
  await channel.send(str.askCompany);
}

async function handleToJobBoard(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  officeName: string
): Promise<void> {
  const str = s();
  // Disable the button on the general message
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:to-job-board")
      .setLabel(str.toJobBoardButton)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] });

  state.step = "step-4-job-board";
  state.jobBoardPage = 0;
  saveState(state);

  const allRoles = getAllHireableRoles();
  const selected = new Set(state.selectedRoles);
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, 0, ROLES_PER_PAGE);

  try {
    const hrChannel = await findTextChannel("hr");
    const hrMsg = await hrChannel.send({
      content: str.jobBoardContent,
      embeds: [embed],
      components: rows,
    });
    state.hrMessageId = hrMsg.id;
    saveState(state);

    // Notify in general that #hr is ready
    const generalChannel = await findTextChannel("general");
    await generalChannel.send(str.jobBoardNotification(hrChannel.id));
  } catch (err) {
    console.error("[Onboarding] Failed to create job board:", err);
  }
}

async function handleRoleToggle(
  interaction: {
    message: {
      edit: (opts: MessageEditOptions) => Promise<unknown>;
      channelId: string;
      id: string;
    };
  },
  state: OnboardingState,
  roleId: string,
  page: number
): Promise<void> {
  const selected = new Set(state.selectedRoles);

  if (selected.has(roleId)) {
    selected.delete(roleId);
  } else {
    selected.add(roleId);
  }

  state.selectedRoles = [...selected];
  saveState(state);

  const allRoles = getAllHireableRoles();
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, page, ROLES_PER_PAGE);
  await interaction.message.edit({ embeds: [embed], components: rows });
}

async function handlePage(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  newPage: number
): Promise<void> {
  const allRoles = getAllHireableRoles();
  const totalPages = Math.ceil(allRoles.length / ROLES_PER_PAGE);
  const page = Math.max(0, Math.min(newPage, totalPages - 1));

  state.jobBoardPage = page;
  saveState(state);

  const selected = new Set(state.selectedRoles);
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, page, ROLES_PER_PAGE);
  await interaction.message.edit({ embeds: [embed], components: rows });
}

async function handleCartConfirm(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  officeName: string
): Promise<void> {
  if (state.selectedRoles.length === 0) return;

  const str = s();

  // Disable the job board
  const allRoles = getAllHireableRoles();
  const selected = new Set(state.selectedRoles);
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, state.jobBoardPage, ROLES_PER_PAGE);
  await interaction.message.edit({
    embeds: [embed],
    components: disableAllButtons(rows),
  });

  state.step = "step-4-confirming";
  saveState(state);

  // Show confirmation in #hr
  const selectedList = state.selectedRoles.map((id) => {
    const r = getRoleById(id);
    return r ? str.cartConfirmItem(roleName(r), r.department) : `• ${id}`;
  }).join("\n");

  const confirmEmbed = new EmbedBuilder()
    .setTitle(str.cartConfirmTitle)
    .setDescription(str.cartConfirmBody(state.selectedRoles.length, selectedList))
    .setColor(COLORS.GOLD)
    .setFooter({ text: str.officeFooter(officeName) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-adjust")
      .setLabel(str.cartAdjustButton)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel(str.cartContinueButton)
      .setStyle(ButtonStyle.Primary)
  );

  const hrChannel = await findTextChannel("hr");
  await hrChannel.send({ embeds: [confirmEmbed], components: [row] });
}

async function handleCartAdjust(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState
): Promise<void> {
  const str = s();
  // Disable this confirmation message's buttons
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-adjust")
      .setLabel(str.cartAdjustButton)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel(str.cartContinueButton)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] });

  state.step = "step-4-job-board";
  state.jobBoardPage = 0;
  saveState(state);

  const allRoles = getAllHireableRoles();
  const selected = new Set(state.selectedRoles);
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, 0, ROLES_PER_PAGE);

  const hrChannel = await findTextChannel("hr");
  const newMsg = await hrChannel.send({
    content: str.jobBoardContent,
    embeds: [embed],
    components: rows,
  });
  state.hrMessageId = newMsg.id;
  saveState(state);
}

async function handleRoleCount(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  count: number
): Promise<void> {
  const currentRoleId = state.selectedRoles[state.currentRoleIndex];
  if (!currentRoleId) return;

  state.roleDetails[currentRoleId] = count;
  saveState(state);

  // Re-render current role detail embed with updated selection
  const role = getRoleById(currentRoleId);
  if (!role) return;

  const { embed, row } = buildRoleDetailEmbed(
    role,
    count,
    state.currentRoleIndex,
    state.selectedRoles.length
  );
  await interaction.message.edit({ embeds: [embed], components: [row] });
}

async function handleRoleDetailNext(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  officeName: string
): Promise<void> {
  const str = s();
  const currentRoleId = state.selectedRoles[state.currentRoleIndex];

  // If coming from step-4-confirming (first call), initialize details
  if (state.step === "step-4-confirming") {
    state.step = "step-5-role-details";
    state.currentRoleIndex = 0;
    // Set default count of 1 for all roles
    for (const id of state.selectedRoles) {
      if (!state.roleDetails[id]) {
        state.roleDetails[id] = 1;
      }
    }
  } else {
    // Save current role's default count if not explicitly set
    if (currentRoleId && !state.roleDetails[currentRoleId]) {
      state.roleDetails[currentRoleId] = 1;
    }
    state.currentRoleIndex++;
  }

  saveState(state);

  // Disable buttons on the previous message
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel(str.doneLabel)
      .setStyle(ButtonStyle.Success)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] });

  // Check if we're done with all roles
  if (state.currentRoleIndex >= state.selectedRoles.length) {
    await handleFinish(state, officeName);
    return;
  }

  // Show next role detail
  const nextRoleId = state.selectedRoles[state.currentRoleIndex];
  const role = getRoleById(nextRoleId);
  if (!role) {
    // Skip unknown roles
    state.currentRoleIndex++;
    saveState(state);
    return;
  }

  const currentCount = state.roleDetails[nextRoleId] ?? 1;
  const { embed, row } = buildRoleDetailEmbed(
    role,
    currentCount,
    state.currentRoleIndex,
    state.selectedRoles.length
  );

  const hrChannel = await findTextChannel("hr");
  await hrChannel.send({ embeds: [embed], components: [row] });
}

async function handleFinish(state: OnboardingState, officeName: string): Promise<void> {
  const str = s();
  state.step = "completed";
  saveState(state);

  // Write active-roles.yaml with selected roles and counts
  const details = { ...state.roleDetails };
  // Ensure default count 1 for roles without explicit count
  for (const id of state.selectedRoles) {
    if (!details[id]) details[id] = 1;
  }
  writeActiveRoles(details);

  // Create .onboarded flag
  fs.mkdirSync(path.dirname(ONBOARDED_FLAG), { recursive: true });
  fs.writeFileSync(ONBOARDED_FLAG, "", "utf-8");
  console.log("[Onboarding] Created .onboarded flag");

  // Send team ready embed to #hr
  const hrChannel = await findTextChannel("hr");
  const generalChannel = await findTextChannel("general");
  const embed = buildTeamReadyEmbed(details, officeName, generalChannel.id);
  await hrChannel.send({ embeds: [embed] });

  // Send persistent rehire menu to #hr
  const persistentMsg = await sendPersistentRehireMenu(hrChannel);
  if (persistentMsg) {
    state.hrPersistentMenuId = persistentMsg.id;
    saveState(state);
  }

  // Notify in #general
  await generalChannel.send(str.finishNotification(state.selectedRoles.length, hrChannel.id));

  console.log("[Onboarding] Onboarding completed. Team:", Object.keys(details).join(", "));
}

/**
 * Handle the "rehire-add" and "rehire-reset" button actions from the
 * persistent rehire menu in #hr.
 *
 * - "add"  → keep existing active-roles, re-open job board to add more
 * - "reset" → clear active-roles.yaml + reset state, re-open full job board
 */
async function handleRehire(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  mode: "add" | "reset",
  officeName: string
): Promise<void> {
  const str = s();

  if (mode === "reset") {
    // Clear existing role selections
    state.selectedRoles = [];
    state.roleDetails = {};
    state.currentRoleIndex = 0;
    // Reset active-roles.yaml to only contain leader
    writeActiveRoles({});
    console.log("[Onboarding] Rehire reset: cleared active roles");
  }

  // Re-open the job board
  state.step = "step-4-job-board";
  state.jobBoardPage = 0;
  saveState(state);

  const allRoles = getAllHireableRoles();
  const selected = new Set(state.selectedRoles);
  const { embed, rows } = buildJobBoardEmbed(allRoles, selected, 0, ROLES_PER_PAGE);

  try {
    const hrChannel = await findTextChannel("hr");
    const hrMsg = await hrChannel.send({
      content: str.jobBoardContent,
      embeds: [embed],
      components: rows,
    });
    state.hrMessageId = hrMsg.id;
    saveState(state);
    console.log("[Onboarding] Rehire job board opened (mode:", mode, ")");
  } catch (err) {
    console.error("[Onboarding] Failed to open rehire job board:", err);
  }
}

/**
 * Send (or re-send) the persistent rehire menu embed to #hr.
 * Returns the sent message so caller can store its ID.
 */
async function sendPersistentRehireMenu(hrChannel: TextChannel): Promise<import("discord.js").Message | null> {
  const str = s();
  try {
    const embed = new EmbedBuilder()
      .setTitle(str.rehireMenuTitle)
      .setDescription(str.rehireMenuDescription)
      .setColor(COLORS.BLURPLE);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("onboarding:rehire-add")
        .setLabel(str.rehireAddButton)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("onboarding:rehire-reset")
        .setLabel(str.rehireResetButton)
        .setStyle(ButtonStyle.Danger)
    );

    const msg = await hrChannel.send({ embeds: [embed], components: [row] });
    return msg;
  } catch (err) {
    console.error("[Onboarding] Failed to send persistent rehire menu:", err);
    return null;
  }
}
