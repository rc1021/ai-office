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

### Build Tools (for Voice STT)

The Voice STT feature uses whisper.cpp, which must be compiled from source during `npm install`. The following tools are required:

```sh
# macOS
xcode-select --install   # installs make, gcc, clang

# Ubuntu / Debian
sudo apt-get install -y build-essential
```

After `npm install`, the `postinstall` script in `discord-bot/` compiles the binary automatically. If compilation fails (e.g. `make` not found), install the tools above and re-run `npm install` in `discord-bot/`.

### ffmpeg (for Voice Messages)

Required to convert Discord native voice messages (OGG/Opus) to WAV before transcription.

```sh
# macOS
brew install ffmpeg

# Ubuntu / Debian
sudo apt-get install -y ffmpeg
```

### Whisper Model

AI Office uses the **medium** Whisper model (~1.5 GB) as the default for high-accuracy speech recognition across multiple languages.

The model is downloaded automatically during `npm install` in `discord-bot/` via the `postinstall` script — no manual step is required. If you need to re-download it manually:

```sh
cd discord-bot/node_modules/whisper-node/lib/whisper.cpp/models
bash download-ggml-model.sh medium
```

The file (`ggml-medium.bin`) is excluded from git and lives only in `node_modules`.

**Language**: The STT language is read automatically from `config/office.yaml` (`office.language`). For example, `zh-TW` → Whisper uses `zh`, `en` → `en`, `ja` → `ja`. No code changes are needed when changing the office language.

### Optional: Docker

Docker is only needed if you want to run the Pixel Office UI or the setup wizard in a container. The core agent system (Discord Listener + Claude agents) runs on the host machine.

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

## 7. Docker

AI Office has a multi-stage `Dockerfile` and a `docker-compose.yaml`. Not all components are equal in Docker — here is what each tier supports:

### What runs in Docker

| Component | Docker support | Notes |
|-----------|---------------|-------|
| Pixel Office UI (port 3847) | ✅ Full | Default `CMD`, works out of the box |
| Coordination MCP Server (SQLite) | ✅ Full | Pure Node.js, no external deps |
| Discord Bot connection | ✅ With env vars | Needs `DISCORD_TOKEN` + `DISCORD_GUILD_ID` |
| Voice STT (Whisper) | ✅ With model | ffmpeg in runtime image; `ggml-medium.bin` must exist before `docker build` |
| Claude agent execution (`claude -p`) | ⚠️ Extra work | Needs `claude` binary + `ANTHROPIC_API_KEY` in container |
| `office` CLI commands | ❌ Not applicable | Designed for host process management |

### Three usage tiers

**Tier A — Pixel Office only (current default)**

```sh
docker compose up pixel-office
```

Dashboard at [http://localhost:3847](http://localhost:3847). Config files are mounted read-only from `./config`; workspace data persists in a named volume (`ai-office-data`).

**Tier B — Pixel Office + Discord Bot**

Start the supervisor (Discord listener) as an additional service in `docker-compose.yaml` and pass `DISCORD_TOKEN` / `DISCORD_GUILD_ID` as environment variables. Claude agents still run on the host.

**Tier C — Full agent system in Docker**

Requires installing the `claude` binary inside the image and mounting auth credentials (`ANTHROPIC_API_KEY` env var or `~/.claude/` volume). This is technically possible but not officially configured yet.

### Run the setup wizard in Docker

```sh
docker compose run setup
```

Runs the interactive wizard inside the container with the project directory mounted, so generated config files land in the correct locations on your host.

### Whisper model and Docker builds

The `ggml-medium.bin` model file (~1.5 GB) lives in `node_modules` (excluded from git). It is downloaded automatically during `npm install` via the `postinstall` script. Before running `docker build`, ensure `npm install` has been run on the host at least once so the model exists — it will be copied from the builder stage into the runtime image via `COPY --from=builder`. If it is missing at build time, Voice STT will not work in the container.

> **Note:** The MCP servers (`discord-bot`, `coordination`) are spawned automatically by Claude Code via `.mcp.json` when you run `claude` on the host. They are not managed by Docker Compose in the default configuration.

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
