# Getting Started with AI Office

AI Office is a multi-agent virtual office system powered by Claude Code. You hire AI agents with specialized roles, who collaborate via Discord to accomplish complex tasks under human supervision.

---

## 1. Prerequisites

Before you begin, ensure you have the following installed and available:

### Node.js >= 22

AI Office requires Node.js version 22 or higher. Check your version:

```sh
node -v
```

Download from [nodejs.org](https://nodejs.org) if you need to upgrade.

### Claude Code with Max Subscription

The Leader agent runs on Claude Opus 4.6 and workers run on Claude Sonnet 4.6. A **Claude Max 20x subscription** is required to sustain multi-agent workloads. Install Claude Code:

```sh
npm install -g @anthropic-ai/claude-code
```

Verify with:

```sh
claude --version
```

### Discord Bot

You will need a Discord bot token and the ID of the server (guild) where you want AI Office to operate. See [Section 3](#3-discord-bot-setup) for step-by-step bot creation instructions.

### Optional: Docker

Docker is only needed if you want to run the Pixel Office UI or the setup wizard in a container. The core system runs entirely within Claude Code.

---

## 2. Installation

### One-command install

```sh
bash <(curl -fsSL https://raw.githubusercontent.com/rc1021/ai-office/main/setup.sh)
```

After the initial install, the `office` CLI is available for all subsequent management:

```sh
office setup    # re-run setup (install deps + wizard + start listener)
office help     # show all available commands
```

> **Note:** `./bin/office` must be in your PATH, or call it as `./bin/office <command>` from the project root.

The `setup.sh` script (and `office setup`) performs six steps automatically:

1. **Downloads AI Office** — fetches the latest tarball from GitHub (no git required).
2. **Checks prerequisites** — verifies Node.js >= 22, npm, curl, Claude Code, and Docker/ngrok (optional).
3. **Installs dependencies** — runs `npm install` in `core`, `discord-bot`, `coordination`, `orchestrator`, `pixel-office`, and `setup`.
4. **Builds TypeScript** — compiles all packages to `dist/` (`core` first, then the rest).
5. **Launches the configuration wizard** — interactive prompts to create your office config (see [Section 4](#4-configuration-wizard)).
6. **Stops old processes** — kills any existing listener/Pixel Office daemons to prevent duplicates.
7. **Starts the Discord Listener daemon** — background process that keeps the bot online.

If any step fails, the script exits with an error message indicating which package failed. Fix the issue and re-run `office setup`.

---

## 3. Discord Bot Setup

### Create the application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name (e.g., "AI Office Bot").
3. Navigate to **Bot** in the left sidebar.
4. Click **Add Bot**, then confirm.

### Enable Message Content Intent

On the **Bot** page, scroll down to **Privileged Gateway Intents** and enable:

- **MESSAGE CONTENT INTENT** — required for reading user messages in channels.

Save your changes.

### Copy your Bot Token

On the **Bot** page, click **Reset Token**, confirm, then copy the token. You will paste this into the setup wizard. Keep this token secret — never commit it to version control.

### Invite the bot to your server

1. Navigate to **OAuth2 > URL Generator** in the left sidebar.
2. Under **Scopes**, select `bot` and `applications.commands`.
3. Under **Bot Permissions**, select **Administrator** (required for creating channels and managing messages).
4. Copy the generated URL and open it in your browser.
5. Select your server and click **Authorize**.

### Get your Guild ID

In Discord, open **User Settings > Advanced** and enable **Developer Mode**. Then right-click your server name and select **Copy Server ID**. This is your Guild ID.

---

## 4. Configuration Wizard

The wizard runs automatically at the end of `office setup`. You can also run it standalone:

```sh
office wizard
```

The wizard asks the following questions in order:

### Office Settings

| Prompt | Description | Default |
|--------|-------------|---------|
| **Office name** | Display name for your AI Office, shown in Discord embeds and status messages. | `My AI Office` |
| **Primary language** | Language agents use in responses. Choose from `zh-TW`, `en`, or `ja`. | `zh-TW` |
| **Timezone** | Used for working-hours throttling and log timestamps. Auto-detected from your system. | System timezone |

### Discord Bot

| Prompt | Description |
|--------|-------------|
| **Discord Bot Token** | The bot token from the Developer Portal. Required for the bot to connect to Discord. |
| **Discord Guild (Server) ID** | The server ID where AI Office will operate. |

If you skip either field, they default to placeholder values. Edit `discord-bot/.env` later to fill them in.

### Starter Pack

Choose a bundle of pre-configured agent roles to activate alongside the Leader:

| Option | Roles included |
|--------|---------------|
| **Solo** | Leader only — minimal setup for exploring the system. |
| **Engineering Team** | Leader + Software Engineer + QA Engineer. |
| **Business Team** | Leader + Project Manager + Business Analyst. |
| *(and more)* | Additional packs available in the wizard list. |

### Performance

| Prompt | Description | Default |
|--------|-------------|---------|
| **Max concurrent workers** | Maximum number of worker agents allowed to run simultaneously. Tune based on your Max subscription limits. | `3` |

### What the wizard writes

After you confirm the summary, the wizard creates or updates:

- `config/office.yaml` — office name, language, timezone, agent limits.
- `discord-bot/.env` — `DISCORD_TOKEN` and `DISCORD_GUILD_ID`.
- `.mcp.json` — MCP server configuration for Claude Code to auto-connect the Discord and Coordination servers.
- `config/active-roles.yaml` — the list of roles enabled from your chosen starter pack.
- `.ai-office/` workspace directories for state, artifacts, events, logs, and memory.

---

## 5. First Run

Once setup is complete, the Discord Listener daemon is already running in the background — no need to open Claude Code manually.

To verify everything is working:

```sh
office status   # show component status
office logs     # tail the listener log
```

### What happens on startup

1. The Listener daemon starts and loads the project-level `CLAUDE.md` and the Leader's `agents/leader/CLAUDE.md`.
2. The Leader agent calls `orchestrator init` to generate a session key, clean up stale workers, and sync active roles to the database.
3. The Leader calls `register_agent` on the Discord MCP Server to announce itself and ensure all required Discord channels exist.
4. The Leader posts a startup embed to the `#general` channel in Discord, showing office name, active roles, and session ID.

### How to interact

Speak to the Leader directly in Discord in the `#general` channel, or tag it in any channel where it has write access. The Leader reads new messages via `read_new_messages` and responds.

Example commands you can send in Discord:

```
Hire a software engineer to review my PR.
What tasks are currently in progress?
Stop the QA engineer — the testing phase is complete.
```

For high-risk actions (risk level `YELLOW` or `RED`), the Leader posts an approval request with Approve / Reject buttons. You must click a button in Discord before the action proceeds.

---

## 6. Pixel Office UI

The Pixel Office is an optional real-time visualization dashboard that shows agent positions, statuses, and activity in a pixel-art office layout.

### Development mode

```sh
cd pixel-office
npm run dev
```

Open your browser at [http://localhost:3847](http://localhost:3847).

The dev server supports hot-reload. Changes to Phaser.js scenes or the Express API update immediately.

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PIXEL_OFFICE_PORT` | HTTP port for the dashboard server. | `3847` |
| `AI_OFFICE_WORKSPACE` | Path to the `.ai-office` workspace directory. | `<project-dir>/.ai-office` |

---

## 7. Docker Alternative

If you prefer a containerized setup, Docker Compose handles the Pixel Office UI and the setup wizard.

### Run the Pixel Office in Docker

```sh
docker compose up pixel-office
```

The dashboard will be available at [http://localhost:3847](http://localhost:3847). Configuration files are mounted read-only from `./config`, and workspace data is stored in a named volume (`ai-office-data`).

### Run the setup wizard in Docker

```sh
docker compose run setup
```

This runs the interactive wizard inside the container with your project directory mounted, so the generated config files land in the correct locations on your host.

> Note: The MCP servers (`discord-bot` and `coordination`) are **not** managed by Docker Compose. They are spawned automatically by Claude Code via `.mcp.json` when you run `claude` in the project directory.

---

## 8. Troubleshooting

### Port already in use

**Symptom:** `Error: listen EADDRINUSE: address already in use :::3847`

**Fix:** Another process is using port 3847. Either stop that process or change the port:

```sh
PIXEL_OFFICE_PORT=3848 npm run dev
```

Or set `PIXEL_OFFICE_PORT` in your environment before running `docker compose up`.

### Database not found

**Symptom:** `Error: unable to open database file` or `SQLITE_CANTOPEN`

**Fix:** The workspace directory was not created by the setup wizard. Create it manually:

```sh
mkdir -p .ai-office/{state,artifacts,events,logs,memory}
```

Then re-run the wizard or set `AI_OFFICE_WORKSPACE` to point to an existing directory.

### Discord token invalid

**Symptom:** Discord bot fails to connect; logs show `TOKEN_INVALID` or `Error: An invalid token was provided.`

**Fix:**
1. Open `discord-bot/.env` and verify `DISCORD_TOKEN` is set correctly.
2. Tokens contain three dot-separated segments. Make sure you copied the full token from the Developer Portal.
3. If the token was reset in the Developer Portal after you copied it, you need to copy the new token.

### Guild ID not found

**Symptom:** `DiscordAPIError: Unknown Guild` when the bot attempts to set up channels.

**Fix:**
1. Verify `DISCORD_GUILD_ID` in `discord-bot/.env` matches the server ID you copied from Discord.
2. Confirm the bot was invited to that specific server using the OAuth2 URL from the Developer Portal.
3. Ensure the bot has Administrator permissions in the server.

### Build errors after updating

**Symptom:** TypeScript compilation errors after `office update`.

**Fix:** Re-run the full setup to reinstall dependencies and rebuild:

```sh
office setup
```

This is idempotent — it is safe to run multiple times. Note: `core/` must build before `discord-bot/` (the build scripts handle this automatically).

### Listener won't start

**Symptom:** `office start` returns an error or the listener exits immediately.

**Fix:** Check the logs to see what went wrong:

```sh
office logs
```

Common causes: missing `.env` values (see [Discord token invalid](#discord-token-invalid)), missing build output (`office setup` to rebuild), or a port conflict.

### MCP servers not connecting

**Symptom:** Claude Code shows tools unavailable; no Discord messages are sent.

**Fix:**
1. Verify `.mcp.json` exists in the project root. If missing, re-run `office wizard`.
2. Check that `discord-bot/dist/` and `coordination/dist/` exist. If not, run `office setup` to build.
3. In Claude Code, use `/mcp` to view the MCP server connection status and error details.

### Uninstalling

To stop all processes:

```sh
office stop
```

This stops the listener and Pixel Office daemons. To also remove state files, build outputs, and `node_modules`, delete those directories manually. Your `.env` config files are preserved — run `office setup` to reinstall.
