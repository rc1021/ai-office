/**
 * officeInteractionHandler.ts — Handle all office:* button and select interactions
 *
 * Routes interactions with customId starting with "office:" to the appropriate
 * handler. All replies are ephemeral. Security check is applied at the top.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Interaction,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { buildControlPanel } from "./officeCommand.js";

const execAsync = promisify(exec);

// ── Resolve project root ──────────────────────────────────────────────────────
// At runtime: discord-bot/dist/interactions/officeInteractionHandler.js
// → dist/ → discord-bot/ → project root
const __filename = fileURLToPath(import.meta.url);
const DIST_INTERACTIONS_DIR = path.dirname(__filename);
const DIST_DIR = path.resolve(DIST_INTERACTIONS_DIR, "..");
const DISCORD_BOT_DIR = path.resolve(DIST_DIR, "..");
const PROJECT_DIR = path.resolve(DISCORD_BOT_DIR, "..");

// ── Role index types ──────────────────────────────────────────────────────────

interface RoleEntry {
  id: string;
  en: string;
  "zh-TW": string;
  department: string;
  category: string;
}

interface RoleIndex {
  roles: RoleEntry[];
}

// ── Security helper ───────────────────────────────────────────────────────────

function isAuthorized(userId: string): boolean {
  const ownerId = process.env.DISCORD_OWNER_USER_ID;
  if (!ownerId) return true; // No restriction configured
  return userId === ownerId;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface AgentRow {
  agent_id: string;
  role_id: string;
  department: string;
  status: string;
  last_heartbeat: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  assigned_to: string | null;
  priority: string;
  created_at: string;
}

function openDb(): Database.Database | null {
  const dbPath = path.join(PROJECT_DIR, ".ai-office", "state", "coordination.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath, { readonly: true });
    db.pragma("busy_timeout = 2000");
    return db;
  } catch {
    return null;
  }
}

function queryAgents(): AgentRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        "SELECT agent_id, role_id, department, status, last_heartbeat FROM agents ORDER BY department, agent_id"
      )
      .all() as AgentRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

function queryTasks(limit = 20): TaskRow[] {
  const db = openDb();
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT id, title, status, assigned_to, priority, created_at
         FROM tasks
         ORDER BY CASE status
           WHEN 'in_progress' THEN 0
           WHEN 'pending'     THEN 1
           WHEN 'assigned'    THEN 2
           WHEN 'checkpoint'  THEN 3
           WHEN 'failed'      THEN 4
           ELSE 5
         END, created_at DESC
         LIMIT ?`
      )
      .all(limit) as TaskRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

// ── Role index loader ─────────────────────────────────────────────────────────

function loadRoles(): RoleEntry[] {
  const indexPath = path.join(PROJECT_DIR, "roles", "role-index.yaml");
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = yaml.load(raw) as RoleIndex;
    // Exclude the leader role from the hire menu
    return (parsed.roles ?? []).filter((r) => r.id !== "leader");
  } catch {
    return [];
  }
}

// ── Status emoji helper ───────────────────────────────────────────────────────

function agentStatusEmoji(status: string): string {
  switch (status) {
    case "online": return "🟢";
    case "busy":   return "🔴";
    case "idle":   return "🟡";
    default:       return "⚫";
  }
}

function taskStatusEmoji(status: string): string {
  switch (status) {
    case "in_progress": return "🔄";
    case "pending":     return "⏳";
    case "assigned":    return "📌";
    case "checkpoint":  return "🔖";
    case "completed":   return "✅";
    case "failed":      return "❌";
    case "cancelled":   return "🚫";
    default:            return "❓";
  }
}

// ── Handler: status ───────────────────────────────────────────────────────────

async function handleStatus(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const agents = queryAgents();
  const tasks = queryTasks(10);

  const onlineCount = agents.filter((a) => a.status !== "offline").length;
  const busyCount   = agents.filter((a) => a.status === "busy").length;
  const activeTasks = tasks.filter((t) =>
    ["in_progress", "pending", "assigned", "checkpoint"].includes(t.status)
  ).length;

  const embed = new EmbedBuilder()
    .setTitle("📊 AI Office 狀態")
    .setColor(0x57f287)
    .addFields(
      { name: "員工在線", value: `${onlineCount} 人`, inline: true },
      { name: "忙碌中",   value: `${busyCount} 人`,    inline: true },
      { name: "進行中任務", value: `${activeTasks} 項`, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "AI Office Status" });

  const { components } = buildControlPanel();
  await interaction.editReply({ embeds: [embed], components });
}

// ── Handler: agents ───────────────────────────────────────────────────────────

async function handleAgents(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const agents = queryAgents();
  const embed = new EmbedBuilder()
    .setTitle("👥 已雇用員工")
    .setColor(0x5865f2);

  if (agents.length === 0) {
    embed.setDescription("目前沒有已雇用的員工。");
  } else {
    const lines = agents.map(
      (a) =>
        `${agentStatusEmoji(a.status)} **${a.agent_id}** (${a.role_id}) — ${a.department}`
    );
    // Discord field value limit is 1024 chars; chunk if needed
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      if ((current + "\n" + line).length > 1020) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({
        name: i === 0 ? `員工列表 (${agents.length} 人)` : "\u200b",
        value: chunks[i],
      });
    }
  }

  embed.setTimestamp();
  const { components } = buildControlPanel();
  await interaction.editReply({ embeds: [embed], components });
}

// ── Handler: tasks ────────────────────────────────────────────────────────────

async function handleTasks(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const tasks = queryTasks(20);
  const embed = new EmbedBuilder()
    .setTitle("📋 任務列表")
    .setColor(0xfee75c);

  if (tasks.length === 0) {
    embed.setDescription("目前沒有任務。");
  } else {
    const lines = tasks.map(
      (t) =>
        `${taskStatusEmoji(t.status)} **${t.id.substring(0, 12)}** ${t.title.substring(0, 40)} — ${t.assigned_to ?? "未指派"}`
    );
    const chunks: string[] = [];
    let current = "";
    for (const line of lines) {
      if ((current + "\n" + line).length > 1020) {
        chunks.push(current);
        current = line;
      } else {
        current = current ? current + "\n" + line : line;
      }
    }
    if (current) chunks.push(current);

    for (let i = 0; i < chunks.length; i++) {
      embed.addFields({
        name: i === 0 ? `最近任務 (${tasks.length} 筆)` : "\u200b",
        value: chunks[i],
      });
    }
  }

  embed.setTimestamp();
  const { components } = buildControlPanel();
  await interaction.editReply({ embeds: [embed], components });
}

// ── Handler: destructive confirm dialog ───────────────────────────────────────

async function handleDestructiveConfirm(
  interaction: ButtonInteraction,
  action: "restart" | "stop",
): Promise<void> {
  await interaction.deferUpdate();

  const isRestart = action === "restart";
  const embed = new EmbedBuilder()
    .setTitle(isRestart ? "⚠️ 確定要重啟 AI Office？" : "⚠️ 確定要停止 AI Office？")
    .setDescription(
      isRestart
        ? "重啟將中斷所有進行中的任務，並在幾秒後自動重新連線。"
        : "停止後 AI Office 將完全關閉，需要手動重新啟動。"
    )
    .setColor(0xed4245);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`office:${action}:confirm`)
      .setLabel(isRestart ? "確認重啟" : "確認停止")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`office:${action}:cancel`)
      .setLabel("取消")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── Handler: exec CLI ─────────────────────────────────────────────────────────

async function execOfficeCommand(
  interaction: ButtonInteraction,
  cliAction: "restart" | "stop",
): Promise<void> {
  await interaction.deferUpdate();

  const label = cliAction === "restart" ? "重啟" : "停止";
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setDescription(`⏳ 正在${label}，請稍候...`)
        .setColor(0xfee75c),
    ],
    components: [],
  });

  try {
    // Try the `office` CLI first; fall back to node cli/dist/index.js
    const cliPath = path.join(PROJECT_DIR, "cli", "dist", "index.js");
    const command = fs.existsSync(cliPath)
      ? `node "${cliPath}" ${cliAction}`
      : `office ${cliAction}`;

    await execAsync(command, { timeout: 15_000 });

    // If we get here (restart didn't kill us), report success
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription(`✅ AI Office 已${label}。`)
          .setColor(0x57f287),
      ],
      components: [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // For restart/stop the process itself may have exited, so a non-zero exit
    // code is expected. Only report unexpected errors.
    const isExpected = /SIGTERM|SIGINT|exit code 0|Process exited/.test(msg);
    if (!isExpected) {
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setDescription(`❌ ${label}失敗：${msg.substring(0, 300)}`)
            .setColor(0xed4245),
        ],
        components: [],
      }).catch(() => { /* interaction may already be invalid */ });
    }
  }
}

