import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from "discord.js";

let clientInstance: Client | null = null;

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[Discord] Bot ready! Logged in as ${readyClient.user.tag}`);
    console.log(`[Discord] Serving ${readyClient.guilds.cache.size} guild(s)`);
  });

  client.on(Events.Error, (error) => {
    console.error("[Discord] Client error:", error);
  });

  client.on(Events.Warn, (info) => {
    console.warn("[Discord] Warning:", info);
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    console.log(
      `[Discord] Message in #${message.channel.type === 0 ? (message.channel as { name: string }).name : "unknown"} from ${message.author.username}: ${message.content.substring(0, 80)}`
    );
  });

  clientInstance = client;
  return client;
}

export function getDiscordClient(): Client {
  if (!clientInstance) {
    throw new Error("Discord client not initialized. Call createDiscordClient() or setDiscordClient() first.");
  }
  return clientInstance;
}

/**
 * Set an externally-created Client as the shared singleton.
 * Used by the listener daemon which creates its own Client instance.
 */
export function setDiscordClient(client: Client): void {
  clientInstance = client;
}
