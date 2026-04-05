import { createCategory, createChannel, findTextChannel } from "./channel-manager.js";
import { resolveAgent } from "./agent-registry.js";
import { ChannelType } from "discord.js";
import { getDiscordClient } from "./discord-client.js";

// ─── State ───────────────────────────────────────────────────────────────────

// Track which departments have been initialized
const initializedDepartments = new Set<string>();

// ─── Department Channel Management ──────────────────────────────────────────

/**
 * Ensure department channels exist for the given agent.
 * Creates category + channels on first agent registration in a department.
 */
export async function ensureDepartmentChannels(agentId: string): Promise<{
  created: string[];
  skipped: string[];
}> {
  const agent = resolveAgent(agentId);
  const department = agent.department;

  // Skip non-department agents (system, management/leader uses fixed channels)
  if (department === "system" || department === "unknown" || department === "management") {
    return { created: [], skipped: [] };
  }

  const result = { created: [] as string[], skipped: [] as string[] };

  if (initializedDepartments.has(department)) {
    return { created: [], skipped: [`dept-${department} (already initialized)`] };
  }

  const categoryName = `DEPT-${department.toUpperCase()}`;
  const channelName = `dept-${department}`;
  const topic = `${department} department workspace`;

  try {
    // Create category
    await createCategory(categoryName);

    // Create main department channel
    await createChannel(categoryName, channelName, topic);
    result.created.push(`#${channelName}`);

    // Create confidential channel if agent has clearance >= 2
    if (agent.clearance_level >= 2) {
      const confName = `dept-${department}-confidential`;
      const confTopic = `${department} confidential discussions (clearance 2+)`;
      await createChannel(categoryName, confName, confTopic);
      result.created.push(`#${confName}`);
    }

    initializedDepartments.add(department);
    console.log(`[DepartmentManager] Initialized department channels for ${department}`);
  } catch (err) {
    console.error(`[DepartmentManager] Failed to create channels for ${department}:`, err);
    throw err;
  }

  return result;
}

/**
 * Create confidential channel for a department if not already created.
 * Called when a clearance 2+ agent joins a department that only had clearance <2 agents.
 */
export async function ensureConfidentialChannel(department: string): Promise<string | null> {
  const categoryName = `DEPT-${department.toUpperCase()}`;
  const confName = `dept-${department}-confidential`;

  try {
    // Check if it already exists
    await findTextChannel(confName);
    return null; // Already exists
  } catch {
    // Doesn't exist, create it
    const confTopic = `${department} confidential discussions (clearance 2+)`;
    await createChannel(categoryName, confName, confTopic);
    console.log(`[DepartmentManager] Created confidential channel #${confName}`);
    return confName;
  }
}

/**
 * Archive department channels when no agents remain.
 */
export async function archiveDepartmentChannels(department: string): Promise<string[]> {
  const client = getDiscordClient();
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID not set");

  const guild = await client.guilds.fetch(guildId);
  const prefix = `dept-${department}`;
  const archivePrefix = "archived-";
  const archived: string[] = [];

  const channels = guild.channels.cache.filter(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      ch.name.startsWith(prefix) &&
      !ch.name.startsWith(archivePrefix)
  );

  for (const [, channel] of channels) {
    try {
      await channel.setName(`${archivePrefix}${channel.name}`);
      archived.push(channel.name);
      console.log(`[DepartmentManager] Archived channel #${channel.name}`);
    } catch (err) {
      console.error(`[DepartmentManager] Failed to archive #${channel.name}:`, err);
    }
  }

  initializedDepartments.delete(department);
  return archived;
}

/**
 * Check if a department has been initialized.
 */
export function isDepartmentInitialized(department: string): boolean {
  return initializedDepartments.has(department);
}