// ── Handler: hire — show role select menu ────────────────────────────────────

async function handleHire(interaction: ButtonInteraction): Promise<void> {
  await interaction.deferUpdate();

  const roles = loadRoles();
  if (roles.length === 0) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setDescription("⚠️ 找不到角色清單（roles/role-index.yaml）。")
          .setColor(0xed4245),
      ],
      components: [],
    });
    return;
  }

  // Discord select menu limit: 25 options
  const top25 = roles.slice(0, 25);

  const menu = new StringSelectMenuBuilder()
    .setCustomId("office:hire:select")
    .setPlaceholder("選擇要雇用的角色...")
    .addOptions(
      top25.map((r) =>
        new StringSelectMenuOptionBuilder()
          .setValue(r.id)
          .setLabel(r["zh-TW"] || r.en)
          .setDescription(`${r.en} · ${r.department}`)
      )
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
  const embed = new EmbedBuilder()
    .setTitle("🆕 雇用員工")
    .setDescription("從下方選單選擇要雇用的角色（顯示前 25 個）：")
    .setColor(0x57f287);

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── Handler: hire:select:{role_id} ───────────────────────────────────────────

async function handleHireSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  await interaction.deferUpdate();

  const roleId = interaction.values[0];
  if (!roleId) {
    await interaction.editReply({ content: "⚠️ 未選擇角色。", components: [] });
    return;
  }

  const roles = loadRoles();
  const role = roles.find((r) => r.id === roleId);
  const roleName = role ? `${role["zh-TW"]} (${role.en})` : roleId;
  const department = role?.department ?? "unknown";

  const embed = new EmbedBuilder()
    .setTitle("🆕 確認雇用")
    .setDescription(`確定要雇用 **${roleName}**？\n\n部門：${department}`)
    .setColor(0x57f287)
    .setFooter({ text: `role_id: ${roleId}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`office:hire:confirm:${roleId}`)
      .setLabel("確認雇用")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("office:hire:cancel")
      .setLabel("取消")
      .setEmoji("❌")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── Handler: hire:confirm:{role_id} ──────────────────────────────────────────

async function handleHireConfirm(
  interaction: ButtonInteraction,
  roleId: string,
): Promise<void> {
  await interaction.deferUpdate();

  const roles = loadRoles();
  const role = roles.find((r) => r.id === roleId);
  const roleName = role ? `${role["zh-TW"]} (${role.en})` : roleId;

  // Record the hiring intent in a simple JSON log for the Leader to act on
  const hireDir = path.join(PROJECT_DIR, ".ai-office", "shared", "inbox", "hire-requests");
  try {
    fs.mkdirSync(hireDir, { recursive: true });
    const record = {
      role_id: roleId,
      role_name: roleName,
      requested_by: interaction.user.id,
      requested_at: new Date().toISOString(),
    };
    const outPath = path.join(hireDir, `${Date.now()}-${roleId}.json`);
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2), "utf-8");
  } catch (err) {
    console.warn("[OfficeInteraction] Failed to write hire request:", err);
  }

  const embed = new EmbedBuilder()
    .setTitle("✅ 雇用請求已送出")
    .setDescription(
      `已記錄雇用 **${roleName}** 的請求。\n\nAI Office Leader 將會處理此請求並完成雇用流程。`
    )
    .setColor(0x57f287)
    .setTimestamp();

  const { components } = buildControlPanel();
  await interaction.editReply({ embeds: [embed], components });
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Handle all interactions whose customId starts with "office:".
 * Register this handler alongside the approval handler in listener.ts.
 */
export async function handleOfficeInteraction(
  interaction: Interaction,
): Promise<void> {
  // Security check — applies to all office:* interactions
  if (!isAuthorized(interaction.user.id)) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "⛔ 無授權操作。", ephemeral: true });
    }
    return;
  }

  // ── Button interactions ──────────────────────────────────────────────────
  if (interaction.isButton()) {
    const customId = interaction.customId;

    // --- Non-destructive ---
    if (customId === "office:status") {
      return handleStatus(interaction);
    }
    if (customId === "office:agents") {
      return handleAgents(interaction);
    }
    if (customId === "office:tasks") {
      return handleTasks(interaction);
    }
    if (customId === "office:hire") {
      return handleHire(interaction);
    }

    // --- Destructive: show confirmation dialogs ---
    if (customId === "office:restart") {
      return handleDestructiveConfirm(interaction, "restart");
    }
    if (customId === "office:stop") {
      return handleDestructiveConfirm(interaction, "stop");
    }

    // --- Confirm/cancel: restart ---
    if (customId === "office:restart:confirm") {
      return execOfficeCommand(interaction, "restart");
    }
    if (customId === "office:restart:cancel" || customId === "office:stop:cancel") {
      await interaction.deferUpdate();
      const { embeds, components } = buildControlPanel();
      await interaction.editReply({ embeds, components });
      return;
    }

    // --- Confirm/cancel: stop ---
    if (customId === "office:stop:confirm") {
      return execOfficeCommand(interaction, "stop");
    }

    // --- Hire confirm (office:hire:confirm:{role_id}) ---
    if (customId.startsWith("office:hire:confirm:")) {
      const roleId = customId.slice("office:hire:confirm:".length);
      return handleHireConfirm(interaction, roleId);
    }

    // --- Hire cancel ---
    if (customId === "office:hire:cancel") {
      await interaction.deferUpdate();
      const { embeds, components } = buildControlPanel();
      await interaction.editReply({ embeds, components });
      return;
    }

    return; // unknown office button — ignore
  }

  // ── StringSelectMenu interactions ────────────────────────────────────────
  if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;

    if (customId === "office:hire:select") {
      return handleHireSelect(interaction);
    }

    return; // unknown office select menu — ignore
  }
}
