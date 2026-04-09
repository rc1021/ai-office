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
}

interface RoleEntry {
  id: string;
  en: string;
  "zh-TW": string;
  department: string;
  category: string;
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
  // Show general + emerging roles on the job board; industry roles available via "雇用"
  return loadRoles().filter((r) => r.category === "general" || r.category === "emerging");
}

function getRoleById(id: string): RoleEntry | undefined {
  return loadRoles().find((r) => r.id === id);
}

// ── Embed builders ────────────────────────────────────────────────────────────

const COLORS = {
  BLURPLE: 0x5865f2,
  GREEN: 0x57f287,
  YELLOW: 0xfee75c,
  GOLD: 0xf1c40f,
};

function buildWelcomeEmbed(officeName: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("👋 嗨！我是你的 AI Office Leader")
    .setDescription(
      "很高興認識你！在我們正式開始之前，我想花幾分鐘了解你的辦公室，這樣我才能為你推薦最適合的團隊成員。\n\n" +
      "整個招聘流程只需要幾分鐘，完成後你就可以立刻開始工作了。"
    )
    .setColor(COLORS.BLURPLE)
    .setTimestamp()
    .setFooter({ text: `${officeName} • AI Office` });
}

function buildJobBoardEmbed(
  roles: RoleEntry[],
  selected: Set<string>,
  page: number,
  pageSize: number
): { embed: EmbedBuilder; rows: ActionRowBuilder<ButtonBuilder>[] } {
  const total = roles.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageRoles = roles.slice(page * pageSize, (page + 1) * pageSize);

  const selectedList = selected.size > 0
    ? [...selected].map((id) => {
        const r = getRoleById(id);
        return r ? `• ${r["zh-TW"]}` : `• ${id}`;
      }).join("\n")
    : "_尚未選擇任何角色_";

  const embed = new EmbedBuilder()
    .setTitle("🏢 招聘看板")
    .setDescription(
      "選擇你想雇用的角色，可以多選。確認後進入細節設定。\n\n" +
      `**目前已選 (${selected.size} 位)**\n${selectedList}`
    )
    .setColor(COLORS.BLURPLE)
    .setFooter({ text: `第 ${page + 1} 頁 / 共 ${totalPages} 頁` });

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Role buttons (up to 4 per row)
  let row = new ActionRowBuilder<ButtonBuilder>();
  let count = 0;
  for (const role of pageRoles) {
    const isSelected = selected.has(role.id);
    const btn = new ButtonBuilder()
      .setCustomId(`onboarding:role-toggle:${role.id}:${page}`)
      .setLabel(isSelected ? `✓ ${role["zh-TW"]}` : `+ ${role["zh-TW"]}`)
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
        .setLabel("◀ 上頁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`onboarding:page:${page + 1}`)
        .setLabel("▶ 下頁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    );
  }

  navRow.addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-confirm")
      .setLabel(`✅ 確認選擇 (${selected.size})`)
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
  const embed = new EmbedBuilder()
    .setTitle(`🧑‍💼 ${role["zh-TW"]} 設定`)
    .setDescription(
      `**部門**: ${role.department}\n` +
      `**英文名**: ${role.en}\n\n` +
      "要雇用幾位？（同一個角色可以有多個實例）"
    )
    .setColor(COLORS.GOLD)
    .setFooter({ text: `角色 ${index + 1} / ${total}` });

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
      .setLabel(index + 1 < total ? "下一位 →" : "完成設定 ✨")
      .setStyle(ButtonStyle.Success)
  );

  return { embed, row };
}

function buildTeamReadyEmbed(
  roleDetails: Record<string, number>,
  officeName: string
): EmbedBuilder {
  const lines = Object.entries(roleDetails).map(([id, count]) => {
    const r = getRoleById(id);
    const name = r ? r["zh-TW"] : id;
    return `• ${name} × ${count}`;
  });

  return new EmbedBuilder()
    .setTitle("✨ 團隊就緒！")
    .setDescription(
      "太好了！你的 AI 辦公室已經組建完成，以下是你的新團隊：\n\n" +
      lines.join("\n") +
      "\n\n前往 **#general** 跟我說你想做什麼，我會分配任務給最合適的成員！"
    )
    .setColor(COLORS.GREEN)
    .setTimestamp()
    .setFooter({ text: `${officeName} • Powered by Claude Code` });
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
      // btn.toJSON() returns the full APIButtonComponent (not Partial)
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

  // Suggest some general roles based on the description
  const generalRoles = getGeneralRoles().slice(0, 6);
  const roleList = generalRoles.map((r) => `• **${r["zh-TW"]}**（${r.department}）`).join("\n");

  const embed = new EmbedBuilder()
    .setTitle("🔍 了解了！以下是我的建議")
    .setDescription(
      `根據你的描述，我建議先從這些基礎角色開始：\n\n${roleList}\n\n` +
      "前往招聘看板後，你可以從所有角色中自由選擇。之後也可以隨時新增更多角色。"
    )
    .setColor(COLORS.BLURPLE)
    .setFooter({ text: `${officeName} • AI Office` });

  state.suggestedRoles = generalRoles.map((r) => r.id);
  saveState(state);

  const confirmBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:to-job-board")
      .setLabel("🏢 前往招聘看板 #hr")
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
        .setLabel("👋 開始招聘！")
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

  // Interaction handlers are re-registered by registerOnboardingInteractionHandler(),
  // so state recovery just needs to ensure we're listening again.
  // If waiting for text, post a reminder in #general.
  if (state.step === "awaiting-company-description") {
    try {
      const channel = await findTextChannel("general");
      await channel.send(
        "🔄 *（Bot 剛剛重啟）繼續你的 onboarding 流程 — 請告訴我你的辦公室主要做什麼？*"
      );
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
  officeName: string
): Promise<void> {
  // Disable the start button
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:start")
      .setLabel("👋 開始招聘！")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true)
  );
  await interaction.message.edit({ components: [disabledRow] });

  state.step = "awaiting-company-description";
  saveState(state);

  const channel = await findTextChannel("general");
  await channel.send(
    "👍 太好了！\n\n請問這間辦公室主要是做什麼的？（例如：軟體開發公司、電商、行銷顧問...）\n\n直接在這裡描述就可以，不需要很正式 😊"
  );
}

async function handleToJobBoard(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState,
  officeName: string
): Promise<void> {
  // Disable the button on the general message
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:to-job-board")
      .setLabel("🏢 前往招聘看板 #hr")
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
      content: "📋 **招聘看板** — 選擇你想加入團隊的角色",
      embeds: [embed],
      components: rows,
    });
    state.hrMessageId = hrMsg.id;
    saveState(state);

    // Notify in general that #hr is ready
    const generalChannel = await findTextChannel("general");
    await generalChannel.send("🏢 招聘看板已在 **#hr** 開啟，請前往選擇你的團隊成員！");
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
    return r ? `• ${r["zh-TW"]} (${r.department})` : `• ${id}`;
  }).join("\n");

  const confirmEmbed = new EmbedBuilder()
    .setTitle("📋 確認選擇")
    .setDescription(`你選擇了 **${state.selectedRoles.length}** 個角色：\n\n${selectedList}`)
    .setColor(COLORS.GOLD)
    .setFooter({ text: `${officeName} • AI Office` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-adjust")
      .setLabel("← 重新選擇")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel("繼續設定細節 →")
      .setStyle(ButtonStyle.Primary)
  );

  const hrChannel = await findTextChannel("hr");
  await hrChannel.send({ embeds: [confirmEmbed], components: [row] });
}

async function handleCartAdjust(
  interaction: { message: { edit: (opts: MessageEditOptions) => Promise<unknown> } },
  state: OnboardingState
): Promise<void> {
  // Disable this confirmation message's buttons
  const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("onboarding:cart-adjust")
      .setLabel("← 重新選擇")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId("onboarding:role-detail-next")
      .setLabel("繼續設定細節 →")
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
    content: "📋 **招聘看板** — 選擇你想加入團隊的角色",
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
      .setLabel("✓ 完成")
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
  const embed = buildTeamReadyEmbed(details, officeName);
  const hrChannel = await findTextChannel("hr");
  await hrChannel.send({ embeds: [embed] });

  // Notify in #general
  const generalChannel = await findTextChannel("general");
  await generalChannel.send(
    `✨ **招聘完成！** 你的團隊已組建好了。\n\n` +
    `雇用了 **${state.selectedRoles.length}** 個角色，詳情請看 **#hr**。\n\n` +
    `現在告訴我你想做什麼，我會分配給最合適的成員！`
  );

  console.log("[Onboarding] Onboarding completed. Team:", Object.keys(details).join(", "));
}
